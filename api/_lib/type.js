// The coin's name on its banner, set in real type by code (2026-11-02). The image model paints the banner with no
// words and leaves a calm, empty space for the name (art.js asks it to); this sets the name and the $TICKER there with
// a real font from api/_fonts, in a lockup that suits the picture's art direction: Comic Neue like MS Paint's text
// tool, Bangers comic lettering, the Anton meme caption, riso ink printed slightly out of register, wood type... It
// looks at the picture first:
//   where the calm space really is: the least busy place (the summed edges of the picture), the side the design asked
//     for unless it is clearly busier than another, and never under the profile picture X puts over the lower left;
//   which colours the picture is made of: the type takes its ink from them, so it belongs to the picture;
//   how light and how busy the ground under the words is: an outline, a halo or a darker ink when they would not read.
// setTitle(jpg, { name, ticker, lockup, at }) -> { jpg, spec }   a 1500 x 500 JPEG in, the same size out
// Fonts: resvg with only the lockup's own files (a missing glyph falls back to Rubik), so a title renders in a few
// tens of ms. The fonts are OFL (google/fonts), cut to static weights where they are variable (resvg ignores axes).
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const W = 1500;
export const H = 500;
/** Where X's profile picture covers the banner (desktop: a circle about 133 px across at 600 px wide). */
export const AVATAR = { x: 0, y: 318, w: 400, h: 182 };

const FONT_DIR = fileURLToPath(new URL('../_fonts/', import.meta.url));
const FILES = {
  'Comic Neue': { 700: 'ComicNeue-Bold.ttf' },
  Bangers: { 400: 'Bangers-Regular.ttf' },
  Anton: { 400: 'Anton-Regular.ttf' },
  'Titan One': { 400: 'TitanOne-Regular.ttf' },
  'Alfa Slab One': { 400: 'AlfaSlabOne-Regular.ttf' },
  Fraunces: { 900: 'Fraunces-900.ttf' },
  UnifrakturMaguntia: { 400: 'UnifrakturMaguntia-Book.ttf' },
  'Gochi Hand': { 400: 'GochiHand-Regular.ttf' },
  'Saira Stencil One': { 400: 'SairaStencilOne-Regular.ttf' },
  Jost: { 700: 'Jost-700.ttf' },
  'Press Start 2P': { 400: 'PressStart2P-Regular.ttf' },
  'Archivo Black': { 400: 'ArchivoBlack-Regular.ttf' },
  'Instrument Serif': { 400: 'InstrumentSerif-Regular.ttf' },
  'Space Mono': { 400: 'SpaceMono-Regular.ttf', 700: 'SpaceMono-Bold.ttf' },
  'Bricolage Grotesque': { 700: 'BricolageGrotesque-700.ttf' },
  Rubik: { 700: 'Rubik-700.ttf' },
};
const fileOf = ([family, weight]) => join(FONT_DIR, FILES[family]?.[weight] ?? Object.values(FILES[family] || FILES.Rubik)[0]);

