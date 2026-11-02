// The coins tab, the coin's page and the home strip. Public data only, cached briefly at the edge.
//
//   GET /api/coins[?n=<1..60>&before=<iso>&ln=<1..60>&lbefore=<iso>]
//     -> { ok, cluster, launched: [...], launchedNext, coins: [...], next }
//     launched: every coin launched through wagbi on this deployment's cluster (mainnet, or devnet on a test
//               deployment), newest launch first, each as it launched: { id, name, ticker, logo, sentence, page,
//               launch: { mint, launchpad, launchpadName, currency, at, feeModel, split, links: { pad, chart, explorer } },
//               site: { slug, path, url, rev } }   (site: the coin's own website, wagbi.fun/<slug>)
//     coins:    the coins made here and not launched, newest first (a coin is a conversation: listed once, by its
//               first kit, shown as its latest version): { id, name, ticker, sentence, logo, made, versions, page, site }
//   GET /api/coins?market=<coin id>,<coin id>,...   (up to 30 launched coins)
//     -> { ok, cluster, market: { <coin id>: { source, at, priceUsd, mcapUsd, volume24hUsd, change24hPct, liquidityUsd,
//          pairUrl, curve } } }   (launch/market.js: DexScreener, and the pump.fun curve read from the chain)
import { Connection } from '@solana/web3.js';
import { clientIp, fail, limited, ok } from './_lib/http.js';
import { settingsFromEnv } from './_lib/launch/settings.js';
import { PAD_INFO, chartOf, explorerOf, factsOf, padLinkOf } from './_lib/launch/facts.js';
import { createMarket } from './_lib/launch/market.js';
import { allVersions, blobs, hasStore, isId, isLive, kitEntries, laterVersionIds, launchList, previewKitIds, readLaunch } from './_lib/store.js';
import { allSiteEvents, primaryOf, siteView, slugOfUrl } from './_lib/sites.js';
import { publicSite, siteOf } from './_lib/siteindex.js';

const getJson = async (url) => {
  const r = await fetch(url);
  return r.ok ? r.json() : null;
};
const log = (e) => console.log(JSON.stringify({ at: 'coins', ...e }));
const clamp = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number(v) || d));

let market = null;
function marketFor(s) {
  if (!market || market.cluster !== s.cluster) market = { cluster: s.cluster, m: createMarket({ rpc: new Connection(s.rpcUrl, 'confirmed'), cluster: s.cluster, log }) };
  return market.m;
}

/** A launch record as the lists show it (public fields only). */
export function launchView(rec, cluster) {
  const launchpad = rec.launchpad ?? 'pumpfun';
  return {
    mint: rec.mint,
    launchpad,
    launchpadName: PAD_INFO[launchpad]?.name ?? launchpad,
    currency: rec.currency ?? 'SOL',
    at: rec.launchedAt ?? null,
    feeModel: rec.feeModel ?? 'split',
    split: (rec.split ?? []).map((x) => ({ role: x.role, bps: x.bps })),
    facts: factsOf(launchpad, rec.currency),
    links: { pad: padLinkOf(launchpad, rec.mint, cluster), chart: chartOf(rec.mint, cluster), explorer: explorerOf(rec.mint, cluster) },
  };
}

async function marketAnswer(u, s) {
  const ids = [...new Set((u.searchParams.get('market') || '').split(',').map((x) => x.trim()).filter(isId))].slice(0, 30);
  if (!ids.length) return ok({ cluster: s.cluster, market: {} }, 'public, max-age=10, s-maxage=20');
  // only coins launched here: the ids are read back through their launch records, never taken as mints
  const recs = (await Promise.all(ids.map((id) => readLaunch(id, s.cluster).catch(() => null)))).filter(Boolean);
  const m = await marketFor(s).read(recs.map((r) => ({ id: r.kitId, mint: r.mint, launchpad: r.launchpad ?? 'pumpfun' })));
  for (const r of recs) if (m[r.kitId]) m[r.kitId].chart = chartOf(r.mint, s.cluster, m[r.kitId].pairUrl);
  return ok({ cluster: s.cluster, market: m }, 'public, max-age=10, s-maxage=20, stale-while-revalidate=40');
}

