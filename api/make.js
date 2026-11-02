// POST /api/make {sentence, from?}  ->  a stream of newline separated JSON, one event per line:
//   {type:'start', id, root, version}         the kit's id (stored under it once it is done), its coin, its version
// With "from" (a kit id) the sentence is a follow-up on that kit: the model gets the coin's whole conversation and
// the kit as it is, changes only what was asked, and the result is the coin's next version (a new kit; the old ones
// stay). Every follow-up counts against the same limits as a new coin.
//   {type:'step', step:'read'|'name'|'logo'|'banner'}
//   {type:'name', name, ticker, bio}          as soon as the words are written
//   {type:'logo', png} / {type:'banner', png} each image as a data url, as soon as it is drawn
//   {type:'done', kit}                        the stored kit (see /api/kit/:id)
//   {type:'error', code, error}               a polite message; the stream ends after it
// Guards before anything is spent: 140 characters, slurs, about 6 kits per hour per IP, and the daily cap
// (WAGBI_DAILY_USD, default 5). A refusal from the model arrives as an error event.
// A kit is several calls (the draft, then the look-and-fix pass: a redraw and a blind pick per round, WAGBI_LOOKS):
// the cap holds the worst case of all of them while it runs and then counts what every call really cost.
//   {type:'step', step:'look'}                the look pass started; a better logo/banner may follow it
// The work runs to the end even if the visitor leaves, so the kit is stored and the spend is counted.
import { waitUntil } from '@vercel/functions';
import { EngineError, MAX_SENTENCE, badWords, cleanSentence, makeKit, worstKit } from './_lib/engine.js';
import { MESSAGES, clientIp, fail, limited, readJson } from './_lib/http.js';
import { hasStore, hold, isId, markIp, newId, putVersion, readKit, recentByIp, saveKit, settle, spentToday, versionsOf } from './_lib/store.js';

// kits (new coins and follow-ups alike) per IP per hour; WAGBI_PER_HOUR raises it without a code change
const PER_HOUR = (() => {
  const v = Number(process.env.WAGBI_PER_HOUR);
  return Number.isInteger(v) && v > 0 && v <= 100 ? v : 6;
})();
const cap = () => {
  const v = Number(process.env.WAGBI_DAILY_USD);
  return Number.isFinite(v) && v >= 0 ? v : 5;
};

function channel() {
  const enc = new TextEncoder();
  let ctrl;
  let open = true;
  const readable = new ReadableStream({
    start(c) { ctrl = c; },
    cancel() { open = false; },
  });
  const push = (s) => {
    if (!open) return;
    try { ctrl.enqueue(enc.encode(s)); } catch { open = false; }
  };
  return {
    readable,
    send: (obj) => push(JSON.stringify(obj) + '\n'),
    ping: () => push('\n'),
    close() {
      if (!open) return;
      open = false;
      try { ctrl.close(); } catch { /* already gone */ }
    },
  };
}

const log = (obj) => console.log(JSON.stringify({ at: 'make', ...obj }));
const round = (usd) => Math.round(usd * 10000) / 10000;

/** A follow-up's context: the kit it edits, its coin's conversation so far, both current SVGs. */
async function followUp(from, ask) {
  const cur = await readKit(from);
  if (!cur) return null;
  const root = cur.root || cur.id;
  const versions = await versionsOf(root);
  // a coin from before conversations: its first kit becomes version 1 now
  if (versions.length === 1 && versions[0].at === null) await putVersion(root, 1, { kitId: root, ask: null, parent: null, at: cur.made || null });
  const svg = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`svg ${r.status}`);
    return r.text();
  };
  const [logoSvg, bannerSvg] = await Promise.all([svg(cur.logoSvg), svg(cur.bannerSvg)]);
  const at = versions.findIndex((v) => v.kitId === cur.id);
  // the asks that led to the kit being edited (its own line back to version 1), oldest first
  const asks = versions.slice(1, at < 0 ? versions.length : at + 1).map((v) => v.ask).filter(Boolean);
  return {
    thread: { root, version: versions.at(-1).version + 1, parent: cur.id, ask },
    edit: {
      sentence: cur.sentence, asks, ask, version: cur.version || 1,
      current: { name: cur.name, ticker: cur.ticker, bio: cur.bio, style: cur.style, dither: cur.dither ?? null, logoSvg, bannerSvg, logo: cur.logo, banner: cur.banner, logoSvgUrl: cur.logoSvg, bannerSvgUrl: cur.bannerSvg },
    },
  };
}

