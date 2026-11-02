// GET /api/coins[?before=<iso time>&n=<1..60>]  ->  {ok, coins: [...], next, cluster}
// The coins tab: every coin made on wagbi, newest first. A coin is a conversation: listed once (by its first kit),
// shown as its latest version, with its launch when it is live on this deployment's cluster (mainnet, or devnet
// on a test deployment). Public data only. Cached briefly at the edge.
import { clientIp, fail, limited, ok } from './_lib/http.js';
import { settingsFromEnv } from './_lib/launch/settings.js';
import { allVersions, hasStore, kitEntries, laterVersionIds, launchEntries } from './_lib/store.js';

const getJson = async (url) => {
  const r = await fetch(url);
  return r.ok ? r.json() : null;
};

export async function GET(req) {
  if (limited(`coins:${clientIp(req)}`, 60, 60_000)) return fail('slow', 429);
  if (!hasStore()) return fail('off', 503);
  const u = new URL(req.url);
  const n = Math.max(1, Math.min(60, Number(u.searchParams.get('n')) || 30));
  const before = u.searchParams.get('before');
  const { cluster, publicSite } = settingsFromEnv();
  try {
    const [kits, later, versions, launched] = await Promise.all([kitEntries(), laterVersionIds(), allVersions(), launchEntries(cluster)]);
    const byId = new Map(kits.map((k) => [k.id, k]));
    const roots = kits.filter((k) => !later.has(k.id));
    const after = before ? roots.filter((k) => k.at < before) : roots;
    const page = after.slice(0, n);
    const coins = await Promise.all(
      page.map(async (e) => {
        const vs = versions.get(e.id) ?? [];
        const lastPointer = vs.at(-1);
        const [first, latestRef, launch] = await Promise.all([
          getJson(e.url).catch(() => null),
          lastPointer && lastPointer.version > 1 ? getJson(lastPointer.url).catch(() => null) : null,
          launched.has(e.id) ? getJson(launched.get(e.id)).catch(() => null) : null,
        ]);
        if (!first) return null;
        const latestEntry = latestRef && byId.get(latestRef.kitId);
        const latest = (latestEntry && (await getJson(latestEntry.url).catch(() => null))) || first;
        // a launched coin shows the version it launched with
        const shown = launch?.versionId && launch.versionId !== latest.id ? (byId.has(launch.versionId) ? (await getJson(byId.get(launch.versionId).url).catch(() => null)) || latest : latest) : latest;
        return {
          id: e.id, name: shown.name, ticker: shown.ticker, sentence: first.sentence, logo: shown.logo, made: first.made || e.at,
          versions: Math.max(1, vs.length), page: `${publicSite || ''}/k/${e.id}`,
          launch: launch
            ? { mint: launch.mint, cluster: launch.cluster, at: launch.launchedAt || null, version: launch.version || 1, launchpad: launch.launchpad || 'pumpfun', pump: launch.cluster === 'devnet' || (launch.launchpad && launch.launchpad !== 'pumpfun') ? null : `https://pump.fun/coin/${launch.mint}` }
            : null,
        };
      }),
    );
    return ok({ coins: coins.filter(Boolean), next: after.length > n ? page.at(-1).at : null, cluster }, 'public, max-age=10, s-maxage=15, stale-while-revalidate=60');
  } catch (e) {
    console.log(JSON.stringify({ at: 'coins', error: String(e?.message ?? e).slice(0, 200) }));
    return fail('off', 503);
  }
}
