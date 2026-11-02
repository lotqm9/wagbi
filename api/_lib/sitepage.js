// A coin's website as HTML, drawn on the server so it is whole on first load, for crawlers and for link previews.
// Every value from a coin (its words, made by a person and a model) is escaped: the template escapes everything it is
// given unless it is markup built here (raw()). Links are built here from checked parts, never taken as they come.
// The page's own colours and font go in one small <style> whose hash is in the CSP; the rest is /coin-site/ (static,
// same origin). No outside scripts, fonts or trackers.
import { createHash } from 'node:crypto';
import { BRAND } from './brand.js';

export const ASSET_V = '4';
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s));
const part = (v) => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : esc(v));
/** Markup with every value escaped (arrays joined, null and false dropped, raw() kept as is). */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return raw(out);
}

/** An address the page may link to: https, or a path on this site. Anything else is dropped. */
export function safeHref(u) {
  const s = String(u ?? '');
  if (/^\/(?!\/)[A-Za-z0-9/_.?=&%#-]*$/.test(s)) return s;
  try {
    const x = new URL(s);
    return x.protocol === 'https:' && !x.username && !x.password ? x.href : null;
  } catch {
    return null;
  }
}
const BLOB = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/(kits\/[A-Za-z0-9_-]{16}\/[a-z]+|sites\/looks\/[A-Za-z0-9_-]{16})\.(png|jpg|webp)$/;
const pic = (u) => (BLOB.test(String(u || '')) ? u : null);

// the display faces (coin-site/fonts): family, file, how big it sets next to the others, tracking, weight
export const FONTS = {
  bricolage: { family: 'Bricolage Grotesque', file: 'bricolage-800', scale: 1, track: '-0.045em', weight: 800 },
  unbounded: { family: 'Unbounded', file: 'unbounded-800', scale: 0.8, track: '-0.04em', weight: 800 },
  rubik800: { family: 'Rubik', file: 'rubik-800', scale: 0.98, track: '-0.04em', weight: 800 },
  rubik900: { family: 'Rubik', file: 'rubik-900', scale: 0.98, track: '-0.035em', weight: 900 },
  archivo: { family: 'Archivo Black', file: 'archivo-black', scale: 0.9, track: '-0.04em', weight: 400 },
  bungee: { family: 'Bungee', file: 'bungee', scale: 0.86, track: '-0.01em', weight: 400 },
  instrument: { family: 'Instrument Serif', file: 'instrument-serif', scale: 1.22, track: '-0.025em', weight: 400 },
  fredoka: { family: 'Fredoka', file: 'fredoka-700', scale: 1.02, track: '-0.02em', weight: 700 },
  pixel: { family: 'Press Start 2P', file: 'press-start-2p', scale: 0.5, track: '0', weight: 400 },
  spacemono: { family: 'Space Mono', file: 'space-mono-700', scale: 0.82, track: '-0.04em', weight: 700 },
};
const DEFAULT_LOOK = {
  skin: 'clean', font: 'bricolage', layout: 'profile', mode: 'light',
  colors: { bg: '#f6f6f3', bg2: '#ededea', surface: '#ffffff', ink: '#121212', ink2: '#56564f', line: '#dadad5', accent: '#3b5bfd', accentInk: '#ffffff', pop: '#ff7a59', popInk: '#121212' },
};

// ---------- numbers, the way the app shows them (launch.js fmt) ----------
const trim = (v, d) => {
  let t = Number(v).toFixed(d);
  if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
  return t;
};
const ok = (n) => typeof n === 'number' && Number.isFinite(n);
export function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return trim(n / 1e9, a >= 1e10 ? 1 : 2) + 'B';
  if (a >= 1e6) return trim(n / 1e6, a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e3) return trim(n / 1e3, a >= 1e5 ? 0 : 1) + 'K';
  if (a >= 100) return String(Math.round(n));
  if (a >= 1) return trim(n, 2);
  return trim(n, 3) === '0' ? n.toPrecision(2) : trim(n, 3);
}
const SUBS = '₀₁₂₃₄₅₆₇₈₉';
export function price(n, unit) {
  if (!ok(n) || n <= 0) return null;
  const pre = unit === '$' ? '$' : '';
  const post = unit && unit !== '$' ? ' ' + unit : '';
  if (n >= 1) return pre + trim(n, 2) + post;
  if (n >= 0.001) return pre + Number(n.toPrecision(3)) + post;
  const [m, e] = n.toExponential(3).split('e');
  const zeros = -Number(e) - 1;
  return pre + '0.0' + String(zeros).split('').map((x) => SUBS[x]).join('') + m.replace('.', '').replace(/0+$/, '') + post;
}
/** The live numbers from a market answer (market.js): { mcap, vol, chg, change, price, prog, progPct }. */
export function numbers(m) {
  const curve = m && m.curve;
  const q = curve && curve.quote;
  const mcap = (m && ok(m.mcapUsd) ? '$' + compact(m.mcapUsd) : null) || (curve && ok(curve.mcap) ? `${compact(curve.mcap)} ${q}` : null);
  const vol = m && ok(m.volume24hUsd) ? '$' + compact(m.volume24hUsd) : null;
  const c = m && m.change24hPct;
  const chg = ok(c) ? (c > 0.05 ? '+' : c < -0.05 ? '−' : '') + (Math.abs(c) >= 100 ? Math.round(Math.abs(c)) : trim(Math.abs(c), 1)) + '%' : null;
  const pr = (m && price(m.priceUsd, '$')) || (curve && ok(curve.price) ? price(curve.price, q) : null);
  const progPct = curve ? (curve.complete ? 100 : ok(curve.progressPct) ? curve.progressPct : null) : null;
  const prog = curve ? (curve.complete ? 'graduated' : ok(curve.progressPct) ? `${trim(curve.progressPct, 1)}%` : null) : null;
  return { mcap, vol, chg, change: ok(c) ? c : null, price: pr, prog, progPct };
}
const shortMint = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '');
const dateOf = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).toLowerCase() : null;
};
const lenClass = (s) => ([...String(s)].length > 18 ? 'len-l' : [...String(s)].length > 11 ? 'len-m' : 'len-s');

