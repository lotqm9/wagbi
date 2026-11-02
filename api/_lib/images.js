// Pictures that come from outside (an image model's render, a meme's original from the web, a file someone attached)
// are read with sharp, checked and written out again before anything else sees them: only real PNG, JPEG, WebP or
// GIF pixels get through (the bytes are sniffed, not the name or the content type), never anything huge, and what
// comes out is a fresh encode with no metadata (no EXIF location, nothing hidden after the pixels).
//   normalize(buf)          -> { data: JPEG, width, height }    a reference or an attachment, at most 1536 px a side
//   logoFiles(buf)          -> { png: 1024 PNG, thumb: 256 WebP }
//   bannerFile(buf)         -> 1500 x 500 JPEG, cut from a wider render
//   forModel(buf, max)      -> base64 JPEG, for showing a picture to Claude
import sharp from 'sharp';

export const KINDS = ['png', 'jpeg', 'webp', 'gif'];
export const MAX_PIXELS = 40_000_000;
export const MIN_SIDE = 48;

/** The image type from the first bytes, or null. */
export function sniff(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  return null;
}

export class ImageError extends Error {
  constructor(message, code = 'bad_image') {
    super(message);
    this.code = code;
  }
}

/** Reads a picture: { img (a sharp pipeline, EXIF rotation applied, first frame only), width, height, format }. Throws ImageError. */
export async function readImage(buf) {
  const kind = sniff(buf);
  if (!kind) throw new ImageError('not a png, jpeg, webp or gif');
  let meta;
  try {
    meta = await sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
  } catch (e) {
    throw new ImageError(`unreadable image: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  if (!KINDS.includes(meta.format) || meta.format !== kind) throw new ImageError('the image is not what its bytes say');
  // after EXIF rotation a portrait photo swaps its sides
  const turned = (meta.orientation ?? 1) >= 5;
  const width = turned ? meta.height : meta.width;
  const height = turned ? meta.width : meta.height;
  if (!width || !height || width < MIN_SIDE || height < MIN_SIDE) throw new ImageError('too small');
  if (width * height > MAX_PIXELS) throw new ImageError('too big', 'too_big');
  const img = sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error', pages: 1 }).rotate();
  return { img, width, height, format: meta.format, alpha: !!meta.hasAlpha };
}

/** A reference or an attachment, made safe and small: a JPEG of at most `max` px a side on white, no metadata. */
export async function normalize(buf, { max = 1536, quality = 90 } = {}) {
  const { img } = await readImage(buf);
  const out = await img
    .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data: out.data, width: out.info.width, height: out.info.height, type: 'image/jpeg' };
}

/** The logo files from a square render: a 1024 PNG (what launches and downloads use) and a 256 WebP thumbnail. */
export async function logoFiles(buf) {
  const { img } = await readImage(buf);
  const square = await img.resize(1024, 1024, { fit: 'cover', position: 'centre' }).flatten({ background: '#ffffff' }).png().toBuffer();
  const [png, thumb] = await Promise.all([
    sharp(square).png({ palette: true, quality: 92, effort: 8, dither: 1, compressionLevel: 9 }).toBuffer(),
    sharp(square).resize(256, 256).webp({ quality: 84 }).toBuffer(),
  ]);
  return { png, thumb };
}

/**
 * Where to cut a band of `band` rows out of `h` rows of greyscale pixels (w wide): the window holding the most detail
 * (the summed gradient: characters, words and edges, not flat sky or floor), nudged toward `bias` (0 top, 1 bottom)
 * so a picture with detail everywhere is cut a little above its middle. Answers the top row.
 */
export function bandTop(px, w, h, band, bias = 0.42) {
  if (band >= h) return 0;
  const rows = new Float64Array(h);
  for (let y = 1; y < h; y++) {
    let e = 0;
    for (let x = 1; x < w; x++) {
      const i = y * w + x;
      e += Math.abs(px[i] - px[i - w]) + Math.abs(px[i] - px[i - 1]);
    }
    rows[y] = e;
  }
  let sum = 0;
  for (let y = 0; y < band; y++) sum += rows[y];
  const total = rows.reduce((a, b) => a + b, 0) || 1;
  const want = (h - band) * bias;
  let best = 0;
  let bestScore = -Infinity;
  for (let top = 0; top <= h - band; top++) {
    if (top > 0) sum += rows[top + band - 1] - rows[top - 1];
    // detail kept, as a share of all of it, less a small cost for straying from the middle
    const score = sum / total - 0.25 * Math.abs(top - want) / (h - band || 1);
    if (score > bestScore) { bestScore = score; best = top; }
  }
  return best;
}

/**
 * The 1500 x 500 banner from a wider render (21:9 or 16:9): scaled to 1500 wide, then the 500 px band that keeps the
 * most of the picture's detail (bandTop). A render that is already 3:1 or wider is cut from its middle.
 */
export async function bannerFile(buf, opts) {
  return (await bannerCut(buf, opts)).jpg;
}

/**
 * The banner cut, and where: { jpg, topPct (the band's top edge, in % of the render's height), maxPct (the lowest it
 * can start) }. topPct given: cut there (the second look moves a cut that went through the coin's name).
 */
export async function bannerCut(buf, { topPct = null } = {}) {
  const { img, width, height } = await readImage(buf);
  const flat = img.flatten({ background: '#ffffff' });
  if (width / height >= 3) {
    const jpg = await flat.resize(1500, 500, { fit: 'cover', position: 'centre' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    return { jpg, topPct: 0, maxPct: 0 };
  }
  const h = Math.round((1500 * height) / width);
  const scaled = await flat.resize(1500, h).png().toBuffer();
  let top;
  if (Number.isFinite(topPct)) top = Math.round((topPct / 100) * h);
  else {
    const k = 5; // look at it 300 px wide
    const probe = await sharp(scaled).resize(300, Math.round(h / k), { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    top = bandTop(probe.data, probe.info.width, probe.info.height, Math.round(500 / k)) * k;
  }
  top = Math.max(0, Math.min(h - 500, top));
  const jpg = await sharp(scaled).extract({ left: 0, top, width: 1500, height: 500 }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  return { jpg, topPct: Math.round((top / h) * 1000) / 10, maxPct: Math.round(((h - 500) / h) * 1000) / 10 };
}

/**
 * The banner as painted, before the cut, with the cut drawn on it and a ruler in % down its left edge (for the second
 * look). draw(w, h, svgBody) -> PNG renders the overlay with real fonts (engine.js sheetPng: the bundled ones).
 */
export async function cutSheet(buf, topPct, draw) {
  const { img } = await readImage(buf);
  const W = 960;
  const base = await img.flatten({ background: '#ffffff' }).resize(W).jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
  const H = base.info.height;
  const bandH = Math.round(W / 3);
  const y = Math.round((topPct / 100) * H);
  const ticks = Array.from({ length: 11 }, (_, i) => {
    const ty = Math.round((i / 10) * H);
    return `<line x1="0" y1="${ty}" x2="22" y2="${ty}" stroke="#ff2d6f" stroke-width="3"/><text x="27" y="${Math.min(H - 5, Math.max(15, ty + 6))}" font-family="Space Mono" font-weight="700" font-size="16" fill="#ff2d6f" stroke="#ffffff" stroke-width="4" paint-order="stroke">${i * 10}%</text>`;
  }).join('');
  const body = `<image href="data:image/jpeg;base64,${base.data.toString('base64')}" x="0" y="0" width="${W}" height="${H}"/><rect x="0" y="0" width="${W}" height="${y}" fill="#000" fill-opacity=".5"/><rect x="0" y="${y + bandH}" width="${W}" height="${Math.max(0, H - y - bandH)}" fill="#000" fill-opacity=".5"/><rect x="2" y="${y + 1}" width="${W - 4}" height="${bandH - 2}" fill="none" stroke="#00e5ff" stroke-width="4"/>${ticks}`;
  return sharp(draw(W, H, body)).jpeg({ quality: 80 }).toBuffer();
}

/** A picture as Claude should see it: a JPEG of at most `max` px a side, base64. */
export async function forModel(buf, max = 1024) {
  const { img } = await readImage(buf);
  const out = await img.resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
  return out.toString('base64');
}

/** A small preview for the steps in the chat (a data url, a few kB). */
export async function thumbUrl(buf, size = 112) {
  const { img } = await readImage(buf);
  const out = await img.resize(size, size, { fit: 'cover' }).flatten({ background: '#ffffff' }).webp({ quality: 72 }).toBuffer();
  return 'data:image/webp;base64,' + out.toString('base64');
}

/** A banner preview for the page while the turn runs (a data url, about 25 kB). */
export async function previewUrl(jpg) {
  const out = await sharp(jpg).resize(900, 300).webp({ quality: 74 }).toBuffer();
  return 'data:image/webp;base64,' + out.toString('base64');
}

/** The logo as it lives on X: cropped round at 128 px on a light and a dark ground (for the second look). */
export async function avatarSheet(logoPng) {
  const round = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><circle cx="64" cy="64" r="64" fill="#fff"/></svg>');
  const small = await sharp(logoPng).resize(128, 128).composite([{ input: round, blend: 'dest-in' }]).png().toBuffer();
  const tiny = await sharp(small).resize(48, 48).png().toBuffer();
  return sharp({ create: { width: 400, height: 168, channels: 3, background: '#ffffff' } })
    .composite([
      { input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="168"><rect width="200" height="168" fill="#000"/></svg>'), left: 200, top: 0 },
      { input: small, left: 20, top: 20 },
      { input: tiny, left: 156, top: 60 },
      { input: small, left: 220, top: 20 },
      { input: tiny, left: 352, top: 60 },
    ])
    .png()
    .toBuffer();
}

/** The banner as X shows it: the profile picture over its lower left corner. */
export async function bannerPreview(bannerJpg, logoPng) {
  const R = 150;
  const disc = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${R * 2}" height="${R * 2}"><circle cx="${R}" cy="${R}" r="${R}" fill="#fff"/></svg>`);
  const avatar = logoPng ? await sharp(logoPng).resize(R * 2 - 16, R * 2 - 16).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${R * 2 - 16}" height="${R * 2 - 16}"><circle cx="${R - 8}" cy="${R - 8}" r="${R - 8}" fill="#fff"/></svg>`), blend: 'dest-in' }]).png().toBuffer() : null;
  const layers = [{ input: bannerJpg, left: 0, top: 0 }];
  if (avatar) layers.push({ input: disc, left: 40, top: 500 - R }, { input: avatar, left: 48, top: 500 - R + 8 });
  return sharp({ create: { width: 1500, height: 680, channels: 3, background: '#ffffff' } }).composite(layers).jpeg({ quality: 82 }).toBuffer();
}
