// Storage: the public Vercel Blob store "wagbi-kits" (BLOB_READ_WRITE_TOKEN, added when the store was
// connected to the project). Public so the PNGs load straight from the Blob CDN; every path carries a random
// id, so nothing can be guessed, and list() needs the token.
//   kits/<id>/kit.json, logo.png, banner.png, logo.svg, banner.svg   written once, never overwritten
//   meta/ip/<hour>/<ip hash>/<ms>-<id>                               one per kit, for the hourly limit per IP
//   meta/spend/<day>/<id>_<micro $>  (_r<micro $> while it runs)     one per call, for the daily cap
//   (previews count theirs under meta/spend-preview/: they share this store, and testing one must not use up
//   the live site's day)
// Blob has no counters, so both limits count objects. Nothing here is ever read back as code.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { del, get, head, list, put } from '@vercel/blob';

const token = () => process.env.BLOB_READ_WRITE_TOKEN?.trim() || undefined;
export const hasStore = () => !!token();

export const newId = () => randomBytes(12).toString('base64url');
export const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{16}$/.test(v);

const YEAR = 31_536_000;
async function write(path, body, contentType) {
  const r = await put(path, body, { access: 'public', token: token(), contentType, addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: YEAR });
  return r.url;
}

async function names(prefix) {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000, token: token() });
    for (const b of page.blobs) out.push(b.pathname.slice(prefix.length));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// ---------- kits ----------

/** Stores a finished kit (images first, the json last, so a kit.json means the whole kit is there). */
export async function saveKit(id, kit, model, thread = null) {
  const base = `kits/${id}/`;
  // a picture a follow-up kept is not stored again: the new version points at the same files
  const pic = (t, ext, type, body) => (kit[t].reuse?.[ext] ? kit[t].reuse[ext] : write(`${base}${t}.${ext}`, body, type));
  const [logo, banner, logoSvg, bannerSvg] = await Promise.all([
    pic('logo', 'png', 'image/png', kit.logo.png && Buffer.from(kit.logo.png)),
    pic('banner', 'png', 'image/png', kit.banner.png && Buffer.from(kit.banner.png)),
    pic('logo', 'svg', 'image/svg+xml', kit.logo.svg),
    pic('banner', 'svg', 'image/svg+xml', kit.banner.svg),
  ]);
  const json = { v: 1, id, sentence: kit.sentence, name: kit.name, ticker: kit.ticker, bio: kit.bio, style: kit.style, dither: kit.dither ?? null, logo, banner, logoSvg, bannerSvg, model, made: new Date().toISOString() };
  if (thread) {
    // a version in a coin's conversation: which coin (the first kit's id), which version, made from which, by what
    // ask. The version number is claimed first (write-once); two follow-ups at once take the next free one.
    let version = thread.version;
    while (!(await putVersion(thread.root, version, { kitId: id, ask: thread.ask ?? null, parent: thread.parent ?? null, at: json.made }))) {
      if (++version > thread.version + 20) throw new Error('no free version number');
    }
    Object.assign(json, { root: thread.root, version, parent: thread.parent ?? null, ask: thread.ask ?? null });
    // a later version is marked, so the coins tab lists each coin once (by its first kit)
    if (version > 1) await write(`vers/${id}`, thread.root, 'text/plain');
  }
  await write(base + 'kit.json', JSON.stringify(json), 'application/json');
  return json;
}

// ---------- a coin's conversation: one write-once pointer per version ----------
//   convos/<root kit id>/<00001>.json   { kitId, ask, parent, at }   version 1 is the first kit

const pad5 = (n) => String(n).padStart(5, '0');
/** Records a version. False when that version number is already taken (two follow-ups at once). */
export async function putVersion(root, version, entry) {
  try {
    await write(`convos/${root}/${pad5(version)}.json`, JSON.stringify({ version, ...entry }), 'application/json');
    return true;
  } catch (e) {
    if (/exist/i.test(String(e?.message ?? ''))) return false;
    throw e;
  }
}

/** A coin's versions in order: [{ version, kitId, ask, parent, at }]. A kit made before conversations is version 1 alone. */
export async function versionsOf(root) {
  const page = await list({ prefix: `convos/${root}/`, limit: 1000, token: token() });
  const items = await Promise.all(
    page.blobs
      .filter((b) => /\/\d{5}\.json$/.test(b.pathname))
      .map(async (b) => {
        const r = await fetch(b.url);
        return r.ok ? r.json() : null;
      }),
  );
  const out = items.filter(Boolean).sort((a, b) => a.version - b.version);
  return out.length ? out : [{ version: 1, kitId: root, ask: null, parent: null, at: null }];
}

