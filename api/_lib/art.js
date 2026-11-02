// Art directions (2026-11-02): the looks a coin's pictures can take, so they come out designed and not as generic AI
// art. The assistant picks one direction per design (two different ones a message) and writes WHAT is in the
// picture; this adds HOW it looks: a precise brief for the image model (medium, line, palette, texture,
// composition), what that medium must never turn into, the AI defaults every picture avoids, and the frame (a
// square profile picture, or a wide banner painted with NO words and a calm space where type.js sets the name).
// Some looks get a finish in code after painting, because an image model only imitates them: a real pixel grid with
// a small palette (pixel), two colours and an ordered dither (one-bit), flat aliased Paint fills (ms-paint).
//   DIRECTIONS[id]                 { name, when, brief, logo?, banner?, avoid?, tells, type: [lockups], finish? }
//   directionOf(id, { refs })      the direction for a design (a missing or unknown id falls back)
//   artPrompt(kind, opts)          the whole brief for one picture
//   finishArt(buf, direction, kind) the code finish (a PNG of the same size), or the picture as it was
import sharp from 'sharp';
import { readImage } from './images.js';

// Every picture avoids these unless the person asked for that look (direction "asked").
export const AI_DEFAULTS = 'a glossy 3D render, a vinyl toy or plastic look, a Pixar or claymation look, a polished digital painting or concept-art look with soft cinematic light, airbrushed smooth gradients, flat vector clip art with gradients and grain, a stock cartoon mascot face (huge shiny eyes, an open-mouthed surprised look), lens flare, bokeh, sparkles, glowing neon outlines, a purple or pink-to-purple gradient background';

