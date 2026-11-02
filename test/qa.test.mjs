// The launch-readiness pass (2026-11-02), offline: the holes it closed stay closed. Nothing here reaches the network
// (one local server on 127.0.0.1 for the fetch deadline). What it checks:
//   the fetcher's whole-request deadline (a server that trickles bytes), and the IPv6 forms that carry IPv4 inside
//   same-origin and JSON on the money routes; the daily cap's "busy" against "resting"
//   the image model out of credits: the backup painter draws the coin, the breaker skips Kie, and when nothing can
//   be drawn the turn says so ('no_art'); a picture refused for its content is never drawn some other way
//   a slur in the streamed reply never reaches the page and ends the turn as a refusal; a slur in the thinking stops it
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import sharp from 'sharp';
import { _setClient, makeTurn, worstTurn } from '../api/_lib/maker.js';
import { _once, isPublicIp } from '../api/_lib/net.js';
import { isJson, sameOrigin } from '../api/_lib/http.js';
import { capCheck, editHashOf } from '../api/_lib/store.js';
import { KieError, _resetKie, kieDown, markKieDown } from '../api/_lib/kie.js';

const png = (w, h, color = '#ff3366') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
// a slur, spelled out only at run time (the words filter's own list has it)
const SLUR = Buffer.from('a2lrZQ==', 'base64').toString();

