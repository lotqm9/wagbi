// Who gets the creator fees on each launchpad, and where a launched coin lives, in plain words. Light on purpose (no
// adapter, no SDK): the launch picker (launchpads.js), the coin's public record (service.js) and the coins tab
// (api/coins.js) all read it, so every page says the same thing.
//
// Every rate here is from LAUNCH-SPEC.md (read live 2026-11-01/02) or an adapter's own code. Where the spec doesn't
// state a rate it is null, and the page names none (never a number from memory).
//   rate      the creator's fee on every trade                 paidIn  what it is paid in
//   claim     how the money reaches the wallets               after   the creator fee once the coin graduates
//   graduates where the coin moves when its curve completes    caveat  the plain truth that changes the headline
// The split itself (pump.fun) is each deposit's own (service.js sharesOf); wagbi's cut is settings.feeBps.
import { BRAND } from '../brand.js';

export const PAD_INFO = {
  pumpfun: {
    name: 'pump.fun',
    facts: {
      rate: null,
      paidIn: 'SOL',
      // printer-engine's crank: distribute_creator_fees_v2 is pump.fun's own permissionless instruction
      claim: "pump.fun's fee program pays each wallet its share. anyone can trigger a payout once the fees pass pump.fun's minimum.",
      after: null,
      // read live 2026-11-02: graduated pump.fun coins trade on PumpSwap (DexScreener dexId pumpswap; Pilot's tape 2026-10-03)
      graduates: 'PumpSwap',
      caveat: null,
    },
    // LAUNCH-SPEC.md "pump.fun USDC pairs": the stable tier pays 0.30% to the creator (mainnet fee_config, 2026-11-02)
    currencies: { USDC: { facts: { rate: "0.30% of every trade (pump.fun's stable tier, mainnet, read 2026-11-02)", paidIn: 'USDC' } } },
  },
  'raydium-launchlab': {
    name: 'Raydium LaunchLab',
    facts: {
      rate: "0.05% of every trade on the curve (Raydium's platform rate, mainnet, read 2026-11-02)",
      paidIn: 'SOL',
      claim: "your wallet is the pool's creator from the first trade. you claim on raydium.io.",
      after: "after graduation, the CPMM pool's creator fee, paid in SOL only or in SOL and the coin (your pick).",
      graduates: 'a Raydium CPMM pool',
      caveat: null,
    },
  },
  letsbonk: {
    name: 'LetsBonk',
    facts: {
      rate: "0% on the curve (bonk.fun's platform config, read 2026-11-02)",
      paidIn: 'SOL',
      claim: null,
      after: "after graduation, bonk.fun's own wallet takes the pool's creator fee.",
      graduates: 'a Raydium CPMM pool',
      caveat: 'bonk.fun pays creators nothing, so there is nothing to keep here.',
    },
  },
  'meteora-dbc': {
    name: 'Meteora DBC',
    facts: {
      rate: '80% of the trading fee you pick (0.5%, 1% or 2% of every trade). Meteora keeps the other 20%.',
      paidIn: 'SOL',
      claim: 'you claim on meteora.ag.',
      after: "after graduation, the fees of the coin's locked liquidity in its DAMM v2 pool (locked for good, its fees stay yours).",
      graduates: 'a Meteora DAMM v2 pool',
      caveat: 'about 0.006 SOL of the setup stays locked on chain for good (Meteora has no way to close it).',
    },
  },
  bags: {
    name: 'Bags',
    facts: {
      rate: null,
      paidIn: 'SOL',
      claim: 'you claim on bags.fm.',
      after: null,
      graduates: null,
      // LAUNCH-SPEC.md "Bags", open problem: the fee-share config's payer (the deposit) gets 25% of the claimers' pool
      caveat: "Bags gives 25% of the claimers' pool to whoever pays for the fee setup, which here is the deposit, so you wouldn't get all of it. it stays off until that's solved.",
    },
  },
  moonit: {
    name: 'Moonit',
    facts: { rate: null, paidIn: null, claim: null, after: null, graduates: null, caveat: 'creators earn nothing on the curve (checked 2026-11-02).' },
  },
};

/** A launchpad's fee facts for one currency (the currency's own over the launchpad's), or null. */
export function factsOf(launchpad, currency) {
  const p = PAD_INFO[launchpad ?? 'pumpfun'];
  if (!p) return null;
  return { ...p.facts, ...(p.currencies?.[currency ?? 'SOL']?.facts ?? {}) };
}

/** Bags' own words for its fee line (see the caveat): not "you keep all of it". */
export const BAGS_FEE_NOTE = `most of the creator fees on Bags go to your wallet. Bags gives 25% to the fee setup's payer, which here is the deposit, so it isn't all of them yet. ${BRAND.name} takes nothing.`;

/** Where a coin's chart lives: DexScreener (mainnet only; devnet has no market). `pairUrl` when the market read found it. */
export const chartOf = (mint, cluster, pairUrl = null) => (cluster === 'mainnet' && mint ? pairUrl || `https://dexscreener.com/solana/${mint}` : null);

/** The launchpad's own page for a coin (the adapters' links(), mainnet only), without loading the adapters. */
export function padLinkOf(launchpad, mint, cluster) {
  if (cluster !== 'mainnet' || !mint) return null;
  switch (launchpad ?? 'pumpfun') {
    case 'pumpfun': return { url: `https://pump.fun/coin/${mint}`, label: 'open on pump.fun' };
    case 'raydium-launchlab': return { url: `https://raydium.io/launchpad/token/?mint=${mint}`, label: 'open on Raydium' };
    case 'letsbonk': return { url: `https://bonk.fun/token/${mint}`, label: 'open on bonk.fun' };
    case 'meteora-dbc': return { url: `https://www.meteora.ag/dbc/${mint}`, label: 'open on Meteora' };
    case 'bags': return { url: `https://bags.fm/${mint}`, label: 'open on Bags' };
    default: return null;
  }
}

/** The explorer page for a coin. */
export const explorerOf = (mint, cluster) => `https://solscan.io/token/${mint}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