async function run(id, sentence, ch, day, held, from) {
  const t0 = Date.now();
  let usd = held;
  const ping = setInterval(ch.ping, 10_000);
  try {
    const f = from ? await followUp(from, sentence) : null;
    if (from && !f) throw new Error('the kit to change is gone');
    const thread = f ? f.thread : { root: id, version: 1, parent: null, ask: null };
    ch.send({ type: 'start', id, root: thread.root, version: thread.version });
    const res = await makeKit(f ? f.edit.sentence : sentence, { emit: ch.send, edit: f ? f.edit : null });
    usd = res.usd;
    const kit = await saveKit(id, res.kit, res.model, thread);
    ch.send({ type: 'done', kit });
    const calls = res.art?.calls?.map((c) => `${c.step}:${c.state}:${round(c.usd)}`).join(' ');
    log({ id, ok: true, root: thread.root, version: kit.version, ms: Date.now() - t0, usd: round(usd), model: res.model, in: res.usage?.input_tokens, out: res.usage?.output_tokens, calls, picks: res.art?.picks });
  } catch (e) {
    let code = 'jam';
    if (e instanceof EngineError) {
      // the engine books every call: one that failed before any reply cost nothing, one cut off mid reply its worst case
      usd = Number.isFinite(e.usd) ? e.usd : held;
      if (e.code === 'nope') code = e.reason === 'real_person' ? 'real_person' : 'nope';
    }
    ch.send({ type: 'error', code, error: MESSAGES[code] });
    log({ id, ok: false, code, why: String(e?.message ?? e).slice(0, 240), ms: Date.now() - t0, usd: round(usd) });
  } finally {
    clearInterval(ping);
    ch.close();
    await settle(id, day, held, usd).catch((err) => log({ id, settle: String(err?.message ?? err).slice(0, 160) }));
  }
}

export async function POST(req) {
  const body = await readJson(req);
  const sentence = cleanSentence(body?.sentence);
  if (!sentence) return fail('empty');
  if (sentence.length > MAX_SENTENCE) return fail('too_long');
  if (badWords(sentence)) return fail('nope', 422);
  const from = body?.from == null ? null : isId(body.from) ? body.from : undefined;
  if (from === undefined) return fail('not_found', 404);
  if (!process.env.ANTHROPIC_API_KEY?.trim() || !hasStore()) return fail('off', 503);

  const ip = clientIp(req);
  if (limited(`make:${ip}`, PER_HOUR, 3600_000) || limited(`burst:${ip}`, 2, 20_000)) return fail('slow', 429);

  const worst = worstKit({ edit: !!from });
  let spent, recent;
  try {
    [spent, recent] = await Promise.all([spentToday(), recentByIp(ip)]);
  } catch (e) {
    log({ storage: String(e?.message ?? e).slice(0, 160) });
    return fail('off', 503);
  }
  if (spent + worst > cap()) return fail('resting', 429);
  if (recent >= PER_HOUR) return fail('slow', 429);

  const id = newId();
  let day;
  try {
    [, day] = await Promise.all([markIp(ip, id), hold(id, worst)]);
  } catch (e) {
    log({ storage: String(e?.message ?? e).slice(0, 160) });
    return fail('off', 503);
  }

  const ch = channel();
  waitUntil(run(id, sentence, ch, day, worst, from));
  return new Response(ch.readable, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