// ---------- the parts ----------
const ICON = {
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  out: '<path d="M8 16L16 8M9.5 8H16v6.5"/>',
  chart: '<path d="M4.5 19.5h15M7 16l3.5-4.5 3 2.5 4.5-6.5"/>',
  wallet: '<rect x="3.5" y="6.5" width="17" height="12.5" rx="3"/><path d="M3.5 10h17M16 14.5h1.5"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.6 0-2.7.8-2.7 2s1 1.7 2.7 2 2.7.8 2.7 2-1.1 2-2.7 2c-1.1 0-2-.4-2.5-1.2M12 6.5v11"/>',
  swap: '<path d="M7 7.5h11l-3-3M17 16.5H6l3 3"/>',
  shield: '<path d="M12 3.5l7 2.5v5.5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
};
const icon = (n) => raw(`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`);
const XMARK = raw('<svg class="ic xmark" viewBox="0 0 24 24" aria-hidden="true"><path d="M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L2 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.4 4.7H5.5z"/></svg>');
const ext = (href) => html`href="${href}" target="_blank" rel="noopener noreferrer"`;

function copyBox(mint, cls = '') {
  return html`<div class="ca ${cls}">
  <span class="ca-k">CA</span>
  <code class="ca-v" title="${mint}">${mint}</code>
  <button class="ca-copy" type="button" data-copy="${mint}" aria-label="copy the contract address">${icon('copy')}<span>copy</span></button>
</div>`;
}

