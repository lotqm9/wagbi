// The coins' websites, offline: slugs and claims (first come keeps a name), what a coin's site shows, the keys that
// let a chat change it, the page's escaping and CSP, readable colours whatever the art or the owner picks, the lore
// and edit parsers, and the launch putting the site in the coin's details. Run: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MAX_SLUGS, baseOf, candidates, claimOf, claimSlug, currentKit, ensureSite, isReserved, isSlug, keyOk, primaryOf, siteEvents, siteKey, slugBase, slugOfUrl, siteView,
} from '../api/_lib/sites.js';
import { SKINS, buildLook, cleanLook, contrast, hex, moodScores } from '../api/_lib/looks.js';
import { fallbackLore, parseLore } from '../api/_lib/lore.js';
import { mentionsSite, parseEdit } from '../api/_lib/siteedit.js';
import { esc, renderMissing, renderSite, safeHref, themeCss } from '../api/_lib/sitepage.js';
import { launchFacts } from '../api/_lib/coinsite.js';

/** Blob's own rule, in memory: a path is written once; a list answers what is there. */
function memStore() {
  const m = new Map();
  let t = 1_700_000_000_000;
  return {
    m,
    async create(path, body) {
      if (m.has(path)) return null;
      m.set(path, { body: String(body), at: ++t });
      return `https://store.public.blob.vercel-storage.com/${path}`;
    },
    async json(path) {
      return m.has(path) ? JSON.parse(m.get(path).body) : null;
    },
    async head(path) {
      return m.has(path) ? { url: `https://store.public.blob.vercel-storage.com/${path}`, at: m.get(path).at } : null;
    },
    async list(prefix) {
      return [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => ({ path: k, url: `https://store.public.blob.vercel-storage.com/${k}`, at: m.get(k).at }));
    },
  };
}
const id = (c) => c.repeat(16).slice(0, 16);
const [A, B, C, D] = ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCC', 'DDDDDDDDDDDDDDDD'];

describe('slugs', () => {
  it('are the name, lowercase letters and digits only, accents folded', () => {
    assert.equal(slugBase('pepe bank'), 'pepebank');
    assert.equal(slugBase('Pokémon 2.0'), 'pokemon20');
    assert.equal(slugBase('$PEPE!!'), 'pepe');
    assert.equal(slugBase('Straße'), 'strasse');
    assert.equal(slugBase('🐸🐸', 'FROG'), 'frog');
    assert.equal(slugBase('a very long name that keeps going and going', 'X'), 'averylongnamethatkeepsgoingand');
  });
  it('are never an app path, a reserved word or too short', () => {
    for (const w of ['api', 'coins', 'coin', 'k', 'privacy', 'terms', 'tool', 'admin', 'wagbi', 'launch', 'img', 'vendor', 'site']) {
      assert.ok(isReserved(w), w);
      const b = slugBase(w, 'TICK');
      assert.ok(!isReserved(b), `${w} -> ${b}`);
      assert.ok(isSlug(b), b);
    }
    assert.equal(slugBase('ok', 'OK'), 'okcoin');
    assert.equal(slugBase('x', 'X'), 'xcoin');
    assert.ok(isReserved('coin-site'));
  });
  it('only take the clean form as a path', () => {
    for (const s of ['pepebank', 'pepebank-2', 'agent47-2', 'abc-x7k']) assert.ok(isSlug(s), s);
    for (const s of ['PepeBank', 'ab', 'pepe_bank', 'pepe bank', '-pepe', 'pepe--2', 'pepebank-12345', '../etc', 'a'.repeat(41)]) assert.ok(!isSlug(s), s);
    assert.equal(baseOf('pepebank-2'), 'pepebank');
    assert.deepEqual([...candidates('pepebank', () => 0.5)].slice(0, 3), ['pepebank', 'pepebank-2', 'pepebank-3']);
  });
  it('first come keeps a name; the next coin gets a dash and a number; a coin finds its own again', async () => {
    const s = memStore();
    assert.equal(await claimSlug(s, { base: 'pepebank', coin: A, kit: A }), 'pepebank');
    assert.equal(await claimSlug(s, { base: 'pepebank', coin: B, kit: B }), 'pepebank-2');
    assert.equal(await claimSlug(s, { base: 'pepebank', coin: C, kit: C }), 'pepebank-3');
    assert.equal(await claimSlug(s, { base: 'pepebank', coin: B, kit: B }), 'pepebank-2');
    assert.equal((await claimOf(s, 'pepebank')).coin, A);
    assert.equal(await claimSlug(s, { base: 'agent47', coin: A, kit: A }), 'agent47');
    assert.equal(await claimSlug(s, { base: 'agent47', coin: D, kit: D }), 'agent47-2');
  });
  it('two coins claiming one name at once: exactly one gets it', async () => {
    const s = memStore();
    const [x, y] = await Promise.all([claimSlug(s, { base: 'race', coin: A, kit: A }), claimSlug(s, { base: 'race', coin: B, kit: B })]);
    assert.deepEqual([x, y].sort(), ['race', 'race-2']);
  });
});

