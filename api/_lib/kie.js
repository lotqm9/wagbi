// Kie.ai: the image models (Laith's provider for every picture). Async tasks on Kie's Market API, docs read 2026-11-02:
//   POST https://api.kie.ai/api/v1/jobs/createTask   { model, input }   -> data.taskId
//   GET  https://api.kie.ai/api/v1/jobs/recordInfo?taskId=...          -> data.state waiting | queuing | generating |
//        success | fail, resultJson ({ resultUrls }), creditsConsumed, failCode, failMsg
// Auth "Authorization: Bearer KIE_API_KEY". Kie answers HTTP 200 even when a call fails: body.code is the real status
// (401 key, 402 credits, 429 rate, 422/500 rejected). A task is billed only when it succeeds; results are deleted after
// 14 days, so each picture is downloaded right away. 1 credit is about $0.005 (kie.ai/pricing, 2026-11-02).
// Measured 2026-11-02 on the same wojak logo with the original as reference (scratchpad kie2/race.mjs):
//   nano-banana-pro   24 s    18 credits   faithful, follows the prompt     <- the default
//   nano-banana-2     15 s     8 credits   faithful face, ignored the prompt (badge with broken text)
//   gpt-image-2.5    204 s     6 credits   the most polished, but 172 s of it waiting in Kie's queue (a banner: 535 s)
//   seedream-5-flash 141 s   3.2 credits   faithful, flatter
// WAGBI_IMAGE_MODEL / WAGBI_IMAGE_BACKUP pick them without a code change; the backup is started when the first one
// fails or is still not done after WAGBI_HEDGE_MS (a hedge: whichever finishes first is used).
export const USD_PER_CREDIT = 0.005;
const API = 'https://api.kie.ai';

// how each model takes its references and its aspect ratio; credits = Kie's price for one 1K picture
export const MODELS = {
  'nano-banana-pro': { id: () => 'nano-banana-pro', refs: 'image_input', maxRefs: 8, credits: 18, extra: { resolution: '1K', output_format: 'png' } },
  'nano-banana-2': { id: () => 'nano-banana-2', refs: 'image_input', maxRefs: 10, credits: 8, extra: { resolution: '1K', output_format: 'png' } },
  'gpt-image-2.5': { id: (refs) => (refs ? 'gpt-image-2-5-flare-image-to-image' : 'gpt-image-2-5-flare-text-to-image'), refs: 'input_urls', maxRefs: 16, credits: 6, extra: { resolution: '1K' } },
  'seedream-5-flash': { id: (refs) => (refs ? 'seedream/5-flash-image-to-image' : 'seedream/5-flash-text-to-image'), refs: 'image_urls', maxRefs: 10, credits: 4, extra: { output_format: 'png' } },
};
export const ASPECT = { logo: '1:1', banner: '21:9' };

export const imageModel = () => (MODELS[process.env.WAGBI_IMAGE_MODEL?.trim()] ? process.env.WAGBI_IMAGE_MODEL.trim() : 'nano-banana-pro');
export const backupModel = () => {
  const v = process.env.WAGBI_IMAGE_BACKUP?.trim();
  if (v === 'none') return null;
  return MODELS[v] ? v : 'gpt-image-2.5';
};
export const hedgeMs = () => {
  const v = Number(process.env.WAGBI_HEDGE_MS);
  return Number.isFinite(v) && v >= 5000 ? v : 75_000;
};
/** The most one picture can cost: the first model and the backup both billed. */
export const worstPictureUsd = (a = imageModel(), b = backupModel()) => ((MODELS[a]?.credits ?? 20) + (b ? MODELS[b]?.credits ?? 20 : 0)) * USD_PER_CREDIT;

export class KieError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind; // config | http | content | failed | timeout | download
    Object.assign(this, extra);
  }
  get retryable() {
    return this.kind !== 'config' && this.kind !== 'content';
  }
}
const CONTENT = /(content|policy|safety|sensitive|moderat|nsfw|violat|inappropriate|not allowed|copyright)/i;

// ---------- when Kie can't paint at all (out of credits, a bad key) ----------
// A line that is easy to alert on (Vercel's log search or a drain: "WAGBI_ALERT"), at most once per breaker trip per
// instance, so it is loud without flooding. While the breaker is open the maker skips Kie and draws the art itself.
const BREAK_MS = 10 * 60_000;
let downUntil = 0;
let downWhy = null;
/** Why Kie is out right now (402 credits, 401 key, ...), or null. */
export const kieDown = (now = Date.now()) => (now < downUntil ? downWhy : null);
/** Opens the breaker; true when it was closed (the moment to raise the alert). */
export function markKieDown(why, now = Date.now(), ms = BREAK_MS) {
  const first = now >= downUntil;
  downUntil = now + ms;
  downWhy = why;
  return first;
}
/** For tests: closes the breaker. */
export const _resetKie = () => { downUntil = 0; downWhy = null; credit = null; };
export function alert(what, fields = {}) {
  console.error(`WAGBI_ALERT ${what} ${JSON.stringify({ at: 'kie', alert: what, ...fields })}`);
}
const outWhy = (code) => (code === 402 ? 'kie_out_of_credits' : code === 401 ? 'kie_bad_key' : 'kie_config');

