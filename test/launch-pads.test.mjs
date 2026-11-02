// The launchpads beyond pump.fun on SOL, offline: pump.fun USDC pairs, Raydium LaunchLab, LetsBonk, Meteora DBC and
// Bags, each through the whole deposit flow against a fake chain that checks every signature and applies what each
// launchpad's instructions do. Plus every adapter's guard (what the deposit key refuses to sign), the spend cap,
// the custody that opens the engine's sealed keys, the switches and the picker. No network, nothing sent anywhere.
// Run: npm test
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { Custody, DISC, DepositStore, base58, bondingCurveOf, decodeCreateV2, decodeSystemTransfer, decodeUpdateSharesV2, hex, sharingConfigOf, sweepFee } from 'printer-engine/launch';
import { createLaunchService, cleanLaunchBody } from '../api/_lib/launch/service.js';
import { settingsFromEnv } from '../api/_lib/launch/settings.js';
import { LaunchCustody } from '../api/_lib/launch/custody.js';
import { GUARDS, adapterFor } from '../api/_lib/launch/launchpads.js';
import { P, USDC, WSOL, ataOf } from '../api/_lib/launch/chain.js';
import { LAUNCHLAB_PROGRAM, PLATFORMS, decodeBuyExactIn, decodeInitializeV2, launchlabAccounts, letsbonk, raydiumLaunchlab } from '../api/_lib/launch/adapters/launchlab.js';
import { DBC_PROGRAM, configParams, meteoraDbc } from '../api/_lib/launch/adapters/meteoraDbc.js';
import { MAX_WALLETS_USDC, PUMP, PUMP_FEES, pumpfunUsdc } from '../api/_lib/launch/adapters/pumpfunUsdc.js';
import { BAGS_FEE_SHARE_V2, bags } from '../api/_lib/launch/adapters/bags.js';

const require = createRequire(import.meta.url);
const S = require('@meteora-ag/dynamic-bonding-curve-sdk');
const dbcProgram = S.createDbcProgram(new (require('@solana/web3.js').Connection)('http://127.0.0.1:1'));

const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const wallet = () => Keypair.generate().publicKey.toBase58();
const pk = (k) => new PublicKey(k);
const d8 = (ix) => hex(Uint8Array.from(ix.data).subarray(0, 8));
function sigValid(message, signature, signer) {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(signer.toBytes()).toString('base64url') }, format: 'jwk' });
  return verify(null, message, key, signature);
}

