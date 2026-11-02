// wagbi's launch, offline: the whole deposit flow against a fake chain that checks every signature and applies
// each transaction (printer-engine's own test chain, ported). No network, nothing sent anywhere. Covers the
// split (the person's wallets + wagbi's fixed cut, locked), the first buy into the payout wallet, the
// leftover, failures and refunds, underpaid, abandoned, races, the closed switch and the guard.
// Run: npm test
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  Custody, DISC, DepositStore, GuardRefused, PROGRAMS, base58, bondingCurveOf, buildDepositSplitTx, decodeBuy, decodeCreateV2, decodeSystemTransfer,
  decodeUpdateSharesV2, hex, sharingConfigOf, sweepFee,
} from 'printer-engine/launch';
import { createLaunchService, cleanLaunchBody, MAX_EXTRA_WALLETS } from '../api/_lib/launch/service.js';
import { settingsFromEnv } from '../api/_lib/launch/settings.js';

const quiet = console.log;
const REC = JSON.parse(readFileSync(new URL('./fixtures/pump-state.json', import.meta.url), 'utf8'));
const accountOf = (a) => ({ data: Buffer.from(a.data, 'base64'), owner: new PublicKey(a.owner), lamports: a.lamports, executable: false, rentEpoch: 0 });
const table = () =>
  new AddressLookupTableAccount({
    key: new PublicKey(REC.table.address),
    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: REC.table.addresses.map((a) => new PublicKey(a)) },
  });
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
function sigValid(message, signature, signer) {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(signer.toBytes()).toString('base64url') }, format: 'jwk' });
  return verify(null, message, key, signature);
}
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
function curveAccountOf(creator, complete = false) {
  const data = Buffer.concat([Buffer.from(DISC.accountBondingCurve, 'hex'), u64le(1n), u64le(1n), u64le(1n), u64le(0n), u64le(1n), Buffer.from([complete ? 1 : 0]), new PublicKey(creator).toBuffer(), Buffer.from([0, 0]), PublicKey.default.toBuffer(), u64le(0n), Buffer.from([0, 0]), u64le(0n), u64le(0n)]);
  return { data, owner: new PublicKey(PROGRAMS.pump), lamports: 1, executable: false, rentEpoch: 0 };
}
function sharingConfigAccountOf(mint, admin, revoked, holders) {
  const parts = [Buffer.from(DISC.accountSharingConfig, 'hex'), Buffer.from([255, 2, 1]), new PublicKey(mint).toBuffer(), new PublicKey(admin).toBuffer(), Buffer.from([revoked ? 1 : 0])];
  const n = Buffer.alloc(4);
  n.writeUInt32LE(holders.length);
  parts.push(n);
  for (const h of holders) {
    const bps = Buffer.alloc(2);
    bps.writeUInt16LE(h.bps);
    parts.push(new PublicKey(h.address).toBuffer(), bps);
  }
  return { data: Buffer.concat(parts), owner: new PublicKey(PROGRAMS.pumpFees), lamports: 1, executable: false, rentEpoch: 0 };
}
const mintAccountOf = () => ({ data: Buffer.alloc(82), owner: new PublicKey(PROGRAMS.token2022), lamports: 1, executable: false, rentEpoch: 0 });