export const DIRECTIONS = {
  native: {
    name: "the meme's own look",
    when: 'an existing meme or character drawn exactly the way its original is (the crude MS Paint wojak, the flat comic pepe, the real doge photo); usually one of the two designs when there is one',
    brief: "Draw it in the reference picture's own medium and look, as if the meme's original creator made this new picture: the same line quality and weight, the same colours, the same way of shading (or of not shading), the same proportions, texture and level of crudeness or polish. Nothing gets upgraded: a crude drawing stays crude, a flat drawing stays flat, a photo stays a real photo with real light and real texture.",
    avoid: 'a smoother, cleaner, glossier, more detailed or more 3D version of the original',
    tells: "the original's own line, colours and finish, nothing upgraded",
    type: ['paint', 'macro', 'comic', 'doge'],
  },
  'ms-paint': {
    name: 'crude MS Paint',
    when: 'dumb, relatable or self-deprecating jokes, a nobody or a feeling ("a guy who..."), wojak-world humour: the crudest is the funniest',
    brief: 'A deliberately crude drawing made with a mouse in Microsoft Paint on Windows 95: wobbly black outlines about 3 pixels thick with jagged, pixel-stepped edges and no anti-aliasing; flat bucket fills in the basic Paint colours (pure red, yellow, blue, green, orange, a peach skin tone, grey) with small white gaps where a fill missed; lopsided proportions, naive perspective, one eye a little bigger than the other; a plain white or flat-coloured canvas; at most a few spray-can speckles. Funny because it is so bad, but every choice reads as on purpose.',
    avoid: 'gradients, soft shading, textures, clean smooth curves, anti-aliased lines',
    tells: 'jagged aliased mouse lines, flat Paint-palette bucket fills, a naive drawing',
    type: ['paint'],
    finish: 'paint',
  },
  'comic-halftone': {
    name: 'hand-inked comic, halftone print',
    when: 'action, drama, a heist, a reveal, a hero or a villain: ideas with an event in them',
    brief: 'A panel from a printed 1960s comic book: confident black brush-and-nib ink lines that swell and taper, solid black shadows, flat printed colours (primary red, yellow, cyan and a muted skin tone) a hair out of register with the line work, Ben-Day halftone dots for shading and skies, hand-drawn speed lines and action bursts, on slightly yellowed newsprint with visible paper grain. A dynamic composition with a strong diagonal and one clear focal point.',
    avoid: 'digital gradients, glossy highlights, thin even vector lines, 3D shading',
    tells: 'varied-weight ink line, Ben-Day dots, flat print colours on newsprint',
    type: ['comic'],
  },
  risograph: {
    name: 'two-colour risograph print',
    when: 'cool, arty, indie, zine or gig-poster energy; a strong second direction for almost any idea',
    brief: 'A two-colour risograph print on off-white uncoated paper, printed in exactly two spot inks (a striking pair, e.g. fluorescent pink and blue, yellow and teal, orange and navy, or red and green). Shapes are flat and simplified, tone comes from coarse halftone dots and grain, the two inks overprint into a darker third colour where they cross, the two layers are slightly out of register, the ink coverage is uneven and speckled. A bold graphic composition with big shapes and plenty of bare paper.',
    avoid: 'a third ink, black outlines, smooth digital gradients, photographic detail',
    tells: 'two spot inks only, overprint, halftone grain, misregistration, bare paper',
    type: ['riso'],
  },
  pixel: {
    name: '8-bit pixel sprite',
    when: 'only for games, speedruns, retro tech or "level up" ideas (pixel mascots are everywhere: never the default)',
    brief: 'Real low-resolution pixel art like a late-80s console game: big visible square pixels (the whole picture is about 64 pixels across), hard stepped edges with no anti-aliasing, no gradients, a palette of at most 12 flat colours with checkerboard dithering for shading, sprites with a one-pixel dark outline, a simple tiled background.',
    avoid: 'smooth gradients, soft painted pixels, high-resolution detail, glow',
    tells: 'a real coarse pixel grid, a small flat palette, dithering',
    type: ['pixel'],
    finish: 'pixel',
  },
  'one-bit': {
    name: '1-bit dither',
    when: 'computers, the internet, terminals, moody or deadpan tech jokes',
    brief: 'A 1-bit picture like an old black-and-white Macintosh screen or a Game Boy Camera photo: only two colours, one ink and one paper, every tone made with ordered dither patterns, chunky visible pixels, strong light and shadow so the forms read through the dither.',
    avoid: 'any third colour, smooth gradients',
    tells: 'two colours only, ordered dither, visible pixels',
    type: ['pixel', 'mono'],
    finish: 'one-bit',
  },
  'cel-90s': {
    name: '90s cartoon cel',
    when: 'chaotic, gross-out or slapstick characters, a character stuck in a ridiculous situation',
    brief: 'A frame from a 1990s TV cartoon: hand-inked outlines with lively, varied weight; flat cel colours with one hard-edged shadow tone; exaggerated squash-and-stretch poses and expressions; gross close-up detail when it is funny (bloodshot eyes, stubble, a throbbing vein); a hand-painted gouache background in muted colours with visible brush texture behind the brighter characters; slight film grain.',
    avoid: 'the clean modern vector cartoon look, soft 3D shading, big glossy eyes',
    tells: 'inked outlines, flat cel paint with a hard shadow, a painted background',
    type: ['cartoon'],
  },
  sticker: {
    name: 'die-cut vinyl sticker',
    when: 'cute-but-tough mascots, skate and street culture (use sparingly)',
    brief: 'A real printed die-cut vinyl sticker: the subject drawn with bold simple shapes and a confident dark outline, a thick white die-cut border following its silhouette, flat printed colours with a soft satin sheen, a soft real shadow under the sticker edge.',
    logo: 'The sticker sits on a flat colour ground.',
    banner: 'The sticker (or a few of them) slapped on a scuffed real wall or laptop lid.',
    avoid: 'gradients inside the shapes, a 3D toy look',
    tells: 'a white die-cut border, printed vinyl, a real shadow',
    type: ['sticker'],
  },
  linocut: {
    name: 'linocut print',
    when: 'fables and folk tales, animals, nature, work and toil, money told like a parable',
    brief: 'A hand-carved linoleum block print: bold black relief shapes with the knife and gouge marks visible (parallel carved strokes for shading, chunky white cut lines), slightly uneven ink with speckles and the paper texture showing through, printed in black plus at most two flat colours (e.g. a warm red and an ochre) on cream paper. High contrast, simplified graphic shapes, a strong silhouette.',
    avoid: 'gradients, smooth shading, thin even outlines, more than three inks',
    tells: 'carved gouge marks, black relief ink, one or two flat colours, cream paper',
    type: ['woodtype'],
  },
  marginalia: {
    name: 'medieval manuscript margin',
    when: 'absurd things treated with medieval seriousness: snails and knights, monks, money lenders, cults, prophecies',
    brief: 'A drawing from the margin of a medieval illuminated manuscript: brown iron-gall ink line on aged, stained vellum, flat washes of vermilion, ultramarine and dull green, touches of gold leaf, naive medieval proportions and flat perspective, deadpan faces, a decorative vine scroll. The joke is a modern thing drawn in total seriousness by a 13th-century monk.',
    logo: 'The drawing fills the whole square: the vellum runs to every edge, with no border, panel or initial-letter box around it.',
    banner: 'The scene runs edge to edge across the vellum: vine scrolls may climb through it but never box it in.',
    avoid: 'modern shading, smooth gradients, a fantasy-game look',
    tells: 'iron-gall ink on vellum, flat medieval washes, gold leaf, naive figures',
    type: ['blackletter'],
  },
  propaganda: {
    name: 'vintage propaganda poster',
    when: 'a movement, an army, a cause, "join us", community coins, workers and the grind',
    brief: 'A 1930s-50s lithographic propaganda poster: a heroic figure seen from a low angle, strong diagonals and radiating rays, flat simplified shapes with crisp edges, a limited palette of three or four inks (red, black, cream and one accent), printed grain and slight wear. Dead serious about a silly subject.',
    avoid: 'photographic detail, soft gradients, more than four inks',
    tells: 'a low-angle heroic figure, rays, three or four flat inks, litho grain',
    type: ['poster'],
  },
  travel: {
    name: 'vintage travel poster',
    when: 'places, journeys, space and the moon, "come to...", ideas with a destination',
    brief: 'A 1930s-50s travel poster printed in silkscreen: every area one flat ink with a crisp edge, depth built only from stacked bands of colour (pale distant hills, a sky in two or three flat bands), one striking viewpoint, a palette of five or six harmonious muted inks (e.g. teal, coral, cream, ochre, navy), stylised geometric simplification, a little ink texture and paper grain.',
    avoid: 'photographic detail, soft airbrushed gradients, glow, neon colours',
    tells: 'flat silkscreen shapes, depth from colour bands, muted harmonious inks',
    type: ['deco'],
  },
  label: {
    name: 'retro packaging label',
    when: 'food, drinks, products and everyday objects, "a brand of..." jokes',
    brief: 'The art of a 1950s-60s product label (a cereal box, a tin can, a seed packet, a matchbox): a cheerful mascot illustration in printed spot colours with halftone shading, a sunburst or checked ground, a few starbursts and border ornaments, slight print misregistration and worn edges.',
    banner: 'The empty space for the name can be a blank cream plate or ribbon with nothing written on it.',
    avoid: 'glossy highlights, 3D shading, modern flat vector',
    tells: 'spot colours, halftone, a retro mascot, a sunburst, print wear',
    type: ['label'],
  },
  storybook: {
    name: 'mid-century picture book',
    when: 'sweet, sad or wholesome ideas, small animals, quiet jokes',
    brief: 'A page from a 1950s-60s picture book, painted in flat opaque gouache and printed on uncoated paper: simple naive shapes with no realistic detail, flat areas of four or five muted colours (no gradients: a sky is one flat colour), dry-brush and crayon texture inside the flat areas, small deadpan faces (dot eyes, a tiny line mouth), stylised plants and buildings, a quiet composition with plenty of air, the paper grain showing through.',
    avoid: 'realistic fur or fabric, soft gradients, glowing skies, big glossy eyes, digital smoothness, 3D shading',
    tells: 'flat opaque shapes in a few muted colours, dry-brush texture, naive dot-eyed characters',
    type: ['storybook'],
  },
  zine: {
    name: 'xerox zine collage',
    when: 'photo memes, real-world absurdity, posts and headlines, anything with a real photo',
    brief: 'A punk photocopied zine collage: real photo cut-outs with rough scissor edges, harsh black-and-white photocopy texture with toner noise and streaks, halftoned photos, torn paper and tape, and one spot colour (red or fluorescent yellow) printed in flat blocks. Chaotic but composed around one big focal cut-out.',
    avoid: 'clean digital photo editing, glow, gradients',
    tells: 'photocopy texture, scissor-cut photos, tape, one spot colour',
    type: ['strip', 'macro'],
  },
  engraving: {
    name: 'engraved banknote',
    when: 'money, banks, funds, old money, "in X we trust"',
    brief: 'A banknote engraving: the subject as a dignified portrait, shaded entirely with fine engraved line hatching and cross-hatching, guilloche rosettes and ornamental scrollwork, printed in one or two inks (banknote green, sepia or deep blue) on cream security paper.',
    logo: 'The portrait fills the frame and the guilloche runs to every edge: no oval, border or margin around it.',
    banner: 'The engraving runs edge to edge like a detail cropped from a large note: no outer border, no blank panel.',
    avoid: 'smooth shading, photographic tones, colour gradients',
    tells: 'fine line hatching, guilloche, one or two inks on cream',
    type: ['engraved'],
  },
  crayon: {
    name: "kid's crayon drawing",
    when: "innocent or dumb jokes, wholesome chaos, a kid's idea of a big thing",
    brief: 'A drawing by a six-year-old with wax crayons on white paper: scribbled fill strokes that go over the lines, waxy texture with the paper tooth showing, wonky proportions, stick limbs, bright crayon colours, a crooked sun or a few clouds if there is sky. Sincere and funny.',
    avoid: 'clean lines, digital fills, adult drawing skill',
    tells: "waxy scribbles, paper tooth, a child's proportions",
    type: ['marker'],
  },
  patent: {
    name: 'patent drawing',
    when: 'inventions, machines, launchpads, protocols, "how it works" jokes',
    brief: 'A 19th-century patent drawing: precise fine black pen lines on aged cream paper, hatch and stipple shading, a cutaway or exploded view of the contraption, leader lines ending in small blank circles, a thin border rule. Dead serious engineering of a silly idea.',
    avoid: 'colour fills, gradients, a modern CAD look',
    tells: 'fine technical pen line, hatching, a cutaway view, aged paper',
    type: ['mono'],
  },
  stencil: {
    name: 'street stencil',
    when: 'rebellion, anti-something, the underground, protest',
    brief: "Spray-paint stencil art on a concrete or brick wall: two or three flat spray colours with soft overspray edges, a few drips, the stencil's bridges visible, the wall's texture and stains showing through.",
    avoid: 'gradients inside the shapes, clean digital edges',
    tells: 'flat spray layers, overspray, drips, wall texture',
    type: ['stencil'],
  },
  'ukiyo-e': {
    name: 'Japanese woodblock print',
    when: 'the sea, waves, mountains, epic calm, wandering-swordsman jokes',
    brief: 'An Edo-period ukiyo-e woodblock print: flat areas of colour inside black keyblock outlines, wood-grain texture in the flat areas, Prussian blue, vermilion, soft ochre and pale green, stylised wave and cloud patterns, a gradated sky.',
    avoid: 'anime styling, 3D shading, neon colours',
    tells: 'keyblock outlines, flat colour with wood grain, Prussian blue',
    type: ['engraved'],
  },
  asked: {
    name: 'the look the person asked for',
    when: 'only when the person asks for a look that is not in this list (3D, anime, a real photo...): describe that look in the prompts yourself',
    brief: '',
    tells: 'the look the person asked for, done well',
    type: ['clean', 'macro'],
  },
};

