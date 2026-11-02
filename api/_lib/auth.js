// Sign in with Google, without a framework. The page shows Google's own button (Google Identity Services); Google
// hands it an ID token; the server checks that token the way Google's docs say (read 2026-11-02,
// developers.google.com/identity/gsi/web/guides/verify-google-id-token): the RS256 signature against Google's keys at
// https://www.googleapis.com/oauth2/v3/certs, aud = our client id, iss = accounts.google.com, not expired. No client
// secret is involved. Then the server sets its own session cookie (HMAC-signed, HttpOnly) and keys everything on the
// account's `sub`, never the email.
//   GOOGLE_CLIENT_ID   the Web client id from Google Cloud (unset: sign-in stays "soon")
//   AUTH_SECRET        32+ random bytes: signs the session cookie and hashes account ids in storage
import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

const CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
export const COOKIE = 'wsid';
const MAX_AGE_S = 30 * 86_400;

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

export const authConfig = (env = process.env) => {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() || null;
  const secret = env.AUTH_SECRET?.trim() || null;
  return { clientId, secret: secret && secret.length >= 32 ? secret : null };
};

let jwks = null;
/** Google's signing keys, cached for as long as Google's Cache-Control says. `fetchJson` is a test seam. */
async function googleKeys(fetchJson, now) {
  if (jwks && jwks.until > now) return jwks.keys;
  const { body, maxAge } = await fetchJson(CERTS);
  jwks = { keys: Array.isArray(body?.keys) ? body.keys : [], until: now + Math.max(60, Math.min(maxAge || 3600, 86_400)) * 1000 };
  return jwks.keys;
}
async function defaultFetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`certs ${r.status}`);
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  return { body: await r.json(), maxAge: m ? Number(m[1]) : 3600 };
}

/** The checked claims of a Google ID token, or throws with a short reason. */
export async function verifyGoogleIdToken(token, clientId, o = {}) {
  const now = o.now ?? Date.now();
  if (typeof token !== 'string' || token.length > 4096) throw new Error('no token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a jwt');
  const header = JSON.parse(unb64u(parts[0]).toString('utf8'));
  const claims = JSON.parse(unb64u(parts[1]).toString('utf8'));
  if (header.alg !== 'RS256' || !header.kid) throw new Error('unexpected alg');
  const keys = await googleKeys(o.fetchJson ?? defaultFetchJson, now);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const ok = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), unb64u(parts[2]));
  if (!ok) throw new Error('bad signature');
  if (claims.aud !== clientId) throw new Error('wrong audience');
  if (!ISSUERS.has(claims.iss)) throw new Error('wrong issuer');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now - 30_000) throw new Error('expired');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('no subject');
  return claims;
}

// ── our session cookie ──────────────────────────────────────────────────
const sign = (secret, data) => createHmac('sha256', secret).update(data).digest('base64url');

export function sessionCookie(secret, user, now = Date.now()) {
  const body = b64u(JSON.stringify({ sub: user.sub, email: user.email || null, name: user.name || null, picture: user.picture || null, exp: Math.floor(now / 1000) + MAX_AGE_S }));
  const value = `${body}.${sign(secret, body)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_S}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** The signed-in person from the request's cookie, or null. */
export function sessionOf(req, secret, now = Date.now()) {
  if (!secret) return null;
  const raw = (req.headers.get('cookie') || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [body, mac] = raw.slice(COOKIE.length + 1).split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(unb64u(body).toString('utf8'));
    if (!s.sub || !s.exp || s.exp * 1000 < now) return null;
    return s;
  } catch {
    return null;
  }
}

/** An account's storage id: a keyed hash of its Google `sub`, so no Google id sits in a path. */
export const accountKey = (secret, sub) => createHmac('sha256', secret).update(`account|${sub}`).digest('base64url').slice(0, 32);

/** For tests: forget the cached keys. */
export const _resetKeys = () => { jwks = null; };