// ── a write-once object store (Blob's own rule: nothing is ever replaced) ──
class WriteOnceObjects {
  label = 'write-once memory';
  m = new Map();
  async put(key, body, opts) {
    if (!opts.ifAbsent) throw new Error(`a put without ifAbsent: ${key}`);
    await new Promise((r) => setTimeout(r, Math.random() * 2));
    if (this.m.has(key)) return false;
    this.m.set(key, { body: Buffer.from(body), contentType: opts.contentType });
    return true;
  }
  async get(key) {
    await new Promise((r) => setTimeout(r, Math.random() * 2));
    return this.m.get(key) ?? null;
  }
  async list(prefix) {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

// ── the fake chain ──
const CREATE_RENT = 8_400_000;
const SPLIT_RENT = 2_500_000;
function kindOf(ixs) {
  const d = (ix) => hex(Uint8Array.from(ix.data).subarray(0, 8));
  if (ixs.some((ix) => ix.programId.toBase58() === PROGRAMS.pump && d(ix) === DISC.createV2)) return 'create';
  if (ixs.some((ix) => ix.programId.toBase58() === PROGRAMS.pumpFees && d(ix) === DISC.updateFeeSharesV2)) return 'split';
  if (ixs.some((ix) => ix.programId.toBase58() === PROGRAMS.system)) return 'sweep';
  return 'other';
}
class FakeChain {
  accounts = new Map();
  balances = new Map();
  tokens = new Map();
  statuses = new Map();
  sent = [];
  height = 900;
  onSend = () => 'land';
  onSimulate = () => null;
  /** a coin whose split needs more compute than the engine's 215,000 (one devnet coin needed 219,903) */
  splitNeedsCu = 0;
  limitOf(s) {
    const ix = s.ixs.find((i) => i.programId.toBase58() === PROGRAMS.computeBudget && Uint8Array.from(i.data)[0] === 2);
    return ix ? Buffer.from(ix.data).readUInt32LE(1) : 200_000;
  }
  constructor() {
    this.accounts.set(REC.global.address, accountOf(REC.global));
    this.accounts.set(REC.feeConfig.address, accountOf(REC.feeConfig));
  }
  read(tx) {
    const ixs = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tx.message.addressTableLookups.length ? [table()] : [] }).instructions;
    return { kind: kindOf(ixs), sig: base58(tx.signatures[0]), tx, ixs };
  }
  signaturesValid(tx) {
    const msg = tx.message.serialize();
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    return signers.every((k, i) => sigValid(msg, tx.signatures[i], k));
  }
  fund(address, lamports) {
    this.balances.set(address, (this.balances.get(address) ?? 0) + lamports);
  }
  apply(s) {
    const payer = s.tx.message.staticAccountKeys[0].toBase58();
    const debit = (n) => {
      const b = this.balances.get(payer) ?? 0;
      if (b < n) return false;
      this.balances.set(payer, b - n);
      return true;
    };
    const d = (ix) => hex(Uint8Array.from(ix.data).subarray(0, 8));
    if (s.kind === 'create') {
      const create = s.ixs.find((ix) => d(ix) === DISC.createV2);
      const mint = create.keys[0].pubkey.toBase58();
      const buy = s.ixs.find((ix) => ix.programId.toBase58() === PROGRAMS.pump && d(ix) === DISC.buy);
      const spend = buy ? Number(decodeBuy(Uint8Array.from(buy.data)).maxSolCost) - 1_000 : 0;
      if (!debit(spend + CREATE_RENT + 10_000)) return false;
      this.accounts.set(mint, mintAccountOf());
      this.accounts.set(bondingCurveOf(mint), curveAccountOf(decodeCreateV2(Uint8Array.from(create.data)).creator));
      if (buy) this.tokens.set(buy.keys[5].pubkey.toBase58(), decodeBuy(Uint8Array.from(buy.data)).amount);
      return true;
    }
    if (s.kind === 'split') {
      const shares = s.ixs.find((ix) => d(ix) === DISC.updateFeeSharesV2);
      const mint = shares.keys[4].pubkey.toBase58();
      if (!debit(SPLIT_RENT + 5_000)) return false;
      const holders = decodeUpdateSharesV2(Uint8Array.from(shares.data)).map((h) => ({ address: h.address, bps: h.shareBps }));
      this.accounts.set(sharingConfigOf(mint), sharingConfigAccountOf(mint, payer, true, holders));
      this.accounts.set(bondingCurveOf(mint), curveAccountOf(sharingConfigOf(mint)));
      return true;
    }
    if (s.kind === 'sweep') {
      const t = s.ixs.find((ix) => ix.programId.toBase58() === PROGRAMS.system);
      const lamports = Number(decodeSystemTransfer(Uint8Array.from(t.data)));
      if (!debit(lamports + sweepFee())) return false;
      this.fund(t.keys[1].pubkey.toBase58(), lamports);
      return true;
    }
    return false;
  }
  rpc = {
    getBalance: async (k) => this.balances.get(k.toBase58()) ?? 0,
    getAccountInfo: async (k) => this.accounts.get(k.toBase58()) ?? (this.balances.get(k.toBase58()) ? { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports: this.balances.get(k.toBase58()), executable: false, rentEpoch: 0 } : null),
    getMultipleAccountsInfo: async (keys) => Promise.all(keys.map((k) => this.rpc.getAccountInfo(k))),
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }),
    getBlockHeight: async () => this.height,
    getAddressLookupTable: async () => ({ value: table() }),
    simulateTransaction: async (tx, opts) => {
      const s = this.read(tx);
      if (opts?.sigVerify && !this.signaturesValid(tx)) return { value: { err: 'SignatureFailure', logs: [], unitsConsumed: 0, accounts: null } };
      if (s.kind === 'split' && this.splitNeedsCu && this.limitOf(s) < this.splitNeedsCu) return { value: { err: { InstructionError: [4, 'ComputationalBudgetExceeded'] }, logs: [], unitsConsumed: this.limitOf(s), accounts: null } };
      return { value: { err: this.onSimulate(s), logs: [], unitsConsumed: s.kind === 'split' && this.splitNeedsCu ? this.splitNeedsCu : 150_000, accounts: [{ lamports: 0 }] } };
    },
    sendRawTransaction: async (wire) => {
      const tx = VersionedTransaction.deserialize(wire);
      if (!this.signaturesValid(tx)) throw new Error('signature verification failed');
      const s = this.read(tx);
      this.sent.push(s);
      if (this.statuses.has(s.sig)) return s.sig;
      const what = this.onSend(s);
      if (what === 'drop') return s.sig;
      const ok = what === 'land' && !(s.kind === 'split' && this.splitNeedsCu && this.limitOf(s) < this.splitNeedsCu) && this.apply(s);
      this.statuses.set(s.sig, { err: ok ? null : { InstructionError: [2, { Custom: 6000 }] } });
      return s.sig;
    },
    getSignatureStatuses: async (sigs) => ({ value: sigs.map((g) => (this.statuses.has(g) ? { slot: 1, confirmations: null, err: this.statuses.get(g).err, confirmationStatus: 'confirmed' } : null)) }),
    getSignaturesForAddress: async () => [],
    getTransaction: async () => null,
  };
}