function heroActions(d) {
  const L = d.launch;
  const t = d.words.ticker;
  if (!L) {
    return html`<div class="acts">
  <span class="soon"><i></i>launching soon</span>
  <a class="btn ghost" href="${`/k/${d.coin}`}" target="_top">see it on ${BRAND.name}${icon('out')}</a>
</div>`;
  }
  const out = [];
  if (L.pad && safeHref(L.pad.url)) out.push(html`<a class="btn" ${ext(safeHref(L.pad.url))}>buy $${t}</a>`);
  if (L.chart && safeHref(L.chart)) out.push(html`<a class="btn ghost" ${ext(safeHref(L.chart))}>${icon('chart')}chart</a>`);
  if (!L.pad) out.push(html`<a class="btn ${out.length ? 'ghost' : ''}" ${ext(safeHref(L.explorer))}>explorer${icon('out')}</a>`);
  if (L.x && safeHref(L.x)) out.push(html`<a class="btn ghost icon-only" ${ext(safeHref(L.x))} aria-label="${d.words.name} on x">${XMARK}</a>`);
  return html`<div class="acts">${out}</div>`;
}

function liveStrip(d, n) {
  const chgCls = n.change == null ? '' : n.change >= 0 ? 'up' : 'down';
  const it = (k, label, v, cls = '') => html`<div class="tick-i"><span>${label}</span><b class="${cls}" data-n="${k}">${v ?? '—'}</b></div>`;
  return html`<div class="tick-row" aria-label="live numbers">
  ${it('mcap', 'market cap', n.mcap)}${it('vol', '24h volume', n.vol)}${it('chg', '24h', n.chg, chgCls)}
</div>`;
}

function marquee(d) {
  const bits = [html`<span>$${d.words.ticker}</span>`, html`<span>${d.words.name}</span>`];
  if (d.lore.tagline) bits.push(html`<span>${d.lore.tagline}</span>`);
  const one = bits.map((b) => html`${b}<i aria-hidden="true">✦</i>`);
  const run = Array.from({ length: d.lore.tagline ? 4 : 7 }, () => one);
  return html`<div class="marquee" aria-hidden="true"><div class="mq-track"><div class="mq-run">${run}</div><div class="mq-run">${run}</div></div></div>`;
}

function hero(d, look, n) {
  const k = d.kit;
  const banner = pic(k.banner);
  const logo = (look && look.logo640) || pic(k.logo);
  const name = d.words.name;
  const t = d.words.ticker;
  const L = d.launch;
  const kicker = html`<p class="kicker"><span class="tk">$${t}</span>${L ? html`<span class="live"><i></i>live on ${L.launchpadName}${L.cluster === 'devnet' ? ' (devnet)' : ''}</span>` : html`<span class="live soon-k"><i></i>launching soon</span>`}</p>`;
  const bannerImg = banner ? html`<img src="${banner}" alt="${name} banner" width="1500" height="500" fetchpriority="high">` : '';
  const logoImg = logo ? html`<img class="logo" src="${logo}" alt="${name} logo" width="640" height="640">` : '';
  const text = html`${kicker}<h1 class="${lenClass(name)}">${name}</h1>${d.words.bio ? html`<p class="bio">${d.words.bio}</p>` : ''}${L ? copyBox(L.mint) : ''}${heroActions(d)}${L ? liveStrip(d, n) : ''}`;
  if (look.layout === 'split') {
    return html`<section class="hero hero-split" id="top">
  <div class="hero-text">${text}</div>
  <div class="hero-art">${logoImg}</div>
</section>
${banner ? html`<div class="banner wide" data-reveal>${bannerImg}</div>` : ''}`;
  }
  if (look.layout === 'cover') {
    return html`<section class="hero hero-cover" id="top">
  <div class="cover">${bannerImg}</div>
  <div class="hero-text">${logoImg}${text}</div>
</section>`;
  }
  return html`<section class="hero hero-profile" id="top">
  <div class="banner">${banner && look.skin === 'glow' ? html`<img class="glow" src="${banner}" alt="" aria-hidden="true">` : ''}${bannerImg}</div>
  <div class="hero-row">
    ${logoImg}
    <div class="hero-text">${text}</div>
  </div>
</section>`;
}

