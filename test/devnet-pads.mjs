// The new launchpads on Solana DEVNET (never mainnet: it checks the genesis hash and refuses anything else).
//
//   node test/devnet-pads.mjs sim      READ ONLY, no SOL needed: every launchpad's transactions, built by the adapters
//                                      exactly as a launch builds them, simulated on devnet with a stand-in fee
//                                      payer (signature checks off; nothing is signed or sent). It reads the
//                                      simulated accounts back: who the coin's creator is, where the first buy's
//                                      coins land, who claims the fees.
//   node test/devnet-pads.mjs launch <pad>   REAL devnet launches through wagbi's launch service (the adapters, the
//                                      guards, the custody, the send loop), like devnet-launch.mjs does for pump.fun.
//                                      <pad>: raydium-launchlab | meteora-dbc | pumpfun-usdc. Needs devnet SOL in a
//                                      throwaway key: WAGBI_DEVNET_FUNDER_FILE (a JSON secret key OUTSIDE the vault).
// Optional: WAGBI_DEVNET_RPC. Every key is made in memory; none is printed or written by this script.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { DepositStore, simulateTx } from 'printer-engine/launch';
import { createLaunchService } from '../api/_lib/launch/service.js';
import { settingsFromEnv } from '../api/_lib/launch/settings.js';
import { LaunchCustody } from '../api/_lib/launch/custody.js';
import { GUARDS } from '../api/_lib/launch/launchpads.js';
import { MAX_CU, USDC, WSOL, ataOf } from '../api/_lib/launch/chain.js';
import { LAUNCHLAB_PROGRAM, PLATFORMS, launchlabAccounts, raydiumLaunchlab } from '../api/_lib/launch/adapters/launchlab.js';
import { DBC_PROGRAM, meteoraDbc } from '../api/_lib/launch/adapters/meteoraDbc.js';
import { PUMP, pumpfunUsdc } from '../api/_lib/launch/adapters/pumpfunUsdc.js';

const require = createRequire(import.meta.url);
const S = require('@meteora-ag/dynamic-bonding-curve-sdk');
const dbc = S.createDbcProgram(new Connection('http://127.0.0.1:1'));
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RPC = process.env.WAGBI_DEVNET_RPC || 'https://api.devnet.solana.com';
const rpc = new Connection(RPC, 'confirmed');
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wallet = () => Keypair.generate().publicKey.toBase58();
const NAME = 'wagbi devnet frog';
const SYMBOL = 'DFROG';
const URI = 'https://wagbi.fun/og-meta-devnet-test.json';

if ((await rpc.getGenesisHash()) !== DEVNET_GENESIS) throw new Error(`refusing: ${RPC} is not devnet`);
say('devnet confirmed');
const [mode, padArg] = process.argv.slice(2);

/** A devnet system account with SOL, read from recent DBC/LaunchLab traffic: only a stand-in payer for simulations. */
async function standIn() {
  for (const program of [DBC_PROGRAM, LAUNCHLAB_PROGRAM.devnet, PUMP]) {
    const sigs = await rpc.getSignaturesForAddress(new PublicKey(program), { limit: 15 });
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await rpc.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
      const payer = tx?.transaction.message.staticAccountKeys[0];
      if (!payer) continue;
      const info = await rpc.getAccountInfo(payer);
      if (info && info.owner.equals(SystemProgram.programId) && info.lamports >= 1.2 * LAMPORTS_PER_SOL) return payer.toBase58();
      await sleep(150);
    }
  }
  throw new Error('no devnet payer with SOL found to stand in');
}

async function simulate(label, tx, watch) {
  const r = await rpc.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } });
  const v = r.value;
  say(`${label}: ${v.err ? `FAILED ${JSON.stringify(v.err)}` : 'ok'}, ${v.unitsConsumed} CU, ${tx.serialize().length} bytes`);
  if (v.err) for (const l of (v.logs ?? []).slice(-12)) say('   ', l);
  return v;
}
const accountAfter = (v, i) => (v.accounts?.[i] ? Buffer.from(v.accounts[i].data[0], 'base64') : null);
const tokenAmount = (data) => (data && data.length >= 72 ? data.readBigUInt64LE(64) : null);