let fetcher = fetch;
/** For tests: a stand-in for fetch (null puts the real one back). */
export const _setFetch = (f) => { fetcher = f || fetch; };
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason ?? new Error('aborted')); }, { once: true });
});
const key = () => {
  const k = process.env.KIE_API_KEY?.trim();
  if (!k || /\s/.test(k)) throw new KieError('config', 'KIE_API_KEY is missing', { out: 'kie_no_key' });
  return k;
};
export const hasKie = () => !!process.env.KIE_API_KEY?.trim();

// the account's credits (GET /api/v1/chat/credit -> data: credits left; docs.kie.ai, read 2026-11-02), looked at most
// once a minute per instance: under LOW_CREDITS the alert goes out, under one turn's pictures the maker draws instead
let credit = null; // { at, left, warned }
export const lowCredits = () => {
  const v = Number(process.env.WAGBI_KIE_LOW_CREDITS);
  return Number.isFinite(v) && v >= 0 ? v : 300;
};
/** Credits left on the Kie account (null when it can't be read; a failed read never blocks a turn). */
export async function creditsLeft({ now = Date.now(), signal } = {}) {
  if (!hasKie()) return null;
  if (credit && now - credit.at < 60_000) return credit.left;
  let left = null;
  try {
    const body = await call('/api/v1/chat/credit', { method: 'GET' }, { tries: 1, signal });
    left = Number.isFinite(Number(body?.data)) ? Number(body.data) : null;
  } catch {
    left = null; // a 401/402 has opened the breaker already
  }
  const warned = credit?.warned && now - credit.warned < 30 * 60_000 ? credit.warned : 0;
  credit = { at: now, left, warned };
  if (left !== null && left < lowCredits() && !warned) {
    credit.warned = now;
    alert('kie_credits_low', { credits: left, about: `${Math.floor(left / 72)} coins left at nano-banana-pro prices` });
  }
  return left;
}

