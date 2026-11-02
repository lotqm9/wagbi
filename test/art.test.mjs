// The art directions (art.js) and the banner titles set in type (type.js), offline: what the image model is told for
// each direction, the code finishes, and where and how the coin's name is set on a painted banner.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { AI_DEFAULTS, DIRECTIONS, artPrompt, directionOf, finishArt, titleSpot } from '../api/_lib/art.js';
import { AVATAR, LOCKUPS, LOCKUP_IDS, contrast, lineOptions, lockupOf, setTitle } from '../api/_lib/type.js';

// a banner with a busy subject (stripes) on one side and flat calm ground elsewhere
async function banner({ busy = 'left', ground = '#f1e9d8', ink = '#1d2f6f' } = {}) {
  const x0 = busy === 'left' ? 60 : 860;
  const stripes = Array.from({ length: 30 }, (_, i) => `<rect x="${x0 + i * 20}" y="60" width="9" height="380" fill="${ink}"/>`).join('');
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500"><rect width="1500" height="500" fill="${ground}"/>${stripes}</svg>`)).jpeg().toBuffer();
}
const meanIn = async (jpg, b) => {
  const s = await sharp(await sharp(jpg).extract({ left: b.x, top: b.y, width: b.w, height: b.h }).toBuffer()).stats();
  return s.channels.slice(0, 3).map((c) => c.mean);
};