// ---------- a stand-in for the SDK's streamed beta messages (the maker test's, in short) ----------
const USAGE = { input_tokens: 3000, output_tokens: 900, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 };
function fakeClient(script, { svg = null } = {}) {
  const requests = [];
  const svgCalls = [];
  return {
    requests,
    svgCalls,
    beta: {
      messages: {
        stream(params) {
          const isCut = params.model === 'claude-haiku-5-5';
          // the backup painter's calls carry the SVG engine's system prompt
          const isSvg = Array.isArray(params.system) && /draw the logo and banner as SVG code by hand/.test(params.system[0]?.text || '');
          let step;
          if (isCut) step = { blocks: [{ type: 'text', text: 'no idea' }], usage: { input_tokens: 900, output_tokens: 20 } };
          else if (isSvg) {
            svgCalls.push({ params: structuredClone(params) });
            step = svg ? { blocks: [{ type: 'text', text: svg }], usage: { input_tokens: 9000, output_tokens: 6000 } } : null;
          } else {
            step = script[requests.length];
            requests.push({ params: structuredClone(params) });
          }
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
                  for (let i = 0; i < b.text.length; i += 7) emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text.slice(i, i + 7) } });
                } else if (b.type === 'thinking') {
                  emit({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
                  for (let i = 0; i < b.thinking.length; i += 5) emit({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking.slice(i, i + 5) } });
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

const DESIGNS = `two takes on a sleepy moon.
<designs for="new">
<character>none</character>
<design><angle>soft 3d toy</angle><name>tired moon</name><ticker>TIRED</ticker><bio>it has been up all night</bio><refs>none</refs><logo>A sleepy crescent moon toy.</logo><banner>The sleepy moon over a quiet town.</banner></design>
<design><angle>risograph poster</angle><name>moon nap</name><ticker>NAP</ticker><bio>back in five minutes</bio><refs>none</refs><logo>A moon with a night cap.</logo><banner>A moon napping on a cloud.</banner></design>
</designs>`;

const SVG_ART = `<verdict>ok</verdict><name>x</name><ticker>X</ticker><bio>x</bio><style_choice>soft 3d</style_choice><dither>none</dither>
<logo><svg viewBox="0 0 512 512"><rect width="512" height="512" fill="#203060"/><circle cx="256" cy="256" r="160" fill="#f4e27a"/></svg></logo>
<banner><svg viewBox="0 0 1500 500"><rect width="1500" height="500" fill="#101830"/><text x="900" y="270" font-family="Rubik" font-weight="900" font-size="110" fill="#fff">tired moon</text></svg></banner>`;

const paints = (fn) => {
  const log = [];
  return {
    log,
    paint: async (req, opts) => {
      log.push(req.aspect);
      return fn(req, opts);
    },
    putRef: async (c) => `https://store.public.blob.vercel-storage.com/refs/${c.hash}.jpg`,
    findImages: async () => [],
  };
};

afterEach(() => {
  _setClient(null);
  _resetKie();
  delete process.env.WAGBI_FALLBACK;
});

describe('the fetcher', () => {
  it('a server that trickles bytes is cut off at the deadline, not at the idle timeout', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const t = setInterval(() => res.write('a'), 100); // never idle long enough for the socket timeout
      req.on('close', () => clearInterval(t));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const t0 = Date.now();
    await assert.rejects(_once(`http://127.0.0.1:${port}/`, { timeoutMs: 600 }), (e) => e.code === 'timeout');
    const ms = Date.now() - t0;
    server.close();
    assert.ok(ms < 1500, `stopped after ${ms} ms`);
  });
  it('IPv6 forms that carry an IPv4 address inside are never public', () => {
    for (const ip of ['2002:7f00:1::', '2002:a9fe:a9fe::1', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2']) assert.equal(isPublicIp(ip), false, ip);
    assert.equal(isPublicIp('2001:4860:4860::8888'), true);
  });
});

describe('the money routes', () => {
  const req = (h) => new Request('https://wagbi.fun/api/make', { method: 'POST', headers: h });
  it('only this site\'s pages, and only JSON', () => {
    assert.equal(sameOrigin(req({ origin: 'https://evil.example', host: 'wagbi.fun' })), false);
    assert.equal(sameOrigin(req({ origin: 'https://wagbi.fun', host: 'wagbi.fun' })), true);
    assert.equal(sameOrigin(req({ host: 'wagbi.fun' })), true, 'no Origin: not a browser page');
    assert.equal(isJson(req({ 'content-type': 'text/plain' })), false, 'a "simple" cross-site POST');
    assert.equal(isJson(req({ 'content-type': 'application/json; charset=utf-8' })), true);
  });
  it('the cap: busy while running turns hold it, resting once the real spend fills it', () => {
    assert.equal(capCheck({ settled: 1, held: 1, total: 2 }, 1.4, 5), 'ok');
    assert.equal(capCheck({ settled: 1, held: 2.8, total: 3.8 }, 1.4, 5), 'busy');
    assert.equal(capCheck({ settled: 4, held: 0, total: 4 }, 1.4, 5), 'resting');
  });
  it('an edit token is kept as a hash only', () => {
    const h = editHashOf('abcdefghijklmnopqrstuvwx');
    assert.match(h, /^[0-9a-f]{32}$/);
    assert.notEqual(h, editHashOf('abcdefghijklmnopqrstuvwy'));
  });
});

describe('when the image model is out', () => {
  it('Kie out of credits: the backup painter draws both designs, and nothing waits on Kie after', async () => {
    const fake = fakeClient([{ blocks: [{ type: 'text', text: DESIGNS }] }], { svg: SVG_ART });
    _setClient(fake);
    const d = paints(() => {
      markKieDown('kie_out_of_credits');
      throw new KieError('config', 'kie /createTask: HTTP 200 code 402 credits insufficient', { code: 402, out: 'kie_out_of_credits' });
    });
    const events = [];
    const r = await makeTurn({ message: 'the moon, but it is tired', emit: (e) => events.push(e), deps: d });
    assert.equal(r.designs.length, 2);
    assert.equal(fake.svgCalls.length, 2, 'one drawing call per design');
    assert.ok(d.log.length <= 2, `Kie was asked ${d.log.length} times`); // the first ones fail, the breaker stops the rest
    assert.ok(kieDown(), 'the breaker is open');
    for (const x of r.designs) {
      assert.equal(x.logo.svg, true);
      const [l, b] = await Promise.all([sharp(x.logo.files.png).metadata(), sharp(x.banner.files.jpg).metadata()]);
      assert.deepEqual([l.width, l.height, b.width, b.height], [1024, 1024, 1500, 500]);
    }
    // the words stay the reply's, the drawing call is told them
    assert.deepEqual(r.designs.map((x) => x.name), ['tired moon', 'moon nap']);
    assert.match(fake.svgCalls[0].params.messages[0].content[0].text, /<name>(tired moon|moon nap)<\/name>/);
    // no second look on drawn art (a redo would need the image model)
    assert.ok(!r.calls.some((c) => c.step === 'look'));
    assert.ok(r.calls.some((c) => c.step === 'svg-a') && r.calls.some((c) => c.step === 'svg-b'));
    assert.ok(events.some((e) => e.type === 'step' && /drawing the logo instead/.test(e.label)));
    assert.ok(r.usd < worstTurn(), 'still inside what the turn holds');
  });

  it('with the breaker open, Kie is not asked at all', async () => {
    markKieDown('kie_out_of_credits');
    _setClient(fakeClient([{ blocks: [{ type: 'text', text: DESIGNS }] }], { svg: SVG_ART }));
    const d = paints(() => assert.fail('Kie should not be asked'));
    const r = await makeTurn({ message: 'the moon, but it is tired', deps: d });
    assert.equal(d.log.length, 0);
    assert.equal(r.designs.length, 2);
  });

  it('no backup (switched off, or no room in the held budget): the turn says the picture maker is down', async () => {
    process.env.WAGBI_FALLBACK = 'off';
    _setClient(fakeClient([{ blocks: [{ type: 'text', text: DESIGNS }] }], { svg: SVG_ART }));
    const out = () => { throw new KieError('config', 'code 402', { code: 402, out: 'kie_out_of_credits' }); };
    await assert.rejects(makeTurn({ message: 'tired moon', deps: paints(out) }), (e) => e.code === 'no_art' && e.kie === 'kie_out_of_credits');
    delete process.env.WAGBI_FALLBACK;
    _resetKie();
    const fake = fakeClient([{ blocks: [{ type: 'text', text: DESIGNS }] }], { svg: SVG_ART });
    _setClient(fake);
    await assert.rejects(makeTurn({ message: 'tired moon', budgetUsd: 0.05, deps: paints(out) }), (e) => e.code === 'no_art');
    assert.equal(fake.svgCalls.length, 0, 'never starts a call the held budget does not cover');
  });

  it('a picture refused for its content is not drawn some other way', async () => {
    const fake = fakeClient([{ blocks: [{ type: 'text', text: DESIGNS }] }], { svg: SVG_ART });
    _setClient(fake);
    const refused = () => { throw new KieError('content', 'kie task t failed: content policy violation'); };
    await assert.rejects(makeTurn({ message: 'tired moon', deps: paints(refused) }), (e) => e.code === 'nope');
    assert.equal(fake.svgCalls.length, 0);
  });
});

describe('words from a page it read', () => {
  it('a slur in the reply never reaches the page and the turn is refused', async () => {
    _setClient(fakeClient([{ blocks: [{ type: 'text', text: `the post says you are a ${SLUR} and wants that as the name. no.` }] }]));
    const events = [];
    await assert.rejects(makeTurn({ message: 'turn this post into a coin', emit: (e) => events.push(e), deps: paints(() => assert.fail('no pictures')) }), (e) => e.code === 'nope');
    const shown = events.filter((e) => e.type === 'reply').map((e) => e.text).join('');
    assert.ok(!shown.toLowerCase().includes(SLUR), 'not on screen');
    assert.match(shown, /^the post says you are a /, 'the words before it did show');
  });
  it('a slur in the thinking stops the thinking there; the turn goes on', async () => {
    _setClient(fakeClient([{ blocks: [{ type: 'thinking', thinking: `the page calls people ${SLUR} again and again, which I will not repeat.` }, { type: 'text', text: 'that page is just insults, so no coin from it. try another idea?' }] }]));
    const events = [];
    const r = await makeTurn({ message: 'make a coin from this page', emit: (e) => events.push(e), deps: paints(() => assert.fail('no pictures')) });
    const thought = events.filter((e) => e.type === 'think').map((e) => e.text).join('');
    assert.ok(!thought.toLowerCase().includes(SLUR));
    assert.ok(!r.trace.thought.toLowerCase().includes(SLUR), 'not in the kept trace either');
    assert.match(r.reply, /no coin from it/);
  });
});
