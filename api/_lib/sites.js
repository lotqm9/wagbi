// Every coin gets its own website on the brand's domain, at a clean path: wagbi.fun/<slug>. This module names them
// and keeps track of them (api/site.js draws the page, looks.js reads the art, lore.js writes the story).
//   slug    the coin's name, lowercase letters and digits only: "pepe bank" -> pepebank. The first coin to claim a
//           name keeps it; the next gets a dash and a number (pepebank-2). Never an app path or a reserved word.
//   claim   sites/slugs/<slug>.json, written once: Blob refuses a second write of a path, which is the lock.
//   events  sites/coins/<coin>/<ms>_<kit>_<slug>, one each time the coin's site changed: a turn in its chat (the
//           chat moves to that turn's first design), a design picked, a launch. The newest says which design the
//           site shows and which slug is its main one. A coin keeps every slug it ever had: a shared link keeps working.
//   key     a pick changes what a coin's site shows, so it needs the coin's key: a keyed hash of the coin's id that
//           only the chat that made the coin was given (api/make.js). Coins made before the keys take any pick.
// `store` is store.js's blobs (or a stand-in in the tests): { create, json, head, list }.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { addCacheTag, dangerouslyDeleteByTag } from '@vercel/functions';
import { BRAND } from './brand.js';

export const MAX_BASE = 30;
/** A coin claims a new slug only when its name changes; past this many it keeps its newest. */
export const MAX_SLUGS = 6;

// the app's own paths and files, the words a visitor could mistake for the site's own pages, and the brand's names
const RESERVED = new Set([
  // app paths (vercel.json) and static folders
  'api', 'coin', 'coins', 'k', 'kit', 'kits', 'example', 'examples', 'privacy', 'terms', 'tool', 'tools', 'img', 'vendor',
  'test', 'tests', 'coinsite', 'index', 'og', 'brand', 'fonts', 'static', 'assets', 'public', 'site', 'sites', 'files',
  'uploads', 'upload', 'refs', 'meta', 'convos', 'vers', 'launches', 'looks', 'lore', 'slugs', 'keyed',
  // what a visitor would read as the brand's own page
  'admin', 'administrator', 'root', 'system', 'official', 'team', 'staff', 'support', 'help', 'helpdesk', 'contact',
  'about', 'faq', 'docs', 'doc', 'blog', 'news', 'press', 'status', 'health', 'security', 'legal', 'tos', 'policy',
  'cookies', 'careers', 'jobs', 'home', 'start', 'new', 'make', 'create', 'launch', 'launchpad', 'launchpads', 'deposit',
  'deposits', 'refund', 'refunds', 'withdraw', 'claim', 'claims', 'airdrop', 'presale', 'wallet', 'wallets', 'account',
  'accounts', 'settings', 'profile', 'dashboard', 'login', 'logout', 'signin', 'signout', 'signup', 'register', 'auth',
  'oauth', 'chat', 'chats', 'token', 'tokens', 'market', 'markets', 'chart', 'charts', 'trade', 'swap', 'buy', 'sell',
  'fees', 'fee', 'search', 'explore', 'trending', 'top', 'feed', 'app', 'apps', 'dev', 'developer', 'developers',
  'preview', 'staging', 'beta', 'demo', 'cdn', 'www', 'mail', 'email', 'robots', 'sitemap', 'favicon', 'manifest',
  'well-known', 'null', 'undefined', 'true', 'false', 'none', 'unnamed', 'ca', 'contract', 'x', 'twitter', 'telegram',
  'discord', 'pump', 'pumpfun', 'raydium', 'meteora', 'bags', 'bonk', 'letsbonk', 'moonit', 'solana', 'dexscreener',
]);
// and the brand's own names (brand.js)
for (const w of [BRAND.id, BRAND.name, BRAND.ticker]) {
  const b = squash(w);
  if (b) RESERVED.add(b);
}