// ── fixtures ──
const wallet = () => Keypair.generate().publicKey.toBase58();
const FEE = wallet();
const payout = wallet();
const KIT = 'kitAAAAAAAAAAAAA';
const KIT2 = 'kitBBBBBBBBBBBBB';
const kitOf = (id) => ({ v: 1, id, sentence: 'a frog who does my taxes', name: 'deductoad', ticker: 'TOAD', bio: 'files your taxes for one cricket', logo: `https://store.public.blob.vercel-storage.com/kits/${id}/logo.png`, banner: `https://store.public.blob.vercel-storage.com/kits/${id}/banner.png` });
const KITS = { [KIT]: kitOf(KIT), [KIT2]: kitOf(KIT2) };

const settings = (env = {}) => settingsFromEnv({ WAGBI_FEE_WALLET: FEE, WAGBI_LAUNCH_ALT: REC.table.address, ...env });

function setup(o = {}) {
  const chain = new FakeChain();
  const objects = new WriteOnceObjects();
  const store = o.noStore ? null : new DepositStore(objects, 'mainnet/test/');
  const coins = new Map();
  const meta = new Map();
  const logs = [];
  let offset = 0;
  const now = () => Date.now() + offset;
  const svc = createLaunchService({
    rpc: chain.rpc, store, custody: o.noKey ? null : new Custody(new Uint8Array(randomBytes(32))),
    getKit: async (id) => KITS[id] ?? null,
    putMeta: async (name, json) => (meta.set(name, json), `https://store.public.blob.vercel-storage.com/meta/${name}.json`),
    readCoin: async (id) => coins.get(id) ?? null,
    writeCoin: async (r) => void (coins.has(r.kitId) || coins.set(r.kitId, r)),
    settings: o.settings ?? settings(),
    checkPublic: null,
    now, log: (e) => void logs.push(e), runMs: 30_000, timing: { resendMs: 5, pollMs: 2, settleMs: 2, marginMs: 200 },
  });
  return { chain, svc, store, objects, coins, meta, logs, later: (ms) => void (offset += ms) };
}