// ── a write-once object store ──
class WriteOnceObjects {
  label = 'write-once memory';
  m = new Map();
  async put(key, body, opts) {
    if (!opts.ifAbsent) throw new Error(`a put without ifAbsent: ${key}`);
    if (this.m.has(key)) return false;
    this.m.set(key, { body: Buffer.from(body), contentType: opts.contentType });
    return true;
  }
  async get(key) {
    return this.m.get(key) ?? null;
  }
  async list(prefix) {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

// ── account fixtures ──
const acct = (data, owner, lamports = 2_000_000) => ({ data: Buffer.from(data), owner: pk(owner), lamports, executable: false, rentEpoch: 0 });
function llGlobal() {
  const b = Buffer.alloc(400);
  b[16] = 0; // constant product
  b.writeBigUInt64LE(0n, 19); // migrate fee
  b.writeBigUInt64LE(2500n, 27); // trade fee 0.25%
  b.writeBigUInt64LE(1n, 75); // min fund raising
  pk(WSOL).toBuffer().copy(b, 83);
  return b;
}
function llPlatform({ restricted = false } = {}) {
  const b = Buffer.alloc(1000);
  b.writeBigUInt64LE(2500n, 104); // platform fee 0.25%
  b.writeBigUInt64LE(2500n, 720); // creator fee 0.25%
  b[832] = restricted ? 1 : 0;
  return b;
}
function llPool(a, mint, creator) {
  const b = Buffer.alloc(429);
  for (const [o, k] of [[141, a.globalConfig], [173, a.platform], [205, mint], [237, WSOL], [333, creator]]) pk(k).toBuffer().copy(b, o);
  return b;
}
function dbcAccount(name, set) {
  const c = dbcProgram.coder.accounts;
  const size = c.size(name);
  const o = c.decode(name, Buffer.concat([Buffer.from(c.accountDiscriminator(name)), Buffer.alloc(size - 8)]));
  set(name === 'virtualPool' ? o.poolState : o);
  const L = c.accountLayouts.get(name);
  const buf = Buffer.alloc(size + 64);
  const len = L.layout.encode(o, buf);
  return Buffer.concat([Buffer.from(c.accountDiscriminator(name)), buf.subarray(0, len)]).subarray(0, size);
}
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
function pumpCurve(creator, quoteMint) {
  return Buffer.concat([Buffer.from(DISC.accountBondingCurve, 'hex'), u64le(1), u64le(1), u64le(1), u64le(0), u64le(1), Buffer.from([0]), pk(creator).toBuffer(), Buffer.from([0, 0]), pk(quoteMint).toBuffer(), u64le(0), Buffer.from([0, 0]), u64le(0), u64le(0)]);
}
function sharingConfig(mint, admin, holders) {
  const parts = [Buffer.from(DISC.accountSharingConfig, 'hex'), Buffer.from([255, 2, 1]), pk(mint).toBuffer(), pk(admin).toBuffer(), Buffer.from([1])];
  const n = Buffer.alloc(4);
  n.writeUInt32LE(holders.length);
  parts.push(n);
  for (const h of holders) {
    const bps = Buffer.alloc(2);
    bps.writeUInt16LE(h.bps);
    parts.push(pk(h.address).toBuffer(), bps);
  }
  return Buffer.concat(parts);
}

/** A fake LaunchLab lookup table holding the fixed accounts (what Raydium's real one holds, and more). */
function llTable(cluster) {
  const a = launchlabAccounts(cluster, PLATFORMS.raydium[cluster] ?? PLATFORMS.bonk.mainnet, wallet(), wallet());
  const extra = cluster === 'mainnet' ? [PLATFORMS.bonk.mainnet, launchlabAccounts(cluster, PLATFORMS.bonk.mainnet, wallet(), wallet()).platformVault] : [];
  return new AddressLookupTableAccount({
    key: pk('AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU'),
    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [a.globalConfig, a.platform, a.auth, a.event, a.platformVault, P.metaplex, P.rent, WSOL, ...extra].map(pk) },
  });
}

// ── the fake chain: applies what each launchpad's instructions do ──
const COST = { llInit: 15_000_000, dbcConfig: 6_000_000, dbcInit: 25_000_000, pumpCreate: 8_000_000, pumpSplit: 3_000_000, bagsConfig: 4_000_000, bagsLaunch: 20_000_000 };
class PadChain {
  accounts = new Map();
  balances = new Map();
  tokens = new Map();
  statuses = new Map();
  sent = [];
  height = 900;
  onSend = () => 'land';
  onSimulate = () => null;
  /** extra lamports a simulation says leave the deposit (a transaction doing more than it shows) */
  drain = 0;
  table = null;
  constructor(cluster) {
    this.cluster = cluster;
    this.table = llTable(cluster);
    const prog = LAUNCHLAB_PROGRAM[cluster];
    const a = launchlabAccounts(cluster, PLATFORMS.raydium[cluster], wallet(), wallet());
    this.accounts.set(a.globalConfig, acct(llGlobal(), prog));
    this.accounts.set(PLATFORMS.raydium[cluster], acct(llPlatform(), prog));
    if (cluster === 'mainnet') this.accounts.set(PLATFORMS.bonk.mainnet, acct(llPlatform(), prog));
  }
  read(tx) {
    const ixs = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tx.message.addressTableLookups.length ? [this.table] : [] }).instructions;
    return { sig: base58(tx.signatures[0]), tx, ixs, payer: tx.message.staticAccountKeys[0].toBase58() };
  }
  signaturesValid(tx) {
    const msg = tx.message.serialize();
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    return signers.every((k, i) => sigValid(msg, tx.signatures[i], k));
  }
  fund(address, lamports) {
    this.balances.set(address, (this.balances.get(address) ?? 0) + lamports);
  }
  /** What a transaction costs its payer, and what it does. */
  effects(s) {
    let cost = 5_000 * s.tx.message.header.numRequiredSignatures;
    // the priority fee, as the runtime charges it: price x limit, rounded up
    let limit = 200_000;
    let price = 0n;
    for (const ix of s.ixs) {
      if (ix.programId.toBase58() !== P.computeBudget) continue;
      const b = Buffer.from(ix.data);
      if (b[0] === 2) limit = b.readUInt32LE(1);
      if (b[0] === 3) price = b.readBigUInt64LE(1);
    }
    cost += Number((price * BigInt(limit) + 999_999n) / 1_000_000n);
    const fx = [];
    const ll = LAUNCHLAB_PROGRAM[this.cluster];
    for (const ix of s.ixs) {
      const p = ix.programId.toBase58();
      const k = (i) => ix.keys[i]?.pubkey.toBase58();
      if (p === ll && d8(ix) === '4399af27da102620') {
        cost += COST.llInit;
        fx.push(() => {
          const a = launchlabAccounts(this.cluster, k(3), k(6), k(1));
          this.accounts.set(a.pool, acct(llPool(a, k(6), k(1)), ll));
          this.accounts.set(k(6), acct(Buffer.alloc(82), P.token));
        });
      } else if (p === ll && d8(ix) === 'faea0d7bd59c13ec') {
        cost += Number(decodeBuyExactIn(ix.data).amountIn);
        fx.push(() => this.tokens.set(k(5), (this.tokens.get(k(5)) ?? 0n) + 1n));
      } else if (p === DBC_PROGRAM) {
        const dec = dbcProgram.coder.instruction.decode(Buffer.from(ix.data));
        if (dec?.name === 'createConfig2') {
          cost += COST.dbcConfig;
          const c = dec.data.configParameters;
          fx.push(() => this.accounts.set(k(0), acct(dbcAccount('poolConfig', (o) => {
            o.feeClaimer = pk(k(1));
            o.leftoverReceiver = pk(k(2));
            o.quoteMint = pk(k(3));
            o.creatorTradingFeePercentage = c.creatorTradingFeePercentage;
            o.partnerLiquidityPercentage = c.partnerLiquidityPercentage;
            o.partnerPermanentLockedLiquidityPercentage = c.partnerPermanentLockedLiquidityPercentage;
          }), DBC_PROGRAM)));
        } else if (dec?.name === 'initializeVirtualPoolWithSplToken') {
          cost += COST.dbcInit;
          fx.push(() => {
            this.accounts.set(k(5), acct(dbcAccount('virtualPool', (o) => Object.assign(o, { config: pk(k(0)), creator: pk(k(2)), baseMint: pk(k(3)) })), DBC_PROGRAM));
            this.accounts.set(k(3), acct(Buffer.alloc(82), P.token));
          });
        } else if (dec?.name === 'swap') {
          cost += Number(dec.data.params.amountIn.toString());
          fx.push(() => this.tokens.set(k(4), (this.tokens.get(k(4)) ?? 0n) + 1n));
        } else if (dec?.name === 'transferPoolCreator') {
          fx.push(() => {
            const pool = dbcProgram.coder.accounts.decode('virtualPool', this.accounts.get(k(0)).data).poolState;
            this.accounts.set(k(0), acct(dbcAccount('virtualPool', (o) => Object.assign(o, { config: pool.config, creator: pk(k(3)), baseMint: pool.baseMint })), DBC_PROGRAM));
          });
        } else if (dec) {
          cost += COST.bagsLaunch;
          fx.push(() => this.accounts.set(k(3), acct(Buffer.alloc(82), P.token)));
        }
      } else if (p === PUMP && d8(ix) === DISC.createV2) {
        cost += COST.pumpCreate;
        const args = decodeCreateV2(Uint8Array.from(ix.data));
        fx.push(() => {
          this.accounts.set(k(0), acct(Buffer.alloc(82), P.token2022));
          this.accounts.set(bondingCurveOf(k(0)), acct(pumpCurve(args.creator, k(16) ?? PublicKey.default.toBase58()), PUMP));
        });
      } else if (p === PUMP_FEES && d8(ix) === DISC.updateFeeSharesV2) {
        cost += COST.pumpSplit;
        const holders = decodeUpdateSharesV2(Uint8Array.from(ix.data)).map((h) => ({ address: h.address, bps: h.shareBps }));
        const mint = k(4);
        fx.push(() => {
          this.accounts.set(sharingConfigOf(mint), acct(sharingConfig(mint, s.payer, holders), PUMP_FEES));
          const curve = this.accounts.get(bondingCurveOf(mint));
          const quote = new PublicKey(curve.data.subarray(8 + 40 + 1 + 32 + 2, 8 + 40 + 1 + 32 + 2 + 32)).toBase58();
          this.accounts.set(bondingCurveOf(mint), acct(pumpCurve(sharingConfigOf(mint), quote), PUMP));
        });
      } else if (p === BAGS_FEE_SHARE_V2) {
        cost += COST.bagsConfig;
        fx.push(() => this.accounts.set(k(1), acct(Buffer.alloc(100), BAGS_FEE_SHARE_V2)));
      } else if (p === P.system) {
        const lamports = decodeSystemTransfer(Uint8Array.from(ix.data));
        if (lamports !== null) {
          const to = k(1);
          if (to === ataOf(WSOL, s.payer)) continue; // wrapped: what the buy spends is counted at the buy
          cost += Number(lamports);
          fx.push(() => this.fund(to, Number(lamports)));
        }
      }
    }
    return { cost, fx };
  }
  rpc = {
    getBalance: async (k) => this.balances.get(k.toBase58()) ?? 0,
    getAccountInfo: async (k) => this.accounts.get(k.toBase58()) ?? (this.balances.get(k.toBase58()) ? acct(Buffer.alloc(0), P.system, this.balances.get(k.toBase58())) : null),
    getMultipleAccountsInfo: async (keys) => Promise.all(keys.map((k) => this.rpc.getAccountInfo(k))),
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }),
    getBlockHeight: async () => this.height,
    getAddressLookupTable: async () => ({ value: Object.assign(this.table, { isActive: () => true }) }),
    simulateTransaction: async (tx, opts) => {
      const s = this.read(tx);
      if (opts?.sigVerify && !this.signaturesValid(tx)) return { value: { err: 'SignatureFailure', logs: [], unitsConsumed: 0, accounts: null } };
      const { cost } = this.effects(s);
      const sweep = s.ixs.every((ix) => [P.system, P.computeBudget].includes(ix.programId.toBase58()));
      const after = (this.balances.get(s.payer) ?? 0) - cost - (sweep ? 0 : this.drain);
      return { value: { err: this.onSimulate(s) ?? (after < 0 ? { InstructionError: [0, 'InsufficientFunds'] } : null), logs: [], unitsConsumed: 180_000, accounts: [{ lamports: Math.max(0, after) }] } };
    },
    sendRawTransaction: async (wire) => {
      const tx = VersionedTransaction.deserialize(wire);
      if (!this.signaturesValid(tx)) throw new Error('signature verification failed');
      const s = this.read(tx);
      this.sent.push(s);
      if (this.statuses.has(s.sig)) return s.sig;
      const what = this.onSend(s);
      if (what === 'drop') return s.sig;
      const { cost, fx } = this.effects(s);
      const bal = this.balances.get(s.payer) ?? 0;
      const ok = what === 'land' && bal >= cost;
      if (ok) {
        this.balances.set(s.payer, bal - cost);
        for (const f of fx) f();
      }
      this.statuses.set(s.sig, { err: ok ? null : { InstructionError: [2, { Custom: 6000 }] } });
      return s.sig;
    },
    getSignatureStatuses: async (sigs) => ({ value: sigs.map((g) => (this.statuses.has(g) ? { slot: 1, confirmations: null, err: this.statuses.get(g).err, confirmationStatus: 'confirmed' } : null)) }),
    getSignaturesForAddress: async () => [],
    getTransaction: async () => null,
  };
}

