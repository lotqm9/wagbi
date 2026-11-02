// A coin's website, end to end: what its page shows (pageData), its look and its words, and a design picked in its
// chat (api/site.js), a turn in its chat (api/make.js). siteindex.js keeps the addresses (the coins tab and the launch
// use it without loading the picture tools), sites.js names the sites, looks.js reads the art, lore.js writes.
// The page itself is cached at the edge and tagged with the coin, so a change purges it at once.
import { blobs, editHashOf, hold, isId, latestVersion, readKit, readLaunch, settle, spentToday, storeHost } from './store.js';
import { claimOf, currentKit, ensureSite, isKeyed, keyOk, markKeyed, primaryOf, purgeSite, siteEvents, siteView, slugOfUrl } from './sites.js';
import { publicSite, siteCluster, siteOf } from './siteindex.js';
import { askEditor, latestEdits, saveEdits } from './siteedit.js';
import { accountKey, authConfig } from './auth.js';
import { hasUsers, readChats } from './users.js';
import { buildLook, cleanLook, hashOf, logoWebp, readArt } from './looks.js';
import { LORE_WORST_USD, cleanStored, fallbackLore, loreKey, lorePath, writeLore } from './lore.js';
import { PUBLIC_RPC, settingsFromEnv } from './launch/settings.js';
import { PAD_INFO, chartOf, explorerOf, padLinkOf } from './launch/facts.js';
import { createMarket } from './launch/market.js';
import { Connection, PublicKey } from '@solana/web3.js';

export { siteCluster, siteOf } from './siteindex.js';
export { tagSite } from './sites.js';

const log = (e) => console.log(JSON.stringify({ at: 'site', ...e }));
const errLine = (e) => String(e?.message ?? e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);

// ---------- the pictures ----------
const PIC = /^https:\/\/([a-z0-9]+)\.public\.blob\.vercel-storage\.com\/kits\/[A-Za-z0-9_-]{16}\/[a-z]+\.(png|jpg|webp)$/;
/** One of a kit's pictures from this store (never any other address), or null. */
async function picture(url) {
  const m = PIC.exec(String(url || ''));
  const host = storeHost();
  if (!m || (host && !host.startsWith(m[1]))) return null;
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length > 0 && buf.length <= 12_000_000 ? buf : null;
}

// the look's own version: a change to how looks are read makes every kit's look again (the old ones stay, unread)
export const LOOK_V = 'v2';
const lookPath = (kit) => `sites/looks/${LOOK_V}/${kit}.json`;
const logoPath = (kit) => `sites/looks/${kit}.webp`;

/** A kit's look: stored, else read from its art now (and stored for good). */
export async function lookOf(kit, store = blobs) {
  const have = cleanLook(await store.json(lookPath(kit.id)).catch(() => null));
  if (have) return have;
  const [small, banner, big] = await Promise.all([picture(kit.thumb || kit.logo), picture(kit.banner), kit.thumb ? picture(kit.logo) : null]);
  const art = await readArt(small, banner, hashOf(kit.id));
  const look = { ...buildLook(kit, art), art: { L: art.L, C: art.C, clusters: art.clusters.slice(0, 8) } };
  let logo640 = null;
  try {
    if (big || small) logo640 = (await store.create(logoPath(kit.id), await logoWebp(big || small), 'image/webp')) || (await store.head(logoPath(kit.id)))?.url || null;
  } catch (e) {
    log({ evt: 'site.logo_failed', kit: kit.id, error: errLine(e) });
  }
  const stored = { ...look, logo640, kit: kit.id, at: new Date().toISOString() };
  await store.create(lookPath(kit.id), JSON.stringify(stored), 'application/json').catch(() => null);
  return cleanLook(stored);
}

// ---------- the lore ----------
const dailyCap = () => {
  const v = Number(process.env.WAGBI_DAILY_USD);
  return Number.isFinite(v) && v >= 0 ? v : 5;
};
const hourOf = (t) => new Date(t).toISOString().slice(0, 13).replace(/\D/g, '');
/** The written words for a coin's name, or null. */
export async function storedLore(coin, words, store = blobs) {
  return cleanStored(await store.json(lorePath(coin, words)).catch(() => null));
}

/**
 * Writes a coin's lore once for its words (one try an hour, the daily cap respected, the cost counted like every other
 * call). Answers the paragraphs, or null.
 */
