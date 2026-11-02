// The engine's look-and-fix pass, against a stand-in model (no network, nothing spent): the draft is rendered and
// shown back as images, the redraw is rendered, the blind pick keeps the better picture of each, every call is booked
// for the daily cap, and the pass never breaks a kit. Also the finish post-process and the cap's worst case.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setClient, cleanSvg, costOf, finishOf, makeKit, renderPng as renderSvg, worstCase, worstKit } from '../api/_lib/engine.js';
const renderPng = (svg, w) => renderSvg(cleanSvg(svg, w, w === 512 ? 512 : 500), w);

const logoSvg = (fill, finish = '') => `<svg viewBox="0 0 512 512"${finish ? ` data-finish="${finish}"` : ''}><rect width="512" height="512" fill="${fill}"/><circle cx="256" cy="256" r="150" fill="#111"/></svg>`;
const bannerSvg = (fill) => `<svg viewBox="0 0 1500 500"><rect width="1500" height="500" fill="${fill}"/><text x="700" y="280" font-family="Archivo Black" font-size="120">test</text></svg>`;
const draft = (extra = {}) => [
  '<verdict>ok</verdict><name>test dog</name><ticker>TDOG</ticker><bio>a test coin</bio><style_choice>soft 3d</style_choice><dither>none</dither>',
  `<logo>${extra.logo ?? logoSvg('#ff0000')}</logo>`,
  `<banner>${extra.banner ?? bannerSvg('#ff0000')}</banner>`,
].join('\n');
const revision = (logo = logoSvg('#00ff00', 'grain .3'), banner = bannerSvg('#00ff00')) => `<critique>1. 6/10 too flat\n2. 7/10\nfixes: light, grain, type</critique>\n<logo>${logo}</logo>\n<banner>${banner}</banner>`;

const USAGE = { input_tokens: 5000, output_tokens: 8000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** A stand-in for the SDK client: answers each streamed call from a script, and keeps every request it was sent. */
function fakeClient(script) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        stream(params, opts) {
          const step = script[requests.length];
          requests.push({ params, opts });
          const on = { streamEvent: [], text: [] };
          return {
            on(ev, fn) { (on[ev] ??= []).push(fn); return this; },
            async finalMessage() {
              if (!step) throw new Error('unexpected call');
              const usage = step.usage ?? USAGE;
              if (step.fail === 'before') throw Object.assign(new Error('overloaded'), { status: 529 });
              for (const fn of on.streamEvent) fn({ type: 'message_start', message: { usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } });
              if (step.fail === 'mid') throw Object.assign(new Error('connection reset'), { status: undefined });
              // the text in a few pieces, as a stream would bring it
              for (let i = 0; i < step.text.length; i += 400) for (const fn of on.text) fn(step.text.slice(i, i + 400));
              for (const fn of on.streamEvent) fn({ type: 'message_delta', usage: { output_tokens: usage.output_tokens } });
              return { model: params.model, stop_reason: step.stop ?? 'end_turn', usage, content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: step.text }] };
            },
          };
        },
      },
    },
  };
}

const images = (req) => req.params.messages.at(-1).content.filter((b) => b.type === 'image');
const isPng = (b) => Buffer.from(b).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
const pngSize = (b) => [Buffer.from(b).readUInt32BE(16), Buffer.from(b).readUInt32BE(20)];
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const A_IS_OLD = () => 0; // the blind pick's order: version A is the current picture, B the redraw

afterEach(() => _setClient(null));

