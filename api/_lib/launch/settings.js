// The launch's settings, from the environment. Nothing here is secret: the master key and the deposits
// store token are read in wire.js and never leave the server.
//   WAGBI_FEE_WALLET          wagbi's fee wallet (a Solana wallet address). Unset: launches open soon,
//                             nothing on chain can run.
//   WAGBI_FEE_BPS             wagbi's fixed cut of the creator fees, basis points (default 1500 = 15%)
//   WAGBI_CLUSTER             mainnet (default) or devnet (a test deployment)
//   WAGBI_SOLANA_RPC_URL      the RPC (server only). Default: a public one for the cluster. Use a paid one live.
//   WAGBI_LAUNCH_ALT          the address lookup table the create reads (create + first buy don't fit in one
//                             transaction without one). Default on mainnet: the public table printer-engine
//                             was measured with; on devnet there is no default.
//   WAGBI_PUBLIC_SITE         where coins link forever (default https://wagbi.fun)
//   WAGBI_ALLOC_MAX_BUYERS    private allocation caps, for when it is built (default 10 buyers, 15% of supply)
//   WAGBI_ALLOC_MAX_PCT
//   WAGBI_LAUNCH_<LAUNCHPAD>  on | off: each launchpad beyond pump.fun on SOL (launchpads.js). Unset: on for one proven
//                             on devnet when this deployment IS devnet, off on mainnet.
//   BAGS_API_KEY              Bags' API key (secret: read in wire.js; here only whether it is set)
import { PublicKey } from '@solana/web3.js';
import { BRAND } from '../brand.js';

export const MAINNET_ALT = 'Hyif6eWb8x88RVrvjPfabsgRYnwkVnyByEXTVTXbUcyP';
export const PUBLIC_RPC = { mainnet: 'https://solana-rpc.publicnode.com', devnet: 'https://api.devnet.solana.com' };

const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
};

/** A wallet address (on the ed25519 curve, so a wallet someone holds the key to), else null. */
export function walletOrNull(v) {
  try {
    const k = new PublicKey(String(v || '').trim());
    return k.toBase58() === String(v).trim() && PublicKey.isOnCurve(k.toBytes()) ? k.toBase58() : null;
  } catch {
    return null;
  }
}

export function settingsFromEnv(env = process.env) {
  const t = (k) => (env[k] ?? '').trim();
  const cluster = t('WAGBI_CLUSTER') === 'devnet' ? 'devnet' : 'mainnet';
  const rawFee = t('WAGBI_FEE_WALLET');
  const feeWallet = walletOrNull(rawFee);
  const feeBps = Math.round(num(t('WAGBI_FEE_BPS'), 1, 5000, 1500));
  const site = t('WAGBI_PUBLIC_SITE') || BRAND.site;
  return {
    brand: BRAND.id,
    cluster,
    rpcUrl: t('WAGBI_SOLANA_RPC_URL') || PUBLIC_RPC[cluster],
    feeWallet,
    feeProblem: rawFee && !feeWallet ? 'WAGBI_FEE_WALLET is not a wallet address' : null,
    feeBps,
    table: t('WAGBI_LAUNCH_ALT') || (cluster === 'mainnet' ? MAINNET_ALT : null),
    publicSite: /^https:\/\/[^/\s]+\.[^/\s]+$/.test(site) ? site : null,
    // the brand's own coin, once it is live (the header shows it with a copy button; unset: "CA soon")
    ca: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t('WAGBI_CA')) ? t('WAGBI_CA') : null,
    allocation: { maxBuyers: Math.round(num(t('WAGBI_ALLOC_MAX_BUYERS'), 1, 50, 10)), maxPct: num(t('WAGBI_ALLOC_MAX_PCT'), 0.1, 50, 15) },
    switches: Object.fromEntries(Object.keys(env).filter((k) => /^WAGBI_LAUNCH_[A-Z0-9_]+$/.test(k) && k !== 'WAGBI_LAUNCH_ALT').map((k) => [k, t(k).toLowerCase()])),
    bagsKeySet: !!t('BAGS_API_KEY'),
  };
}

/** One corner of the deposits store per cluster and environment: a preview never touches production's deposits. */
export function depositPrefix(cluster, env = process.env) {
  const where = env.VERCEL_ENV === 'production' ? 'prod' : env.VERCEL_ENV === 'preview' ? 'preview' : 'dev';
  return `${cluster}/${where}/`;
}