const body = (over = {}) => ({
  kitId: KIT, type: 'normal', name: 'deductoad', ticker: 'toad', bio: 'files your taxes for one cricket', x: 'x.com/deductoad',
  payout, creatorBps: 7000, wallets: [{ address: wallet(), bps: 1000 }, { address: wallet(), bps: 500 }], firstBuySol: 0.1, ...over,
});

/** The guarantee, read from what was really sent: SOL only to the payout wallet or into pump.fun. */
function onlyPayoutOrPump(chain, deposit, to, shares) {
  const allowed = new Set([PROGRAMS.computeBudget, PROGRAMS.pump, PROGRAMS.pumpFees, PROGRAMS.ata, PROGRAMS.system]);
  for (const s of chain.sent) {
    assert.equal(s.tx.message.staticAccountKeys[0].toBase58(), deposit);
    for (const ix of s.ixs) {
      const p = ix.programId.toBase58();
      assert.ok(allowed.has(p), `program ${p}`);
      if (p === PROGRAMS.system) {
        assert.equal(ix.keys[0].pubkey.toBase58(), deposit);
        assert.equal(ix.keys[1].pubkey.toBase58(), to);
      }
      if (p === PROGRAMS.ata) assert.equal(ix.keys[2].pubkey.toBase58(), to);
      if (p === PROGRAMS.pump && hex(Uint8Array.from(ix.data).subarray(0, 8)) === DISC.buy) {
        assert.equal(ix.keys[5].pubkey.toBase58(), getAssociatedTokenAddressSync(ix.keys[2].pubkey, new PublicKey(to), true, TOKEN_2022_PROGRAM_ID).toBase58());
      }
      if (p === PROGRAMS.pumpFees && hex(Uint8Array.from(ix.data).subarray(0, 8)) === DISC.updateFeeSharesV2) {
        const list = decodeUpdateSharesV2(Uint8Array.from(ix.data));
        assert.deepEqual(list.map((x) => `${x.address}:${x.shareBps}`).sort(), shares.map((x) => `${x.address}:${x.bps}`).sort());
        assert.ok(!list.some((x) => x.address === deposit));
      }
    }
  }
}

async function poll(t, id, times = 10) {
  let v;
  for (let i = 0; i < times; i++) {
    const st = await t.svc.status(id);
    v = st.view;
    if (st.needsRun) await t.svc.run(id);
    if (['live', 'refunded', 'expired'].includes(v.phase) && !st.needsRun) break;
  }
  return (await t.svc.status(id)).view;
}

