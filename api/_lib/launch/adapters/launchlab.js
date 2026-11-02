// Raydium LaunchLab, and LetsBonk (bonk.fun), which is LaunchLab with bonk.fun's own platform config. The creator
// keeps every creator fee here and wagbi takes nothing (Laith, 2026-11-02): no split, no wagbi wallet.
//
// Read live 2026-11-02 (LAUNCH-SPEC.md, "Raydium LaunchLab and LetsBonk"): @raydium-io/raydium-sdk-v2 0.2.80-alpha
// (2026-10-30) src/raydium/launchpad/{instrument,layout,pda}.ts and curve/*.ts; docs.raydium.io products/launchlab;
// the programs, global configs, platform configs and lookup tables on both clusters (read only).
//
// One transaction, the deposit paying:
//   initialize_v2   the coin (SPL token + Metaplex metadata, 6 decimals), its pool and vaults, on the platform's
//                   config. `creator` is a plain account, not a signer, so it is the PAYOUT wallet: the pool's
//                   creator fee (and its CPMM creator fee after graduation) belongs to the payout wallet from the
//                   first trade, and nothing ever has to be handed over.
//   [first buy]     the payout wallet's coin account, the deposit's own wrapped SOL, buy_exact_in with the coins
//                   into the payout wallet's account, then the wrapped SOL closed back into the deposit.
// The SDK is 122 MB, so the two instructions are written here from its source, byte for byte, and the guard below
// reads them back field by field. test/launch-pads.test.mjs pins the bytes; the devnet run proves them on chain.
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { bad, LaunchError } from 'printer-engine/launch';
import {
  P, WSOL, TOKEN_ACCOUNT_RENT, ataIx, ataOf, b58, checkBase, checkWrap, compileTx, hex8, isAtaFor, isUnwrap, keyAt, progOf, readStr, strBytes, u64, unwrapIx, wrapIxs,
} from '../chain.js';

export const LAUNCHLAB_PROGRAM = { mainnet: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', devnet: 'DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6' };
/** Raydium's lookup tables for LaunchLab (the SDK's), read 2026-11-02. */
const LAUNCHLAB_TABLE = { mainnet: 'AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU', devnet: 'EFhMuDw1PKEuckuFRW9PavNfTH4LKP5uKHgyXDmWpFCq' };
/** Platform configs: Raydium's own (raydium.io/launchpad) and bonk.fun's main "meme" platform (mainnet only). */
export const PLATFORMS = {
  raydium: { mainnet: '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4', devnet: '2Jx4KTDrVSdWNazuGpcA8n3ZLTRGGBDxAWhuKe2Xcj2a' },
  bonk: { mainnet: 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1' },
};
const DISC = { initializeV2: '4399af27da102620', buyExactIn: 'faea0d7bd59c13ec' };
const FEE_DENOM = 1_000_000n;
const DECIMALS = 6;
const SUPPLY = 1_000_000_000_000_000n; // 1B coins, 6 decimals (what bonk.fun and raydium.io launch)
const TOTAL_SELL = 793_100_000_000_000n; // 79.31% sold on the curve (the same)
const CU = 400_000; // create + first buy; the service measures each build and fits the limit
/** create (pool + vaults + mint + Metaplex metadata with its 0.01 SOL fee) + the payout's coin account: 23,593,920
 *  lamports in a devnet simulation (2026-11-02, test/devnet-pads.mjs sim), + fees, with room. */
const NETWORK_LAMPORTS = 27_000_000;

const te = new TextEncoder();
const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58();
const pkb = (k) => new PublicKey(k).toBuffer();
export function launchlabAccounts(cluster, platform, mint, creator) {
  const program = LAUNCHLAB_PROGRAM[cluster];
  const u16be = Buffer.alloc(2);
  const globalConfig = pda([te.encode('global_config'), pkb(WSOL), Buffer.from([0]), u16be], program);
  const pool = pda([te.encode('pool'), pkb(mint), pkb(WSOL)], program);
  return {
    program, globalConfig, platform, pool,
    auth: pda([te.encode('vault_auth_seed')], program),
    vaultA: pda([te.encode('pool_vault'), pkb(pool), pkb(mint)], program),
    vaultB: pda([te.encode('pool_vault'), pkb(pool), pkb(WSOL)], program),
    metadata: pda([te.encode('metadata'), pkb(P.metaplex), pkb(mint)], P.metaplex),
    event: pda([te.encode('__event_authority')], program),
    platformVault: pda([pkb(platform), pkb(WSOL)], program),
    creatorVault: pda([pkb(creator), pkb(WSOL)], program),
  };
}

const meta = (pubkey, isSigner, isWritable) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable });

/** initialize_v2, constant-product curve, migrating to CPMM, nothing locked. */
export function initializeV2Ix(a, { payer, creator, mint, name, symbol, uri, supply, totalSell, raise, feeOn }) {
  const data = Buffer.concat([
    Buffer.from(DISC.initializeV2, 'hex'), Buffer.from([DECIMALS]), strBytes(name), strBytes(symbol), strBytes(uri),
    Buffer.from([0]), u64(supply), u64(totalSell), u64(raise), Buffer.from([1]),
    u64(0), u64(0), u64(0), Buffer.from([feeOn]),
  ]);
  return new TransactionInstruction({
    programId: new PublicKey(a.program),
    keys: [
      meta(payer, true, true), meta(creator, false, false), meta(a.globalConfig, false, false), meta(a.platform, false, false), meta(a.auth, false, false),
      meta(a.pool, false, true), meta(mint, true, true), meta(WSOL, false, false), meta(a.vaultA, false, true), meta(a.vaultB, false, true), meta(a.metadata, false, true),
      meta(P.token, false, false), meta(P.token, false, false), meta(P.metaplex, false, false), meta(P.system, false, false), meta(P.rent, false, false), meta(a.event, false, false), meta(a.program, false, false),
    ],
    data,
  });
}
export function decodeInitializeV2(data) {
  const b = Buffer.from(data);
  if (b.subarray(0, 8).toString('hex') !== DISC.initializeV2) throw new Error('not initialize_v2');
  let o = 8;
  const decimals = b[o++];
  const name = readStr(b, o, 64);
  const symbol = readStr(b, name.next, 32);
  const uri = readStr(b, symbol.next, 400);
  o = uri.next;
  const curve = b[o++];
  if (curve !== 0) return { decimals, name: name.value, symbol: symbol.value, uri: uri.value, curve };
  const supply = b.readBigUInt64LE(o);
  const totalSell = b.readBigUInt64LE(o + 8);
  const raise = b.readBigUInt64LE(o + 16);
  const migrateType = b[o + 24];
  const locked = b.readBigUInt64LE(o + 25);
  const cliff = b.readBigUInt64LE(o + 33);
  const unlock = b.readBigUInt64LE(o + 41);
  const feeOn = b[o + 49];
  if (b.length !== o + 50) throw new Error('initialize_v2 has trailing bytes');
  return { decimals, name: name.value, symbol: symbol.value, uri: uri.value, curve, supply, totalSell, raise, migrateType, locked, cliff, unlock, feeOn };
}

/** buy_exact_in: `amountIn` lamports of wrapped SOL for at least `minOut` coins, into `tokensTo` (no share fee). */
export function buyExactInIx(a, { payer, mint, tokensTo, amountIn, minOut }) {
  return new TransactionInstruction({
    programId: new PublicKey(a.program),
    keys: [
      meta(payer, true, true), meta(a.auth, false, false), meta(a.globalConfig, false, false), meta(a.platform, false, false), meta(a.pool, false, true),
      meta(tokensTo, false, true), meta(ataOf(WSOL, payer), false, true), meta(a.vaultA, false, true), meta(a.vaultB, false, true), meta(mint, false, false), meta(WSOL, false, false),
      meta(P.token, false, false), meta(P.token, false, false), meta(a.event, false, false), meta(a.program, false, false),
      meta(P.system, false, false), meta(a.platformVault, false, true), meta(a.creatorVault, false, true),
    ],
    data: Buffer.concat([Buffer.from(DISC.buyExactIn, 'hex'), u64(amountIn), u64(minOut), u64(0)]),
  });
}
export function decodeBuyExactIn(data) {
  const b = Buffer.from(data);
  if (b.length !== 32 || b.subarray(0, 8).toString('hex') !== DISC.buyExactIn) throw new Error('not buy_exact_in');
  return { amountIn: b.readBigUInt64LE(8), minOut: b.readBigUInt64LE(16), shareFeeRate: b.readBigUInt64LE(24) };
}