// The lockups. fill/stroke/shadow colours are roles, resolved against the picture (see colourOf) or fixed hex.
// track: letter-spacing in em. lead: line advance in em. max: the biggest the name is set, in px on a 1500 banner.
export const LOCKUPS = {
  paint: { about: "Comic Neue in pure red or black, like MS Paint's text tool", font: ['Comic Neue', 700], fill: 'paint', crisp: true, tilt: -2, max: 150, lead: 1.05 },
  macro: { about: 'tall white caps with a black outline, the classic meme caption', font: ['Anton', 400], upper: true, track: 0.015, fill: '#ffffff', stroke: ['#000000', 0.09], max: 175, lead: 1.0 },
  comic: { about: 'Bangers comic lettering, bright with a black outline and a hard shadow, tilted', font: ['Bangers', 400], upper: true, track: 0.04, fill: 'bright', stroke: ['#111111', 0.07], shadow: ['#111111', 0.05, 0.07], tilt: -4, max: 165, lead: 0.98 },
  riso: { about: "heavy grotesk caps in the print's ink, its second ink printed out of register under it", font: ['Archivo Black', 400], upper: true, track: -0.01, fill: 'ink', misreg: 'ink2', max: 140, lead: 0.92, tickerFont: ['Space Mono', 700] },
  pixel: { about: 'Press Start 2P, crisp, with a hard pixel shadow', font: ['Press Start 2P', 400], upper: true, fill: 'light', shadow: ['dark', 0.125, 0.125], crisp: true, steps: [120, 96, 80, 64, 48, 40], max: 120, lead: 1.3 },
  cartoon: { about: 'Titan One, bouncy letters with a thick outline', font: ['Titan One', 400], fill: 'bright', stroke: ['dark', 0.1], bounce: true, max: 145, lead: 1.02 },
  sticker: { about: 'Titan One cut out like a sticker: a thick white edge and a soft shadow', font: ['Titan One', 400], fill: 'bright', stroke: ['dark', 0.05], cut: ['#ffffff', 0.2], max: 135, lead: 1.04 },
  woodtype: { about: 'Alfa Slab One wood type, inked and a little rough', font: ['Alfa Slab One', 400], upper: true, track: 0.02, fill: 'ink', rough: true, max: 130, lead: 0.98 },
  poster: { about: 'Anton tall caps, light on the picture with a dark offset shadow', font: ['Anton', 400], upper: true, track: 0.03, fill: 'light', shadow: ['dark', 0.035, 0.035], max: 180, lead: 0.98 },
  deco: { about: 'Jost caps with wide tracking, like a travel poster', font: ['Jost', 700], upper: true, track: 0.14, fill: 'light', shadow: ['dark', 0.03, 0.03], max: 105, lead: 1.08 },
  label: { about: 'Fraunces Black, a retro label title with an outline and a shadow', font: ['Fraunces', 900], fill: 'light', stroke: ['dark', 0.06], shadow: ['dark', 0.05, 0.06], max: 140, lead: 0.98 },
  storybook: { about: 'Fraunces Black in lowercase ink, like a picture book cover', font: ['Fraunces', 900], lower: true, track: -0.01, fill: 'ink', max: 135, lead: 1.0 },
  strip: { about: 'white caps on black paper strips, ransom-note style', font: ['Archivo Black', 400], upper: true, fill: '#ffffff', plate: '#0d0d0d', jitter: true, max: 96, lead: 1.34 },
  engraved: { about: 'Instrument Serif caps with wide tracking between thin rules, like a banknote', font: ['Instrument Serif', 400], upper: true, track: 0.12, fill: 'ink', rules: true, max: 120, lead: 1.0, tickerFont: ['Space Mono', 400] },
  marker: { about: 'Gochi Hand, hand-written in a crayon colour', font: ['Gochi Hand', 400], fill: 'bright', tilt: -3, max: 150, lead: 1.02 },
  blackletter: { about: 'UnifrakturMaguntia blackletter, in ink', font: ['UnifrakturMaguntia', 400], fill: 'ink', max: 135, lead: 1.05, tickerFont: ['Instrument Serif', 400] },
  mono: { about: 'Space Mono bold caps between thin rules, technical', font: ['Space Mono', 700], upper: true, track: 0.06, fill: 'ink', rules: true, max: 96, lead: 1.12 },
  stencil: { about: 'Saira Stencil caps, sprayed with a soft overspray', font: ['Saira Stencil One', 400], upper: true, track: 0.02, fill: 'bright', spray: true, max: 145, lead: 0.98 },
  doge: { about: 'Comic Neue, each word a different bright colour, like the doge meme', font: ['Comic Neue', 700], lower: true, fill: 'rainbow', tilt: -3, max: 120, lead: 1.15 },
  clean: { about: 'Bricolage Grotesque bold, plain and modern', font: ['Bricolage Grotesque', 700], track: -0.03, fill: 'ink', max: 150, lead: 0.96 },
};
export const LOCKUP_IDS = Object.keys(LOCKUPS);
export const lockupList = () => LOCKUP_IDS.map((id) => `- ${id}: ${LOCKUPS[id].about}`).join('\n');
export const lockupOf = (v) => {
  const k = String(v || '').trim().toLowerCase();
  return LOCKUPS[k] ? k : LOCKUP_IDS.find((id) => k.includes(id)) || null;
};

// the places a title can go; the planned one first. align: how the lines line up.
export const SPOTS = {
  right: { x0: 790, x1: 1444, y0: 40, y1: 460, align: 'start' },
  left: { x0: 60, x1: 720, y0: 36, y1: 312, align: 'start' },
  top: { x0: 250, x1: 1250, y0: 28, y1: 236, align: 'middle' },
  center: { x0: 330, x1: 1170, y0: 70, y1: 430, align: 'middle' },
};

// ---------- colour ----------

const hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
/** WCAG relative luminance, 0..1. */
export const luminance = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
/** WCAG contrast ratio, 1..21. */
export const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const satOf = (c) => {
  const mx = Math.max(...c), mn = Math.min(...c);
  return mx === 0 ? 0 : (mx - mn) / mx;
};
/** How vivid a colour looks: its chroma, weighted toward the brighter ones (a dark saturated green is not bright). */
const vividOf = (c) => ((Math.max(...c) - Math.min(...c)) / 255) * (0.45 + 0.55 * (Math.max(...c) / 255));
const hueOf = (c) => {
  const [r, g, b] = c.map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const mix = (c, to, t) => c.map((v, i) => v + (to[i] - v) * t);
const BLACK = [12, 12, 14], WHITE = [250, 248, 242];
/** c pushed toward black or white until it reads on bg at `ratio` (or as far as it goes). */
function readable(c, bg, ratio) {
  const to = luminance(bg) > 0.4 ? BLACK : WHITE;
  let out = c;
  for (let t = 0; t <= 1.0001 && contrast(out, bg) < ratio; t += 0.1) out = mix(c, to, t);
  return out;
}

/** The picture's main colours, by k-means on a small copy: [{ c: [r, g, b], w: share }], biggest first. */
export function paletteOf(px, n = 6) {
  const N = px.length / 3;
  const pts = [];
  for (let i = 0; i < N; i++) pts.push([px[i * 3], px[i * 3 + 1], px[i * 3 + 2]]);
  // start from colours spread across the brightness range (deterministic: the same picture, the same palette)
  const byL = [...pts].sort((a, b) => luminance(a) - luminance(b));
  let cs = Array.from({ length: n }, (_, k) => byL[Math.min(N - 1, Math.floor(((k + 0.5) / n) * N))].slice());
  let assign = new Int32Array(N);
  for (let it = 0; it < 8; it++) {
    const sum = cs.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < N; i++) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < cs.length; k++) {
        const d = (pts[i][0] - cs[k][0]) ** 2 + (pts[i][1] - cs[k][1]) ** 2 + (pts[i][2] - cs[k][2]) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      assign[i] = best;
      const s = sum[best];
      s[0] += pts[i][0]; s[1] += pts[i][1]; s[2] += pts[i][2]; s[3]++;
    }
    cs = cs.map((c, k) => (sum[k][3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : c));
  }
  const counts = new Array(cs.length).fill(0);
  for (let i = 0; i < N; i++) counts[assign[i]]++;
  return cs.map((c, k) => ({ c, w: counts[k] / N })).filter((p) => p.w > 0.004).sort((a, b) => b.w - a.w);
}

/** A colour role (or a #hex) resolved against the ground under the words and the picture's palette. */
export function colourOf(role, { bg, palette, other = null, alone = false }) {
  if (/^#[0-9a-f]{6}$/i.test(role)) return rgbOf(role);
  const light = luminance(bg) > 0.4;
  const pal = palette.map((p) => p.c);
  const most = (score, list = pal) => list.reduce((a, c) => (score(c) > score(a) ? c : a), list[0] || (light ? BLACK : WHITE));
  if (role === 'ink') {
    // a colour the picture is printed in that stands off the ground: dark on light paper, light on a dark ground
    const cands = pal.filter((c) => contrast(c, bg) >= 2.2);
    const pick = cands.length ? most((c) => contrast(c, bg) * (0.6 + satOf(c)), cands) : light ? BLACK : WHITE;
    return readable(pick, bg, 4.5);
  }
  if (role === 'ink2') {
    // the riso's second ink: another hue the picture has, else the first ink's hue turned well away
    const h0 = hueOf(other || BLACK);
    const cands = pal.filter((c) => satOf(c) > 0.3 && Math.min(Math.abs(hueOf(c) - h0), 360 - Math.abs(hueOf(c) - h0)) > 50);
    return cands.length ? most((c) => satOf(c), cands) : light ? [255, 72, 176] : [0, 120, 191];
  }
  if (role === 'light') return readable(mix(most((c) => luminance(c)), WHITE, 0.55), BLACK, 12);
  if (role === 'dark') return readable(mix(most((c) => -luminance(c)), BLACK, 0.4), WHITE, 12);
  if (role === 'bright') {
    // the picture's loudest colour that still stands off the ground, else a warm yellow or red
    const need = alone ? 2.6 : 1.8;
    const cands = pal.filter((c) => vividOf(c) > 0.32 && contrast(c, bg) >= need);
    if (cands.length) return most((c) => vividOf(c) * Math.min(3, contrast(c, bg)), cands);
    return [[255, 214, 51], [232, 41, 28], [20, 90, 230]].find((c) => contrast(c, bg) >= need) || readable([232, 41, 28], bg, need);
  }
  if (role === 'paint') {
    // MS Paint's own: red, else black, blue or white, whichever reads
    return [[255, 0, 0], [0, 0, 0], [0, 0, 255], [255, 255, 255]].find((c) => contrast(c, bg) >= 3) || (light ? [0, 0, 0] : [255, 255, 255]);
  }
  return light ? BLACK : WHITE;
}
const RAINBOW = ['#ff00ff', '#00b300', '#0080ff', '#ff7f00', '#ffd700', '#00c8c8', '#ff3030'].map(rgbOf);

// ---------- looking at the picture ----------

/**
 * The busyness of each 10 x 10 px cell of a 1500 x 500 banner (the summed edges at 300 x 100), a little blurred so a
 * busy thing makes its neighbourhood busy too, as an integral image; and its colours at 150 x 50.
 */
async function lookAt(jpg) {
  const gw = 300, gh = 100, cw = 150, ch = 50;
  const g = await sharp(jpg).resize(gw, gh, { fit: 'fill' }).greyscale().raw().toBuffer();
  const cell = new Float64Array(cw * ch);
  for (let y = 1; y < gh; y++) {
    for (let x = 1; x < gw; x++) {
      const i = y * gw + x;
      const e = Math.abs(g[i] - g[i - 1]) + Math.abs(g[i] - g[i - gw]);
      cell[(y >> 1) * cw + (x >> 1)] += e;
    }
  }
  // a 3 x 3 box blur
  const busy = new Float64Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= cw || Y >= ch) continue;
        s += cell[Y * cw + X]; n++;
      }
      busy[y * cw + x] = s / n;
    }
  }
  const mean = busy.reduce((a, b) => a + b, 0) / busy.length || 1;
  const sat = new Float64Array((cw + 1) * (ch + 1));
  for (let y = 0; y < ch; y++) {
    let row = 0;
    for (let x = 0; x < cw; x++) {
      row += busy[y * cw + x] / mean;
      sat[(y + 1) * (cw + 1) + x + 1] = sat[y * (cw + 1) + x + 1] + row;
    }
  }
  const rgb = await sharp(jpg).resize(cw, ch, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  return { cw, ch, sat, rgb, palette: paletteOf(rgb) };
}