describe('the request', () => {
  const s = settings();
  it('takes the edited words, the payout wallet and a split that adds to 100% with wagbi at 15%', () => {
    const b = cleanLaunchBody(body(), s);
    assert.equal(b.ticker, 'TOAD');
    assert.equal(b.creatorBps + 1500 + 1000 + 500, 10_000);
    assert.equal(b.firstBuyLamports, 100_000_000);
    assert.equal(b.x, 'https://x.com/deductoad');
  });
  it('refuses a split that is not 100%, a wallet twice, wagbi in the list, or too many wallets', () => {
    assert.throws(() => cleanLaunchBody(body({ creatorBps: 7100 }), s), /adds up to 100\.?1?%|must be exactly 100%/);
    const w = wallet();
    assert.throws(() => cleanLaunchBody(body({ wallets: [{ address: w, bps: 1000 }, { address: w, bps: 500 }] }), s), /twice/);
    assert.throws(() => cleanLaunchBody(body({ wallets: [{ address: FEE, bps: 1500 }] }), s), /wagbi's own fee wallet/);
    assert.throws(() => cleanLaunchBody(body({ payout: FEE }), s), /wagbi's own fee wallet/);
    const nine = Array.from({ length: MAX_EXTRA_WALLETS + 1 }, () => ({ address: wallet(), bps: 100 }));
    assert.throws(() => cleanLaunchBody(body({ creatorBps: 8500 - (MAX_EXTRA_WALLETS + 1) * 100, wallets: nine }), s), /6 more wallets at most/);
  });
  it('refuses a split field, a program address as a wallet, and private allocation (not built)', () => {
    assert.throws(() => cleanLaunchBody(body({ shares: [] }), s), /doesn't know/);
    const pda = PublicKey.findProgramAddressSync([Buffer.from('x')], new PublicKey(PROGRAMS.pump))[0].toBase58();
    assert.throws(() => cleanLaunchBody(body({ payout: pda }), s), /isn't a Solana wallet/);
    assert.throws(() => cleanLaunchBody(body({ type: 'allocation' }), s), (e) => e.code === 'closed');
  });
  it('checks the words: length, ticker, the house ticker, slurs', () => {
    assert.throws(() => cleanLaunchBody(body({ name: 'x'.repeat(33) }), s), /too long/);
    assert.throws(() => cleanLaunchBody(body({ ticker: 'W' }), s), /2 to 10/);
    assert.throws(() => cleanLaunchBody(body({ ticker: 'wagbi' }), s), /wagbi's own/);
    assert.throws(() => cleanLaunchBody(body({ bio: 'a kike frog' }), s), /will not launch/);
  });
});

describe('the switch', () => {
  it('without WAGBI_FEE_WALLET: launches open soon, no address is made, nothing is stored', async () => {
    const t = setup({ settings: settings({ WAGBI_FEE_WALLET: '' }) });
    const c = t.svc.config();
    assert.equal(c.open, false);
    assert.equal(c.reason, 'launches open soon. nothing gets sent or spent.');
    await assert.rejects(t.svc.create(body()), (e) => e.code === 'closed');
    assert.equal(t.objects.m.size, 0);
  });
  it('without the master key or the store: closed too', async () => {
    for (const o of [{ noKey: true }, { noStore: true }]) {
      const t = setup(o);
      assert.equal(t.svc.config().open, false);
      await assert.rejects(t.svc.create(body()), (e) => e.code === 'closed');
    }
  });
  it('a fee wallet that is not a wallet is not used', () => {
    const s = settings({ WAGBI_FEE_WALLET: 'not-a-wallet' });
    assert.equal(s.feeWallet, null);
    assert.ok(s.feeProblem);
  });
  it('says the cut, the limits and that allocation is off', () => {
    const c = setup().svc.config();
    assert.equal(c.open, true);
    assert.equal(c.fee.bps, 1500);
    assert.equal(c.maxWallets, 8);
    assert.equal(c.maxExtraWallets, 6);
    assert.equal(c.allocation.enabled, false);
    assert.equal(c.allocation.maxBuyers, 10);
    assert.equal(c.allocation.maxPct, 15);
  });
});

describe('the quote', () => {
  it('is network costs + the first buy with its slippage + a buffer, and estimates the share of supply', async () => {
    const t = setup();
    const q0 = await t.svc.quote({ firstBuySol: 0 });
    assert.equal(q0.amounts.totalLamports, 20_000_000);
    assert.equal(q0.firstBuy, null);
    const q = await t.svc.quote({ firstBuySol: 0.5 });
    assert.equal(q.amounts.firstBuyMaxLamports, 525_000_000);
    assert.ok(q.amounts.totalLamports >= 525_000_000 + 17_000_000);
    assert.ok(q.firstBuy.pctOfSupply > 1 && q.firstBuy.pctOfSupply < 3, `${q.firstBuy.pctOfSupply}% of supply`);
    await assert.rejects(t.svc.quote({ firstBuySol: 11 }), /0\.001 to 10 SOL/);
  });
});

describe('launch by deposit', () => {
  it('waits, sees the SOL, launches with the coins to the payout wallet and the split locked as set, sends the leftover back', async () => {
    const t = setup();
    const v = await t.svc.create(body());
    assert.equal(v.phase, 'waiting');
    assert.match(v.qr, /^data:image\/svg\+xml;base64,/);
    assert.equal(v.shares.length, 4);
    assert.deepEqual(v.shares.slice(0, 2), [{ role: 'creator', address: payout, bps: 7000 }, { role: 'wagbi', address: FEE, bps: 1500 }]);
    const meta = JSON.parse([...t.meta.values()][0]);
    assert.deepEqual([meta.name, meta.symbol, meta.description, meta.image, meta.website, meta.twitter], ['deductoad', 'TOAD', 'files your taxes for one cricket', KITS[KIT].logo, `https://wagbi.fun/k/${KIT}`, 'https://x.com/deductoad']);

    assert.equal((await t.svc.status(v.id)).needsRun, false);
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'live');
    assert.ok(end.launch.mint);
    assert.equal(end.launch.links.pump, `https://pump.fun/coin/${end.launch.mint}`);
    const ata = getAssociatedTokenAddressSync(new PublicKey(end.launch.mint), new PublicKey(payout), true, TOKEN_2022_PROGRAM_ID).toBase58();
    assert.ok(t.chain.tokens.get(ata) > 0n, 'the first buy landed in the payout wallet');
    assert.equal(end.returns.length, 1);
    assert.equal(end.returns[0].what, 'leftover');
    assert.equal(end.returns[0].to, payout);
    assert.equal(t.chain.balances.get(v.address), 0);
    onlyPayoutOrPump(t.chain, v.address, payout, v.shares);
    const coin = await t.svc.coin(KIT);
    assert.equal(coin.mint, end.launch.mint);
    assert.equal(coin.splitLocked, true);
    assert.deepEqual(coin.split, v.shares);
    assert.deepEqual(coin.allocation, []);
    await assert.rejects(t.svc.create(body()), /already launched/);
  });

  it('a split of 8 wallets (the most one split transaction holds) fits and lands; 9 would not fit', async () => {
    const t = setup();
    const wallets = Array.from({ length: MAX_EXTRA_WALLETS }, () => ({ address: wallet(), bps: 500 }));
    const v = await t.svc.create(body({ creatorBps: 8500 - MAX_EXTRA_WALLETS * 500, wallets, firstBuySol: 0 }));
    assert.equal(v.shares.length, 8);
    const nine = [...v.shares, { role: 'wallet', address: wallet(), bps: 100 }].map((x, i) => (i === 0 ? { ...x, bps: x.bps - 100 } : x));
    await assert.rejects(buildDepositSplitTx({ mint: Keypair.generate().publicKey, deposit: new PublicKey(v.address), shares: nine, priorityLamports: 1_000_000, withBuy: false, blockhash: BLOCKHASH }), /over the 1232-byte limit/);
    const built = await buildDepositSplitTx({ mint: Keypair.generate().publicKey, deposit: new PublicKey(v.address), shares: v.shares, priorityLamports: 1_000_000, withBuy: false, blockhash: BLOCKHASH });
    assert.ok(built.sizeBytes <= 1232, `${built.sizeBytes} bytes`);
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'live');
    onlyPayoutOrPump(t.chain, v.address, payout, v.shares);
  });

  it('a coin whose split needs more compute than the engine budgets still gets its split (measured, then fitted)', async () => {
    const t = setup();
    t.chain.splitNeedsCu = 219_903;
    const v = await t.svc.create(body());
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'live');
    const split = t.chain.sent.find((s) => s.kind === 'split');
    assert.ok(t.chain.limitOf(split) >= 219_903 && t.chain.limitOf(split) <= 1_400_000, String(t.chain.limitOf(split)));
    onlyPayoutOrPump(t.chain, v.address, payout, v.shares);
  });

  it('a poll, a second poll and the cron at once make exactly one coin', async () => {
    const t = setup();
    const v = await t.svc.create(body());
    t.chain.fund(v.address, v.amounts.totalLamports);
    await Promise.all([t.svc.run(v.id), t.svc.run(v.id), t.svc.cron({ days: 1 })]);
    await poll(t, v.id);
    assert.equal(t.chain.sent.filter((s) => s.kind === 'create').map((s) => s.sig).filter((x, i, a) => a.indexOf(x) === i).length, 1);
    assert.equal(t.coins.size, 1);
  });

  it('a launch that fails sends everything back to the payout wallet, says why, and frees the coin', async () => {
    const t = setup();
    t.chain.onSimulate = (s) => (s.kind === 'create' ? { InstructionError: [2, { Custom: 6000 }] } : null);
    const v = await t.svc.create(body());
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id, 12);
    assert.equal(end.phase, 'refunded');
    assert.match(end.problem, /didn't accept the coin/);
    assert.equal(end.returns[0].what, 'refund');
    assert.equal(end.returns[0].to, payout);
    assert.equal(t.chain.balances.get(payout), v.amounts.totalLamports - sweepFee());
    assert.equal(t.chain.sent.filter((s) => s.kind === 'create').length, 0);
    const again = await t.svc.create(body());
    assert.equal(again.phase, 'waiting');
  });

  it('underpaid: shows what is missing; sends it back on request after a few minutes', async () => {
    const t = setup();
    const v = await t.svc.create(body());
    t.chain.fund(v.address, 5_000_000);
    const w = (await t.svc.status(v.id)).view;
    assert.equal(w.phase, 'waiting');
    assert.equal(w.received.missingLamports, v.amounts.totalLamports - 5_000_000);
    await assert.rejects(t.svc.askRefund(v.id), /from \d\d:\d\d UTC/);
    t.later(11 * 60_000);
    const r = await t.svc.askRefund(v.id);
    assert.equal(r.needsRun, true);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'refunded');
    assert.equal(t.chain.balances.get(payout), 5_000_000 - sweepFee());
  });

  it('abandoned: after 24 hours a poll (no cron needed) sends back what is there', async () => {
    const t = setup();
    const v = await t.svc.create(body());
    t.chain.fund(v.address, 1_000_000);
    t.later(24 * 3_600_000 + 1);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'refunded');
    assert.match(end.problem, /24 hours/);
  });

  it('the fee wallet switched off before the SOL arrives: nothing launches, it goes back', async () => {
    const t = setup();
    const v = await t.svc.create(body());
    t.svc.settings.feeWallet = null; // what a redeploy without WAGBI_FEE_WALLET does
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'refunded');
    assert.match(end.problem, /switched off/);
    assert.equal(t.chain.sent.filter((s) => s.kind !== 'sweep').length, 0);
  });

  it('a create that lands with an error is retried; a dropped one is never replaced while it could still land', async () => {
    const t = setup();
    let n = 0;
    t.chain.onSend = (s) => (s.kind === 'create' && n++ === 0 ? 'drop' : 'land');
    const v = await t.svc.create(body());
    t.chain.fund(v.address, v.amounts.totalLamports);
    await t.svc.run(v.id);
    assert.equal(new Set(t.chain.sent.filter((s) => s.kind === 'create').map((s) => s.sig)).size, 1, 'no second create while the first could land');
    t.chain.height = 1001; // the first one's blockhash is dead now
    const end = await poll(t, v.id, 12);
    assert.equal(end.phase, 'live');
    assert.equal(t.coins.size, 1);
  });
});

