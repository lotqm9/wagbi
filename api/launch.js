// The launch on pump.fun, by deposit (no wallet connection). One function; vercel.json maps the paths:
//   GET  /api/launch/config          open or not, wagbi's cut, the limits (never a secret)
//   POST /api/launch/quote           {firstBuySol} -> the exact SOL to send, and the first buy's share of supply
//   POST /api/launch                 the launch (kit, words, payout wallet, split, first buy) -> a fresh deposit
//                                    address, the exact amount, a QR code
//   GET  /api/launch/<id>[?qr=1]     the deposit's status: waiting, launching, live, refunding, refunded, failed.
//                                    When there is work (the SOL arrived, a launch to finish, SOL to send back)
//                                    it starts after the answer, in this same invocation.
//   POST /api/launch/<id>/refund     "send it back" on an underpaid deposit
//   GET  /api/launch/coin/<kitId>    a launched coin, public: mint, links, the locked split, the allocation
//   GET  /api/launch/cron            Vercel Cron (CRON_SECRET): funded deposits nobody watches, refunds after 24 h
import { timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { DEPOSIT_ID_RE, LaunchError } from 'printer-engine/launch';
import { clientIp, limited } from './_lib/http.js';
import { launchService } from './_lib/launch/wire.js';
import { BRAND } from './_lib/brand.js';

const MAX_S = 300;
const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, ...extra } });
const deadline = () => Date.now() + (MAX_S - 20) * 1000;
const log = (e) => console.log(JSON.stringify({ at: 'launch', ...e }));

function errorResponse(e) {
  const err = e instanceof LaunchError ? e : new LaunchError('chain', String(e?.message ?? e), `something went wrong on ${BRAND.name}'s side. nothing was sent. try again in a minute.`);
  if (err.code === 'config' || err.code === 'chain') log({ evt: 'launch.error', code: err.code, error: err.message.slice(0, 400) });
  const extra = err.retryAfterMs ? { 'Retry-After': String(Math.ceil(err.retryAfterMs / 1000)) } : {};
  return json({ ok: false, code: err.code, error: err.userMessage }, err.status, extra);
}

/** Same origin only: another site's page may not drive the launch from a browser. */
function sameOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function body(req) {
  const text = await req.text();
  if (text.length > 8192) throw new LaunchError('bad_input', 'body too large', 'that request is too large.');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new LaunchError('bad_input', 'bad json', "that isn't json.");
  }
}

/** op and ids from the query (the rewrites) or the path (/api/launch/<id>/refund, /api/launch/coin/<kit>). */
function route(req, method) {
  const u = new URL(req.url);
  const parts = u.pathname.replace(/^\/api\/launch\/?/, '').split('/').filter(Boolean);
  let op = u.searchParams.get('op');
  let id = u.searchParams.get('id');
  let kit = u.searchParams.get('kit');
  if (!op) {
    if (parts[0] === 'config' || parts[0] === 'quote' || parts[0] === 'cron') op = parts[0];
    else if (parts[0] === 'coin') [op, kit] = ['coin', parts[1]];
    else if (parts[1] === 'refund') [op, id] = ['refund', parts[0]];
    else if (parts[0]) [op, id] = ['status', parts[0]];
    else op = method === 'POST' ? 'create' : 'config';
  }
  return { op, id: id ?? '', kit: kit ?? '', qr: u.searchParams.get('qr') === '1' };
}

const runAfter = (svc, id) =>
  waitUntil(svc.run(id, { deadline: deadline() }).catch((e) => log({ evt: 'launch.run_failed', id, error: String(e?.message ?? e).slice(0, 300) })));

function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req) {
  try {
    const r = route(req, 'GET');
    const ip = clientIp(req);
    if (r.op !== 'cron' && limited(`launch-get:${ip}`, 240, 60_000)) throw new LaunchError('rate_limited', 'polls', 'too many requests. wait a moment.', { retryAfterMs: 10_000 });
    const svc = launchService();
    if (r.op === 'config') return json({ ok: true, ...svc.config() });
    if (r.op === 'coin') {
      const c = await svc.coin(r.kit);
      return c ? json({ ok: true, coin: c }, 200, { 'Cache-Control': 'public, max-age=30, s-maxage=60' }) : json({ ok: false, code: 'not_found', error: 'this coin is not launched yet.' }, 404);
    }
    if (r.op === 'cron') {
      if (!cronAuthorized(req)) return json({ ok: false, code: 'closed', error: 'not authorized.' }, 403);
      return json({ ok: true, ...(await svc.cron({ deadline: deadline() })) });
    }
    if (r.op === 'status') {
      if (!DEPOSIT_ID_RE.test(r.id)) throw new LaunchError('not_found', 'bad id', `that deposit isn't on ${BRAND.name}.`);
      const st = await svc.status(r.id, { qr: r.qr });
      if (!st) throw new LaunchError('not_found', 'no such deposit', `that deposit isn't on ${BRAND.name}.`);
      if (st.needsRun) runAfter(svc, r.id);
      return json({ ok: true, deposit: st.view });
    }
    throw new LaunchError('not_found', 'no such route', 'not here.');
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req) {
  try {
    if (!sameOrigin(req)) throw new LaunchError('bad_input', 'cross-origin', `launch from ${BRAND.name} itself.`);
    const r = route(req, 'POST');
    const ip = clientIp(req);
    const svc = launchService();
    if (r.op === 'quote') {
      if (limited(`launch-quote:${ip}`, 120, 60_000)) throw new LaunchError('rate_limited', 'quotes', 'too many requests. wait a moment.', { retryAfterMs: 10_000 });
      return json({ ok: true, ...(await svc.quote(await body(req))) });
    }
    if (r.op === 'create') {
      if (limited(`launch-create:${ip}`, 12, 3_600_000)) throw new LaunchError('rate_limited', 'deposits', "that's a lot of deposit addresses this hour. try again later.", { retryAfterMs: 600_000 });
      return json({ ok: true, deposit: await svc.create(await body(req)) });
    }
    if (r.op === 'refund') {
      if (!DEPOSIT_ID_RE.test(r.id)) throw new LaunchError('not_found', 'bad id', `that deposit isn't on ${BRAND.name}.`);
      if (limited(`launch-refund:${ip}`, 30, 3_600_000)) throw new LaunchError('rate_limited', 'refunds', 'too many tries. wait a few minutes.', { retryAfterMs: 300_000 });
      const st = await svc.askRefund(r.id);
      if (st?.needsRun) runAfter(svc, r.id);
      return json({ ok: true, deposit: st?.view ?? null });
    }
    throw new LaunchError('not_found', 'no such route', 'not here.');
  } catch (e) {
    return errorResponse(e);
  }
}