function lore(d) {
  const L = d.lore;
  const logo = pic(d.kit.thumb) || pic(d.kit.logo);
  const seed = d.kit.sentence && d.loreWritten ? html`<p class="seed">it started as one sentence: <q>${d.kit.sentence}</q></p>` : '';
  const quote = L.quote && !(d.hide || []).includes('quote')
    ? html`<figure class="quote" data-reveal><blockquote><p>${L.quote}</p></blockquote><figcaption>${logo ? html`<img src="${logo}" alt="" width="44" height="44">` : ''}<span>${d.words.name}</span></figcaption></figure>`
    : '';
  return html`<section class="lore" id="lore" aria-labelledby="lore-h" data-reveal>
  <div class="lore-head">
    <p class="kicker">the lore</p>
    <h2 id="lore-h">${L.tagline || `who is ${d.words.name}?`}</h2>
    ${seed}
  </div>
  <div class="lore-body${(L.story[0] || '').length > 140 ? ' long' : ''}">${L.story.map((p) => html`<p>${p}</p>`)}</div>
</section>
${quote}`;
}

function facts(d) {
  const L = d.launch;
  const items = d.lore.facts.length === 3
    ? d.lore.facts
    : [
        d.kit.sentence ? { title: 'born from one sentence', text: `“${d.kit.sentence}”` } : { title: 'the name', text: d.words.name },
        { title: 'the look', text: d.kit.angle || d.kit.style || `${d.words.name}, drawn for the coin.` },
        { title: 'the ticker', text: `$${d.words.ticker}${L ? `, live on ${L.launchpadName}` : ', launching soon'}.` },
      ];
  return html`<section class="three" aria-label="about ${d.words.name}" data-reveal>
  ${items.map((f, i) => html`<article class="card">
    <span class="card-n">0${i + 1}</span>
    <h3>${f.title}</h3>
    <p>${f.text}</p>
  </article>`)}
</section>`;
}

/** The blocks the owner asked for in the chat (siteedit.js): a title and a few short paragraphs each. */
function extra(d) {
  return (d.sections || []).map((s, i) => html`<section class="more" aria-labelledby="more-${i}" data-reveal>
  <div class="more-head"><p class="kicker">${d.words.name}</p><h2 id="more-${i}">${s.title}</h2></div>
  <div class="more-body">${String(s.text).split(/\n+/).filter(Boolean).map((p) => html`<p>${p}</p>`)}</div>
</section>`);
}

function howToBuy(d) {
  const L = d.launch;
  const t = d.words.ticker;
  const cur = L.currency;
  if (L.cluster === 'devnet') {
    return html`<section class="how" id="buy" aria-labelledby="how-h" data-reveal>
  <div class="how-head"><p class="kicker">how to buy</p><h2 id="how-h">a devnet test coin</h2></div>
  <p class="how-note">$${t} launched on Solana's test network (devnet), so there is nothing to buy with real SOL. on mainnet this section walks through buying it.</p>
</section>`;
  }
  const where = L.pad ? L.launchpadName : 'a Solana swap';
  const after = L.graduates ? ` once its bonding curve fills, it moves to ${L.graduates}.` : '';
  const steps = [
    { ic: 'wallet', h: 'get a wallet', p: 'Phantom, Solflare or Backpack all work, as a phone app or a browser extension.' },
    { ic: 'coin', h: `add some ${cur}`, p: `buy ${cur} inside the wallet, or send some from an exchange you already use.` },
    { ic: 'swap', h: `buy on ${where}`, p: `open $${t} on ${where}, connect your wallet and swap ${cur} for $${t}.${after}`, btn: L.pad && safeHref(L.pad.url) ? html`<a class="btn small" ${ext(safeHref(L.pad.url))}>open on ${L.launchpadName}${icon('out')}</a>` : '' },
    { ic: 'shield', h: 'check the contract', p: html`the real $${t} is <code>${shortMint(L.mint)}</code>. copy it from here and make sure it matches.`, btn: html`<button class="btn small ghost" type="button" data-copy="${L.mint}">${icon('copy')}<span>copy the CA</span></button>` },
  ];
  return html`<section class="how" id="buy" aria-labelledby="how-h" data-reveal>
  <div class="how-head"><p class="kicker">how to buy</p><h2 id="how-h">get $${t} in four steps</h2></div>
  <ol class="steps">
    ${steps.map((s, i) => html`<li class="step">
      <span class="step-n">${icon(s.ic)}<em>${i + 1}</em></span>
      <h3>${s.h}</h3>
      <p>${s.p}</p>
      ${s.btn || ''}
    </li>`)}
  </ol>
</section>`;
}

