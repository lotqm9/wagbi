// A real launch on Solana DEVNET (never mainnet: it checks the genesis hash and refuses anything else), through
// wagbi's own launch service with the engine's real builders, guard, custody and send loop. Devnet SOL only,
// from the public faucet: nothing here costs money. Every key is made in memory and dropped at the end; none is
// printed or written anywhere.
//   1. a throwaway funder gets devnet SOL from the faucet
//   2. a devnet lookup table with pump.fun's fixed accounts (create + first buy don't fit without one)
//   3. a deposit for a test coin: payout wallet + wagbi + 2 more wallets, 0.01 SOL first buy
//   4. the funder sends exactly the amount asked; the service launches it; the chain is read back:
//      the coin's curve, the split exactly as set and locked, the coins in the payout wallet, the leftover back
//   5. an underpaid deposit, refunded on request (time moved on by the service's clock seam)
// Run: node test/devnet-launch.mjs        (optional: WAGBI_DEVNET_RPC, WAGBI_DEVNET_FAUCET: devnet RPCs)
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  AddressLookupTableProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { Custody, DepositStore, loadPumpState, readLaunchOnChain, tableAddresses } from 'printer-engine/launch';
import { createLaunchService } from '../api/_lib/launch/service.js';
import { settingsFromEnv } from '../api/_lib/launch/settings.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RPC = process.env.WAGBI_DEVNET_RPC || 'https://api.devnet.solana.com';
const rpc = new Connection(RPC, 'confirmed');
// solana's own RPC faucet is closed on devnet (410, 2026-11-01); Alchemy's public demo endpoint still airdrops
const FAUCET = process.env.WAGBI_DEVNET_FAUCET || 'https://solana-devnet.g.alchemy.com/v2/demo';
const faucet = new Connection(FAUCET, 'confirmed');
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const genesis = await rpc.getGenesisHash();
if (genesis !== DEVNET_GENESIS) throw new Error(`refusing: ${RPC} is not devnet (genesis ${genesis})`);
say('devnet confirmed');

// 1. devnet SOL
// a throwaway DEVNET key. WAGBI_DEVNET_FUNDER_FILE (a temp path outside the vault) keeps it between runs so the
// faucet isn't asked again; it is worthless off devnet and never a mainnet key.
const FUNDER_FILE = process.env.WAGBI_DEVNET_FUNDER_FILE;
const funder = FUNDER_FILE && existsSync(FUNDER_FILE) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(FUNDER_FILE, 'utf8')))) : Keypair.generate();
if (FUNDER_FILE && !existsSync(FUNDER_FILE)) writeFileSync(FUNDER_FILE, JSON.stringify([...funder.secretKey]));
let funded = await rpc.getBalance(funder.publicKey);
for (let i = 0; i < 6 && funded < 0.2 * LAMPORTS_PER_SOL; i++) {
  try {
    if ((await faucet.getGenesisHash()) !== DEVNET_GENESIS) throw new Error('the faucet is not devnet');
    const sig = await faucet.requestAirdrop(funder.publicKey, 0.5 * LAMPORTS_PER_SOL);
    await rpc.confirmTransaction({ signature: sig, ...(await rpc.getLatestBlockhash()) }, 'confirmed');
  } catch (e) {
    say('airdrop:', String(e.message).slice(0, 120));
    await sleep(4000 * (i + 1));
  }
  funded = await rpc.getBalance(funder.publicKey);
}
if (funded < 0.1 * LAMPORTS_PER_SOL) throw new Error('the devnet faucet gave nothing; try again later or set WAGBI_DEVNET_RPC');
say('funder has', funded / LAMPORTS_PER_SOL, 'devnet SOL');

async function send(ixs, signers) {
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  tx.sign(signers);
  const sig = await rpc.sendRawTransaction(tx.serialize());
  const r = await rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (r.value.err) throw new Error(`devnet tx failed: ${JSON.stringify(r.value.err)}`);
  return sig;
}