describe('the look-and-fix pass', () => {
  it('shows the rendered pictures back, takes the redraw, and keeps what the blind pick chose', async () => {
    const fake = fakeClient([{ text: draft() }, { text: revision() }, { text: '<logo>B</logo> <banner>A</banner>', usage: { input_tokens: 4000, output_tokens: 300 } }]);
    _setClient(fake);
    const events = [];
    const r = await makeKit('a dog that only buys the top', { model: 'claude-sonnet-5-5', looks: 1, emit: (e) => events.push(e), rand: A_IS_OLD });

    assert.equal(fake.requests.length, 3, 'draft, look, judge');
    const [d, look, pick] = fake.requests;
    // the look call is the same conversation, carried on: the draft's reply (thinking included) then the pictures
    assert.equal(look.params.messages.length, 3);
    assert.deepEqual(look.params.messages[0], d.params.messages[0]);
    assert.equal(look.params.messages[1].role, 'assistant');
    assert.ok(look.params.messages[1].content.some((b) => b.type === 'thinking'), 'thinking blocks go back unchanged');
    assert.equal(look.params.system[0].text, d.params.system[0].text);
    assert.ok(d.params.system[0].cache_control, 'the system prompt is cached for the look call');
    const shown = images(look);
    assert.equal(shown.length, 2, 'the logo sheet and the banner preview');
    for (const im of shown) assert.ok(isPng(Buffer.from(im.source.data, 'base64')));
    assert.deepEqual(pngSize(Buffer.from(shown[0].source.data, 'base64')), [760, 416]);
    assert.deepEqual(pngSize(Buffer.from(shown[1].source.data, 'base64')), [1500, 690]);
    const ask = look.params.messages[2].content.at(-1).text;
    for (const check of ['Small size', 'Contrast', 'Composition', 'Light and texture', 'Clip art', 'Type', 'The idea', 'Bugs']) assert.ok(ask.includes(check), check);
    // the blind pick sees both versions of both pictures, and asks with a small budget at low effort
    assert.equal(images(pick).length, 4);
    assert.equal(pick.params.output_config.effort, 'low');
    assert.ok(pick.params.max_tokens <= 4000);

    // B was the redraw for the logo (kept), A the draft for the banner (kept)
    assert.equal(r.art.picks[0].logo, 'new');
    assert.equal(r.art.picks[0].banner, 'old');
    assert.ok(r.kit.logo.svg.includes('#00ff00'));
    assert.ok(r.kit.banner.svg.includes('#ff0000'));
    // the last picture streamed is the one in the kit
    const lastLogo = events.filter((e) => e.type === 'logo').at(-1).png;
    assert.ok(same(Buffer.from(lastLogo.split(',')[1], 'base64'), r.kit.logo.png));
    const lastBanner = events.filter((e) => e.type === 'banner').at(-1).png;
    assert.ok(same(Buffer.from(lastBanner.split(',')[1], 'base64'), r.kit.banner.png));
    assert.ok(events.some((e) => e.type === 'step' && e.step === 'look'));

    // every call is counted
    assert.deepEqual(r.art.calls.map((c) => c.step), ['draft', 'look1', 'judge']);
    const want = costOf(USAGE, 'claude-sonnet-5-5') * 2 + costOf({ input_tokens: 4000, output_tokens: 300 }, 'claude-sonnet-5-5');
    assert.ok(Math.abs(r.usd - want) < 1e-9, `${r.usd} vs ${want}`);
    // the redraw asked for grain: the kit's logo is the finished render, not a plain one
    assert.ok(!same(r.kit.logo.png, renderPng(logoSvg('#00ff00'), 512)));
  });

  it('keeps the draft when the judge prefers it, and tells the next round which one stands', async () => {
    const fake = fakeClient([
      { text: draft() },
      { text: revision() },
      { text: '<logo>A</logo><banner>A</banner>' },
      { text: revision(logoSvg('#0000ff'), 'keep') },
      { text: '<logo>B</logo>' },
    ]);
    _setClient(fake);
    const r = await makeKit('a dog that only buys the top', { model: 'claude-sonnet-5-5', looks: 2, rand: A_IS_OLD });
    assert.equal(fake.requests.length, 5);
    assert.deepEqual(r.art.picks, [{ logo: 'old', banner: 'old' }, { logo: 'new' }]);
    assert.ok(r.kit.logo.svg.includes('#0000ff'));
    assert.ok(r.kit.banner.svg.includes('#ff0000'));
    // round two was told its first redraws were weaker, with the SVG that stands
    const ask2 = fake.requests[3].params.messages.at(-1).content.at(-1).text;
    assert.match(ask2, /<current_logo><svg/);
    assert.match(ask2, /<current_banner><svg/);
    // and only a picture that changed is judged
    assert.equal(images(fake.requests[4]).length, 2);
  });

  it('never breaks a kit: a failed look call leaves the draft, and its cost is still counted', async () => {
    for (const fail of ['before', 'mid']) {
      const fake = fakeClient([{ text: draft() }, { text: '', fail }]);
      _setClient(fake);
      const r = await makeKit('a dog that only buys the top', { model: 'claude-sonnet-5-5', looks: 1 });
      assert.ok(r.kit.logo.svg.includes('#ff0000'));
      assert.deepEqual(r.art.picks, []);
      const draftUsd = costOf(USAGE, 'claude-sonnet-5-5');
      if (fail === 'before') assert.ok(Math.abs(r.usd - draftUsd) < 1e-9, 'a call that never answered cost nothing');
      // cut off mid reply: billed for its input and up to its whole output budget
      else assert.ok(r.usd >= draftUsd + costOf({ input_tokens: USAGE.input_tokens, output_tokens: 24000 }, 'claude-sonnet-5-5') - 1e-9);
    }
  });

  it('a redraw that will not render, or "keep", means no pick is asked for', async () => {
    const fake = fakeClient([{ text: draft() }, { text: revision('<svg viewBox="0 0 512 512"><rect width="10" height="nope', 'keep') }]);
    _setClient(fake);
    const r = await makeKit('a dog that only buys the top', { model: 'claude-sonnet-5-5', looks: 1 });
    assert.equal(fake.requests.length, 2);
    assert.ok(r.kit.logo.svg.includes('#ff0000'));
  });

  it('a draft cut off by max_tokens still makes a kit if both pictures were written, and jams if not', async () => {
    _setClient(fakeClient([{ text: draft(), stop: 'max_tokens' }]));
    const r = await makeKit('a dog that only buys the top', { model: 'claude-sonnet-5-5', looks: 0 });
    assert.ok(r.kit.banner.png);
    _setClient(fakeClient([{ text: draft().replace(/<banner>[\s\S]*$/, '<banner><svg viewBox="0 0 1500 500"><rect'), stop: 'max_tokens' }]));
    await assert.rejects(makeKit('a dog that only buys the top', { model: 'claude-sonnet-5-5', looks: 0 }), (e) => e.code === 'jam' && e.usd > 0);
  });

  it('looks: 0 is the one-shot engine (one call)', async () => {
    const fake = fakeClient([{ text: draft() }]);
    _setClient(fake);
    const r = await makeKit('a dog that only buys the top', { model: 'claude-sonnet-5-5', looks: 0 });
    assert.equal(fake.requests.length, 1);
    assert.equal(r.art.calls.length, 1);
  });

  it('a follow-up that redraws one picture only shows and judges that one', async () => {
    const fake = fakeClient([
      { text: draft({ logo: 'keep', banner: bannerSvg('#ffff00') }) },
      { text: revision('keep', bannerSvg('#00ffff')) },
      { text: '<banner>B</banner>' },
    ]);
    _setClient(fake);
    const current = { name: 'test dog', ticker: 'TDOG', bio: 'a test coin', style: 'soft 3d', dither: null, logoSvg: logoSvg('#ff0000'), bannerSvg: bannerSvg('#ff0000'), logo: 'https://x/logo.png', banner: 'https://x/banner.png', logoSvgUrl: 'https://x/logo.svg', bannerSvgUrl: 'https://x/banner.svg' };
    const r = await makeKit('a dog that only buys the top', { model: 'claude-sonnet-5-5', looks: 1, rand: A_IS_OLD, edit: { sentence: 'a dog that only buys the top', asks: [], ask: 'make the banner yellow', version: 1, current } });
    assert.equal(images(fake.requests[1]).length, 1, 'only the banner preview');
    assert.match(fake.requests[1].params.messages.at(-1).content.at(-1).text, /make the banner yellow/);
    assert.equal(images(fake.requests[2]).length, 2);
    assert.equal(r.kit.logo.reuse.png, 'https://x/logo.png', 'the kept logo is reused, not redrawn');
    assert.ok(r.kit.banner.svg.includes('#00ffff'));
  });

  it('the daily cap holds the whole kit: the draft plus every look round', () => {
    const one = worstCase('claude-sonnet-5-5');
    assert.ok(worstKit({ model: 'claude-sonnet-5-5', looks: 0 }) >= one - 1e-9);
    assert.ok(worstKit({ model: 'claude-sonnet-5-5', looks: 1 }) > one * 2);
    assert.ok(worstKit({ model: 'claude-sonnet-5-5', looks: 2 }) > worstKit({ model: 'claude-sonnet-5-5', looks: 1 }));
    assert.ok(worstKit({ model: 'claude-opus-5-5', looks: 1 }) > worstKit({ model: 'claude-sonnet-5-5', looks: 1 }));
    assert.ok(worstKit({ edit: true }) > worstKit({ edit: false }));
    // the measured cost of a kit stays under what was held for it
    const real = costOf(USAGE, 'claude-sonnet-5-5') * 2 + costOf({ input_tokens: 7000, output_tokens: 3000 }, 'claude-sonnet-5-5');
    assert.ok(real < worstKit({ model: 'claude-sonnet-5-5', looks: 1 }));
  });
});

describe('the finish', () => {
  it('reads data-finish off the root tag only', () => {
    assert.deepEqual(finishOf('<svg data-finish="grain .3 vignette .25">'), { grain: 0.3, vignette: 0.25 });
    assert.deepEqual(finishOf("<svg viewBox='0 0 1 1' data-finish='paper:0.5; chroma=1'>"), { paper: 0.5, chroma: 1 });
    assert.deepEqual(finishOf('<svg data-finish="grain 30">'), { grain: 0.3 });
    assert.equal(finishOf('<svg><g data-finish="grain .3"/></svg>'), null);
    assert.equal(finishOf('<svg data-finish="sparkle 1">'), null);
  });

  it('renders a finished picture at its size, the same every time', () => {
    const svg = logoSvg('#336699', 'grain .3 paper .4 vignette .3 scanlines .2 chroma .3');
    const a = renderPng(svg, 512);
    assert.ok(isPng(a));
    assert.deepEqual(pngSize(a), [512, 512]);
    assert.ok(same(a, renderPng(svg, 512)), 'seeded by the svg');
    assert.ok(!same(a, renderPng(logoSvg('#336699'), 512)));
  });
});