describe("a coin's site", () => {
  it('follows the design the chat is on: a new name gets its own slug, an old one comes back, links keep working', async () => {
    const s = memStore();
    const a = await ensureSite(s, { coin: A, kit: A, name: 'pepe bank', ticker: 'PEPEBANK', now: 1000 });
    assert.equal(a.slug, 'pepebank');
    const b = await ensureSite(s, { coin: A, kit: B, name: 'pepe capital', ticker: 'PEPECAP', now: 2000 });
    assert.equal(b.slug, 'pepecapital');
    assert.equal(primaryOf(await siteEvents(s, A)), 'pepecapital');
    const back = await ensureSite(s, { coin: A, kit: A, name: 'pepe bank', ticker: 'PEPEBANK', now: 3000 });
    assert.equal(back.slug, 'pepebank');
    const evs = await siteEvents(s, A);
    assert.equal(primaryOf(evs), 'pepebank');
    assert.equal(currentKit(A, evs, null), A);
    assert.equal((await claimOf(s, 'pepecapital')).coin, A, 'the old link still belongs to the coin');
    const same = await ensureSite(s, { coin: A, kit: A, name: 'pepe bank', ticker: 'PEPEBANK', now: 4000 });
    assert.equal((await siteEvents(s, A)).length, evs.length, 'nothing new when nothing changed');
    assert.equal(same.slug, 'pepebank');
  });
  it("the chat's newest turn wins over an older pick, and a pick after it wins over the turn", async () => {
    const s = memStore();
    await ensureSite(s, { coin: A, kit: B, name: 'two', ticker: 'TWO', now: 1000 });
    const evs = await siteEvents(s, A);
    assert.equal(currentKit(A, evs, { kitId: C, at: 5000 }), C);
    assert.equal(currentKit(A, evs, { kitId: C, at: 500 }), B);
    assert.equal(currentKit(A, [], null), A);
  });
  it('a coin that keeps renaming stops claiming names at the cap', async () => {
    const s = memStore();
    for (let i = 0; i < MAX_SLUGS + 3; i++) await ensureSite(s, { coin: A, kit: A, name: `name number ${'abcdefghij'[i]}`, ticker: 'T', now: 1000 + i });
    const slugs = new Set((await siteEvents(s, A)).map((e) => e.slug));
    assert.equal(slugs.size, MAX_SLUGS);
  });
  it('the address: a launch keeps its own; views carry the path, the full address and when it changed', () => {
    assert.equal(slugOfUrl('https://wagbi.fun/pepebank', 'https://wagbi.fun'), 'pepebank');
    assert.equal(slugOfUrl('https://wagbi.fun/k/AAAAAAAAAAAAAAAA', 'https://wagbi.fun'), null);
    assert.equal(slugOfUrl('https://evil.example/pepebank', 'https://wagbi.fun'), null);
    assert.deepEqual(siteView('pepebank', 'https://wagbi.fun', 7), { slug: 'pepebank', path: '/pepebank', url: 'https://wagbi.fun/pepebank', rev: 7 });
  });
  it("a coin's key opens it and nothing else", () => {
    const k = siteKey(A);
    assert.equal(k.length, 24);
    assert.ok(keyOk(A, k));
    assert.ok(!keyOk(B, k));
    assert.ok(!keyOk(A, k.slice(0, 23) + (k.at(-1) === 'a' ? 'b' : 'a')));
    assert.ok(!keyOk(A, null));
  });
});