describe('the art directions', () => {
  it('a design without a known direction falls back: the meme\'s own look with a reference, a print without', () => {
    assert.equal(directionOf('risograph').id, 'risograph');
    assert.equal(directionOf('Comic Halftone').id, 'comic-halftone');
    assert.equal(directionOf('nonsense', { refs: true }).id, 'native');
    assert.equal(directionOf(null).id, 'risograph');
    assert.equal(titleSpot('the right third'), 'right');
    assert.equal(titleSpot('centre'), 'center');
    assert.equal(titleSpot(''), 'right');
    // every direction has a brief (but the asked one), its tells, and lockups that exist
    for (const [id, d] of Object.entries(DIRECTIONS)) {
      assert.ok(id === 'asked' || d.brief.length > 80, id);
      assert.ok(d.tells && d.when, id);
      for (const t of d.type) assert.ok(LOCKUPS[t], `${id}: ${t}`);
    }
  });

  it('the image model hears what is in the picture, then the direction, the frame and what to avoid', () => {
    const logo = artPrompt('logo', { prompt: 'A snail in a top hat.', direction: directionOf('linocut'), refs: 0 });
    assert.ok(logo.startsWith('A snail in a top hat.'));
    assert.match(logo, /Art direction, linocut print: A hand-carved linoleum block print/);
    assert.match(logo, /No words, letters or numbers anywhere/);
    assert.ok(logo.includes(AI_DEFAULTS), 'the AI defaults are always avoided');
    const banner = artPrompt('banner', { prompt: 'A snail bank.', direction: directionOf('linocut'), at: 'top' });
    assert.match(banner, /Leave a band across the top of the picture calm and empty/);
    assert.match(banner, /No words, letters, numbers, signs or logos anywhere/);
    // a reference: the meme's own look keeps its drawing style, any other direction redraws it in its medium
    assert.match(artPrompt('logo', { prompt: 'p', direction: directionOf('native'), refs: 1 }), /keep its face, features and drawing style exactly/);
    assert.match(artPrompt('logo', { prompt: 'p', direction: directionOf('risograph'), refs: 2 }), /pictures show the character: keep its face, features and proportions exactly.*not in the reference's own medium/);
    // a look the person asked for drops the defaults (they asked for it)
    const asked = artPrompt('logo', { prompt: 'A glossy 3D toy frog.', direction: directionOf('asked') });
    assert.ok(!asked.includes('glossy 3D render'), 'no ban on what they asked for');
    assert.ok(!asked.includes('Art direction,'));
  });

  it('pixel art gets a real grid and a small palette; one-bit two colours; others no finish', async () => {
    const soft = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><radialGradient id="g"><stop offset="0" stop-color="#ffcc00"/><stop offset="1" stop-color="#3300aa"/></radialGradient></defs><rect width="1024" height="1024" fill="url(#g)"/><circle cx="512" cy="512" r="300" fill="#ff3366"/></svg>')).png().toBuffer();
    const colours = async (buf) => {
      const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const set = new Set();
      for (let i = 0; i < info.width * info.height; i++) set.add((data[i * 3] << 16) | (data[i * 3 + 1] << 8) | data[i * 3 + 2]);
      return { n: set.size, w: info.width, h: info.height };
    };
    const px = await colours(await finishArt(soft, directionOf('pixel'), 'logo'));
    assert.deepEqual([px.w, px.h], [1024, 1024]);
    assert.ok(px.n <= 16, `${px.n} colours`);
    const bit = await colours(await finishArt(soft, directionOf('one-bit'), 'logo'));
    assert.equal(bit.n, 2);
    const wide = await sharp(soft).resize(1500, 500, { fit: 'fill' }).jpeg().toBuffer();
    const b = await finishArt(wide, directionOf('pixel'), 'banner');
    assert.equal((await sharp(b).metadata()).format, 'jpeg', 'a banner comes back as a jpeg');
    assert.equal(await finishArt(soft, directionOf('linocut'), 'logo'), null);
  });
});

describe('the name set in type on the banner', () => {
  it('goes into the calm space the painting left, never under the profile picture', async () => {
    const r = await setTitle(await banner({ busy: 'left' }), { name: 'snail savings', ticker: 'SLOW', lockup: 'woodtype', at: 'right' });
    assert.equal(r.spec.at, 'right');
    assert.ok(r.spec.box.x > 800, JSON.stringify(r.spec.box));
    assert.ok(r.spec.size >= 80, `set big: ${r.spec.size}`);
    const meta = await sharp(r.jpg).metadata();
    assert.deepEqual([meta.width, meta.height, meta.format], [1500, 500, 'jpeg']);
    // asked for the left, but the left is where the subject is: it moves to the calm side
    const moved = await setTitle(await banner({ busy: 'left' }), { name: 'snail savings', ticker: 'SLOW', lockup: 'clean', at: 'left' });
    assert.notEqual(moved.spec.at, 'left');
    assert.equal(moved.spec.asked, 'left');
    // a calm left is used, above the profile picture
    const left = await setTitle(await banner({ busy: 'right' }), { name: 'wojak pad', ticker: 'WOJPAD', lockup: 'paint', at: 'left' });
    assert.equal(left.spec.at, 'left');
    const b = left.spec.box;
    assert.ok(!(b.x < AVATAR.x + AVATAR.w && b.y + b.h > AVATAR.y), `clear of the profile picture: ${JSON.stringify(b)}`);
  });

  it('the ink comes from the picture and reads on its ground; the type is really there', async () => {
    const light = await banner({ busy: 'left', ground: '#f1e9d8', ink: '#1d2f6f' });
    const r = await setTitle(light, { name: 'trash capital', ticker: 'TRASH', lockup: 'engraved', at: 'right' });
    const fill = [1, 3, 5].map((i) => parseInt(r.spec.fill.slice(i, i + 2), 16));
    assert.ok(contrast(fill, [241, 233, 216]) >= 4.5, `${r.spec.fill} on cream`);
    // the box with the name is darker than the bare ground was
    const before = await meanIn(light, r.spec.box);
    const after = await meanIn(r.jpg, r.spec.box);
    assert.ok(after.reduce((a, v) => a + v, 0) < before.reduce((a, v) => a + v, 0) - 30, `${before} -> ${after}`);
    const dark = await setTitle(await banner({ busy: 'left', ground: '#14172b', ink: '#e8c46a' }), { name: 'moon doge', ticker: 'MOON', lockup: 'storybook', at: 'right' });
    const f2 = [1, 3, 5].map((i) => parseInt(dark.spec.fill.slice(i, i + 2), 16));
    assert.ok(contrast(f2, [20, 23, 43]) >= 4.5, `${dark.spec.fill} on night`);
  });

  it('every lockup sets a long name and a short one', async () => {
    const pic = await banner({ busy: 'left' });
    for (const id of LOCKUP_IDS) {
      for (const name of ['the very long name coin', ...(['pixel', 'strip', 'engraved', 'doge'].includes(id) ? ['wow'] : [])]) {
        const r = await setTitle(pic, { name, ticker: 'TICK', lockup: id, at: 'right' });
        assert.equal(r.spec.lockup, id);
        assert.ok(r.spec.size >= 30 && r.spec.box.w > 50, `${id} "${name}": ${JSON.stringify(r.spec)}`);
      }
    }
    assert.equal(lockupOf('Riso'), 'riso');
    assert.equal(lockupOf('nope'), null);
    assert.deepEqual(lineOptions('the very long name coin').map((l) => l.length), [1, 2, 3]);
  });
});