export async function writeLoreOnce(coin, words, store = blobs) {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return null;
  if (await storedLore(coin, words, store)) return null;
  if (!(await store.create(`${lorePath(coin, words)}.try-${hourOf(Date.now())}`, '1', 'text/plain'))) return null;
  if ((await spentToday()) + LORE_WORST_USD > dailyCap()) return null;
  const id = `lore-${loreKey(words)}-${Date.now().toString(36)}`;
  const day = await hold(id, LORE_WORST_USD);
  let usd = LORE_WORST_USD;
  try {
    const r = await writeLore(words);
    usd = r.usd;
    if (!r.lore) {
      log({ evt: 'site.lore_unusable', coin });
      return null;
    }
    await store.create(lorePath(coin, words), JSON.stringify({ v: 2, ...r.lore, model: r.model, kit: words.id ?? null, at: new Date().toISOString() }), 'application/json');
    log({ evt: 'site.lore', coin, usd: Math.round(usd * 1e6) / 1e6 });
    return r.lore;
  } catch (e) {
    log({ evt: 'site.lore_failed', coin, error: errLine(e) });
    return null;
  } finally {
    await settle(id, day, LORE_WORST_USD, usd).catch(() => {});
  }
}

/** Reads (or writes) what a design's site needs ahead of the first visit: its look and its lore. */
export const warm = (coin, kit, store = blobs) =>
  Promise.allSettled([lookOf(kit, store), writeLoreOnce(coin, kit, store)]).then((r) => {
    for (const x of r) if (x.status === 'rejected') log({ evt: 'site.warm_failed', coin, error: errLine(x.reason) });
  });

// ---------- the moments that change a site ----------
/**
 * After a turn in a coin's chat (api/make.js): the coin's site moves to the turn's first design (where the chat moves).
 * fresh: the coin was made by this turn (it gets its key). Answers { site, warm } (warm: a promise to wait for later).
 */
export async function afterTurn(kits, { fresh = false, store = blobs } = {}) {
  const k = kits[0];
  const coin = k.root || k.id;
  const r = await ensureSite(store, { coin, kit: k.id, name: k.name, ticker: k.ticker });
  if (fresh) await markKeyed(store, coin);
  else await purgeSite(coin);
  return { site: siteView(r.slug, publicSite(), r.events.at(-1)?.at), warm: warm(coin, k, store) };
}

export class SiteError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/**
 * A design picked in a chat: the coin's site shows it from now on. key: the coin's site key (sites.js); token: the
 * chat's edit token for the coin (make.js TOKEN), the other proof that it is the coin's own chat.
 */
export async function pick(kitId, key, { token = null, store = blobs, cluster = siteCluster() } = {}) {
  if (!isId(kitId)) throw new SiteError('not_found', 404);
  const k = await readKit(kitId);
  if (!k) throw new SiteError('not_found', 404);
  const coin = k.root || k.id;
  const launch = await readLaunch(coin, cluster).catch(() => null);
  if (launch?.mint) return { site: await siteOf(coin, { store, cluster }), warm: null };
  const owned = !!(k.edit && typeof token === 'string' && token && editHashOf(token) === k.edit);
  if (!owned && (await isKeyed(store, coin)) && !keyOk(coin, key)) throw new SiteError('signin', 403);
  const r = await ensureSite(store, { coin, kit: k.id, name: k.name, ticker: k.ticker });
  await purgeSite(coin);
  return { site: siteView(r.slug, publicSite(), r.events.at(-1)?.at), warm: warm(coin, k, store) };
}

// ---------- the page's data ----------
/** A launch record as the site shows it (public fields only, links built here from the checked mint). */
export function launchFacts(rec, cluster) {
  if (!rec || typeof rec.mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rec.mint)) return null;
  const launchpad = PAD_INFO[rec.launchpad] ? rec.launchpad : 'pumpfun';
  const x = typeof rec.x === 'string' && /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/.test(rec.x) ? rec.x : null;
  return {
    mint: rec.mint,
    cluster,
    launchpad,
    launchpadName: PAD_INFO[launchpad].name,
    currency: rec.currency === 'USDC' ? 'USDC' : 'SOL',
    at: typeof rec.launchedAt === 'string' ? rec.launchedAt : null,
    x,
    pad: padLinkOf(launchpad, rec.mint, cluster),
    graduates: PAD_INFO[launchpad].facts?.graduates ?? null,
    chart: chartOf(rec.mint, cluster),
    explorer: explorerOf(rec.mint, cluster),
  };
}