// ── fixtures ──
const FEE = wallet();
const KITS = {};
const kitOf = (id) => ({ v: 1, id, sentence: 'a frog who does my taxes', name: 'deductoad', ticker: 'TOAD', bio: 'files your taxes for one cricket', logo: `https://store.public.blob.vercel-storage.com/kits/${id}/logo.png` });
let kitN = 0;
const newKit = () => {
  const id = `padkit${String(++kitN).padStart(10, '0')}`;
  KITS[id] = kitOf(id);
  return id;
};
const settings = (env = {}) => settingsFromEnv({ WAGBI_CLUSTER: 'devnet', WAGBI_FEE_WALLET: FEE, ...env });

function setup(o = {}) {
  const s = o.settings ?? settings();
  const chain = new PadChain(s.cluster);
  const objects = new WriteOnceObjects();
  const coins = new Map();
  const logs = [];
  let offset = 0;
  const svc = createLaunchService({
    rpc: chain.rpc,
    store: new DepositStore(objects, `${s.cluster}/test/`),
    custody: new LaunchCustody(new Uint8Array(randomBytes(32)), GUARDS),
    getKit: async (id) => KITS[id] ?? null,
    putMeta: async (name) => `https://abcdefghijklmnop.public.blob.vercel-storage.com/meta/${name}.json`,
    readCoin: async (id) => coins.get(id) ?? null,
    writeCoin: async (r) => void (coins.has(r.kitId) || coins.set(r.kitId, r)),
    settings: s,
    checkPublic: null,
    now: () => Date.now() + offset, log: (e) => void logs.push(e), runMs: 30_000, timing: { resendMs: 5, pollMs: 2, settleMs: 2, marginMs: 200 },
    secrets: { bagsKey: o.bagsKey ?? null }, fetch: o.fetch,
  });
  return { chain, svc, objects, coins, logs, later: (ms) => void (offset += ms) };
}
async function poll(t, id, times = 14) {
  let v;
  for (let i = 0; i < times; i++) {
    const st = await t.svc.status(id);
    v = st.view;
    if (st.needsRun) await t.svc.run(id);
    if (['live', 'refunded', 'expired'].includes(v.phase) && !st.needsRun) break;
  }
  return (await t.svc.status(id)).view;
}
const creatorBody = (launchpad, over = {}) => ({
  kitId: newKit(), chain: 'solana', launchpad, currency: 'SOL', type: 'normal', name: 'deductoad', ticker: 'toad', bio: 'files your taxes for one cricket', x: 'x.com/deductoad',
  payout: wallet(), firstBuySol: 0.1, ...over,
});

/** The guarantee, read from what was really sent: the deposit pays everything and SOL leaves it only into its own
 *  wrapped-SOL account (spent by the buy) or back to the payout wallet. */
function onlyOwnWrapOrPayout(chain, deposit, payout) {
  for (const s of chain.sent) {
    assert.equal(s.payer, deposit);
    for (const ix of s.ixs) {
      if (ix.programId.toBase58() !== P.system) continue;
      const lamports = decodeSystemTransfer(Uint8Array.from(ix.data));
      if (lamports === null) continue;
      assert.equal(ix.keys[0].pubkey.toBase58(), deposit);
      assert.ok([payout, ataOf(WSOL, deposit)].includes(ix.keys[1].pubkey.toBase58()), `SOL to ${ix.keys[1].pubkey.toBase58()}`);
    }
  }
}

