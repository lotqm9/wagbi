// POST /api/make {message, from?, history?, files?, links?, web?}  ->  a stream of newline separated JSON, one event a
// line. One message to wagbi's assistant (api/_lib/maker.js): it answers in chat, and when the message asks for a coin
// (or a change to one) it makes two coin kits from two angles, showing the work as it happens:
//   {type:'start', ids:[a, b], token, keys}     the ids the kits will have, if any are made; the edit token a new
//                                               coin from this turn gets (the page keeps it: see TOKEN below); and the
//                                               site key each id would have as a new coin's first kit (sites.js)
//   {type:'reply', text, replace?}              the assistant's chat reply, as it streams (replace: the whole text)
//   {type:'think', text, phase}                 its summarised thinking, as it streams ('plan', then 'look')
//   {type:'step', id, state, label, ms?, ...}   one row of the work: state 'run' | 'done' | 'fail'. Extras: thumbs
//                                               [{src, href, title}] (the originals found), links [{title, href}]
//                                               (web results, links read), phase 'waiting' | 'painting' (a picture)
//   {type:'design', i, name, ticker, bio, angle}  a design's words, as soon as they are written
//   {type:'thought', ms}                        the reply is written; only pictures are left
//   {type:'art', i, kind, src}                  a picture (a data url preview) as soon as it is painted
//   {type:'done', reply, kits, site?}           the reply, the stored kits (one per design that came out, or none) and
//                                               the coin's website, now showing the first design ({ slug, path, url })
//   {type:'error', code, error}                 a polite message; the stream ends after it
// from: the kit the person is on (its words and pictures come from storage, so "make it blue" knows what "it" is).
// A message there that talks about the coin's website ("make the website dark", "rewrite the lore") goes to the site
// editor first (coinsite.js siteTurn): it changes the site, or hands the message back when it is about the coin itself.
// siteKey: the chat's key for its coin's website (sites.js); the signed-in person (if any) counts for older coins.
// history: the conversation so far as the page keeps it, [{q, a, made: [{name, ticker, angle}], picked}], last 12.
// files: up to 4 pictures from /api/upload. links: up to 3 links to read (a post on X, any page); links typed in the
// message are read too. web: false turns web search off for this message (on by default).
// Guards before anything is spent: this site's own pages only (Origin + JSON), 600 characters, slurs, a few messages
// per hour per IP, and the daily cap (WAGBI_DAILY_USD, default 5): a message holds its worst case (maker.js worstTurn)
// while it runs, then counts what every call and every picture really cost ('busy' while only running turns' holds
// are in the way, 'resting' once the day's real spend is). The work runs to the end even if the visitor leaves, and
// how it ended is kept at turns/<first id>.json for a page that lost the stream (api/kit/<id>?turn=1 reads it).
import { randomBytes } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { EngineError, badWords, cleanSentence } from './_lib/engine.js';
import { MESSAGES, clientIp, fail, isJson, limited, readJson, sameOrigin } from './_lib/http.js';
import { MODELS, alert, creditsLeft, imageModel, kieDown, markKieDown } from './_lib/kie.js';
import { forModel } from './_lib/images.js';
import { checkUrl, safeGet } from './_lib/net.js';
import { linksIn } from './_lib/links.js';
import { MAX_LINKS, MAX_MESSAGE, cleanHistory, makeTurn, worstTurn } from './_lib/maker.js';
import { capCheck, editHashOf, hasStore, hold, isId, markIp, newId, putRef, putTurn, readKit, recentByIp, saveTurn, settle, spendToday, uploadUrl, versionsOf } from './_lib/store.js';
import { siteKey } from './_lib/sites.js';
import { afterTurn, siteTurn } from './_lib/coinsite.js';
import { mentionsSite } from './_lib/siteedit.js';
import { authConfig, sessionOf } from './_lib/auth.js';

// messages (new coins, changes and questions alike) per IP per hour; WAGBI_PER_HOUR raises it without a code change
const PER_HOUR = (() => {
  const v = Number(process.env.WAGBI_PER_HOUR);
  return Number.isInteger(v) && v > 0 && v <= 200 ? v : 12;
})();
const cap = () => {
  const v = Number(process.env.WAGBI_DAILY_USD);
  return Number.isFinite(v) && v >= 0 ? v : 5;
};
const MAX_FILES = 4;
// the function has 800 s (vercel.json); the turn plans to be done well before
const BUDGET_MS = 740_000;

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