async function sim() {
  const payer = await standIn();
  say('stand-in payer (simulation only, never signs)', payer);
  const { blockhash } = await rpc.getLatestBlockhash('confirmed');
  const results = {};

  // Raydium LaunchLab: create + first buy, the PAYOUT wallet as creator and as the coins' owner
  {
    const payout = wallet();
    const o = raydiumLaunchlab.cleanOptions({});
    const b = await raydiumLaunchlab.buildCreate({ rpc, cluster: 'devnet', deposit: payer, payout, name: NAME, symbol: SYMBOL, uri: URI, firstBuy: { lamports: 10_000_000n, slippagePct: 5 }, maxFirstBuyLamports: 10_500_000, cu: MAX_CU, cuPrice: 0, blockhash, options: o });
    const guard = raydiumLaunchlab.checkTx(b.tx, { ...b.policy, deposit: payer });
    const a = launchlabAccounts('devnet', PLATFORMS.raydium.devnet, b.mint, payout);
    const v = await simulate('LaunchLab create + first buy', b.tx, [a.pool, ataOf(b.mint, payout), payer]);
    const pool = accountAfter(v, 0);
    results.launchlab = {
      ok: !v.err, guard: guard.length ? guard : 'passes', units: v.unitsConsumed, bytes: b.size,
      poolCreator: pool ? new PublicKey(pool.subarray(333, 365)).toBase58() === payout ? 'payout wallet' : 'SOMEONE ELSE' : null,
      payoutCoins: tokenAmount(accountAfter(v, 1))?.toString() ?? null,
      payerSpentLamports: v.accounts?.[2] ? (await rpc.getBalance(new PublicKey(payer))) - v.accounts[2].lamports : null,
    };
  }

  // Meteora DBC: the per-launch config (fees and leftovers to the payout wallet)
  {
    const payout = wallet();
    const o = meteoraDbc.cleanOptions({});
    const p = await meteoraDbc.buildPrep({ deposit: payer, payout, cu: MAX_CU, cuPrice: 0, blockhash, options: o });
    const guard = meteoraDbc.checkTx(p.tx, { ...p.policy, deposit: payer });
    const v = await simulate('DBC config', p.tx, [p.data.config, payer]);
    const cfg = accountAfter(v, 0);
    const c = cfg ? dbc.coder.accounts.decode('poolConfig', cfg) : null;
    results.dbcConfig = {
      ok: !v.err, guard: guard.length ? guard : 'passes', units: v.unitsConsumed, bytes: p.size,
      feeClaimer: c ? (c.feeClaimer.toBase58() === payout ? 'payout wallet' : 'SOMEONE ELSE') : null,
      creatorTradingFeePercentage: c?.creatorTradingFeePercentage ?? null, payerSpentLamports: v.accounts?.[1] ? (await rpc.getBalance(new PublicKey(payer))) - v.accounts[1].lamports : null,
    };
    // the create needs its config on chain: simulate it on an existing devnet SOL config (someone else's), which
    // proves the pool, the first buy into the payout wallet and the hand-over of the creator
    const found = await rpc.getProgramAccounts(new PublicKey(DBC_PROGRAM), { filters: [{ dataSize: 1048 }, { memcmp: { offset: 8, bytes: WSOL } }], dataSlice: { offset: 0, length: 0 } }).catch((e) => (say('config search:', e.message), []));
    let tried = 0;
    for (const f of found.slice(-30).reverse()) {
      const info = await rpc.getAccountInfo(f.pubkey);
      const pc = dbc.coder.accounts.decode('poolConfig', info.data);
      if (pc.tokenType !== 0 || pc.quoteTokenFlag !== 0 || pc.tokenUpdateAuthority > 2) continue;
      if (++tried > 3) break;
      const cr = await meteoraDbc.buildCreate({ deposit: payer, payout, name: NAME, symbol: SYMBOL, uri: URI, firstBuy: { lamports: 10_000_000n, slippagePct: 50 }, maxFirstBuyLamports: 15_000_000, cu: MAX_CU, cuPrice: 0, blockhash, options: o, prep: { config: f.pubkey.toBase58() } });
      const pool = S.deriveDbcPoolAddress(new PublicKey(WSOL), new PublicKey(cr.mint), f.pubkey).toBase58();
      const v2 = await simulate(`DBC pool + first buy + hand-over (on config ${f.pubkey.toBase58().slice(0, 8)})`, cr.tx, [pool, ataOf(cr.mint, payout), payer]);
      const pa = accountAfter(v2, 0);
      results.dbcCreate = {
        ok: !v2.err, onConfig: f.pubkey.toBase58(), units: v2.unitsConsumed, bytes: cr.size, error: v2.err ?? undefined,
        poolCreator: pa ? (dbc.coder.accounts.decode('virtualPool', pa).poolState.creator.toBase58() === payout ? 'payout wallet' : 'SOMEONE ELSE') : null,
        payoutCoins: tokenAmount(accountAfter(v2, 1))?.toString() ?? null,
        payerSpentLamports: v2.accounts?.[2] ? (await rpc.getBalance(new PublicKey(payer))) - v2.accounts[2].lamports : null,
      };
      if (!v2.err) break;
    }
  }

  // pump.fun USDC: create_v2 on devnet USDC
  {
    const c = await pumpfunUsdc.buildCreate({ cluster: 'devnet', deposit: payer, name: NAME, symbol: SYMBOL, uri: URI, cu: MAX_CU, cuPrice: 0, blockhash });
    const guard = pumpfunUsdc.checkTx(c.tx, { ...c.policy, deposit: payer });
    const { bondingCurveOf } = await import('printer-engine/launch');
    const v = await simulate('pump.fun USDC create', c.tx, [bondingCurveOf(c.mint), payer]);
    const curve = accountAfter(v, 0);
    results.pumpUsdcCreate = {
      ok: !v.err, guard: guard.length ? guard : 'passes', units: v.unitsConsumed, bytes: c.size,
      quoteMint: curve ? (new PublicKey(curve.subarray(83, 115)).toBase58() === USDC.devnet ? 'devnet USDC' : new PublicKey(curve.subarray(83, 115)).toBase58()) : null,
      payerSpentLamports: v.accounts?.[1] ? (await rpc.getBalance(new PublicKey(payer))) - v.accounts[1].lamports : null,
    };
  }
  // pump.fun USDC split: on an existing devnet USDC coin whose creator has no split yet (the creator stands in as the
  // deposit: signature checks are off, so this only shows whether pump.fun takes the three instructions as built)
  {
    const { decodeCurve, sharingConfigOf } = await import('printer-engine/launch');
    const found = await rpc.getProgramAccounts(new PublicKey(PUMP), { filters: [{ memcmp: { offset: 83, bytes: USDC.devnet } }], dataSlice: { offset: 0, length: 0 } }).catch((e) => (say('curve search:', e.message), []));
    say('devnet USDC curves found', found.length);
    let tried = 0;
    for (const f of found.slice(-40).reverse()) {
      const info = await rpc.getAccountInfo(f.pubkey);
      let c;
      try {
        c = decodeCurve(info.data);
      } catch {
        continue;
      }
      if (c.complete || c.quoteMint !== USDC.devnet) continue;
      const creator = await rpc.getAccountInfo(new PublicKey(c.creator));
      if (!creator || !creator.owner.equals(SystemProgram.programId) || creator.lamports < 0.05 * LAMPORTS_PER_SOL) continue;
      // the mint: the curve PDA is [bonding-curve, mint]; find it from the curve's own creation
      const sigs = await rpc.getSignaturesForAddress(f.pubkey, { limit: 50 });
      const first = sigs.at(-1);
      const tx = first && (await rpc.getTransaction(first.signature, { maxSupportedTransactionVersion: 0 }));
      const keys = tx?.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
      const mint = keys && [...Array(keys.length).keys()].map((i) => keys.get(i).toBase58()).find((k) => { try { return bondingCurveOfSync(k) === f.pubkey.toBase58(); } catch { return false; } });
      if (!mint || (await rpc.getAccountInfo(new PublicKey(sharingConfigOf(mint))))) continue;
      if (++tried > 3) break;
      const payout = wallet();
      const split = await pumpfunUsdc.buildSplit({ cluster: 'devnet', mint, deposit: c.creator, payout, shares: [{ role: 'creator', address: payout, bps: 7500 }, { role: 'wagbi', address: wallet(), bps: 1500 }, { role: 'wallet', address: wallet(), bps: 1000 }], cu: MAX_CU, cuPrice: 0, blockhash });
      const guard = pumpfunUsdc.checkTx(split.tx, { ...split.policy, deposit: c.creator });
      const v = await simulate(`pump.fun USDC split (on devnet coin ${mint.slice(0, 8)}, its creator standing in)`, split.tx, [sharingConfigOf(mint), c.creator]);
      results.pumpUsdcSplit = { ok: !v.err, onMint: mint, guard: guard.length ? guard : 'passes', units: v.unitsConsumed, bytes: split.size, error: v.err ?? undefined, logs: v.err ? (v.logs ?? []).slice(-6) : undefined,
        payerSpentLamports: v.accounts?.[1] ? creator.lamports - v.accounts[1].lamports : null };
      if (!v.err) break;
    }
    if (!results.pumpUsdcSplit) results.pumpUsdcSplit = { ok: null, note: 'no devnet USDC coin without a split, whose creator holds SOL, was found to simulate on' };
  }
  console.log(JSON.stringify(results, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}
function bondingCurveOfSync(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], new PublicKey(PUMP))[0].toBase58();
}