export const DIRECTION_IDS = Object.keys(DIRECTIONS);

/** The direction for a design: its id if known, else the meme's own look with a reference, else a risograph print. */
export function directionOf(id, { refs = false } = {}) {
  const k = String(id || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (DIRECTIONS[k]) return { id: k, ...DIRECTIONS[k] };
  const loose = DIRECTION_IDS.find((d) => k && (k.includes(d) || d.includes(k)));
  if (loose) return { id: loose, ...DIRECTIONS[loose] };
  const fall = refs ? 'native' : 'risograph';
  return { id: fall, ...DIRECTIONS[fall] };
}

/** The list the assistant chooses from, one line each. */
export const directionList = () => DIRECTION_IDS.map((id) => `- ${id}: ${DIRECTIONS[id].name}. For ${DIRECTIONS[id].when}.`).join('\n');

export const TITLE_SPOTS = ['right', 'left', 'top', 'center'];
export const titleSpot = (v) => {
  const s = String(v || '').toLowerCase();
  return TITLE_SPOTS.find((t) => s.includes(t)) || (/centre|middle/.test(s) ? 'center' : 'right');
};
const SPOT_WORDS = {
  right: 'the right third of the picture',
  left: 'the upper left of the picture (above the lower left corner)',
  top: 'a band across the top of the picture',
  center: 'the middle of the picture, with the subjects to its left and right',
};

/**
 * The whole brief for one picture. kind: logo | banner. prompt: what is in it (the assistant's words). direction:
 * from directionOf. refs: how many reference pictures go with it. at: where the banner leaves room for the name.
 */
export function artPrompt(kind, { prompt, direction, refs = 0, at = 'right' }) {
  const d = direction || directionOf(null, { refs: refs > 0 });
  const parts = [String(prompt || '').trim()];
  if (d.brief) parts.push(`Art direction, ${d.name}: ${d.brief}${d[kind] ? ` ${d[kind]}` : ''}`);
  if (kind === 'logo') {
    parts.push('A square profile picture: one subject, big and centred, filling most of the frame, on a simple background that runs to every edge, behind and below the subject (the shoulders of a bust run off the bottom edge; no white patch or strip left over from a reference picture). No words, letters or numbers anywhere; no frame, border, white margin or circle around it.');
  } else {
    parts.push(`A very wide header picture: one full-bleed scene from edge to edge, never a picture inside a panel, box or frame. Keep every important thing in the middle band of the height (the top and bottom get cut off) and keep the lower left corner calm. Leave ${SPOT_WORDS[titleSpot(at)]} calm and empty, plain background with nothing in it: a title is set there later. No words, letters, numbers, signs or logos anywhere in the picture.`);
  }
  if (refs > 0) {
    parts.push(d.id === 'native' || d.id === 'asked'
      ? `The reference picture${refs > 1 ? 's show' : ' shows'} the character: keep its face, features and drawing style exactly.`
      : `The reference picture${refs > 1 ? 's show' : ' shows'} the character: keep its face, features and proportions exactly, recognisable at a glance, but draw it in the art direction above, not in the reference's own medium.`);
  }
  const avoid = [d.avoid, d.id === 'asked' ? null : AI_DEFAULTS].filter(Boolean).join('; ');
  if (avoid) parts.push(`Avoid ${avoid}.`);
  return parts.join('\n\n');
}

// ---------- the finishes: what code does better than an image model ----------

/** PNG bytes of raw RGB pixels. */
const rgbPng = (px, w, h) => sharp(px, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();

/** A real pixel grid: the picture at `cols` pixels across with a small palette, each pixel blown up square. */
async function pixelGrid(img, w, h, cols, colours) {
  const rows = Math.max(1, Math.round((cols * h) / w));
  const small = await img.resize(cols, rows, { fit: 'fill', kernel: 'cubic' }).png({ palette: true, colours, dither: 0 }).toBuffer();
  return sharp(small).resize(w, h, { fit: 'fill', kernel: 'nearest' }).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
}

const BAYER8 = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Two colours and an 8x8 ordered dither at 4 px a pixel: the ink and the paper are the picture's darkest and lightest. */
async function oneBit(img, w, h) {
  const k = 4;
  const sw = Math.round(w / k), sh = Math.round(h / k);
  const { data } = await img.resize(sw, sh, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // the ink and the paper: the mean colour of the darkest and the lightest tenth
  const ls = [];
  for (let i = 0; i < sw * sh; i++) ls.push([lum(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]), i]);
  ls.sort((a, b) => a[0] - b[0]);
  const tenth = Math.max(1, Math.floor(ls.length / 10));
  const mean = (arr) => [0, 1, 2].map((c) => Math.round(arr.reduce((a, [, i]) => a + data[i * 3 + c], 0) / arr.length));
  let ink = mean(ls.slice(0, tenth));
  let paper = mean(ls.slice(-tenth));
  // keep them apart: a dark ink and a light paper, whatever the picture
  if (lum(...ink) > 0.28) ink = ink.map((v) => Math.round(v * 0.45));
  if (lum(...paper) < 0.8) paper = paper.map((v) => Math.round(v + (255 - v) * 0.6));
  const lo = ls[tenth][0], hi = ls[ls.length - tenth - 1][0];
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      // the tones stretched between the darkest and lightest tenth, so the dither uses the whole range
      const t = Math.min(1, Math.max(0, (lum(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]) - lo) / Math.max(0.05, hi - lo)));
      const c = (1 - t) * 64 > BAYER8[(y % 8) * 8 + (x % 8)] ? ink : paper;
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) {
          const X = x * k + dx, Y = y * k + dy;
          if (X >= w || Y >= h) continue;
          const o = (Y * w + X) * 3;
          out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
        }
      }
    }
  }
  return rgbPng(out, w, h);
}

/**
 * The code finish of a direction, on a painted picture: the same size again (a logo is cut square at 1024 first, and
 * comes back as a PNG; a banner as a JPEG), or null when the direction has none. kind: logo | banner.
 */
export async function finishArt(buf, direction, kind) {
  const png = await finishPng(buf, direction, kind);
  if (!png || kind === 'logo') return png;
  return sharp(png).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
}

async function finishPng(buf, direction, kind) {
  const f = direction?.finish;
  if (!f) return null;
  const { img, width, height } = await readImage(buf);
  let base = img.flatten({ background: '#ffffff' });
  let w = width, h = height;
  if (kind === 'logo') {
    base = base.resize(1024, 1024, { fit: 'cover', position: 'centre' });
    w = 1024; h = 1024;
  }
  base = sharp(await base.png().toBuffer());
  if (f === 'pixel') return pixelGrid(base, w, h, kind === 'logo' ? 64 : 150, 16);
  if (f === 'one-bit') return oneBit(base, w, h);
  // ms-paint: flat fills with no in-between colours, on a 2 px grid (mouse lines are jagged)
  if (f === 'paint') return pixelGrid(base, w, h, Math.round(w / 2), 12);
  return null;
}