describe('the guard and the secrets', () => {
  it('the deposit key refuses (and does not sign) a split other than the one pinned', async () => {
    const t = setup();
    const v = await t.svc.create(body());
    const rec = await t.store.get(v.id);
    const sealed = await t.store.sealedKey(v.id);
    assert.throws(() => new Custody(new Uint8Array(randomBytes(32))).signer(sealed, v.id, v.address), /another master key/);
    const mint = Keypair.generate().publicKey;
    const wrong = rec.shares.map((x) => (x.role === 'wagbi' ? { ...x, address: wallet() } : x));
    const built = await buildDepositSplitTx({ mint, deposit: new PublicKey(v.address), shares: wrong, priorityLamports: 1_000_000, withBuy: true, blockhash: BLOCKHASH });
    const { checkDepositTx } = await import('printer-engine/launch');
    const problems = checkDepositTx(built.tx, { kind: 'split', deposit: v.address, payout, mint: mint.toBase58(), shares: rec.shares.map((x) => ({ address: x.address, shareBps: x.bps })) });
    assert.ok(problems.some((p) => /split/.test(p)), problems.join(' '));
  });
  it('no view, log line or stored record carries a secret key', async () => {
    const t = setup();
    const v = await t.svc.create(body());
    t.chain.fund(v.address, v.amounts.totalLamports);
    await poll(t, v.id);
    const sealed = JSON.stringify(await t.store.sealedKey(v.id));
    const ct = JSON.parse(sealed).ct;
    const everything = JSON.stringify([v, (await t.svc.status(v.id)).view, t.logs, [...t.coins.values()]]);
    assert.ok(!everything.includes(ct));
    assert.ok(!everything.includes('secretKey'));
    assert.equal(inspect(t.svc).includes(ct), false);
  });
});

