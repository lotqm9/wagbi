// A signed-in person's coin chats, so they follow them across devices. The PRIVATE Blob store "wagbi-users"
// (WAGBI_USERS_READ_WRITE_TOKEN, connected with the prefix WAGBI_USERS), never the public kits store:
//   u/<account key>/chats.json   { v: 1, chats: [...], deleted: { <chat id>: <ms> }, at }
// The account key is a keyed hash of the Google `sub` (auth.js). The chats are the same records the page keeps in
// this device's storage; the pictures in them are public kit urls, the words are what the person typed.
import { del, get, put } from '@vercel/blob';

const token = () => process.env.WAGBI_USERS_READ_WRITE_TOKEN?.trim() || undefined;
export const hasUsers = () => !!token();
const path = (key) => `u/${key}/chats.json`;

export const MAX_CHATS = 100;
const MAX_BYTES = 3_000_000;
const ID = /^[A-Za-z0-9_-]{4,40}$/;

export async function readChats(key) {
  const r = await get(path(key), { access: 'private', token: token(), useCache: false }).catch((e) => {
    if (e?.name === 'BlobNotFoundError') return null;
    throw e;
  });
  if (!r || r.statusCode !== 200) return { v: 1, chats: [], deleted: {} };
  const j = JSON.parse(await new Response(r.stream).text());
  return { v: 1, chats: Array.isArray(j.chats) ? j.chats : [], deleted: j.deleted && typeof j.deleted === 'object' ? j.deleted : {} };
}

export async function writeChats(key, data) {
  const body = JSON.stringify({ v: 1, chats: data.chats, deleted: data.deleted, at: new Date().toISOString() });
  if (body.length > MAX_BYTES) throw Object.assign(new Error('too big'), { code: 'too_long' });
  await put(path(key), body, { access: 'private', token: token(), contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
}

export async function clearChats(key) {
  await del(path(key), { token: token() }).catch(() => {});
}

/** A chat record from a page, kept only if it has the shape the page writes (an id, a sentence, a time). */
export function cleanChat(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  if (typeof c.id !== 'string' || !ID.test(c.id) || typeof c.sentence !== 'string' || typeof c.t !== 'number') return null;
  // a chat with its turns (the replies, both designs of each) runs to a few kB a turn
  if (c.sentence.length > 700 || JSON.stringify(c).length > 120_000) return null;
  const { pending, ...rest } = c; // a make running on one device isn't anyone else's business
  void pending;
  return rest;
}

const turns = (c) => (Array.isArray(c.turns) ? c.turns.length : c.kit ? 1 : 0);
const changed = (c) => c.u || c.t || 0;
/**
 * One chat over another: the one that has gone further, then the one changed last (a design picked, a rename). A
 * name given on one device survives a newer copy from another that didn't rename it: the latest name wins on its own.
 */
function better(a, b) {
  const win = turns(a) !== turns(b) ? (turns(a) > turns(b) ? a : b) : changed(a) >= changed(b) ? a : b;
  const named = (a.titleAt || 0) >= (b.titleAt || 0) ? a : b;
  if (named === win || !named.titleAt) return win;
  return { ...win, title: named.title ?? null, titleAt: named.titleAt };
}

/**
 * Merges a device's chats into the account's. Deletions win over older copies (a chat deleted on one device stays
 * deleted everywhere, unless it changed after the delete). Newest first, at most MAX_CHATS.
 */
export function mergeChats(account, incoming, incomingDeleted = {}) {
  const deleted = { ...account.deleted };
  for (const [id, at] of Object.entries(incomingDeleted || {})) if (ID.test(id) && typeof at === 'number') deleted[id] = Math.max(deleted[id] || 0, at);
  const byId = new Map();
  for (const c of [...account.chats, ...incoming]) {
    const x = cleanChat(c);
    if (!x) continue;
    const prev = byId.get(x.id);
    byId.set(x.id, prev ? better(prev, x) : x);
  }
  const chats = [...byId.values()].filter((c) => !(deleted[c.id] && deleted[c.id] >= (c.t || 0))).sort((a, b) => b.t - a.t).slice(0, MAX_CHATS);
  // forget tombstones older than 90 days
  const cutoff = Date.now() - 90 * 86_400_000;
  for (const [id, at] of Object.entries(deleted)) if (at < cutoff) delete deleted[id];
  return { chats, deleted };
}
