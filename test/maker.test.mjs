// The maker (2026-11-02), offline: no network, nothing spent. Stand-ins for Claude, the image model, the reference
// finder and the link reader. What it checks: a reply streams as chat text and the designs block never shows as
// text; a coin is two designs whose pictures start painting as soon as their prompts are written, with the original
// character's picture as the reference; the second look sends a miss back once; every call and picture is booked;
// the reply's budget and the daily cap's worst case hold. Plus the pieces: the safe fetcher's address rules, the
// picture checks and the banner cut, the reference and link parsers, the image model's hedge, and the chat merge.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { _setClient, callUsd, cleanHistory, designsBlock, makeTurn, parseDesigns, pictureAsk, planBudgetUsd, refIds, visibleReply, worstPlanCall, worstTurn, PLAN_FIRST_INPUT } from '../api/_lib/maker.js';
import { checkUrl, isPublicIp } from '../api/_lib/net.js';
import { bandTop, bannerFile, logoFiles, normalize, sniff } from '../api/_lib/images.js';
import { kymEntries, matchScore, pageImages, pageTitle, slugOf } from '../api/_lib/refs.js';
import { linksIn, pageText, tweetId } from '../api/_lib/links.js';
import { _setFetch, paint, taskOf, worstPictureUsd } from '../api/_lib/kie.js';
import { mergeChats } from '../api/_lib/users.js';
import { sheetPng } from '../api/_lib/engine.js';

const png = (w, h, color = '#ff3366') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();