// Who may add versions to a coin: the page that made it. A new coin's turn hands its page an edit token (in the
// start event); each kit stores only the token's hash. A message "on" a coin without its token (someone else's coin
// from the coins tab, or one made before tokens) makes a new coin from it instead of a version of it, so nobody can
// put their own version on another person's coin page.
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const newToken = () => randomBytes(18).toString('base64url');

/** The coin the person is on, from storage: its words, pictures, prompts and references, and its next version. */
async function currentOf(from) {
  const k = await readKit(from);
  if (!k) return null;
  const root = k.root || k.id;
  const versions = await versionsOf(root);
  return {
    id: k.id, root, sentence: k.sentence, version: k.version || 1, next: versions.at(-1).version + 1,
    line: [...(Array.isArray(k.line) ? k.line.filter(isId) : []), k.id].slice(-40),
    name: k.name, ticker: k.ticker, bio: k.bio, angle: k.angle || k.style || '', character: k.character || null,
    logo: k.logo, thumb: k.thumb || null, banner: k.banner,
    logoPrompt: k.prompts?.logo || null, bannerPrompt: k.prompts?.banner || null,
    // the art direction, and the banner's painting without its name with how that name is set (newer kits only)
    direction: typeof k.direction === 'string' ? k.direction : null,
    bannerArt: typeof k.bannerArt === 'string' ? k.bannerArt : null,
    title: k.title && typeof k.title === 'object' && typeof k.title.lockup === 'string' ? { lockup: k.title.lockup, at: String(k.title.at || 'right') } : null,
    refs: (Array.isArray(k.refs) ? k.refs : []).filter((r) => r && typeof r.url === 'string'),
    edit: typeof k.edit === 'string' ? k.edit : null,
  };
}

// Kie can't paint at all: the turn goes straight to the backup painter (maker.js). Its credits are read at most once
// a minute; fewer than one turn's pictures left opens the breaker (and raises the alert) before the pictures start.
async function kieReady() {
  if (kieDown()) return null;
  const left = await creditsLeft({ signal: AbortSignal.timeout(3000) }).catch(() => null);
  const need = 4 * (MODELS[imageModel()]?.credits ?? 18);
  if (left !== null && left < need && markKieDown('kie_out_of_credits')) alert('kie_out_of_credits', { credits: left, need });
  return left; // logged with the turn, so the credits left are in every make line
}

// An Anthropic account problem (no credit, a bad key) stops every turn: said once a minute per instance, loudly.
let lastClaudeAlert = 0;
let lastCapAlert = 0;
function claudeTrouble(e) {
  const why = String(e?.message ?? '');
  const billing = e?.status === 401 || e?.status === 403 || /credit balance|billing|insufficient|quota/i.test(why);
  if (billing && Date.now() - lastClaudeAlert > 60_000) {
    lastClaudeAlert = Date.now();
    console.error(`WAGBI_ALERT anthropic_account ${JSON.stringify({ at: 'make', alert: 'anthropic_account', status: e?.status ?? null, why: why.slice(0, 200) })}`);
  }
  return billing;
}

/** The attached pictures, read back from this store and checked again: [{ url, b64 }]. */
async function attachmentsOf(urls) {
  return Promise.all(urls.map(async (url) => {
    const r = await safeGet(url, { maxBytes: 6_000_000, timeoutMs: 8000, accept: 'image/*' });
    return { url, b64: await forModel(r.body, 1024) };
  }));
}

/**
 * The guards that need the store (the daily cap, the hourly count per IP), then the hold: run inside the stream, so
 * the page shows the first step at once, and still before anything is spent. Answers the day held on, or an error code.
 */
async function admit(ip, id, worst) {
  let spend, recent;
  try {
    [spend, recent] = await Promise.all([spendToday(), recentByIp(ip)]);
  } catch (e) {
    log({ storage: String(e?.message ?? e).slice(0, 160) });
    return { code: 'off' };
  }
  // 'busy': only the worst cases held by the turns running now are in the way (they settle for much less);
  // 'resting': what was really spent today leaves no room for one more turn
  const room = capCheck(spend, worst, cap());
  if (room !== 'ok') {
    log({ cap: room, settled: round(spend.settled), held: round(spend.held), worst: round(worst), capUsd: cap() });
    if (room === 'resting' && Date.now() - lastCapAlert > 10 * 60_000) {
      lastCapAlert = Date.now();
      console.error(`WAGBI_ALERT daily_cap_reached ${JSON.stringify({ at: 'make', alert: 'daily_cap_reached', settled: round(spend.settled), capUsd: cap() })}`);
    }
    return { code: room };
  }
  if (recent >= PER_HOUR) return { code: 'slow' };
  try {
    const [, day] = await Promise.all([markIp(ip, id), hold(id, worst)]);
    return { day };
  } catch (e) {
    log({ storage: String(e?.message ?? e).slice(0, 160) });
    return { code: 'off' };
  }
}

