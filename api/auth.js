// Sign in with Google (api/_lib/auth.js) and the signed-in person's chats (api/_lib/users.js). One function;
// vercel.json maps /api/chats here too.
//   GET    /api/auth     {ok, clientId, user}      clientId null: sign-in isn't set up here (the menu says "soon")
//   POST   /api/auth     {credential}              Google's ID token from its button -> the session cookie, {user}
//   DELETE /api/auth                               signs out (clears the cookie)
//   GET    /api/chats    {ok, chats, deleted}      the account's chats
//   POST   /api/chats    {chats, deleted}          merges this device's chats in; answers the merged list
//   DELETE /api/chats                              deletes every chat on the account ("clear all chat history")
import { authConfig, accountKey, clearCookie, sessionCookie, sessionOf, verifyGoogleIdToken } from './_lib/auth.js';
import { clientIp, fail, limited, ok, readJson } from './_lib/http.js';
import { hasUsers, mergeChats, readChats, writeChats } from './_lib/users.js';

const log = (o) => console.log(JSON.stringify({ at: 'auth', ...o }));
const sameOrigin = (req) => {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host);
  } catch {
    return false;
  }
};
const withCookie = (res, cookie) => {
  res.headers.append('Set-Cookie', cookie);
  return res;
};
const isChats = (req) => new URL(req.url).pathname.startsWith('/api/chats') || new URL(req.url).searchParams.get('op') === 'chats';
const publicUser = (s) => (s ? { name: s.name, email: s.email, picture: s.picture } : null);

export async function GET(req) {
  const { clientId, secret } = authConfig();
  const s = sessionOf(req, secret);
  if (!isChats(req)) return ok({ clientId: clientId && secret && hasUsers() ? clientId : null, user: publicUser(s) });
  if (!s) return fail('signin', 401);
  if (limited(`chats:${clientIp(req)}`, 120, 60_000)) return fail('slow', 429);
  try {
    const data = await readChats(accountKey(secret, s.sub));
    return ok(data);
  } catch (e) {
    log({ read: String(e?.message ?? e).slice(0, 160) });
    return fail('off', 503);
  }
}

export async function POST(req) {
  if (!sameOrigin(req)) return fail('nope', 403);
  const { clientId, secret } = authConfig();
  if (!secret || !hasUsers()) return fail('off', 503);
  const ip = clientIp(req);
  if (!isChats(req)) {
    if (!clientId) return fail('off', 503);
    if (limited(`signin:${ip}`, 20, 3600_000)) return fail('slow', 429);
    const body = await readJson(req, 8192);
    try {
      const c = await verifyGoogleIdToken(body?.credential, clientId);
      const user = { sub: c.sub, email: c.email_verified ? c.email : null, name: c.name || null, picture: typeof c.picture === 'string' && c.picture.startsWith('https://') ? c.picture : null };
      log({ signin: true });
      return withCookie(ok({ user: publicUser(user) }), sessionCookie(secret, user));
    } catch (e) {
      log({ signin: false, why: String(e?.message ?? e).slice(0, 80) });
      return fail('nope', 401);
    }
  }
  const s = sessionOf(req, secret);
  if (!s) return fail('signin', 401);
  if (limited(`chatsave:${ip}`, 60, 60_000)) return fail('slow', 429);
  const body = await readJson(req, 3_200_000);
  if (!body || !Array.isArray(body.chats)) return fail('empty');
  try {
    const key = accountKey(secret, s.sub);
    const merged = mergeChats(await readChats(key), body.chats, body.deleted);
    await writeChats(key, merged);
    return ok(merged);
  } catch (e) {
    log({ write: String(e?.message ?? e).slice(0, 160) });
    return fail(e?.code === 'too_long' ? 'too_long' : 'off', e?.code === 'too_long' ? 413 : 503);
  }
}

export async function DELETE(req) {
  if (!sameOrigin(req)) return fail('nope', 403);
  const { secret } = authConfig();
  if (!isChats(req)) return withCookie(ok({ user: null }), clearCookie());
  const s = sessionOf(req, secret);
  if (!s) return fail('signin', 401);
  try {
    // every chat is marked deleted (not just dropped), so another device's copy doesn't sync it back
    const key = accountKey(secret, s.sub);
    const cur = await readChats(key);
    const at = Date.now();
    const deleted = { ...cur.deleted };
    for (const c of cur.chats) if (c && typeof c.id === 'string') deleted[c.id] = at;
    await writeChats(key, { chats: [], deleted });
    return ok({ chats: [], deleted, clearedAt: at });
  } catch (e) {
    log({ clear: String(e?.message ?? e).slice(0, 160) });
    return fail('off', 503);
  }
}
