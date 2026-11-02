// Meteora Dynamic Bonding Curve (DBC). The creator keeps every creator fee here and wagbi takes nothing (Laith,
// 2026-11-02): there is no wagbi config, no wagbi wallet, no partner cut.
//
// Read live 2026-11-02 (LAUNCH-SPEC.md, "Meteora DBC"): @meteora-ag/dynamic-bonding-curve-sdk 2.0.0 (2026-10-15),
// program 0.2.2 (github.com/MeteoraAg/dynamic-bonding-curve, 2026-10-16), docs.meteora.ag dbc pages (2026-10-31),
// the program on both clusters (same id, read only).
//
// Two transactions, the deposit paying both:
//   prep    create_config2: a config of the coin's own, made fresh for this launch, whose fee claimer and leftover
//           receiver are the PAYOUT wallet, the creator's share of the trading fee 100%, the partner's LP 0% and the
//           creator's LP 100% permanently locked (fees claimable, liquidity can't be pulled), the metadata immutable,
//           no creation fee, no migration fee, no vesting. Every economic right a "partner" has is the payout
//           wallet's or zero. (A config, its pool and a first buy don't fit one transaction: 1,415 bytes, measured.)
//   create  initialize_virtual_pool_with_spl_token (the coin, SPL + Metaplex metadata), [the payout's coin account,
//           the deposit's wrapped SOL, swap with the coins into the payout's account, unwrap], then
//           transfer_pool_creator: the pool's creator becomes the payout wallet in the same transaction.
// Meteora keeps 20% of every trading fee (its protocol fee); the other 80% is the payout wallet's.
// Instructions are built with the SDK's own Anchor program (its IDL), offline; the guard decodes them with the
// same IDL and checks every field that moves money or rights.
import { createRequire } from 'node:module';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { bad, LaunchError } from 'printer-engine/launch';
import { P, WSOL, ataIx, ataOf, checkBase, checkWrap, compileTx, hex8, isAtaFor, isUnwrap, keyAt, progOf, unwrapIx, wrapIxs } from '../chain.js';

// the SDK's CommonJS build (Vercel's runtime and Anchor's ESM build don't always agree; printer-engine does the same)
const require = createRequire(import.meta.url);
const S = require('@meteora-ag/dynamic-bonding-curve-sdk');
const M = require('@meteora-ag/dynamic-bonding-curve-sdk/math');

export const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const DISC = { createConfig2: '09ca18cb8fd4fc51', initSpl: '8c55d7b06636684f', swap: 'f8c69e91e17587c8', transferCreator: '1407a9213a93a621' };
const SUPPLY = 1_000_000_000;
const CU = { prep: 200_000, create: 400_000 };
/** prep (the config, 1,048 B): 5,984,080 lamports; create (pool, 2 vaults, mint, Metaplex metadata with its 0.01 SOL
 *  fee, the payout's coin account): 22,080,080. Both from devnet simulations (2026-11-02, test/devnet-pads.mjs sim).
 *  + fees, with room. */
const NETWORK_LAMPORTS = 33_000_000;

let program = null;
/** The SDK's Anchor program, offline: building and decoding instructions never touches this connection. */
function dbc() {
  if (!program) program = S.createDbcProgram(new Connection('http://127.0.0.1:1'), 'confirmed');
  return program;
}

const START = [20, 30, 50];
const GRAD = [200, 400, 800];
const FEE = [50, 100, 200];
const POOL_FEE = { 25: S.MigrationFeeOption.FixedBps25, 100: S.MigrationFeeOption.FixedBps100, 200: S.MigrationFeeOption.FixedBps200 };