/**
 * Everything a coin's site shows, for one of its slugs, or null when no coin holds the slug.
 * { slug, canonical, coin, kit, words: { name, ticker, bio }, launch, look, lore, loreWritten }
 */
export async function pageData(slug, opts = {}) {
  const claim = await claimOf(opts.store ?? blobs, slug);
  return claim ? coinPage(claim.coin, slug, opts) : null;
}

/** The same for a coin (by its id), as seen at one of its slugs. */
export async function coinPage(coin, slug, { store = blobs, cluster = siteCluster(), onLater = () => {} } = {}) {
  const [events, latest, rec] = await Promise.all([siteEvents(store, coin), latestVersion(coin).catch(() => null), readLaunch(coin, cluster).catch(() => null)]);
  const launch = launchFacts(rec, cluster);
  const kitId = launch ? (isId(rec.versionId) ? rec.versionId : coin) : currentKit(coin, events, latest);
  const kit = (await readKit(kitId)) || (kitId !== coin ? await readKit(coin) : null);
  if (!kit) return null;
  const words = launch ? { ...kit, name: rec.name || kit.name, ticker: rec.ticker || kit.ticker, bio: typeof rec.bio === 'string' ? rec.bio : kit.bio } : kit;
  const [look0, lore, edits] = await Promise.all([
    lookOf(kit, store).catch((e) => (log({ evt: 'site.look_failed', kit: kit.id, error: errLine(e) }), null)),
    storedLore(coin, words, store),
    latestEdits(store, coin).catch(() => null),
  ]);
  if (!lore) onLater(writeLoreOnce(coin, words, store));
  const main = (launch && slugOfUrl(rec.website, publicSite())) || primaryOf(events) || slug;
  const e = edits || {};
  return {
    slug,
    canonical: siteView(main, publicSite()).url,
    coin,
    kit,
    words: { name: String(words.name || ''), ticker: String(words.ticker || ''), bio: String(words.bio || '') },
    launch,
    look: lookWith(look0, e, kit),
    lore: { ...(lore || fallbackLore(words)), ...pickKeys(e, ['tagline', 'story', 'facts', 'quote']) },
    loreWritten: !!lore || !!e.story,
    sections: e.sections ?? [],
    hide: e.hide ?? [],
    edited: e.at ?? null,
  };
}

const pickKeys = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));
/** A look with the owner's choices over it (a skin, a font, a mode, colours), rebuilt from the art it was read from. */
function lookWith(look, e, kit) {
  if (!look || !look.art || !(e.skin || e.font || e.mode || e.accent || e.background)) return look;
  return cleanLook({ ...buildLook(kit, look.art, { skin: e.skin, font: e.font, mode: e.mode, accent: e.accent, bg: e.background }), art: look.art, logo640: look.logo640 }) || look;
}

// ---------- changes asked for in the chat ----------
/** Does a signed-in person's account hold a chat about this coin? */
async function ownsCoin(sub, coin) {
  const { secret } = authConfig();
  if (!sub || !secret || !hasUsers()) return false;
  const { chats } = await readChats(accountKey(secret, sub));
  return chats.some((c) => c && (c.root === coin || c.kit === coin || (Array.isArray(c.turns) && c.turns.some((t) => Array.isArray(t?.made) && t.made.some((d) => d && (d.root === coin || d.kit === coin))))));
}
/** May this chat change the coin's website? Its site key; for a coin made before the keys, a signed-in owner. */
export async function mayEdit(coin, key, sub, store = blobs) {
  if (keyOk(coin, key)) return true;
  if (await isKeyed(store, coin)) return false;
  return ownsCoin(sub, coin).catch(() => false);
}

/**
 * A message in a coin's chat that talks about its website (api/make.js). The editor changes the site, or says the
 * message is about the coin itself: { coin: true, usd } (the maker takes it). Otherwise { reply, site, usd }.
 * current: make.js's coin as it stands ({ id, root, sentence, ... }); key: the chat's site key; sub: the signed-in
 * person, if any; owned: the chat holds the coin's edit token (make.js checked it).
 */