async function launch(pad) {
  const FILE = process.env.WAGBI_DEVNET_FUNDER_FILE;
  if (!FILE || !existsSync(FILE)) throw new Error('set WAGBI_DEVNET_FUNDER_FILE to a devnet key file (outside the vault) holding devnet SOL');
  const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(FILE, 'utf8'))));
  const bal = await rpc.getBalance(funder.publicKey);
  say('funder', funder.publicKey.toBase58(), bal / LAMPORTS_PER_SOL, 'devnet SOL');
  class WriteOnceObjects {
    label = 'memory';
    m = new Map();
    async put(k, body) {
      if (this.m.has(k)) return false;
      this.m.set(k, { body: Buffer.from(body) });
      return true;
    }
    async get(k) {
      return this.m.get(k) ?? null;
    }
    async list(p) {
      return [...this.m.keys()].filter((k) => k.startsWith(p)).sort();
    }
  }
  const fee = wallet();
  const payout = wallet();
  const KIT = 'devnetPad' + randomBytes(4).toString('hex').slice(0, 7);
  const kit = { id: KIT, name: NAME, ticker: SYMBOL, bio: 'a wagbi devnet test coin', logo: 'https://wagbi.fun/og.png' };
  const coins = new Map();
  const svc = createLaunchService({
    rpc, store: new DepositStore(new WriteOnceObjects(), 'devnet/pads/'), custody: new LaunchCustody(new Uint8Array(randomBytes(32)), GUARDS),
    getKit: async (id) => (id === KIT ? kit : null), putMeta: async (name) => `https://wagbi.fun/m/${name}`,
    readCoin: async (id) => coins.get(id) ?? null, writeCoin: async (r) => void coins.set(r.kitId, r),
    settings: settingsFromEnv({ WAGBI_CLUSTER: 'devnet', WAGBI_FEE_WALLET: fee, WAGBI_SOLANA_RPC_URL: RPC }), checkPublic: null,
    log: (e) => say('  log', JSON.stringify({ ...e, logs: undefined }).slice(0, 240), e.logs ? ['', ...e.logs].join('\n    ') : ''),
  });
  const body = pad === 'pumpfun-usdc'
    ? { kitId: KIT, launchpad: 'pumpfun', currency: 'USDC', type: 'normal', name: NAME, ticker: SYMBOL, bio: kit.bio, payout, creatorBps: 7500, wallets: [{ address: wallet(), bps: 1000 }], firstBuySol: 0 }
    : { kitId: KIT, launchpad: pad, currency: 'SOL', type: 'normal', name: NAME, ticker: SYMBOL, bio: kit.bio, payout, firstBuySol: 0.01 };
  const v = await svc.create(body);
  say('deposit', v.id, v.address, 'send exactly', v.sol, 'SOL');
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: funder.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: new PublicKey(v.address), lamports: v.amounts.totalLamports })] }).compileToV0Message());
  tx.sign([funder]);
  const sig = await rpc.sendRawTransaction(tx.serialize());
  await rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  say('paid');
  let view;
  for (let i = 0; i < 40; i++) {
    const st = await svc.status(v.id);
    view = st.view;
    say('phase', view.phase, JSON.stringify(view.steps));
    if (st.needsRun) say('run', (await svc.run(v.id)).steps.join(' | '));
    if ((view.phase === 'live' && view.returns.length) || ['refunded', 'expired'].includes(view.phase)) break;
    await sleep(2000);
  }
  view = (await svc.status(v.id)).view;
  say('RESULT', JSON.stringify({ pad, phase: view.phase, problem: view.problem, mint: view.launch?.mint, createTx: view.launch?.links.createTx, splitTx: view.launch?.links.splitTx, returns: view.returns, coin: coins.get(KIT) && { feeModel: coins.get(KIT).feeModel, split: coins.get(KIT).split, setup: coins.get(KIT).setup } }));
  void simulateTx;
}

if (mode === 'launch') await launch(padArg);
else await sim();