// ---------- a stand-in for the SDK's streamed beta messages ----------
const USAGE = { input_tokens: 3000, output_tokens: 900, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 };
function fakeClient(script, { cutTop = null } = {}) {
  const requests = [];
  const cuts = [];
  return {
    requests,
    cuts,
    beta: {
      messages: {
        stream(params) {
          // the banner cut checks (a small model) answer on their own, outside the script
          const isCut = params.model === 'claude-haiku-5-5';
          const step = isCut ? { blocks: [{ type: 'text', text: cutTop == null ? 'no idea' : `<top>${cutTop}</top>` }], usage: { input_tokens: 900, output_tokens: 20 } } : script[requests.length];
          if (isCut) cuts.push({ params: structuredClone(params) });
          else requests.push({ params: structuredClone(params) });
          const on = [];
          return {
            on(ev, fn) { if (ev === 'streamEvent') on.push(fn); return this; },
            async finalMessage() {
              if (!step) throw new Error('unexpected call');
              const usage = step.usage ?? USAGE;
              const emit = (e) => on.forEach((fn) => fn(e));
              emit({ type: 'message_start', message: { usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } });
              (step.blocks || []).forEach((b, index) => {
                if (b.type === 'text') {
                  emit({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
                  for (let i = 0; i < b.text.length; i += 37) emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text.slice(i, i + 37) } });
                } else if (b.type === 'thinking') {
                  emit({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
                  emit({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
                } else if (b.type === 'tool_use') {
                  emit({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
                  emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
                } else {
                  emit({ type: 'content_block_start', index, content_block: b });
                }
                emit({ type: 'content_block_stop', index });
              });
              emit({ type: 'message_delta', delta: { stop_reason: step.stop ?? 'end_turn' }, usage: { output_tokens: usage.output_tokens } });
              return { model: params.model, stop_reason: step.stop ?? 'end_turn', usage, content: (step.blocks || []).map((b) => (b.type === 'thinking' ? { ...b, signature: 'sig' } : b)) };
            },
          };
        },
      },
    },
  };
}

const DESIGNS = `here are two takes on a wojak launchpad: the original ms paint lines, and a riso launch poster.
<designs for="new">
<character>Wojak (the Feels Guy)</character>
<design>
<angle>the original, crude ms paint lines</angle>
<direction>native</direction>
<name>wojak pad</name>
<ticker>WOJPAD</ticker>
<bio>every wojak gets a liftoff</bio>
<refs>r1</refs>
<logo>The original Wojak with a tiny rocket on his head.</logo>
<title_at>right</title_at>
<type>paint</type>
<banner>A row of original Wojaks launching rockets, the right third empty sky.</banner>
</design>
<design>
<angle>a two-colour riso launch poster</angle>
<direction>risograph</direction>
<name>wojak rocket</name>
<ticker>WOJRKT</ticker>
<bio>strap in, feels guy</bio>
<refs>r1</refs>
<logo>Wojak in a round space helmet, looking up.</logo>
<title_at>left</title_at>
<type>riso</type>
<banner>Wojak strapped to a rocket lifting off on the right, the upper left empty sky.</banner>
</design>
</designs>`;

function deps({ fail = new Set(), log = [] } = {}) {
  const sq = () => png(1024, 1024);
  const wide = () => png(1344, 576, '#3366ff');
  return {
    log,
    findImages: async ({ query }) => {
      log.push(['find', query]);
      return [{ src: 'https://i.kym-cdn.com/w.jpg', page: 'https://knowyourmeme.com/memes/wojak', title: 'Wojak', site: 'Know Your Meme', data: await png(320, 180, '#ffffff'), width: 320, height: 180, hash: 'a'.repeat(24), thumb: 'data:image/webp;base64,AA==' }];
    },
    putRef: async (c) => `https://store.public.blob.vercel-storage.com/refs/${c.hash}.jpg`,
    paint: async (req, opts) => {
      log.push(['paint', req.aspect, req.refs, req.prompt]);
      const entry = { model: 'nano-banana-pro', taskId: 't' + log.length, usd: 0.09, state: 'running', t0: Date.now() };
      opts.book(entry);
      opts.onState({ model: 'nano-banana-pro', state: 'generating' });
      if (fail.has(req.aspect)) {
        Object.assign(entry, { state: 'failed', usd: 0 });
        throw new Error('kie said no');
      }
      Object.assign(entry, { state: 'done' });
      return { data: req.aspect === '1:1' ? await sq() : await wide(), model: 'nano-banana-pro', usd: 0.09 };
    },
  };
}

afterEach(() => _setClient(null));

describe('the reply', () => {
  it('a question gets a streamed chat answer and no designs, and costs only its call', async () => {
    const fake = fakeClient([{ blocks: [{ type: 'thinking', thinking: 'they want to know about tickers.' }, { type: 'text', text: 'a ticker is the short name people trade under, like $WOJPAD. keep it 3 to 8 letters.' }] }]);
    _setClient(fake);
    const events = [];
    const r = await makeTurn({ message: 'why that ticker?', emit: (e) => events.push(e), deps: deps() });
    assert.equal(r.kind, null);
    assert.equal(r.designs.length, 0);
    assert.match(r.reply, /^a ticker is the short name/);
    const streamed = events.filter((e) => e.type === 'reply' && !e.replace).map((e) => e.text).join('');
    assert.equal(streamed, r.reply);
    assert.ok(events.some((e) => e.type === 'think'), 'the thinking streams');
    assert.equal(fake.requests.length, 1);
    assert.ok(r.usd > 0 && r.usd < 0.05);
    // the request: summarised thinking, the fallback, the tools (web on), the system prompt cached
    const p = fake.requests[0].params;
    assert.deepEqual(p.thinking, { type: 'adaptive', display: 'summarized' });
    assert.equal(p.fallbacks, 'default');
    assert.ok(p.system[0].cache_control);
    assert.deepEqual(p.tools.map((t) => t.name), ['find_images', 'web_search', 'web_fetch']);
    assert.equal(p.tools[1].type, 'web_search_20260209');
  });

  it('a banner cut that goes through its words is moved where the cut check says', async () => {
    const one = DESIGNS.replace(/<refs>r1<\/refs>/g, '<refs>none</refs>');
    // a render 1344 x 576: words at the very top, the default cut (the detail is lower down) would take them off
    const words = sheetPng(1344, 576, `<rect width="1344" height="576" fill="#2050a0"/>${Array.from({ length: 40 }, (_, i) => `<rect x="${i * 30}" y="300" width="15" height="270" fill="#fff"/>`).join('')}<rect x="900" y="4" width="400" height="40" fill="#ffff00"/>`);
    const d = deps();
    d.paint = async (req, opts) => {
      opts.book({ model: 'nano-banana-pro', usd: 0.09, state: 'done', t0: Date.now() });
      return { data: req.aspect === '1:1' ? await png(1024, 1024) : words, model: 'nano-banana-pro', usd: 0.09 };
    };
    const fake = fakeClient([{ blocks: [{ type: 'text', text: one }] }, { blocks: [{ type: 'text', text: '<logo_a>ok</logo_a><banner_a>ok</banner_a><logo_b>ok</logo_b><banner_b>ok</banner_b>' }] }], { cutTop: 0 });
    _setClient(fake);
    const r = await makeTurn({ message: 'x', deps: d });
    assert.equal(fake.cuts.length, 2, 'one check per banner');
    assert.match(fake.cuts[0].params.messages[0].content[1].text, /"wojak pad" \(\$WOJPAD\)|"wojak rocket" \(\$WOJRKT\)/);
    for (const x of r.designs) {
      // (stats() reads its input, so the strip is cut out first)
      const top = await sharp(await sharp(x.banner.files.jpg).extract({ left: 1100, top: 2, width: 200, height: 16 }).toBuffer()).stats();
      assert.ok(top.channels[0].mean > 200 && top.channels[2].mean < 120, 'the yellow words at the top are in the cut: ' + JSON.stringify(x.banner.files.cut) + ' ' + top.channels.map((c) => Math.round(c.mean)).join(','));
      assert.equal(x.banner.files.cut.topPct, 0);
    }
  });

  it('web search off leaves the web tools out', async () => {
    const fake = fakeClient([{ blocks: [{ type: 'text', text: 'what should it be about?' }] }]);
    _setClient(fake);
    await makeTurn({ message: 'make a coin', web: false, deps: deps() });
    assert.deepEqual(fake.requests[0].params.tools.map((t) => t.name), ['find_images']);
    assert.match(JSON.stringify(fake.requests[0].params.messages), /Web search is off/);
  });

  it('a coin: finds the original, two designs painted from it, the block never shows as text, all of it booked', async () => {
    const fake = fakeClient([
      { blocks: [{ type: 'thinking', thinking: 'wojak is an existing meme: find the original.' }, { type: 'tool_use', id: 'tu1', name: 'find_images', input: { query: 'wojak' } }], stop: 'tool_use' },
      { blocks: [{ type: 'text', text: DESIGNS }] },
      { blocks: [{ type: 'text', text: '<review>banner_a: words miss (a sign says "wojk")</review><logo_a>ok</logo_a><banner_a>redo: The same scene, the sign on the pad left blank, no "wojk" lettering.</banner_a><logo_b>ok</logo_b><banner_b>ok</banner_b>' }], usage: { input_tokens: 6000, output_tokens: 200 } },
      // the pick between the banner's two takes: the first one stays
      { blocks: [{ type: 'text', text: '<banner_a>1</banner_a>' }], usage: { input_tokens: 4000, output_tokens: 10 } },
    ]);
    _setClient(fake);
    const d = deps();
    d.rand = () => 0.9; // the pick sees the takes in their own order
    const events = [];
    const r = await makeTurn({ message: 'Coin that has a launchpad for wojaks', emit: (e) => events.push(e), deps: d });
    // the plan saw the candidates as pictures, in a tool result
    const second = fake.requests[1].params.messages;
    assert.equal(second.at(-1).content[0].type, 'tool_result');
    assert.ok(second.at(-1).content[0].content.some((c) => c.type === 'image'));
    // the reply is the words, not the tags
    assert.equal(r.reply, 'here are two takes on a wojak launchpad: the original ms paint lines, and a riso launch poster.');
    const shown = events.filter((e) => e.type === 'reply').map((e) => e.text).join('');
    assert.ok(!/<design|<name|<logo/.test(shown), 'no tags on screen');
    // two designs, words and pictures; the logos square, the banners wide, every one from the original
    assert.equal(r.kind, 'new');
    assert.equal(r.character, 'Wojak (the Feels Guy)');
    assert.deepEqual(r.designs.map((x) => [x.name, x.ticker]), [['wojak pad', 'WOJPAD'], ['wojak rocket', 'WOJRKT']]);
    const paints = d.log.filter((x) => x[0] === 'paint');
    assert.equal(paints.length, 5, 'four pictures and one redo');
    assert.deepEqual(paints.slice(0, 4).map((x) => x[1]).sort(), ['1:1', '1:1', '21:9', '21:9']);
    for (const p of paints) assert.deepEqual(p[2], ['https://store.public.blob.vercel-storage.com/refs/' + 'a'.repeat(24) + '.jpg']);
    // each picture is painted in its design's art direction, the banner with no words (the name is set in type)
    const prompt = (aspect, start) => paints.find((x) => x[1] === aspect && x[3].startsWith(start))[3];
    assert.match(prompt('1:1', 'The original Wojak'), /reference picture's own medium/);
    assert.match(prompt('1:1', 'Wojak in a round'), /two-colour risograph print/);
    assert.match(prompt('1:1', 'Wojak in a round'), /not in the reference's own medium/);
    const banner = prompt('21:9', 'A row of');
    assert.ok(!banner.includes('wojak pad'), 'the banner prompt never spells the name');
    assert.match(banner, /No words, letters, numbers, signs or logos anywhere/);
    assert.match(banner, /Leave the right third of the picture calm and empty/);
    assert.match(prompt('21:9', 'Wojak strapped'), /Leave the upper left of the picture/);
    assert.match(banner, /Avoid .*glossy 3D render/);
    assert.match(paints[4][3], /no "wojk" lettering/, 'the redo carries the second look\'s prompt');
    assert.match(paints[4][3], /reference picture's own medium/, 'and its direction again');
    // the names are set in type: the lockup each design asked for, the painting kept apart
    assert.deepEqual(r.designs.map((x) => [x.direction, x.title?.lockup, x.title?.lines.join(' ')]), [['native', 'paint', 'wojak pad'], ['risograph', 'riso', 'WOJAK ROCKET']]);
    assert.ok(r.designs.every((x) => x.banner.files.art && x.banner.files.art.length > 1000));
    // the pick kept the banner's first take (its prompt, not the redo's)
    assert.equal(r.designs[0].prompts.banner, 'A row of original Wojaks launching rockets, the right third empty sky.');
    assert.match(r.trace.review, /banner_a: words miss/);
    const pickAsk = JSON.stringify(fake.requests.at(-1).params.messages);
    assert.match(pickAsk, /sent back for this: banner_a: words miss/);
    const sizes = await Promise.all(r.designs.map(async (x) => [(await sharp(x.logo.files.png).metadata()).width, (await sharp(x.banner.files.jpg).metadata()).width, (await sharp(x.banner.files.jpg).metadata()).height]));
    assert.deepEqual(sizes, [[1024, 1500, 500], [1024, 1500, 500]]);
    assert.equal(r.designs[0].refs[0].page, 'https://knowyourmeme.com/memes/wojak');
    // the page heard the words before the pictures, and a picture as each one landed
    const firstDesign = events.findIndex((e) => e.type === 'design');
    const firstArt = events.findIndex((e) => e.type === 'art');
    assert.ok(firstDesign >= 0 && firstArt > firstDesign);
    assert.equal(events.filter((e) => e.type === 'art').length, 6, 'four, the redo, and the first take back');
    assert.ok(events.some((e) => e.type === 'step' && e.id === 'pick' && e.state === 'done' && /kept the first take of design A's banner/.test(e.label)));
    assert.ok(events.some((e) => e.type === 'step' && e.id === 'find:1' && e.state === 'done' && e.thumbs.length === 1));
    // three Claude calls and five pictures, every one booked
    // every banner (the redo too) had its cut checked by the small model
    assert.deepEqual(r.calls.map((c) => c.step).sort(), ['banner-a', 'banner-a-redo', 'banner-b', 'cut', 'cut', 'cut', 'logo-a', 'logo-b', 'look', 'pick', 'reply', 'reply2']);
    assert.ok(r.calls.filter((c) => c.step === 'cut').every((c) => c.model === 'claude-haiku-5-5'));
    const pictures = r.calls.filter((c) => c.kind === 'picture');
    assert.equal(pictures.length, 5);
    assert.ok(Math.abs(pictures.reduce((a, c) => a + c.usd, 0) - 0.45) < 1e-9);
    assert.ok(r.usd < worstTurn(), 'the real cost stays under what is held');
  });

  it('a change keeps what it was not asked to change and edits from the current picture', async () => {
    const change = `making it red.
<designs for="change">
<character>Wojak (the Feels Guy)</character>
<design><angle>as asked</angle><name>wojak pad</name><ticker>WOJPAD</ticker><bio>every wojak gets a liftoff</bio><refs>h1</refs><logo>edit: make the background bright red</logo><banner>keep</banner></design>
<design><angle>red alert</angle><name>red pad</name><ticker>REDPAD</ticker><bio>code red, wojak</bio><refs>h1</refs><logo>A red Wojak.</logo><banner>A red launch scene.</banner></design>
</designs>`;
    _setClient(fakeClient([{ blocks: [{ type: 'text', text: change }] }, { blocks: [{ type: 'text', text: '<logo_a>ok</logo_a><logo_b>ok</logo_b><banner_b>ok</banner_b>' }] }]));
    const d = deps();
    const current = { id: 'k'.repeat(16), name: 'wojak pad', ticker: 'WOJPAD', bio: 'x', angle: 'a', logo: 'https://s.public.blob.vercel-storage.com/kits/aaaaaaaaaaaaaaaa/logo.png', thumb: 'https://s.public.blob.vercel-storage.com/kits/aaaaaaaaaaaaaaaa/thumb.webp', banner: 'https://s.public.blob.vercel-storage.com/kits/aaaaaaaaaaaaaaaa/banner.jpg', refs: [{ url: 'https://s.public.blob.vercel-storage.com/refs/x.jpg', title: 'Wojak' }], bannerPrompt: 'the old banner prompt' };
    const r = await makeTurn({ message: 'make it red', current, deps: d });
    assert.equal(r.kind, 'change');
    const a = r.designs[0];
    assert.ok(a.banner.keep, 'the banner is kept');
    assert.equal(a.banner.url, current.banner);
    assert.equal(a.prompts.banner, 'the old banner prompt');
    const edit = d.log.find((x) => x[0] === 'paint' && /^Edit this picture: make the background bright red/.test(x[3]));
    assert.ok(edit, 'the logo is edited');
    assert.deepEqual(edit[2], [current.logo], 'from the current logo');
    const fresh = d.log.find((x) => x[0] === 'paint' && x[3].startsWith('A red Wojak'));
    assert.deepEqual(fresh[2], ['https://s.public.blob.vercel-storage.com/refs/x.jpg'], 'h1 is the reference the current version used');
  });

  it('a picture that never comes out drops its design, not the turn', async () => {
    // (the backup painter has nothing to answer with here: the fake client's script is spent)
    _setClient(fakeClient([{ blocks: [{ type: 'text', text: DESIGNS.replace(/<refs>r1<\/refs>/g, '<refs>none</refs>') }] }]));
    const d = deps({ fail: new Set(['21:9']) });
    await assert.rejects(makeTurn({ message: 'wojak pad', deps: d }), (e) => e.code === 'no_art' && e.usd > 0);
  });

  it('a refusal is a nope; a turn that would pass its budget stops before the call', async () => {
    _setClient(fakeClient([{ blocks: [], stop: 'refusal' }]));
    await assert.rejects(makeTurn({ message: 'something', deps: deps() }), (e) => e.code === 'nope');
    // a context so big the next call could pass the budget: stopped before it is made
    const fake = fakeClient([{ blocks: [{ type: 'tool_use', id: 'tu1', name: 'find_images', input: { query: 'wojak' } }], stop: 'tool_use', usage: { input_tokens: 150_000, output_tokens: 900 } }]);
    _setClient(fake);
    await assert.rejects(makeTurn({ message: 'wojak', deps: deps() }), (e) => e.code === 'jam' && /budget/.test(e.message));
    assert.equal(fake.requests.length, 1);
  });

  it('reads the links before it answers, and hands their pictures over as references', async () => {
    const fake = fakeClient([{ blocks: [{ type: 'text', text: 'that post is a whole mood. here is a coin.' }] }]);
    _setClient(fake);
    const d = deps();
    const readLink = async (url) => ({ kind: 'tweet', url, site: 'x.com', handle: 'someone', author: 'Some One (@someone)', title: 'a post on X by @someone', text: 'my sink is now a dao', images: ['https://pbs.twimg.com/media/a.jpg'] });
    const fetchImage = async () => png(400, 300, '#22aa66');
    const events = [];
    await makeTurn({ message: 'turn this into a coin', links: ['https://x.com/someone/status/123456789'], emit: (e) => events.push(e), deps: { ...d, readLink, fetchImage } });
    const sent = JSON.stringify(fake.requests[0].params.messages[0].content);
    assert.match(sent, /my sink is now a dao/);
    assert.match(sent, /l1/);
    assert.ok(fake.requests[0].params.messages[0].content.some((c) => c.type === 'image'));
    assert.ok(events.some((e) => e.type === 'step' && e.id === 'link:1' && e.state === 'done' && /read the post by @someone/.test(e.label)));
  });
});

describe('the reply text and its designs block', () => {
  it('holds back what may be the start of the block, and drops the block', () => {
    assert.equal(visibleReply('two takes.\n<des'), 'two takes.\n');
    assert.equal(visibleReply('a < b is true'), 'a < b is true');
    assert.equal(visibleReply('done.\n<designs for="new"><design></design></designs>\nbye', true), 'done.\n\nbye');
    assert.deepEqual(designsBlock('x <designs for="change">\n<design>'), { kind: 'change', body: '\n<design>', open: true });
    assert.equal(designsBlock('no block'), null);
    const ds = parseDesigns('<design><name>a</name><logo>p</logo></design><design><name>b');
    assert.equal(ds.length, 2);
    assert.equal(ds[0].open, false);
    assert.equal(ds[1].open, true);
    assert.equal(ds[1].name, null);
  });
  it('reads refs and picture asks', () => {
    assert.deepEqual(refIds('r1, u2 l1 h3 x9 r1'), ['r1', 'u2', 'l1', 'h3']);
    assert.deepEqual(refIds('none'), []);
    assert.deepEqual(pictureAsk('keep'), { keep: true });
    assert.deepEqual(pictureAsk('Edit: make it red'), { edit: 'make it red' });
    assert.deepEqual(pictureAsk('A whole prompt.'), { prompt: 'A whole prompt.' });
  });
  it('keeps the page\'s record of the conversation to its shape', () => {
    const h = cleanHistory([{ q: 'hi\u0000 there', a: 'yo', made: [{ name: 'a', ticker: 'B', angle: 'c' }, { name: 'd' }, { name: 'e' }], picked: 1 }, { x: 1 }, 'nope', ...Array.from({ length: 20 }, (_, i) => ({ q: 'q' + i }))]);
    assert.equal(h.length, 12);
    const all = cleanHistory([{ q: 'hi\u0000 there', a: 'yo', made: [{ name: 'a', ticker: 'B', angle: 'c' }, { name: 'd' }, { name: 'e' }], picked: 1 }]);
    assert.deepEqual(all, [{ q: 'hi there', a: 'yo', made: [{ name: 'a', ticker: 'B', angle: 'c' }, { name: 'd', ticker: '', angle: '' }], picked: 1 }]);
    assert.equal(cleanHistory([{ q: 'x', made: [{ name: 'a' }], picked: 5 }])[0].picked, null);
  });
});

describe('the daily cap', () => {
  it('holds the reply budget, every picture with its backup and the redos, and the second look', () => {
    const w = worstTurn();
    assert.ok(w >= planBudgetUsd() + 6 * worstPictureUsd());
    assert.ok(w < 2, `${w}`);
    assert.ok(worstPlanCall('claude-sonnet-5-5', PLAN_FIRST_INPUT, 5) < planBudgetUsd(), 'the first call always fits the budget');
    // every model at its own price, searches on top
    assert.ok(Math.abs(callUsd({ input_tokens: 1000, output_tokens: 1000 }, 'claude-haiku-5-5') - 0.0006) < 1e-12);
    assert.ok(Math.abs(callUsd({ input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 10000, server_tool_use: { web_search_requests: 2 } }, 'claude-sonnet-5-5') - (0.002 + 0.01 + 0.002 + 0.02)) < 1e-12);
  });
});

describe('the safe fetcher', () => {
  it('only public addresses, default ports, no credentials', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) assert.equal(isPublicIp(ip), false, ip);
    for (const ip of ['8.8.8.8', '151.101.1.69', '2606:4700::6810:85e5', '::ffff:8.8.8.8']) assert.equal(isPublicIp(ip), true, ip);
    assert.ok(checkUrl('https://knowyourmeme.com/memes/wojak'));
    for (const u of ['http://localhost/x', 'https://127.0.0.1/', 'http://169.254.169.254/latest', 'https://a.b.c:8443/', 'https://user:pw@example.com/', 'ftp://example.com/', 'file:///etc/passwd', 'https://intranet/', 'https://[::1]/', 'javascript:alert(1)']) assert.equal(checkUrl(u), null, u);
  });
});

describe('pictures from outside', () => {
  it('only real pixels get through, re-encoded with no metadata', async () => {
    assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    await assert.rejects(normalize(Buffer.from('GIF89a but not really a gif at all')));
    await assert.rejects(normalize(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40)])));
    const withExif = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#123456' } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'someone' } } }).toBuffer();
    const n = await normalize(withExif);
    assert.equal(n.type, 'image/jpeg');
    assert.equal(n.width, 1536);
    const meta = await sharp(n.data).metadata();
    assert.equal(meta.exif, undefined, 'no exif left');
    await assert.rejects(normalize(await png(20, 20)), /too small/);
  });
  it('cuts the logo square and the banner to 1500 x 500, keeping the band with the detail', async () => {
    const l = await logoFiles(await png(1200, 900));
    assert.deepEqual([(await sharp(l.png).metadata()).width, (await sharp(l.thumb).metadata()).width], [1024, 256]);
    // a wide picture, flat except for a detailed strip near the top: the cut keeps the strip
    const w = 1344, h = 576;
    const stripe = await sharp({ create: { width: w, height: 120, channels: 3, background: '#000' } }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="120">${Array.from({ length: 60 }, (_, i) => `<rect x="${i * 22}" y="0" width="11" height="120" fill="#fff"/>`).join('')}</svg>`) }]).png().toBuffer();
    const pic = await sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } }).composite([{ input: stripe, left: 0, top: 20 }]).png().toBuffer();
    const b = await bannerFile(pic);
    const meta = await sharp(b).metadata();
    assert.deepEqual([meta.width, meta.height], [1500, 500]);
    const px = (await sharp(b).resize(1500, 500).greyscale().raw().toBuffer());
    let edges = 0;
    for (let x = 1; x < 1500; x++) edges += Math.abs(px[40 * 1500 + x] - px[40 * 1500 + x - 1]);
    assert.ok(edges > 10_000, 'the striped band is inside the cut');
    // and the helper itself: detail at the bottom pulls the window down
    const g = new Uint8Array(100 * 50);
    for (let y = 40; y < 50; y++) for (let x = 0; x < 100; x++) g[y * 100 + x] = x % 2 ? 255 : 0;
    assert.equal(bandTop(g, 100, 50, 20), 30);
  });
});

describe('the reference finder and the link reader', () => {
  it('parses Know Your Meme, Wikipedia names and page pictures', () => {
    const html = `<a class="item" data-title="Withered Wojak" href="/memes/withered-wojak">x</a><a href="/memes/new">new</a><a class='item' data-title='Wojak' href='/memes/wojak'>y</a><a class="item" data-title="Wojak" href="/memes/wojak">dup</a>`;
    assert.deepEqual(kymEntries(html), [{ title: 'Withered Wojak', path: '/memes/withered-wojak' }, { title: 'Wojak', path: '/memes/wojak' }]);
    assert.equal(matchScore('Wojak', 'wojak'), 3);
    assert.equal(matchScore('Pepe the Frog', 'pepe the frog meme'), 3);
    assert.equal(matchScore('Just a Chill Guy / My New Character', 'chill guy'), 1);
assert.equal(matchScore('Chill Guy Vietnamese Magazine Cover', 'chill guy'), 2);
    assert.equal(matchScore('Withered Wojak', 'wojak'), 1);
    assert.equal(matchScore('Frogs in culture', 'pepe'), 0);
    assert.equal(slugOf('Pepe the Frog meme'), 'pepe-the-frog');
    const page = `<html><head><title>Doge | Know Your Meme</title><meta property='og:image' content='https://i.kym-cdn.com/entries/icons/original/000/013/564/doge.jpg' /><meta name="twitter:image" content="/rel.png"></head></html>`;
    assert.deepEqual(pageImages(page, 'https://knowyourmeme.com/memes/doge'), ['https://i.kym-cdn.com/entries/icons/original/000/013/564/doge.jpg', 'https://knowyourmeme.com/rel.png']);
    assert.equal(pageTitle(page), 'Doge | Know Your Meme');
  });
  it('finds links and posts on X, and reads a page\'s text', () => {
    assert.deepEqual(linksIn('look https://x.com/a/status/1585341984679469056?s=20, and https://example.com/news. also http://localhost/x'), ['https://x.com/a/status/1585341984679469056?s=20', 'https://example.com/news']);
    assert.equal(tweetId('https://x.com/elonmusk/status/1585341984679469056'), '1585341984679469056');
    assert.equal(tweetId('https://mobile.twitter.com/a/status/12345678'), '12345678');
    assert.equal(tweetId('https://fxtwitter.com/a/status/12345678/photo/1'), '12345678');
    assert.equal(tweetId('https://example.com/a/status/12345678'), null);
    assert.equal(pageText('<html><body><nav>menu</nav><article><h1>Big news</h1><p>a dog &amp; a cat</p><script>evil()</script></article></body></html>'), 'Big news\na dog & a cat');
  });
});

describe('the image model', () => {
  const done = (url = 'https://tempfile.example/x.png') => ({ code: 200, data: { state: 'success', resultJson: JSON.stringify({ resultUrls: [url] }), creditsConsumed: 18 } });
  function fakeKie({ slow = new Set(), fail = new Set() } = {}) {
    const created = [];
    const f = async (url, init = {}) => {
      const u = String(url);
      const json = (o) => ({ ok: true, status: 200, json: async () => o, arrayBuffer: async () => new ArrayBuffer(0) });
      if (u.endsWith('/createTask')) {
        const body = JSON.parse(init.body);
        created.push(body.model);
        return json({ code: 200, data: { taskId: body.model } });
      }
      if (u.includes('recordInfo')) {
        const id = decodeURIComponent(u.split('taskId=')[1]);
        if (fail.has(id)) return json({ code: 200, data: { state: 'fail', failCode: '500', failMsg: 'internal error' } });
        if (slow.has(id)) return json({ code: 200, data: { state: 'waiting' } });
        return json(done(`https://tempfile.example/${id}.png`));
      }
      // the download
      const b = await png(64, 64);
      return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
    };
    return { f, created };
  }
  afterEach(() => _setFetch(null));
  it('takes the backup when the first model is slow, and books both', async () => {
    process.env.KIE_API_KEY = 'test-key';
    const k = fakeKie({ slow: new Set(['nano-banana-pro']) });
    _setFetch(k.f);
    const booked = [];
    const r = await paint({ prompt: 'p', refs: ['https://x/r.jpg'], aspect: '1:1' }, { models: ['nano-banana-pro', 'gpt-image-2.5'], hedge: 30, pollMs: 10, timeoutMs: 5000, book: (e) => booked.push(e) });
    assert.equal(r.model, 'gpt-image-2.5');
    assert.deepEqual(k.created, ['nano-banana-pro', 'gpt-image-2-5-flare-image-to-image']);
    assert.equal(booked.length, 2);
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(booked[0].state, 'abandoned', 'the slow one may still be billed: it stays counted');
    assert.ok(booked[0].usd > 0);
  });
  it('a failed task starts the backup at once; a task body names the refs the model\'s way', async () => {
    process.env.KIE_API_KEY = 'test-key';
    const k = fakeKie({ fail: new Set(['nano-banana-pro']) });
    _setFetch(k.f);
    const r = await paint({ prompt: 'p', refs: [], aspect: '21:9' }, { models: ['nano-banana-pro', 'gpt-image-2.5'], hedge: 60_000, pollMs: 10, timeoutMs: 5000 });
    assert.equal(r.model, 'gpt-image-2.5');
    assert.deepEqual(taskOf('nano-banana-pro', { prompt: 'p', refs: ['https://a/1.jpg'], aspect: '1:1' }).input.image_input, ['https://a/1.jpg']);
    assert.equal(taskOf('gpt-image-2.5', { prompt: 'p', refs: ['https://a/1.jpg'], aspect: '1:1' }).model, 'gpt-image-2-5-flare-image-to-image');
    assert.equal(taskOf('gpt-image-2.5', { prompt: 'p', refs: [], aspect: '1:1' }).model, 'gpt-image-2-5-flare-text-to-image');
  });
});

describe('the chat sync', () => {
  it('a picked design and a rename survive a copy from another device', () => {
    const base = { id: 'cmh2wojak1', sentence: 'wojak', t: 100, turns: [{ q: 'wojak', made: [{}, {}], pick: null }] };
    const picked = { ...base, u: 300, kit: 'B', turns: [{ q: 'wojak', made: [{}, {}], pick: 1 }] };
    const renamed = { ...base, u: 200, title: 'my wojak', titleAt: 200 };
    const m = mergeChats({ chats: [renamed], deleted: {} }, [picked]).chats[0];
    assert.equal(m.turns[0].pick, 1, 'the later change wins');
    assert.equal(m.title, 'my wojak', 'and the name given elsewhere stays');
    const m2 = mergeChats({ chats: [picked], deleted: {} }, [renamed]).chats[0];
    assert.equal(m2.turns[0].pick, 1);
    assert.equal(m2.title, 'my wojak');
  });
});
