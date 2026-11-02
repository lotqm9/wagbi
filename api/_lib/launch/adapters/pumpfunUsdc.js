// pump.fun with USDC as the launch currency: the coin trades against USDC instead of SOL. The fee split is the same
// as on SOL (the payout wallet, wagbi's fixed cut and the person's own wallets, locked on chain).
//
// Read live 2026-11-02 (LAUNCH-SPEC.md, "pump.fun USDC pairs"): pump-public-docs 639b87f (2026-10-13) COIN_CREATION,
// BUY, TRADE_V3, SWEEP_FEES and CREATOR_FEE_SHARING; @pump-fun/pump-sdk 4.3.1 (2026-10-22), whose create_v2, buy_v3,
// sweep_creator_fee, create_fee_sharing_config and update_fee_shares_v2 are byte for byte the 4.0.0 this site runs;
// Global on both clusters (USDC whitelisted: mainnet EPjFW..., devnet 4zMMC...).
//
//   create  create_v2 with the three quote accounts (USDC, the curve's USDC account, SPL Token) and pump.fun's
//           quote-control account. CREATE ONLY: a USDC pair is bought with USDC (buy_v3), pump.fun has no
//           instruction that takes SOL for it, and a deposit receives SOL. A first buy would need a SOL->USDC swap
//           on an outside DEX first, which the deposit guard does not allow, so the picker says "no first buy".
//   split   two USDC accounts opened first (pump.fun's creator vault for the coin's sharing config, and the deposit's
//           own, as the current shareholder): update_fee_shares_v2 pays out pending fees through them and fails with
//           InvalidAccountData when the vault's is missing (devnet simulation 2026-11-02, test/devnet-pads.mjs sim);
//           then sweep_creator_fee (USDC) + create_fee_sharing_config + update_fee_shares_v2 (USDC), as on SOL.
// The creator fee is paid in USDC (pump.fun's stable tier, 0.30% to the creator: mainnet fee_config 2026-11-02).
import { createRequire } from 'node:module';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  MAX_SHAREHOLDERS, asShareholders, bad, bondingCurveOf, creatorVaultOf, decodeCreateV2, decodeCurve, decodeSharingConfig, decodeUpdateSharesV2, sameSplit, sharingConfigOf,
} from 'printer-engine/launch';
import { P, USDC, ataIx, ataOf, checkBase, compileTx, hex8, isAtaFor, keyAt, progOf } from '../chain.js';

const require = createRequire(import.meta.url);
const pump = require('@pump-fun/pump-sdk');
const { PUMP_SDK, QUOTE_CONTROL_PDA } = pump;

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const DISC = { createV2: 'd6904cec5f8b31b4', sweep: '20f6bf3408c949ba', config: 'c34e564c6f34fbd5', shares: '6ffb31064e4e6a12' };
const CU = { create: 160_000, split: 300_000 };
/** create: 7,096,600 lamports in a devnet simulation (2026-11-02); split: the sharing config + three USDC accounts
 *  (the two it opens, the deposit creator vault's the sweep opens) ~ 8.5M; + fees, with room. */
const NETWORK_LAMPORTS = 24_000_000;
/** The split transaction holds 6 wallets here (the USDC accounts it opens and names): measured by building. */
export const MAX_WALLETS_USDC = Math.min(MAX_SHAREHOLDERS, 6);

const pk = (k) => new PublicKey(k);
const tokenProgram = pk(P.token);