function theCoin(d, live) {
  const L = d.launch;
  const n = numbers(live.market);
  const chgCls = n.change == null ? '' : n.change >= 0 ? 'up' : 'down';
  const m = live.market;
  const src = !m || !m.source
    ? (L.cluster === 'devnet' ? 'a devnet test coin: numbers come straight from the chain, when there are any.' : 'no market data yet. a new coin shows up on DexScreener within a minute or two.')
    : m.source === 'dexscreener' ? 'live from DexScreener. updates every 30 seconds.' : 'read straight from the chain. updates every 30 seconds.';
  const stat = (k, label, v, cls = '') => html`<div class="stat"><span class="stat-k">${label}</span><b class="stat-v ${cls}" data-n="${k}">${v ?? '—'}</b></div>`;
  const row = (k, v) => html`<div class="fact"><dt>${k}</dt><dd>${v}</dd></div>`;
  const launched = dateOf(L.at);
  const curve = n.progPct != null
    ? html`<div class="curve-box"><div class="curve-top"><span>bonding curve</span><b data-n="prog">${n.prog}</b></div><progress class="curve" max="100" value="${Math.round(n.progPct)}" data-n="progbar" aria-label="bonding curve progress">${n.prog}</progress></div>`
    : '';
  return html`<section class="coin" id="coin" aria-labelledby="coin-h" data-live="${d.coin}" data-mint="${L.mint}" data-reveal>
  <div class="coin-head"><p class="kicker">the coin</p><h2 id="coin-h">$${d.words.ticker} on chain</h2></div>
  <div class="stats-grid">
    ${stat('mcap', 'market cap', n.mcap)}
    ${stat('vol', '24h volume', n.vol)}
    ${stat('chg', '24h change', n.chg, chgCls)}
    ${stat('price', 'price', n.price)}
  </div>
  ${curve}
  <p class="stats-src" data-src>${src}</p>
  <dl class="facts-grid">
    ${row('chain', L.cluster === 'devnet' ? 'Solana devnet (a test launch)' : 'Solana')}
    ${row('launchpad', L.launchpadName + (L.currency !== 'SOL' ? ` · ${L.currency} pair` : ''))}
    ${launched ? row('launched', launched) : ''}
    ${live.supply ? row('supply', Math.round(live.supply).toLocaleString('en-US')) : ''}
    ${row('contract', html`<span class="fact-ca"><code title="${L.mint}">${shortMint(L.mint)}</code><button class="ca-copy small" type="button" data-copy="${L.mint}" aria-label="copy the contract address">${icon('copy')}<span>copy</span></button></span>`)}
    ${row('links', html`<span class="fact-links">${L.chart ? html`<a ${ext(safeHref(L.chart))}>DexScreener${icon('out')}</a>` : ''}<a ${ext(safeHref(L.explorer))}>Solscan${icon('out')}</a>${L.pad ? html`<a ${ext(safeHref(L.pad.url))}>${L.launchpadName}${icon('out')}</a>` : ''}</span>`)}
  </dl>
</section>`;
}