/** The mean busyness (1 = the picture's average) of a box in banner px. */
function busyIn(look, x, y, w, h) {
  const { cw, ch, sat } = look;
  const x0 = Math.max(0, Math.floor(x / 10)), y0 = Math.max(0, Math.floor(y / 10));
  const x1 = Math.min(cw, Math.ceil((x + w) / 10)), y1 = Math.min(ch, Math.ceil((y + h) / 10));
  if (x1 <= x0 || y1 <= y0) return 9;
  const S = cw + 1;
  const sum = sat[y1 * S + x1] - sat[y0 * S + x1] - sat[y1 * S + x0] + sat[y0 * S + x0];
  return sum / ((x1 - x0) * (y1 - y0));
}

/** The mean colour of a box and how much its brightness varies. */
function groundIn(look, x, y, w, h) {
  const { cw, ch, rgb } = look;
  const x0 = Math.max(0, Math.floor(x / 10)), y0 = Math.max(0, Math.floor(y / 10));
  const x1 = Math.min(cw, Math.ceil((x + w) / 10)), y1 = Math.min(ch, Math.ceil((y + h) / 10));
  const s = [0, 0, 0];
  const ls = [];
  for (let Y = y0; Y < y1; Y++) for (let X = x0; X < x1; X++) {
    const i = (Y * cw + X) * 3;
    s[0] += rgb[i]; s[1] += rgb[i + 1]; s[2] += rgb[i + 2];
    ls.push(luminance([rgb[i], rgb[i + 1], rgb[i + 2]]));
  }
  const n = Math.max(1, ls.length);
  const mean = s.map((v) => v / n);
  const ml = ls.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(ls.reduce((a, b) => a + (b - ml) ** 2, 0) / n);
  return { bg: mean, sd };
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---------- the type ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const fam = (f) => `${f[0]}, Rubik`;

/** The ways to break a name into lines: one line, and for names of 2+ words, two (and three) balanced lines. */
export function lineOptions(text) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [[words.join(' ')]];
  if (words.length >= 2) {
    let best = null;
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
      const score = Math.max(a.length, b.length);
      if (!best || score < best[0]) best = [score, [a, b]];
    }
    out.push(best[1]);
  }
  if (words.length >= 4) {
    const per = Math.ceil(words.length / 3);
    out.push([words.slice(0, per).join(' '), words.slice(per, 2 * per).join(' '), words.slice(2 * per).join(' ')].filter(Boolean));
  }
  return out;
}