// a coin with every field a stranger (or a model) could fill, hostile
const EVIL = '<script>alert(1)</script>"\'><img src=x onerror=alert(2)>';
const kitOf = (o = {}) => ({
  id: A, root: A, name: `toaster ${EVIL}`, ticker: 'TOAST', bio: `bio ${EVIL}`, sentence: `a toaster ${EVIL}`, angle: 'flat vector mascot',
  logo: `https://store.public.blob.vercel-storage.com/kits/${A}/logo.png`, thumb: `https://store.public.blob.vercel-storage.com/kits/${A}/thumb.webp`,
  banner: `https://store.public.blob.vercel-storage.com/kits/${A}/banner.jpg`, ...o,
});
const art = { L: 0.6, C: 0.1, clusters: [{ L: 0.8, C: 0.12, h: 90, w: 0.5 }, { L: 0.5, C: 0.15, h: 200, w: 0.3 }, { L: 0.2, C: 0.05, h: 260, w: 0.2 }] };

describe('the page', () => {
  const pageOf = (launch = null, extra = {}) => {
    const kit = kitOf();
    return renderSite({
      slug: 'toaster', canonical: 'https://wagbi.fun/toaster', coin: A, kit,
      words: { name: kit.name, ticker: kit.ticker, bio: kit.bio }, launch, look: { ...buildLook(kit, art), logo640: null },
      lore: { tagline: `tag ${EVIL}`, story: [`story ${EVIL}`], facts: [{ title: `t ${EVIL}`, text: `x ${EVIL}` }, { title: 'b', text: 'c' }, { title: 'd', text: 'e' }], quote: `q ${EVIL}` },
      loreWritten: true, sections: [{ title: `s ${EVIL}`, text: `p ${EVIL}` }], hide: [], ...extra,
    }, { market: { source: 'dexscreener', mcapUsd: 2600, volume24hUsd: 102, change24hPct: -0.7, priceUsd: 0.0000026, curve: null }, supply: 1e9 });
  };
  it('escapes everything a coin carries: no markup, no handlers get through', () => {
    const { html } = pageOf();
    assert.ok(!html.includes('<script>alert'), 'no script from the words');
    assert.ok(!html.includes('<img src=x'), 'no tag from the words');
    assert.ok(!/onerror=alert/.test(html.replace(/onerror=alert\(2\)&gt;/g, '')), 'no live handler');
    assert.ok(html.includes(esc(`toaster ${EVIL}`)));
    assert.equal((html.match(/<script\b/g) || []).length, 1, 'only our own script tag');
    assert.match(html, /<script src="\/coin-site\/site\.js\?v=\w+" defer><\/script>/);
  });
  it('its one inline style is the hashed theme, and the CSP allows nothing else inline', () => {
    const { html, csp } = pageOf();
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
    const hash = createHash('sha256').update(style).digest('base64');
    assert.ok(csp.includes(`'sha256-${hash}'`));
    assert.ok(csp.includes("script-src 'self'") && !csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
    assert.ok(csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'self'") && csp.includes("base-uri 'none'"));
    assert.ok(!/ style="/.test(html), 'no style attributes (the CSP would block them)');
    assert.match(themeCss({ ...buildLook(kitOf(), art), colors: { ...buildLook(kitOf(), art).colors, bg: 'red;}body{x' } }).css, /--bg:#888888/);
  });
  it('carries link previews with absolute addresses, and the launched parts', () => {
    const L = launchFacts({ mint: 'So11111111111111111111111111111111111111112', launchpad: 'pumpfun', currency: 'SOL', launchedAt: '2026-11-02T17:26:35Z', x: 'https://x.com/toaster' }, 'mainnet');
    const { html } = pageOf(L);
    for (const re of [/<meta property="og:title" content="[^"]+">/, /<meta property="og:image" content="https:\/\/store\.public\.blob\.vercel-storage\.com\/kits\/A{16}\/banner\.jpg">/, /<meta property="og:url" content="https:\/\/wagbi\.fun\/toaster">/, /<meta name="twitter:card" content="summary_large_image">/, /<link rel="canonical" href="https:\/\/wagbi\.fun\/toaster">/]) assert.match(html, re);
    assert.match(html, /href="https:\/\/pump\.fun\/coin\/So11111111111111111111111111111111111111112"/);
    assert.match(html, /data-copy="So11111111111111111111111111111111111111112"/);
    assert.match(html, /how to buy/);
    assert.match(html, /\$2\.6K/);
    assert.match(html, /href="https:\/\/x\.com\/toaster"/);
    assert.match(html, /made on <b>wagbi<\/b>/);
    assert.ok(!pageOf(null).html.includes('how to buy'), 'not before launch');
    assert.match(pageOf(null).html, /launching soon/);
    assert.ok(!pageOf(L, { hide: ['howtobuy', 'quote', 'facts', 'marquee'] }).html.includes('id="buy"'));
  });
  it('only links to https and its own paths; a launch record can not smuggle in a link', () => {
    assert.equal(safeHref('javascript:alert(1)'), null);
    assert.equal(safeHref('http://pump.fun/x'), null);
    assert.equal(safeHref('//evil.example/x'), null);
    assert.equal(safeHref('/k/AAAAAAAAAAAAAAAA'), '/k/AAAAAAAAAAAAAAAA');
    assert.equal(launchFacts({ mint: 'not a mint' }, 'mainnet'), null);
    assert.equal(launchFacts({ mint: 'So11111111111111111111111111111111111111112', x: 'javascript:alert(1)' }, 'mainnet').x, null);
    assert.equal(launchFacts({ mint: 'So11111111111111111111111111111111111111112', launchpad: '<b>' }, 'mainnet').launchpad, 'pumpfun');
  });
  it('an address no coin holds says so (no-store, noindex)', () => {
    const { html } = renderMissing('nothing-1');
    assert.match(html, /no coin lives here yet/);
    assert.match(html, /noindex/);
  });
});

describe('the look', () => {
  const rand = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  it('always reads: body text 7:1, quiet text 4.5:1, the accent and its text 4.5:1, whatever the art', () => {
    const r = rand(42);
    for (let i = 0; i < 300; i++) {
      const clusters = Array.from({ length: 1 + Math.floor(r() * 6) }, () => ({ L: r(), C: r() * 0.3, h: r() * 360, w: r() }));
      const tw = clusters.reduce((a, c) => a + c.w, 0);
      clusters.forEach((c) => { c.w /= tw; });
      const kit = kitOf({ id: `k${String(i).padStart(15, '0')}`, angle: ['pixel art', 'engraved', 'glossy 3d', 'cute plush', 'crude ms paint', 'terminal', ''][i % 7] });
      const look = buildLook(kit, { L: r(), C: r() * 0.2, clusters });
      const c = look.colors;
      assert.ok(contrast(c.ink, c.bg) >= 6.9, `ink ${look.skin} ${JSON.stringify(c)}`);
      assert.ok(contrast(c.ink2, c.bg) >= 4.5, `ink2 ${look.skin} ${JSON.stringify(c)}`);
      assert.ok(contrast(c.accentInk, c.accent) >= 4.5, `accent ${look.skin} ${JSON.stringify(c)}`);
      assert.ok(cleanLook(look), 'a look the page takes');
    }
  });
  it("keeps reading with the owner's own skin, mode and colours", () => {
    const r = rand(7);
    for (let i = 0; i < 200; i++) {
      const o = { skin: SKINS[i % SKINS.length], mode: i % 3 === 0 ? 'dark' : i % 3 === 1 ? 'light' : undefined, accent: hex(r(), r() * 0.3, r() * 360), bg: i % 2 ? hex(r(), r() * 0.2, r() * 360) : undefined, font: 'pixel' };
      const look = buildLook(kitOf({ id: `o${String(i).padStart(15, '0')}` }), art, o);
      const c = look.colors;
      assert.equal(look.skin, o.skin);
      assert.equal(look.font, 'pixel');
      assert.ok(contrast(c.ink, c.bg) >= 6.9 && contrast(c.ink2, c.bg) >= 4.5 && contrast(c.accentInk, c.accent) >= 4.5, JSON.stringify({ o, c }));
    }
  });
  it("reads the coin's mood from its art's style first, then what it is about", () => {
    assert.ok(moodScores({ angle: 'one-bit dither, pixel sprite' }).arcade > 0);
    assert.ok(moodScores({ angle: 'flat vector mascot', sentence: 'a crab who is a strict librarian' }).paper > 0);
    assert.ok(moodScores({ angle: 'glossy 3d vinyl toy' }).glow > moodScores({ angle: 'glossy 3d vinyl toy' }).poster);
    assert.equal(cleanLook({ skin: 'nope' }), null);
  });
});

describe('the words', () => {
  it('lore: four tags in, checked fields out; links, markup and slurs never', () => {
    const ok = parseLore('<tagline>he is not okay</tagline><story>first paragraph about the toaster and his long day at the counter.\n\nsecond one, where he flinches at bread and the fridge is unbothered. https://evil.example</story><facts>known fear: the lever\nritual: counts the seconds\nfavourite: light golden</facts><quote>nobody tell the bagel</quote>');
    assert.equal(ok.tagline, 'he is not okay');
    assert.equal(ok.story.length, 2);
    assert.ok(!ok.story.join(' ').includes('http'));
    assert.equal(ok.facts.length, 3);
    assert.equal(ok.quote, 'nobody tell the bagel');
    assert.equal(parseLore('nothing tagged'), null);
    assert.equal(parseLore('<story>a kike frog who files taxes all day long and never stops, never once.</story>'), null);
    assert.deepEqual(fallbackLore({ name: 'x', bio: 'a bio', sentence: 'an idea.' }).story, ['a bio', 'it started as one sentence: "an idea".']);
  });
  it('edits: only known fields, checked; the coin itself goes back to the maker', () => {
    const e = parseEdit('{"route":"site","reply":"done, it is dark now.","changes":{"mode":"dark","skin":"glow","font":"pixel","accent":"#FF00AA","background":"javascript:x","tagline":"<b>new</b> line","hide":["quote","nope"],"sections":[{"title":"bread","text":"he fears it"}],"evil":1}}');
    assert.deepEqual(Object.keys(e.changes).sort(), ['accent', 'font', 'hide', 'mode', 'sections', 'skin', 'tagline']);
    assert.equal(e.changes.accent, '#ff00aa');
    assert.equal(e.changes.tagline, 'bnew/b line');
    assert.deepEqual(e.changes.hide, ['quote']);
    assert.equal(parseEdit('{"route":"coin","reply":"that is the logo"}').route, 'coin');
    assert.equal(parseEdit('no json'), null);
    assert.ok(mentionsSite('make the website dark'));
    assert.ok(mentionsSite('rewrite the lore so he is a pirate'));
    assert.ok(!mentionsSite('make the logo blue'));
  });
});