async function call(path, init = {}, { tries = 3, signal } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    let res, body;
    try {
      res = await fetcher(API + path, { ...init, headers: { Authorization: `Bearer ${key()}`, ...(init.headers || {}) }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      if (e instanceof KieError || signal?.aborted) throw e;
      last = new KieError('http', `kie ${path.split('?')[0]}: ${String(e?.message ?? e).slice(0, 120)}`);
      await sleep(800 * (i + 1), signal);
      continue;
    }
    const code = body.code ?? res.status;
    if (code === 200) return body;
    const why = `kie ${path.split('?')[0]}: HTTP ${res.status} code ${code} ${String(body.msg || '').slice(0, 160)}`.trim();
    if (code === 401 || code === 402) {
      if (markKieDown(outWhy(code))) alert(outWhy(code), { code, msg: String(body.msg || '').slice(0, 160) });
      throw new KieError('config', why, { code, out: outWhy(code) });
    }
    if (code === 429 || code >= 500) {
      last = new KieError('http', why, { code });
      await sleep(1500 * (i + 1), signal);
      continue;
    }
    throw new KieError(CONTENT.test(String(body.msg || '')) ? 'content' : 'http', why, { code });
  }
  throw last;
}

/** The createTask body for one picture. refs: public image URLs (references to draw from). */
export function taskOf(model, { prompt, refs = [], aspect }) {
  const m = MODELS[model];
  if (!m) throw new KieError('config', `no image model ${model}`);
  const r = refs.slice(0, m.maxRefs);
  const input = { prompt: String(prompt).slice(0, 8000), aspect_ratio: aspect, ...m.extra };
  if (r.length) input[m.refs] = r;
  return { model: m.id(r.length > 0), input };
}

export async function createTask(task, { signal } = {}) {
  const body = await call('/api/v1/jobs/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(task) }, { signal });
  const id = body?.data?.taskId;
  if (!id) throw new KieError('http', 'kie createTask: no taskId');
  return id;
}

/** One look at a task: { state, url?, credits, failCode?, failMsg? } (state: waiting, queuing, generating, success, fail). */
export async function taskState(taskId, { signal } = {}) {
  const body = await call(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { method: 'GET' }, { signal });
  const d = body?.data || {};
  let url = null;
  if (d.state === 'success') {
    try {
      url = JSON.parse(d.resultJson || '{}').resultUrls?.[0] ?? null;
    } catch {
      url = null;
    }
  }
  return { state: d.state || 'waiting', url, credits: Number(d.creditsConsumed) || 0, failCode: d.failCode ?? null, failMsg: d.failMsg ?? null };
}

async function download(url, signal) {
  // Kie's result host (tempfile.aiquickdraw.com and the like): https only, size capped
  if (!/^https:\/\//.test(url)) throw new KieError('download', 'result url is not https');
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetcher(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 64 || buf.length > 30_000_000) throw new Error(`${buf.length} bytes`);
      return buf;
    } catch (e) {
      if (signal?.aborted) throw e;
      if (i === 2) throw new KieError('download', `kie download: ${String(e?.message ?? e).slice(0, 120)}`);
      await sleep(1000 * (i + 1), signal);
    }
  }
  throw new KieError('download', 'kie download failed');
}

/**
 * One picture on one model: creates the task, polls it, downloads the result. onState(state) hears every change
 * (waiting, queuing, generating). Resolves { data, model, taskId, credits, usd, ms }; throws KieError.
 * book(entry) is told about the task as soon as it exists, so a picture abandoned mid-way is still counted.
 */
export async function paintOne(model, req, { signal, onState = () => {}, book = () => {}, pollMs = 2500, timeoutMs = 600_000 } = {}) {
  const t0 = Date.now();
  const task = taskOf(model, req);
  const taskId = await createTask(task, { signal });
  const entry = { model, taskId, usd: MODELS[model].credits * USD_PER_CREDIT, state: 'running', t0 };
  book(entry);
  let last = '';
  try {
    for (;;) {
      await sleep(pollMs, signal);
      if (Date.now() - t0 > timeoutMs) throw new KieError('timeout', `kie task ${taskId} took over ${Math.round(timeoutMs / 1000)} s`, { taskId });
      let s;
      try {
        s = await taskState(taskId, { signal });
      } catch (e) {
        if (e instanceof KieError && e.kind === 'config') throw e;
        continue; // a missed poll is not a failed picture
      }
      if (s.state !== last) {
        last = s.state;
        onState(s.state);
      }
      if (s.state === 'success') {
        if (!s.url) throw new KieError('failed', `kie task ${taskId}: no result url`, { taskId });
        const data = await download(s.url, signal);
        const usd = (s.credits || MODELS[model].credits) * USD_PER_CREDIT;
        Object.assign(entry, { state: 'done', usd, ms: Date.now() - t0 });
        return { data, model, taskId, credits: s.credits, usd, ms: Date.now() - t0 };
      }
      if (s.state === 'fail') {
        const why = `${s.failCode ?? ''} ${s.failMsg ?? ''}`.trim();
        Object.assign(entry, { state: 'failed', usd: 0, ms: Date.now() - t0 });
        throw new KieError(CONTENT.test(why) ? 'content' : 'failed', `kie task ${taskId} failed: ${why.slice(0, 200)}`, { taskId });
      }
    }
  } catch (e) {
    if (entry.state === 'running') entry.state = 'abandoned'; // may still succeed and be billed: stays at its price
    throw e;
  }
}

/**
 * One picture, hedged: the first model, and the backup when the first fails or is not done after hedgeMs. The first
 * to finish wins; the other is abandoned (and counted at its price, since it may still be billed).
 * onState({ model, state }) hears both. Throws the last error when neither could make it.
 */
export async function paint(req, { models = [imageModel(), backupModel()].filter(Boolean), hedge = hedgeMs(), signal, onState = () => {}, book = () => {}, pollMs, timeoutMs } = {}) {
  const ctl = new AbortController();
  const stop = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal;
  const errors = [];
  let started = 0;
  return new Promise((resolve, reject) => {
    let done = false;
    let running = 0;
    let timer = null;
    const start = (i) => {
      if (done || i >= models.length || i < started) return;
      started = i + 1;
      running++;
      if (i + 1 < models.length) timer = setTimeout(() => start(i + 1), hedge);
      paintOne(models[i], req, { signal: stop, onState: (state) => onState({ model: models[i], state, backup: i > 0 }), book, ...(pollMs ? { pollMs } : {}), ...(timeoutMs ? { timeoutMs } : {}) })
        .then((r) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          ctl.abort(new Error('another model finished first'));
          resolve(r);
        })
        .catch((e) => {
          running--;
          if (done) return;
          errors.push(e);
          if (e instanceof KieError && e.kind === 'config') {
            done = true;
            clearTimeout(timer);
            ctl.abort(e);
            return reject(e);
          }
          if (started < models.length) {
            clearTimeout(timer);
            start(started); // the backup now, without waiting for the hedge
          } else if (running === 0) {
            done = true;
            reject(errors.at(-1));
          }
        });
    };
    start(0);
  });
}
