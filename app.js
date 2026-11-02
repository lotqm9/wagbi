// wagbi front end: a chat with wagbi's assistant. Each chat lives at /coin/<id>; the history is kept in this viewer's
// localStorage and follows a signed-in person to every device. A message streams from /api/make: the reply as it is
// written, the thinking and every step of the work, and when it makes a coin, two designs to pick from.
(() => {
  const B = window.BRAND || { name: 'wagbi', domain: 'wagbi.fun' };
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
  const svgIcon = (d, size = 16) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    s.setAttribute('width', size);
    s.setAttribute('height', size);
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = d;
    return s;
  };
  const ICON = {
    chev: '<path d="m7.5 5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    dots: '<circle cx="4.5" cy="10" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><circle cx="15.5" cy="10" r="1.5" fill="currentColor"/>',
    pen: '<path d="M12.6 4.4 15.6 7.4 7.6 15.4H4.6V12.4Z M11 6l3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
    bin: '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.8 10h6.4L14 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    check: '<path d="m5 10.4 3.2 3.1L15 6.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    link: '<path d="M8.6 11.4a3 3 0 0 0 4.2 0l2.4-2.4a3 3 0 0 0-4.2-4.2l-1 1M11.4 8.6a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l1-1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    x: '<path d="M6 6l8 8M14 6l-8 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  };

  const IDEAS = [
    'a raccoon who runs a hedge fund',
    'paste a tweet and say: make it a coin',
    'a dog that only buys the top',
    'drop a picture of your cat',
    'the moon, but it is tired',
    'pepe running a bank',
  ];
  const MAX_LEN = 600;
  // said here when the server could not say it
  const SAY = {
    offline: `could not reach ${B.name}. check your connection and try again.`,
    jam: 'something went wrong on that one. try it again.',
    lost: 'this reply did not finish. try it again.',
  };
  // after these the message goes back in the box, ready to send again
  const RETRY = new Set(['offline', 'jam', 'lost', 'slow', 'off', 'too_long', 'empty', 'resting', 'busy', 'no_art']);

  // ---------- the mark ----------
  let uid = 0;
  function mark() {
    if (B.markImg) return `<img class="mark" src="${B.markImg}" alt="" aria-hidden="true">`;
    const id = 'mk' + (++uid);
    return `<svg class="mark" viewBox="0 0 200 200" aria-hidden="true"><defs><clipPath id="${id}"><circle cx="100" cy="100" r="78"/></clipPath></defs><circle cx="100" cy="100" r="78" fill="#0b0b0c"/><g clip-path="url(#${id})"><g class="arc"><circle cx="128" cy="72" r="78" fill="none" stroke="#f4f4f1" stroke-width="7"/></g></g></svg>`;
  }
  const img = (src, alt = '') => {
    const i = new Image();
    i.alt = alt;
    i.decoding = 'async';
    i.src = src;
    return i;
  };
  // a link from the stream or a stored chat (a page it read, a search result, a post): http(s) only, never script
  const safeHref = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

  // the arc of light turns while wagbi works, then eases to rest
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

  // ---------- history: per viewer, never required ----------
  // a chat: { id, sentence (its first message), t (last message), u (last change), title?, titleAt?, root, kit (the
  //   design it is on), name, ticker, bio, logo, banner, thumb, turns, pending? }
  // a turn: { q, t, files?, links?, web?, a (the reply), made?: [design, design?], pick (0, 1 or null), v?, kind?, tr? }
  // a design: { kit, root, name, ticker, bio, angle, logo, banner, thumb }
  const KEY = `${B.id || 'wagbi'}.coins.v1`;
  const MAX = 100;
  const KIT_ID = /^[A-Za-z0-9_-]{16}$/;
  const PIC = /^https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com\/(kits\/[A-Za-z0-9_-]{16}\/(logo\.png|banner\.(png|jpg)|thumb\.webp)|uploads\/[A-Za-z0-9_-]{16}\.jpg)$/;
  const REF = /^https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com\/refs\/[0-9a-f]{16,64}\.jpg$/;
  const okPic = (u) => u == null || PIC.test(u);
  const jobs = {}; // chat id -> the message running in this tab
  const okDesign = (d) => d && KIT_ID.test(d.kit || '') && okPic(d.logo) && okPic(d.banner) && okPic(d.thumb);
  // chats from before the two designs: their versions become turns of one design each
  function migrate(c) {
    if (!c || typeof c !== 'object') return c;
    const old = Array.isArray(c.turns) ? c.turns : c.kit && c.logo ? [{ v: 1, kit: c.kit, ask: c.sentence, name: c.name, ticker: c.ticker, bio: c.bio, logo: c.logo, banner: c.banner }] : null;
    if (!old || old.every((t) => t && 'q' in t)) return c;
    c.turns = old.filter((t) => t && t.kit).map((t, i) => ({ q: t.ask || c.sentence, t: c.t, a: i === 0 ? 'here is your coin.' : 'here is the new version.', made: [{ kit: t.kit, root: c.turns && c.turns[0] ? c.turns[0].kit : c.kit, name: t.name, ticker: t.ticker, bio: t.bio, angle: '', logo: t.logo, banner: t.banner, thumb: null }], pick: 0, v: t.v || i + 1 }));
    c.root = c.root || (c.turns[0] && c.turns[0].made[0].kit);
    return c;
  }
  const valid = (c) => {
    if (!c || typeof c.id !== 'string' || typeof c.sentence !== 'string' || typeof c.t !== 'number') return false;
    if (c.example) return false; // the demo days' examples are gone
    if (!okPic(c.logo) || !okPic(c.banner) || !okPic(c.thumb)) return false;
    if (c.kit != null && !KIT_ID.test(c.kit)) return false;
    if (!Array.isArray(c.turns)) return !!jobs[c.id] || !!c.pending;
    return c.turns.every((t) => t && typeof t.q === 'string' && (!t.made || (Array.isArray(t.made) && t.made.every(okDesign))));
  };
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(migrate).filter(valid).sort((a, b) => b.t - a.t).slice(0, MAX) : [];
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
      Object.assign(c, fields, { u: Date.now() });
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
    if (parse().kind === 'coin' && parse().id === id) go('/');
    else renderSide();
  }
  function renameChat(id, title) {
    const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    patch(id, { title: t || null, titleAt: Date.now() });
    renderSide();
    if (parse().kind === 'coin' && parse().id === id) document.title = `${titleOf(find(id))} · ${B.name}`;
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
    if (parse().kind === 'coin') go('/');
    else renderSide();
  }
  const titleOf = (c) => (c && (c.title || c.name || c.sentence)) || B.name;

  function ago(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd';
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase();
  }
  const secs = (ms) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

  // ---------- elements ----------
  const hero = $('hero');
  const thread = $('thread');
  // the examples grid is gone; the coins tab and the coin page still hide it on their way in
  const made = $('made') || { hidden: true };
  const composer = $('composer');
  const field = $('field');
  const ta = $('prompt');
  const ph = $('ph');
  const list = $('list');
  const side = $('side');
  const menu = $('menu');
  const sendBtn = $('send');
  const plus = $('plus');
  const plusMenu = $('plusMenu');
  const atts = $('atts');
  const fileInput = $('fileInput');
  const webPill = $('webPill');
  const webToggle = $('webToggle');

  $('heroMark').innerHTML = mark();
  $('brandMark').outerHTML = mark();

  // ---------- the prompt box ----------
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
  function holdPh(text, forever) {
    ph.classList.remove('out', 'pre');
    ph.textContent = text;
    holdUntil = forever ? Infinity : Date.now() + 6000;
  }
  const uploading = () => draft.some((a) => a.busy);
  function fit() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
    field.classList.toggle('has', ta.value.length > 0);
    sendBtn.disabled = !ta.value.trim() || uploading() || document.body.dataset.state === 'making';
  }
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit(ta.value);
    }
  });
  composer.addEventListener('submit', (e) => { e.preventDefault(); submit(ta.value); });
  field.addEventListener('click', (e) => { if (e.target === field || e.target.closest('.ta')) ta.focus(); });
  addEventListener('resize', fit);
  const focusPrompt = () => { if (canHover) ta.focus({ preventScroll: true }); };

  // ---------- the "+": pictures, links, web search ----------
  // draft: what goes with the next message. { kind: 'img', id, local, url, busy, bad } | { kind: 'link', id, url }
  let draft = [];
  const MAX_PICS = 4;
  const MAX_LINKS = 3;
  const WEB_KEY = KEY + '.web';
  let webOn = (() => { try { return localStorage.getItem(WEB_KEY) !== '0'; } catch (e) { return true; } })();
  function setWeb(on) {
    webOn = on;
    webToggle.checked = on;
    $('pmWeb').setAttribute('aria-checked', String(on));
    webPill.setAttribute('aria-pressed', String(on));
    webPill.title = on ? 'web search is on: wagbi looks things up when it helps' : 'web search is off';
    try { localStorage.setItem(WEB_KEY, on ? '1' : '0'); } catch (e) { /* memory only */ }
  }
  setWeb(webOn);
  webPill.addEventListener('click', (e) => { e.stopPropagation(); setWeb(!webOn); });
  webToggle.addEventListener('change', () => setWeb(webToggle.checked));
  $('pmWeb').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setWeb(!webOn); } });

  function openPlus(on) {
    plusMenu.hidden = !on;
    plus.setAttribute('aria-expanded', String(on));
    if (!on) $('pmLinkBox').hidden = true;
  }
  plus.addEventListener('click', (e) => { e.stopPropagation(); openPlus(plusMenu.hidden); });
  plusMenu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (!plusMenu.hidden) openPlus(false); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !plusMenu.hidden) { openPlus(false); plus.focus(); } });
  $('pmPhotos').addEventListener('click', () => { openPlus(false); fileInput.click(); });
  $('pmLink').addEventListener('click', () => {
    const box = $('pmLinkBox');
    box.hidden = !box.hidden;
    if (!box.hidden) $('pmLinkInput').focus();
  });
  const addLinkFromBox = () => {
    const v = $('pmLinkInput').value.trim();
    if (!v) return;
    if (addLink(v)) {
      $('pmLinkInput').value = '';
      openPlus(false);
      ta.focus();
      if (!ta.value.trim()) {
        ta.value = /(^|\.)(x|twitter)\.com\//i.test(v) ? 'turn this post into a coin' : 'make a coin from this';
        fit();
      }
    } else {
      $('pmLinkInput').setCustomValidity('paste a full link, starting with https://');
      $('pmLinkInput').reportValidity();
      setTimeout(() => $('pmLinkInput').setCustomValidity(''), 2000);
    }
  };
  $('pmLinkAdd').addEventListener('click', addLinkFromBox);
  $('pmLinkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLinkFromBox(); } });
  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  });
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  field.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) {
      e.preventDefault();
      field.classList.add('drop');
    }
  });
  field.addEventListener('dragleave', (e) => { if (!field.contains(e.relatedTarget)) field.classList.remove('drop'); });
  field.addEventListener('drop', (e) => {
    field.classList.remove('drop');
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  const shortUrl = (u) => {
    try {
      const x = new URL(u);
      return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, '').slice(0, 48);
    } catch (e) {
      return u.slice(0, 48);
    }
  };
  const isPostLink = (u) => /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/[^/]+\/status\/\d+/i.test(u);
  function addLink(raw) {
    let u;
    try {
      u = new URL(raw.trim());
    } catch (e) {
      return false;
    }
    if (!/^https?:$/.test(u.protocol)) return false;
    if (draft.filter((a) => a.kind === 'link').length >= MAX_LINKS) return holdPh(`${MAX_LINKS} links at most.`), true;
    if (!draft.some((a) => a.kind === 'link' && a.url === u.href)) draft.push({ kind: 'link', id: newId(), url: u.href });
    drawDraft();
    return true;
  }
  function addFiles(files) {
    for (const f of files) {
      if (draft.filter((a) => a.kind === 'img').length >= MAX_PICS) { holdPh(`${MAX_PICS} pictures at most.`); break; }
      if (!/^image\//.test(f.type)) { holdPh('png, jpg, webp or gif pictures only.'); continue; }
      if (f.size > 40_000_000) { holdPh('that picture is too big. try a smaller one.'); continue; }
      const a = { kind: 'img', id: newId(), local: URL.createObjectURL(f), url: null, busy: true, bad: false };
      draft.push(a);
      upload(a, f);
    }
    drawDraft();
  }
  // The server takes a request body of 4.5 MB at most (Vercel's limit) and keeps a 1536 px copy, so a picture over
  // 3.5 MB or 2048 px a side (most phone photos), or one the server doesn't read (heic, avif), is redrawn here first:
  // a JPEG of at most 2048 px a side, on white. Answers what to send, or null when this browser can't read it.
  const SEND_MAX = 3_500_000;
  async function shrinkPicture(f) {
    const native = /^image\/(png|jpeg|webp|gif)$/.test(f.type);
    let bmp = null;
    try {
      if (typeof createImageBitmap !== 'function') return native && f.size <= SEND_MAX ? f : null;
      bmp = await createImageBitmap(f);
      const side = Math.max(bmp.width, bmp.height);
      if (native && f.size <= SEND_MAX && side <= 2048) return f;
      const k = Math.min(1, 2048 / side);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * k));
      c.height = Math.max(1, Math.round(bmp.height * k));
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0, c.width, c.height);
      for (const q of [0.9, 0.8, 0.65]) {
        const b = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
        if (b && b.size <= SEND_MAX) return b;
      }
      return null;
    } catch (e) {
      return native && f.size <= SEND_MAX ? f : null;
    } finally {
      if (bmp && bmp.close) bmp.close();
    }
  }
  async function upload(a, f) {
    try {
      const body = await shrinkPicture(f);
      if (!body) throw new Error(/^image\/(png|jpeg|webp|gif)$/.test(f.type) ? 'that picture is too big. try a smaller one.' : 'png, jpg, webp or gif pictures only.');
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': body.type || f.type }, body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok || !PIC.test(j.url || '')) throw new Error(j.error || (r.status === 413 ? 'that picture is too big. try a smaller one.' : "that picture didn't upload. try another one."));
      a.url = j.url;
    } catch (e) {
      a.bad = true;
      holdPh(e.message && e.message.length < 90 ? e.message : "that picture didn't upload. try another one.");
    }
    a.busy = false;
    drawDraft();
  }
  function drawDraft() {
    atts.textContent = '';
    atts.hidden = !draft.length;
    for (const a of draft) {
      const chip = el('div', 'att' + (a.kind === 'img' ? ' img' : '') + (a.busy ? ' busy' : '') + (a.bad ? ' bad' : ''));
      if (a.kind === 'img') {
        chip.appendChild(img(a.local));
        chip.title = a.bad ? "this picture didn't upload" : 'a picture for the art';
      } else {
        const ic = el('span', 'att-ic');
        ic.appendChild(svgIcon(ICON.link, 18));
        const t = el('span', 'att-t');
        t.append(el('b', '', isPostLink(a.url) ? 'a post on x' : 'a link'), el('span', '', shortUrl(a.url)));
        chip.append(ic, t);
        chip.title = a.url;
      }
      const x = el('button', 'att-x');
      x.type = 'button';
      x.setAttribute('aria-label', 'remove');
      x.appendChild(svgIcon(ICON.x, 12));
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        draft = draft.filter((d) => d !== a);
        if (a.local) URL.revokeObjectURL(a.local);
        drawDraft();
      });
      chip.appendChild(x);
      atts.appendChild(chip);
    }
    fit();
  }
  function clearDraft() {
    for (const a of draft) if (a.local) setTimeout(() => URL.revokeObjectURL(a.local), 60_000);
    draft = [];
    drawDraft();
  }

  // ---------- a message: one job per chat, alive while this tab is ----------
  const running = (id) => !!jobs[id] && !jobs[id].end;
  const busy = () => Object.keys(jobs).some(running);

  async function fetchKit(kitId) {
    const r = await fetch('/api/kit/' + encodeURIComponent(kitId));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('kit ' + r.status);
    const j = await r.json();
    return j && j.kit;
  }
  const designOf = (k) => ({ kit: k.id, root: k.root || k.id, name: k.name, ticker: k.ticker, bio: k.bio, angle: k.angle || k.style || '', logo: k.logo, banner: k.banner, thumb: k.thumb || null });
  // the coin's website (wagbi.fun/<slug>) as a chat keeps it: { slug, path, url, rev, kit (the design it shows) },
  // and the key that lets this chat change it (siteKeys: coin id -> key; only the chat that made a coin has one)
  const SITE_PATH = /^\/[a-z0-9]{3,32}(?:-[a-z0-9]{1,4})?$/;
  const okSite = (s) => !!(s && typeof s.path === 'string' && SITE_PATH.test(s.path) && typeof s.url === 'string' && /^https:\/\//.test(s.url));
  const siteRec = (s, kit) => ({ slug: s.slug, path: s.path, url: s.url, rev: Number.isFinite(s.rev) ? s.rev : null, kit });
  function siteFields(rec, kit, site, ids, keys) {
    const out = {};
    if (okSite(site)) out.site = siteRec(site, kit.id);
    const root = kit.root || kit.id;
    const i = Array.isArray(ids) ? ids.indexOf(root) : -1;
    if (i >= 0 && Array.isArray(keys) && typeof keys[i] === 'string' && !(rec.siteKeys || {})[root]) out.siteKeys = { ...(rec.siteKeys || {}), [root]: keys[i] };
    return out;
  }
  // the page's record of the conversation, as /api/make takes it (the last 12 turns)
  const historyOf = (rec) => (rec.turns || []).slice(-12).map((t) => ({ q: t.q, a: String(t.a || '').slice(0, 1500), made: (t.made || []).map((d) => ({ name: d.name, ticker: d.ticker, angle: d.angle || '' })), picked: Number.isInteger(t.pick) ? t.pick : null }));
  // the design the chat is on (what a follow-up changes and what launches)
  function currentOf(rec) {
    for (let i = (rec.turns || []).length - 1; i >= 0; i--) {
      const t = rec.turns[i];
      const j = (t.made || []).findIndex((d) => d.kit === rec.kit);
      if (j >= 0) return { turn: t, i, j, d: t.made[j] };
    }
    return null;
  }

  // a message's job: everything the stream says, for whichever view shows it
  function startJob(rec, msg) {
    const id = rec.id;
    const job = { q: msg.q, files: msg.files || [], links: msg.links || [], web: msg.web, t0: Date.now(), reply: '', thought: '', thinking: false, thoughtMs: null, steps: new Map(), designs: [], end: null, error: null, subs: new Set(), ids: null };
    jobs[id] = job;
    const tell = () => job.subs.forEach((fn) => fn());
    const finish = (end) => {
      job.end = end;
      job.ms = Date.now() - job.t0;
      tell();
      renderSide();
    };
    const failWith = (code, text) => {
      job.error = { code, text: text || SAY[code] || SAY.jam };
      const c0 = find(id);
      // (a newer message sent on this chat from another tab keeps its own pending)
      if (c0 && c0.pending && (!Array.isArray(c0.pending.ids) || (job.ids && c0.pending.ids[0] === job.ids[0]))) patch(id, { pending: null });
      // a chat that never got a reply is not a chat
      const c = find(id);
      if (c && (!c.turns || !c.turns.length) && !c.pending) forget(id);
      finish('error');
    };
    function on(ev) {
      if (job.end) return;
      if (ev.type === 'start') {
        job.ids = ev.ids;
        job.token = typeof ev.token === 'string' ? ev.token : null;
        // a new coin's site key (one per id: the coin is whichever design comes out first); only this chat gets it
        job.keys = Array.isArray(ev.keys) && ev.keys.every((k) => typeof k === 'string' && k.length < 64) ? ev.keys : null;
        patch(id, { pending: { q: job.q, ids: ev.ids, t: job.t0, token: job.token, keys: job.keys || undefined } });
      } else if (ev.type === 'reply') {
        job.reply = ev.replace ? ev.text : job.reply + ev.text;
      } else if (ev.type === 'think') {
        job.thought += ev.text;
        job.thinking = true;
      } else if (ev.type === 'step') {
        const s = job.steps.get(ev.id) || { t0: Date.now() };
        Object.assign(s, ev);
        if (ev.state !== 'run' && ev.ms == null) s.ms = Date.now() - s.t0;
        job.steps.set(ev.id, s);
      } else if (ev.type === 'design') {
        job.designs[ev.i] = { ...(job.designs[ev.i] || {}), name: ev.name, ticker: ev.ticker, bio: ev.bio, angle: ev.angle };
      } else if (ev.type === 'thought') {
        job.thoughtMs = ev.ms;
      } else if (ev.type === 'art') {
        if (/^data:image\/(png|webp|jpeg);base64,/.test(ev.src || '') || PIC.test(ev.src || '')) job.designs[ev.i] = { ...(job.designs[ev.i] || {}), [ev.kind]: ev.src };
      } else if (ev.type === 'done') {
        const kits = (Array.isArray(ev.kits) ? ev.kits : []).filter((k) => KIT_ID.test(k.id || '') && PIC.test(k.logo || '') && PIC.test(k.banner || ''));
        const turn = { q: job.q, t: job.t0, k: job.ids ? job.ids[0] : undefined, a: String(ev.reply || job.reply || '').slice(0, 4000), files: job.files.length ? job.files : undefined, links: job.links.length ? job.links : undefined, web: job.web, made: kits.length ? kits.map(designOf) : undefined, pick: null, v: kits.length ? kits[0].version : undefined, tr: traceOf(job) };
        const c0 = find(id);
        const mine = !c0 || !c0.pending || !job.ids || !Array.isArray(c0.pending.ids) || c0.pending.ids[0] === job.ids[0];
        job.turnIndex = landTurn(id, rec, turn, kits, job.token, mine, (cur) => siteFields(cur, kits[0], ev.site, job.ids, job.keys));
        // a change to the coin's website (no new designs): the card under the design shows it
        const c1 = find(id);
        if (!kits.length && okSite(ev.site) && c1 && c1.kit) patch(id, { site: siteRec(ev.site, c1.kit) });
        return finish('done');
      } else if (ev.type === 'error') {
        return failWith(ev.code, ev.error);
      }
      tell();
    }

    (async () => {
      let res;
      try {
        res = await fetch('/api/make', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg.q, from: msg.from || undefined, token: msg.from ? msg.token : undefined, history: msg.history, files: job.files, links: job.links, web: msg.web, siteKey: msg.siteKey || undefined }),
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
      // the stream ended early: the kits may still land on the server
      if (job.ids) return recover(id, job);
      failWith('jam');
    })();
    return job;
  }
  // the trace a finished turn keeps: how long it thought, what it did (the thinking itself, shortened)
  const traceOf = (job) => ({ ms: job.thoughtMs || job.ms || Date.now() - job.t0, thought: job.thought.slice(0, 6000), steps: [...job.steps.values()].filter((s) => !/^paint:.*:redo$/.test(s.id) || s.state !== 'run').map((s) => ({ id: s.id, state: s.state, label: s.label, ms: s.ms, links: s.links, thumbs: s.thumbs ? s.thumbs.map((t) => ({ src: REF.test(t.src || '') ? t.src : undefined, href: t.href, title: t.title })) : undefined })) });

  // a finished turn joins its chat; its kits (if any) become the design the chat is on. A new coin's edit token is
  // kept by its coin (tokens[root]): with it, the next message here makes a version of this coin (api/make.js).
  // Answers the turn's index. turn.k: the turn's first kit id (how another tab knows it landed). clear: the chat's
  // pending message is this turn's (a newer one sent from another tab keeps its own). more(cur): more fields for the
  // chat when the turn made kits.
  function landTurn(id, rec, turn, kits, token, clear = true, more = null) {
    const cur = find(id) || rec;
    const fields = { turns: [...(cur.turns || []), turn] };
    if (clear) fields.pending = null;
    if (kits.length) {
      const root = kits[0].root || kits[0].id;
      Object.assign(fields, { kit: kits[0].id, root, name: kits[0].name, ticker: kits[0].ticker, bio: kits[0].bio, logo: kits[0].logo, banner: kits[0].banner, thumb: kits[0].thumb || null });
      if (token && !(cur.tokens && cur.tokens[root])) fields.tokens = { ...(cur.tokens || {}), [root]: token };
      if (more) Object.assign(fields, more(cur));
    }
    patch(id, fields);
    return fields.turns.length - 1;
  }
  const tokenOf = (rec) => {
    const c = currentOf(rec);
    const root = (c && c.d.root) || rec.root || rec.kit;
    return (rec.tokens && root && rec.tokens[root]) || undefined;
  };

  // A message whose stream was lost (a reload, a dropped connection, a phone that slept): the server finishes the
  // turn anyway and keeps how it ended (api/kit/<first id>?turn=1). This looks until well past the turn's own
  // deadline (the server stops at about 13 minutes), then gives up.
  const TURN_MS = 15 * 60_000;
  async function turnOf(firstId) {
    const r = await fetch('/api/kit/' + encodeURIComponent(firstId) + '?turn=1', { cache: 'no-store' });
    if (!r.ok) throw new Error('turn ' + r.status);
    const j = await r.json();
    return (j && j.turn) || null;
  }
  async function recover(id, job) {
    const p = (find(id) || {}).pending;
    const ids = (job && job.ids) || (p && p.ids);
    const t = (job && job.t0) || (p && p.t) || 0;
    const token = (job && job.token) || (p && p.token) || null;
    const q = (p && p.q) || (job && job.q) || '';
    const ours = (c) => !!(c && c.pending && Array.isArray(c.pending.ids) && c.pending.ids[0] === (ids && ids[0]));
    // the turn is in the chat already (another tab kept the stream and landed it)
    const landed = (c) => !!(c && Array.isArray(c.turns) && c.turns.some((x) => x && x.k === ids[0]));
    const end = (how, err) => {
      // a view showing this job redraws itself from it (and shows the error); otherwise the chat is drawn again
      const watched = !!(job && job.subs && job.subs.size);
      if (how === 'error') {
        const c = find(id);
        if (ours(c)) patch(id, { pending: null }); // (another tab's newer message keeps its own)
        if (c && (!c.turns || !c.turns.length) && !c.pending) forget(id);
      }
      if (job && !job.end) {
        if (err) job.error = err;
        job.end = how;
        job.ms = Date.now() - (job.t0 || Date.now());
        job.subs.forEach((fn) => fn());
      }
      if (!watched && parse().kind === 'coin' && parse().id === id) route();
      else renderSide();
    };
    if (!Array.isArray(ids) || !KIT_ID.test(ids[0] || '')) return end('error', { code: 'lost', text: SAY.lost });
    for (let n = 0; n === 0 || Date.now() - t < TURN_MS; n++) {
      if (n) await sleep(n < 24 ? 5000 : 15000);
      if (job && job.end) return;
      const c = find(id);
      if (!c) return end('error', { code: 'lost', text: SAY.lost }); // deleted meanwhile (in another tab)
      if (landed(c)) return end('done'); // another tab landed it: this view just catches up
      let turn = null;
      try {
        turn = await turnOf(ids[0]);
        // a turn from before the turn records: its kits are the only sign
        if (!turn && n % 4 === 3) {
          const old = (await Promise.all(ids.map((k) => fetchKit(k).catch(() => null)))).filter(Boolean);
          if (old.length) turn = { ok: true, reply: old[0].note || 'here are two designs.', kits: old.map((k) => k.id) };
        }
      } catch (e) {
        continue; // offline for a moment: try again
      }
      if (!turn) continue;
      if (!turn.ok) return end('error', { code: String(turn.code || 'jam'), text: String(turn.error || SAY.jam).slice(0, 300) });
      const kits = (await Promise.all((turn.kits || []).filter((k) => KIT_ID.test(k)).slice(0, 2).map((k) => fetchKit(k).catch(() => null)))).filter((k) => k && KIT_ID.test(k.id || '') && PIC.test(k.logo || '') && PIC.test(k.banner || ''));
      if ((turn.kits || []).length && !kits.length) continue; // listed but not readable yet
      const now = find(id);
      if (!now) return end('error', { code: 'lost', text: SAY.lost });
      if (landed(now)) return end('done'); // another tab landed it meanwhile
      const t2 = { q, t, k: ids[0], a: String(turn.reply || (kits.length ? 'here are two designs.' : '')).slice(0, 4000), made: kits.length ? kits.map(designOf) : undefined, pick: null, v: kits.length ? kits[0].version : undefined };
      landTurn(id, now, t2, kits, token, ours(now), (cur) => siteFields(cur, kits[0], null, ids, (job && job.keys) || (p && p.keys)));
      return end('done');
    }
    end('error', { code: 'lost', text: SAY.lost });
  }

  // ---------- sidebar ----------
  let freshId = null;
  let doneId = null;
  let openRowMenu = null;
  const closeRowMenu = () => {
    if (!openRowMenu) return;
    openRowMenu.menu.remove();
    openRowMenu.wrap.classList.remove('menu-open');
    openRowMenu = null;
  };
  document.addEventListener('click', closeRowMenu);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRowMenu(); });
  function startRename(wrap, c) {
    closeRowMenu();
    const nameEl = wrap.querySelector('.row-name');
    if (!nameEl) return;
    const input = el('input', 'row-edit');
    input.value = titleOf(c);
    input.maxLength = 80;
    input.setAttribute('aria-label', 'chat name');
    let done = false;
    const finishEdit = (keep) => {
      if (done) return;
      done = true;
      if (keep && input.value.trim() !== titleOf(c)) renameChat(c.id, input.value);
      else renderSide();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
    });
    input.addEventListener('blur', () => finishEdit(true));
    input.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
  }
  function row({ href, logo, name, sub, t, cur, making, fresh, justDone, chat }) {
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
    if (!chat) return a;
    // a chat's row: rename (the menu, or a double click on its name) and delete (asks first)
    const wrap = el('div', 'row-wrap');
    const more = el('button', 'row-more');
    more.type = 'button';
    more.setAttribute('aria-label', `options for ${name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.appendChild(svgIcon(ICON.dots, 16));
    more.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = openRowMenu && openRowMenu.wrap === wrap;
      closeRowMenu();
      if (open) return;
      const m = el('div', 'row-menu');
      m.setAttribute('role', 'menu');
      const ren = el('button');
      ren.type = 'button';
      ren.setAttribute('role', 'menuitem');
      ren.append(svgIcon(ICON.pen, 16), 'rename');
      ren.addEventListener('click', (ev) => { ev.stopPropagation(); startRename(wrap, chat); });
      const del = el('button', 'danger');
      del.type = 'button';
      del.setAttribute('role', 'menuitem');
      del.append(svgIcon(ICON.bin, 16), making ? 'delete (when done)' : 'delete');
      if (making) del.disabled = true;
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (del.dataset.sure) return deleteChat(chat.id);
        del.dataset.sure = '1';
        del.lastChild.textContent = 'sure? delete';
      });
      m.append(ren, del);
      m.addEventListener('click', (ev) => ev.stopPropagation());
      wrap.appendChild(m);
      wrap.classList.add('menu-open');
      openRowMenu = { wrap, menu: m };
    });
    a.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.row-name')) return;
      e.preventDefault();
      startRename(wrap, chat);
    });
    wrap.append(a, more);
    return wrap;
  }
  function renderSide() {
    const r = parse();
    const keep = list.scrollTop;
    list.textContent = '';
    if (coins.length) {
      $('sideLabel').hidden = false;
      for (const c of coins) {
        const making = running(c.id);
        const logo = c.thumb || c.logo;
        list.appendChild(row({
          href: '/coin/' + c.id,
          logo: logo ? img(logo) : null,
          name: making && !c.name && !c.title ? c.sentence : titleOf(c),
          sub: making ? 'working' : c.ticker ? '$' + c.ticker : 'chat',
          t: c.t,
          cur: r.kind === 'coin' && r.id === c.id,
          making,
          fresh: c.id === freshId,
          justDone: c.id === doneId,
          chat: c,
        }));
      }
      freshId = null;
      doneId = null;
    } else {
      $('sideLabel').hidden = false;
      list.appendChild(el('p', 'side-empty', 'your chats will show up here.'));
    }
    list.scrollTop = keep;
  }
  setInterval(() => { if (coins.length && !busy() && !openRowMenu && !list.querySelector('.row-edit')) renderSide(); }, 60000);

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

  // clean paths (wagbi.fun/coin/<id>), no #/ in them: links inside the app move with the history API and every app
  // path serves the same index.html (vercel.json). Clicking the link you are already on still resets the view.
  const APP_PATH = /^\/(?:$|coins$|coin\/[\w-]+$|example\/[\w-]+$|k\/[A-Za-z0-9_-]{16}$)/;
  function go(path, replace) {
    if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path);
    route();
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/"]');
    if (!a || a.target || a.hasAttribute('download') || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
    const href = a.getAttribute('href');
    if (!APP_PATH.test(href)) return;
    e.preventDefault();
    go(href);
  });

  // ---------- routes ----------
  function parse() {
    const h = location.pathname.replace(/\/+$/, '') || '/';
    let m = h.match(/^\/coin\/([\w-]+)$/);
    if (m) return { kind: 'coin', id: m[1] };
    m = h.match(/^\/example\/([\w-]+)$/);
    if (m) return { kind: 'example', id: m[1] };
    m = h.match(/^\/k\/([A-Za-z0-9_-]{16})$/);
    if (m) return { kind: 'kit', id: m[1] };
    if (h === '/coins') return { kind: 'coins' };
    return { kind: 'new' };
  }
  let gen = 0;
  let streamNext = null;
  function route() {
    closeNav();
    openPlus(false);
    gen++;
    const r = parse();
    const fresh = streamNext;
    streamNext = null;
    coinsTab.hidden = true;
    $('coinsRow').classList.toggle('cur', r.kind === 'coins');
    if (r.kind === 'example') return go('/', true); // the examples are gone
    if (r.kind === 'coins') {
      showCoins();
      renderSide();
      return;
    }
    if (r.kind === 'coin' && (find(r.id) || jobs[r.id])) {
      showChatView(r.id, fresh === r.id);
      renderSide();
      return;
    }
    if (r.kind === 'kit') {
      showKitPage(r.id);
      renderSide();
      return;
    }
    if (r.kind === 'coin') return go('/', true);
    showNew();
    renderSide();
  }
  addEventListener('popstate', route);

  function placeComposer(where) {
    composer.classList.remove('away', 'up', 'on');
    if (where === 'hero') {
      composer.classList.remove('dock');
      hero.appendChild(composer);
    } else {
      composer.classList.add('dock');
      const wrap = el('div', 'dock-wrap');
      wrap.appendChild(composer);
      wrap.appendChild(el('p', 'dock-note', `${B.name} makes mistakes sometimes. check a coin before you launch it.`));
      thread.appendChild(wrap);
    }
  }

  function showNew() {
    document.title = B.name;
    document.body.dataset.state = 'idle';
    thread.hidden = true;
    thread.textContent = '';
    hero.hidden = false;
    made.hidden = false; // the newest launches, under the prompt (launch.js fills it when there are any)
    hero.classList.remove('leaving');
    placeComposer('hero');
    ta.value = '';
    fit();
    ph.classList.remove('out', 'pre');
    ph.textContent = IDEAS[idea];
    holdUntil = Date.now() + 3000;
    scrollTo({ top: 0 });
    focusPrompt();
  }

  async function submit(raw) {
    const text = (raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
    if (!text || document.body.dataset.state === 'making' || uploading()) return;
    const r = parse();
    // "a meme generator for this character": that's a tool, not a message
    if (r.kind === 'coin' && wantsMemeTool(text)) {
      const btn = thread.querySelector('.tool-btn');
      if (btn) {
        ta.value = '';
        fit();
        if (!btn.classList.contains('on')) btn.click();
        return;
      }
    }
    const files = draft.filter((a) => a.kind === 'img' && a.url && !a.bad).map((a) => a.url);
    const links = draft.filter((a) => a.kind === 'link').map((a) => a.url);
    let rec = r.kind === 'coin' ? find(r.id) : null;
    if (rec && running(rec.id)) return;
    const fresh = !rec;
    if (!rec) {
      rec = { id: newId(), sentence: text, t: Date.now(), turns: [] };
      coins.unshift(rec);
      if (coins.length > MAX) coins.length = MAX;
      save();
      freshId = rec.id;
    } else {
      patch(rec.id, { t: Date.now() });
    }
    startJob(rec, { q: text, files, links, web: webOn, from: rec.kit || null, token: tokenOf(rec), history: historyOf(rec), siteKey: (rec.siteKeys || {})[rec.root] || null });
    streamNext = rec.id;
    document.body.dataset.state = 'making';
    ta.value = '';
    clearDraft();
    fit();
    ta.blur();
    if (fresh) {
      if (!hero.hidden && !reduce) {
        hero.classList.add('leaving');
        await wait(260);
      }
      go('/coin/' + rec.id);
    } else {
      route();
    }
  }

  // ---------- the reply's text: paragraphs, lists, bold and links, built as nodes (never as html) ----------
  function inline(parent, text) {
    const re = /(\*\*[^*\n]+\*\*|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
    let at = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > at) parent.append(text.slice(at, m.index));
      const s = m[0];
      if (s.startsWith('**')) parent.appendChild(el('strong', '', s.slice(2, -2)));
      else {
        const a = el('a', '', shortUrl(s));
        a.href = s;
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
        parent.appendChild(a);
      }
      at = m.index + s.length;
    }
    if (at < text.length) parent.append(text.slice(at));
  }
  function richText(box, text) {
    box.textContent = '';
    const blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
    for (const b of blocks) {
      const lines = b.split('\n');
      if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l) || !l.trim())) {
        const ul = el('ul');
        for (const l of lines) {
          if (!l.trim()) continue;
          const li = el('li');
          inline(li, l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
          ul.appendChild(li);
        }
        box.appendChild(ul);
      } else {
        const p = el('p');
        lines.forEach((l, i) => {
          if (i) p.appendChild(el('br'));
          inline(p, l);
        });
        box.appendChild(p);
      }
    }
  }
  const thinkText = (box, text) => {
    box.textContent = '';
    const parts = String(text || '').split(/(\*\*[^*\n]+\*\*)/);
    for (const p of parts) {
      if (/^\*\*[^*\n]+\*\*$/.test(p)) box.appendChild(el('strong', '', p.slice(2, -2)));
      else if (p) box.append(p);
    }
  };

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

  // ---------- a chat ----------
  const reveal = (n) => { n.classList.add('up'); requestAnimationFrame(() => requestAnimationFrame(() => n.classList.add('on'))); };
  function follow(node) {
    const r = node.getBoundingClientRect();
    const dock = thread.querySelector('.dock-wrap');
    const bottom = innerHeight - (dock ? dock.getBoundingClientRect().height : 0) - 16;
    const over = r.bottom - bottom;
    if (over > 0) scrollBy({ top: over, behavior: reduce ? 'auto' : 'smooth' });
  }
  const nearBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 160;

  // the person's message: its words, its pictures, its links
  function meView(q, files, links) {
    const me = el('div', 'me');
    if ((files && files.length) || (links && links.length)) {
      const box = el('div', 'me-atts');
      for (const u of files || []) {
        if (!PIC.test(u)) continue;
        const a = el('a');
        a.href = u;
        a.target = '_blank';
        a.rel = 'noopener';
        a.style.padding = '0';
        a.style.border = '0';
        a.appendChild(img(u, 'a picture you added'));
        box.appendChild(a);
      }
      for (const u of links || []) {
        if (!safeHref(u)) continue;
        const a = el('a');
        a.href = u;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.append(svgIcon(ICON.link, 14), isPostLink(u) ? 'a post on x' : shortUrl(u));
        a.title = u;
        box.appendChild(a);
      }
      me.appendChild(box);
    }
    me.appendChild(el('p', '', q));
    return me;
  }

  // the work: thinking (as it streams) and each step, collapsible like Claude's
  function traceView(get, { live = false, open = false } = {}) {
    const box = el('div', 'trace' + (live ? ' live' : '') + (open ? ' open' : ''));
    const head = el('button', 'trace-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    const title = el('span', 'trace-title');
    const time = el('span', 'trace-time');
    head.append(svgIcon(ICON.chev, 14), title, time);
    head.firstChild.classList.add('chev');
    const body = el('div', 'trace-body');
    const think = el('div', 'think-text');
    const steps = el('ol', 'steps2');
    body.append(think, steps);
    box.append(head, body);
    let loaded = false;
    head.addEventListener('click', async () => {
      const on = !box.classList.contains('open');
      box.classList.toggle('open', on);
      head.setAttribute('aria-expanded', String(on));
      if (on && !loaded && get.load) {
        loaded = true;
        await get.load();
        update();
      }
    });
    const rows = new Map();
    function stepRow(s) {
      let r = rows.get(s.id);
      if (!r) {
        const li = el('li', 'st');
        const i = el('i');
        const label = el('span', 'st-label');
        const t = el('span', 'st-time');
        li.append(i, label, t);
        r = { li, label, t, more: null };
        rows.set(s.id, r);
        steps.appendChild(li);
      }
      r.li.className = 'st ' + (s.state || 'done');
      r.label.textContent = s.label || '';
      const ms = s.state === 'run' ? Date.now() - (s.t0 || Date.now()) : s.ms;
      const paintRun = s.state === 'run' && /^paint:/.test(s.id);
      // (Kie doesn't always say when a picture leaves its queue, so a running picture is just 'painting')
      r.t.textContent = paintRun ? `painting · ${secs(ms)}` : s.state === 'run' ? (ms > 1500 ? secs(ms) : '') : ms > 900 ? secs(ms) : '';
      const extras = (s.thumbs && s.thumbs.length) || (s.links && s.links.length);
      if (extras && !r.more) {
        r.more = el('div', 'st-more');
        for (const th of s.thumbs || []) {
          const a = el('a', 'st-thumb');
          a.href = safeHref(th.href) || '#';
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.title = th.title || '';
          if (th.src) a.appendChild(img(th.src, th.title || ''));
          else a.textContent = '';
          if (!th.src) { a.className = 'st-link'; a.textContent = th.title || shortUrl(th.href || ''); }
          r.more.appendChild(a);
        }
        for (const l of (s.links || []).slice(0, 5)) {
          if (!safeHref(l && l.href)) continue;
          const a = el('a', 'st-link');
          a.href = l.href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          let host = '';
          try { host = new URL(l.href).hostname.replace(/^www\./, ''); } catch (e) { /* as is */ }
          a.append(el('b', '', host), ' ' + (l.title || ''));
          a.title = l.title || l.href;
          r.more.appendChild(a);
        }
        r.li.appendChild(r.more);
      }
    }
    function update() {
      const st = get();
      box.classList.toggle('live', !!st.live);
      title.textContent = st.live ? (st.phase || 'thinking') : st.ms ? `thought for ${secs(st.ms)}` : 'how it was made';
      time.textContent = st.live ? secs(Date.now() - st.t0) : st.count ? `${st.count} step${st.count > 1 ? 's' : ''}` : '';
      if (st.thought != null) {
        thinkText(think, st.live ? st.thought.slice(-1400) : st.thought);
        think.classList.toggle('short', st.thought.length < 300);
      }
      for (const s of st.steps || []) stepRow(s);
    }
    update();
    return { box, update, open(on) { box.classList.toggle('open', on); head.setAttribute('aria-expanded', String(on)); } };
  }

  // one design: banner, logo, words; live ones fill in as they arrive
  function designCard(i, { onPick } = {}) {
    const card = el('article', 'dcard');
    const banner = el('div', 'dc-banner');
    const body = el('div', 'dc-body');
    const top = el('div', 'dc-top');
    const logo = el('div', 'dc-logo');
    const tag = el('span', 'dc-tag', i === 0 ? 'design a' : 'design b');
    top.append(logo, tag);
    const id = el('div', 'dc-id');
    const h3 = el('h3');
    const tick = el('span');
    id.append(h3, tick);
    const bio = el('p', 'dc-bio');
    const angle = el('p', 'dc-angle');
    const foot = el('div', 'dc-foot');
    const pick = el('button', 'dc-pick', 'use this one');
    pick.type = 'button';
    pick.disabled = true;
    foot.appendChild(pick);
    body.append(top, id, bio, angle, foot);
    card.append(banner, body);
    const sk = [el('span', 'dc-skel w1'), el('span', 'dc-skel w2'), el('span', 'dc-skel w3')];
    body.insertBefore(sk[0], id);
    body.insertBefore(sk[1], id);
    body.insertBefore(sk[2], id);
    const put = (box, src, alt) => {
      if (!src || box.dataset.src === src) return;
      box.dataset.src = src;
      const old = box.querySelectorAll('img');
      const im = img(src, alt);
      im.addEventListener('load', () => { old.forEach((o) => o.remove()); box.querySelector('.wait-pic')?.remove(); box.querySelector('.pic-status')?.remove(); });
      box.appendChild(im);
    };
    const waitOn = (box, status) => {
      if (box.dataset.src) return;
      if (!box.querySelector('.wait-pic')) box.appendChild(el('span', 'wait-pic'));
      let s = box.querySelector('.pic-status');
      if (status) {
        if (!s) { s = el('span', 'pic-status'); box.appendChild(s); }
        s.textContent = status;
      } else if (s) s.remove();
    };
    if (onPick) pick.addEventListener('click', () => onPick(i));
    return {
      card,
      fill(d, { live = false, status = {}, picked = false, done = false } = {}) {
        if (d && d.name) {
          sk.forEach((s) => s.remove());
          h3.textContent = d.name;
          tick.textContent = d.ticker ? '$' + d.ticker : '';
          bio.textContent = d.bio || '';
          angle.textContent = d.angle || '';
        }
        const logoSrc = d && (d.thumb || d.logo);
        if (logoSrc) put(logo, logoSrc, d.name ? `${d.name} logo` : 'logo');
        else if (live) waitOn(logo, null);
        if (d && d.banner) put(banner, d.banner, d.name ? `${d.name} banner` : 'banner');
        else if (live) waitOn(banner, status.banner || status.logo || 'waiting for its words');
        card.classList.toggle('picked', picked);
        pick.disabled = !done || picked;
        pick.textContent = '';
        if (picked) pick.append(svgIcon(ICON.check, 16), 'using this one');
        else pick.append(done ? 'use this one' : 'painting…');
        if (done && d && d.kit && !foot.querySelector('.dc-dl')) {
          const dl = el('a', 'dc-dl', 'open the files');
          dl.href = d.logo;
          dl.target = '_blank';
          dl.rel = 'noopener';
          dl.title = 'the logo (1024 px png); the banner opens from its picture';
          banner.style.cursor = 'zoom-in';
          banner.addEventListener('click', () => window.open(d.banner, '_blank', 'noopener'));
          foot.appendChild(dl);
        }
      },
    };
  }

  // the launch row: the chat's current design is what launches (launch.js, unchanged)
  function launchCtx(id, rec) {
    const r = find(id) || rec;
    if (!r.kit) return undefined;
    const c = currentOf(r);
    return {
      kitId: r.kit, coinId: (c && c.d.root) || r.root || r.kit, name: r.name, ticker: r.ticker, bio: r.bio, logo: r.logo, banner: r.banner,
      saved: r.launch, save: (f) => patch(id, { launch: f }),
    };
  }

  // picking a design makes it the chat's current one: the next message changes it, it is what launches, and the
  // coin's website shows it (the server is told; the card under the design shows the site once it has changed)
  const sitePicks = {}; // chat id -> the pick on its way to the server
  function pickDesign(id, ti, i) {
    const rec = find(id);
    if (!rec || running(id)) return;
    const turns = rec.turns.slice();
    const t = { ...turns[ti], pick: i };
    turns[ti] = t;
    const d = t.made[i];
    patch(id, { turns, kit: d.kit, root: d.root || rec.root, name: d.name, ticker: d.ticker, bio: d.bio, logo: d.logo, banner: d.banner, thumb: d.thumb || null });
    const L = window.WagbiLaunch;
    if (L && L.pickSite) {
      const p = (sitePicks[id] = L.pickSite(d.kit, (rec.siteKeys || {})[d.root || rec.root], (rec.tokens || {})[d.root || rec.root])
        .then((site) => {
          const cur = find(id);
          if (site && cur && cur.kit === d.kit) patch(id, { site: siteRec(site, d.kit) });
        })
        .catch(() => {})
        .finally(() => {
          if (sitePicks[id] !== p) return;
          delete sitePicks[id];
          redrawSite(id);
        }));
    }
    route();
  }

  // the coin's website, live, under the design the chat is on (launch.js draws the card)
  function siteBlock(rec) {
    const host = el('div', 'sc-host');
    host.dataset.chat = rec.id;
    fillSite(host, rec);
    return host;
  }
  function fillSite(host, rec) {
    const L = window.WagbiLaunch;
    host.textContent = '';
    if (!L || !L.siteCard || !rec.kit) return;
    const o = { title: "your coin's website", note: 'its own site, made with the coin. it updates as the coin changes, and it goes into the coin as its website when you launch.' };
    if (sitePicks[rec.id]) {
      const wait = el('div', 'sc sc-wait');
      wait.appendChild(el('p', '', 'putting this design on your website'));
      host.appendChild(wait);
      return;
    }
    if (okSite(rec.site) && rec.site.kit === rec.kit) {
      host.appendChild(L.siteCard(rec.site, { ...o, version: rec.site.rev || rec.kit }));
      return;
    }
    L.siteOf(rec.kit, true).then((site) => {
      if (!site || !host.isConnected) return;
      const cur = find(rec.id);
      if (cur && cur.kit === rec.kit) patch(rec.id, { site: siteRec(site, rec.kit) });
      host.textContent = '';
      host.appendChild(L.siteCard(site, { ...o, version: site.rev || rec.kit }));
    });
  }
  function redrawSite(id) {
    const host = thread.querySelector(`.sc-host[data-chat="${id}"]`);
    const rec = find(id);
    if (host && rec) fillSite(host, rec);
  }

  // a finished turn (or the one running now): the message, the work, the reply, the designs
  function turnView(rec, t, ti, job) {
    const wrap = el('div', 'turn');
    wrap.appendChild(meView(t.q, t.files, t.links));
    const ai = el('div', 'ai');
    const markBox = el('div', 'ai-mark');
    markBox.innerHTML = mark();
    const main = el('div', 'ai-main');
    ai.append(markBox, main);
    wrap.appendChild(ai);
    // live while its job runs (it can end while this view is up: the view then shows how it ended)
    const isLive = () => !!job && !job.end;
    const live = isLive();
    const tr = t.tr || (job ? traceOf(job) : null);
    // the work: live from the job, else the turn's own record, else the kit's (loaded on first open)
    let loadedTrace = null;
    const traceState = () => {
      if (isLive()) {
        const steps = [...job.steps.values()];
        const painting = steps.some((s) => s.state === 'run' && /^paint:/.test(s.id));
        const phase = painting ? 'painting the designs' : steps.some((s) => s.state === 'run' && s.id === 'look') ? 'taking a second look' : job.reply && !job.designs.length ? 'writing' : 'thinking';
        return { live: true, phase, t0: job.t0, thought: job.thought, steps, count: steps.length };
      }
      const src = loadedTrace || tr;
      return { live: false, ms: src ? src.ms : null, thought: src ? src.thought || '' : '', steps: src ? src.steps || [] : [], count: src ? (src.steps || []).length : 0 };
    };
    traceState.load = async () => {
      if (tr && (tr.thought || (tr.steps && tr.steps.length))) return;
      const k = t.made && t.made[0] && t.made[0].kit;
      if (!k) return;
      try {
        const kit = await fetchKit(k);
        if (kit && kit.trace) loadedTrace = { ms: tr ? tr.ms : null, thought: kit.trace.thought || '', steps: kit.trace.steps || [] };
      } catch (e) { /* stays as it was */ }
    };
    const hasTrace = live || (tr && (tr.thought || (tr.steps && tr.steps.length))) || (t.made && t.made.length && t.made[0].kit);
    const trace = hasTrace ? traceView(traceState, { live, open: live }) : null;
    if (trace) main.appendChild(trace.box);
    const reply = el('div', 'reply');
    main.appendChild(reply);
    let pair = null;
    const cards = [];
    const ensurePair = (n) => {
      if (!pair) {
        pair = el('div', 'pair');
        main.appendChild(pair);
      }
      while (cards.length < n) {
        const c = designCard(cards.length, { onPick: (i) => pickDesign(rec.id, ti, i) });
        cards.push(c);
        pair.appendChild(c.card);
      }
    };
    const foot = el('div', 'turn-foot');

    function update() {
      const live = isLive();
      // the reply
      const text = (job ? job.reply : t.a || '').replace(/\s+$/, '');
      if (job && job.end === 'error' && !text) {
        reply.classList.add('err');
        reply.textContent = job.error.text;
      } else {
        richText(reply, text || '');
        if (live && !job.designs.length && !job.steps.size && !text) reply.textContent = '';
        if (live && text) {
          const last = reply.lastElementChild || reply;
          last.appendChild(el('span', 'cursor'));
        }
      }
      if (job && job.end === 'error' && text) {
        const e = el('p', 'reply err', job.error.text);
        reply.appendChild(e);
      }
      // the designs
      const made = live ? job.designs : t.made || [];
      if (made.length || (live && job.steps.has('write'))) {
        ensurePair(live ? 2 : made.length);
        cards.forEach((c, i) => {
          const d = made[i];
          if (live) {
            const status = {};
            for (const k of ['logo', 'banner']) {
              const s = job.steps.get(`paint:${i}:${k}`);
              if (s && s.state === 'run') status[k] = `painting ${secs(Date.now() - (s.t0 || Date.now()))}`;
            }
            if (!status.banner && d && d.name && !d.banner) status.banner = 'starting';
            c.fill(d || {}, { live: true, status, picked: false, done: false });
          } else {
            c.fill(d, { picked: t.pick === i, done: true });
          }
        });
        if (pair) pair.classList.toggle('has-pick', !live && Number.isInteger(t.pick));
      }
      if (trace) {
        trace.update();
        // a message turned away before any work (busy, resting, offline) has no work to show
        trace.box.hidden = !!(job && job.end === 'error' && !job.steps.size && !job.thought);
      }
    }
    update();

    if (!live && t.made && t.made.length) {
      foot.textContent = '';
      if (t.v) foot.appendChild(el('span', '', `version ${t.v}`));
      if (Number.isInteger(t.pick)) {
        const p = el('span');
        p.append('using ', el('b', '', t.made[t.pick].name));
        foot.appendChild(p);
      } else if (t.made.length > 1) {
        foot.appendChild(el('span', '', 'pick one to keep going with it, or just say what to change.'));
      }
      main.appendChild(foot);
    }
    return { wrap, main, update };
  }

  function showChatView(id, fresh) {
    const my = gen;
    const alive = () => my === gen;
    let rec = find(id);
    if (!rec && jobs[id]) rec = { id, sentence: jobs[id].q, t: jobs[id].t0, turns: [] };
    if (rec.pending && !jobs[id]) {
      // left mid message (a reload): its kits may still land
      jobs[id] = { q: rec.pending.q, files: [], links: [], t0: rec.pending.t, reply: '', thought: '', steps: new Map(), designs: [], end: null, error: null, subs: new Set(), ids: rec.pending.ids, recovering: true };
      jobs[id].steps.set('wait', { id: 'wait', state: 'run', label: 'still working on your last message', t0: rec.pending.t });
      recover(id, jobs[id]);
    }
    const job = jobs[id];
    const live = !!job && !job.end;
    document.title = `${titleOf(rec)} · ${B.name}`;
    hero.hidden = true;
    made.hidden = true;
    thread.hidden = false;
    thread.textContent = '';

    const turns = rec.turns || [];
    const cur = currentOf(rec);
    turns.forEach((t, ti) => {
      const done = job && job.end === 'done' && job.turnIndex === ti ? job : null;
      const v = turnView(rec, t, ti, done);
      thread.appendChild(v.wrap);
      // the coin's website, live, after the newest turn (so a change to it shows right under the reply); under the
      // design the chat is on, once it is picked, the launch and the tools
      const siteHere = cur && !live && ti === turns.length - 1;
      if (siteHere && cur.i === ti) v.main.appendChild(siteBlock(rec));
      if (cur && cur.i === ti && Number.isInteger(t.pick) && !live) {
        v.main.appendChild(goRow(() => launchCtx(id, rec)));
        v.main.appendChild(toolsRow(() => find(id) || rec));
      }
      if (siteHere && cur.i !== ti) v.main.appendChild(siteBlock(rec));
    });

    // the message running here, or the one that just failed
    let liveView = null;
    if (job && (live || job.end === 'error')) {
      const t = { q: job.q, files: job.files, links: job.links };
      liveView = turnView(rec, t, turns.length, job);
      thread.appendChild(liveView.wrap);
    }
    placeComposer('thread');

    const idle = (again) => {
      holdPh(cur ? 'say what to change, or ask anything' : turns.length ? 'ask anything, or describe a coin' : 'describe a coin', true);
      ta.value = again || ta.value || '';
      fit();
      document.body.dataset.state = 'idle';
      focusPrompt();
    };

    if (!live) {
      idle(job && job.end === 'error' && RETRY.has(job.error.code) && !ta.value ? job.q : '');
      if (job && job.end === 'error') delete jobs[id];
      requestAnimationFrame(() => alive() && scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' }));
      return;
    }

    // the message running here: everything it says, as it comes
    document.body.dataset.state = 'making';
    fit();
    holdPh('wagbi is working on it', true);
    const spinner = spin(liveView.wrap.querySelector('.ai-mark .mark'));
    let ticking = null;
    const onJob = () => {
      if (!alive()) {
        job.subs.delete(onJob);
        clearInterval(ticking);
        return;
      }
      const stick = nearBottom();
      liveView.update();
      if (stick) follow(liveView.wrap);
      if (job.end) {
        job.subs.delete(onJob);
        clearInterval(ticking);
        spinner.stop();
        if (job.end === 'done') {
          doneId = id;
          setTimeout(() => alive() && route(), 350);
        } else {
          document.body.dataset.state = 'idle';
          idle(RETRY.has(job.error.code) ? job.q : '');
          delete jobs[id];
        }
      }
    };
    job.subs.add(onJob);
    // the clocks on running steps tick even when nothing new arrives
    ticking = setInterval(() => alive() && !job.end && liveView.update(), 1000);
    if (fresh) reveal(liveView.wrap.querySelector('.me'));
    requestAnimationFrame(() => alive() && scrollTo({ top: document.documentElement.scrollHeight, behavior: fresh && !reduce ? 'smooth' : 'auto' }));
  }

  // ---------- the coins tab: launched coins first (live numbers), then every coin made and not launched ----------
  // launch.js draws it (WagbiLaunch.coinsTab) and keeps its numbers fresh while it is on screen.
  const coinsTab = $('coins');
  function showCoins() {
    document.title = `coins · ${B.name}`;
    document.body.dataset.state = 'idle';
    hero.hidden = true;
    made.hidden = true;
    thread.hidden = true;
    thread.textContent = '';
    coinsTab.hidden = false;
    scrollTo({ top: 0 });
    if (window.WagbiLaunch) window.WagbiLaunch.coinsTab($('coinsBody'));
  }

  // ---------- a coin's public page: /k/<kit id>, the link the launchpad shows ----------
  // launch.js draws it (WagbiLaunch.kitPage): the coin, and once it is live its market, contract, links and fees.
  function showKitPage(kitId) {
    const my = gen;
    document.title = B.name;
    hero.hidden = true;
    made.hidden = true;
    thread.hidden = false;
    thread.textContent = '';
    scrollTo({ top: 0 });
    const page = el('div', 'kp-host');
    thread.append(page, composer);
    composer.classList.remove('away', 'up', 'on');
    holdPh('make your own coin');
    ta.value = '';
    fit();
    document.body.dataset.state = 'idle';
    const L = window.WagbiLaunch;
    if (!L) return;
    L.kitPage(page, kitId, { alive: () => my === gen }).then((kit) => {
      if (my === gen && kit) document.title = `${kit.name} · ${B.name}`;
    });
  }
  // a launch that went live in the sheet: draw the chat again, so the coin shows its live box
  addEventListener('wagbi:launched', () => route());

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
      // what the account keeps of a chat: everything but the thinking text (the kits keep their own trace)
      const sent = coins.map((c) => ({ ...c, turns: (c.turns || []).map((t) => (t.tr ? { ...t, tr: { ms: t.tr.ms, steps: t.tr.steps } } : t)) }));
      const r = await fetch('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chats: sent, deleted: deletedIds }) });
      if (r.status === 401) { auth.user = null; authUi(); return; }
      const j = await r.json();
      if (!r.ok || !j.ok) return;
      deletedIds = {};
      saveDeleted();
      const live = coins.filter((c) => running(c.id) || c.pending);
      const merged = j.chats.map(migrate).filter(valid);
      for (const c of live) {
        const i = merged.findIndex((m) => m.id === c.id);
        if (i >= 0) merged[i] = c; else merged.unshift(c);
      }
      // the thinking this device still has stays with its turns
      for (const m of merged) {
        const mine = find(m.id);
        if (!mine || mine === m || !Array.isArray(mine.turns) || !Array.isArray(m.turns)) continue;
        m.turns.forEach((t, i) => {
          const o = mine.turns[i];
          if (o && o.q === t.q && o.t === t.t && o.tr && o.tr.thought && t.tr && !t.tr.thought) t.tr = o.tr;
        });
      }
      coins = merged.sort((a, b) => b.t - a.t).slice(0, MAX);
      try { localStorage.setItem(KEY, JSON.stringify(coins)); } catch (e) { /* memory only */ }
      renderSide();
      const rt = parse();
      if (rt.kind === 'coin' && !find(rt.id) && !jobs[rt.id]) go('/', true);
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
  coins.filter((c) => c.pending && Array.isArray(c.pending.ids)).forEach((c) => {
    if (jobs[c.id]) return;
    jobs[c.id] = { q: c.pending.q, files: [], links: [], t0: c.pending.t, reply: '', thought: '', steps: new Map([['wait', { id: 'wait', state: 'run', label: 'still working on your last message', t0: c.pending.t }]]), designs: [], end: null, error: null, subs: new Set(), ids: c.pending.ids, recovering: true };
    recover(c.id, jobs[c.id]);
  });
  // links shared before the clean paths (wagbi.fun/#/coin/<id>) open at the clean path (also when one is pasted
  // into the address bar while the site is open: that changes only the hash, the page doesn't load again)
  const fromHash = () => {
    if (/^#\/./.test(location.hash)) history.replaceState(null, '', location.hash.slice(1));
    else if (location.hash === '#/') history.replaceState(null, '', '/');
    else return false;
    return true;
  };
  addEventListener('hashchange', () => { if (fromHash()) route(); });
  fromHash();
  route();

})();