/** Every version pointer of every coin (for the coins tab): root -> [{ version, kitId, at }], from the paths alone. */
export async function allVersions() {
  const out = new Map();
  let cursor;
  do {
    const page = await list({ prefix: 'convos/', cursor, limit: 1000, token: token() });
    for (const b of page.blobs) {
      const m = /^convos\/([A-Za-z0-9_-]{16})\/(\d{5})\.json$/.exec(b.pathname);
      if (!m) continue;
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push({ version: Number(m[2]), url: b.url, at: new Date(b.uploadedAt).toISOString() });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  for (const v of out.values()) v.sort((a, b) => a.version - b.version);
  return out;
}

export async function readKit(id) {
  const r = await get(`kits/${id}/kit.json`, { access: 'public', token: token() }).catch((e) => {
    if (e?.name === 'BlobNotFoundError') return null;
    throw e;
  });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}

// ---------- the maker's kits (2026-11-02): two designs a turn, painted by an image model ----------
//   kits/<id>/logo.png (1024), thumb.webp (256), banner.jpg (1500 x 500), kit.json       v 2, written once
//   refs/<content hash>.jpg     an original picture of a meme found on the web (the same picture is one file)
//   uploads/<random id>.jpg     a picture someone attached (checked and re-encoded first)
// A turn's two kits share a version: convos/<root>/<n>.json is { kitId: design A, alt: design B, ask, parent, at }.
// Every kit that isn't the coin's first gets a vers/ marker, so the coins tab lists each coin once.

/** This store's public host (the pictures the image model reads must be ours). */
export function storeHost() {
  const id = (token() || '').split('_')[3] || '';
  return id ? `${id.toLowerCase()}.public.blob.vercel-storage.com` : null;
}

/** Stores a reference picture once, by its content: answers its public URL. c: { hash, data } */
export async function putRef(c) {
  if (!/^[0-9a-f]{16,64}$/.test(c?.hash || '')) throw new Error('bad ref hash');
  const path = `refs/${c.hash}.jpg`;
  try {
    return await write(path, c.data, 'image/jpeg');
  } catch (e) {
    if (!/exist/i.test(String(e?.message ?? ''))) throw e;
    const host = storeHost();
    if (!host) throw e;
    return `https://${host}/${path}`;
  }
}

/** Stores an attached picture (already checked and re-encoded): { id, url }. */
export async function putUpload(data) {
  const id = newId();
  return { id, url: await write(`uploads/${id}.jpg`, data, 'image/jpeg') };
}

/** An attachment URL this site stored (uploads/<id>.jpg on this store), else null. */
export function uploadUrl(v) {
  const host = storeHost();
  const m = /^https:\/\/([a-z0-9.-]+)\/uploads\/([A-Za-z0-9_-]{16})\.jpg$/.exec(String(v || ''));
  return m && host && m[1] === host ? m[0] : null;
}

/**
 * Stores a turn: one kit per design that came out, a version number claimed for the turn (write-once, the next free
 * one when two turns land at once), and the markers. designs[i]: { id, name, ticker, bio, angle, logo, banner, refs,
 * prompts } where logo/banner are { files } (painted now) or { keep, url, thumb } (the version before's).
 * thread: { root (null for a new coin), version, parent, ask, line }. Answers the stored kits.
 */
export async function saveTurn(designs, thread, { sentence, model, character = null, note = null, trace = null, editHash = null } = {}) {
  const root = thread.root || designs[0].id;
  const made = new Date().toISOString();
  let version = thread.version;
  while (!(await putVersion(root, version, { kitId: designs[0].id, alt: designs[1]?.id ?? null, ask: thread.ask ?? null, parent: thread.parent ?? null, at: made }))) {
    if (++version > thread.version + 20) throw new Error('no free version number');
  }
  const kits = await Promise.all(designs.map(async (d, i) => {
    const base = `kits/${d.id}/`;
    const [logo, thumb, banner, bannerArt] = await Promise.all([
      d.logo.keep ? d.logo.url : write(base + 'logo.png', d.logo.files.png, 'image/png'),
      d.logo.keep ? d.logo.thumb || d.logo.url : write(base + 'thumb.webp', d.logo.files.thumb, 'image/webp'),
      d.banner.keep ? d.banner.url : write(base + 'banner.jpg', d.banner.files.jpg, 'image/jpeg'),
      // the banner's painting before its name was set in type (a new name is set again on it, nothing repainted)
      d.banner.keep ? d.banner.artUrl ?? null : d.banner.files?.art && d.banner.files?.title ? write(base + 'banner-art.jpg', d.banner.files.art, 'image/jpeg') : null,
    ]);
    const other = designs[1 - i];
    const json = {
      v: 2, id: d.id, sentence, name: d.name, ticker: d.ticker, bio: d.bio, style: d.angle, angle: d.angle,
      logo, thumb, banner, model, made,
      root, version, parent: thread.parent ?? null, ask: thread.ask ?? null, line: [...(thread.line || []), ...(thread.parent ? [thread.parent] : [])].slice(-40),
      design: i === 0 ? 'a' : 'b', pair: other ? { id: other.id, name: other.name, ticker: other.ticker, angle: other.angle } : null,
      character, refs: d.refs || [], prompts: d.prompts || null, art: { logo: d.logo.model ?? null, banner: d.banner.model ?? null }, note, trace,
      // the art direction (art.js) and how the banner's name is set in type on bannerArt (type.js), when it is
      direction: d.direction ?? null, bannerArt, title: bannerArt ? d.title ?? null : null,
      // who may add versions to this coin: the hash of the edit token its maker's page holds (make.js)
      ...(editHash ? { edit: editHash } : {}),
    };
    return json;
  }));
  // a kit made on a preview or a local run is marked first, so the live site's coins tab never lists it
  if (!isLive()) await Promise.all(kits.map((k) => write(`pv/${k.id}`, String(process.env.VERCEL_ENV || 'dev'), 'text/plain').catch(() => {})));
  // the json last: a kit.json means the whole kit is there
  await Promise.all(kits.map((k) => write(`kits/${k.id}/kit.json`, JSON.stringify(k), 'application/json')));
  await Promise.all(kits.filter((k) => k.id !== root).map((k) => write(`vers/${k.id}`, root, 'text/plain').catch(() => {})));
  return kits;
}

/** The hash a kit keeps of its coin's edit token (make.js): who holds the token may add versions to the coin. */
export const editHashOf = (token) => createHash('sha256').update(`wagbi-edit|${token}`).digest('hex').slice(0, 32);

/** This deployment is the live site (previews and local runs share the kits store, and their test coins stay theirs). */
export const isLive = () => process.env.VERCEL_ENV === 'production';

/** Kit ids made on previews or local runs (the live coins tab leaves them out). */
export async function previewKitIds() {
  const out = new Set();
  for (const b of await blobsUnder('pv/')) {
    const m = /^pv[/]([A-Za-z0-9_-]{16})$/.exec(b.pathname);
    if (m) out.add(m[1]);
  }
  return out;
}

// ---------- a turn's outcome, for a page that lost the stream (a reload, a phone that slept) ----------
//   turns/<first kit id>.json   { ok, reply, kits: [ids], code?, error?, at }   written once when the turn ends
// The id is the turn's first kit id: random, sent only to the page that asked, so nobody else can find it.

/** Records how a turn ended. Never throws (a page that kept its stream doesn't need it). */
export async function putTurn(id, rec) {
  if (!isId(id)) return;
  await write(`turns/${id}.json`, JSON.stringify({ ...rec, at: new Date().toISOString() }), 'application/json').catch(() => {});
}

/** How a turn ended, or null while it runs (or if it never started). */
export async function readTurn(id) {
  if (!isId(id)) return null;
  const r = await get(`turns/${id}.json`, { access: 'public', token: token(), useCache: false }).catch((e) => {
    if (e?.name === 'BlobNotFoundError') return null;
    throw e;
  });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}

// ---------- the hourly limit per IP ----------

const HOUR = 3600_000;
const hourKey = (t) => new Date(t).toISOString().slice(0, 13).replace(/\D/g, '');
// a keyed hash: enough to count one visitor's kits, useless for finding anyone
const ipHash = (ip) => createHmac('sha256', process.env.WAGBI_SALT?.trim() || token() || 'wagbi-local').update(String(ip)).digest('base64url').slice(0, 22);

/** Kits this IP started in the last hour (sliding: this hour's folder and the last one's). */
export async function recentByIp(ip, now = Date.now()) {
  const h = ipHash(ip);
  const lists = await Promise.all([now, now - HOUR].map((t) => names(`meta/ip/${hourKey(t)}/${h}/`)));
  return lists.flat().filter((n) => now - Number(n.split('-')[0]) < HOUR).length;
}

export const markIp = (ip, id, now = Date.now()) => write(`meta/ip/${hourKey(now)}/${ipHash(ip)}/${now}-${id}`, '1', 'text/plain');

// ---------- the daily spend cap ----------

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const SPEND = process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production' ? `meta/spend-${process.env.VERCEL_ENV}` : 'meta/spend';
const micro = (usd) => Math.max(0, Math.round(usd * 1e6));

/** $ spent today (UTC), calls still running counted at their worst case. */
export async function spentToday() {
  return (await spendToday()).total;
}

/**
 * Today's spend (UTC), apart: { settled (what finished calls really cost), held (the worst cases of calls still
 * running), total, voice (the transcriptions' part of the total: their ids start with "t") }.
 */
export async function spendToday() {
  const out = { settled: 0, held: 0, total: 0, voice: 0 };
  for (const n of await names(`${SPEND}/${day()}/`)) {
    const m = /_(r?)(\d+)$/.exec(n);
    if (!m) continue;
    const usd = Number(m[2]) / 1e6;
    if (m[1]) out.held += usd;
    else out.settled += usd;
    if (n.startsWith('t')) out.voice += usd;
  }
  out.total = out.settled + out.held;
  return out;
}

/**
 * Whether a call that may cost up to `worst` can start under the daily cap: 'ok', 'busy' (only the worst cases of
 * the calls running now stand in the way: they settle for much less, so it frees up in a minute or two) or
 * 'resting' (what was really spent today leaves no room: back tomorrow).
 */
export function capCheck(spend, worst, cap) {
  if (spend.total + worst <= cap) return 'ok';
  return spend.settled + worst > cap ? 'resting' : 'busy';
}

/** Holds a running call's worst case against the cap. Returns the day it was held on. */
export async function hold(id, usd) {
  const d = day();
  await write(`${SPEND}/${d}/${id}_r${micro(usd)}`, '1', 'text/plain');
  return d;
}

/** Swaps the hold for what the call really cost. */
export async function settle(id, d, heldUsd, usd) {
  await write(`${SPEND}/${d}/${id}_${micro(usd)}`, '1', 'text/plain');
  await del(`${SPEND}/${d}/${id}_r${micro(heldUsd)}`, { token: token() }).catch(() => {});
}

// ---------- launches (api/launch) ----------
//   meta/<16 hex>.json                 a coin's metadata, content addressed: the link create_v2 carries
//   launches/<kitId>.json              a launched coin, public: its mint, its locked split (devnet test
//   launches/devnet/<kitId>.json       launches in their own folder, so they never block a real one)

/** Stores a coin's metadata once and answers its public link (the same link if it was already there). */
export async function putMeta(name, json, kit) {
  if (!/^[0-9a-f]{16}$/.test(name)) throw new Error('bad metadata name');
  try {
    return await write(`meta/${name}.json`, json, 'application/json');
  } catch (e) {
    if (!/exist/i.test(String(e?.message ?? ''))) throw e;
    return `${new URL(kit.logo).origin}/meta/${name}.json`;
  }
}

const launchPath = (kitId, cluster) => (cluster === 'devnet' ? `launches/devnet/${kitId}.json` : `launches/${kitId}.json`);

/** A launched coin's public record, read from the origin (never a cached miss), or null. */
export async function readLaunch(kitId, cluster) {
  const r = await get(launchPath(kitId, cluster), { access: 'public', token: token(), useCache: false }).catch((e) => {
    if (e?.name === 'BlobNotFoundError') return null;
    throw e;
  });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}

/** Writes a launched coin's record once. A second write (a resumed run) is a no-op. */
export async function writeLaunch(rec) {
  try {
    await write(launchPath(rec.kitId, rec.cluster), JSON.stringify(rec), 'application/json');
  } catch (e) {
    if (!/exist/i.test(String(e?.message ?? ''))) throw e;
  }
}

// ---------- the coins tab (api/coins) ----------

async function blobsUnder(prefix) {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000, token: token() });
    out.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** Every stored kit, newest first: { id, url, at }. Lists the kits folder (5 objects a kit). */
export async function kitEntries() {
  const out = [];
  for (const b of await blobsUnder('kits/')) {
    const m = /^kits\/([A-Za-z0-9_-]{16})\/kit\.json$/.exec(b.pathname);
    if (m) out.push({ id: m[1], url: b.url, at: new Date(b.uploadedAt).toISOString() });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** The launched coins of one cluster: kit id -> the record's public url. */
export async function launchEntries(cluster) {
  const prefix = cluster === 'devnet' ? 'launches/devnet/' : 'launches/';
  const out = new Map();
  for (const b of await blobsUnder(prefix)) {
    const m = new RegExp(`^${prefix}([A-Za-z0-9_-]{16})\.json$`).exec(b.pathname);
    if (m) out.set(m[1], b.url);
  }
  return out;
}

/** The launched coins of one cluster, newest launch first: [{ kitId, url, at }] (`at`: when the record was written,
 *  which is the moment the launch read back live from the chain). */
export async function launchList(cluster) {
  const prefix = cluster === 'devnet' ? 'launches/devnet/' : 'launches/';
  const re = new RegExp(`^${prefix}([A-Za-z0-9_-]{16})\\.json$`);
  const out = [];
  for (const b of await blobsUnder(prefix)) {
    const m = re.exec(b.pathname);
    if (m) out.push({ kitId: m[1], url: b.url, at: new Date(b.uploadedAt).toISOString() });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Kit ids that are later versions of a coin (not a coin of their own). */
export async function laterVersionIds() {
  const out = new Set();
  for (const b of await blobsUnder('vers/')) {
    const m = /^vers[/]([A-Za-z0-9_-]{16})$/.exec(b.pathname);
    if (m) out.add(m[1]);
  }
  return out;
}

/** A coin's newest version pointer: { version, kitId, at (ms) }, or null for a coin from before conversations. */
export async function latestVersion(root) {
  const page = await list({ prefix: `convos/${root}/`, limit: 1000, token: token() });
  const last = page.blobs.filter((b) => /\/\d{5}\.json$/.test(b.pathname)).sort((a, b) => (a.pathname < b.pathname ? 1 : -1))[0];
  if (!last) return null;
  const r = await fetch(`${last.url}?v=${new Date(last.uploadedAt).getTime()}`);
  const j = r.ok ? await r.json() : null;
  return j && isId(j.kitId) ? { version: j.version, kitId: j.kitId, at: Date.parse(j.at) || new Date(last.uploadedAt).getTime() } : null;
}

// ---------- the coins' websites (sites.js, api/site.js) ----------
//   sites/slugs/<slug>.json                  { v, slug, coin, kit, at }  the claim: write-once, first come keeps it
//   sites/coins/<coin>/<ms>_<kit id>_<slug>  the coin's site each time it changed (a turn, a pick, a launch)
//   sites/keyed/<coin>                       the coin was made with a site key: a pick needs it
//   sites/looks/<kit id>.json, .webp         the look read from a kit's art, and its logo at 640 px
//   sites/lore/<coin>/<words hash>.json      the lore, written once for each name a coin has
// Everything is written once. Blob's CDN can keep a miss for a moment (a URL read before it existed answers 404 for
// a while after), so a miss that matters is checked again with the API before it counts.

/** The primitives the sites module works with (tests hand it an in-memory stand-in with the same shape). */
export const blobs = {
  /** Writes once: the object's public URL, or null when the path is already taken. */
  async create(path, body, contentType) {
    try {
      return await write(path, body, contentType);
    } catch (e) {
      if (/exist/i.test(String(e?.message ?? ''))) return null;
      throw e;
    }
  },
  /** An object written once, as JSON (read past a cached miss), or null. */
  async json(path) {
    const host = storeHost();
    if (host) {
      const r = await fetch(`https://${host}/${path}`);
      if (r.ok) return r.json();
      if (r.status !== 404) throw new Error(`blob ${r.status}`);
    }
    const h = await blobs.head(path);
    if (!h) return null;
    const r = await fetch(`${h.url}?v=${h.at}`);
    return r.ok ? r.json() : null;
  },
  /** { url, at } of an object, from the API (never a cached miss), or null. */
  async head(path) {
    try {
      const h = await head(path, { token: token() });
      return { url: h.url, at: new Date(h.uploadedAt).getTime() };
    } catch (e) {
      // (the library's not-found error carries no name of its own: its class or its words tell it)
      if (e?.name === 'BlobNotFoundError' || e?.constructor?.name === 'BlobNotFoundError' || /does not exist|not found/i.test(String(e?.message ?? ''))) return null;
      throw e;
    }
  },
  /** Every object under a prefix: [{ path, url, at }]. */
  async list(prefix) {
    return (await blobsUnder(prefix)).map((b) => ({ path: b.pathname, url: b.url, at: new Date(b.uploadedAt).getTime() }));
  },
};
