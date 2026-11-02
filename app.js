// wagbi front end. a submit asks /api/make for a real coin and shows it as it streams in.
// each coin is its own chat at #/coin/<id>; history lives in this viewer's localStorage when it can.
// the four examples stay examples. history from the demo days (records with an example id) still opens.
(() => {
  const B = window.BRAND || { name: 'wagbi', domain: 'wagbi.fun' };
  const KITS = window.WAGBI_EXAMPLES || [];
  const BY_ID = Object.fromEntries(KITS.map((k) => [k.id, k]));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canHover = matchMedia('(hover: hover)').matches;
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const IDEAS = [
    'a raccoon who runs a hedge fund',
    'a dog that only buys the top',
    'a cat that is always late for the bus',
    'the moon, but it is tired',
    'a snail that day trades',
    'a ghost who haunts your portfolio',
  ];
  // what the engine streams, in order: [doing, done]
  const STEPS = [
    ['reading it', 'read'],
    ['naming it', 'named'],
    ['drawing the logo', 'logo'],
    ['painting the banner', 'banner'],
    ['giving it a second look', 'second look'],
  ];
  const STEP_AT = { read: 0, name: 1, logo: 2, banner: 3, look: 4 };
  const MAX_LEN = 140;
  // said here when the server could not say it
  const SAY = {
    offline: `could not reach ${B.name}. check your connection and try again.`,
    jam: 'something went wrong on that one. try it again.',
    lost: 'this one did not finish. try it again.',
  };
  // after these the sentence goes back in the box, ready to send again
  const RETRY = new Set(['offline', 'jam', 'lost', 'slow', 'off', 'too_long', 'empty']);

  // ---------- svg helpers ----------
  let uid = 0;
  const uniq = (svg) => {
    const n = ++uid;
    return svg
      .replace(/\sid="([^"]+)"/g, (m, id) => ` id="${id}-${n}"`)
      .replace(/(href="#|url\(#)([^")]+)/g, (m, p, id) => `${p}${id}-${n}`);
  };
  function mark() {
    if (B.markImg) return `<img class="mark" src="${B.markImg}" alt="" aria-hidden="true">`;
    const id = 'mk' + (++uid);
    return `<svg class="mark" viewBox="0 0 200 200" aria-hidden="true"><defs><clipPath id="${id}"><circle cx="100" cy="100" r="78"/></clipPath></defs><circle cx="100" cy="100" r="78" fill="#0b0b0c"/><g clip-path="url(#${id})"><g class="arc"><circle cx="128" cy="72" r="78" fill="none" stroke="#f4f4f1" stroke-width="7"/></g></g></svg>`;
  }
  const img = (src) => {
    const i = new Image();
    i.alt = '';
    i.decoding = 'async';
    i.src = src;
    return i;
  };
  // small logos in the sidebar are images, so a long history stays light
  const imgCache = {};
  const exampleImg = (kit) => {
    if (!imgCache[kit.id]) {
      let s = kit.logo;
      if (!/xmlns=/.test(s)) s = s.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      imgCache[kit.id] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
    }
    return img(imgCache[kit.id]);
  };

  // the arc of light turns while a coin is being made, then eases to rest
  function spin(svg) {
    const arc = svg && svg.querySelector('.arc');
    if (reduce || !arc || !arc.animate) return { stop() {} };
    const T = 3000;
    const a = arc.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: T, iterations: Infinity });
    return {
      stop() {
        const ang = (((a.currentTime || 0) % T) / T) * 360;
        a.cancel();
        arc.animate(
          [{ transform: `rotate(${ang}deg)` }, { transform: 'rotate(360deg)' }],
          { duration: 600 + ((360 - ang) / 360) * T * 1.6, easing: 'cubic-bezier(.12,.6,.22,1)' }
        );
      },
    };
  }

  // banner fonts, loaded once
  if (window.WAGBI_FONTS && window.WAGBI_FONTS.length) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?' + window.WAGBI_FONTS.map((f) => 'family=' + f).join('&') + '&display=swap';
    document.head.appendChild(l);
  }

  // ---------- history: per viewer, never required ----------
  // a real coin: { id, sentence, t, kit (its id on the server), name, ticker, bio, logo, banner (image urls) }
  // a demo era coin: { id, sentence, t, example, name, ticker }
  const KEY = `${B.id || 'wagbi'}.coins.v1`;
  const MAX = 100;
  const KIT_ID = /^[A-Za-z0-9_-]{16}$/;
  const PNG_URL = /^https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com\/kits\/[A-Za-z0-9_-]{16}\/(logo|banner)\.png$/;
  const jobs = {}; // coin id -> the make running in this tab
  const valid = (c) => {
    if (!c || typeof c.id !== 'string' || typeof c.sentence !== 'string' || typeof c.t !== 'number') return false;
    if (c.example) return !!BY_ID[c.example];
    if (c.logo != null && !PNG_URL.test(c.logo)) return false;
    if (c.banner != null && !PNG_URL.test(c.banner)) return false;
    return KIT_ID.test(c.kit || '') || !!jobs[c.id];
  };
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(valid).sort((a, b) => b.t - a.t).slice(0, MAX) : [];
    } catch (e) {
      return [];
    }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(coins.slice(0, MAX))); } catch (e) { /* blocked or full: memory only */ }
    if (typeof syncSoon === 'function') syncSoon();
  }
  // chats deleted on this device, until the account has heard about it ({ id: ms })
  const auth = { clientId: null, user: null };
  const DEL_KEY = KEY + '.deleted';
  let deletedIds = (() => {
    try { return JSON.parse(localStorage.getItem(DEL_KEY) || '{}') || {}; } catch (e) { return {}; }
  })();
  const saveDeleted = () => { try { localStorage.setItem(DEL_KEY, JSON.stringify(deletedIds)); } catch (e) { /* memory only */ } };
  let coins = load();
  addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    coins = load();
    renderSide();
  });
  const newId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const find = (id) => coins.find((c) => c.id === id);
  function patch(id, fields) {
    const c = find(id);
    if (c) {
      Object.assign(c, fields);
      save();
    }
  }
  function forget(id) {
    coins = coins.filter((c) => c.id !== id);
    save();
  }
  function deleteChat(id) {
    delete jobs[id];
    deletedIds[id] = Date.now();
    saveDeleted();
    forget(id);
    if (parse().kind === 'coin' && parse().id === id) location.hash = '#/';
    else renderSide();
  }
  function clearAll() {
    const at = Date.now();
    for (const c of coins) deletedIds[c.id] = at;
    saveDeleted();
    coins = [];
    for (const k of Object.keys(jobs)) delete jobs[k];
    try { localStorage.removeItem(KEY); } catch (e) { /* memory only */ }
    // signed in: the account's copy goes too (each chat is marked deleted there, so no device brings it back)
    if (auth.user) fetch('/api/chats', { method: 'DELETE' }).then(() => { deletedIds = {}; saveDeleted(); }).catch(() => {});
    if (parse().kind === 'coin') location.hash = '#/';
    else renderSide();
  }

  function ago(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd';
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase();
  }

  // ---------- elements ----------
  const hero = $('hero');
  const thread = $('thread');
  const made = $('made');
  const composer = $('composer');
  const field = $('field');
  const ta = $('prompt');
  const ph = $('ph');
  const list = $('list');
  const side = $('side');
  const menu = $('menu');

  $('heroMark').innerHTML = mark();
  $('brandMark').outerHTML = mark();

  // chips: the example sentences, each makes a coin
  KITS.slice(0, 3).forEach((k) => {
    const b = el('button', 'chip', k.sentence);
    b.type = 'button';
    b.addEventListener('click', () => submit(k.sentence));
    $('chips').appendChild(b);
  });

  // made with wagbi grid: each opens that example's chat
  KITS.forEach((k) => {
    const c = el('a', 'card');
    c.href = '#/example/' + k.id;
    c.setAttribute('aria-label', `${k.name}, $${k.ticker}, made from: ${k.sentence}`);
    const logo = el('div', 'card-logo');
    logo.innerHTML = uniq(k.logo);
    const id = el('div', 'card-id');
    id.append(el('b', '', k.name), el('span', '', '$' + k.ticker));
    c.append(logo, id, el('p', 'card-q', k.sentence));
    $('grid').appendChild(c);
  });

  // ---------- the prompt ----------
  let idea = 0;
  let holdUntil = 0;
  ph.textContent = IDEAS[0];
  if (!reduce) {
    setInterval(() => {
      if (field.classList.contains('has') || Date.now() < holdUntil) return;
      ph.classList.add('out');
      setTimeout(() => {
        idea = (idea + 1) % IDEAS.length;
        ph.textContent = IDEAS[idea];
        ph.classList.remove('out');
        ph.classList.add('pre');
        void ph.offsetWidth;
        ph.classList.remove('pre');
      }, 480);
    }, 3400);
  }
  function holdPh(text) {
    ph.classList.remove('out', 'pre');
    ph.textContent = text;
    holdUntil = Date.now() + 6000;
  }
  function fit() {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    field.classList.toggle('has', ta.value.length > 0);
  }
  ta.addEventListener('input', () => {
    if (/\n/.test(ta.value)) ta.value = ta.value.replace(/\s*\n\s*/g, ' ');
    fit();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit(ta.value);
    }
  });
  ta.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      e.preventDefault();
      submit(ta.value);
    }
  });
  composer.addEventListener('submit', (e) => { e.preventDefault(); submit(ta.value); });
  addEventListener('resize', fit);
  const focusPrompt = () => { if (canHover) ta.focus({ preventScroll: true }); };

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // ---------- making a coin: one job per coin, alive while this tab is ----------
  const running = (id) => !!jobs[id] && !jobs[id].end;
  const busy = () => Object.keys(jobs).some(running);

  async function fetchKit(kitId) {
    const r = await fetch('/api/kit/' + encodeURIComponent(kitId));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('kit ' + r.status);
    const j = await r.json();
    return j && j.kit;
  }

  // a coin is a conversation: its finished versions, oldest first ({ v, kit, ask, name, ticker, bio, logo, banner }).
  // the record's own kit/name/.../banner are the CURRENT version (the one the chat continues from and launch uses).
  function turnsOf(rec) {
    if (Array.isArray(rec.turns) && rec.turns.length) return rec.turns.filter((t) => KIT_ID.test(t.kit || '') && PNG_URL.test(t.logo || '') && PNG_URL.test(t.banner || ''));
    if (rec.kit && rec.logo) return [{ v: 1, kit: rec.kit, ask: rec.sentence, name: rec.name, ticker: rec.ticker, bio: rec.bio, logo: rec.logo, banner: rec.banner }];
    return [];
  }
  const turnOf = (k, ask) => ({ v: k.version || 1, kit: k.id, ask, name: k.name, ticker: k.ticker, bio: k.bio, logo: k.logo, banner: k.banner });

  // poll: true skips the make and only looks for the stored kit (a reload, or a dropped connection)
  // follow: { ask, from } makes the coin's next version from the kit `from` (a follow-up in its chat)
  function startJob(rec, poll, follow) {
    const id = rec.id;
    const job = { sentence: follow ? follow.ask : rec.sentence, follow: !!follow, step: 'read', end: null, subs: new Set() };
    jobs[id] = job;
    const tell = () => job.subs.forEach((fn) => fn());
    const finish = (end) => {
      job.end = end;
      tell();
      if (end === 'done') doneId = id;
      renderSide();
    };
    const failWith = (code, text) => {
      job.error = { code, text: text || SAY[code] || SAY.jam };
      if (follow) patch(id, { pending: null }); // the coin stays as it was
      else forget(id);
      finish('error');
    };
    function on(ev) {
      if (job.end) return;
      if (ev.type === 'start') {
        if (follow) patch(id, { pending: { ...follow, kit: ev.id } });
        else patch(id, { kit: ev.id });
      } else if (ev.type === 'step') {
        job.step = ev.step;
      } else if (ev.type === 'name') {
        Object.assign(job, { name: ev.name, ticker: ev.ticker, bio: ev.bio });
        if (!follow) patch(id, { name: ev.name, ticker: ev.ticker, bio: ev.bio });
      } else if (ev.type === 'logo' || ev.type === 'banner') {
        if (/^data:image\/png;base64,/.test(ev.png || '')) job[ev.type] = ev.png;
      } else if (ev.type === 'done') {
        const k = ev.kit || {};
        if (!PNG_URL.test(k.logo || '') || !PNG_URL.test(k.banner || '')) return failWith('jam');
        Object.assign(job, { name: k.name, ticker: k.ticker, bio: k.bio, logo: job.logo || k.logo, banner: job.banner || k.banner });
        const cur = find(id) || rec;
        const turns = follow ? [...turnsOf(cur), turnOf(k, follow.ask)] : [turnOf(k, cur.sentence)];
        patch(id, { kit: k.id, name: k.name, ticker: k.ticker, bio: k.bio, logo: k.logo, banner: k.banner, turns, pending: null });
        return finish('done');
      } else if (ev.type === 'error') {
        return failWith(ev.code, ev.error);
      }
      tell();
    }

    // the kit may still be finishing on the server: look for it for a while
    async function look(tries) {
      const cur = find(id) || rec;
      const kitId = follow ? (cur.pending || follow).kit : cur.kit;
      for (let n = 0; n < tries && !job.end; n++) {
        if (n) await sleep(5000);
        try {
          const k = await fetchKit(kitId);
          if (k) return on({ type: 'done', kit: k });
        } catch (e) { /* try again */ }
      }
      if (!job.end) failWith('lost');
    }

    (async () => {
      if (poll) return look(Date.now() - ((follow && follow.t) || rec.t) < 6 * 60_000 ? 36 : 1);
      let res;
      try {
        res = await fetch('/api/make', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(follow ? { sentence: follow.ask, from: follow.from } : { sentence: rec.sentence }),
        });
      } catch (e) {
        return failWith('offline');
      }
      if (!res.ok || !res.body) {
        let j = null;
        try { j = await res.json(); } catch (e) { /* not json */ }
        return failWith((j && j.code) || 'jam', j && j.error);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let ev;
            try { ev = JSON.parse(line); } catch (e) { continue; }
            on(ev);
            if (job.end) return;
          }
        }
      } catch (e) { /* the connection dropped */ }
      if (job.end) return;
      if (follow ? ((find(id) || {}).pending || {}).kit : (find(id) || {}).kit) return look(36);
      failWith('jam');
    })();
    return job;
  }

  // ---------- sidebar ----------
  let freshId = null;
  let doneId = null;
  function row({ href, logo, name, sub, t, cur, making, fresh, justDone, onDelete }) {
    const a = el('a', 'row' + (cur ? ' cur' : '') + (making ? ' making' : '') + (fresh ? ' fresh' : '') + (justDone ? ' just' : ''));
    a.href = href;
    if (cur) a.setAttribute('aria-current', 'page');
    const box = el('span', 'row-logo');
    if (making || !logo) {
      box.innerHTML = mark();
      if (making) spin(box.querySelector('.mark'));
    } else {
      box.appendChild(logo);
    }
    const text = el('span', 'row-text');
    text.append(el('span', 'row-name', name), el('span', 'row-sub', sub));
    a.append(box, text);
    if (t) {
      const time = el('time', '', ago(t));
      time.dateTime = new Date(t).toISOString();
      a.appendChild(time);
    }
    if (!onDelete) return a;
    // a coin's own row can delete its chat (asks first)
    const wrap = el('div', 'row-wrap');
    const del = el('button', 'row-del', 'delete');
    del.type = 'button';
    del.setAttribute('aria-label', `delete the chat for ${name}`);
    del.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (del.dataset.sure) return onDelete();
      del.dataset.sure = '1';
      del.textContent = 'sure?';
      setTimeout(() => { delete del.dataset.sure; del.textContent = 'delete'; }, 3000);
    });
    wrap.append(a, del);
    return wrap;
  }
  function renderSide() {
    const r = parse();
    const keep = list.scrollTop;
    list.textContent = '';
    if (coins.length) {
      $('sideLabel').textContent = 'your coins';
      for (const c of coins) {
        const ex = c.example && BY_ID[c.example];
        const making = running(c.id);
        list.appendChild(row({
          href: '#/coin/' + c.id,
          logo: ex ? exampleImg(ex) : c.logo ? img(c.logo) : null,
          name: making && !c.name ? c.sentence : (c.name || (ex && ex.name) || c.sentence),
          sub: making ? 'making' : '$' + (c.ticker || (ex && ex.ticker) || ''),
          t: c.t,
          cur: r.kind === 'coin' && r.id === c.id,
          making,
          fresh: c.id === freshId,
          justDone: c.id === doneId,
          onDelete: making ? null : () => deleteChat(c.id),
        }));
      }
      freshId = null;
      doneId = null;
    } else {
      $('sideLabel').textContent = 'examples';
      for (const k of KITS) {
        list.appendChild(row({ href: '#/example/' + k.id, logo: exampleImg(k), name: k.name, sub: '$' + k.ticker, cur: r.kind === 'example' && r.id === k.id }));
      }
    }
    list.scrollTop = keep;
  }
  setInterval(() => { if (coins.length && !busy()) renderSide(); }, 60000);

  // phones: the sidebar slides over the page
  const small = matchMedia('(max-width: 860px)');
  const setInert = () => {
    const hide = small.matches && !document.body.classList.contains('nav');
    if (hide) side.setAttribute('inert', ''); else side.removeAttribute('inert');
  };
  function openNav() {
    document.body.classList.add('nav');
    menu.setAttribute('aria-expanded', 'true');
    setInert();
  }
  function closeNav() {
    document.body.classList.remove('nav');
    menu.setAttribute('aria-expanded', 'false');
    setInert();
  }
  menu.addEventListener('click', () => (document.body.classList.contains('nav') ? closeNav() : openNav()));
  $('scrim').addEventListener('click', closeNav);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });
  (small.addEventListener ? small.addEventListener('change', setInert) : small.addListener(setInert));
  setInert();

  // clicking the link you are already on still resets the view
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="#/"]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    if (a.getAttribute('href') === (location.hash || '#/')) { e.preventDefault(); route(); }
  });

  // ---------- routes ----------
  function parse() {
    const h = location.hash;
    let m = h.match(/^#\/coin\/([\w-]+)$/);
    if (m) return { kind: 'coin', id: m[1] };
    m = h.match(/^#\/example\/([\w-]+)$/);
    if (m) return { kind: 'example', id: m[1] };
    m = h.match(/^#\/k\/([A-Za-z0-9_-]{16})$/);
    if (m) return { kind: 'kit', id: m[1] };
    if (h === '#/coins') return { kind: 'coins' };
    return { kind: 'new' };
  }
  let gen = 0;
  let streamNext = null;
  function route() {
    closeNav();
    gen++;
    const r = parse();
    const fresh = streamNext;
    streamNext = null;
    coinsTab.hidden = true;
    $('coinsRow').classList.toggle('cur', r.kind === 'coins');
    if (r.kind === 'coins') {
      showCoins();
      renderSide();
      return;
    }
    if (r.kind === 'coin') {
      const c = find(r.id);
      if (c && c.example) {
        showChat(c, 'demo');
        renderSide();
        return;
      }
      if (c || jobs[r.id]) {
        showReal(c || {}, r.id, fresh === r.id);
        renderSide();
        return;
      }
    }
    if (r.kind === 'kit') {
      showKitPage(r.id);
      renderSide();
      return;
    }
    if (r.kind === 'example' && BY_ID[r.id]) {
      const k = BY_ID[r.id];
      showChat({ sentence: k.sentence, example: k.id, name: k.name, ticker: k.ticker }, 'example');
    } else {
      showNew();
    }
    renderSide();
  }
  addEventListener('hashchange', route);

  function showNew() {
    document.title = B.name;
    document.body.dataset.state = 'idle';
    thread.hidden = true;
    thread.textContent = '';
    hero.hidden = false;
    hero.classList.remove('leaving');
    made.hidden = false;
    hero.insertBefore(composer, $('chips'));
    composer.classList.remove('away', 'up', 'on');
    ta.value = '';
    fit();
    ph.classList.remove('out', 'pre');
    ph.textContent = IDEAS[idea];
    holdUntil = Date.now() + 3000;
    scrollTo({ top: 0 });
    focusPrompt();
  }

  // in a coin's chat the box talks to that coin: the message changes it and makes its next version
  function followUp(c, text) {
    const pending = { ask: text, from: c.kit, t: Date.now() };
    patch(c.id, { pending, t: Date.now() });
    startJob(find(c.id) || c, false, pending);
    streamNext = c.id;
    document.body.dataset.state = 'making';
    ta.value = '';
    fit();
    ta.blur();
    route();
  }

  async function submit(raw) {
    const text = (raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
    if (!text || document.body.dataset.state === 'making') return;
    const r = parse();
    if (r.kind === 'coin') {
      const c = find(r.id);
      if (c && !c.example && c.kit && c.logo && !running(c.id)) {
        // "a meme generator for this character": that's a tool, not a change to the coin
        if (wantsMemeTool(text)) {
          ta.value = '';
          fit();
          const btn = thread.querySelector('.tool-btn');
          if (btn && !btn.classList.contains('on')) btn.click();
          return;
        }
        return followUp(c, text);
      }
    }
    const rec = { id: newId(), sentence: text, t: Date.now() };
    coins.unshift(rec);
    if (coins.length > MAX) coins.length = MAX;
    save();
    startJob(rec);
    freshId = rec.id;
    streamNext = rec.id;
    document.body.dataset.state = 'making';
    ta.value = '';
    fit();
    ta.blur();
    if (!hero.hidden && !reduce) {
      hero.classList.add('leaving');
      await wait(300);
    }
    location.hash = '#/coin/' + rec.id;
  }

  // ---------- one coin, one chat ----------
  function noteFor(rec, mode) {
    const kit = BY_ID[rec.example];
    const note = el('p', 'note');
    if (mode === 'example') {
      note.textContent = 'example: a real kit this sentence made. type your own to make one.';
    } else if (norm(rec.sentence) === norm(kit.sentence)) {
      note.textContent = 'demo for now: this is the real kit this sentence made.';
    } else {
      note.append('demo for now: the engine is not wired yet, so here is a real kit made from ');
      note.appendChild(el('q', '', kit.sentence));
      note.append('.');
    }
    return note;
  }

  function kitCard(rec) {
    const kit = BY_ID[rec.example];
    const card = el('div', 'kit');
    const banner = el('div', 'kit-banner');
    banner.innerHTML = uniq(kit.banner);
    const body = el('div', 'kit-body');
    const logo = el('div', 'kit-logo');
    logo.innerHTML = uniq(kit.logo);
    const id = el('div', 'kit-id');
    id.append(el('h2', '', rec.name || kit.name), el('span', '', '$' + (rec.ticker || kit.ticker)));
    const bio = el('p', 'kit-bio', kit.bio);
    body.append(logo, id, bio);
    card.append(banner, body);
    return card;
  }

  // a real kit: the images arrive one by one, so each box waits until its picture is in
  function realCard() {
    const card = el('div', 'kit');
    const banner = el('div', 'kit-banner wait');
    const body = el('div', 'kit-body');
    const logo = el('div', 'kit-logo wait');
    const id = el('div', 'kit-id');
    const h2 = el('h2');
    const tick = el('span');
    id.append(h2, tick);
    const bio = el('p', 'kit-bio');
    body.append(logo, id, bio);
    card.append(banner, body);
    const put = (box, src) => {
      if (!src || box.dataset.src === src) return;
      box.dataset.src = src;
      const old = box.querySelector('img');
      const i = img(src);
      if (old) i.addEventListener('load', () => old.remove());
      const show = () => box.classList.remove('wait');
      i.addEventListener('load', show);
      i.addEventListener('error', show);
      box.appendChild(i);
    };
    return {
      card, logo, id, bio,
      fill(k) {
        h2.textContent = k.name || '';
        tick.textContent = k.ticker ? '$' + k.ticker : '';
        bio.textContent = k.bio || '';
        put(logo, k.logo);
        put(banner, k.banner);
      },
    };
  }

  // the launch button. getCtx() -> the coin to launch ({ kitId, name, ticker, bio, logo, banner, saved, save }),
  // or null for an example (examples aren't real kits, so they can't launch)
  function goRow(getCtx) {
    const row = el('div', 'go');
    const launch = el('button', 'launch');
    launch.type = 'button';
    const a = el('span', 'a', 'launch this coin');
    const b = el('span', 'b', 'launches open soon');
    launch.append(a, b);
    const small = el('small', '', 'no wallet connection: you pay a one-time address from any wallet.');
    let t;
    let panel = null;
    const say = (text) => {
      b.textContent = text;
      launch.classList.add('soon');
      clearTimeout(t);
      t = setTimeout(() => launch.classList.remove('soon'), 2600);
    };
    const L = window.WagbiLaunch;
    // a coin that is already live says so, and shows its contract and split
    const ctx0 = getCtx && getCtx();
    if (L && ctx0 && ctx0.kitId) {
      L.launched(ctx0.coinId || ctx0.kitId).then((coin) => {
        if (!coin || !row.parentNode) return;
        a.textContent = coin.cluster === 'devnet' ? 'live on devnet' : `live on ${coin.launchpadName || 'pump.fun'}`;
        small.textContent = '';
        small.appendChild(Object.assign(el('a', '', 'open its page'), { href: `/k/${ctx0.coinId || ctx0.kitId}` }));
        row.dataset.live = '1';
        row.after(L.liveBox(coin));
      });
    }
    launch.addEventListener('click', async () => {
      if (row.dataset.live) return;
      const ctx = getCtx && getCtx();
      if (!L || !ctx || !ctx.kitId) return say(ctx === null ? 'make your own to launch it' : 'launches open soon');
      if (panel && panel.isConnected) return panel.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      let c;
      try {
        c = await L.config();
      } catch (e) {
        return say('try again in a minute');
      }
      if (!c.open) return say('launches open soon');
      row.hidden = true;
      panel = L.open(row.parentNode, { ...ctx, onClose: () => { row.hidden = false; panel = null; } }, c);
      row.after(panel);
    });
    row.append(launch, small);
    return row;
  }

  function stepItem([doing, label], done) {
    const li = el('li', done ? 'done' : 'up now');
    const t = el('span', '', done ? label : doing);
    li.append(el('i'), t);
    return { li, t };
  }

  const reveal = (n) => { n.classList.add('up'); requestAnimationFrame(() => requestAnimationFrame(() => n.classList.add('on'))); };
  function follow(node) {
    const r = node.getBoundingClientRect();
    const over = r.bottom - (innerHeight - 40);
    if (over > 0) scrollBy({ top: over, behavior: reduce ? 'auto' : 'smooth' });
  }

  function chatFrame(sentence, title) {
    document.title = `${title} · ${B.name}`;
    hero.hidden = true;
    made.hidden = true;
    thread.hidden = false;
    thread.textContent = '';
    scrollTo({ top: 0 });
    const me = el('div', 'me');
    me.appendChild(el('p', '', sentence));
    const bot = el('div', 'bot');
    const head = el('div', 'bot-head');
    head.innerHTML = mark();
    thread.append(me, bot);
    thread.appendChild(composer);
    composer.classList.remove('up', 'on');
    return { me, bot, head };
  }

  function composerBack(again) {
    holdPh('make another one');
    ta.value = again || '';
    composer.classList.remove('away');
    fit();
    composer.classList.add('up');
    void composer.offsetWidth;
    requestAnimationFrame(() => composer.classList.add('on'));
    document.body.dataset.state = 'idle';
    focusPrompt();
  }

  // examples and demo era coins: shown as they ended
  function showChat(rec, mode) {
    const { bot, head } = chatFrame(rec.sentence, rec.name);
    head.appendChild(noteFor(rec, mode));
    const steps = el('ol', 'steps');
    STEPS.forEach((s) => steps.appendChild(stepItem(s, true).li));
    bot.append(head, steps, kitCard(rec), goRow(() => null));
    composer.classList.remove('away');
    holdPh(mode === 'example' ? 'make your own' : 'make another one');
    ta.value = '';
    fit();
    document.body.dataset.state = 'idle';
    focusPrompt();
  }

  const follow2 = (n) => follow(n); // showReal has a flag named follow

  // a real coin is a conversation: its finished versions as they ended, then the make running here (the first one
  // or a follow-up), live. the launch row sits under the current version; the box below keeps talking to the coin.
  const FOLLOW_STEPS = [
    ['reading your change', 'read'],
    ['making the new version', 'new version'],
    ['giving it a second look', 'second look'],
  ];
  const ASK_HINT = 'change anything: a shorter name, a blue logo, the banner at night';

  // tools: small apps for a coin. Each runs in a sandboxed frame (tool/*.html, vercel.json's CSP): an opaque origin
  // with no network, no storage, no cookies, no wagbi API and no wallet. Money only ever moves through the launch.
  function memeTool(k) {
    const box = el('section', 'tool');
    const head = el('div', 'tool-head');
    head.append(el('b', '', 'meme generator'), el('span', '', `${k.name}'s character, your words. it runs sealed off: no wallet, no account.`));
    const f = document.createElement('iframe');
    f.className = 'tool-frame';
    f.title = `meme generator for ${k.name}`;
    f.setAttribute('sandbox', 'allow-scripts allow-downloads');
    f.setAttribute('referrerpolicy', 'no-referrer');
    // srcdoc + sandbox without allow-same-origin: an opaque origin; the tool's own CSP blocks every connection
    const params = String(new URLSearchParams({ logo: k.logo || '', banner: k.banner || '', name: k.name || '', ticker: k.ticker || '' }));
    f.addEventListener('load', () => f.contentWindow && f.contentWindow.postMessage({ wagbiTool: 'meme', params }, '*'));
    toolHtml('meme').then((html) => { f.srcdoc = html; }).catch(() => head.appendChild(el('span', '', "couldn't open the tool. try again.")));
    box.append(head, f);
    return box;
  }
  const toolCache = {};
  const toolHtml = (name) => (toolCache[name] ??= fetch(`/tool/${name}.html`).then((r) => (r.ok ? r.text() : Promise.reject(new Error('tool ' + r.status)))));
  function toolsRow(getK) {
    const row = el('div', 'tools');
    const b = el('button', 'tool-btn', 'meme generator');
    b.type = 'button';
    let open = null;
    b.addEventListener('click', () => {
      if (open) {
        open.remove();
        open = null;
        b.classList.remove('on');
        return;
      }
      open = memeTool(getK());
      row.after(open);
      b.classList.add('on');
      requestAnimationFrame(() => follow2(open));
    });
    row.append(el('span', 'tools-label', 'tools'), b);
    return row;
  }
  const wantsMemeTool = (t) => /\bmemes?\b/i.test(t) && /\b(generator|maker|tool|app|machine)\b/i.test(t);

  function launchCtx(id, rec) {
    const r = find(id) || rec;
    if (!r.kit) return undefined;
    const turns = turnsOf(r);
    return {
      kitId: r.kit, coinId: (turns[0] && turns[0].kit) || r.kit, name: r.name, ticker: r.ticker, bio: r.bio, logo: r.logo, banner: r.banner,
      saved: r.launch, save: (f) => patch(id, { launch: f }),
    };
  }

  function showReal(rec, id, fresh) {
    const my = gen;
    const alive = () => my === gen;
    let job = jobs[id];
    if (!job && rec.kit && !rec.logo) job = startJob(rec, true); // left mid make (a reload): find the stored kit
    if (!job && rec.pending && rec.pending.kit) job = startJob(rec, true, rec.pending); // a follow-up left mid make
    const live = !!job && !job.end;
    const turns = turnsOf(rec);
    const follow = !!job && job.follow;
    // the exchange running here (or that just failed); a finished first make shows as a version instead
    const showJob = !!job && (live || job.end === 'error') && (follow || !turns.length);

    document.title = `${rec.name || 'making'} · ${B.name}`;
    hero.hidden = true;
    made.hidden = true;
    thread.hidden = false;
    thread.textContent = '';
    scrollTo({ top: 0 });

    // finished versions
    const go = goRow(() => launchCtx(id, rec));
    turns.forEach((t, i) => {
      const me = el('div', 'me');
      me.appendChild(el('p', '', t.ask || rec.sentence));
      const bot = el('div', 'bot');
      const head = el('div', 'bot-head');
      head.innerHTML = mark();
      head.appendChild(el('p', 'note', i === 0 ? 'here is your coin.' : `version ${t.v || i + 1}. only what you asked for changed.`));
      const card = realCard();
      card.fill(t);
      const ver = el('div', 'ver');
      ver.appendChild(el('span', 'ver-n', `version ${t.v || i + 1}`));
      if (t.kit === rec.kit) {
        ver.appendChild(el('span', 'ver-cur', turns.length > 1 ? 'current: launch uses this one' : 'current'));
      } else {
        const b = el('button', 'ver-use', i < turns.length - 1 ? 'go back to this version' : 'use this version');
        b.type = 'button';
        b.addEventListener('click', () => {
          patch(id, { kit: t.kit, name: t.name, ticker: t.ticker, bio: t.bio, logo: t.logo, banner: t.banner });
          route();
        });
        ver.appendChild(b);
      }
      bot.append(head, card.card, ver);
      thread.append(me, bot);
    });
    if (turns.length && !showJob) {
      thread.appendChild(go);
      thread.appendChild(toolsRow(() => find(id) || rec));
    }
    thread.appendChild(composer);
    composer.classList.remove('up', 'on');

    const idle = (again) => {
      composer.classList.remove('away');
      holdPh(turns.length ? ASK_HINT : 'make another one');
      if (turns.length) holdUntil = Infinity; // in a coin's chat the hint stays put
      ta.value = again || '';
      fit();
      document.body.dataset.state = 'idle';
      focusPrompt();
    };
    if (!showJob) {
      idle('');
      if (fresh || turns.length > 1) requestAnimationFrame(() => alive() && go.isConnected && follow2(go));
      return;
    }

    // the make running here
    const steps_ = follow ? FOLLOW_STEPS : STEPS;
    const sentence = job.sentence;
    const me = el('div', 'me');
    me.appendChild(el('p', '', sentence));
    const bot = el('div', 'bot');
    const head = el('div', 'bot-head');
    head.innerHTML = mark();
    const note = el('p', 'note');
    head.appendChild(note);
    thread.insertBefore(me, composer);
    thread.insertBefore(bot, composer);
    const steps = el('ol', 'steps');
    const items = [];
    const card = realCard();
    const shown = { head: false, steps: false, card: false, go: false };
    let spinner = null;
    let ended = false;

    const state = () => {
      const base = follow ? rec : {};
      const k = { name: job.name || base.name, ticker: job.ticker || base.ticker, bio: job.bio || base.bio, logo: job.logo || base.logo || rec.logo, banner: job.banner || base.banner || rec.banner };
      let at = steps_.length;
      if (job.end !== 'done') {
        if (follow) at = job.step === 'read' ? 0 : job.step === 'look' ? 2 : 1;
        else {
          at = STEP_AT[job.step] || 0;
          if (job.name) at = Math.max(at, 2);
          if (job.logo) at = Math.max(at, 3);
          if (job.banner) at = Math.max(at, STEP_AT.look); // the second look runs after both pictures are drawn
        }
      }
      return { k, at };
    };

    function update(animate) {
      if (!alive()) {
        job.subs.delete(onJob);
        return;
      }
      const { k, at } = state();
      const end = job.end;
      const err = end === 'error' ? job.error : null;

      if (!shown.head) {
        shown.head = true;
        bot.appendChild(head);
        if (animate) reveal(head);
        if (!end) spinner = spin(head.querySelector('.mark'));
      }
      note.textContent = err ? err.text : end ? (follow ? 'done. here is the new version.' : 'here is your coin.') : follow ? 'changing it. this takes about half a minute.' : 'making it. a coin takes about half a minute.';

      if (!shown.steps) {
        shown.steps = true;
        bot.appendChild(steps);
      }
      const upto = err ? items.length : Math.min(at + 1, steps_.length);
      while (items.length < upto) {
        const s = stepItem(steps_[items.length], false);
        if (!animate) s.li.classList.add('on');
        steps.appendChild(s.li);
        items.push(s);
        if (animate) requestAnimationFrame(() => s.li.classList.add('on'));
      }
      items.forEach(({ li, t }, i) => {
        const done = i < at;
        li.classList.toggle('done', done);
        li.classList.toggle('now', !done && !end);
        t.textContent = done ? steps_[i][1] : steps_[i][0];
        if (err && !done) li.remove();
      });
      if (err && !steps.children.length) steps.remove();
      if (err && shown.card) card.card.remove();

      if (!err && k.name) {
        card.fill(k);
        if (!shown.card) {
          shown.card = true;
          bot.appendChild(card.card);
          if (animate) {
            const order = [card.card, card.logo, card.id, card.bio];
            order.forEach((n) => n.classList.add('up'));
            order.forEach((n, i) => setTimeout(() => requestAnimationFrame(() => n.classList.add('on')), i * 170));
            follow2(card.card);
          }
        }
      }

      if (end && !ended) {
        ended = true;
        if (spinner) spinner.stop();
        job.subs.delete(onJob);
        if (end === 'done') {
          // the new version joins the conversation: draw it again as a finished version, with the launch row under it
          setTimeout(() => alive() && route(), follow ? 500 : 900);
        }
        document.title = err ? `${rec.name || B.name} · ${B.name}` : `${k.name} · ${B.name}`;
        if (err) idle(RETRY.has(err.code) ? sentence : '');
      } else if (!end) {
        if (k.name) document.title = `${k.name} · ${B.name}`;
        follow2(steps);
      }
    }
    const onJob = () => update(true);

    if (!live) {
      bot.append(head, steps);
      shown.head = shown.steps = true;
      update(false);
      return;
    }
    document.body.dataset.state = 'making';
    composer.classList.add('away');
    job.subs.add(onJob);
    (async () => {
      if (fresh) {
        reveal(me);
        await wait(420);
        if (!alive()) return;
      }
      update(fresh);
      requestAnimationFrame(() => alive() && follow2(me));
    })();
  }

  // ---------- the coins tab: every coin made on wagbi, newest first ----------
  const coinsTab = $('coins');
  const coinsList = $('coinsList');
  const coinsMore = $('coinsMore');
  const coinsSeen = { list: [], next: null, filter: 'all', loading: false, loaded: 0 };
  const shortCa = (a) => (a ? a.slice(0, 4) + '...' + a.slice(-4) : '');
  function coinRow(c) {
    const li = el('li');
    const a = el('a', 'coin-row');
    a.href = '#/k/' + c.id;
    a.setAttribute('aria-label', `${c.name}, $${c.ticker}${c.launch ? ', launched' : ''}`);
    const logo = el('span', 'coin-logo');
    if (c.logo) logo.appendChild(img(c.logo));
    const id = el('span', 'coin-id');
    id.append(el('b', '', c.name), el('span', '', '$' + c.ticker));
    const st = el('span', 'coin-st');
    if (c.launch) {
      st.append(el('span', 'coin-badge live', c.launch.cluster === 'devnet' ? 'launched (devnet)' : 'launched'), el('code', '', shortCa(c.launch.mint)));
    } else {
      st.append(el('span', 'coin-badge', 'made'));
    }
    const t = el('time', 'coin-t', ago(Date.parse(c.made)));
    t.dateTime = c.made;
    a.append(logo, id, el('span', 'coin-q', c.sentence), st, t);
    li.appendChild(a);
    return li;
  }
  function drawCoins() {
    coinsList.textContent = '';
    const shown = coinsSeen.list.filter((c) => coinsSeen.filter === 'all' || c.launch);
    if (!shown.length) {
      const li = el('li', 'coins-empty', coinsSeen.loading ? 'loading coins.' : coinsSeen.filter === 'live' ? 'no launched coins yet.' : 'no coins yet. make the first one.');
      coinsList.appendChild(li);
    }
    shown.forEach((c) => coinsList.appendChild(coinRow(c)));
    coinsMore.hidden = !coinsSeen.next;
  }
  async function loadCoins(more) {
    if (coinsSeen.loading) return;
    coinsSeen.loading = true;
    if (!more) drawCoins();
    try {
      const q = more && coinsSeen.next ? '?before=' + encodeURIComponent(coinsSeen.next) : '';
      const r = await fetch('/api/coins' + q);
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'could not load the coins.');
      coinsSeen.list = more ? coinsSeen.list.concat(j.coins) : j.coins;
      coinsSeen.next = j.next;
      coinsSeen.loaded = Date.now();
    } catch (e) {
      coinsSeen.loading = false;
      coinsList.textContent = '';
      coinsList.appendChild(el('li', 'coins-empty', 'could not load the coins. try again in a minute.'));
      return;
    }
    coinsSeen.loading = false;
    drawCoins();
  }
  $('coinsFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    coinsSeen.filter = b.dataset.f;
    $('coinsFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    drawCoins();
  });
  coinsMore.addEventListener('click', () => loadCoins(true));
  function showCoins() {
    document.title = `coins · ${B.name}`;
    document.body.dataset.state = 'idle';
    hero.hidden = true;
    made.hidden = true;
    thread.hidden = true;
    thread.textContent = '';
    coinsTab.hidden = false;
    scrollTo({ top: 0 });
    drawCoins();
    if (Date.now() - coinsSeen.loaded > 20_000) loadCoins(false);
  }

  // ---------- a coin's public page: /k/<kit id>, the link pump.fun shows ----------
  function showKitPage(kitId) {
    const my = gen;
    document.title = B.name;
    hero.hidden = true;
    made.hidden = true;
    thread.hidden = false;
    thread.textContent = '';
    scrollTo({ top: 0 });
    const bot = el('div', 'bot');
    const head = el('div', 'bot-head');
    head.innerHTML = mark();
    const note = el('p', 'note', 'loading this coin.');
    head.appendChild(note);
    bot.appendChild(head);
    thread.append(bot, composer);
    composer.classList.remove('away', 'up', 'on');
    holdPh('make your own coin');
    ta.value = '';
    fit();
    document.body.dataset.state = 'idle';
    const L = window.WagbiLaunch;
    if (!L) return;
    L.coinPage(bot, kitId).then((p) => {
      if (my !== gen) return;
      if (!p) {
        note.textContent = 'this coin is not here.';
        return;
      }
      const { kit, coin, wrap } = p;
      wrap.remove();
      document.title = `${kit.name} · ${B.name}`;
      note.textContent = `made with ${B.name} from one sentence: `;
      note.appendChild(el('q', '', kit.sentence));
      if (p.versions.length > 1) note.append(` (${p.versions.length} versions; this is version ${kit.version || 1})`);
      const card = realCard();
      card.fill(kit);
      bot.appendChild(card.card);
      if (coin) bot.appendChild(L.liveBox(coin));
      else bot.appendChild(el('p', 'note lp-notyet', 'not launched yet.'));
    });
  }

  // ---------- voice: tap the mic, say the idea, the words land in the box (api/transcribe) ----------
  const mic = $('mic');
  let recorder = null;
  let micLimit = null;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) mic.hidden = true;
  mic.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (mic.dataset.state === 'rec') return recorder && recorder.state === 'recording' && recorder.stop();
    if (mic.dataset.state === 'busy' || document.body.dataset.state === 'making') return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      holdPh('the mic is blocked. allow it in your browser to talk.');
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const chunks = [];
    recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = async () => {
      clearTimeout(micLimit);
      stream.getTracks().forEach((t) => t.stop());
      mic.dataset.state = 'busy';
      holdPh('writing it down');
      const blob = new Blob(chunks, { type: (recorder.mimeType || type || 'audio/webm').split(';')[0] });
      try {
        const r = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok && j.text) {
          ta.value = ((ta.value ? ta.value.trim() + ' ' : '') + j.text).slice(0, MAX_LEN);
          fit();
          ta.focus();
        } else {
          holdPh(j.error || "couldn't hear that. try again.");
        }
      } catch (err) {
        holdPh(SAY.offline);
      }
      mic.dataset.state = '';
      mic.setAttribute('aria-label', 'speak your idea');
    };
    recorder.start();
    mic.dataset.state = 'rec';
    mic.setAttribute('aria-label', 'stop and write it down');
    holdPh('listening. tap the mic again when you are done.');
    micLimit = setTimeout(() => recorder && recorder.state === 'recording' && recorder.stop(), 30_000);
  });

  // ---------- settings (bottom of the sidebar) and the header's CA ----------
  const setBtn = $('settingsBtn');
  const setMenu = $('settingsMenu');
  const openSettings = (on) => {
    setMenu.hidden = !on;
    setBtn.setAttribute('aria-expanded', String(on));
    if (!on) $('clearConfirm').hidden = true;
  };
  setBtn.addEventListener('click', (e) => { e.stopPropagation(); openSettings(setMenu.hidden); });
  document.addEventListener('click', (e) => { if (!setMenu.hidden && !setMenu.contains(e.target)) openSettings(false); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') openSettings(false); });
  $('clearBtn').addEventListener('click', () => { $('clearConfirm').hidden = false; });
  $('clearNo').addEventListener('click', () => { $('clearConfirm').hidden = true; });
  $('clearYes').addEventListener('click', () => { clearAll(); openSettings(false); });

  // ---------- sign in with google: a person's coin chats follow them across devices ----------
  // signed out, chats live on this device as before. signing in merges this device's chats into the account, and
  // from then on every change is sent up (and other devices' changes come down on the next load or sync).
  function authUi() {
    const on = !!auth.clientId;
    $('signInBtn').hidden = on;
    $('gBtn').hidden = !on || !!auth.user;
    $('signOutBtn').hidden = !auth.user;
    $('authNote').textContent = auth.user
      ? `signed in as ${auth.user.email || auth.user.name || 'you'}. your chats follow you to any device.`
      : on ? 'sign in to keep your chats on every device. signed out, they live on this device only.' : 'signed out, your chats live on this device only.';
    $('clearText').textContent = auth.user
      ? `delete every coin chat from this device and your account? the coins already made stay on ${B.name}.`
      : `delete every coin chat from this device? the coins already made stay on ${B.name}.`;
  }
  let gsiLoaded = null;
  function googleButton() {
    if (!auth.clientId || auth.user) return;
    gsiLoaded ??= new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client';
      sc.async = true;
      sc.onload = res;
      sc.onerror = rej;
      document.head.appendChild(sc);
    });
    gsiLoaded.then(() => {
      const g = window.google && window.google.accounts && window.google.accounts.id;
      if (!g) return;
      g.initialize({ client_id: auth.clientId, callback: onGoogle, auto_select: false, cancel_on_tap_outside: true, use_fedcm_for_button: true });
      $('gBtn').textContent = '';
      g.renderButton($('gBtn'), { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 232 });
    }).catch(() => { $('authNote').textContent = "google's sign-in didn't load. try again."; gsiLoaded = null; });
  }
  async function onGoogle(resp) {
    try {
      const r = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: resp && resp.credential }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'sign-in failed');
      auth.user = j.user;
      authUi();
      await sync();
    } catch (e) {
      $('authNote').textContent = "that sign-in didn't go through. try again.";
    }
  }
  $('signOutBtn').addEventListener('click', async () => {
    await fetch('/api/auth', { method: 'DELETE' }).catch(() => {});
    try { window.google && window.google.accounts.id.disableAutoSelect(); } catch (e) { /* not loaded */ }
    auth.user = null;
    authUi();
    googleButton();
  });
  setBtn.addEventListener('click', () => googleButton());

  // sends this device's chats up, takes the merged list back (a make running here keeps its local copy)
  let syncing = false;
  let syncAgain = false;
  let syncTimer = null;
  async function sync() {
    if (!auth.user) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    try {
      const sent = coins.filter((c) => !c.example);
      const r = await fetch('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chats: sent, deleted: deletedIds }) });
      if (r.status === 401) { auth.user = null; authUi(); return; }
      const j = await r.json();
      if (!r.ok || !j.ok) return;
      deletedIds = {};
      saveDeleted();
      const live = coins.filter((c) => running(c.id) || c.pending);
      const merged = j.chats.filter(valid);
      for (const c of live) {
        const i = merged.findIndex((m) => m.id === c.id);
        if (i >= 0) merged[i] = c; else merged.unshift(c);
      }
      const examples = coins.filter((c) => c.example && !merged.some((m) => m.id === c.id));
      coins = [...merged, ...examples].sort((a, b) => b.t - a.t).slice(0, MAX);
      try { localStorage.setItem(KEY, JSON.stringify(coins)); } catch (e) { /* memory only */ }
      renderSide();
      const rt = parse();
      if (rt.kind === 'coin' && !find(rt.id) && !jobs[rt.id]) location.hash = '#/';
    } catch (e) {
      /* offline: the next change tries again */
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; syncSoon(); }
    }
  }
  function syncSoon() {
    if (!auth.user) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 1500);
  }
  authUi();
  fetch('/api/auth').then((r) => r.json()).then((j) => {
    if (!j || !j.ok) return;
    auth.clientId = j.clientId;
    auth.user = j.user;
    authUi();
    if (auth.user) sync();
  }).catch(() => {});
  addEventListener('focus', () => { if (auth.user) syncSoon(); });
  if (window.WagbiLaunch) {
    window.WagbiLaunch.config().then((c) => {
      if (!c || !c.ca) return;
      const b = $('caBtn');
      b.disabled = false;
      b.textContent = 'CA ' + c.ca.slice(0, 4) + '...' + c.ca.slice(-4);
      b.title = c.ca;
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(c.ca); } catch (e) { /* no clipboard */ }
        b.textContent = 'copied';
        setTimeout(() => (b.textContent = 'CA ' + c.ca.slice(0, 4) + '...' + c.ca.slice(-4)), 1500);
      });
    }).catch(() => {});
  }

  // coins left mid make by a reload: look for their stored kit once, quietly
  coins.filter((c) => !c.example && c.kit && !c.logo).forEach((c) => startJob(c, true));
  // /k/<kit id> (the link pump.fun shows) opens as #/k/<kit id>
  const kp = location.pathname.match(/^\/k\/([A-Za-z0-9_-]{16})\/?$/);
  if (kp && (!location.hash || location.hash === '#/')) history.replaceState(null, '', '/#/k/' + kp[1]);
  route();
})();
