import { BRAND } from './brand.js';
// Small helpers shared by the functions: json replies, the visitor's IP, a per instance limiter.
// Every message a visitor can see lives here: lowercase, plain, nothing about money.
export const MESSAGES = {
  empty: 'type one sentence first.',
  too_long: 'keep it to one sentence, 140 characters at most.',
  real_person: `${BRAND.name} does not make coins about real people. try a made up character instead.`,
  nope: `${BRAND.name} will not make that one. try another idea.`,
  slow: 'that is a lot of coins for one hour. try again a little later.',
  resting: `${BRAND.name} is resting, back tomorrow.`,
  jam: 'something went wrong on that one. try it again.',
  off: `${BRAND.name} can not make coins right now. try again soon.`,
  not_found: 'this coin is not here.',
  signin: 'sign in first.',
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