// ── the custody ──
describe('custody: one sealed-key format, a guard per launchpad', () => {
  it("opens the engine's sealed keys, and nothing else", () => {
    const master = new Uint8Array(randomBytes(32));
    const engine = new Custody(master);
    const mine = new LaunchCustody(master, GUARDS);
    assert.equal(mine.kid, engine.kid);
    const { address, sealed } = engine.newDepositKey('dep_x');
    assert.equal(mine.signer(sealed, 'dep_x', address).address, address);
    const { address: a2, sealed: s2 } = mine.newDepositKey('dep_y');
    assert.equal(engine.signer(s2, 'dep_y', a2).address, a2);
    assert.throws(() => mine.signer(sealed, 'dep_other', address), /didn't open/);
    assert.throws(() => new LaunchCustody(new Uint8Array(randomBytes(32)), GUARDS).signer(sealed, 'dep_x', address), /another master key/);
    assert.equal(JSON.stringify(mine), '"[custody: redacted]"');
    assert.ok(!inspect(mine.signer(sealed, 'dep_x', address)).includes(sealed.ct));
  });
  it('refuses a policy whose guard it has no rules for, and extra signers the launch did not make', async () => {
    const mine = new LaunchCustody(new Uint8Array(randomBytes(32)), GUARDS);
    const { address, sealed } = mine.newDepositKey('dep_z');
    const signer = mine.signer(sealed, 'dep_z', address);
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: pk(address), recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: pk(address), toPubkey: pk(wallet()), lamports: 5 })] }).compileToV0Message());
    assert.throws(() => signer.sign(tx, { guard: 'nope', kind: 'create' }), /no guard for nope/);
    const stranger = Keypair.generate();
    assert.throws(() => signer.sign(tx, { guard: 'meteora-dbc', kind: 'create', signers: [] }, [stranger]), /refused/);
    assert.equal(tx.signatures[0].every((b) => b === 0), true, 'nothing was signed');
  });
});

// ── the picker and the switches ──
describe('the picker, per deployment', () => {
  it('devnet: what was proven on devnet is on; LetsBonk and Bags (no devnet) and Moonit say why not', () => {
    const c = setup().svc.config();
    const st = (id, cur = 'SOL') => c.launchpads.find((l) => l.id === id).currencies.find((x) => x.id === cur);
    assert.equal(st('pumpfun').status, 'live');
    assert.equal(st('pumpfun', 'USDC').status, 'live');
    assert.equal(st('raydium-launchlab').status, 'live');
    assert.equal(st('meteora-dbc').status, 'live');
    assert.equal(st('letsbonk').status, 'soon');
    assert.match(st('letsbonk').why, /no devnet deployment/);
    assert.equal(st('bags').status, 'soon');
    assert.equal(st('moonit').status, 'soon');
    assert.match(st('moonit').why, /co-signs/);
    assert.equal(st('pumpfun', 'USDC').firstBuy, false);
    assert.equal(st('pumpfun', 'USDC').maxWallets, MAX_WALLETS_USDC);
    assert.deepEqual(st('meteora-dbc').options.map((o) => o.id), ['startMcap', 'gradMcap', 'feeBps', 'poolFeeBps']);
    assert.deepEqual(st('raydium-launchlab').options.map((o) => o.id), ['raise', 'feeOn']);
    assert.match(c.launchpads.find((l) => l.id === 'meteora-dbc').feeNote, /you keep all the creator fees on Meteora DBC/);
    assert.match(c.launchpads.find((l) => l.id === 'raydium-launchlab').feeNote, /you keep all the creator fees on Raydium LaunchLab/);
  });
  it('mainnet: only pump.fun on SOL until a switch is set; Bags also needs its key', () => {
    const live = (s) => setup({ settings: s }).svc.config().launchpads.flatMap((l) => l.currencies.filter((x) => x.status === 'live').map((x) => `${l.id}/${x.id}`));
    assert.deepEqual(live(settings({ WAGBI_CLUSTER: 'mainnet' })), ['pumpfun/SOL']);
    assert.deepEqual(live(settings({ WAGBI_CLUSTER: 'mainnet', WAGBI_LAUNCH_METEORA_DBC: 'on', WAGBI_LAUNCH_LETSBONK: 'on' })), ['pumpfun/SOL', 'letsbonk/SOL', 'meteora-dbc/SOL']);
    assert.deepEqual(live(settings({ WAGBI_CLUSTER: 'mainnet', WAGBI_LAUNCH_BAGS: 'on' })), ['pumpfun/SOL']);
    assert.deepEqual(live(settings({ WAGBI_CLUSTER: 'mainnet', WAGBI_LAUNCH_BAGS: 'on', BAGS_API_KEY: 'k' })), ['pumpfun/SOL', 'bags/SOL']);
    assert.deepEqual(live(settings({ WAGBI_LAUNCH_METEORA_DBC: 'off' })).includes('meteora-dbc/SOL'), false);
  });
  it('without wagbi\'s fee wallet, pump.fun is closed but the creator-fee launchpads stay open', () => {
    const c = setup({ settings: settings({ WAGBI_FEE_WALLET: '' }) }).svc.config();
    assert.equal(c.open, true);
    assert.equal(c.launchpads.find((l) => l.id === 'pumpfun').status, 'soon');
    assert.equal(c.launchpads.find((l) => l.id === 'meteora-dbc').status, 'live');
  });
});

// ── the request ──
describe('the request, per launchpad', () => {
  const s = settings();
  it('a creator-fee launchpad: no split (one share, the payout wallet at 100%), its own options, checked', () => {
    const b = cleanLaunchBody(creatorBody('meteora-dbc', { options: { startMcap: '20', feeBps: 200 } }), s);
    assert.equal(b.feeModel, 'creator');
    assert.equal(b.creatorBps, 10_000);
    assert.deepEqual(b.wallets, []);
    assert.deepEqual(b.options, { startMcap: 20, gradMcap: 400, feeBps: 200, poolFeeBps: 100 });
    assert.throws(() => cleanLaunchBody(creatorBody('meteora-dbc', { wallets: [{ address: wallet(), bps: 500 }] }), s), /keep all the creator fees/);
    assert.throws(() => cleanLaunchBody(creatorBody('meteora-dbc', { creatorBps: 8500 }), s), /keep all the creator fees/);
    assert.throws(() => cleanLaunchBody(creatorBody('meteora-dbc', { options: { startMcap: 31 } }), s), /starting market cap/);
    assert.throws(() => cleanLaunchBody(creatorBody('raydium-launchlab', { options: { sneaky: 1 } }), s), /no option called sneaky/);
    assert.throws(() => cleanLaunchBody(creatorBody('letsbonk'), s), (e) => e.code === 'closed');
    assert.throws(() => cleanLaunchBody(creatorBody('moonit'), s), (e) => e.code === 'closed');
  });
  it(`pump.fun USDC: the same split as SOL (wagbi 15%), no first buy, ${MAX_WALLETS_USDC} wallets at most`, () => {
    const base = { kitId: newKit(), launchpad: 'pumpfun', currency: 'USDC', type: 'normal', name: 'deductoad', ticker: 'toad', bio: 'x', payout: wallet(), creatorBps: 8500, wallets: [], firstBuySol: 0 };
    const b = cleanLaunchBody(base, s);
    assert.equal(b.feeModel, 'split');
    assert.throws(() => cleanLaunchBody({ ...base, firstBuySol: 0.1 }, s), /no first buy on pump\.fun with USDC/);
    const six = Array.from({ length: MAX_WALLETS_USDC - 2 }, () => ({ address: wallet(), bps: 100 }));
    assert.equal(cleanLaunchBody({ ...base, creatorBps: 8500 - six.length * 100, wallets: six }, s).wallets.length, MAX_WALLETS_USDC - 2);
    const seven = [...six, { address: wallet(), bps: 100 }];
    assert.throws(() => cleanLaunchBody({ ...base, creatorBps: 8500 - seven.length * 100, wallets: seven }, s), (e) => e.userMessage.includes(`${MAX_WALLETS_USDC - 2} more wallets at most (${MAX_WALLETS_USDC} in the split`));
  });
});

