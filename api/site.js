// Every coin's own website, on the brand's domain. One function; vercel.json sends the clean paths here:
//   GET  /<slug>                      the coin's website, drawn on the server (api/_lib/sitepage.js): whole on first
//                                     load, for crawlers and for link previews. Cached at the edge, tagged with the
//                                     coin, and purged when the coin's site changes (coinsite.js).
//   GET  /api/site?coin=<id>          -> { ok, site: { slug, path, url } }   any kit id of the coin works; a coin made
//                                     before sites gets its site here
//   GET  /api/site?market=<coin id>   -> { ok, n, src }   the live numbers a launched coin's page refreshes
//   POST /api/site { kit, key }       -> { ok, site }     a design picked in its chat: the site shows it from now on
//                                     (key: the coin's site key, which only the chat that made it was given)
import { waitUntil } from '@vercel/functions';
import { clientIp, fail, limited, ok, readJson } from './_lib/http.js';
import { hasStore, isId, readLaunch } from './_lib/store.js';
import { isReserved, isSlug } from './_lib/sites.js';
import { SiteError, launchFacts, liveOf, pageData, pick, siteCluster, siteOf, tagSite } from './_lib/coinsite.js';
import { numbers, renderMissing, renderSite } from './_lib/sitepage.js';

const log = (e) => console.log(JSON.stringify({ at: 'site', ...e }));

function page({ html, csp }, status, cache) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      ...(cache ? { 'Vercel-CDN-Cache-Control': cache } : { 'Cache-Control': 'no-store' }),
    },
  });
}
const missing = (slug) => page(renderMissing(slug), 404, null);

async function sitePage(req, raw) {
  const lower = raw.toLowerCase();
  if (lower !== raw && isSlug(lower)) return new Response(null, { status: 308, headers: { Location: `/${lower}`, 'Cache-Control': 'public, max-age=3600' } });
  if (!isSlug(lower) || isReserved(lower)) return missing(isSlug(lower) ? lower : '');
  const later = [];
  const d = await pageData(lower, { onLater: (p) => later.push(p) });
  for (const p of later) waitUntil(p.catch(() => {}));
  if (!d) return missing(lower);
  await tagSite(d.coin);
  const live = d.launch ? await liveOf(d.launch) : { market: null, supply: null };
  return page(renderSite(d, live), 200, 'max-age=60, stale-while-revalidate=600');
}

async function market(coin) {
  if (!isId(coin)) return fail('not_found', 404);
  const cluster = siteCluster();
  const L = launchFacts(await readLaunch(coin, cluster).catch(() => null), cluster);
  if (!L) return fail('not_found', 404);
  const { market: m } = await liveOf(L);
  const src = !m || !m.source
    ? (cluster === 'devnet' ? 'a devnet test coin: numbers come straight from the chain, when there are any.' : 'no market data yet. a new coin shows up on DexScreener within a minute or two.')
    : m.source === 'dexscreener' ? 'live from DexScreener. updates every 30 seconds.' : 'read straight from the chain. updates every 30 seconds.';
  return ok({ n: numbers(m), src }, 'public, max-age=10, s-maxage=20, stale-while-revalidate=40');
}

export async function GET(req) {
  const u = new URL(req.url);
  if (limited(`site:${clientIp(req)}`, 240, 60_000)) return fail('slow', 429);
  if (!hasStore()) return fail('off', 503);
  try {
    if (u.searchParams.has('slug')) return await sitePage(req, u.searchParams.get('slug') || '');
    if (u.searchParams.has('market')) return await market(u.searchParams.get('market') || '');
    const id = u.searchParams.get('coin') || '';
    if (!isId(id)) return fail('not_found', 404);
    const site = await siteOf(id);
    return site ? ok({ site }, 'public, max-age=5, s-maxage=10') : fail('not_found', 404);
  } catch (e) {
    log({ evt: 'site.error', error: String(e?.message ?? e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 300) });
    return u.searchParams.has('slug') ? page({ ...renderMissing(''), html: renderMissing('').html.replace('no coin lives here yet.', 'this site is resting. try again in a minute.') }, 503, null) : fail('off', 503);
  }
}

/** Same origin only: another site's page may not change a coin's website from a browser (as api/launch.js). */
function sameOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host);
  } catch {
    return false;
  }
}

export async function POST(req) {
  if (!sameOrigin(req)) return fail('nope', 403);
  if (limited(`site-pick:${clientIp(req)}`, 60, 60_000)) return fail('slow', 429);
  if (!hasStore()) return fail('off', 503);
  const body = await readJson(req, 2048);
  if (!body || !isId(body.kit)) return fail('not_found', 404);
  try {
    const r = await pick(body.kit, typeof body.key === 'string' ? body.key : null, { token: typeof body.token === 'string' ? body.token.slice(0, 64) : null });
    if (r.warm) waitUntil(r.warm.catch(() => {}));
    return ok({ site: r.site });
  } catch (e) {
    if (e instanceof SiteError) {
      if (e.code === 'signin') return new Response(JSON.stringify({ ok: false, code: 'not_yours', error: "only the chat that made this coin can change its website." }), { status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
      return fail(e.code, e.status);
    }
    log({ evt: 'site.pick_error', error: String(e?.message ?? e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 300) });
    return fail('off', 503);
  }
}