/** Letters and digits only, lowercase, accents folded ("Pokémon 2.0" -> pokemon20). */
function squash(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/þ/g, 'th')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** The slug a name asks for, before any collision: its letters and digits (the ticker when it has none). */
export function slugBase(name, ticker) {
  let b = squash(name).slice(0, MAX_BASE) || squash(ticker).slice(0, MAX_BASE) || 'coin';
  if (b.length < 3 || RESERVED.has(b)) b = `${b}coin`;
  if (RESERVED.has(b)) b = `${b}x`;
  return b;
}

/** What a site path can be: a base, or a base and a collision suffix after one dash. */
export const isSlug = (s) => typeof s === 'string' && s.length <= 40 && /^[a-z0-9]{3,32}(?:-[a-z0-9]{1,4})?$/.test(s);
export const baseOf = (slug) => slug.split('-')[0];
export const isReserved = (slug) => RESERVED.has(slug) || RESERVED.has(baseOf(slug));

/** The slugs to try, in order: the base, then base-2 ... base-9, then a few short random ones. */
export function* candidates(base, rand = Math.random) {
  yield base;
  for (let n = 2; n <= 9; n++) yield `${base}-${n}`;
  for (let i = 0; i < 6; i++) yield `${base}-${Math.floor(rand() * 36 ** 3).toString(36).padStart(3, '0')}`;
}

export const slugPath = (slug) => `sites/slugs/${slug}.json`;
const EVENT = /^sites\/coins\/([A-Za-z0-9_-]{16})\/(\d{13})_([A-Za-z0-9_-]{16})_([a-z0-9-]{3,40})$/;
const eventPath = (coin, at, kit, slug) => `sites/coins/${coin}/${String(Math.floor(at)).padStart(13, '0')}_${kit}_${slug}`;
const ID = /^[A-Za-z0-9_-]{16}$/;

/** One event from its path: { coin, at, kit, slug }, or null. */
export function parseEvent(path) {
  const m = EVENT.exec(path);
  return m && isSlug(m[4]) ? { coin: m[1], at: Number(m[2]), kit: m[3], slug: m[4] } : null;
}
const byAt = (a, b) => a.at - b.at || (a.slug < b.slug ? -1 : 1);

/** A coin's site events, oldest first. */
export async function siteEvents(store, coin) {
  return (await store.list(`sites/coins/${coin}/`)).map((b) => parseEvent(b.path)).filter(Boolean).sort(byAt);
}

/** Every coin's site events (the coins tab): coin -> events, oldest first. */
export async function allSiteEvents(store) {
  const out = new Map();
  for (const b of await store.list('sites/coins/')) {
    const e = parseEvent(b.path);
    if (!e) continue;
    if (!out.has(e.coin)) out.set(e.coin, []);
    out.get(e.coin).push(e);
  }
  for (const v of out.values()) v.sort(byAt);
  return out;
}

/** The slugs a coin holds, in the order it got them. */
export const slugsOf = (events) => [...new Set(events.map((e) => e.slug))];
/** The slug a coin's site goes by now: its newest event's. */
export const primaryOf = (events) => events.at(-1)?.slug ?? null;

/** Who holds a slug: its claim, or null. */
export async function claimOf(store, slug) {
  if (!isSlug(slug)) return null;
  const c = await store.json(slugPath(slug));
  return c && ID.test(c.coin) ? c : null;
}

/** Claims the first free slug for a base: the slug (one this coin already holds counts as free). */
export async function claimSlug(store, { base, coin, kit, now = Date.now(), rand }) {
  for (const slug of candidates(base, rand)) {
    if (isReserved(slug)) continue;
    const rec = { v: 1, slug, coin, kit, at: new Date(now).toISOString() };
    if (await store.create(slugPath(slug), JSON.stringify(rec), 'application/json')) return slug;
    const held = await claimOf(store, slug);
    if (held && held.coin === coin) return slug;
  }
  throw new Error(`no free slug for ${base}`);
}

/**
 * Puts a design on its coin's site: claims a slug for its name when the coin has none for that name yet, and records
 * the change. coin: the coin's id (its first kit's); kit: the design the site shows from now; name/ticker: its words
 * (a launch's own, when the launch renamed it). Answers { slug, fresh, events }.
 */
