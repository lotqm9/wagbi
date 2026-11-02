// POST /api/transcribe  (body: the recorded audio, Content-Type audio/webm | audio/mp4 | audio/mpeg | audio/wav | audio/ogg)
//   -> {ok, text}   the words, for the prompt box
// A real transcription model, server side only (no key reaches the browser), whichever has a key, in this order:
//   OpenAI      POST /v1/audio/transcriptions, model gpt-transcribe, $0.0045 a minute (OPENAI_API_KEY; docs and pricing
//               read 2026-11-02: developers.openai.com/api/docs/guides/speech-to-text and /api/docs/pricing)
//   ElevenLabs  POST /v1/speech-to-text, model scribe_v2, header xi-api-key (ELEVENLABS_API_KEY; docs read 2026-11-02:
//               elevenlabs.io/docs/api-reference/speech-to-text/convert; its per-minute price wasn't on that page, so it
//               is counted at a conservative $0.01 a minute)
// One that fails (no credit, down) hands over to the next. WAGBI_TRANSCRIBE=openai or =elevenlabs picks one only.
// Capped like generation: at most 2 MB (well under two minutes of speech), 20 clips per IP per hour, and each clip held
// against the same daily $ cap (WAGBI_DAILY_USD) as kits.
// Voice has its own slice of the day (WAGBI_VOICE_USD, default a tenth of the cap): clips can never use up what the
// coins need, however many come in.
import { clientIp, fail, limited, ok, sameOrigin } from './_lib/http.js';
import { capCheck, hasStore, hold, newId, settle, spendToday } from './_lib/store.js';

const MAX_BYTES = 2_000_000;
const USD_PER_MIN = { openai: 0.0045, elevenlabs: 0.01 };
const WORST_USD = 0.02;
const TYPES = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a' };
const cap = () => {
  const v = Number(process.env.WAGBI_DAILY_USD);
  return Number.isFinite(v) && v >= 0 ? v : 5;
};
const voiceCap = () => {
  const v = Number(process.env.WAGBI_VOICE_USD);
  return Number.isFinite(v) && v >= 0 ? v : cap() / 10;
};
const log = (o) => console.log(JSON.stringify({ at: 'transcribe', ...o }));

async function viaOpenAI(key, audio, type, ext) {
  const form = new FormData();
  form.append('model', 'gpt-transcribe');
  form.append('response_format', 'text');
  form.append('prompt', 'someone describing a memecoin idea in one sentence');
  form.append('file', new Blob([audio], { type }), `clip.${ext}`);
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.text();
}

async function viaElevenLabs(key, audio, type, ext) {
  const form = new FormData();
  form.append('model_id', 'scribe_v2');
  form.append('tag_audio_events', 'false');
  form.append('file', new Blob([audio], { type }), `clip.${ext}`);
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).text || '';
}

function providers() {
  const pick = process.env.WAGBI_TRANSCRIBE?.trim();
  const out = [];
  const o = process.env.OPENAI_API_KEY?.trim();
  const e = process.env.ELEVENLABS_API_KEY?.trim();
  if (o && pick !== 'elevenlabs') out.push(['openai', o, viaOpenAI]);
  if (e && pick !== 'openai') out.push(['elevenlabs', e, viaElevenLabs]);
  return out;
}

const oneLine = (t) => String(t).split(/\s+/).join(' ').trim().slice(0, 300);

export async function POST(req) {
  if (!sameOrigin(req)) return fail('cross_site', 403);
  const list = providers();
  if (!list.length || !hasStore()) return fail('off', 503);
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = TYPES[type];
  if (!ext) return fail('empty', 415);
  const ip = clientIp(req);
  if (limited(`talk:${ip}`, 20, 3600_000) || limited(`talkburst:${ip}`, 3, 10_000)) return fail('slow', 429);

  const audio = Buffer.from(await req.arrayBuffer());
  if (audio.length < 800) return fail('empty');
  if (audio.length > MAX_BYTES) return fail('too_long', 413);

  let day;
  const id = 't' + newId().slice(1);
  try {
    const spend = await spendToday();
    const room = capCheck(spend, WORST_USD, cap());
    if (room !== 'ok') return fail(room, 429);
    if (spend.voice + WORST_USD > voiceCap()) return fail('voice_rest', 429);
    day = await hold(id, WORST_USD);
  } catch (e) {
    log({ storage: String(e?.message ?? e).slice(0, 160) });
    return fail('off', 503);
  }

  let usd = 0;
  try {
    for (const [name, key, call] of list) {
      try {
        const text = oneLine(await call(key, audio, type, ext));
        // about 16 kB a second of speech in these formats: count what was sent, at least a second
        usd = (Math.max(1, audio.length / 16_000) / 60) * USD_PER_MIN[name];
        log({ ok: true, via: name, bytes: audio.length, chars: text.length });
        return ok({ text });
      } catch (e) {
        log({ ok: false, via: name, why: String(e?.message ?? e).slice(0, 200) });
      }
    }
    return fail('jam', 502);
  } finally {
    await settle(id, day, WORST_USD, usd).catch(() => {});
  }
}
