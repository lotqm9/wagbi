// pump.fun, the one wired launchpad. Everything the launch service does on chain that is pump.fun's own goes
// through here, and all of it is printer-engine's code (the builders, the guard rules, the chain read-back),
// so another launchpad is one more file like this one with the same shape:
//   id, chain, currencies          what the picker shows
//   maxWallets                     the most wallets its creator-fee split takes (here: what fits one split tx)
//   estimateFirstBuy(rpc, lamports, slippagePct) -> { tokens, pctOfSupply }
//   buildCreate(i) -> { tx, policy, extraSigners }   the coin + the first buy into the payout wallet
//   coinExists(rpc, mint) -> bool                    for a create whose fate is unknown
//   buildSplit(i) -> { tx, policy }                  the creator-fee split, locked
//   readLaunch(rpc, i) -> engine ChainVerdict        live / created / waiting / rejected
//   links(mint, cluster)
// The deposit key signs through the engine's DepositSigner, whose guard knows pump.fun's instructions only, so
// a new launchpad also brings its own guard rules before it can sign anything.
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  MAX_SHAREHOLDERS, asShareholders, bad, bondingCurveOf, buildDepositCreateTx, buildDepositSplitTx, firstBuyAmounts, loadPumpState, readLaunchOnChain,
} from 'printer-engine/launch';

/** pump.fun takes 10 shareholders (update_fee_shares_v2, verified 2026-11-01), but the engine's split transaction
 *  (sweep + config + shares, no lookup table) grows 34 bytes a wallet: 8 are 1,216 bytes, 9 are 1,250, over
 *  Solana's 1,232 (measured 2026-11-01). Going to 10 needs the lookup table in the engine's split builder. */
const MAX_WALLETS = Math.min(MAX_SHAREHOLDERS, 8);

let cache = null;
async function state(rpc, now = Date.now()) {
  if (cache && cache.rpc === rpc && now - cache.at < 60_000) return cache.st;
  const st = await loadPumpState(rpc, now);
  cache = { rpc, at: now, st };
  return st;
}

export const pumpfun = {
  id: 'pumpfun',
  currency: 'SOL',
  chain: 'solana',
  name: 'pump.fun',
  feeModel: 'split',
  firstBuy: true,
  clusters: ['mainnet', 'devnet'],
  maxWallets: MAX_WALLETS,
  options: [],
  cleanOptions(raw) {
    if (raw && typeof raw === 'object' && Object.keys(raw).length) throw bad('pump.fun has no options to set.');
    return {};
  },
  /** null: the engine's own measured network costs (DEFAULT_DEPOSIT_PARAMS.networkLamports) */
  networkLamports: () => null,
  async estimateFirstBuy(rpc, lamports, slippagePct) {
    const st = await state(rpc);
    const est = firstBuyAmounts(st, BigInt(lamports), slippagePct);
    const supply = BigInt(st.global.tokenTotalSupply.toString());
    return { tokens: est.tokens.toString(), pctOfSupply: Number((est.tokens * 1_000_000n) / supply) / 10_000 };
  },
  /** create_v2 [+ the payout wallet's coin account + the first buy], with a fresh mint. Not signed. */
  async buildCreate({ rpc, deposit, payout, name, symbol, uri, firstBuy, maxFirstBuyLamports, priorityLamports, blockhash, table }) {
    const pump = await loadPumpState(rpc);
    const mint = Keypair.generate();
    const built = await buildDepositCreateTx({
      pump, mint: mint.publicKey, deposit: new PublicKey(deposit), payout: new PublicKey(payout), name, symbol, uri, firstBuy, priorityLamports, blockhash, table,
    });
    return {
      tx: built.built.tx,
      mint: mint.publicKey.toBase58(),
      extraSigners: [mint],
      policy: { kind: 'create', payout, mint: mint.publicKey.toBase58(), coin: { name, symbol, uri }, maxFirstBuyLamports: firstBuy ? maxFirstBuyLamports : null, tables: table ? [table] : [] },
    };
  },
  async coinExists(rpc, mint) {
    return !!(await rpc.getAccountInfo(new PublicKey(bondingCurveOf(mint)), 'confirmed'));
  },
  /** sweep_creator_fee + create_fee_sharing_config + update_fee_shares_v2 (locks it). Not signed. */
  async buildSplit({ mint, deposit, payout, shares, priorityLamports, withBuy, blockhash }) {
    const built = await buildDepositSplitTx({ mint: new PublicKey(mint), deposit: new PublicKey(deposit), shares, priorityLamports, withBuy, blockhash });
    return { tx: built.tx, policy: { kind: 'split', payout, mint, shares: asShareholders(shares) } };
  },
  readLaunch(rpc, { mint, deposit, shares }) {
    return readLaunchOnChain(rpc, { mint, launcher: deposit, shareholders: asShareholders(shares) });
  },
  links(mint, cluster) {
    return cluster === 'devnet' ? null : { url: `https://pump.fun/coin/${mint}`, label: 'open on pump.fun' };
  },
};