// ── the curve, for the quote and the buy's minimum ──────────────────────
/** The constant-product curve's starting virtual reserves (the SDK's LaunchConstantProductCurve.getInitParam). */
export function initReserves({ supply, totalSell, raise, migrateFee }) {
  const left = supply - totalSell;
  const tf = raise - migrateFee;
  const numerator = (tf * totalSell * totalSell) / left;
  const denominator = (tf * totalSell) / left - raise;
  if (denominator <= 0n) throw new Error('the curve parameters are invalid');
  return { virtualA: numerator / denominator, virtualB: (raise * raise) / denominator };
}
/** Coins out for `amountIn` lamports on a fresh pool (Curve.buyExactIn: fee off the top, ceil). */
export function buyOut({ virtualA, virtualB, totalSell }, amountIn, feeRate) {
  const fee = (amountIn * feeRate + FEE_DENOM - 1n) / FEE_DENOM;
  const net = amountIn - fee;
  const out = (net * virtualA) / (virtualB + net);
  return out > totalSell ? totalSell : out;
}

// ── chain reads ─────────────────────────────────────────────────────────
const caches = new WeakMap();
/** The global config's trade fee and migrate fee, the platform's fee rates and restrictions (a minute's cache per RPC). */
async function rates(rpc, a) {
  if (!caches.has(rpc)) caches.set(rpc, new Map());
  const cache = caches.get(rpc);
  const k = `${a.globalConfig}:${a.platform}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const [g, p] = await rpc.getMultipleAccountsInfo([new PublicKey(a.globalConfig), new PublicKey(a.platform)], 'confirmed');
  if (!g || g.owner.toBase58() !== a.program) throw new LaunchError('chain', `LaunchLab global config ${a.globalConfig} not found`, "the launchpad couldn't be read right now. try again in a minute.");
  if (!p || p.owner.toBase58() !== a.program) throw new LaunchError('chain', `LaunchLab platform ${a.platform} not found`, "the launchpad couldn't be read right now. try again in a minute.");
  const gd = Buffer.from(g.data);
  const pd = Buffer.from(p.data);
  const v = {
    curveType: gd[16], migrateFee: gd.readBigUInt64LE(19), tradeFeeRate: gd.readBigUInt64LE(27), minSupplyA: gd.readBigUInt64LE(43), minSellRateA: gd.readBigUInt64LE(59),
    minFundRaisingB: gd.readBigUInt64LE(75), mintB: new PublicKey(gd.subarray(83, 115)).toBase58(),
    platformFeeRate: pd.readBigUInt64LE(104), creatorFeeRate: pd.readBigUInt64LE(720), cpCreator: new PublicKey(pd.subarray(800, 832)).toBase58(),
    restricted: pd[832] !== 0 || pd[833] !== 0,
  };
  cache.set(k, { at: Date.now(), v });
  return v;
}

// ── the adapter ─────────────────────────────────────────────────────────
const RAISES = [30, 85, 150];

/**
 * One adapter per platform: Raydium's own (options: the SOL raised to graduate, and what the creator fee is paid
 * in after graduation) and bonk.fun's (bonk.fun's standard coin, no options).
 */
export function launchlabAdapter({ id, name, platform, options }) {
  const clusters = Object.keys(PLATFORMS[platform]);
  const optionList = options
    ? [
        { id: 'raise', label: 'graduates when the curve has raised', type: 'choice', default: '85', choices: RAISES.map((n) => ({ id: String(n), label: `${n} SOL` })), hint: 'then the coin moves to a Raydium CPMM pool. 85 SOL is the standard.' },
        { id: 'feeOn', label: 'after graduation, your creator fee comes in', type: 'choice', default: 'sol', choices: [{ id: 'sol', label: 'SOL only' }, { id: 'both', label: 'SOL and the coin' }] },
      ]
    : [];
  const curveOf = (o) => ({ supply: SUPPLY, totalSell: TOTAL_SELL, raise: BigInt(o.raise) * 1_000_000_000n, feeOn: o.feeOn === 'both' ? 1 : 0 });

  const ad = {
    id, chain: 'solana', name, feeModel: 'creator', firstBuy: true, clusters, options: optionList,
    guard: id,
    cleanOptions(raw) {
      const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      for (const k of Object.keys(o)) if (!optionList.some((x) => x.id === k)) throw bad(`${name} has no option called ${k.slice(0, 20)}.`);
      if (!options) return { raise: 85, feeOn: 'sol' };
      const raise = o.raise === undefined ? 85 : Number(o.raise);
      if (!RAISES.includes(raise)) throw bad(`pick how much the curve raises before graduating: ${RAISES.join(', ')} SOL.`);
      const feeOn = o.feeOn ?? 'sol';
      if (feeOn !== 'sol' && feeOn !== 'both') throw bad('pick what your creator fee comes in after graduation.');
      return { raise, feeOn };
    },
    networkLamports: () => NETWORK_LAMPORTS,
    accounts: (cluster, mint, creator) => launchlabAccounts(cluster, PLATFORMS[platform][cluster], mint, creator),

    async estimateFirstBuy(rpc, lamports, slippagePct, { cluster, options: o }) {
      const a = launchlabAccounts(cluster, PLATFORMS[platform][cluster], Keypair.generate().publicKey.toBase58(), WSOL);
      const r = await rates(rpc, a);
      const c = curveOf(o ?? ad.cleanOptions({}));
      const res = initReserves({ ...c, migrateFee: r.migrateFee });
      const tokens = buyOut({ ...res, totalSell: c.totalSell }, BigInt(lamports), r.tradeFeeRate + r.platformFeeRate + r.creatorFeeRate);
      return { tokens: tokens.toString(), pctOfSupply: Number((tokens * 1_000_000n) / c.supply) / 10_000, creatorFeePct: Number(r.creatorFeeRate) / 10_000 };
    },

    /** initialize_v2 [+ the payout's coin account + wrap + buy_exact_in + unwrap], with a fresh mint. Not signed. */
    async buildCreate({ rpc, cluster, deposit, payout, name: coinName, symbol, uri, firstBuy, maxFirstBuyLamports, cu = CU, cuPrice, blockhash, options: o, keys }) {
      const platformId = PLATFORMS[platform][cluster];
      if (!platformId) throw new LaunchError('config', `${id} has no platform on ${cluster}`, `${name} isn't on this network.`);
      const mint = keys?.mint ?? Keypair.generate();
      const m = mint.publicKey.toBase58();
      const a = launchlabAccounts(cluster, platformId, m, payout);
      const r = await rates(rpc, a);
      if (r.restricted) throw new LaunchError('config', `${platformId} restricts its configs or curves`, `${name} isn't taking coins like this right now.`);
      if (r.mintB !== WSOL || r.curveType !== 0) throw new LaunchError('config', `global config ${a.globalConfig} isn't a SOL constant-product config`, `${name} isn't taking coins like this right now.`);
      const c = curveOf(o);
      if (BigInt(c.raise) < r.minFundRaisingB) throw bad(`${name} needs the curve to raise at least ${Number(r.minFundRaisingB) / 1e9} SOL.`);
      const body = [initializeV2Ix(a, { payer: deposit, creator: payout, mint: m, name: coinName, symbol, uri, ...c })];
      let minOut = null;
      if (firstBuy) {
        const res = initReserves({ ...c, migrateFee: r.migrateFee });
        const out = buyOut({ ...res, totalSell: c.totalSell }, firstBuy.lamports, r.tradeFeeRate + r.platformFeeRate + r.creatorFeeRate);
        minOut = (out * BigInt(10_000 - Math.round(firstBuy.slippagePct * 100))) / 10_000n;
        if (minOut <= 0n) throw bad('that first buy is too small to buy any coins.');
        const tokensTo = ataOf(m, payout);
        body.push(ataIx(deposit, payout, m), ...wrapIxs(deposit, firstBuy.lamports), buyExactInIx(a, { payer: deposit, mint: m, tokensTo, amountIn: firstBuy.lamports, minOut }), unwrapIx(deposit));
      }
      const tableKey = LAUNCHLAB_TABLE[cluster];
      const table = tableKey ? (await rpc.getAddressLookupTable(new PublicKey(tableKey))).value : null;
      const tables = table && table.isActive() ? [table] : [];
      const { tx, size } = compileTx({ label: 'create', payer: deposit, blockhash, cu, cuPrice, body, tables });
      return {
        tx, size, mint: m, extraSigners: [mint], keys: { mint },
        policy: {
          guard: id, kind: 'create', payout, mint: m, signers: [m], tables, cluster, platform: platformId,
          coin: { name: coinName, symbol, uri }, curve: c, maxFirstBuyLamports: firstBuy ? maxFirstBuyLamports : null,
        },
      };
    },

    async coinExists(rpc, mint, { cluster, payout }) {
      const a = launchlabAccounts(cluster, PLATFORMS[platform][cluster], mint, payout);
      return !!(await rpc.getAccountInfo(new PublicKey(a.pool), 'confirmed'));
    },

    /** The pool as the chain has it: this mint, on this platform, its creator the payout wallet. */
    async readLaunch(rpc, { mint, rec }) {
      const a = launchlabAccounts(rec.cluster, PLATFORMS[platform][rec.cluster], mint, rec.payout.address);
      const info = await rpc.getAccountInfo(new PublicKey(a.pool), 'confirmed');
      if (!info) return { state: 'waiting', problem: null };
      if (info.owner.toBase58() !== a.program) return { state: 'rejected', problem: "the coin's pool isn't LaunchLab's." };
      const d = Buffer.from(info.data);
      if (d.length < 367) return { state: 'rejected', problem: "the coin's pool couldn't be read." };
      const at = (o) => new PublicKey(d.subarray(o, o + 32)).toBase58();
      if (at(141) !== a.globalConfig || at(173) !== a.platform) return { state: 'rejected', problem: "the coin isn't on the platform it was built for." };
      if (at(205) !== mint || at(237) !== WSOL) return { state: 'rejected', problem: 'the pool is for another coin.' };
      if (at(333) !== rec.payout.address) return { state: 'rejected', problem: "the pool's creator isn't the payout wallet." };
      return { state: 'live', problem: null };
    },

    links(mint, cluster) {
      if (cluster !== 'mainnet') return null;
      return platform === 'bonk' ? { url: `https://bonk.fun/token/${mint}`, label: 'open on bonk.fun' } : { url: `https://raydium.io/launchpad/token/?mint=${mint}`, label: 'open on Raydium' };
    },

    /** The deposit key's rules for this launchpad (see the top of this file). */
    checkTx(tx, p) {
      if (p.kind !== 'create') return [`${name} transactions are creates only.`];
      const { problems, body } = checkBase(tx, { ...p, programs: [LAUNCHLAB_PROGRAM[p.cluster], P.ata, P.system, P.token] });
      if (!body.length) return problems.length ? problems : ['the transaction is empty.'];
      const a = launchlabAccounts(p.cluster, p.platform, p.mint, p.payout);
      const init = body[0];
      if (progOf(init) !== a.program || hex8(init) !== DISC.initializeV2) return [...problems, 'the create must start with initialize_v2.'];
      let args;
      try {
        args = decodeInitializeV2(init.data);
      } catch {
        return [...problems, "the create couldn't be read."];
      }
      if (init.keys.length !== 18) problems.push('the create names accounts it must not.');
      if (keyAt(init, 0) !== p.deposit || !init.keys[0].isSigner) problems.push("the create isn't paid by the deposit.");
      if (keyAt(init, 1) !== p.payout) problems.push("the coin's creator isn't the payout wallet.");
      if (keyAt(init, 2) !== a.globalConfig || keyAt(init, 3) !== a.platform) problems.push("the create isn't on the platform it was built for.");
      if (keyAt(init, 5) !== a.pool || keyAt(init, 6) !== p.mint || !init.keys[6].isSigner || keyAt(init, 7) !== WSOL) problems.push("the create isn't for this coin's mint, paired with SOL.");
      if (keyAt(init, 11) !== P.token || keyAt(init, 12) !== P.token || keyAt(init, 13) !== P.metaplex) problems.push('the create uses the wrong token programs.');
      if (args.name !== p.coin.name || args.symbol !== p.coin.symbol || args.uri !== p.coin.uri) problems.push("the create's name, ticker or link isn't the kit's.");
      const c = p.curve;
      if (args.decimals !== DECIMALS || args.curve !== 0 || args.supply !== c.supply || args.totalSell !== c.totalSell || args.raise !== c.raise || args.migrateType !== 1 || args.feeOn !== c.feeOn) {
        problems.push("the create's curve isn't the one the launch was made with.");
      }
      if (args.locked !== 0n || args.cliff !== 0n || args.unlock !== 0n) problems.push('the create locks coins for someone.');
      if (body.length === 1) return problems;
      if (p.maxFirstBuyLamports == null) return [...problems, 'this launch has no first buy.'];
      if (body.length !== 7) return [...problems, 'the first buy must be: coin account, wrap, buy, unwrap.'];
      if (!isAtaFor(body[1], p.deposit, p.payout, p.mint)) problems.push("the coin account isn't the payout wallet's.");
      const wrapped = checkWrap(body, 2, p.deposit, p.maxFirstBuyLamports, problems);
      const buy = body[5];
      let b;
      try {
        if (progOf(buy) !== a.program) throw new Error('x');
        b = decodeBuyExactIn(buy.data);
      } catch {
        return [...problems, "the first buy couldn't be read."];
      }
      if (buy.keys.length !== 18) problems.push('the first buy names accounts it must not (a share-fee receiver?).');
      if (keyAt(buy, 0) !== p.deposit || keyAt(buy, 4) !== a.pool || keyAt(buy, 5) !== ataOf(p.mint, p.payout) || keyAt(buy, 6) !== ataOf(WSOL, p.deposit) || keyAt(buy, 9) !== p.mint) {
        problems.push("the first buy isn't the deposit buying this coin into the payout wallet.");
      }
      if (keyAt(buy, 2) !== a.globalConfig || keyAt(buy, 3) !== a.platform || keyAt(buy, 16) !== a.platformVault || keyAt(buy, 17) !== a.creatorVault) problems.push("the first buy's fees don't go where the platform and the payout wallet's vault are.");
      if (b.shareFeeRate !== 0n) problems.push('the first buy pays a share fee.');
      if (wrapped !== null && b.amountIn > wrapped) problems.push('the first buy spends more than was wrapped.');
      if (!isUnwrap(body[6], p.deposit)) problems.push("the wrapped SOL isn't closed back into the deposit.");
      return problems;
    },
  };
  return ad;
}

export const raydiumLaunchlab = launchlabAdapter({ id: 'raydium-launchlab', name: 'Raydium LaunchLab', platform: 'raydium', options: true });
export const letsbonk = launchlabAdapter({ id: 'letsbonk', name: 'LetsBonk', platform: 'bonk', options: false });
void TOKEN_ACCOUNT_RENT;
void b58;
