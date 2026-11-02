// Reading a link someone pasted, so "turn this tweet into a coin" just works:
//   a post on X     fxtwitter's public API (api.fxtwitter.com/status/<id>: the text, the author, the photos), and X's
//                   own oEmbed (publish.twitter.com/oembed) when that is down. Both checked live 2026-11-02.
//   any other page  its title, description, main picture and the start of its text.
// Everything goes through net.js (public addresses only, capped, timed). What comes back is material for the coin,
// shown to the model as quoted data, never as instructions.
import { safeGet, checkUrl } from './net.js';
import { pageImages, pageTitle } from './refs.js';

const MAX_TEXT = 4000;
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)));

/** The http(s) links in a message, cleaned of trailing punctuation, at most `max`. */
export function linksIn(text, max = 3) {
  const out = [];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const u = m[0].replace(/[),.;:!?\]]+$/, '');
    if (checkUrl(u) && !out.includes(u)) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

/** The status id of a link to a post on X (x.com, twitter.com and the usual mirrors), else null. */
export function tweetId(url) {
  const u = checkUrl(url);
  if (!u) return null;
  if (!/(^|\.)(x|twitter|fxtwitter|fixupx|vxtwitter|fixvx)\.com$/i.test(u.hostname)) return null;
  const m = /\/status(?:es)?\/(\d{5,25})/.exec(u.pathname);
  return m ? m[1] : null;
}

async function readTweet(id, url, signal) {
  try {
    const r = await safeGet(`https://api.fxtwitter.com/status/${id}`, { maxBytes: 1_000_000, timeoutMs: 7000, accept: 'application/json', signal });
    const j = JSON.parse(r.body.toString('utf8'));
    const t = j?.tweet;
    if (j?.code === 200 && t) {
      const media = Array.isArray(t.media?.all) ? t.media.all : [];
      const images = media.map((m) => (m.type === 'photo' ? m.url : m.thumbnail_url)).filter((s) => typeof s === 'string' && /^https:\/\//.test(s)).slice(0, 2);
      const quote = t.quote ? `\n(quoting @${t.quote.author?.screen_name || '?'}: "${String(t.quote.text || '').slice(0, 600)}")` : '';
      return {
        kind: 'tweet', url: t.url || url, site: 'x.com',
        author: t.author ? `${t.author.name} (@${t.author.screen_name})` : null,
        handle: t.author?.screen_name || null,
        title: `a post on X by @${t.author?.screen_name || 'someone'}`,
        text: (String(t.text || '') + quote).slice(0, MAX_TEXT),
        when: t.created_at || null,
        stats: [t.likes != null ? `${t.likes} likes` : null, t.retweets != null ? `${t.retweets} reposts` : null, t.views != null ? `${t.views} views` : null].filter(Boolean).join(', '),
        images,
      };
    }
  } catch { /* the fallback below */ }
  const r = await safeGet(`https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(`https://twitter.com/i/status/${id}`)}`, { maxBytes: 200_000, timeoutMs: 7000, accept: 'application/json', signal });
  const j = JSON.parse(r.body.toString('utf8'));
  const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(j.html || '');
  const text = decode(String(p ? p[1] : '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
  const handle = /twitter\.com\/([A-Za-z0-9_]+)|x\.com\/([A-Za-z0-9_]+)/.exec(j.author_url || '');
  const h = handle ? handle[1] || handle[2] : null;
  return { kind: 'tweet', url: j.url || url, site: 'x.com', author: j.author_name ? `${j.author_name}${h ? ` (@${h})` : ''}` : null, handle: h, title: `a post on X by @${h || 'someone'}`, text: text.slice(0, MAX_TEXT), when: null, stats: '', images: [] };
}

/** The readable text of a page: its article (or body), no scripts, styles or navigation, collapsed. */
export function pageText(html) {
  let s = String(html || '');
  const art = /<article\b[\s\S]*?<\/article>/i.exec(s);
  const main = /<main\b[\s\S]*?<\/main>/i.exec(s);
  s = art ? art[0] : main ? main[0] : (/<body\b[\s\S]*<\/body>/i.exec(s) || [s])[0];
  s = s
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|aside|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decode(s).replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim().slice(0, MAX_TEXT);
}

async function readPage(url, signal) {
  const r = await safeGet(url, { maxBytes: 3_000_000, timeoutMs: 8000, accept: 'text/html,application/xhtml+xml,image/*;q=0.8', signal });
  const host = new URL(r.url).hostname.replace(/^www\./, '');
  if (r.type.startsWith('image/')) return { kind: 'image', url: r.url, site: host, title: `a picture on ${host}`, text: '', images: [r.url], body: r.body };
  if (!/html|xml/.test(r.type)) return { kind: 'page', url: r.url, site: host, title: host, text: '', images: [] };
  const html = r.body.toString('utf8');
  const desc = /<meta\b[^>]*(?:name|property)\s*=\s*["'](?:og:)?description["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(html);
  return { kind: 'page', url: r.url, site: host, title: pageTitle(html) || host, description: desc ? decode(desc[1]).slice(0, 400) : '', text: pageText(html), images: pageImages(html, r.url).slice(0, 1) };
}

/** Reads one link: { kind: 'tweet' | 'page' | 'image', url, site, title, text, author?, images: [url], ... }. Throws on failure. */
export async function readLink(url, { signal } = {}) {
  const id = tweetId(url);
  return id ? readTweet(id, url, signal) : readPage(url, signal);
}