function soon(d) {
  return html`<section class="later" id="soon" aria-labelledby="soon-h" data-reveal>
  <div class="later-text">
    <p class="kicker">not on chain yet</p>
    <h2 id="soon-h">$${d.words.ticker} is launching soon</h2>
    <p>when it launches, its contract address, chart and buy link land right here. until then it lives on ${BRAND.name}.</p>
  </div>
  <a class="btn" href="${`/k/${d.coin}`}" target="_top">see it on ${BRAND.name}${icon('out')}</a>
</section>`;
}

/** The page's own style: its colours and its display face. Answers { css, hash } (the hash goes in the CSP). */
export function themeCss(look) {
  const c = look.colors;
  const f = FONTS[look.font] || FONTS.bricolage;
  const vars = Object.entries({ bg: c.bg, bg2: c.bg2, surface: c.surface, ink: c.ink, ink2: c.ink2, line: c.line, accent: c.accent, 'accent-ink': c.accentInk, pop: c.pop, 'pop-ink': c.popInk })
    .map(([k, v]) => `--${k}:${/^#[0-9a-f]{6}$/.test(v) ? v : '#888888'}`)
    .join(';');
  const css = `:root{${vars};--display:'${f.family}';--ds:${f.scale};--dt:${f.track};--dw:${f.weight}}`;
  return { css, hash: createHash('sha256').update(css).digest('base64') };
}

/** The CSP for a coin's page: our own files, the store's pictures, our own API; the one inline style by its hash. */
export function sitePolicy(styleHash) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'sha256-${styleHash}'`,
    "img-src 'self' data: https://*.public.blob.vercel-storage.com",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/**
 * The whole page. d: coinsite.js pageData(); live: { market, supply } (coinsite.js liveOf) for a launched coin.
 * Answers { html, csp }.
 */
export function renderSite(d, live = { market: null, supply: null }) {
  const look = d.look || DEFAULT_LOOK;
  const f = FONTS[look.font] || FONTS.bricolage;
  const { css, hash } = themeCss(look);
  const name = d.words.name;
  const t = d.words.ticker;
  const L = d.launch;
  const n = numbers(live.market);
  const title = `${name} ($${t})`;
  const desc = (d.words.bio || d.lore.tagline || `${name}, the memecoin.`) + (L ? '' : ' launching soon.');
  const banner = pic(d.kit.banner);
  const icon16 = pic(d.kit.thumb) || pic(d.kit.logo);
  const canonical = safeHref(d.canonical);
  const hide = new Set(d.hide || []);
  const marq = ['poster', 'clean', 'soft', 'arcade', 'glow'].includes(look.skin) && !hide.has('marquee');
  const nav = [html`<a href="#lore">lore</a>`, L && !hide.has('howtobuy') ? html`<a href="#buy">how to buy</a>` : '', L ? html`<a href="#coin">chart</a>` : html`<a href="#soon">launch</a>`];
  const barBtn = L
    ? L.pad && safeHref(L.pad.url) ? html`<a class="btn small" ${ext(safeHref(L.pad.url))}>buy $${t}</a>` : html`<span class="soon small"><i></i>${L.cluster === 'devnet' ? 'devnet test' : 'live'}</span>`
    : html`<span class="soon small"><i></i>launching soon</span>`;
  const footLinks = L
    ? [
        L.pad && safeHref(L.pad.url) ? html`<a ${ext(safeHref(L.pad.url))}>${L.launchpadName}</a>` : '',
        L.chart && safeHref(L.chart) ? html`<a ${ext(safeHref(L.chart))}>chart</a>` : '',
        L.x && safeHref(L.x) ? html`<a ${ext(safeHref(L.x))}>x</a>` : '',
        html`<a ${ext(safeHref(L.explorer))}>explorer</a>`,
      ]
    : [html`<a href="${`/k/${d.coin}`}" target="_top">see it on ${BRAND.name}</a>`];
  const page = html`<!doctype html>