// ── Raydium LaunchLab ──
describe('Raydium LaunchLab', () => {
  it('launches by deposit: the payout wallet is the creator, the first buy lands in it, the leftover comes back', async () => {
    const t = setup();
    const body = creatorBody('raydium-launchlab', { options: { raise: 30, feeOn: 'both' } });
    const v = await t.svc.create(body);
    assert.deepEqual(v.shares, [{ role: 'creator', address: body.payout, bps: 10_000 }]);
    assert.equal(v.feeModel, 'creator');
    assert.equal(v.steps.split, 'skip');
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'live', end.problem ?? '');
    const mint = end.launch.mint;
    const a = launchlabAccounts('devnet', PLATFORMS.raydium.devnet, mint, body.payout);
    assert.equal(new PublicKey(t.chain.accounts.get(a.pool).data.subarray(333, 365)).toBase58(), body.payout, "the pool's creator is the payout wallet");
    assert.ok(t.chain.tokens.get(ataOf(mint, body.payout)) > 0n, 'the first buy landed in the payout wallet');
    const create = t.chain.sent.find((s) => s.ixs.some((ix) => d8(ix) === '4399af27da102620'));
    const init = decodeInitializeV2(create.ixs.find((ix) => d8(ix) === '4399af27da102620').data);
    assert.equal(init.raise, 30_000_000_000n);
    assert.equal(init.feeOn, 1);
    assert.equal(end.returns.at(-1).to, body.payout);
    assert.equal(t.chain.balances.get(v.address), 0);
    onlyOwnWrapOrPayout(t.chain, v.address, body.payout);
    const coin = await t.svc.coin(body.kitId);
    assert.equal(coin.feeModel, 'creator');
    assert.equal(coin.launchpad, 'raydium-launchlab');
    assert.equal(coin.splitLocked, false);
    assert.deepEqual(coin.split, [{ role: 'creator', address: body.payout, bps: 10_000 }]);
    assert.equal(coin.links.pump, null);
  });
  it('without a first buy: initialize_v2 alone', async () => {
    const t = setup();
    const body = creatorBody('raydium-launchlab', { firstBuySol: 0 });
    const v = await t.svc.create(body);
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'live');
    assert.equal(t.chain.sent.find((s) => s.ixs.some((ix) => d8(ix) === '4399af27da102620')).ixs.filter((ix) => ix.programId.toBase58() !== P.computeBudget).length, 1);
  });
  it('the longest name, ticker and a 90-character metadata link fit in one transaction (with the lookup table)', async () => {
    const t = setup();
    const deposit = wallet();
    const built = await raydiumLaunchlab.buildCreate({
      rpc: t.chain.rpc, cluster: 'devnet', deposit, payout: wallet(), name: 'n'.repeat(32), symbol: 'ABCDEFGHIJ', uri: `https://abcdefghijklmnop.public.blob.vercel-storage.com/meta/${'f'.repeat(16)}.json`,
      firstBuy: { lamports: 1_000_000_000n, slippagePct: 5 }, maxFirstBuyLamports: 1_050_000_000, cu: 400_000, cuPrice: 2_000, blockhash: BLOCKHASH, options: raydiumLaunchlab.cleanOptions({}),
    });
    assert.ok(built.size <= 1232, `${built.size} bytes`);
    assert.deepEqual(raydiumLaunchlab.checkTx(built.tx, { ...built.policy, deposit }), []);
  });
  it("the guard refuses: another creator, coins bought into the deposit, a share fee, locked coins, another platform, an outsider's signature", async () => {
    const t = setup();
    const deposit = wallet();
    const payout = wallet();
    const build = () => raydiumLaunchlab.buildCreate({
      rpc: t.chain.rpc, cluster: 'devnet', deposit, payout, name: 'deductoad', symbol: 'TOAD', uri: 'https://x.y/m.json', firstBuy: { lamports: 100_000_000n, slippagePct: 5 }, maxFirstBuyLamports: 105_000_000,
      cu: 400_000, cuPrice: 1_000, blockhash: BLOCKHASH, options: raydiumLaunchlab.cleanOptions({}),
    });
    const ok = await build();
    const p = { ...ok.policy, deposit };
    assert.deepEqual(raydiumLaunchlab.checkTx(ok.tx, p), []);
    const tamper = (fn) => {
      const ixs = TransactionMessage.decompile(ok.tx.message, { addressLookupTableAccounts: ok.policy.tables }).instructions;
      fn(ixs);
      return new VersionedTransaction(new TransactionMessage({ payerKey: pk(deposit), recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message(ok.policy.tables));
    };
    const initAt = 2;
    const buyAt = 7;
    const refused = (tx, re) => assert.ok(raydiumLaunchlab.checkTx(tx, p).some((x) => re.test(x)), raydiumLaunchlab.checkTx(tx, p).join(' | '));
    refused(tamper((ixs) => (ixs[initAt].keys[1].pubkey = pk(deposit))), /creator isn't the payout/);
    refused(tamper((ixs) => (ixs[buyAt].keys[5].pubkey = pk(ataOf(ok.mint, deposit)))), /into the payout wallet/);
    refused(tamper((ixs) => (ixs[buyAt].data = Buffer.concat([ixs[buyAt].data.subarray(0, 24), u64le(100)]))), /share fee/);
    refused(tamper((ixs) => {
      const d = Buffer.from(ixs[initAt].data);
      d.writeBigUInt64LE(1n, d.length - 25);
      ixs[initAt].data = d;
    }), /locks coins/);
    refused(tamper((ixs) => (ixs[initAt].keys[3].pubkey = pk(wallet()))), /platform/);
    refused(tamper((ixs) => ixs.push(new TransactionInstruction({ programId: pk(P.system), keys: [{ pubkey: pk(wallet()), isSigner: true, isWritable: true }], data: Buffer.alloc(0) }))), /signer the launch did not make/);
    refused(tamper((ixs) => ixs.push(SystemProgram.transfer({ fromPubkey: pk(deposit), toPubkey: pk(wallet()), lamports: 1 }))), /must be: coin account, wrap, buy, unwrap/);
  });
  it("a platform that restricts its curves is refused before anything is signed (the SOL comes back)", async () => {
    const t = setup();
    t.chain.accounts.set(PLATFORMS.raydium.devnet, acct(llPlatform({ restricted: true }), LAUNCHLAB_PROGRAM.devnet));
    const body = creatorBody('raydium-launchlab', { firstBuySol: 0 });
    const v = await t.svc.create(body);
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'refunded');
    assert.match(end.problem, /isn't taking coins like this right now/);
    assert.equal(t.chain.sent.filter((s) => s.ixs.some((ix) => d8(ix) === '4399af27da102620')).length, 0);
  });
  it('LetsBonk: bonk.fun\'s platform and standard curve, switched on for mainnet only', async () => {
    const t = setup({ settings: settings({ WAGBI_CLUSTER: 'mainnet', WAGBI_LAUNCH_LETSBONK: 'on' }) });
    const body = creatorBody('letsbonk');
    assert.throws(() => cleanLaunchBody({ ...body, options: { raise: 30 } }, t.svc.settings), /no option called raise/);
    const v = await t.svc.create(body);
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'live', end.problem ?? '');
    const create = t.chain.sent.find((s) => s.ixs.some((ix) => d8(ix) === '4399af27da102620'));
    const init = create.ixs.find((ix) => d8(ix) === '4399af27da102620');
    assert.equal(init.keys[3].pubkey.toBase58(), PLATFORMS.bonk.mainnet);
    const args = decodeInitializeV2(init.data);
    assert.deepEqual([args.supply, args.totalSell, args.raise, args.feeOn], [1_000_000_000_000_000n, 793_100_000_000_000n, 85_000_000_000n, 0]);
    assert.equal(end.launch.links.pad.url, `https://bonk.fun/token/${end.launch.mint}`);
    void letsbonk;
  });
});

