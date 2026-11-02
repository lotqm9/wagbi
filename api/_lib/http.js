import { BRAND } from './brand.js';
// Small helpers shared by the functions: json replies, the visitor's IP, a per instance limiter.
// Every message a visitor can see lives here: lowercase, plain, nothing about money.
export const MESSAGES = {
  empty: 'type one sentence first.',
  too_long: 'keep it under 600 characters.',
  real_person: `${BRAND.name} does not make coins about real people. try a made up character instead.`,
  nope: `${BRAND.name} will not make that one. try another idea.`,
  slow: 'that is a lot of coins for one hour. try again a little later.',
  resting: `${BRAND.name} is resting, back tomorrow.`,
  busy: `${BRAND.name} is busy making other coins right now. try again in a minute.`,
  jam: 'something went wrong on that one. try it again.',
  off: `${BRAND.name} can not make coins right now. try again soon.`,
  no_art: `${BRAND.name}'s picture maker is down right now, so no coin came out. try again in a little while.`,
  not_found: 'this coin is not here.',
  signin: 'sign in first.',
  bad_file: 'that file is not a picture we can use. try a png, jpg, webp or gif.',
  file_too_big: 'that picture is too big. try a smaller one.',
  too_many_files: 'four pictures at most.',
  cross_site: `send it from ${BRAND.name} itself.`,
  voice_rest: 'the mic is resting for today. type your idea instead.',
};

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };

export function fail(code, status = 400) {
  return new Response(JSON.stringify({ ok: false, code, error: MESSAGES[code] ?? MESSAGES.jam }), { status, headers: NO_STORE });
}

export function ok(body, cache = 'no-store') {
  return new Response(JSON.stringify({ ok: true, ...body }), { headers: { ...NO_STORE, 'Cache-Control': cache } });
}

export async function readJson(req, maxBytes = 2048) {
  try {
    const raw = await req.text();
    if (raw.length > maxBytes) return null;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * A browser request from this site, not another one's page. A browser sends Origin on every POST it makes for a
 * page; another site's page can send a "simple" POST (text/plain, no preflight) and spend this site's money with it,
 * so a POST that names another origin is turned away. No Origin: not a browser page (curl and the like), which the
 * per-IP limits and the daily cap handle.
 */
export function sameOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host);
  } catch {
    return false;
  }
}

/** The request says it is JSON (a page's fetch does; a cross-site form or a "simple" POST can't without a preflight). */
export const isJson = (req) => /^application\/json\b/i.test(req.headers.get('content-type') || '');

export function clientIp(req) {
  const real = req.headers.get('x-real-ip') ?? req.headers.get('x-vercel-forwarded-for');
  if (real) return real.split(',')[0].trim();
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'local';
}

// best effort, per server instance: stops one browser hammering before any storage is touched.
// The real limits (per IP per hour, the daily cap) are counted in Blob.
const buckets = new Map();
export function limited(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return true;
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  return false;
}