async function run(ids, message, ch, ip, held, { from, token, history, files, links, web, key = null, sub = null }) {
  const t0 = Date.now();
  let usd = 0;
  let turnStarted = false; // from here on money may be spent: an unexpected error is counted at the worst case
  let firstAt = null;
  let day = null;
  let warm = null; // the coin's website getting its look and lore, after the reply is out
  let outcome = null; // how the turn ended, for a page that lost the stream (turns/<id>.json)
  let kieCredits = null;
  // a page that isn't the coin's maker gets a token of its own: its message makes a new coin (see TOKEN)
  const fresh = newToken();
  const send = (ev) => {
    if (firstAt === null) firstAt = Date.now() - t0;
    ch.send(ev);
  };
  const ping = setInterval(ch.ping, 8000);
  try {
    ch.send({ type: 'start', ids, token: fresh, keys: ids.map(siteKey) });
    send({ type: 'step', id: 'read', state: 'run', label: from || history.length ? 'reading your message' : 'reading your idea' });
    const ok = await admit(ip, ids[0], held);
    if (ok.code) {
      usd = 0;
      ch.send({ type: 'error', code: ok.code, error: MESSAGES[ok.code] });
      outcome = { ok: false, code: ok.code, error: MESSAGES[ok.code], kits: [] };
      return;
    }
    day = ok.day;
    // Kie's credits are read alongside (never in the way: the first picture starts seconds later, after the reply
    // has written its prompt, and a breaker opened by then sends it straight to the backup painter)
    kieReady().then((c) => { kieCredits = c; }, () => {});
    const [current, attachments] = await Promise.all([from ? currentOf(from) : null, files.length ? attachmentsOf(files) : []]);
    if (from && !current) throw new Error('the kit to change is gone');
    const owned = !!(current && current.edit && token && editHashOf(token) === current.edit);
    turnStarted = true;
    // the coin's website: changed here when the message is about it (and nothing else is attached)
    let siteUsd = 0;
    if (current && !files.length && !links.length && mentionsSite(message)) {
      send({ type: 'step', id: 'site', state: 'run', label: 'reading your website' });
      const st = await siteTurn({ current, message, key, sub, owned });
      siteUsd = st.usd || 0;
      if (!st.coin) {
        usd = siteUsd;
        send({ type: 'step', id: 'site', state: 'done', label: st.edited ? 'changed your website' : 'read your website' });
        ch.send({ type: 'reply', text: st.reply, replace: true });
        ch.send({ type: 'done', reply: st.reply, kits: [], site: st.site });
        outcome = { ok: true, reply: st.reply, kits: [] };
        log({ ok: true, kind: 'site', edited: !!st.edited, owned, ms: Date.now() - t0, usd: round(usd) });
        return;
      }
      send({ type: 'step', id: 'site', state: 'done', label: 'this one is about the coin itself' });
    }
    const res = await makeTurn({ message, transcript: history, current, attachments, links, web, emit: send, deadline: t0 + BUDGET_MS, budgetUsd: held, deps: { putRef } });
    usd = res.usd + siteUsd;
    let kits = [];
    let change = false;
    if (res.designs.length) {
      // a version of the coin only for its maker's page; anyone else's "change" becomes a new coin made from it
      change = res.kind === 'change' && current && owned;
      const thread = change
        ? { root: current.root, version: current.next, parent: current.id, ask: message, line: current.line.slice(0, -1) }
        : { root: null, version: 1, parent: null, ask: null, line: [] };
      const designs = res.designs.map((d) => ({ ...d, id: ids[d.i] }));
      const editHash = change ? current.edit : editHashOf(fresh);
      // a change (a version, or a new coin made from someone else's) keeps the idea it came from; a new idea is its own
      const sentence = res.kind === 'change' && current ? current.sentence : message;
      kits = await saveTurn(designs, thread, { sentence, model: res.model, character: res.character, note: res.reply.slice(0, 600), trace: res.trace, editHash });
    }
    // the coin's website moves to the turn's first design (where the chat moves); a new coin gets its site here
    let site = null;
    if (kits.length) {
      try {
        const r = await afterTurn(kits, { fresh: !change });
        site = r.site;
        warm = r.warm;
      } catch (e) {
        log({ ids, site: String(e?.message ?? e).slice(0, 160) });
      }
    }
    ch.send({ type: 'done', reply: res.reply, kits, site });
    outcome = { ok: true, reply: res.reply, kits: kits.map((k) => k.id) };
    log({ ids: kits.length ? ids : undefined, ok: true, kind: res.kind, owned: from ? owned : undefined, root: kits[0]?.root, version: kits[0]?.version, designs: kits.length, ms: Date.now() - t0, firstMs: firstAt, usd: round(usd), web, files: files.length, links: links.length, art: res.art, kieCredits, calls: res.calls.map((c) => `${c.step}:${c.state}:${c.model}:${round(c.usd || 0)}`).join(' ') });
  } catch (e) {
    let code = 'jam';
    if (!(e instanceof EngineError)) usd = turnStarted && usd === 0 ? held : usd;
    if (e instanceof EngineError) {
      usd = Number.isFinite(e.usd) ? e.usd : held;
      if (e.code === 'nope') code = e.reason === 'real_person' ? 'real_person' : 'nope';
      else if (e.code === 'no_art') code = 'no_art';
      else if (e.apiError && claudeTrouble(e)) code = 'off';
    }
    ch.send({ type: 'error', code, error: MESSAGES[code] });
    outcome = { ok: false, code, error: MESSAGES[code], kits: [] };
    log({ ids, ok: false, code, why: String(e?.message ?? e).slice(0, 240), kie: e?.kie, kieCredits, ms: Date.now() - t0, usd: round(usd), calls: e?.calls?.map((c) => `${c.step}:${c.state}:${round(c.usd || 0)}`).join(' ') });
  } finally {
    clearInterval(ping);
    ch.close();
    await Promise.all([
      outcome ? putTurn(ids[0], outcome) : null,
      day ? settle(ids[0], day, held, usd).catch((err) => log({ ids, settle: String(err?.message ?? err).slice(0, 160) })) : null,
    ]);
    if (warm) await warm.catch(() => {});
  }
}