// ── Meteora DBC ──
describe('Meteora DBC', () => {
  it("launches by deposit: the coin's own config (fees and leftovers to the payout wallet), the pool, the first buy, the creator handed over", async () => {
    const t = setup();
    const body = creatorBody('meteora-dbc', { options: { gradMcap: 800, feeBps: 50 } });
    const v = await t.svc.create(body);
    assert.ok(v.amounts.networkLamports >= 33_000_000);
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'live', end.problem ?? '');
    const mint = end.launch.mint;
    const prep = t.chain.sent.find((s) => s.ixs.some((ix) => ix.programId.toBase58() === DBC_PROGRAM && dbcProgram.coder.instruction.decode(Buffer.from(ix.data))?.name === 'createConfig2'));
    const config = prep.ixs.find((ix) => ix.programId.toBase58() === DBC_PROGRAM).keys[0].pubkey;
    const cfg = dbcProgram.coder.accounts.decode('poolConfig', t.chain.accounts.get(config.toBase58()).data);
    assert.equal(cfg.feeClaimer.toBase58(), body.payout);
    assert.equal(cfg.leftoverReceiver.toBase58(), body.payout);
    assert.equal(cfg.creatorTradingFeePercentage, 100);
    const pool = S.deriveDbcPoolAddress(pk(WSOL), pk(mint), config).toBase58();
    assert.equal(dbcProgram.coder.accounts.decode('virtualPool', t.chain.accounts.get(pool).data).poolState.creator.toBase58(), body.payout);
    assert.ok(t.chain.tokens.get(ataOf(mint, body.payout)) > 0n);
    assert.equal(t.chain.balances.get(v.address), 0);
    onlyOwnWrapOrPayout(t.chain, v.address, body.payout);
    const sent = dbcProgram.coder.instruction.decode(Buffer.from(prep.ixs.find((ix) => ix.programId.toBase58() === DBC_PROGRAM).data)).data.configParameters;
    assert.equal(sent.poolFees.baseFee.cliffFeeNumerator.toString(), configParams({ startMcap: 30, gradMcap: 800, feeBps: 50, poolFeeBps: 100 }).poolFees.baseFee.cliffFeeNumerator.toString());
    assert.equal((await t.svc.coin(body.kitId)).setup.config, config.toBase58());
  });
  it("the guard refuses a config that pays anyone else, or isn't what the options make; a create without the hand-over or buying into the deposit", async () => {
    const deposit = wallet();
    const payout = wallet();
    const o = meteoraDbc.cleanOptions({});
    const prep = await meteoraDbc.buildPrep({ deposit, payout, cu: 200_000, cuPrice: 1, blockhash: BLOCKHASH, options: o });
    assert.deepEqual(meteoraDbc.checkTx(prep.tx, { ...prep.policy, deposit }), []);
    assert.ok(meteoraDbc.checkTx(prep.tx, { ...prep.policy, deposit, payout: wallet() }).some((x) => /fee claimer/.test(x)));
    assert.ok(meteoraDbc.checkTx(prep.tx, { ...prep.policy, deposit, options: { ...o, feeBps: 200 } }).some((x) => /isn't the one these options make/.test(x)));
    const other = await meteoraDbc.buildPrep({ deposit, payout: wallet(), cu: 200_000, cuPrice: 1, blockhash: BLOCKHASH, options: o, keys: prep.keys });
    assert.ok(meteoraDbc.checkTx(other.tx, { ...prep.policy, deposit }).some((x) => /fee claimer/.test(x)));
    const c = await meteoraDbc.buildCreate({ deposit, payout, name: 'deductoad', symbol: 'TOAD', uri: 'https://x.y/m.json', firstBuy: { lamports: 100_000_000n, slippagePct: 5 }, maxFirstBuyLamports: 105_000_000, cu: 400_000, cuPrice: 1, blockhash: BLOCKHASH, options: o, prep: prep.data });
    const p = { ...c.policy, deposit };
    assert.deepEqual(meteoraDbc.checkTx(c.tx, p), []);
    const ixs = TransactionMessage.decompile(c.tx.message).instructions;
    const remake = (list) => new VersionedTransaction(new TransactionMessage({ payerKey: pk(deposit), recentBlockhash: BLOCKHASH, instructions: list }).compileToV0Message());
    assert.ok(meteoraDbc.checkTx(remake(ixs.slice(0, -1)), p).some((x) => /hand the pool's creator/.test(x)));
    const swapAt = ixs.findIndex((ix) => ix.programId.toBase58() === DBC_PROGRAM && dbcProgram.coder.instruction.decode(Buffer.from(ix.data))?.name === 'swap');
    const bad = ixs.map((ix, i) => (i === swapAt ? new TransactionInstruction({ ...ix, keys: ix.keys.map((k, j) => (j === 4 ? { ...k, pubkey: pk(ataOf(c.mint, deposit)) } : k)) }) : ix));
    assert.ok(meteoraDbc.checkTx(remake(bad), p).some((x) => /into the payout wallet/.test(x)));
    assert.ok(c.size <= 1232);
  });
  it('the spend cap: a create whose simulation takes more than the launch costs is never sent; three of them refund everything', async () => {
    const t = setup();
    const body = creatorBody('meteora-dbc', { firstBuySol: 0 });
    const v = await t.svc.create(body);
    // overpaid by 5 SOL, and after the config lands every simulation says 1 SOL more leaves the deposit than it shows
    t.chain.fund(v.address, v.amounts.totalLamports + 5_000_000_000);
    t.chain.onSend = (s) => {
      if (s.ixs.some((ix) => ix.programId.toBase58() === DBC_PROGRAM && dbcProgram.coder.instruction.decode(Buffer.from(ix.data))?.name === 'createConfig2')) t.chain.drain = 1_000_000_000;
      return 'land';
    };
    const end = await poll(t, v.id, 20);
    assert.equal(end.phase, 'refunded');
    assert.match(end.problem, /Meteora DBC didn't accept the coin/);
    assert.equal(t.chain.sent.filter((s) => s.ixs.some((ix) => ix.programId.toBase58() === DBC_PROGRAM && dbcProgram.coder.instruction.decode(Buffer.from(ix.data))?.name === 'initializeVirtualPoolWithSplToken')).length, 0);
    assert.ok(t.logs.some((e) => e.evt === 'launch.create_sim_failed' && /spend cap/.test(e.error)));
    assert.equal(end.returns.at(-1).to, body.payout);
  });
  it('a config that landed but whose create keeps failing still refunds what is left', async () => {
    const t = setup();
    t.chain.onSimulate = (s) => (s.ixs.some((ix) => ix.programId.toBase58() === DBC_PROGRAM && dbcProgram.coder.instruction.decode(Buffer.from(ix.data))?.name === 'initializeVirtualPoolWithSplToken') ? { InstructionError: [2, { Custom: 6001 }] } : null);
    const body = creatorBody('meteora-dbc');
    const v = await t.svc.create(body);
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id, 20);
    assert.equal(end.phase, 'refunded');
    assert.equal(t.chain.balances.get(v.address), 0);
    const got = t.chain.balances.get(body.payout);
    assert.ok(got < v.amounts.totalLamports - COST.dbcConfig && got > v.amounts.totalLamports - COST.dbcConfig - 600_000, `payout got ${got}`);
  });
});

// ── pump.fun USDC ──
describe('pump.fun USDC pairs', () => {
  it('launches by deposit: create_v2 on USDC (no first buy), then the same locked split as SOL', async () => {
    const t = setup();
    const payout = wallet();
    const extra = wallet();
    const body = { kitId: newKit(), launchpad: 'pumpfun', currency: 'USDC', type: 'normal', name: 'deductoad', ticker: 'toad', bio: 'x', payout, creatorBps: 7500, wallets: [{ address: extra, bps: 1000 }], firstBuySol: 0 };
    const v = await t.svc.create(body);
    assert.deepEqual(v.shares.map((x) => x.bps), [7500, 1500, 1000]);
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'live', end.problem ?? '');
    const create = t.chain.sent.find((s) => s.ixs.some((ix) => ix.programId.toBase58() === PUMP && d8(ix) === DISC.createV2)).ixs.find((ix) => d8(ix) === DISC.createV2);
    assert.equal(create.keys[16].pubkey.toBase58(), USDC.devnet);
    const split = t.chain.sent.find((s) => s.ixs.some((ix) => d8(ix) === DISC.updateFeeSharesV2)).ixs.find((ix) => d8(ix) === DISC.updateFeeSharesV2);
    assert.deepEqual(decodeUpdateSharesV2(Uint8Array.from(split.data)).map((h) => `${h.address}:${h.shareBps}`).sort(), v.shares.map((x) => `${x.address}:${x.bps}`).sort());
    assert.equal(end.launch.links.pump, null);
    const coin = await t.svc.coin(body.kitId);
    assert.equal(coin.currency, 'USDC');
    assert.equal(coin.splitLocked, true);
  });
  it(`a split of ${MAX_WALLETS_USDC} wallets fits one transaction; ${MAX_WALLETS_USDC + 1} would not`, async () => {
    const shares = (n) => Array.from({ length: n }, (_, i) => ({ role: 'wallet', address: wallet(), bps: i === 0 ? 10_000 - (n - 1) * 100 : 100 }));
    const deposit = wallet();
    const mint = wallet();
    const built = await pumpfunUsdc.buildSplit({ cluster: 'mainnet', mint, deposit, payout: wallet(), shares: shares(MAX_WALLETS_USDC), cu: 300_000, cuPrice: 1, blockhash: BLOCKHASH });
    assert.ok(built.size <= 1232, `${built.size} bytes`);
    await assert.rejects(pumpfunUsdc.buildSplit({ cluster: 'mainnet', mint, deposit, payout: wallet(), shares: shares(MAX_WALLETS_USDC + 1), cu: 300_000, cuPrice: 1, blockhash: BLOCKHASH }), /over the 1232-byte limit/);
  });
  it('the guard refuses a SOL-quoted create, a first buy, and a split other than the pinned one', async () => {
    const deposit = wallet();
    const c = await pumpfunUsdc.buildCreate({ cluster: 'devnet', deposit, name: 'deductoad', symbol: 'TOAD', uri: 'https://x.y/m.json', cu: 160_000, cuPrice: 1, blockhash: BLOCKHASH });
    assert.deepEqual(pumpfunUsdc.checkTx(c.tx, { ...c.policy, deposit }), []);
    assert.ok(pumpfunUsdc.checkTx(c.tx, { ...c.policy, deposit, cluster: 'mainnet' }).some((x) => /USDC pair on this network/.test(x)));
    await assert.rejects(pumpfunUsdc.buildCreate({ cluster: 'devnet', deposit, name: 'x', symbol: 'X', uri: 'u', firstBuy: { lamports: 1n }, blockhash: BLOCKHASH }), /bought with USDC/);
    const payout = wallet();
    const pinned = [{ address: payout, shareBps: 8500 }, { address: FEE, shareBps: 1500 }];
    const s = await pumpfunUsdc.buildSplit({ cluster: 'devnet', mint: c.mint, deposit, payout, shares: pinned.map((x) => ({ address: x.address, bps: x.shareBps })), cu: 300_000, cuPrice: 1, blockhash: BLOCKHASH });
    assert.deepEqual(pumpfunUsdc.checkTx(s.tx, { ...s.policy, deposit }), []);
    assert.ok(pumpfunUsdc.checkTx(s.tx, { ...s.policy, deposit, shares: [{ address: payout, shareBps: 9000 }, { address: FEE, shareBps: 1000 }] }).some((x) => /pinned|exactly the launch's split/.test(x)));
  });
});

// ── Bags (mock only: no devnet, needs a key) ──
describe('Bags (mocked API; switched off by default)', () => {
  const KEY = 'test-bags-key';
  function fakeBags(t, o = {}) {
    const calls = [];
    const mintKp = Keypair.generate();
    const configKey = Keypair.generate().publicKey.toBase58();
    let deposit = null;
    const fetch = async (url, init) => {
      const path = url.replace('https://public-api-v2.bags.fm/api/v1', '');
      calls.push({ path, headers: init.headers, body: init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body) });
      const ok = (response) => ({ ok: true, status: 200, json: async () => ({ success: true, response }) });
      if (path === '/token-launch/create-token-info') return ok({ tokenMint: mintKp.publicKey.toBase58(), tokenMetadata: 'https://ipfs.bags.fm/meta.json' });
      if (path === '/fee-share/config') {
        deposit = calls.at(-1).body.payer;
        const ix = new TransactionInstruction({ programId: pk(BAGS_FEE_SHARE_V2), keys: [{ pubkey: pk(deposit), isSigner: true, isWritable: true }, { pubkey: pk(configKey), isSigner: false, isWritable: true }], data: Buffer.from([1, 2, 3]) });
        const extra = o.configSteal ? [SystemProgram.transfer({ fromPubkey: pk(deposit), toPubkey: pk(wallet()), lamports: 1_000_000 })] : [];
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: pk(deposit), recentBlockhash: BLOCKHASH, instructions: [ix, ...extra] }).compileToV0Message());
        return ok({ needsCreation: true, transactions: [{ transaction: base58(tx.serialize()) }], meteoraConfigKey: configKey });
      }
      if (path === '/token-launch/create-launch-transaction') {
        const keys = [configKey, wallet(), deposit, mintKp.publicKey.toBase58()].map((k, i) => ({ pubkey: pk(k), isSigner: i === 2 || i === 3, isWritable: true }));
        const ix = new TransactionInstruction({ programId: pk(DBC_PROGRAM), keys, data: Buffer.from(dbcProgram.coder.instruction.encode('createLocker', {})) });
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: pk(deposit), recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message());
        if (!o.unsignedMint) tx.sign([mintKp]);
        return ok(base58(tx.serialize()));
      }
      return { ok: false, status: 404, json: async () => ({ success: false, error: 'no' }) };
    };
    void t;
    return { fetch, calls, mint: mintKp.publicKey.toBase58(), configKey };
  }
  const bagsSettings = (env = {}) => settings({ WAGBI_CLUSTER: 'mainnet', WAGBI_LAUNCH_BAGS: 'on', BAGS_API_KEY: KEY, ...env });

  it('is off without its key or its switch', () => {
    assert.match(adapterFor('solana', 'bags', 'SOL', settings({ WAGBI_CLUSTER: 'mainnet', WAGBI_LAUNCH_BAGS: 'on' })).why, /API key/);
    assert.match(adapterFor('solana', 'bags', 'SOL', settings({ WAGBI_CLUSTER: 'mainnet', BAGS_API_KEY: KEY })).why, /needs a Bags API key and has no devnet/);
    assert.match(adapterFor('solana', 'bags', 'SOL', settings({ WAGBI_LAUNCH_BAGS: 'on', BAGS_API_KEY: KEY })).why, /no devnet deployment/);
  });
  it('launches through the API: one claimer (the payout wallet, 100%, also the admin), the key only in the x-api-key header', async () => {
    const holder = {};
    const t = setup({ settings: bagsSettings(), bagsKey: KEY, fetch: (...a) => holder.f(...a) });
    const fake = fakeBags(t);
    holder.f = fake.fetch;
    const body = creatorBody('bags', { firstBuySol: 0 });
    assert.throws(() => cleanLaunchBody({ ...body, firstBuySol: 0.1 }, t.svc.settings), /no first buy on Bags/);
    const v = await t.svc.create(body);
    t.chain.fund(v.address, v.amounts.totalLamports);
    const end = await poll(t, v.id);
    assert.equal(end.phase, 'live', end.problem ?? '');
    assert.equal(end.launch.mint, fake.mint);
    const cfg = fake.calls.find((c) => c.path === '/fee-share/config').body;
    assert.deepEqual([cfg.claimersArray, cfg.basisPointsArray, cfg.admin, cfg.payer], [[body.payout], [10_000], body.payout, v.address]);
    assert.ok(fake.calls.every((c) => c.headers['x-api-key'] === KEY));
    assert.ok(!JSON.stringify([t.logs, end, await t.svc.coin(body.kitId)]).includes(KEY));
    assert.equal(t.chain.balances.get(v.address), 0);
  });
  it("the guard refuses Bags' transactions that move SOL out, or a launch the mint didn't sign", async () => {
    for (const [o, re] of [[{ configSteal: true }, /SOL straight out/], [{ unsignedMint: true }, /isn't signed by the coin's mint/]]) {
      const holder = {};
      const t = setup({ settings: bagsSettings(), bagsKey: KEY, fetch: (...a) => holder.f(...a) });
      holder.f = fakeBags(t, o).fetch;
      const body = creatorBody('bags', { firstBuySol: 0 });
      const v = await t.svc.create(body);
      t.chain.fund(v.address, v.amounts.totalLamports);
      const end = await poll(t, v.id);
      assert.equal(end.phase, 'refunded');
      assert.ok(t.logs.some((e) => e.evt === 'launch.failed' && re.test(e.detail)), JSON.stringify(t.logs.filter((e) => e.evt === 'launch.failed')));
      assert.equal(t.chain.balances.get(body.payout) > 0, true);
    }
  });
});

void createHash;
void USDC;