export const pumpfunUsdc = {
  id: 'pumpfun', currency: 'USDC', chain: 'solana', name: 'pump.fun', feeModel: 'split', firstBuy: false, clusters: ['mainnet', 'devnet'], guard: 'pumpfun-usdc',
  maxWallets: MAX_WALLETS_USDC,
  options: [],
  cleanOptions(raw) {
    if (raw && typeof raw === 'object' && Object.keys(raw).length) throw bad('pump.fun has no options to set.');
    return {};
  },
  networkLamports: () => NETWORK_LAMPORTS,
  async estimateFirstBuy() {
    return null;
  },

  /** create_v2 on a USDC pair, the deposit as creator and payer. Not signed. */
  async buildCreate({ cluster, deposit, name, symbol, uri, firstBuy, cu = CU.create, cuPrice, blockhash, keys }) {
    if (firstBuy) throw bad("a USDC pair can't have a first buy here: pump.fun's USDC pairs are bought with USDC, and the deposit takes SOL.");
    const mint = keys?.mint ?? Keypair.generate();
    const ix = await PUMP_SDK.createV2Instruction({
      mint: mint.publicKey, name, symbol, uri, creator: pk(deposit), user: pk(deposit), mayhemMode: false, quoteMint: pk(USDC[cluster]), quoteTokenProgram: tokenProgram,
    });
    const { tx, size } = compileTx({ label: 'create', payer: deposit, blockhash, cu, cuPrice, body: [ix] });
    const m = mint.publicKey.toBase58();
    return { tx, size, mint: m, extraSigners: [mint], keys: { mint }, policy: { guard: 'pumpfun-usdc', kind: 'create', cluster, mint: m, signers: [m], coin: { name, symbol, uri } } };
  },
  async coinExists(rpc, mint) {
    return !!(await rpc.getAccountInfo(pk(bondingCurveOf(mint)), 'confirmed'));
  },

  /** sweep_creator_fee + create_fee_sharing_config + update_fee_shares_v2 on the USDC pair (locks it). Not signed. */
  async buildSplit({ cluster, mint, deposit, payout, shares, cu = CU.split, cuPrice, blockhash }) {
    const usdc = pk(USDC[cluster]);
    const holders = asShareholders(shares);
    const body = [
      ataIx(deposit, creatorVaultOf(sharingConfigOf(mint)), USDC[cluster]),
      ataIx(deposit, deposit, USDC[cluster]),
      await PUMP_SDK.sweepCreatorFeeInstruction({ payer: pk(deposit), mint: pk(mint), creator: pk(deposit), quoteMint: usdc, quoteTokenProgram: tokenProgram }),
      await PUMP_SDK.createFeeSharingConfig({ creator: pk(deposit), mint: pk(mint), pool: null }),
      await PUMP_SDK.updateFeeSharesV2({
        authority: pk(deposit), mint: pk(mint), currentShareholders: [pk(deposit)],
        newShareholders: holders.map((s) => ({ address: pk(s.address), shareBps: s.shareBps })),
        quoteMint: usdc, quoteTokenProgram: tokenProgram, bondingCurveComplete: false,
      }),
    ];
    const { tx, size } = compileTx({ label: 'split', payer: deposit, blockhash, cu, cuPrice, body });
    return { tx, size, policy: { guard: 'pumpfun-usdc', kind: 'split', cluster, payout, mint, shares: holders, signers: [] } };
  },

  /** The coin, its USDC curve and its locked split, as the chain has them. */
  async readLaunch(rpc, { mint, deposit, shares, rec }) {
    const usdc = USDC[rec.cluster];
    const configAddr = sharingConfigOf(mint);
    const [mintInfo, curveInfo, configInfo] = await rpc.getMultipleAccountsInfo([mint, bondingCurveOf(mint), configAddr].map(pk), 'confirmed');
    if (!curveInfo) return { state: 'waiting', problem: null };
    if (!mintInfo || mintInfo.owner.toBase58() !== P.token2022) return { state: 'rejected', problem: "the coin isn't the kind of token pump.fun makes." };
    if (curveInfo.owner.toBase58() !== PUMP) return { state: 'rejected', problem: "the coin's bonding curve isn't pump.fun's." };
    let curve;
    try {
      curve = decodeCurve(curveInfo.data);
    } catch {
      return { state: 'rejected', problem: "the coin's bonding curve couldn't be read." };
    }
    if (curve.quoteMint !== usdc) return { state: 'rejected', problem: "the coin isn't paired with USDC." };
    if (curve.mayhem || curve.cashback || curve.holderReward) return { state: 'rejected', problem: 'the coin was created as a kind wagbi never makes.' };
    if (!configInfo) {
      if (curve.creator !== deposit) return { state: 'rejected', problem: "the coin's creator isn't the deposit." };
      return { state: 'created', problem: null, curve };
    }
    let sc;
    try {
      sc = decodeSharingConfig(configInfo.data);
    } catch {
      return { state: 'rejected', problem: "the fee split on chain couldn't be read." };
    }
    if (configInfo.owner.toBase58() !== PUMP_FEES || sc.status !== 'Active' || sc.mint !== mint || sc.admin !== deposit) return { state: 'rejected', problem: "the fee split on chain isn't this coin's." };
    if (!sc.adminRevoked) return { state: 'rejected', problem: "the fee split isn't locked." };
    if (!sameSplit(sc.shareholders, asShareholders(shares))) return { state: 'rejected', problem: "the fee split on chain doesn't match the launch's." };
    if (curve.creator !== configAddr) return { state: 'rejected', problem: "the coin's creator fees don't flow into its split." };
    return { state: 'live', problem: null, curve };
  },

  links(mint, cluster) {
    return cluster === 'mainnet' ? { url: `https://pump.fun/coin/${mint}`, label: 'open on pump.fun' } : null;
  },

  /** The deposit key's rules for a pump.fun USDC pair. */
  checkTx(tx, p) {
    const usdc = USDC[p.cluster];
    if (p.kind === 'create') {
      const { problems, body } = checkBase(tx, { ...p, programs: [PUMP] });
      if (body.length !== 1 || progOf(body[0]) !== PUMP || hex8(body[0]) !== DISC.createV2) return [...problems, 'the create must be create_v2 alone (no first buy on a USDC pair).'];
      const c = body[0];
      let args;
      try {
        args = decodeCreateV2(Uint8Array.from(c.data));
      } catch {
        return [...problems, "the create couldn't be read."];
      }
      if (args.creator !== p.deposit) problems.push("the create doesn't make the deposit the creator.");
      if (keyAt(c, 0) !== p.mint || !c.keys[0].isSigner) problems.push("the create isn't for this coin's mint.");
      if (keyAt(c, 5) !== p.deposit) problems.push("the create isn't paid by the deposit.");
      if (args.name !== p.coin.name || args.symbol !== p.coin.symbol || args.uri !== p.coin.uri) problems.push("the create's name, ticker or link isn't the kit's.");
      if (args.mayhem || args.cashback || args.holderReward || args.creatorFeeBps !== 0n) problems.push('the create asks for a kind of coin wagbi never makes.');
      if (c.keys.length !== 20 || keyAt(c, 16) !== usdc || keyAt(c, 17) !== ataOf(usdc, bondingCurveOf(p.mint)) || keyAt(c, 18) !== P.token || keyAt(c, 19) !== QUOTE_CONTROL_PDA.toBase58()) {
        problems.push("the create isn't a USDC pair on this network.");
      }
      return problems;
    }
    if (p.kind === 'split') {
      const { problems, body } = checkBase(tx, { ...p, programs: [PUMP, PUMP_FEES, P.ata] });
      const names = body.map((ix) => `${progOf(ix) === PUMP ? 'pump' : progOf(ix) === P.ata ? 'ata' : 'fees'}:${progOf(ix) === P.ata ? '' : hex8(ix)}`).join();
      if (names !== `ata:,ata:,pump:${DISC.sweep},fees:${DISC.config},fees:${DISC.shares}`) return [...problems, 'the split must be: two USDC accounts, sweep, config, shares.'];
      const [vaultAta, ownAta, sweep, config, shares] = body;
      if (!isAtaFor(vaultAta, p.deposit, creatorVaultOf(sharingConfigOf(p.mint)), usdc) || !isAtaFor(ownAta, p.deposit, p.deposit, usdc)) problems.push("the split opens USDC accounts other than the coin's fee vault and the deposit's own.");
      if (keyAt(sweep, 0) !== p.deposit || keyAt(sweep, 2) !== p.mint || keyAt(sweep, 3) !== usdc || keyAt(sweep, 9) !== creatorVaultOf(p.deposit) || keyAt(sweep, 10) !== ataOf(usdc, creatorVaultOf(p.deposit))) {
        problems.push("the fee sweep isn't into the deposit's own creator vault, in USDC.");
      }
      if (keyAt(config, 2) !== p.deposit || keyAt(config, 4) !== p.mint) problems.push("the split isn't for this coin, set up by the deposit.");
      if (keyAt(shares, 2) !== p.deposit || keyAt(shares, 4) !== p.mint || keyAt(shares, 14) !== usdc) problems.push("the shares aren't for this coin's USDC pair, locked by the deposit.");
      if (shares.keys.length !== 21 || keyAt(shares, 19) !== p.deposit || keyAt(shares, 20) !== ataOf(usdc, p.deposit)) problems.push('the shares name accounts they must not.');
      let list;
      try {
        list = decodeUpdateSharesV2(Uint8Array.from(shares.data));
      } catch {
        return [...problems, "the shares couldn't be read."];
      }
      if (!sameSplit(list, p.shares)) problems.push("the shares aren't exactly the launch's split.");
      if (!list.some((s) => s.address === p.payout)) problems.push("the payout wallet isn't a shareholder.");
      if (list.some((s) => s.address === p.deposit)) problems.push('the deposit keeps a share.');
      return problems;
    }
    return [`a ${p.kind} isn't a pump.fun USDC transaction.`];
  },
};

