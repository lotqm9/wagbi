// Live market numbers for the coins launched through wagbi: the coins tab, the coin's page and the home strip.
// Read only, public data, nothing signed. Two sources, both checked live 2026-11-02:
//
//   DexScreener's public API (no key; its docs allow 300 requests a minute on these endpoints), mainnet only:
//     GET https://api.dexscreener.com/tokens/v1/solana/<mint>,<mint>,...   (up to 30 mints)
//     -> [{ chainId, dexId, url, pairAddress, labels, baseToken: { address }, quoteToken, priceUsd, marketCap, fdv,
//           volume: { h24 }, priceChange: { h24 }, liquidity: { usd }, pairCreatedAt }]
//     It listed, that day: a coin still on its pump.fun curve (dexId pumpfun, no liquidity field), graduated pump.fun
//     coins (pumpswap), Raydium LaunchLab coins after graduation (raydium CPMM) and Meteora DBC coins (meteora).
//   The chain itself, for pump.fun coins on both clusters: the coin's bonding curve account gives its price and market
//     cap in the pair's quote (SOL or USDC) and how far the curve is to graduating, the second it exists. On devnet,
//     where no market site looks, this is the only source. The layout is printer-engine's decodeCurve (pump.fun IDL):
//     8-byte discriminator 17b7f83760d8ac60, then virtual token, virtual quote, real token, real quote reserves and the
//     total supply (u64s), complete (bool), creator (32), mayhem, cashback (u8s), quote mint (32). pump.fun's Global
//     holds initial_real_token_reserves at byte 89 (checked against the SDK's decodeGlobal on mainnet, 2026-11-02).
import { PublicKey } from '@solana/web3.js';

export const DEX_API = 'https://api.dexscreener.com/tokens/v1/solana/';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CURVE_DISC = '17b7f83760d8ac60';
const USDC = { mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' };
const TTL_MS = 20_000;
const GLOBAL_TTL_MS = 10 * 60_000;
const BATCH = 30;
const TOKEN_DECIMALS = 6;

/** An error as one short line for the logs, with any URL cut out (a paid RPC's URL carries its key). */
const errLine = (e) => String(e?.message ?? e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 160);

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** The pair that speaks for a coin: the deepest one it is the base of (a curve has no liquidity: then the busiest). */
export function pickPair(pairs, mint) {
  const mine = (Array.isArray(pairs) ? pairs : []).filter((p) => p && p.chainId === 'solana' && p.baseToken?.address === mint);
  if (!mine.length) return null;
  const liq = (p) => num(p.liquidity?.usd) ?? -1;
  const vol = (p) => num(p.volume?.h24) ?? 0;
  return mine.slice().sort((a, b) => liq(b) - liq(a) || vol(b) - vol(a))[0];
}

/** One DexScreener pair as the page shows it. */
export function fromPair(p) {
  return {
    priceUsd: num(p.priceUsd),
    mcapUsd: num(p.marketCap) ?? num(p.fdv),
    volume24hUsd: num(p.volume?.h24),
    change24hPct: num(p.priceChange?.h24),
    liquidityUsd: num(p.liquidity?.usd),
    dex: typeof p.dexId === 'string' ? p.dexId : null,
    pairUrl: typeof p.url === 'string' && p.url.startsWith('https://dexscreener.com/') ? p.url : null,
  };
}

export const bondingCurveOf = (mint) => PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], new PublicKey(PUMP_PROGRAM))[0].toBase58();

/** A pump.fun bonding curve account, decoded (printer-engine's layout), or null when it isn't one. */
export function decodeCurve(data) {
  const b = Buffer.from(data);
  if (b.length < 81 || b.subarray(0, 8).toString('hex') !== CURVE_DISC) return null;
  const u = (o) => b.readBigUInt64LE(o);
  return {
    virtualTokenReserves: u(8), virtualQuoteReserves: u(16), realTokenReserves: u(24), realQuoteReserves: u(32), tokenTotalSupply: u(40),
    complete: b[48] === 1,
    quoteMint: b.length >= 115 ? new PublicKey(b.subarray(83, 115)).toBase58() : PublicKey.default.toBase58(),
  };
}

/** What a curve says: price and market cap in its quote, and how far it is to graduating (0 to 100). */
export function curveNumbers(c, initialRealTokenReserves, cluster) {
  const usdc = c.quoteMint === USDC[cluster];
  const quoteDecimals = usdc ? 6 : 9;
  const vt = Number(c.virtualTokenReserves) / 10 ** TOKEN_DECIMALS;
  const vq = Number(c.virtualQuoteReserves) / 10 ** quoteDecimals;
  const price = vt > 0 ? vq / vt : null;
  const supply = Number(c.tokenTotalSupply) / 10 ** TOKEN_DECIMALS;
  const init = initialRealTokenReserves ? Number(initialRealTokenReserves) : null;
  const progress = c.complete ? 100 : init ? Math.max(0, Math.min(100, ((init - Number(c.realTokenReserves)) / init) * 100)) : null;
  return { quote: usdc ? 'USDC' : 'SOL', price, mcap: price === null ? null : price * supply, progressPct: progress === null ? null : Math.round(progress * 10) / 10, complete: c.complete };
}