export async function GET(req) {
  if (limited(`coins:${clientIp(req)}`, 90, 60_000)) return fail('slow', 429);
  if (!hasStore()) return fail('off', 503);
  const u = new URL(req.url);
  const s = settingsFromEnv();
  try {
    if (u.searchParams.has('market')) return await marketAnswer(u, s);
    const n = clamp(u.searchParams.get('n'), 1, 60, 30);
    const ln = clamp(u.searchParams.get('ln'), 1, 60, 24);
    const before = u.searchParams.get('before');
    const lbefore = u.searchParams.get('lbefore');
    const onlyLaunched = u.searchParams.get('only') === 'launched';
    // the live site leaves out the coins made on previews and local runs (they share the kits store)
    const [kits, later, versions, launches, tests, siteEvts] = await Promise.all([kitEntries(), laterVersionIds(), allVersions(), launchList(s.cluster), isLive() ? previewKitIds() : new Set(), allSiteEvents(blobs).catch(() => new Map())]);
    // each coin's website: its newest site event's slug (a launch's own address first); a coin with none gets one now
    const siteFor = async (id, website) => {
      const evs = siteEvts.get(id) ?? [];
      const own = slugOfUrl(website, publicSite());
      if (own || evs.length) return siteView(own || primaryOf(evs), publicSite(), evs.at(-1)?.at);
      return siteOf(id).catch(() => null);
    };
    const byId = new Map(kits.map((k) => [k.id, k]));
    const launchedIds = new Set(launches.map((l) => l.kitId));

    // launched, newest launch first
    const lAfter = lbefore ? launches.filter((l) => l.at < lbefore) : launches;
    const lPage = lAfter.slice(0, ln);
    const launched = (
      await Promise.all(
        lPage.map(async (l) => {
          const [rec, root] = await Promise.all([getJson(l.url).catch(() => null), byId.has(l.kitId) ? getJson(byId.get(l.kitId).url).catch(() => null) : null]);
          if (!rec || !rec.mint) return null;
          return {
            id: l.kitId, name: rec.name, ticker: rec.ticker, logo: rec.image, sentence: root?.sentence ?? null, page: `${s.publicSite || ''}/k/${l.kitId}`,
            launch: { ...launchView(rec, s.cluster), at: rec.launchedAt || l.at },
            site: await siteFor(l.kitId, rec.website),
          };
        }),
      )
    ).filter(Boolean);
    const launchedNext = lAfter.length > ln ? lPage.at(-1).at : null;
    if (onlyLaunched) return ok({ cluster: s.cluster, launched, launchedNext, coins: [], next: null }, 'public, max-age=10, s-maxage=15, stale-while-revalidate=60');

    // made here, not launched: each coin once (by its first kit), as its latest version
    const roots = kits.filter((k) => !later.has(k.id) && !launchedIds.has(k.id) && !tests.has(k.id));
    const after = before ? roots.filter((k) => k.at < before) : roots;
    const page = after.slice(0, n);
    const coins = (
      await Promise.all(
        page.map(async (e) => {
          const vs = versions.get(e.id) ?? [];
          const lastPointer = vs.at(-1);
          const [first, latestRef] = await Promise.all([
            getJson(e.url).catch(() => null),
            lastPointer && lastPointer.version > 1 ? getJson(lastPointer.url).catch(() => null) : null,
          ]);
          if (!first) return null;
          const latestEntry = latestRef && byId.get(latestRef.kitId);
          const latest = (latestEntry && (await getJson(latestEntry.url).catch(() => null))) || first;
          return {
            id: e.id, name: latest.name, ticker: latest.ticker, sentence: first.sentence, logo: latest.logo, made: first.made || e.at,
            versions: Math.max(1, vs.length), page: `${s.publicSite || ''}/k/${e.id}`, site: await siteFor(e.id),
          };
        }),
      )
    ).filter(Boolean);
    return ok(
      { cluster: s.cluster, launched, launchedNext, coins, next: after.length > n ? page.at(-1).at : null },
      'public, max-age=10, s-maxage=15, stale-while-revalidate=60',
    );
  } catch (e) {
    log({ error: String(e?.message ?? e).slice(0, 200) });
    return fail('off', 503);
  }
}
