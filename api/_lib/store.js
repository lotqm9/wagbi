// Storage: the public Vercel Blob store "wagbi-kits" (BLOB_READ_WRITE_TOKEN, added when the store was
// connected to the project). Public so the PNGs load straight from the Blob CDN; every path carries a random
// id, so nothing can be guessed, and list() needs the token.
//   kits/<id>/kit.json, logo.png, banner.png, logo.svg, banner.svg   written once, never overwritten
//   meta/ip/<hour>/<ip hash>/<ms>-<id>                               one per kit, for the hourly limit per IP
//   meta/spend/<day>/<id>_<micro $>  (_r<micro $> while it runs)     one per call, for the daily cap
// Blob has no counters, so both limits count objects. Nothing here is ever read back as code.
import { createHmac, randomBytes } from 'node:crypto';
import { del, get, list, put } from '@vercel/blob';

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
const micro = (usd) => Math.max(0, Math.round(usd * 1e6));

/** $ spent today (UTC), calls still running counted at their worst case. */
export async function spentToday() {
  let total = 0;
  for (const n of await names(`meta/spend/${day()}/`)) {
    const m = /_r?(\d+)$/.exec(n);
    if (m) total += Number(m[1]) / 1e6;
  }
  return total;
}

/** Holds a running call's worst case against the cap. Returns the day it was held on. */
export async function hold(id, usd) {
  const d = day();
  await write(`meta/spend/${d}/${id}_r${micro(usd)}`, '1', 'text/plain');
  return d;
}

/** Swaps the hold for what the call really cost. */
export async function settle(id, d, heldUsd, usd) {
  await write(`meta/spend/${d}/${id}_${micro(usd)}`, '1', 'text/plain');
  await del(`meta/spend/${d}/${id}_r${micro(heldUsd)}`, { token: token() }).catch(() => {});
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

/** Kit ids that are later versions of a coin (not a coin of their own). */
export async function laterVersionIds() {
  const out = new Set();
  for (const b of await blobsUnder('vers/')) {
    const m = /^vers[/]([A-Za-z0-9_-]{16})$/.exec(b.pathname);
    if (m) out.add(m[1]);
  }
  return out;
}