describe('devnet test deployments', () => {
  it('use their own corner and no pump.fun link (pump.fun shows mainnet only)', async () => {
    const t = setup({ settings: settings({ WAGBI_CLUSTER: 'devnet' }) });
    const v = await t.svc.create(body());
    assert.equal(v.cluster, 'devnet');
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'live');
    assert.equal(end.launch.links.pump, null);
    assert.match(end.launch.links.mint, /\?cluster=devnet$/);
  });
});

void quiet;

describe('the picker: chain -> launchpad -> currency', () => {
  const s = settings();
  it('launches only what has an adapter (solana / pump.fun / SOL); the rest say they are not open yet', () => {
    assert.equal(cleanLaunchBody(body({ chain: 'solana', launchpad: 'pumpfun', currency: 'SOL' }), s).launchpad, 'pumpfun');
    assert.throws(() => cleanLaunchBody(body({ chain: 'base' }), s), (e) => e.code === 'closed' && /Base isn't open yet/.test(e.userMessage));
    assert.throws(() => cleanLaunchBody(body({ launchpad: 'meteora-dbc' }), s), (e) => e.code === 'closed' && /Meteora DBC isn't open yet/.test(e.userMessage));
    assert.throws(() => cleanLaunchBody(body({ currency: 'USDC' }), s), (e) => e.code === 'closed' && /USDC pairs aren't open yet/.test(e.userMessage));
  });
  it('the config lists the chains and launchpads, with what is live and what is soon', () => {
    const c = setup().svc.config();
    assert.deepEqual(c.chains.map((x) => `${x.id}:${x.status}`), ['solana:live', 'base:soon', 'bnb:soon']);
    assert.equal(c.launchpads.find((l) => l.id === 'pumpfun').status, 'live');
    assert.equal(c.launchpads.find((l) => l.id === 'pumpfun').maxWallets, 8);
    assert.ok(c.launchpads.filter((l) => l.status === 'soon').length >= 4);
  });
  it('a deposit pins its chain, launchpad and currency, and the live coin carries them', async () => {
    const t = setup();
    const v = await t.svc.create(body());
    const rec = await t.store.get(v.id);
    assert.deepEqual([rec.chain, rec.launchpad, rec.currency], ['solana', 'pumpfun', 'SOL']);
    t.chain.fund(v.address, v.amounts.totalLamports);
    await poll(t, v.id);
    assert.equal(t.coins.get(KIT).launchpad, 'pumpfun');
  });
});

describe('versions: a coin is its conversation', () => {
  it('launching version 2 launches the coin: the record is the coin\'s, it names the version, and version 1 can\'t launch again', async () => {
    const V2 = 'kitV2xxxxxxxxxxx';
    KITS[V2] = { ...kitOf(V2), root: KIT2, version: 2, ask: 'make the logo blue', name: 'blue toad', ticker: 'BTOAD' };
    const t = setup();
    const v = await t.svc.create(body({ kitId: V2, name: 'blue toad', ticker: 'BTOAD' }));
    assert.equal(v.kitId, KIT2);
    t.chain.fund(v.address, v.amounts.totalLamports);
    await poll(t, v.id);
    const coin = t.coins.get(KIT2);
    assert.equal(coin.versionId, V2);
    assert.equal(coin.version, 2);
    assert.equal(coin.name, 'blue toad');
    await assert.rejects(t.svc.create(body({ kitId: KIT2 })), /already launched/);
    delete KITS[V2];
  });
});