/**
 * The market reader. deps: { rpc (a web3 Connection, or null), cluster, fetch, now }.
 * read(coins) with coins = [{ id, mint, launchpad }] -> { [id]: market } where market =
 *   { source: 'dexscreener' | 'chain' | null, at, priceUsd, mcapUsd, volume24hUsd, change24hPct, liquidityUsd, dex,
 *     pairUrl, curve: { quote, price, mcap, progressPct, complete } | null }
 * A source that fails or is slow just leaves its numbers null: the page says "no market data yet".
 */
export function createMarket(d) {
  const fetchFn = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const cache = new Map(); // `${kind}:${mint}` -> { at, v }
  let global = null;

  const fresh = (k, ttl = TTL_MS) => {
    const hit = cache.get(k);
    return hit && now() - hit.at < ttl ? hit : null;
  };

  async function dex(mints) {
    const out = new Map();
    const want = mints.filter((m) => {
      const hit = fresh(`dex:${m}`);
      if (hit) out.set(m, hit.v);
      return !hit;
    });
    for (let i = 0; i < want.length; i += BATCH) {
      const part = want.slice(i, i + BATCH);
      try {
        const r = await fetchFn(DEX_API + part.join(','), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6_000) });
        if (!r.ok) throw new Error(`dexscreener ${r.status}`);
        const pairs = await r.json();
        for (const m of part) {
          const p = pickPair(pairs, m);
          const v = p ? fromPair(p) : null;
          cache.set(`dex:${m}`, { at: now(), v });
          out.set(m, v);
        }
      } catch (e) {
        d.log?.({ evt: 'market.dex_failed', error: errLine(e) });
      }
    }
    return out;
  }

  async function initialReal() {
    if (global && now() - global.at < GLOBAL_TTL_MS) return global.v;
    const [g] = await d.rpc.getMultipleAccountsInfo([PublicKey.findProgramAddressSync([Buffer.from('global')], new PublicKey(PUMP_PROGRAM))[0]], 'confirmed');
    const v = g && g.data.length >= 97 ? g.data.readBigUInt64LE(89) : null;
    global = { at: now(), v };
    return v;
  }

  async function curves(mints) {
    const out = new Map();
    if (!d.rpc || !mints.length) return out;
    const want = mints.filter((m) => {
      const hit = fresh(`curve:${m}`, 10_000);
      if (hit) out.set(m, hit.v);
      return !hit;
    });
    if (!want.length) return out;
    try {
      const [init, infos] = await Promise.all([
        initialReal().catch(() => null),
        d.rpc.getMultipleAccountsInfo(want.map((m) => new PublicKey(bondingCurveOf(m))), 'confirmed'),
      ]);
      want.forEach((m, i) => {
        const c = infos[i] ? decodeCurve(infos[i].data) : null;
        const v = c ? curveNumbers(c, init, d.cluster) : null;
        cache.set(`curve:${m}`, { at: now(), v });
        out.set(m, v);
      });
    } catch (e) {
      d.log?.({ evt: 'market.curve_failed', error: errLine(e) });
    }
    return out;
  }

  async function read(coins) {
    const list = coins.filter((c) => c && typeof c.mint === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.mint));
    const mints = [...new Set(list.map((c) => c.mint))];
    const pumpMints = [...new Set(list.filter((c) => (c.launchpad ?? 'pumpfun') === 'pumpfun').map((c) => c.mint))];
    const [dx, cv] = await Promise.all([d.cluster === 'mainnet' ? dex(mints) : new Map(), curves(pumpMints)]);
    const out = {};
    for (const c of list) {
      const m = dx.get(c.mint) ?? null;
      const curve = cv.get(c.mint) ?? null;
      out[c.id] = {
        source: m ? 'dexscreener' : curve ? 'chain' : null,
        at: new Date(now()).toISOString(),
        priceUsd: m?.priceUsd ?? null,
        mcapUsd: m?.mcapUsd ?? (curve?.quote === 'USDC' ? curve.mcap : null),
        volume24hUsd: m?.volume24hUsd ?? null,
        change24hPct: m?.change24hPct ?? null,
        liquidityUsd: m?.liquidityUsd ?? null,
        dex: m?.dex ?? null,
        pairUrl: m?.pairUrl ?? null,
        curve,
      };
    }
    return out;
  }

  return { read };
}
