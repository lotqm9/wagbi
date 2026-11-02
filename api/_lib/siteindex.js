// Which website a coin has, light enough for any function to load (no picture tools): its address, a site made for a
// coin that has none yet (coins from before sites), every old coin's site in one go (oldest first), and the address a
// launch puts in the coin's details. coinsite.js draws the pages; sites.js keeps the names.
import { BRAND } from './brand.js';
import { blobs, kitEntries, laterVersionIds, latestVersion, readKit, readLaunch } from './store.js';
import { allSiteEvents, currentKit, ensureSite, primaryOf, purgeSite, siteEvents, siteView, slugOfUrl } from './sites.js';
import { settingsFromEnv } from './launch/settings.js';

const log = (e) => console.log(JSON.stringify({ at: 'site', ...e }));
const errLine = (e) => String(e?.message ?? e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
export const publicSite = () => settingsFromEnv().publicSite || BRAND.site;
/** The cluster whose launches the sites show: this deployment's, unless WAGBI_SITE_CLUSTER says otherwise (a devnet
 *  preview set to mainnet shows the live coins as production does; it only reads). */
export const siteCluster = () => {
  const v = (process.env.WAGBI_SITE_CLUSTER ?? '').trim();
  return v === 'mainnet' || v === 'devnet' ? v : settingsFromEnv().cluster;
};

/** A launch's website (launch/service.js): the site for the launching design and its (maybe edited) name. */
export async function siteForLaunch({ coinId, kit, name, ticker }, store = blobs) {
  const r = await ensureSite(store, { coin: coinId, kit: kit.id, name, ticker });
  await purgeSite(coinId);
  return siteView(r.slug, publicSite()).url;
}

/**
 * A coin's site address ({ slug, path, url }). A coin with no site yet (made before sites) gets one now, for the design
 * its site would show. Launched coins answer the address their launch carries.
 */
export async function siteOf(coinOrKit, { store = blobs, cluster = siteCluster(), events = null } = {}) {
  let coin = coinOrKit;
  const evs0 = events ?? (await siteEvents(store, coin));
  if (!evs0.length) {
    // maybe a later version's id: its coin is its root
    const k = await readKit(coinOrKit);
    if (!k) return null;
    coin = k.root || k.id;
    if (coin !== coinOrKit) return siteOf(coin, { store, cluster });
  }
  const launch = await readLaunch(coin, cluster).catch(() => null);
  const fromLaunch = launch && slugOfUrl(launch.website, publicSite());
  if (fromLaunch) return siteView(fromLaunch, publicSite(), evs0.at(-1)?.at);
  if (evs0.length) return siteView(primaryOf(evs0), publicSite(), evs0.at(-1)?.at);
  const kitId = currentKit(coin, [], await latestVersion(coin).catch(() => null));
  const k = (await readKit(kitId)) || (await readKit(coin));
  if (!k) return null;
  const r = await ensureSite(store, { coin, kit: k.id, name: launch?.name || k.name, ticker: launch?.ticker || k.ticker, events: [] });
  return siteView(r.slug, publicSite(), r.events.at(-1)?.at);
}

/**
 * Gives every coin made before sites its site, oldest coin first (so the first coin with a name keeps it). limit: at
 * most this many in one go. Answers [{ coin, slug }].
 */
export async function backfillSites({ store = blobs, cluster = siteCluster(), limit = Infinity } = {}) {
  const [kits, later, all] = await Promise.all([kitEntries(), laterVersionIds(), allSiteEvents(store)]);
  const todo = kits.filter((k) => !later.has(k.id) && !all.has(k.id)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, limit);
  const out = [];
  for (const k of todo) {
    try {
      const s = await siteOf(k.id, { store, cluster, events: [] });
      out.push({ coin: k.id, slug: s?.slug ?? null });
    } catch (e) {
      log({ evt: 'site.backfill_failed', coin: k.id, error: errLine(e) });
      out.push({ coin: k.id, slug: null });
    }
  }
  return out;
}
