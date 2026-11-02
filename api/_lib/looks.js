// Each coin's website gets its own look, read once from its art and its words, and stored (sites/looks/<kit>.json):
//   palette  the colours of the logo and banner (k-means in OKLab, a perceptual space), turned into a page palette
//            whose text always reads (WCAG contrast is checked and fixed, not hoped for)
//   skin     the page's style, from the coin's mood: what the design says it is (pixel art, an engraving, a glossy toy,
//            a crude drawing...), read from its angle, its picture briefs and its words
//   font     a display face from a small set that suits the skin, served from this site (no outside requests)
//   layout   how the first screen is arranged
// The same kit always gets the same look (the choices that are a toss-up are seeded with its id).
import { readImage } from './images.js';

// ---------- colour ----------
const lin = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const gam = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** sRGB 0..255 -> OKLab [L, a, b]. */
export function oklab(r, g, b) {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function labToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const inGamut = (rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);
/** OKLCH -> #rrggbb, the chroma cut back until it fits sRGB (the hue and lightness kept). */
export function hex(L, C, h) {
  L = Math.max(0, Math.min(1, L));
  const at = (c) => labToLinear(L, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180));
  let c = Math.max(0, C);
  if (!inGamut(at(c))) {
    let lo = 0, hi = c;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid; else hi = mid;
    }
    c = lo;
  }
  return '#' + at(c).map((v) => Math.round(Math.max(0, Math.min(1, gam(Math.max(0, Math.min(1, v))))) * 255).toString(16).padStart(2, '0')).join('');
}
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** WCAG relative luminance of a #rrggbb. */
export const luminance = (h) => {
  const [r, g, b] = rgbOf(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio of two #rrggbb. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const lch = (h) => {
  const [L, a, b] = oklab(...rgbOf(h));
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
};
/** The colour at the given lightness nearest the wanted one that reaches `min` contrast against `bg`. */
function reach(L, C, h, bg, min, dir) {
  for (let i = 0; i <= 60; i++) {
    const c = hex(L, C, h);
    if (contrast(c, bg) >= min) return c;
    L += dir * 0.015;
    if (L < 0 || L > 1) break;
  }
  return dir > 0 ? '#ffffff' : '#000000';
}
/** Text that reads on a fill: near-white or near-black in the fill's own hue, whichever reads better. */
function inkOn(fill, h) {
  const light = hex(0.985, 0.01, h);
  const dark = hex(0.18, 0.03, h);
  return contrast(light, fill) >= contrast(dark, fill) ? light : dark;
}
const mixHex = (a, b, t) => '#' + rgbOf(a).map((v, i) => Math.round(v + (rgbOf(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');
const hueDist = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

// ---------- the art ----------
/** A small seeded random (mulberry32). */
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
/** FNV-1a of a string. */
export function hashOf(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h;
}

/** k-means over OKLab points [{ p: [L, a, b], w }], seeded: clusters [{ L, C, h, w }] heaviest first (w sums to 1). */
export function clusters(points, k = 7, seed = 1) {
  const rand = rng(seed);
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const cents = [points[Math.floor(rand() * points.length)].p.slice()];
  while (cents.length < Math.min(k, points.length)) {
    // k-means++: the next centre far from the ones chosen
    const ds = points.map((x) => Math.min(...cents.map((c) => d2(x.p, c))) * x.w);
    let r = rand() * ds.reduce((a, b) => a + b, 0);
    let i = 0;
    while (i < ds.length - 1 && (r -= ds[i]) > 0) i++;
    cents.push(points[i].p.slice());
  }
  let assign = new Array(points.length).fill(0);
  for (let it = 0; it < 14; it++) {
    assign = points.map((x) => {
      let best = 0, bd = Infinity;
      cents.forEach((c, j) => {
        const d = d2(x.p, c);
        if (d < bd) { bd = d; best = j; }
      });
      return best;
    });
    const sum = cents.map(() => [0, 0, 0, 0]);
    points.forEach((x, i) => {
      const s = sum[assign[i]];
      s[0] += x.p[0] * x.w; s[1] += x.p[1] * x.w; s[2] += x.p[2] * x.w; s[3] += x.w;
    });
    sum.forEach((s, j) => { if (s[3] > 0) cents[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  const weight = cents.map(() => 0);
  points.forEach((x, i) => { weight[assign[i]] += x.w; });
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  return cents
    .map((c, j) => ({ L: c[0], C: Math.hypot(c[1], c[2]), h: ((Math.atan2(c[2], c[1]) * 180) / Math.PI + 360) % 360, w: weight[j] / total }))
    .filter((c) => c.w > 0)
    .sort((a, b) => b.w - a.w);
}

/** The pixels of the logo and the banner, small, as OKLab points (each picture half the weight). */
export async function artPoints(logoBuf, bannerBuf) {
  const out = [];
  const take = async (buf, w, h) => {
    if (!buf) return;
    const { img } = await readImage(buf);
    const { data, info } = await img.resize(w, h, { fit: 'cover' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = [];
    for (let i = 0; i < data.length; i += info.channels) if (data[i + 3] >= 128) px.push(oklab(data[i], data[i + 1], data[i + 2]));
    for (const p of px) out.push({ p, w: 1 / px.length });
  };
  await take(logoBuf, 40, 40);
  await take(bannerBuf, 96, 32);
  return out;
}

// ---------- the mood ----------
export const SKINS = ['clean', 'poster', 'glow', 'paper', 'soft', 'arcade', 'terminal'];
// the style of the art (its angle and picture briefs) says the most; the subject (the idea, the name, the bio) breaks
// the tie, since most coins share the maker's default flat mascot style
const STYLE = {
  arcade: /\b(pixel(s|ated)?|8[- ]?bit|16[- ]?bit|1[- ]?bit|one[- ]bit|dither(ed)?|sprite|arcade|retro game|game ?boy|voxel)\b/g,
  terminal: /\b(terminal|hacker|ascii|crt|command line|monospace|circuit|glitch|matrix)\b/g,
  paper: /\b(engrav\w*|etch\w*|vintage|antique|victorian|old money|certificate|banknote|parchment|newspaper|editorial|woodcut|renaissance|baroque|oil painting|classical|art deco|noir|sepia|crest|heraldic|mid-century|letterpress|ink drawing)\b/g,
  soft: /\b(cute|kawaii|plush(ie)?|pastel|chibi|squish\w*|cozy|fluffy|claymation|clay|vinyl toy|adorable|soft)\b/g,
  glow: /\b(glossy|3d|render(ed)?|cinematic|neon|cosmic|galaxy|chrome|holographic|futur\w*|sci-?fi|glow\w*|dreamy|synthwave|vaporwave|moody|real photo|photo(graph)?)\b/g,
  poster: /\b(ms paint|crude|scribbl\w*|doodle\w*|marker|comic|poster|graffiti|punk|brutal\w*|zine|collage|risograph|halftone|pop art)\b/g,
};
const SUBJECT = {
  arcade: /\b(game|gamer|gaming|arcade|pixel|retro|console|quest|level|boss|joystick)\b/g,
  terminal: /\b(ai|bot|robot|agent|hacker|code|coder|computer|chart|charts|trader|trading|trade|buys|buying|top|dip|degen|algorithm|data|chip|server|leverage|liquidat\w*)\b/g,
  paper: /\b(bank|banker|banking|fund|hedge|finance|financial|stock|stocks|librarian|library|book|books|lawyer|tax|taxes|accountant|office|professor|museum|history|king|queen|royal|butler|detective|newspaper|teller|vault|savings|insur\w*|tea|gentleman|ancient|scroll)\b/g,
  soft: /\b(cute|baby|hug|hugs|cuddl\w*|bakery|baker|pastry|croissant|cake|cookie|candy|sweet|cozy|sleepy|nap|blanket|cactus|flower|garden|bunny|kitten|puppy|duckling|cloud|marshmallow|tiny|smol|soft|lonely|sad)\b/g,
  glow: /\b(space|moon|stars?|galaxy|cosmic|astronaut|orbit|rocket|alien|night|dark|neon|lamp|bulb|light|glow\w*|ghost|dream\w*|deep sea|jellyfish|arctic|ice|lava|fire)\b/g,
  poster: /\b(crude|wojak|pepe|meme|comic|punk|loud|angry|scared|scream\w*|chaos|rage|panic\w*|frantic|sprint\w*|rush\w*|bus|bread|toaster)\b/g,
};
/** How strongly each skin fits the coin: its art's style counts most, then what it is about. */
export function moodScores(kit) {
  const count = (re, text) => new Set(String(text || '').toLowerCase().match(re) || []).size;
  const style = `${kit.angle || ''} ${kit.style || ''}`;
  const briefs = `${kit.prompts?.logo || ''} ${kit.prompts?.banner || ''}`.slice(0, 2400);
  const about = `${kit.sentence || ''} ${kit.name || ''} ${kit.bio || ''}`;
  const scores = {};
  for (const k of Object.keys(STYLE)) scores[k] = count(STYLE[k], style) * 3 + count(STYLE[k], briefs) + count(SUBJECT[k], about) * 2 + count(SUBJECT[k], style);
  return scores;
}

const FONTS = {
  clean: ['bricolage', 'unbounded', 'rubik800'],
  poster: ['archivo', 'bungee', 'rubik900'],
  glow: ['unbounded', 'bricolage'],
  paper: ['instrument'],
  soft: ['fredoka', 'rubik800'],
  arcade: ['pixel'],
  terminal: ['spacemono'],
};
const LAYOUTS = {
  clean: ['profile', 'split'],
  poster: ['split'],
  glow: ['cover', 'profile'],
  paper: ['split'],
  soft: ['split', 'profile'],
  arcade: ['profile'],
  terminal: ['cover', 'split'],
};
const DARK = new Set(['glow', 'arcade', 'terminal']);
const LIGHT = new Set(['paper', 'soft', 'poster']);
// for art with no colour of its own (black and white, greys): an accent that is a choice, not a default
const SPARE_HUES = [25, 145, 265, 330, 85, 200];

const ALL_FONTS = new Set(Object.values(FONTS).flat());
const HEX6 = /^#[0-9a-f]{6}$/i;

/**
 * The look from the art's colours and the coin's words. art: { clusters, L (mean lightness), C (mean chroma) }.
 * o: what the coin's owner chose in its chat (siteedit.js): { skin, font, mode, accent, bg }, each optional.
 * Answers { v, skin, font, layout, mode, colors: { bg, bg2, surface, ink, ink2, line, accent, accentInk, pop, popInk } }.
 */
export function buildLook(kit, art, o = {}) {
  const seed = hashOf(kit.id || kit.name || 'coin');
  const pick = (arr, salt = 0) => arr[(seed >>> salt) % arr.length];
  const scores = moodScores(kit);
  const top = Math.max(...Object.values(scores));
  let skin;
  if (SKINS.includes(o.skin)) skin = o.skin;
  else if (top > 0) {
    const tied = Object.keys(scores).filter((k) => scores[k] === top);
    skin = pick(tied, 3);
  } else {
    skin = art.L < 0.38 ? 'glow' : art.C > 0.1 ? pick(['poster', 'clean'], 5) : pick(['clean', 'soft', 'paper'], 5);
  }
  const font = ALL_FONTS.has(o.font) ? o.font : pick(FONTS[skin], 7);
  const layout = pick(LAYOUTS[skin], 11);

  const cl = art.clusters.length ? art.clusters : [{ L: 0.5, C: 0, h: 0, w: 1 }];
  const dom = cl[0];
  const colourful = cl.filter((c) => c.C > 0.05 && c.w > 0.015);
  const vivid = colourful.slice().sort((a, b) => b.C * b.w ** 0.3 - a.C * a.w ** 0.3)[0] || null;
  const vh = vivid ? vivid.h : SPARE_HUES[seed % SPARE_HUES.length];
  const vc = vivid ? Math.max(0.1, Math.min(0.2, vivid.C * 1.15)) : 0.17;
  const second = colourful.filter((c) => vivid && hueDist(c.h, vh) > 50).sort((a, b) => b.C * b.w ** 0.3 - a.C * a.w ** 0.3)[0];
  const dh = dom.C > 0.03 ? dom.h : vh;
  const dc = Math.min(dom.C, 0.08);
  const natural = DARK.has(skin) ? 'dark' : LIGHT.has(skin) ? 'light' : art.L < 0.42 ? 'dark' : 'light';
  const mode = o.mode === 'dark' || o.mode === 'light' ? o.mode : natural;
  // a mode the skin doesn't have by nature takes the plain palette of that mode, and keeps the skin's shapes
  const own = mode === natural;

  let bg = null, bg2, surface, ink, ink2, accent, pop;
  if (!own) {
    // drawn below
  } else if (skin === 'poster') {
    bg = hex(0.84, Math.max(0.09, Math.min(0.15, vc)), vh);
    bg2 = hex(0.78, Math.max(0.1, Math.min(0.16, vc)), vh);
    surface = hex(0.985, 0.012, vh);
    ink = hex(0.17, 0.02, vh);
    ink2 = hex(0.33, 0.04, vh);
    accent = ink;
    pop = second ? hex(0.7, Math.min(0.19, second.C * 1.2), second.h) : hex(0.7, 0.18, (vh + 150) % 360);
  } else if (skin === 'paper') {
    const ph = dc > 0.02 ? dh : 80;
    bg = hex(0.955, 0.02, ph);
    bg2 = hex(0.925, 0.025, ph);
    surface = hex(0.975, 0.014, ph);
    ink = hex(0.22, 0.025, 55);
    ink2 = hex(0.44, 0.025, 55);
    accent = hex(0.47, Math.min(0.15, vc), vh);
    pop = hex(0.62, Math.min(0.12, vc), vh);
  } else if (skin === 'soft') {
    bg = hex(0.945, 0.04, dc > 0.03 ? dh : vh);
    bg2 = hex(0.91, 0.055, dc > 0.03 ? dh : vh);
    surface = hex(0.99, 0.012, vh);
    ink = hex(0.27, 0.06, dc > 0.03 ? dh : vh);
    ink2 = hex(0.45, 0.05, dc > 0.03 ? dh : vh);
    accent = hex(0.66, Math.min(0.17, vc), vh);
    pop = second ? hex(0.8, 0.1, second.h) : hex(0.82, 0.09, (vh + 60) % 360);
  } else if (skin === 'arcade') {
    bg = hex(0.17, 0.06, dc > 0.04 ? dh : 285);
    bg2 = hex(0.21, 0.07, dc > 0.04 ? dh : 285);
    surface = hex(0.22, 0.07, dc > 0.04 ? dh : 285);
    ink = hex(0.97, 0.02, vh);
    ink2 = hex(0.78, 0.05, vh);
    accent = hex(0.84, 0.2, vh);
    pop = second ? hex(0.8, 0.2, second.h) : hex(0.8, 0.2, (vh + 120) % 360);
  } else if (skin === 'terminal') {
    bg = hex(0.135, 0.012, dh);
    bg2 = hex(0.16, 0.014, dh);
    surface = hex(0.175, 0.015, dh);
    ink = hex(0.94, 0.02, vh);
    ink2 = hex(0.72, 0.03, vh);
    accent = hex(0.83, Math.min(0.19, vc), vh);
    pop = hex(0.83, 0.12, (vh + 40) % 360);
  }
  // the plain palettes: the clean and glow skins' own, and any skin in the mode it doesn't have by nature
  if (!bg && mode === 'dark') {
    bg = hex(0.15, 0.03 + dc * 0.2, dh);
    bg2 = hex(0.19, 0.035 + dc * 0.2, dh);
    surface = hex(0.205, 0.035 + dc * 0.2, dh);
    ink = hex(0.97, 0.01, dh);
    ink2 = hex(0.76, 0.02, dh);
    accent = hex(0.79, Math.min(0.18, vc), vh);
    pop = second ? hex(0.75, Math.min(0.16, second.C), second.h) : hex(0.75, 0.14, (vh + 50) % 360);
  } else if (!bg) {
    bg = hex(0.975, Math.min(0.015, dc * 0.3), dh);
    bg2 = hex(0.95, Math.min(0.022, dc * 0.35 + 0.004), dh);
    surface = hex(0.995, 0.004, dh);
    ink = hex(0.2, 0.02, dh);
    ink2 = hex(0.44, 0.02, dh);
    accent = hex(0.57, Math.min(0.2, vc), vh);
    pop = second ? hex(0.72, Math.min(0.16, second.C), second.h) : hex(0.74, 0.13, (vh + 40) % 360);
  }

  // the owner's own colours: the page (its text follows it) and the accent
  if (HEX6.test(o.bg || '')) {
    const [oL, oC, oH] = lch(o.bg.toLowerCase());
    const d = oL < 0.6;
    ink = d ? hex(0.985, 0.008, oH) : hex(0.18, 0.02, oH);
    // the owner's colour at a lightness its text reads on: its hue and strength kept, a mid tone moved off the middle
    bg = reach(oL, oC, oH, ink, 7.2, d ? -1 : 1);
    const [bL, bC, bH] = lch(bg);
    bg2 = hex(bL + (d ? 0.035 : -0.03), bC, bH);
    surface = reach(bL + (d ? 0.04 : 0.02), Math.min(bC, 0.04), bH, ink, 7.2, d ? -1 : 1);
    ink2 = d ? hex(0.8, 0.02, bH) : hex(0.42, 0.02, bH);
  }
  // (an accent the owner picked is the page's highlight everywhere, the skin's own second colour included)
  if (HEX6.test(o.accent || '')) accent = pop = o.accent.toLowerCase();

  // the rules every look keeps: body text reads (7:1 on the page, 4.5:1 for the quieter text and on a card), the
  // accent stands out from the page and its own text reads on it
  const dark = luminance(bg) < 0.2;
  const [iL, iC, iH] = lch(ink);
  if (contrast(ink, bg) < 7) ink = reach(iL, iC, iH, bg, 7, dark ? 1 : -1);
  if (contrast(ink, surface) < 7) ink = reach(lch(ink)[0], iC, iH, surface, 7, dark ? 1 : -1);
  const [jL, jC, jH] = lch(ink2);
  if (contrast(ink2, bg) < 4.6) ink2 = reach(jL, jC, jH, bg, 4.6, dark ? 1 : -1);
  if (contrast(ink2, surface) < 4.6) ink2 = reach(lch(ink2)[0], jC, jH, surface, 4.6, dark ? 1 : -1);
  if (skin !== 'poster') {
    const [aL, aC, aH] = lch(accent);
    if (contrast(accent, bg) < 3) accent = reach(aL, aC, aH, bg, 3, dark ? 1 : -1);
  }
  let accentInk = inkOn(accent, lch(accent)[2]);
  if (contrast(accentInk, accent) < 4.5) {
    const [aL, aC, aH] = lch(accent);
    const lightInk = luminance(accentInk) > 0.5;
    accent = reach(aL, aC, aH, accentInk, 4.5, lightInk ? -1 : 1);
    accentInk = inkOn(accent, aH);
  }
  const popInk = inkOn(pop, lch(pop)[2]);
  const line = mixHex(bg, ink, dark ? 0.16 : 0.13);
  return { v: 1, skin, font, layout, mode: dark ? 'dark' : 'light', colors: { bg, bg2, surface, ink, ink2, line, accent, accentInk, pop, popInk } };
}

/** What the art says, from its pictures: { clusters, L, C }. */
export async function readArt(logoBuf, bannerBuf, seed = 1) {
  const pts = await artPoints(logoBuf, bannerBuf);
  if (!pts.length) return { clusters: [], L: 0.5, C: 0 };
  const total = pts.reduce((a, p) => a + p.w, 0);
  const L = pts.reduce((a, p) => a + p.p[0] * p.w, 0) / total;
  const C = pts.reduce((a, p) => a + Math.hypot(p.p[1], p.p[2]) * p.w, 0) / total;
  return { clusters: clusters(pts, 7, seed), L, C };
}

/** The logo at 640 px as WebP (the site shows it large; the original PNG is ten times the weight). */
export async function logoWebp(logoBuf) {
  const { img } = await readImage(logoBuf);
  return img.resize(640, 640, { fit: 'cover' }).webp({ quality: 84 }).toBuffer();
}

const COLOR = /^#[0-9a-f]{6}$/;
/** A stored look, checked field by field before the page uses it (it goes into the page's style). */
export function cleanLook(l) {
  if (!l || typeof l !== 'object' || !SKINS.includes(l.skin) || !LAYOUTS[l.skin]?.includes(l.layout) || !ALL_FONTS.has(l.font)) return null;
  const c = l.colors || {};
  const keys = ['bg', 'bg2', 'surface', 'ink', 'ink2', 'line', 'accent', 'accentInk', 'pop', 'popInk'];
  if (!keys.every((k) => COLOR.test(c[k] || ''))) return null;
  const art = l.art && Array.isArray(l.art.clusters) ? { L: Number(l.art.L) || 0.5, C: Number(l.art.C) || 0, clusters: l.art.clusters.slice(0, 8).filter((x) => x && [x.L, x.C, x.h, x.w].every(Number.isFinite)) } : null;
  return { v: 1, skin: l.skin, font: l.font, layout: l.layout, mode: l.mode === 'dark' ? 'dark' : 'light', colors: Object.fromEntries(keys.map((k) => [k, c[k]])), art, logo640: typeof l.logo640 === 'string' && /^https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com\/sites\/looks\/[A-Za-z0-9_-]{16}\.webp$/.test(l.logo640) ? l.logo640 : null };
}
