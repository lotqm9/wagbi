// The original picture of an existing meme or character (wojak, pepe, doge...), so the art shows THAT character and not
// a lookalike. The model calls find_images; this looks the name up where the canonical pictures live and hands back a
// few candidates, which the model then looks at and picks from:
//   Wikipedia   the article's lead image (generator=search + pageimages, original size)
//   Know Your Meme   the entry's header image (og:image of /memes/<slug>), the canonical picture of most memes
//   a page URL  (one the model found with web search, or one the person pasted): its og:image / twitter:image, or the
//               URL itself when it is a picture
// Everything goes through net.js (public addresses only, capped, timed) and images.js (real pixels only, re-encoded).
import { createHash } from 'node:crypto';
import { safeGet } from './net.js';
import { normalize, thumbUrl } from './images.js';

const MAX_IMAGE = 8_000_000;
const MAX_HTML = 2_500_000;

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** og:image / twitter:image / image_src from a page's HTML, absolute, in that order. */
export function pageImages(html, base) {
  const out = [];
  const head = String(html || '').slice(0, 400_000);
  const metas = head.match(/<meta\b[^>]*>/gi) || [];
  const want = ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'];
  for (const name of want) {
    for (const m of metas) {
      const key = (/(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(m) || [])[1];
      if (!key || key.toLowerCase() !== name) continue;
      const content = (/content\s*=\s*["']([^"']+)["']/i.exec(m) || [])[1];
      if (content) out.push(content);
    }
  }
  const link = /<link\b[^>]*rel\s*=\s*["']image_src["'][^>]*>/i.exec(head);
  if (link) {
    const href = (/href\s*=\s*["']([^"']+)["']/i.exec(link[0]) || [])[1];
    if (href) out.push(href);
  }
  const abs = [];
  for (const u of out) {
    try {
      const a = new URL(decode(u), base).href;
      if (!abs.includes(a)) abs.push(a);
    } catch { /* not a url */ }
  }
  return abs;
}

/** The page's title (og:title, else <title>), short. */
export function pageTitle(html) {
  const s = String(html || '').slice(0, 200_000);
  const og = /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(s) || /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:title["']/i.exec(s);
  const t = og ? og[1] : (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || [])[1];
  return decode(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Know Your Meme's search results, in page order: [{ title, path }] for meme entries only (no people, sites or subcultures). */
export function kymEntries(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<a\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bclass\s*=\s*["']item["']/i.test(tag)) continue;
    const path = (/href\s*=\s*["'](\/memes\/[a-z0-9-]+)["']/i.exec(tag) || [])[1];
    if (!path || out.some((e) => e.path === path)) continue;
    out.push({ title: decode((/data-title\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1] || ''), path: path.toLowerCase() });
  }
  return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
/** How well a title names the thing asked for: 3 exact (or one of its " / " names), 2 starts with it, 1 contains it, 0 not. */
export function matchScore(title, query) {
  const key = (s) => norm(s).replace(/\b(meme|memes|the|coin|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const q = key(query);
  if (!q) return 0;
  const names = String(title || '').split('/').map(key);
  if (names.some((n) => n === q)) return 3;
  if (names.some((n) => n.startsWith(q + ' ') || q.startsWith(n + ' '))) return 2;
  if (names.some((n) => n.includes(q))) return 1;
  return 0;
}
export const slugOf = (q) => norm(q).replace(/\b(meme|coin)\b/g, ' ').trim().replace(/\s+/g, '-');

// people are never references: an article about a person (a birth year, a job in its description) is left out
const PERSON = /\b(born|died)\b|\(\d{4}\s*[–-]\s*\d{4}\)|\b(politician|actor|actress|singer|rapper|businessman|businesswoman|historian|footballer|youtuber|streamer|journalist|entrepreneur)\b/i;

async function wikipedia(query, signal) {
  const u = new URL('https://en.wikipedia.org/w/api.php');
  // pilicense=any: the lead images of meme articles are mostly non-free (fair use), which pageimages hides by default
  for (const [k, v] of Object.entries({ action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrsearch: query, gsrlimit: '4', prop: 'pageimages|description', piprop: 'original', pilicense: 'any', redirects: '1' })) u.searchParams.set(k, v);
  const r = await safeGet(u.href, { maxBytes: 500_000, timeoutMs: 6000, accept: 'application/json', signal });
  const j = JSON.parse(r.body.toString('utf8'));
  return (j?.query?.pages || [])
    .filter((p) => p.original?.source && !PERSON.test(p.description || ''))
    .map((p) => ({ src: p.original.source, page: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`, title: `${p.title}${p.description ? ` (${p.description})` : ''}`, site: 'Wikipedia', score: matchScore(p.title, query) * 10 - (p.index ?? 5) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

async function kymPage(path, signal) {
  const p = await safeGet(`https://knowyourmeme.com${path}`, { maxBytes: MAX_HTML, timeoutMs: 6000, accept: 'text/html', signal });
  // an entry (some live under /sensitive/), not a list, a person or a site page it redirected to
  if (!/^https:\/\/knowyourmeme\.com\/(sensitive\/)?memes\/[a-z0-9-]+$/.test(p.url)) return null;
  const html = p.body.toString('utf8');
  const src = pageImages(html, p.url).find((u) => /kym-cdn\.com\/(entries|photos)\//.test(u));
  return src ? { src, page: p.url, title: pageTitle(html).replace(/\s*\|\s*Know Your Meme\s*$/i, ''), site: 'Know Your Meme' } : null;
}

async function knowYourMeme(query, signal) {
  const direct = `/memes/${slugOf(query)}`;
  const [hit, search] = await Promise.all([
    slugOf(query) ? kymPage(direct, signal).catch(() => null) : null,
    safeGet(`https://knowyourmeme.com/search?q=${encodeURIComponent(query)}`, { maxBytes: MAX_HTML, timeoutMs: 6000, accept: 'text/html', signal }).then((r) => kymEntries(r.body.toString('utf8'))).catch(() => []),
  ]);
  const ranked = search
    .map((e, i) => ({ ...e, score: matchScore(e.title, query) * 10 - i }))
    .filter((e) => e.path !== direct && e.score > -10)
    .sort((a, b) => b.score - a.score)
    .slice(0, hit ? 1 : 2);
  const more = await Promise.all(ranked.map((e) => kymPage(e.path, signal).catch(() => null)));
  return [hit, ...more].filter(Boolean).map((c, i) => ({ ...c, score: matchScore(c.title, query) * 10 - i }));
}

async function fromPage(url, signal) {
  const r = await safeGet(url, { maxBytes: MAX_IMAGE, timeoutMs: 8000, accept: 'text/html,image/*;q=0.9', signal });
  if (r.type.startsWith('image/')) return [{ src: r.url, page: r.url, title: 'a picture', site: new URL(r.url).hostname, body: r.body }];
  if (!/html/.test(r.type)) return [];
  const html = r.body.toString('utf8');
  const title = pageTitle(html);
  return pageImages(html, r.url).slice(0, 2).map((src) => ({ src, page: r.url, title, site: new URL(r.url).hostname }));
}

/**
 * Candidates for find_images({ query } | { page }): up to `limit`, each { id, src, page, title, site, data (a clean
 * JPEG), width, height, hash, thumb (a data url for the steps) }. Sources that fail are skipped quietly.
 */
export async function findImages({ query, page }, { limit = 4, signal, seen = new Set() } = {}) {
  const lists = [];
  if (page) lists.push(fromPage(page, signal).catch(() => []));
  if (query) lists.push(knowYourMeme(query, signal).catch(() => []), wikipedia(query, signal).catch(() => []));
  const found = (await Promise.all(lists)).flat();
  // the best named first (a page the model chose comes first of all), a source's own order breaking ties
  const picked = found.map((f, i) => ({ ...f, rank: (f.score ?? 100) - i * 0.01 })).sort((a, b) => b.rank - a.rank).slice(0, limit + 2);
  const out = [];
  await Promise.all(picked.map(async (c, i) => {
    try {
      const raw = c.body ?? (await safeGet(c.src, { maxBytes: MAX_IMAGE, timeoutMs: 8000, accept: 'image/*', signal })).body;
      const img = await normalize(raw);
      const hash = createHash('sha256').update(img.data).digest('hex').slice(0, 24);
      if (seen.has(hash)) return;
      out.push({ order: i, src: c.src, page: c.page, title: c.title, site: c.site, data: img.data, width: img.width, height: img.height, hash, thumb: await thumbUrl(img.data) });
    } catch { /* not a usable picture */ }
  }));
  const res = out.sort((a, b) => a.order - b.order).filter((c) => (seen.has(c.hash) ? false : (seen.add(c.hash), true))).slice(0, limit);
  return res;
}