<html lang="en" class="skin-${look.skin} mode-${look.mode} layout-${look.layout} font-${look.font}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${desc}">
${canonical ? html`<link rel="canonical" href="${canonical}">` : ''}
<meta name="theme-color" content="${look.colors.bg}">
<meta name="color-scheme" content="${look.mode}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${name}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
${canonical ? html`<meta property="og:url" content="${canonical}">` : ''}
${banner ? html`<meta property="og:image" content="${banner}">
<meta property="og:image:width" content="1500">
<meta property="og:image:height" content="500">
<meta property="og:image:alt" content="${name} banner">` : ''}
<meta name="twitter:card" content="${banner ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
${banner ? html`<meta name="twitter:image" content="${banner}">` : ''}
${icon16 ? html`<link rel="icon" href="${icon16}">` : ''}
<link rel="preload" href="/coin-site/fonts/${f.file}.woff2?v=${ASSET_V}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/coin-site/site.css?v=${ASSET_V}">
<style>${raw(css)}</style>
</head>
<body>
<a class="skip" href="#main">skip to ${name}</a>
<header class="bar">
  <a class="bar-id" href="#top">${icon16 ? html`<img src="${icon16}" alt="" width="34" height="34">` : ''}<b>${name}</b><span class="tk">$${t}</span></a>
  <nav class="bar-nav" aria-label="sections">${nav}</nav>
  <div class="bar-acts">${barBtn}</div>
</header>
<main id="main">
${hero(d, look, n)}
${marq ? marquee(d) : ''}
${lore(d)}
${hide.has('facts') ? '' : facts(d)}
${extra(d)}
${L && !hide.has('howtobuy') ? howToBuy(d) : ''}
${L ? theCoin(d, live) : soon(d)}
</main>
<footer class="foot">
  <p class="foot-name ${lenClass(name)}" aria-hidden="true">${name}</p>
  <div class="foot-row">
    <div class="foot-id">${icon16 ? html`<img src="${icon16}" alt="" width="44" height="44">` : ''}<div><b>${name}</b><span>$${t}</span></div></div>
    ${L ? copyBox(L.mint, 'small') : ''}
    <nav class="foot-links" aria-label="links">${footLinks}</nav>
    <a class="made" href="${BRAND.site}" target="_top">made on <b>${BRAND.name}</b></a>
  </div>
  <p class="foot-note">$${t} is a memecoin, made for fun. nothing on this page is financial advice.</p>
</footer>
<script src="/coin-site/site.js?v=${ASSET_V}" defer></script>
</body>
</html>
`;
  return { html: page.s, csp: sitePolicy(hash) };
}

/** The page for a slug no coin holds. */
export function renderMissing(slug) {
  const css = ':root{--bg:#f4f4f1;--bg2:#ebebe6;--surface:#fff;--ink:#0b0b0c;--ink2:#5b5b55;--line:#d9d9d3;--accent:#0b0b0c;--accent-ink:#f4f4f1;--pop:#0b0b0c;--pop-ink:#fff}';
  const hash = createHash('sha256').update(css).digest('base64');
  const page = html`<!doctype html>
<html lang="en" class="missing">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nothing here · ${BRAND.name}</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="/coin-site/site.css?v=${ASSET_V}">
<style>${raw(css)}</style>
</head>
<body>
<main class="missing-box">
  <p class="kicker">${BRAND.name}${slug ? html`/${slug}` : ''}</p>
  <h1>no coin lives here yet.</h1>
  <p>every coin made on ${BRAND.name} gets its own website at an address like this one. make one in a sentence.</p>
  <a class="btn" href="/">make a coin</a>
</main>
</body>
</html>
`;
  return { html: page.s, csp: sitePolicy(hash) };
}