export async function POST(req) {
  // another site's page can't start a turn (it would spend this site's money with its visitors' browsers): the
  // Origin must be this site's, and the body must say it is JSON (which a cross-site page can't send unasked)
  if (!sameOrigin(req) || !isJson(req)) return fail('cross_site', 403);
  const body = await readJson(req, 64_000);
  const message = cleanSentence(body?.message ?? body?.sentence);
  if (!message) return fail('empty');
  if (message.length > MAX_MESSAGE) return fail('too_long');
  if (badWords(message)) return fail('nope', 422);
  const from = body?.from == null ? null : isId(body.from) ? body.from : undefined;
  if (from === undefined) return fail('not_found', 404);
  const token = typeof body?.token === 'string' && TOKEN.test(body.token) ? body.token : null;
  const rawFiles = Array.isArray(body?.files) ? body.files : [];
  if (rawFiles.length > MAX_FILES) return fail('too_many_files');
  const files = rawFiles.map(uploadUrl);
  if (files.some((u) => !u)) return fail('bad_file');
  const rawLinks = Array.isArray(body?.links) ? body.links.filter((u) => typeof u === 'string').map((u) => checkUrl(u.trim())?.href).filter(Boolean) : [];
  const links = [...new Set([...rawLinks, ...linksIn(message)])].slice(0, MAX_LINKS);
  const history = cleanHistory(body?.history);
  const web = body?.web !== false;
  const key = typeof body?.siteKey === 'string' ? body.siteKey.slice(0, 64) : null;
  const sub = sessionOf(req, authConfig().secret)?.sub ?? null;
  // (no Kie key is not "off": the backup painter draws the art, see maker.js)
  if (!process.env.ANTHROPIC_API_KEY?.trim() || !hasStore()) return fail('off', 503);

  const ip = clientIp(req);
  if (limited(`make:${ip}`, PER_HOUR, 3600_000) || limited(`burst:${ip}`, 3, 20_000)) return fail('slow', 429);

  const ids = [newId(), newId()];
  const ch = channel();
  waitUntil(run(ids, message, ch, ip, worstTurn(), { from, token, history, files, links, web, key, sub }));
  return new Response(ch.readable, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