/** The title's SVG body at a size, its origin at 0,0 (the first baseline), colours given. */
function titleBody(spec, lines, ticker, size, align, colours, ids = 't') {
  const L = spec;
  const s = size;
  const anchor = align === 'middle' ? 'middle' : 'start';
  const tSize = L.steps ? [48, 40, 32, 24, 16].find((v) => v <= s * 0.45) ?? 16 : Math.round(Math.max(26, Math.min(64, s * 0.3)));
  const tFont = L.tickerFont || L.font;
  const tTrack = (L.tickerFont ? 0.08 : (L.track ?? 0) + 0.02) * tSize;
  const lead = L.lead * s;
  const capsOnly = L.upper;
  const lastBase = (lines.length - 1) * lead;
  const tBase = lastBase + (capsOnly ? 0.24 : 0.34) * s + 0.74 * tSize;
  const crisp = L.crisp ? ' text-rendering="optimizeSpeed"' : '';
  const track = (L.track ?? 0) * s;
  const nameAttrs = `font-family="${fam(L.font)}" font-weight="${L.font[1]}" font-size="${s}" letter-spacing="${track.toFixed(2)}" text-anchor="${anchor}"${crisp}`;
  const tickAttrs = `font-family="${fam(tFont)}" font-weight="${tFont[1]}" font-size="${tSize}" letter-spacing="${tTrack.toFixed(2)}" text-anchor="${anchor}"${crisp}`;
  const bounce = (t) => {
    if (!L.bounce) return '';
    const r = [], dy = [];
    for (let i = 0; i < t.length; i++) {
      r.push([-6, 4, -2, 6, -4, 3][i % 6]);
      dy.push(i === 0 ? 0 : ([0.04, -0.06, 0.05, -0.03, 0.06, -0.05][i % 6] * s).toFixed(1));
    }
    return ` rotate="${r.join(' ')}" dy="${dy.join(' ')}"`;
  };
  // the words themselves, in one colour or per word (doge)
  const nameText = (fill, extra = '') => lines.map((t, i) => {
    if (colours.perWord) {
      const words = t.split(' ');
      const spans = words.map((w, k) => `<tspan fill="${hex(colours.perWord[(i * 3 + k) % colours.perWord.length])}">${esc(w)}${k < words.length - 1 ? ' ' : ''}</tspan>`).join('');
      return `<text x="0" y="${(i * lead).toFixed(1)}" ${nameAttrs}${extra}>${spans}</text>`;
    }
    return `<text x="0" y="${(i * lead).toFixed(1)}" ${nameAttrs} fill="${fill}"${extra}${bounce(t)}>${esc(t)}</text>`;
  }).join('');
  const tickText = (fill, extra = '') => (ticker ? `<text x="0" y="${tBase.toFixed(1)}" ${tickAttrs} fill="${fill}"${extra}>${esc(ticker)}</text>` : '');
  // shift: [dx, dy] in em, applied to the name and the ticker each at its own size
  const both = (fill, extra = '', shift = null) => {
    if (!shift) return nameText(fill, extra) + tickText(fill, extra);
    const mv = (k) => `translate(${(shift[0] * k).toFixed(1)} ${(shift[1] * k).toFixed(1)})`;
    return `<g transform="${mv(s)}">${nameText(fill, extra)}</g>${ticker ? `<g transform="${mv(tSize)}">${tickText(fill, extra)}</g>` : ''}`;
  };
  const parts = [];
  const fillHex = hex(colours.fill);
  if (L.cut) {
    // the sticker edge: the words drawn fat in white under everything, with a soft shadow under that
    const cw = (L.cut[1] * s).toFixed(1);
    parts.push(`<g opacity=".35" filter="url(#${ids}b)">${both('#000', ` stroke="#000" stroke-width="${cw}" stroke-linejoin="round"`, [0, 0.035])}</g>`);
    parts.push(`<g>${both(L.cut[0], ` stroke="${L.cut[0]}" stroke-width="${cw}" stroke-linejoin="round"`)}</g>`);
  }
  if (colours.halo) {
    // a soft patch of the ground's own colour under the words, so they read on a busy picture
    parts.push(`<g opacity=".8" filter="url(#${ids}h)">${both(hex(colours.halo), ` stroke="${hex(colours.halo)}" stroke-width="${(0.16 * s).toFixed(1)}" stroke-linejoin="round"`)}</g>`);
  }
  if (L.spray) parts.push(`<g opacity=".45" filter="url(#${ids}s)">${both(fillHex)}</g>`);
  const strokeAttr = colours.stroke ? ` stroke="${hex(colours.stroke)}" stroke-width="${(L.stroke[1] * s).toFixed(1)}" stroke-linejoin="round" paint-order="stroke"` : '';
  if (L.shadow && colours.shadow) {
    const sh = hex(colours.shadow);
    const shStroke = colours.stroke ? ` stroke="${sh}" stroke-width="${(L.stroke[1] * s).toFixed(1)}" stroke-linejoin="round"` : '';
    parts.push(`<g>${both(sh, shStroke, [L.shadow[1], L.shadow[2]])}</g>`);
  }
  if (L.misreg && colours.ink2) {
    parts.push(`<g style="mix-blend-mode:multiply">${both(hex(colours.ink2), '', [0.045, 0.03])}</g>`);
  }
  const blend = L.misreg ? ' style="mix-blend-mode:multiply"' : '';
  const rough = L.rough ? ` filter="url(#${ids}r)"` : '';
  if (L.plate) {
    // a paper strip behind each line, each a little crooked
    const pad = 0.16 * s;
    lines.forEach((t, i) => {
      const y = i * lead;
      parts.push(`<g data-plate="${i}" transform="rotate(${i % 2 ? 1.4 : -1.2} 0 ${y.toFixed(1)})"><rect data-line="${i}" x="${(-pad).toFixed(1)}" y="${(y - 0.86 * s).toFixed(1)}" width="0" height="${(1.08 * s).toFixed(1)}" fill="${L.plate}"/></g>`);
    });
    if (ticker) parts.push(`<rect data-line="t" x="${(-pad * 0.6).toFixed(1)}" y="${(tBase - 0.9 * tSize).toFixed(1)}" width="0" height="${(1.2 * tSize).toFixed(1)}" fill="${L.plate}"/>`);
  }
  parts.push(`<g${blend}${rough}>${nameText(fillHex, strokeAttr)}${tickText(hex(colours.tick || colours.fill), strokeAttr ? ` stroke="${hex(colours.stroke)}" stroke-width="${(L.stroke[1] * tSize * 1.2).toFixed(1)}" stroke-linejoin="round" paint-order="stroke"` : '')}</g>`);
  if (L.rules) {
    const w = 0; // filled in once the block is measured
    parts.push(`<line data-rule="top" x1="0" x2="${w}" y1="0" y2="0" stroke="${fillHex}" stroke-width="${Math.max(2, 0.025 * s).toFixed(1)}"/><line data-rule="bottom" x1="0" x2="${w}" y1="0" y2="0" stroke="${fillHex}" stroke-width="${Math.max(2, 0.025 * s).toFixed(1)}"/>`);
  }
  const blur = (id, sd) => `<filter id="${ids}${id}" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="${sd.toFixed(1)}"/></filter>`;
  const defs = `<defs>${blur('b', 0.03 * s)}${blur('h', 0.09 * s)}${blur('s', 0.035 * s)}<filter id="${ids}r" x="-5%" y="-10%" width="110%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="${(2.2 / s).toFixed(4)}" numOctaves="2" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="${(0.035 * s).toFixed(1)}" xChannelSelector="R" yChannelSelector="G" result="d"/><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="3" result="g"/><feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -12 8.2" result="m"/><feComposite in="d" in2="m" operator="in"/></filter></defs>`;
  return { defs, body: parts.join(''), tSize };
}