// 2. a devnet lookup table with pump.fun's fixed accounts
const pump = await loadPumpState(rpc);
const slot = (await rpc.getSlot('confirmed')) - 10; // must be in SlotHashes (the last 512 slots)
const [createIx, alt] = AddressLookupTableProgram.createLookupTable({ authority: funder.publicKey, payer: funder.publicKey, recentSlot: slot });
const addrs = tableAddresses(pump.global);
await send([createIx, AddressLookupTableProgram.extendLookupTable({ lookupTable: alt, authority: funder.publicKey, payer: funder.publicKey, addresses: addrs })], [funder]);
say('lookup table', alt.toBase58(), 'with', addrs.length, 'addresses');
for (let i = 0; i < 20; i++) {
  const t = (await rpc.getAddressLookupTable(alt)).value;
  if (t && t.state.addresses.length === addrs.length && (await rpc.getSlot('confirmed')) > Number(t.state.lastExtendedSlot)) break;
  await sleep(800);
}

// 3. the service, wired the way wire.js wires it, with a memory store and a fresh master key
class WriteOnceObjects {
  label = 'memory';
  m = new Map();
  async put(k, body, o) {
    if (this.m.has(k)) return false;
    this.m.set(k, { body: Buffer.from(body), contentType: o.contentType });
    return true;
  }
  async get(k) {
    return this.m.get(k) ?? null;
  }
  async list(p) {
    return [...this.m.keys()].filter((k) => k.startsWith(p)).sort();
  }
}
const fee = Keypair.generate().publicKey.toBase58();
const payout = Keypair.generate().publicKey.toBase58();
// WAGBI_DEVNET_EXTRA: how many wallets besides the payout and wagbi (default 2; 6 is the most a split holds)
const EXTRA = Math.max(0, Math.min(6, Number(process.env.WAGBI_DEVNET_EXTRA ?? 2)));
const extra = Array.from({ length: EXTRA }, () => Keypair.generate().publicKey.toBase58());
const KIT = 'devnetTest' + randomBytes(3).toString('hex');  // 16 characters, like a wagbi kit id
const kit = { id: KIT, name: 'devnet frog', ticker: 'DFROG', bio: 'a wagbi devnet test coin', logo: 'https://wagbi.fun/og.png' };
const coins = new Map();
let offset = 0;
const svc = createLaunchService({
  rpc,
  store: new DepositStore(new WriteOnceObjects(), 'devnet/script/'),
  custody: new Custody(new Uint8Array(randomBytes(32))),
  getKit: async (id) => (id === KIT ? kit : null),
  putMeta: async (name) => `https://wagbi.fun/m/${name}`,
  readCoin: async (id) => coins.get(id) ?? null,
  writeCoin: async (r) => void coins.set(r.kitId, r),
  settings: settingsFromEnv({ WAGBI_CLUSTER: 'devnet', WAGBI_FEE_WALLET: fee, WAGBI_LAUNCH_ALT: alt.toBase58(), WAGBI_SOLANA_RPC_URL: RPC }),
  checkPublic: null,
  now: () => Date.now() + offset,
  log: (e) => say('  log', JSON.stringify({ ...e, logs: undefined }).slice(0, 220), e.logs ? ['', ...e.logs].join(String.fromCharCode(10) + '    ') : ''),
});

const v = await svc.create({
  kitId: KIT, type: 'normal', name: kit.name, ticker: kit.ticker, bio: kit.bio, payout,
  creatorBps: 8500 - EXTRA * 500, wallets: extra.map((address) => ({ address, bps: 500 })), firstBuySol: 0.01,
});
say('deposit', v.id, v.address, 'send exactly', v.sol, 'SOL; split', v.shares.map((s) => `${s.role}:${s.bps}`).join(' '));