export async function siteTurn({ current, message, key, sub, owned = false, store = blobs, cluster = siteCluster() }) {
  const coin = current.root;
  const [kit, rec, events] = await Promise.all([readKit(current.id), readLaunch(coin, cluster).catch(() => null), siteEvents(store, coin)]);
  if (!kit) return { coin: true, usd: 0 };
  const words = rec?.mint ? { ...kit, name: rec.name || kit.name, ticker: rec.ticker || kit.ticker, bio: rec.bio ?? kit.bio } : kit;
  const [look0, lore, edits] = await Promise.all([lookOf(kit, store).catch(() => null), storedLore(coin, words, store), latestEdits(store, coin).catch(() => null)]);
  const e = edits || {};
  const ctx = {
    words: { name: words.name, ticker: words.ticker, bio: words.bio },
    sentence: kit.sentence,
    look: lookWith(look0, e, kit),
    lore: { ...(lore || fallbackLore(words)), ...pickKeys(e, ['tagline', 'story', 'facts', 'quote']) },
    edits: e,
  };
  const r = await askEditor(ctx, message);
  if (r.edit?.route === 'coin') return { coin: true, usd: r.usd };
  const site = siteView(primaryOf(events) || (await siteOf(coin, { store, cluster }))?.slug, publicSite(), e.at ?? events.at(-1)?.at);
  if (!r.edit) return { reply: "i couldn't make that change to the website. try saying it another way.", site, usd: r.usd };
  if (!owned && !(await mayEdit(coin, key, sub, store))) return { reply: 'only the chat that made this coin can change its website. a coin made here comes with its own.', site, usd: r.usd };
  if (!Object.keys(r.edit.changes).length) return { reply: r.edit.reply, site, usd: r.usd };
  const snap = await saveEdits(store, coin, edits, r.edit.changes);
  await purgeSite(coin);
  log({ evt: 'site.edit', coin, fields: Object.keys(r.edit.changes) });
  return { reply: r.edit.reply, site: site && { ...site, rev: snap.at }, usd: r.usd, edited: true };
}

// ---------- the live numbers ----------
const markets = new Map(); // cluster -> { m, rpc }
function reader(cluster) {
  if (!markets.has(cluster)) {
    const s = settingsFromEnv();
    const rpc = new Connection(s.cluster === cluster ? s.rpcUrl : PUBLIC_RPC[cluster], 'confirmed');
    markets.set(cluster, { rpc, m: createMarket({ rpc, cluster, log }) });
  }
  return markets.get(cluster);
}
const supplies = new Map(); // mint -> { at, v }
// the default public RPC won't answer getTokenSupply without a key (checked 2026-11-02); Solana's own public one does
const SUPPLY_RPC = { mainnet: 'https://api.mainnet-beta.solana.com', devnet: 'https://api.devnet.solana.com' };
const spare = new Map();
async function supplyOf(rpc, mint, cluster) {
  const hit = supplies.get(mint);
  if (hit && Date.now() - hit.at < 600_000) return hit.v;
  const ask = (c) => c.getTokenSupply(new PublicKey(mint), 'confirmed');
  const r = await ask(rpc).catch(() => {
    if (!spare.has(cluster)) spare.set(cluster, new Connection(SUPPLY_RPC[cluster], 'confirmed'));
    return ask(spare.get(cluster));
  });
  const v = Number(r?.value?.uiAmount);
  const out = Number.isFinite(v) && v > 0 ? v : null;
  supplies.set(mint, { at: Date.now(), v: out });
  return out;
}
/** A launched coin's market (market.js) and its supply, read now; whatever doesn't answer in time stays null. */
export async function liveOf(launch, { timeoutMs = 2500 } = {}) {
  if (!launch) return { market: null, supply: null };
  const { m, rpc } = reader(launch.cluster);
  const late = (p) => Promise.race([p.catch(() => null), new Promise((r) => setTimeout(() => r(null), timeoutMs))]);
  const [mk, supply] = await Promise.all([late(m.read([{ id: 'coin', mint: launch.mint, launchpad: launch.launchpad }])), late(supplyOf(rpc, launch.mint, launch.cluster))]);
  const market = mk?.coin ?? null;
  if (market) market.chart = chartOf(launch.mint, launch.cluster, market.pairUrl);
  return { market, supply };
}