/** Bounding box of an SVG body ({ x, y, w, h }), measured by resvg with the given fonts. */
function measure(body, fonts, defs = '') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="3000">${defs}<g transform="translate(2000 1500)">${body}</g></svg>`;
  const r = new Resvg(svg, { font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'Rubik' } });
  const b = r.getBBox();
  if (!b || !b.width) return null;
  return { x: b.x - 2000, y: b.y - 1500, w: b.width, h: b.height };
}

/** The lines' own boxes (for plates and rules): each line measured alone. */
function lineBoxes(spec, lines, ticker, size, align, fonts) {
  const plain = { fill: [0, 0, 0] };
  return [...lines.map((_, i) => {
    const one = titleBody({ ...spec, plate: null, rules: false, shadow: null, cut: null, misreg: null, spray: false, stroke: null }, lines.map((t, k) => (k === i ? t : '')), null, size, align, plain);
    return measure(one.body, fonts);
  }), ticker ? measure(titleBody({ ...spec, plate: null, rules: false, shadow: null, cut: null, misreg: null, spray: false, stroke: null }, lines.map(() => ''), ticker, size, align, plain).body, fonts) : null];
}

/**
 * Sets the coin's name (and $TICKER) on a painted banner. lockup: an id of LOCKUPS. at: right | left | top | center,
 * the space the painting left for it (a clearly calmer place wins over it). Answers { jpg, spec } where spec says
 * what was set where ({ lockup, at, size, lines, fill, box }).
 */
export async function setTitle(jpg, { name, ticker = '', lockup = 'clean', at = 'right' } = {}) {
  const id = LOCKUPS[lockup] ? lockup : 'clean';
  const L = LOCKUPS[id];
  const look = await lookAt(jpg);
  let text = String(name || '').replace(/\s+/g, ' ').trim();
  if (L.upper) text = text.toUpperCase();
  if (L.lower) text = text.toLowerCase();
  const tick = ticker ? `$${String(ticker).toUpperCase()}` : '';
  const fonts = [...new Set([fileOf(L.font), fileOf(L.tickerFont || L.font), fileOf(['Rubik', 700])])];
  const black = { fill: [0, 0, 0] };

  // every spot, every way to break the lines: the biggest size that fits, then the calmest place for it
  const plans = [];
  const order = [SPOTS[at] ? at : 'right', ...Object.keys(SPOTS).filter((k) => k !== at)];
  for (const spotId of order) {
    const S = SPOTS[spotId];
    for (const [lines, tk] of lineOptions(text).flatMap((l) => (tick ? [[l, tick], [l, '']] : [[l, '']]))) {
      const r100 = titleBody(L, lines, tk, 100, S.align, black);
      const ref = measure(r100.body, fonts, r100.defs);
      if (!ref) continue;
      // room for the outline, shadow and sticker edge around the letters
      const padK = ((L.stroke?.[1] ?? 0) / 2 + Math.max(L.shadow?.[1] ?? 0, L.shadow?.[2] ?? 0) + (L.cut?.[1] ?? 0) / 2 + (L.plate ? 0.2 : 0) + (L.rules ? 0.12 : 0)) * 1.0;
      const sw = S.x1 - S.x0, sh = S.y1 - S.y0;
      const fit = Math.min(L.max, (100 * sw * 0.94) / (ref.w + padK * 200), (100 * sh * 0.92) / (ref.h + padK * 200));
      // as big as fits, or a little smaller when that finds a much calmer place: the score weighs both
      for (const scale of [1, 0.86, 0.74]) {
        let size = fit * scale;
        if (L.steps) size = L.steps.find((v) => v <= size) ?? L.steps.at(-1);
        size = Math.floor(size);
        if (size < 30) continue;
        const k = size / 100;
        const bw = ref.w * k + padK * size * 2, bh = ref.h * k + padK * size * 2;
        // slide the block over the spot: the calmest place, a little drawn to the spot's middle
        let best = null;
        const cx = (S.x0 + S.x1) / 2, cy = (S.y0 + S.y1) / 2;
        for (let y = S.y0; y + bh <= S.y1 + 0.5; y += 10) {
          for (let x = S.x0; x + bw <= S.x1 + 0.5; x += 10) {
            if (overlaps({ x, y, w: bw, h: bh }, AVATAR)) continue;
            const busy = busyIn(look, x, y, bw, bh);
            const cost = busy + 0.25 * (Math.abs(x + bw / 2 - cx) / W + Math.abs(y + bh / 2 - cy) / H);
            if (!best || cost < best.cost) best = { x, y, cost, busy };
          }
        }
        if (!best) continue;
        const score = best.cost + 0.8 * (1 - size / L.max) + 0.06 * (lines.length - 1) + (tick && !tk ? 0.15 : 0);
        plans.push({ spot: spotId, lines, tick: tk, size, bw, bh, x: best.x, y: best.y, cost: best.cost, busy: best.busy, score, ref, padK });
      }
    }
  }
  if (!plans.length) throw new Error('no room for the title');
  const perSpot = {};
  for (const p of plans) if (!perSpot[p.spot] || p.score < perSpot[p.spot].score) perSpot[p.spot] = p;
  const planned = perSpot[order[0]];
  const best = Object.values(perSpot).reduce((a, b) => (b.score < a.score ? b : a));
  // the planned spot unless another is clearly better (the painting didn't leave the space where it was asked to)
  const plan = planned && planned.score <= best.score + 0.3 ? planned : best;

  // the colours, from the ground under the words and the picture's palette
  const { bg, sd } = groundIn(look, plan.x, plan.y, plan.bw, plan.bh);
  const ctx = { bg, palette: look.palette, alone: !L.stroke && !L.plate && !L.cut };
  const colours = { fill: colourOf(L.fill, ctx) };
  if (L.fill === 'rainbow') colours.perWord = RAINBOW.filter((c) => contrast(c, bg) >= 2).slice(0, 5);
  if (colours.perWord && !colours.perWord.length) colours.perWord = [colourOf('ink', ctx)];
  if (L.stroke) colours.stroke = colourOf(L.stroke[0], ctx);
  if (L.shadow) colours.shadow = colourOf(L.shadow[0], ctx);
  if (L.misreg) colours.ink2 = colourOf(L.misreg, { ...ctx, other: colours.fill });
  if (colours.stroke && contrast(colours.fill, colours.stroke) < 3) colours.fill = luminance(colours.stroke) < 0.3 ? colourOf('light', ctx) : colourOf('dark', ctx);
  // light words on a light ground (or dark on dark) with nothing around them: the other way round
  if (!L.stroke && !L.plate && !L.cut && L.fill !== 'paint' && !colours.perWord && contrast(colours.fill, bg) < 2.2) {
    colours.fill = colourOf('ink', ctx);
    if (colours.shadow) colours.shadow = luminance(colours.fill) > 0.4 ? colourOf('dark', ctx) : colourOf('light', ctx);
  }
  // a busy or low-contrast ground under unoutlined words gets a soft halo of its own colour
  const busy = plan.busy;
  if (!L.stroke && !L.plate && !L.cut && (busy > 0.75 || sd > 0.12 || contrast(colours.perWord?.[0] || colours.fill, bg) < 3.2)) colours.halo = readable(bg, colours.perWord?.[0] || colours.fill, 3.5);

  // set it: the body at its size, measured, then moved so the letters sit in the chosen box
  const S = SPOTS[plan.spot];
  const t = titleBody(L, plan.lines, plan.tick, plan.size, S.align, colours);
  let body = t.body;
  if (L.plate || L.rules) {
    const boxes = lineBoxes(L, plan.lines, plan.tick, plan.size, S.align, fonts);
    if (L.plate) {
      const pad = 0.16 * plan.size;
      body = body.replace(/<rect data-line="(\d+|t)" x="[^"]*" y="([^"]*)" width="0"/g, (m, k, y) => {
        const b = k === 't' ? boxes.at(-1) : boxes[Number(k)];
        if (!b) return m;
        const p = k === 't' ? pad * 0.6 : pad;
        return `<rect data-line="${k}" x="${(b.x - p).toFixed(1)}" y="${y}" width="${(b.w + 2 * p).toFixed(1)}"`;
      });
    }
    if (L.rules) {
      const all = boxes.filter(Boolean);
      const x0 = Math.min(...all.map((b) => b.x)) - 0.1 * plan.size, x1 = Math.max(...all.map((b) => b.x + b.w)) + 0.1 * plan.size;
      const top = Math.min(...all.map((b) => b.y)) - 0.16 * plan.size, bottom = Math.max(...all.map((b) => b.y + b.h)) + 0.16 * plan.size;
      body = body.replace(/<line data-rule="top" x1="0" x2="0" y1="0" y2="0"/, `<line data-rule="top" x1="${x0.toFixed(1)}" x2="${x1.toFixed(1)}" y1="${top.toFixed(1)}" y2="${top.toFixed(1)}"`)
        .replace(/<line data-rule="bottom" x1="0" x2="0" y1="0" y2="0"/, `<line data-rule="bottom" x1="${x0.toFixed(1)}" x2="${x1.toFixed(1)}" y1="${bottom.toFixed(1)}" y2="${bottom.toFixed(1)}"`);
    }
  }
  let inner = body;
  let box = measure(inner, fonts, t.defs);
  if (L.tilt && box) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    inner = `<g transform="rotate(${L.tilt} ${cx.toFixed(1)} ${cy.toFixed(1)})">${inner}</g>`;
    box = measure(inner, fonts, t.defs) || box;
  }
  if (!box) throw new Error('the title did not render');
  // into the chosen box: start-aligned blocks keep its left edge, centred ones its middle; vertically centred
  const pad = plan.padK * plan.size;
  const targetX = S.align === 'middle' ? plan.x + plan.bw / 2 - (box.x + box.w / 2) : plan.x + pad - box.x;
  const targetY = plan.y + plan.bh / 2 - (box.y + box.h / 2);
  let tx = targetX, ty = targetY;
  if (L.crisp) {
    // whole pixels (Press Start 2P on its own 8-unit grid)
    const q = L.steps ? plan.size / 8 : 1;
    tx = Math.round(tx / q) * q;
    ty = Math.round(ty / q) * q;
  }
  // never off the banner
  tx = Math.max(24 - box.x, Math.min(W - 24 - (box.x + box.w), tx));
  ty = Math.max(16 - box.y, Math.min(H - 16 - (box.y + box.h), ty));
  const base = (await sharp(jpg).resize(W, H, { fit: 'fill' }).jpeg({ quality: 92 }).toBuffer()).toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${t.defs}<image href="data:image/jpeg;base64,${base}" x="0" y="0" width="${W}" height="${H}"/><g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)})">${inner}</g></svg>`;
  const png = new Resvg(svg, { font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'Rubik' } }).render().asPng();
  const out = await sharp(png).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  const placed = { x: Math.round(tx + box.x), y: Math.round(ty + box.y), w: Math.round(box.w), h: Math.round(box.h) };
  return {
    jpg: out,
    spec: { lockup: id, at: plan.spot, asked: at, size: plan.size, lines: plan.lines, ticker: !!plan.tick, fill: hex(colours.fill), box: placed, busy: Math.round(busy * 100) / 100 },
  };
}