// 4. pay exactly, then poll the way the page does
await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: new PublicKey(v.address), lamports: v.amounts.totalLamports })], [funder]);
say('paid');
let view;
for (let i = 0; i < Number(process.env.WAGBI_DEVNET_POLLS ?? 40); i++) {
  const st = await svc.status(v.id);
  view = st.view;
  say('phase', view.phase, JSON.stringify(view.steps));
  if (st.needsRun) {
    const r = await svc.run(v.id);
    say('run', r.phase, r.steps.join(' | '));
  }
  if (view.phase === 'live' && view.returns.length) break;
  if (['refunded', 'expired'].includes(view.phase)) break;
  await sleep(2000);
}
view = (await svc.status(v.id)).view;
if (view.phase !== 'live') throw new Error(`not live: ${view.phase} ${view.problem ?? ''}`);
const mint = view.launch.mint;
const chain = await readLaunchOnChain(rpc, { mint, launcher: v.address, shareholders: v.shares.map((s) => ({ address: s.address, shareBps: s.bps })) });
const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(payout), true, TOKEN_2022_PROGRAM_ID);
const tokens = await rpc.getTokenAccountBalance(ata, 'confirmed');
const [depositLeft, payoutSol] = await Promise.all([rpc.getBalance(new PublicKey(v.address)), rpc.getBalance(new PublicKey(payout))]);
say('RESULT launch', JSON.stringify({
  mint, chainVerdict: chain.state, locked: chain.state === 'live', payoutTokens: tokens.value.uiAmountString, depositLeftLamports: depositLeft, payoutGotLamports: payoutSol,
  leftover: view.returns.map((r) => `${r.what} ${r.lamports} -> payout`), createTx: view.launch.links.createTx, splitTx: view.launch.links.splitTx,
}));

// 5. underpaid, then "send it back"
const u = await svc.create({ kitId: KIT, type: 'normal', name: kit.name, ticker: kit.ticker, bio: kit.bio, payout, creatorBps: 8500, wallets: [], firstBuySol: 0 }).catch((e) => ({ err: e.message }));
say('second deposit for the same coin:', u.err ?? 'made (unexpected)');
const kit2 = { ...kit, id: 'devnetTestKit02x' };
const w = createLaunchService({
  rpc, store: new DepositStore(new WriteOnceObjects(), 'devnet/script2/'), custody: new Custody(new Uint8Array(randomBytes(32))),
  getKit: async () => kit2, putMeta: async (name) => `https://wagbi.fun/m/${name}`, readCoin: async () => null, writeCoin: async () => {},
  settings: settingsFromEnv({ WAGBI_CLUSTER: 'devnet', WAGBI_FEE_WALLET: fee, WAGBI_LAUNCH_ALT: alt.toBase58(), WAGBI_SOLANA_RPC_URL: RPC }),
  checkPublic: null, now: () => Date.now() + offset, log: () => {},
});
const d2 = await w.create({ kitId: 'devnetTestKit02x', type: 'normal', name: 'devnet frog', ticker: 'DFROG', bio: 'test', payout, creatorBps: 8500, wallets: [], firstBuySol: 0 });
await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: new PublicKey(d2.address), lamports: 5_000_000 })], [funder]);
offset = 11 * 60_000;
const before = await rpc.getBalance(new PublicKey(payout));
let r2 = await w.askRefund(d2.id);
for (let i = 0; i < 15 && !['refunded', 'expired'].includes(r2.view.phase); i++) {
  if (r2.needsRun) await w.run(d2.id);
  await sleep(1500);
  r2 = await w.status(d2.id);
}
const after = await rpc.getBalance(new PublicKey(payout));
say('RESULT refund', JSON.stringify({ phase: r2.view.phase, paid: 5_000_000, payoutGot: after - before, depositLeft: await rpc.getBalance(new PublicKey(d2.address)), tx: r2.view.returns[0]?.tx }));
say('done. lookup table (devnet):', alt.toBase58());