export async function ensureSite(store, { coin, kit, name, ticker, now = Date.now(), events = null, rand }) {
  if (!ID.test(coin) || !ID.test(kit)) throw new Error('bad coin or kit id');
  const evs = events ?? (await siteEvents(store, coin));
  const base = slugBase(name, ticker);
  const mine = slugsOf(evs);
  let slug = mine.find((s) => baseOf(s) === base) ?? null;
  if (!slug && mine.length >= MAX_SLUGS) slug = primaryOf(evs);
  let fresh = false;
  if (!slug) {
    slug = await claimSlug(store, { base, coin, kit, now, rand });
    fresh = !mine.includes(slug);
  }
  const last = evs.at(-1);
  if (!last || last.slug !== slug || last.kit !== kit) {
    const at = Math.max(now, (last?.at ?? 0) + 1);
    await store.create(eventPath(coin, at, kit, slug), kit, 'text/plain');
    evs.push({ coin, at, kit, slug });
  }
  return { slug, fresh, events: evs };
}

/**
 * The design a coin's site shows: the newest of its site events and its chat's newest turn (whose first design the
 * chat moves to). latest: store.js latestVersion(coin) -> { kitId, at } | null.
 */
export function currentKit(coin, events, latest) {
  const ev = events.at(-1);
  if (latest && (!ev || latest.at > ev.at)) return latest.kitId;
  return ev?.kit ?? coin;
}

// ---------- the key that lets a chat change its coin's site ----------
const secret = () => process.env.WAGBI_SITE_SECRET?.trim() || process.env.WAGBI_SALT?.trim() || process.env.BLOB_READ_WRITE_TOKEN?.trim() || `${BRAND.id}-local`;
/** The key for a coin (given to the chat that made it). */
export const siteKey = (coin) => createHmac('sha256', secret()).update(`${BRAND.id}-site:${coin}`).digest('base64url').slice(0, 24);
export function keyOk(coin, key) {
  if (typeof key !== 'string' || key.length !== 24) return false;
  const a = Buffer.from(siteKey(coin));
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const keyedPath = (coin) => `sites/keyed/${coin}`;
/** Marks a new coin as made with a key (from then on a pick needs it). */
export const markKeyed = (store, coin) => store.create(keyedPath(coin), '1', 'text/plain');
export const isKeyed = async (store, coin) => !!(await store.head(keyedPath(coin)));

// ---------- the addresses ----------
/** A site's path on this deployment ("/pepebank"), and its address on the brand's domain. */
export const sitePath = (slug) => `/${slug}`;
export const siteUrl = (publicSite, slug) => `${publicSite || BRAND.site}/${slug}`;
/** The slug in one of our site addresses (a launch's website), or null. */
export function slugOfUrl(url, publicSite) {
  const base = publicSite || BRAND.site;
  if (typeof url !== 'string' || !url.startsWith(`${base}/`)) return null;
  const s = url.slice(base.length + 1);
  return isSlug(s) ? s : null;
}
/** What the page and the API say about a site: { slug, path, url, rev } (rev: when it last changed, ms). */
export const siteView = (slug, publicSite, rev = null) => (slug ? { slug, path: sitePath(slug), url: siteUrl(publicSite, slug), rev: Number.isFinite(rev) ? rev : null } : null);

// ---------- the edge cache ----------
export const siteTag = (coin) => `site-${coin}`;
/** Drops a coin's cached page everywhere, so the next visit draws it fresh. */
// (the runtime's calls may answer a promise or nothing at all, and neither must ever stop a page)
export const purgeSite = (coin) => Promise.resolve().then(() => dangerouslyDeleteByTag(siteTag(coin))).catch((e) => console.log(JSON.stringify({ evt: 'site.purge_failed', coin, error: String(e?.message ?? e).slice(0, 200) })));
export const tagSite = (coin) => Promise.resolve().then(() => addCacheTag(siteTag(coin))).catch(() => {});