/** The config's parameters for these options (deterministic: the guard rebuilds and compares them). */
export function configParams(o) {
  return S.buildCurveWithMarketCap({
    token: { tokenType: S.TokenType.SPLToken, tokenBaseDecimal: S.TokenDecimal.SIX, tokenQuoteDecimal: 9, tokenAuthorityOption: S.TokenAuthorityOption.Immutable, totalTokenSupply: SUPPLY, leftover: 0 },
    fee: {
      baseFeeParams: { baseFeeMode: S.BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: o.feeBps, endingFeeBps: o.feeBps, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: S.CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 100, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: S.MigrationOption.MET_DAMM_V2, migrationFeeOption: POOL_FEE[o.poolFeeBps], migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 100 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: S.ActivationType.Timestamp,
    initialMarketCap: o.startMcap,
    migrationMarketCap: o.gradMcap,
  });
}

const pk = (k) => new PublicKey(k);
function accountsOf(mint, config) {
  const pool = S.deriveDbcPoolAddress(pk(WSOL), pk(mint), pk(config)).toBase58();
  return {
    pool,
    poolAuthority: S.deriveDbcPoolAuthority().toBase58(),
    baseVault: S.deriveDbcTokenVaultAddress(pk(pool), pk(mint)).toBase58(),
    quoteVault: S.deriveDbcTokenVaultAddress(pk(pool), pk(WSOL)).toBase58(),
    metadata: PublicKey.findProgramAddressSync([Buffer.from('metadata'), pk(P.metaplex).toBuffer(), pk(mint).toBuffer()], pk(P.metaplex))[0].toBase58(),
    event: S.deriveDbcEventAuthority().toBase58(),
    migrationMetadata: S.deriveDammV1MigrationMetadataAddress(pk(pool)).toBase58(),
  };
}

/** The coins a first buy gets on a brand-new pool of this config (fee off the input, as the program takes it). */
export function firstBuyOut(cp, lamports) {
  const fee = new BN(lamports.toString()).mul(cp.poolFees.baseFee.cliffFeeNumerator).add(new BN(S.FEE_DENOMINATOR - 1)).div(new BN(S.FEE_DENOMINATOR));
  const net = new BN(lamports.toString()).sub(fee);
  const stop = cp.curve[cp.curve.length - 1].sqrtPrice;
  const r = M.calculateQuoteToBaseFromAmountIn({ curve: cp.curve }, cp.sqrtStartPrice, net, stop);
  return BigInt(r.outputAmount.toString());
}

export const meteoraDbc = {
  id: 'meteora-dbc', chain: 'solana', name: 'Meteora DBC', feeModel: 'creator', firstBuy: true, clusters: ['mainnet', 'devnet'], guard: 'meteora-dbc',
  options: [
    { id: 'startMcap', label: 'starting market cap', type: 'choice', default: '30', choices: START.map((n) => ({ id: String(n), label: `${n} SOL` })), hint: 'the price the first buyer pays. pump.fun starts near 28 SOL.' },
    { id: 'gradMcap', label: 'graduates at a market cap of', type: 'choice', default: '400', choices: GRAD.map((n) => ({ id: String(n), label: `${n} SOL` })), hint: 'then the coin moves to a Meteora DAMM v2 pool, its liquidity locked for good.' },
    { id: 'feeBps', label: 'trading fee on the curve', type: 'choice', default: '100', choices: FEE.map((n) => ({ id: String(n), label: `${n / 100}%` })), hint: 'you get 80% of it, Meteora keeps 20%.' },
    { id: 'poolFeeBps', label: 'pool fee after graduation', type: 'choice', default: '100', choices: Object.keys(POOL_FEE).map((n) => ({ id: n, label: `${Number(n) / 100}%` })), hint: 'paid to the locked liquidity, which is yours.' },
  ],
  cleanOptions(raw) {
    const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    for (const k of Object.keys(o)) if (!meteoraDbc.options.some((x) => x.id === k)) throw bad(`Meteora DBC has no option called ${k.slice(0, 20)}.`);
    const pick = (k, list, dflt, words) => {
      const v = o[k] === undefined ? dflt : Number(o[k]);
      if (!list.includes(v)) throw bad(words);
      return v;
    };
    return {
      startMcap: pick('startMcap', START, 30, `pick a starting market cap: ${START.join(', ')} SOL.`),
      gradMcap: pick('gradMcap', GRAD, 400, `pick a graduation market cap: ${GRAD.join(', ')} SOL.`),
      feeBps: pick('feeBps', FEE, 100, 'pick a trading fee: 0.5%, 1% or 2%.'),
      poolFeeBps: pick('poolFeeBps', Object.keys(POOL_FEE).map(Number), 100, 'pick the pool fee after graduation: 0.25%, 1% or 2%.'),
    };
  },
  networkLamports: () => NETWORK_LAMPORTS,

  async estimateFirstBuy(rpc, lamports, slippagePct, { options }) {
    const cp = configParams(options ?? meteoraDbc.cleanOptions({}));
    const tokens = firstBuyOut(cp, lamports);
    const supply = BigInt(SUPPLY) * 1_000_000n;
    return { tokens: tokens.toString(), pctOfSupply: Number((tokens * 1_000_000n) / supply) / 10_000, creatorFeePct: (cp.poolFees.baseFee.cliffFeeNumerator.toNumber() / 1e7) * 0.8 };
  },

  /** create_config2 for this launch's own config (a fresh key). Not signed. */
  async buildPrep({ deposit, payout, cu = CU.prep, cuPrice, blockhash, options, keys }) {
    const config = keys?.config ?? Keypair.generate();
    const cp = configParams(options);
    const ix = await dbc().methods.createConfig2(cp, null).accountsPartial({ config: config.publicKey, feeClaimer: pk(payout), leftoverReceiver: pk(payout), quoteMint: pk(WSOL), payer: pk(deposit) }).instruction();
    const { tx, size } = compileTx({ label: 'config', payer: deposit, blockhash, cu, cuPrice, body: [ix] });
    const c = config.publicKey.toBase58();
    return { tx, size, extraSigners: [config], keys: { config }, data: { config: c }, policy: { guard: 'meteora-dbc', kind: 'prep', payout, config: c, signers: [c], options } };
  },
  async prepExists(rpc, { config }) {
    const info = await rpc.getAccountInfo(pk(config), 'confirmed');
    return !!info && info.owner.toBase58() === DBC_PROGRAM;
  },

  /** the pool [+ the first buy into the payout wallet] + the creator handed to the payout wallet. Not signed. */
  async buildCreate({ deposit, payout, name, symbol, uri, firstBuy, maxFirstBuyLamports, cu = CU.create, cuPrice, blockhash, options, prep, keys }) {
    if (!prep?.config) throw new LaunchError('config', 'meteora-dbc create without its config', "the coin's config isn't on chain yet.");
    const mint = keys?.mint ?? Keypair.generate();
    const m = mint.publicKey.toBase58();
    const a = accountsOf(m, prep.config);
    const program = dbc();
    const body = [
      await program.methods.initializeVirtualPoolWithSplToken({ name, symbol, uri }).accountsPartial({
        config: pk(prep.config), poolAuthority: pk(a.poolAuthority), creator: pk(deposit), baseMint: mint.publicKey, quoteMint: pk(WSOL), pool: pk(a.pool),
        baseVault: pk(a.baseVault), quoteVault: pk(a.quoteVault), mintMetadata: pk(a.metadata), metadataProgram: pk(P.metaplex), payer: pk(deposit),
        tokenQuoteProgram: pk(P.token), tokenProgram: pk(P.token),
      }).instruction(),
    ];
    if (firstBuy) {
      const out = firstBuyOut(configParams(options), firstBuy.lamports);
      const minOut = (out * BigInt(10_000 - Math.round(firstBuy.slippagePct * 100))) / 10_000n;
      if (minOut <= 0n) throw bad('that first buy is too small to buy any coins.');
      body.push(
        ataIx(deposit, payout, m),
        ...wrapIxs(deposit, firstBuy.lamports),
        await program.methods.swap({ amountIn: new BN(firstBuy.lamports.toString()), minimumAmountOut: new BN(minOut.toString()) }).accountsPartial({
          poolAuthority: pk(a.poolAuthority), config: pk(prep.config), pool: pk(a.pool), inputTokenAccount: pk(ataOf(WSOL, deposit)), outputTokenAccount: pk(ataOf(m, payout)),
          baseVault: pk(a.baseVault), quoteVault: pk(a.quoteVault), baseMint: mint.publicKey, quoteMint: pk(WSOL), payer: pk(deposit),
          tokenBaseProgram: pk(P.token), tokenQuoteProgram: pk(P.token), referralTokenAccount: null,
        }).instruction(),
        unwrapIx(deposit),
      );
    }
    body.push(
      await program.methods.transferPoolCreator().accountsPartial({ virtualPool: pk(a.pool), config: pk(prep.config), creator: pk(deposit), newCreator: pk(payout) })
        .remainingAccounts([{ pubkey: pk(a.migrationMetadata), isSigner: false, isWritable: false }]).instruction(),
    );
    const { tx, size } = compileTx({ label: 'create', payer: deposit, blockhash, cu, cuPrice, body });
    return {
      tx, size, mint: m, extraSigners: [mint], keys: { mint },
      policy: { guard: 'meteora-dbc', kind: 'create', payout, mint: m, config: prep.config, signers: [m], coin: { name, symbol, uri }, maxFirstBuyLamports: firstBuy ? maxFirstBuyLamports : null },
    };
  },

  async coinExists(rpc, mint, { prep }) {
    if (!prep?.config) return false;
    return !!(await rpc.getAccountInfo(pk(accountsOf(mint, prep.config).pool), 'confirmed'));
  },

  /** The pool and its config as the chain has them: the payout wallet is the creator and the fee claimer. */
  async readLaunch(rpc, { mint, rec, prep }) {
    if (!prep?.config) return { state: 'rejected', problem: "the coin's config isn't recorded." };
    const a = accountsOf(mint, prep.config);
    const [poolInfo, configInfo] = await rpc.getMultipleAccountsInfo([pk(a.pool), pk(prep.config)], 'confirmed');
    if (!poolInfo) return { state: 'waiting', problem: null };
    if (poolInfo.owner.toBase58() !== DBC_PROGRAM || configInfo?.owner.toBase58() !== DBC_PROGRAM) return { state: 'rejected', problem: "the coin's pool isn't Meteora's." };
    let pool;
    let config;
    try {
      pool = dbc().coder.accounts.decode('virtualPool', Buffer.from(poolInfo.data)).poolState; // the IDL wraps the fields
      config = dbc().coder.accounts.decode('poolConfig', Buffer.from(configInfo.data));
    } catch {
      return { state: 'rejected', problem: "the coin's pool couldn't be read." };
    }
    const payout = rec.payout.address;
    if (pool.config.toBase58() !== prep.config || pool.baseMint.toBase58() !== mint) return { state: 'rejected', problem: 'the pool is for another coin.' };
    if (pool.creator.toBase58() !== payout) return { state: 'waiting', problem: null }; // the hand-over lands with the create
    if (config.feeClaimer.toBase58() !== payout || config.leftoverReceiver.toBase58() !== payout) return { state: 'rejected', problem: "the coin's fees don't go to the payout wallet." };
    if (config.creatorTradingFeePercentage !== 100 || config.partnerLiquidityPercentage !== 0 || config.partnerPermanentLockedLiquidityPercentage !== 0) return { state: 'rejected', problem: "the coin's config gives someone else a share." };
    return { state: 'live', problem: null };
  },

  links(mint, cluster) {
    return cluster === 'mainnet' ? { url: `https://www.meteora.ag/dbc/${mint}`, label: 'open on Meteora' } : null;
  },

  /** The deposit key's rules for Meteora DBC (see the top of this file). */
  checkTx(tx, p) {
    const program = dbc();
    const { problems, body } = checkBase(tx, { ...p, programs: [DBC_PROGRAM, P.ata, P.system, P.token] });
    if (!body.length) return problems.length ? problems : ['the transaction is empty.'];
    const decode = (ix) => {
      if (progOf(ix) !== DBC_PROGRAM) return null;
      try {
        return program.coder.instruction.decode(Buffer.from(ix.data));
      } catch {
        return null;
      }
    };
    if (p.kind === 'prep') {
      const ix = body[0];
      const d = decode(ix);
      if (body.length !== 1 || !d || d.name !== 'createConfig2') return [...problems, 'the config transaction must be create_config2 alone.'];
      if (keyAt(ix, 0) !== p.config || !ix.keys[0].isSigner) problems.push("the config isn't the launch's own fresh one.");
      if (keyAt(ix, 1) !== p.payout || keyAt(ix, 2) !== p.payout) problems.push("the config's fee claimer and leftover receiver aren't the payout wallet.");
      if (keyAt(ix, 3) !== WSOL || keyAt(ix, 4) !== p.deposit) problems.push("the config isn't SOL-paired and paid by the deposit.");
      if (ix.keys.length !== 8) problems.push('the config names accounts it must not.');
      const c = d.data.configParameters;
      if (d.data.transferFeeParameters !== null) problems.push('the config sets a transfer fee.');
      // byte for byte: the parameters these options make, encoded by the same IDL
      const want = program.coder.instruction.encode('createConfig2', { configParameters: configParams(p.options), transferFeeParameters: null });
      if (Buffer.compare(Buffer.from(ix.data), Buffer.from(want)) !== 0) problems.push("the config isn't the one these options make.");
      if (c.creatorTradingFeePercentage !== 100 || c.partnerLiquidityPercentage !== 0 || c.partnerPermanentLockedLiquidityPercentage !== 0 || !new BN(c.poolCreationFee).isZero() || c.migrationFee.feePercentage !== 0) {
        problems.push('the config gives someone other than the creator a share.');
      }
      return problems;
    }
    if (p.kind !== 'create') return [...problems, `a ${p.kind} isn't a Meteora DBC transaction.`];
    const a = accountsOf(p.mint, p.config);
    const init = body[0];
    const di = decode(init);
    if (!di || di.name !== 'initializeVirtualPoolWithSplToken') return [...problems, 'the create must start with the pool.'];
    if (keyAt(init, 0) !== p.config || keyAt(init, 2) !== p.deposit || keyAt(init, 3) !== p.mint || !init.keys[3].isSigner || keyAt(init, 4) !== WSOL || keyAt(init, 5) !== a.pool || keyAt(init, 10) !== p.deposit) {
      problems.push("the pool isn't this coin's, on its own config, made by the deposit.");
    }
    if (keyAt(init, 8) !== a.metadata || keyAt(init, 9) !== P.metaplex || keyAt(init, 12) !== P.token || init.keys.length !== 16) problems.push('the pool names accounts it must not.');
    if (di.data.params.name !== p.coin.name || di.data.params.symbol !== p.coin.symbol || di.data.params.uri !== p.coin.uri) problems.push("the create's name, ticker or link isn't the kit's.");
    const last = body[body.length - 1];
    const dt = decode(last);
    if (!dt || dt.name !== 'transferPoolCreator' || keyAt(last, 0) !== a.pool || keyAt(last, 1) !== p.config || keyAt(last, 2) !== p.deposit || keyAt(last, 3) !== p.payout) {
      problems.push("the create doesn't hand the pool's creator to the payout wallet.");
    }
    if (last.keys.length !== 7 || keyAt(last, 6) !== a.migrationMetadata) problems.push('the hand-over names accounts it must not.');
    const mid = body.slice(1, -1);
    if (!mid.length) return problems;
    if (p.maxFirstBuyLamports == null) return [...problems, 'this launch has no first buy.'];
    if (mid.length !== 6) return [...problems, 'the first buy must be: coin account, wrap, swap, unwrap.'];
    if (!isAtaFor(mid[0], p.deposit, p.payout, p.mint)) problems.push("the coin account isn't the payout wallet's.");
    const wrapped = checkWrap(mid, 1, p.deposit, p.maxFirstBuyLamports, problems);
    const swap = mid[4];
    const ds = decode(swap);
    if (!ds || ds.name !== 'swap') return [...problems, "the first buy couldn't be read."];
    if (keyAt(swap, 1) !== p.config || keyAt(swap, 2) !== a.pool || keyAt(swap, 3) !== ataOf(WSOL, p.deposit) || keyAt(swap, 4) !== ataOf(p.mint, p.payout) || keyAt(swap, 7) !== p.mint || keyAt(swap, 8) !== WSOL || keyAt(swap, 9) !== p.deposit) {
      problems.push("the first buy isn't the deposit buying this coin into the payout wallet.");
    }
    if (keyAt(swap, 12) !== DBC_PROGRAM || swap.keys.length !== 15) problems.push('the first buy pays a referral.');
    if (wrapped !== null && BigInt(ds.data.params.amountIn.toString()) > wrapped) problems.push('the first buy spends more than was wrapped.');
    if (!isUnwrap(mid[5], p.deposit)) problems.push("the wrapped SOL isn't closed back into the deposit.");
    void hex8;
    return problems;
  },
};
