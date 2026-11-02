// the launch, as a focused sheet over the coin's chat: coin -> launchpad -> fees -> deposit -> live (LAUNCH-SPEC.md).
// payment is a deposit address, no wallet connection: the server (api/launch) makes the coin when the SOL lands.
// on pump.fun the creator fees are split (the brand's cut locked on chain); on every other launchpad the creator keeps
// all of them and the brand takes nothing. what each launchpad pays comes from the server (api/_lib/launch/facts.js).
// also here: the coin's public page (/k/<id>), the live box under a launched coin's chat, the coins tab, the home strip.
(() => {
  const B = window.BRAND || { name: 'wagbi', domain: 'wagbi.fun' };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const X_LINK = /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})\/?$/i;
  const X_HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
  const short = (a) => (a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '');

  // ---------- icons (stroke, 24 grid) ----------
  const ICON = {
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
    out: '<path d="M8 16L16 8M9.5 8H16v6.5"/>',
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    back: '<path d="M14.5 6l-6 6 6 6"/>',
    next: '<path d="M9.5 6l6 6-6 6"/>',
    wallet: '<rect x="3.5" y="6.5" width="17" height="12.5" rx="3"/><path d="M3.5 10h17M16 14.5h1.5"/>',
    undo: '<path d="M9 14.5L4.5 10 9 5.5"/><path d="M4.5 10H15a4.5 4.5 0 0 1 0 9h-3"/>',
    shield: '<path d="M12 3.5l7 2.5v5.5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    plus: '<path d="M12 6v12M6 12h12"/>',
    chart: '<path d="M4.5 19.5h15M7 16l3.5-4.5 3 2.5 4.5-6.5"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17"/>',
    pen: '<path d="M14.5 5.5l4 4L9 19H5v-4z"/>',
    expand: '<path d="M14 5h5v5M10 19H5v-5M19 5l-6 6M5 19l6-6"/>',
  };
  function icon(name, cls) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    s.innerHTML = ICON[name] || '';
    return s;
  }

  // ---------- numbers ----------
  const SUBS = '₀₁₂₃₄₅₆₇₈₉';
  const trim = (v, d) => {
    let t = Number(v).toFixed(d);
    if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
    return t;
  };
  const ok = (n) => typeof n === 'number' && Number.isFinite(n);
  const fmt = {
    sol(lamports) {
      const v = Math.round(lamports);
      const frac = String(v % 1e9).padStart(9, '0').replace(/0+$/, '');
      return Math.floor(v / 1e9) + (frac ? '.' + frac : '');
    },
    compact(n) {
      const a = Math.abs(n);
      if (a >= 1e9) return trim(n / 1e9, a >= 1e10 ? 1 : 2) + 'B';
      if (a >= 1e6) return trim(n / 1e6, a >= 1e7 ? 1 : 2) + 'M';
      if (a >= 1e3) return trim(n / 1e3, a >= 1e5 ? 0 : 1) + 'K';
      if (a >= 100) return String(Math.round(n));
      if (a >= 1) return trim(n, 2);
      return trim(n, 3) === '0' ? n.toPrecision(2) : trim(n, 3);
    },
    usd: (n) => (ok(n) ? '$' + fmt.compact(n) : null),
    price(n, unit) {
      if (!ok(n) || n <= 0) return null;
      const pre = unit === '$' ? '$' : '';
      const post = unit && unit !== '$' ? ' ' + unit : '';
      if (n >= 1) return pre + trim(n, 2) + post;
      if (n >= 0.001) return pre + Number(n.toPrecision(3)) + post;
      const [m, e] = n.toExponential(3).split('e');
      const zeros = -Number(e) - 1;
      const digits = m.replace('.', '').replace(/0+$/, '');
      return pre + '0.0' + String(zeros).split('').map((d) => SUBS[d]).join('') + digits + post;
    },
    pct(n) {
      if (!ok(n)) return null;
      const r = Math.abs(n) >= 100 ? Math.round(Math.abs(n)) : trim(Math.abs(n), 1);
      return (n > 0.05 ? '+' : n < -0.05 ? '−' : '') + r + '%';
    },
    bps: (bps) => trim(bps / 100, 2) + '%',
    /** a share of the supply: "3.4%", "0.03%", "<0.01%" */
    supply: (p) => (!ok(p) ? '' : p > 0 && p < 0.01 ? '<0.01%' : (p < 1 ? trim(p, 2) : trim(p, 1)) + '%'),
    ago(iso) {
      const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
      if (!ok(s)) return '';
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
      return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase();
    },
    when(iso) {
      const d = new Date(iso);
      if (!ok(d.getTime())) return '';
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).toLowerCase();
    },
  };

  // ---------- the server ----------
  async function api(path, opts) {
    let r;
    try {
      r = await fetch(path, opts);
    } catch (e) {
      throw new Error(`could not reach ${B.name}. check your connection.`);
    }
    let j = null;
    try { j = await r.json(); } catch (e) { /* not json */ }
    if (!r.ok || !j || !j.ok) {
      const err = new Error((j && j.error) || 'something went wrong. try again in a minute.');
      err.code = j && j.code;
      err.status = r.status;
      throw err;
    }
    return j;
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  let cfg = null;
  function config() {
    if (!cfg) cfg = api('/api/launch/config').catch((e) => { cfg = null; throw e; });
    return cfg;
  }
  /** the coin's public launch record, or null when it isn't live */
  async function launched(kitId) {
    try {
      return (await api('/api/launch/coin/' + encodeURIComponent(kitId))).coin;
    } catch (e) {
      return null;
    }
  }
  /** live market numbers for launched coins: { id: market } (DexScreener, and pump.fun curves read from the chain) */
  async function market(ids) {
    const out = {};
    const list = [...new Set(ids)].filter(Boolean);
    for (let i = 0; i < list.length; i += 30) {
      try {
        Object.assign(out, (await api('/api/coins?market=' + list.slice(i, i + 30).map(encodeURIComponent).join(','))).market || {});
      } catch (e) { /* the numbers stay empty this time */ }
    }
    return out;
  }

  // ---------- small parts ----------
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const t = el('textarea');
      t.value = text;
      t.setAttribute('readonly', '');
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      let done = false;
      try { done = document.execCommand('copy'); } catch (x) { /* nothing more to try */ }
      t.remove();
      return done;
    }
  }
  function copyBtn(text, label, cls) {
    const b = el('button', 'lp-copy' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    const lab = el('span', '', label || 'copy');
    b.append(icon('copy'), lab);
    b.setAttribute('aria-label', `${label || 'copy'}: ${text}`);
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await copyText(text);
      b.classList.add('done');
      b.replaceChild(icon('check'), b.firstChild);
      lab.textContent = 'copied';
      setTimeout(() => {
        b.classList.remove('done');
        b.replaceChild(icon('copy'), b.firstChild);
        lab.textContent = label || 'copy';
      }, 1600);
    });
    return b;
  }
  function outLink(href, text, cls) {
    const a = el('a', cls || 'ls-out');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.append(el('span', '', text), icon('out'));
    return a;
  }
  const img = (src, alt) => {
    const i = new Image();
    i.alt = alt || '';
    i.decoding = 'async';
    if (src) i.src = src;
    return i;
  };
  function chip(text, cls) {
    return el('span', 'ls-chip' + (cls ? ' ' + cls : ''), text);
  }
  const devnetChip = () => chip('devnet test', 'warn');

  // the split as a bar: one part per wallet, ink steps from darkest (the payout wallet)
  const TONES = [100, 46, 74, 60, 86, 34, 54, 26];
  function splitBar(parts, cls) {
    const bar = el('div', 'ls-bar' + (cls ? ' ' + cls : ''));
    bar.setAttribute('role', 'img');
    const total = parts.reduce((a, p) => a + Math.max(0, p.bps || 0), 0) || 1;
    bar.setAttribute('aria-label', 'creator fee split: ' + parts.map((p) => `${p.label} ${fmt.bps(p.bps || 0)}`).join(', '));
    parts.forEach((p, i) => {
      const seg = el('i');
      seg.style.flexGrow = String(Math.max(0, p.bps || 0) / total);
      seg.style.setProperty('--tone', `${p.tone ?? TONES[i % TONES.length]}%`);
      if (p.house) seg.classList.add('house');
      if (!(p.bps > 0)) seg.style.display = 'none';
      bar.appendChild(seg);
    });
    return bar;
  }
  const roleLabel = (s, i) => (s.role === 'creator' ? 'creator' : s.role === 'wagbi' ? B.name : `wallet ${i + 1}`);
  /** the locked split as a bar and a legend (public pages) */
  function splitTable(split, opts = {}) {
    const box = el('div', 'ls-split-pub');
    const parts = split.map((s, i) => ({ label: roleLabel(s, i), bps: s.bps, house: s.role === 'wagbi' }));
    box.appendChild(splitBar(parts));
    const ul = el('ul', 'ls-legend');
    split.forEach((s, i) => {
      const li = el('li');
      const dot = el('i');
      dot.style.setProperty('--tone', `${TONES[i % TONES.length]}%`);
      if (s.role === 'wagbi') dot.classList.add('house');
      const who = el('span', 'who', s.role === 'creator' ? (opts.you ? 'you' : 'creator') : s.role === 'wagbi' ? `${B.name}, fixed` : `wallet ${i + 1}`);
      li.append(dot, who);
      if (s.address) {
        const a = el('code', '', short(s.address));
        a.title = s.address;
        li.appendChild(a);
      }
      li.appendChild(el('b', '', fmt.bps(s.bps)));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }

  // =====================================================================================================
  // the coin's website (api/site.js: wagbi.fun/<slug>), as a live preview: the real page, scaled down
  // =====================================================================================================
  const SITE_W = 1280;
  const SITE_H = 800;
  const siteText = (site) => `${B.domain}${site.path}`;
  const SITE_PATH = /^\/[a-z0-9]{3,32}(?:-[a-z0-9]{1,4})?$/;
  const siteOk = (s) => !!(s && typeof s.path === 'string' && SITE_PATH.test(s.path) && typeof s.url === 'string' && /^https:\/\//.test(s.url));
  const sites = new Map();
  /** A coin's website ({ slug, path, url }) from any of its kit ids, or null. fresh: ask again. */
  function siteOf(id, fresh) {
    if (!fresh && sites.has(id)) return sites.get(id);
    const p = api('/api/site?coin=' + encodeURIComponent(id)).then((j) => (siteOk(j.site) ? j.site : null)).catch(() => {
      sites.delete(id);
      return null;
    });
    sites.set(id, p);
    return p;
  }
  /** A design picked in its chat: the coin's website shows it from now on. Answers the site, or throws. */
  async function pickSite(kitId, key, token) {
    const j = await post('/api/site', { kit: kitId, key: key || undefined, token: token || undefined });
    return siteOk(j.site) ? j.site : null;
  }
  const frameSrc = (site, v) => `${site.path}${v ? `?v=${encodeURIComponent(v)}` : ''}`;
  /** A site from its address (a launch's website link), or null when it isn't one of ours. */
  function siteOfUrl(url) {
    try {
      const u = new URL(String(url || ''));
      const path = u.pathname.replace(/\/+$/, '');
      return u.protocol === 'https:' && !u.search && SITE_PATH.test(path) ? { slug: path.slice(1), path, url: u.origin + path } : null;
    } catch (e) {
      return null;
    }
  }
  /** The website over the page, full size and live; Escape or the close button puts it away. */
  function siteViewer(site, v) {
    const back = document.activeElement;
    const root = el('div', 'sv');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', `${siteText(site)}, full size`);
    const box = el('div', 'sv-box');
    const bar = el('div', 'sv-bar');
    const dots = el('span', 'sv-dots');
    dots.append(el('i'), el('i'), el('i'));
    const addr = el('span', 'sv-addr', siteText(site));
    const open = outLink(site.path, 'open in a new tab', 'sv-open');
    const x = el('button', 'sv-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'close');
    x.appendChild(icon('x'));
    bar.append(dots, addr, open, x);
    const f = document.createElement('iframe');
    f.className = 'sv-frame';
    f.src = frameSrc(site, v);
    f.title = `${siteText(site)}`;
    box.append(bar, f);
    root.appendChild(box);
    const html = document.documentElement.style;
    const was = html.overflow;
    html.overflow = 'hidden';
    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add('in'));
    const close = () => {
      removeEventListener('keydown', onKey, true);
      html.overflow = was;
      root.remove();
      if (back && back.focus) back.focus({ preventScroll: true });
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    addEventListener('keydown', onKey, true);
    x.addEventListener('click', close);
    root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
    x.focus({ preventScroll: true });
  }
  /**
   * The coin's website as a card: its address, copy, open and expand, and the live page scaled down to fit (loaded
   * when it scrolls into view). o: { title, note, version (anything that changes when the site does), compact }.
   */
  function siteCard(site, o = {}) {
    const card = el('section', 'sc' + (o.compact ? ' compact' : ''));
    const top = el('div', 'sc-top');
    const id = el('div', 'sc-id');
    const link = el('a', 'sc-url');
    link.href = site.path;
    link.target = '_blank';
    link.rel = 'noopener';
    link.append(el('span', '', siteText(site)), icon('out'));
    id.append(el('b', '', o.title || "your coin's website"), link);
    const acts = el('div', 'sc-acts');
    const grow = el('button', 'lp-copy');
    grow.type = 'button';
    grow.setAttribute('aria-label', 'expand the website');
    grow.append(icon('expand'), el('span', '', 'expand'));
    grow.addEventListener('click', () => siteViewer(site, o.version));
    acts.append(copyBtn(site.url, 'copy link'), grow);
    top.append(id, acts);
    const frame = el('div', 'sc-frame');
    const f = document.createElement('iframe');
    f.src = frameSrc(site, o.version);
    f.loading = 'lazy';
    f.width = String(SITE_W);
    f.height = String(SITE_H);
    f.tabIndex = -1;
    f.title = `preview of ${siteText(site)}`;
    f.setAttribute('aria-hidden', 'true');
    const hit = el('button', 'sc-hit');
    hit.type = 'button';
    hit.setAttribute('aria-label', `open ${siteText(site)} full size`);
    hit.addEventListener('click', () => siteViewer(site, o.version));
    frame.append(f, hit);
    const fit = () => frame.style.setProperty('--s', String((frame.clientWidth || SITE_W / 2) / SITE_W));
    if (window.ResizeObserver) new ResizeObserver(fit).observe(frame);
    requestAnimationFrame(fit);
    card.append(top, frame);
    if (o.note) card.appendChild(el('p', 'sc-note', o.note));
    return card;
  }
  /** A card that fills in once the coin's website is known (a coin made before sites gets one on the way). */
  function siteCardFor(id, o = {}) {
    const slot = el('div', 'sc-slot');
    siteOf(id, o.fresh).then((site) => {
      if (site && slot.isConnected !== false) slot.replaceWith(siteCard(site, o));
      else slot.remove();
    });
    return slot;
  }

  // =====================================================================================================
  // the launch sheet
  // =====================================================================================================
  const STEPS = [['coin', 'coin'], ['pad', 'launchpad'], ['fees', 'fees'], ['deposit', 'deposit']];

  /**
   * The launch, as a sheet over the page. ctx: { kitId, coinId, name, ticker, bio, logo, banner, saved: { depositId },
   * save(fields), onClose }. Answers a hidden placeholder the caller may place (the sheet itself sits on <body>).
   */
  function open(host, ctx, c) {
    const coinId = ctx.coinId || ctx.kitId;
    const s = {
      step: 'coin',
      name: ctx.name || '', ticker: (ctx.ticker || '').toUpperCase(), bio: ctx.bio || '', x: '',
      art: { kitId: ctx.kitId, logo: ctx.logo, banner: ctx.banner, v: null }, versions: [],
      chain: 'solana', launchpad: 'pumpfun', currency: 'SOL', options: {}, firstBuy: '',
      payout: '', creatorPct: String((10000 - c.fee.bps) / 100), wallets: [],
      quote: null, deposit: null, busy: false, maxStep: 0,
    };
    const placeholder = el('span');
    placeholder.hidden = true;

    // ---- the frame ----
    const root = el('div', 'ls');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'ls-title');
    const sheet = el('div', 'ls-sheet');
    const side = el('aside', 'ls-side');
    const main = el('section', 'ls-main');
    const top = el('div', 'ls-top');
    const stepper = el('ol', 'ls-steps');
    const closeBtn = el('button', 'ls-x');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'close');
    closeBtn.appendChild(icon('x'));
    top.append(stepper, closeBtn);
    const body = el('div', 'ls-body');
    const foot = el('div', 'ls-foot');
    main.append(top, body, foot);
    sheet.append(side, main);
    root.appendChild(sheet);
    document.body.appendChild(root);
    const htmlStyle = document.documentElement.style;
    const oldOverflow = htmlStyle.overflow;
    htmlStyle.overflow = 'hidden';
    requestAnimationFrame(() => root.classList.add('in'));

    let timer = null;
    let alive = true;
    function close() {
      if (!alive) return;
      alive = false;
      removeEventListener('popstate', close);
      clearTimeout(timer);
      clearTimeout(quoteTimer);
      htmlStyle.overflow = oldOverflow;
      root.classList.remove('in');
      root.classList.add('out');
      setTimeout(() => root.remove(), reduce ? 0 : 220);
      placeholder.remove();
      if (ctx.onClose) ctx.onClose();
      if (s.deposit && s.deposit.launch && ['live'].includes(s.deposit.phase)) dispatchEvent(new CustomEvent('wagbi:launched', { detail: { kitId: coinId, mint: s.deposit.launch.mint } }));
    }
    closeBtn.addEventListener('click', close);
    root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
    // the back button moves the page under the sheet: the sheet goes with it (a deposit is saved and resumes)
    addEventListener('popstate', close, { once: true });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') {
        const f = [...root.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), textarea, [tabindex="0"]')].filter((n) => n.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    // ---- the picked launchpad, currency and options ----
    const pads = () => (c.launchpads || []).filter((l) => l.chain === s.chain);
    const padOf = () => (c.launchpads || []).find((l) => l.id === s.launchpad) || null;
    const curOf = () => {
      const pad = padOf();
      return (pad && pad.currencies.find((x) => x.id === s.currency)) || null;
    };
    const optsOf = () => {
      const out = {};
      for (const o of (curOf() || {}).options || []) out[o.id] = s.options[o.id] != null ? s.options[o.id] : o.default;
      return out;
    };
    const splitPad = () => (padOf() || {}).feeModel === 'split';
    const padName = () => (padOf() || { name: 'the launchpad' }).name;
    const factsNow = () => (curOf() && curOf().facts) || (padOf() && padOf().facts) || {};
    const firstBuyOk = () => { const cur = curOf(); return !cur || cur.firstBuy; };
    const maxWallets = () => (curOf() && curOf().maxWallets) || c.maxWallets;
    const toBps = (v) => {
      const n = Number(String(v).replace('%', '').replace(',', '.').trim());
      return String(v).trim() === '' ? NaN : Number.isFinite(n) ? Math.round(n * 100) : NaN;
    };
    const splitSum = () => toBps(s.creatorPct) + c.fee.bps + s.wallets.reduce((a, w) => a + (toBps(w.pct) || 0), 0);
    const buyVal = () => (s.firstBuy.trim() === '' ? 0 : Number(s.firstBuy.replace(',', '.')));

    // the coin's website, which goes into its details (the chip on the card below shows it once it is known)
    let sheetSite = null;
    siteOf(coinId).then((site) => {
      sheetSite = site;
      if (alive && site) updateSide();
    });

    // ---- the side: the coin as the launchpad will show it, and the order ----
    const sideTop = el('div', 'ls-side-top');
    sideTop.appendChild(el('span', 'ls-kicker', 'launching'));
    if (c.cluster === 'devnet') sideTop.appendChild(devnetChip());
    const card = el('div', 'ls-card');
    const cBanner = el('div', 'ls-card-banner');
    const cLogo = el('div', 'ls-card-logo');
    const cName = el('b', 'ls-card-name');
    const cTick = el('span', 'ls-card-tick');
    const cBio = el('p', 'ls-card-bio');
    const cLinks = el('div', 'ls-card-links');
    const cId = el('div', 'ls-card-id');
    cId.append(cName, cTick);
    const cBody = el('div', 'ls-card-body');
    cBody.append(cLogo, cId, cBio, cLinks);
    card.append(cBanner, cBody);
    const sum = el('dl', 'ls-sum');
    const sideFoot = el('p', 'ls-side-foot');
    sideFoot.append(icon('shield'), el('span', '', 'no wallet connection. you send SOL to a one-time address made for this coin.'));
    const mini = el('div', 'ls-mini');
    side.append(sideTop, card, sum, sideFoot, mini);

    function setImg(box, src) {
      if (!src || box.dataset.src === src) return;
      box.dataset.src = src;
      box.textContent = '';
      box.appendChild(img(src));
    }
    function sumRow(k, v, cls) {
      const dt = el('dt', '', k);
      const dd = el('dd', cls || '');
      if (v instanceof Node) dd.appendChild(v);
      else dd.textContent = v;
      sum.append(dt, dd);
      return dd;
    }
    function updateSide() {
      const d = s.deposit;
      const name = d ? d.coin.name : s.name.trim() || 'your coin';
      const ticker = d ? d.coin.ticker : s.ticker || 'TICKER';
      setImg(cBanner, s.art.banner);
      setImg(cLogo, d ? d.coin.imageUrl || s.art.logo : s.art.logo);
      cName.textContent = name;
      cTick.textContent = '$' + ticker;
      cBio.textContent = d ? '' : s.bio.trim();
      cBio.hidden = !cBio.textContent;
      cLinks.textContent = '';
      const xv = cleanX(s.x);
      if (xv) cLinks.appendChild(chip('x.com/' + xv.split('/').pop()));
      cLinks.appendChild(chip(sheetSite ? `${B.domain}${sheetSite.path}` : `${B.domain}/k/${coinId}`));

      sum.textContent = '';
      const pad = d ? { name: d.launchpadName } : padOf();
      const cur = d ? d.currency : s.currency;
      sumRow('launchpad', pad ? pad.name + (cur !== 'SOL' ? ` · ${cur} pair` : '') : '—');
      if (d) {
        sumRow('first buy', d.amounts.firstBuyLamports ? `${fmt.sol(d.amounts.firstBuyLamports)} SOL` : 'none');
      } else if (!firstBuyOk()) {
        sumRow('first buy', `none (${s.currency} pair)`, 'dim');
      } else {
        const v = buyVal();
        const q = s.quote && s.quote.firstBuy;
        sumRow('first buy', v > 0 ? `${trim(v, 4)} SOL${q ? ` · ≈${fmt.supply(q.pctOfSupply)} of supply` : ''}` : 'none');
      }
      const feeModel = d ? d.feeModel : splitPad() ? 'split' : 'creator';
      if (feeModel === 'split') {
        const shares = d ? d.shares : [{ role: 'creator', bps: toBps(s.creatorPct) || 0 }, { role: 'wagbi', bps: c.fee.bps }, ...s.wallets.map((w) => ({ role: 'wallet', bps: toBps(w.pct) || 0 }))];
        const box = el('div', 'ls-sum-split');
        box.appendChild(splitBar(shares.map((x, i) => ({ label: roleLabel(x, i), bps: x.bps, house: x.role === 'wagbi' })), 'thin'));
        const you = shares[0].bps;
        const more = shares.length - 2;
        box.appendChild(el('span', '', `you ${fmt.bps(you)} · ${B.name} ${fmt.bps(c.fee.bps)}${more > 0 ? ` · ${more} more` : ''}`));
        sumRow('creator fees', box);
      } else {
        sumRow('creator fees', `100% yours · ${B.name} 0%`);
      }
      const total = d ? d.amounts.totalLamports : s.quote && s.quote.amounts ? s.quote.amounts.totalLamports : null;
      const tot = el('div', 'ls-sum-total');
      if (d && ['refunded', 'refunding', 'expired'].includes(d.phase)) {
        // what came back, not what was asked (an underpaid deposit sent less)
        const back = (d.returns || []).filter((r) => r.what !== 'leftover').reduce((a, r) => a + r.lamports, 0);
        tot.append(el('span', '', 'came back'), el('b', '', back ? `${fmt.sol(back)} SOL` : d.phase === 'expired' ? 'nothing sent' : '…'));
      } else {
        tot.append(el('span', '', d && d.phase !== 'waiting' ? 'sent' : 'you send'), el('b', '', total ? `${fmt.sol(total)} SOL` : '…'));
      }
      sum.appendChild(tot);

      mini.textContent = '';
      const ml = el('span', 'ls-mini-logo');
      if (s.art.logo) ml.appendChild(img(d ? d.coin.imageUrl || s.art.logo : s.art.logo));
      const mt = el('span', 'ls-mini-text');
      mt.append(el('b', '', name), el('span', '', '$' + ticker));
      mini.append(ml, mt);
      if (total) mini.appendChild(el('span', 'ls-mini-send', `${fmt.sol(total)} SOL`));
    }

    // ---- the stepper ----
    const at = () => Math.max(0, STEPS.findIndex(([k]) => k === s.step));
    function renderSteps() {
      stepper.textContent = '';
      const locked = !!s.deposit;
      const done = s.deposit && s.deposit.phase === 'live';
      STEPS.forEach(([k, label], i) => {
        const li = el('li', 'ls-step' + (done || i < at() ? ' done' : i === at() ? ' now' : ''));
        const b = el('button');
        b.type = 'button';
        b.disabled = locked || i > s.maxStep || i === at();
        b.append(el('i'), el('span', '', label));
        if (i === at() && !done) b.setAttribute('aria-current', 'step');
        b.addEventListener('click', () => go(k));
        li.appendChild(b);
        stepper.appendChild(li);
      });
    }
    function go(step) {
      s.step = step;
      s.maxStep = Math.max(s.maxStep, at());
      render();
      body.scrollTop = 0;
    }

    // ---- shared bits of a step ----
    function head(title, sub) {
      const h = el('div', 'ls-head');
      const h2 = el('h2', 'ls-h', title);
      h2.id = 'ls-title';
      h.appendChild(h2);
      if (sub) h.appendChild(sub instanceof Node ? sub : el('p', 'ls-sub', sub));
      body.appendChild(h);
      return h;
    }
    function section(title, hint) {
      const sec = el('section', 'ls-sec');
      if (title) {
        const t = el('div', 'ls-sec-head');
        t.appendChild(el('h3', '', title));
        if (hint) t.appendChild(hint instanceof Node ? hint : el('span', '', hint));
        sec.appendChild(t);
      }
      body.appendChild(sec);
      return sec;
    }
    const errOf = (input) => {
      const f = input.closest('.ls-field');
      return f && f.querySelector('.ls-field-err');
    };
    function fieldErr(input, text) {
      const e = errOf(input);
      if (e) e.textContent = text || '';
      input.classList.toggle('bad', !!text);
      if (text) input.focus();
      return !text;
    }
    function field(label, input, opts = {}) {
      const f = el('label', 'ls-field' + (opts.cls ? ' ' + opts.cls : ''));
      const top = el('span', 'ls-field-top');
      top.appendChild(el('span', 'ls-label', label));
      if (opts.count) top.appendChild(opts.count);
      f.appendChild(top);
      if (opts.prefix || opts.suffix) {
        const w = el('span', 'ls-affix');
        if (opts.prefix) w.appendChild(el('i', 'pre', opts.prefix));
        w.appendChild(input);
        if (opts.suffix) w.appendChild(el('i', 'suf', opts.suffix));
        if (opts.prefix) w.classList.add('has-pre');
        if (opts.suffix) w.classList.add('has-suf');
        f.appendChild(w);
      } else {
        f.appendChild(input);
      }
      if (opts.hint) f.appendChild(el('span', 'ls-hint', opts.hint));
      f.appendChild(el('span', 'ls-field-err'));
      return f;
    }
    function input(value, attrs = {}) {
      const i = el(attrs.multiline ? 'textarea' : 'input', 'ls-input');
      if (!attrs.multiline) i.type = 'text';
      i.value = value || '';
      for (const [k, v] of Object.entries(attrs)) if (k !== 'multiline') i.setAttribute(k, v);
      i.spellcheck = false;
      i.addEventListener('input', () => {
        i.classList.remove('bad');
        const e = errOf(i);
        if (e) e.textContent = '';
      });
      return i;
    }
    function counter(inputEl, max) {
      const n = el('span', 'ls-count');
      const upd = () => {
        const len = [...inputEl.value].length;
        n.textContent = `${len}/${max}`;
        n.classList.toggle('over', len > max);
      };
      inputEl.addEventListener('input', upd);
      upd();
      return n;
    }
    function nav(back, next, label, opts = {}) {
      foot.textContent = '';
      const left = el('div', 'ls-foot-l');
      if (opts.note) left.appendChild(opts.note instanceof Node ? opts.note : el('span', 'ls-foot-note', opts.note));
      foot.appendChild(left);
      if (back) {
        const b = el('button', 'lp-btn ghost');
        b.type = 'button';
        b.append(icon('back'), el('span', '', 'back'));
        b.addEventListener('click', back);
        foot.appendChild(b);
      }
      if (next) {
        const n = el('button', 'lp-btn');
        n.type = 'button';
        n.append(el('span', '', label || 'continue'));
        if (!opts.noArrow) n.appendChild(icon('next'));
        n.addEventListener('click', next);
        foot.appendChild(n);
        return n;
      }
      return null;
    }
    function cleanX(v) {
      const t = String(v || '').trim().replace(/\?.*$/, '');
      if (!t) return null;
      const m = X_LINK.exec(t) || X_HANDLE.exec(t);
      return m ? `https://x.com/${m[1]}` : undefined;
    }
    function segmented(items, current, onPick, cls) {
      const g = el('div', 'ls-seg' + (cls ? ' ' + cls : ''));
      g.setAttribute('role', 'radiogroup');
      for (const it of items) {
        const b = el('button', 'lp-opt' + (it.id === current ? ' on' : ''));
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(it.id === current));
        b.disabled = !!it.disabled;
        b.appendChild(el('span', '', it.label));
        if (it.tag) b.appendChild(el('em', '', it.tag));
        if (it.title) b.title = it.title;
        b.addEventListener('click', () => onPick(it.id));
        g.appendChild(b);
      }
      return g;
    }

    // ================= 1. the coin =================
    function stepCoin() {
      head('check your coin', 'this is what the launchpad shows: the logo, name, ticker, bio and links. change anything before it goes on chain.');
      if (s.versions.length > 1) {
        const sec = section('logo and banner', `${s.versions.length} versions of this coin`);
        const row = el('div', 'ls-arts');
        for (const v of s.versions) {
          const b = el('button', 'ls-art' + (v.kitId === s.art.kitId ? ' on' : ''));
          b.type = 'button';
          b.setAttribute('aria-pressed', String(v.kitId === s.art.kitId));
          b.setAttribute('aria-label', `use the logo and banner of version ${v.version}`);
          const th = el('span', 'ls-art-logo');
          th.appendChild(img(v.logo));
          b.append(th, el('span', 'ls-art-v', `v${v.version}`));
          if (v.ask) b.title = v.ask;
          b.addEventListener('click', () => {
            s.art = { kitId: v.kitId, logo: v.logo, banner: v.banner, v: v.version };
            render();
          });
          row.appendChild(b);
        }
        sec.appendChild(row);
        sec.appendChild(el('p', 'ls-hint', 'each version made in the chat is here. to change the art itself, close this and ask the chat.'));
      }
      const sec = section(null);
      const grid = el('div', 'ls-grid2');
      const name = input(s.name, { maxlength: '40', 'aria-label': 'name', autocomplete: 'off' });
      const ticker = input(s.ticker, { maxlength: '12', 'aria-label': 'ticker', autocomplete: 'off', autocapitalize: 'characters' });
      const bio = input(s.bio, { multiline: true, rows: '3', 'aria-label': 'bio' });
      const x = input(s.x, { placeholder: 'x.com/yourcoin', 'aria-label': 'x account', autocomplete: 'off', inputmode: 'url' });
      name.addEventListener('input', () => { s.name = name.value; updateSide(); });
      ticker.addEventListener('input', () => {
        const v = ticker.value.replace(/^\$/, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (v !== ticker.value) ticker.value = v;
        s.ticker = v;
        updateSide();
      });
      bio.addEventListener('input', () => { s.bio = bio.value; updateSide(); });
      x.addEventListener('input', () => { s.x = x.value; updateSide(); });
      grid.append(field('name', name, { count: counter(name, 32) }), field('ticker', ticker, { prefix: '$', hint: '2 to 10 letters or numbers' }));
      sec.append(grid, field('bio', bio, { count: counter(bio, 280) }), field('x account', x, { hint: 'optional. the launchpad links to it.' }));
      sec.appendChild(siteCardFor(coinId, { compact: true, version: s.art.kitId, note: "it goes into the coin's details as its website, so the launchpad, DexScreener and every explorer link to it. the contract, chart and buy link show up on it the moment the coin is live." }));
      nav(null, () => {
        if (!s.name.trim()) return fieldErr(name, 'give the coin a name.');
        if ([...s.name.trim()].length > 32) return fieldErr(name, '32 characters at most.');
        if (!/^[A-Z0-9]{2,10}$/.test(s.ticker)) return fieldErr(ticker, 'the ticker is 2 to 10 letters or numbers.');
        if ([...s.bio.trim()].length > 280) return fieldErr(bio, '280 characters at most.');
        if (cleanX(s.x) === undefined) return fieldErr(x, 'paste an x.com profile, like x.com/yourcoin.');
        go('pad');
      });
    }

    // ================= 2. the launchpad =================
    let quoteTimer = null;
    let quoteN = 0;
    async function requote(out) {
      const n = ++quoteN;
      const v = firstBuyOk() ? buyVal() : 0;
      if (!Number.isFinite(v) || v < 0) {
        if (out) out.textContent = 'type an amount of SOL, or leave it empty.';
        return;
      }
      try {
        const q = await post('/api/launch/quote', { firstBuySol: v > 0 && v >= c.firstBuy.minSol && v <= c.firstBuy.maxSol ? v : 0, chain: s.chain, launchpad: s.launchpad, currency: s.currency, options: optsOf() });
        if (n !== quoteN || !alive) return;
        s.quote = q;
        if (out) {
          out.textContent = '';
          if (v > 0 && (v < c.firstBuy.minSol || v > c.firstBuy.maxSol)) out.textContent = `a first buy is ${c.firstBuy.minSol} to ${c.firstBuy.maxSol} SOL.`;
          else if (v > 0 && q.firstBuy) out.append(el('b', '', `≈ ${fmt.supply(q.firstBuy.pctOfSupply)} of the supply`), ` at the opening price. you send ${q.sol} SOL in all.`);
          else if (v > 0) out.textContent = `you send ${q.sol} SOL in all.`;
          else out.textContent = `no first buy. you send ${q.sol} SOL for the network costs.`;
        }
        updateSide();
      } catch (e) {
        if (out && n === quoteN) out.textContent = e.message;
      }
    }
    function padCard(pad) {
      const on = pad.id === s.launchpad;
      const b = el('button', 'lp-opt ls-pad' + (on ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on));
      const h = el('span', 'ls-pad-head');
      h.appendChild(el('b', '', pad.name));
      const tick = el('span', 'ls-pad-tick');
      tick.appendChild(icon('check'));
      h.appendChild(tick);
      b.append(h, el('span', 'ls-pad-blurb', pad.blurb));
      const facts = pad.facts || {};
      const cur = (on ? pad.currencies.find((x) => x.id === s.currency) : null) || pad.currencies.find((x) => x.status === 'live') || pad.currencies[0];
      const dl = el('dl', 'ls-pad-facts');
      const row = (k, v) => dl.append(el('dt', '', k), el('dd', '', v));
      row('creator fees', pad.feeModel === 'split' ? `split by you · ${B.name} ${fmt.bps(c.fee.bps)}` : '100% yours');
      row('first buy', cur && cur.firstBuy ? 'yes, in the launch' : 'no');
      if (facts.graduates) row('graduates to', facts.graduates);
      b.appendChild(dl);
      b.addEventListener('click', () => {
        if (s.launchpad === pad.id) return;
        s.launchpad = pad.id;
        s.options = {};
        const live = pad.currencies.find((x) => x.status === 'live');
        s.currency = live ? live.id : 'SOL';
        render();
        requote();
      });
      return b;
    }
    function stepPad() {
      const chains = c.chains || [{ id: 'solana', name: 'Solana', status: 'live' }];
      const sub = el('div', 'ls-sub-row');
      sub.appendChild(el('p', 'ls-sub', 'where your coin trades first. each launchpad pays the creator fees its own way.'));
      head('pick a launchpad', sub);
      const chainRow = section('blockchain');
      chainRow.appendChild(segmented(chains.map((x) => ({ id: x.id, label: x.name, disabled: x.status !== 'live', tag: x.status !== 'live' ? 'soon' : null })), s.chain, (id) => { s.chain = id; render(); }, 'small'));

      const list = pads();
      if (!list.some((p) => p.id === s.launchpad && p.status === 'live')) {
        const first = list.find((p) => p.status === 'live');
        if (first) { s.launchpad = first.id; s.currency = (first.currencies.find((x) => x.status === 'live') || first.currencies[0]).id; }
      }
      const sec = section('launchpad');
      const grid = el('div', 'ls-pads');
      grid.setAttribute('role', 'radiogroup');
      grid.setAttribute('aria-label', 'launchpad');
      for (const p of list.filter((p) => p.status === 'live')) grid.appendChild(padCard(p));
      sec.appendChild(grid);
      const soon = list.filter((p) => p.status !== 'live');
      if (soon.length) {
        const d = el('details', 'ls-soon');
        const sm = el('summary');
        sm.append(el('span', '', 'not open here yet: '), el('b', '', soon.map((p) => p.name).join(', ')));
        d.appendChild(sm);
        const ul = el('ul');
        for (const p of soon) {
          const li = el('li');
          li.append(el('b', '', p.name), el('span', '', ((p.facts && p.facts.caveat) ? p.facts.caveat + ' ' : '') + (p.why || '')));
          ul.appendChild(li);
        }
        d.appendChild(ul);
        sec.appendChild(d);
      }

      // the picked launchpad's own settings: its currency, its curve
      const pad = padOf();
      const cur = curOf();
      const liveCurs = pad ? pad.currencies : [];
      if (pad && (liveCurs.length > 1 || ((cur && cur.options) || []).length)) {
        const set = section(`${pad.name} settings`);
        const box = el('div', 'ls-box ls-opts');
        if (liveCurs.length > 1) {
          const r = el('div', 'ls-opt-row');
          r.append(el('span', 'ls-label', 'pair'), segmented(liveCurs.map((x) => ({ id: x.id, label: x.id, disabled: x.status !== 'live', tag: x.status !== 'live' ? 'soon' : null, title: x.why || '' })), s.currency, (id) => { s.currency = id; render(); requote(); }));
          box.appendChild(r);
          if (cur && cur.note) box.appendChild(el('p', 'ls-hint', cur.note));
        }
        for (const o of (cur && cur.options) || []) {
          const r = el('div', 'ls-opt-row');
          const now = String(s.options[o.id] != null ? s.options[o.id] : o.default);
          const lab = el('div', 'ls-opt-label');
          lab.appendChild(el('span', 'ls-label', o.label));
          if (o.hint) lab.appendChild(el('span', 'ls-hint', o.hint));
          r.append(lab, segmented((o.choices || []).map((ch) => ({ id: ch.id, label: ch.label })), now, (id) => { s.options[o.id] = id; render(); requote(); }));
          box.appendChild(r);
        }
        set.appendChild(box);
      }

      // the first buy
      const buySec = section('first buy', 'optional');
      const out = el('p', 'ls-quote');
      out.setAttribute('aria-live', 'polite');
      if (firstBuyOk()) {
        const box = el('div', 'ls-box ls-buy');
        const buy = input(s.firstBuy, { inputmode: 'decimal', placeholder: '0', 'aria-label': 'first buy in SOL', autocomplete: 'off' });
        const quick = el('div', 'ls-quick');
        for (const v of ['0', '0.1', '0.5', '1']) {
          const qb = el('button', 'lp-opt' + ((s.firstBuy || '0') === v || (v === '0' && !buyVal()) ? ' on' : ''), v === '0' ? 'none' : `${v} SOL`);
          qb.type = 'button';
          qb.addEventListener('click', () => {
            s.firstBuy = v === '0' ? '' : v;
            buy.value = s.firstBuy;
            quick.querySelectorAll('.lp-opt').forEach((n) => n.classList.toggle('on', n === qb));
            requote(out);
          });
          quick.appendChild(qb);
        }
        buy.addEventListener('input', () => {
          s.firstBuy = buy.value.replace(',', '.');
          quick.querySelectorAll('.lp-opt').forEach((n) => n.classList.remove('on'));
          clearTimeout(quoteTimer);
          quoteTimer = setTimeout(() => requote(out), 320);
        });
        const f = field('SOL', buy, { suffix: 'SOL', cls: 'bare' });
        box.append(f, quick, out);
        box.appendChild(el('p', 'ls-hint', 'you buy in the same transaction that makes the coin, so nobody gets in before you. the coins land in your payout wallet.'));
        buySec.appendChild(box);
      } else {
        s.firstBuy = '';
        const box = el('div', 'ls-box ls-muted');
        box.appendChild(el('p', '', (cur && cur.note) || `${pad ? pad.name : 'this launchpad'} has no first buy here.`));
        buySec.appendChild(box);
        buySec.appendChild(out);
      }
      const type = el('p', 'ls-type');
      type.append(el('span', 'ls-label', 'launch type'), el('span', '', ' public. anyone can buy from the first second. '), el('span', 'ls-dim', `private allocation (invited buyers in the launch block) isn't open yet.`));
      body.appendChild(type);
      requote(out);
      nav(() => go('coin'), () => {
        const cur2 = curOf();
        if (!cur2 || cur2.status !== 'live') return toast((cur2 && cur2.why) || "that launchpad isn't open yet. pick one that is.");
        const v = buyVal();
        if (firstBuyOk() && (!Number.isFinite(v) || v < 0 || (v > 0 && (v < c.firstBuy.minSol || v > c.firstBuy.maxSol)))) return toast(`the first buy can be empty, or ${c.firstBuy.minSol} to ${c.firstBuy.maxSol} SOL.`);
        go('fees');
      });
    }

    // ================= 3. the fees =================
    function walletCheck(inputEl, v, label) {
      if (!ADDR.test(v)) return fieldErr(inputEl, `paste ${label} (a Solana wallet you control, not an exchange).`);
      if (c.fee.wallet && v === c.fee.wallet) return fieldErr(inputEl, `that's ${B.name}'s own fee wallet. use your own.`);
      return true;
    }
    function stepFees() {
      if (!splitPad()) return stepFeesCreator();
      const facts = factsNow();
      const pad = padOf();
      head('split the creator fees', `${pad.name} pays a creator fee on every trade${facts.rate ? `: ${facts.rate}` : ''}. choose who gets it. the split is locked on chain the moment the coin launches.`);
      const max = maxWallets();
      const maxExtra = max - 2;
      const sec = section(null);
      const barHost = el('div', 'ls-split-bar');
      const totalPill = el('span', 'ls-total');
      const rows = el('div', 'ls-rows');
      const add = el('button', 'lp-add');
      add.type = 'button';
      const parts = () => [{ label: 'you', bps: toBps(s.creatorPct) || 0 }, { label: B.name, bps: c.fee.bps, house: true }, ...s.wallets.map((w, i) => ({ label: `wallet ${i + 3}`, bps: toBps(w.pct) || 0 }))];
      function paintTotal() {
        barHost.textContent = '';
        barHost.appendChild(splitBar(parts()));
        const t = splitSum();
        totalPill.className = 'ls-total';
        totalPill.textContent = '';
        if (Number.isNaN(t)) {
          totalPill.classList.add('bad');
          totalPill.textContent = 'check the numbers';
        } else if (t === 10000) {
          totalPill.classList.add('ok');
          totalPill.append(icon('check'), el('span', '', '100%'));
        } else {
          totalPill.classList.add('bad');
          totalPill.textContent = t < 10000 ? `${fmt.bps(t)} · add ${fmt.bps(10000 - t)}` : `${fmt.bps(t)} · ${fmt.bps(t - 10000)} too much`;
        }
        updateSide();
      }
      function row(i, label, opts) {
        const r = el('div', 'ls-row' + (opts.fixed ? ' fixed' : ''));
        const dot = el('i', 'ls-dot');
        dot.style.setProperty('--tone', `${TONES[i % TONES.length]}%`);
        if (opts.fixed) dot.classList.add('house');
        const who = el('div', 'ls-row-who');
        who.append(dot, el('b', '', label));
        if (opts.sub) who.appendChild(el('span', '', opts.sub));
        let addr;
        if (opts.fixed) {
          addr = el('div', 'ls-row-fixed');
          addr.append(icon('lock'), el('span', '', `${B.name}'s fixed cut. it can't be removed or changed.`));
        } else {
          const a = input(opts.addr, { placeholder: 'Solana wallet address', 'aria-label': `${label}: wallet address`, autocomplete: 'off' });
          a.addEventListener('input', () => opts.onAddr(a.value.trim()));
          addr = el('div', 'ls-field ls-row-addr');
          addr.append(a, el('span', 'ls-field-err'));
        }
        let pct;
        if (opts.fixed) {
          pct = el('span', 'ls-pct-fixed', fmt.bps(c.fee.bps));
        } else {
          const p = input(opts.pct, { inputmode: 'decimal', 'aria-label': `${label}: share in percent`, autocomplete: 'off' });
          p.classList.add('ls-pct');
          p.addEventListener('input', () => { opts.onPct(p.value.replace(',', '.')); paintTotal(); });
          pct = el('span', 'ls-affix has-suf ls-pct-box');
          pct.append(p, el('i', 'suf', '%'));
        }
        r.append(who, addr, pct);
        if (opts.remove) {
          const x = el('button', 'ls-rm');
          x.type = 'button';
          x.setAttribute('aria-label', `remove ${label}`);
          x.appendChild(icon('x'));
          x.addEventListener('click', opts.remove);
          r.appendChild(x);
        } else {
          r.appendChild(el('span', 'ls-rm-space'));
        }
        return r;
      }
      function draw() {
        rows.textContent = '';
        rows.appendChild(row(0, 'you', { sub: 'your payout wallet', addr: s.payout, pct: s.creatorPct, onAddr: (v) => (s.payout = v), onPct: (v) => (s.creatorPct = v) }));
        rows.appendChild(row(1, B.name, { fixed: true }));
        s.wallets.forEach((w, i) => {
          rows.appendChild(row(i + 2, `wallet ${i + 3}`, {
            addr: w.address, pct: w.pct, onAddr: (v) => (w.address = v), onPct: (v) => (w.pct = v),
            remove: () => { s.wallets.splice(i, 1); draw(); },
          }));
        });
        if (s.wallets.length > maxExtra) s.wallets.length = maxExtra;
        add.disabled = s.wallets.length >= maxExtra;
        add.textContent = '';
        add.append(icon('plus'), el('span', '', s.wallets.length >= maxExtra ? `${max} wallets is the most a split holds` : `add a wallet (${maxExtra - s.wallets.length} more possible)`));
        paintTotal();
      }
      add.addEventListener('click', () => {
        if (s.wallets.length < maxExtra) s.wallets.push({ address: '', pct: '' });
        draw();
        const last = rows.querySelector('.ls-row:last-child input');
        if (last) last.focus();
      });
      const barRow = el('div', 'ls-split-top');
      barRow.append(barHost, totalPill);
      sec.append(barRow, rows, add);
      const notes = el('ul', 'ls-notes');
      const note = (ic, text) => { const li = el('li'); li.append(icon(ic), el('span', '', text)); notes.appendChild(li); };
      note('lock', `locked at launch. nobody can change the split after, ${B.name} included: pump.fun's fee program allows it to be set once.`);
      if (facts.claim) note('wallet', facts.claim + (facts.paidIn ? ` fees are paid in ${facts.paidIn}.` : ''));
      note('shield', 'your payout wallet (the first row) also gets the first-buy coins and any SOL sent back.');
      sec.appendChild(notes);
      draw();
      nav(() => go('pad'), () => {
        const first = rows.querySelector('.ls-row input');
        if (!walletCheck(first, s.payout, 'your payout wallet')) return;
        const inputs = [...rows.querySelectorAll('.ls-row:not(.fixed)')];
        for (const [i, w] of s.wallets.entries()) {
          const rowEl = inputs[i + 1];
          const [a, p] = rowEl.querySelectorAll('input');
          if (!walletCheck(a, w.address, `wallet ${i + 3}'s address`)) return;
          if (!(toBps(w.pct) > 0)) return fieldErr(p, 'above 0%');
        }
        if (!(toBps(s.creatorPct) > 0)) return fieldErr(rows.querySelectorAll('.ls-row input')[1], 'above 0%');
        const all = [s.payout, ...s.wallets.map((w) => w.address)];
        if (new Set(all).size !== all.length) return toast('the same wallet is in the split twice. each wallet can be in it once.');
        if (splitSum() !== 10000) return toast('the split must add up to exactly 100%.');
        go('deposit');
      });
    }
    function stepFeesCreator() {
      const pad = padOf() || { name: 'this launchpad' };
      const facts = factsNow();
      head('your creator fees', `on ${pad.name} you keep all the creator fees. ${B.name} takes nothing.`);
      const sec = section(null);
      const big = el('div', 'ls-box ls-keep');
      const n = el('div', 'ls-keep-n');
      n.append(el('b', '', '100%'), el('span', '', 'of the creator fees go to your wallet'));
      big.append(n, splitBar([{ label: 'you', bps: 10000 }]));
      const zero = el('p', 'ls-keep-zero');
      zero.append(el('span', '', `${B.name}`), el('b', '', '0%'));
      big.appendChild(zero);
      sec.appendChild(big);
      const dl = el('dl', 'ls-facts');
      const row = (k, v) => { if (v) dl.append(el('dt', '', k), el('dd', '', v)); };
      row('rate', facts.rate);
      row('paid in', facts.paidIn);
      row('how you get them', facts.claim);
      row('after graduation', facts.after);
      row('good to know', facts.caveat);
      if (dl.children.length) sec.appendChild(dl);
      const a = input(s.payout, { placeholder: 'Solana wallet address', 'aria-label': 'your payout wallet', autocomplete: 'off' });
      a.addEventListener('input', () => (s.payout = a.value.trim()));
      const ws = section('your payout wallet');
      ws.appendChild(field('wallet address', a, { hint: 'the creator fees, the first-buy coins and any SOL sent back all go here. a wallet you control, never an exchange.' }));
      nav(() => go('pad'), () => {
        if (!walletCheck(a, s.payout, 'your payout wallet')) return;
        go('deposit');
      });
    }

    // ================= 4. the deposit =================
    async function create(btn) {
      if (s.busy) return;
      s.busy = true;
      btn.disabled = true;
      btn.classList.add('busy');
      btn.firstChild.textContent = 'making your address';
      try {
        const split = splitPad() ? { creatorBps: toBps(s.creatorPct), wallets: s.wallets.map((w) => ({ address: w.address, bps: toBps(w.pct) })) } : {};
        const j = await post('/api/launch', {
          kitId: s.art.kitId || ctx.kitId, chain: s.chain, launchpad: s.launchpad, currency: s.currency, type: 'normal', name: s.name.trim(), ticker: s.ticker, bio: s.bio.trim(), x: cleanX(s.x) || null,
          payout: s.payout, ...split, options: optsOf(),
          firstBuySol: firstBuyOk() ? buyVal() : 0,
        });
        s.deposit = j.deposit;
        if (ctx.save) ctx.save({ depositId: j.deposit.id });
        render();
        poll();
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
        btn.classList.remove('busy');
        btn.firstChild.textContent = 'get the deposit address';
      } finally {
        s.busy = false;
      }
    }
    function receipt(a) {
      const box = el('div', 'ls-box ls-receipt');
      const dl = el('dl');
      const line = (k, v, hint) => {
        const dt = el('dt', '', k);
        if (hint) dt.appendChild(el('span', '', hint));
        dl.append(dt, el('dd', '', v));
      };
      if (a.firstBuyLamports) {
        line('first buy', `${fmt.sol(a.firstBuyLamports)} SOL`);
        line('slippage room', `${fmt.sol(a.firstBuyMaxLamports - a.firstBuyLamports)} SOL`, 'unused, it comes back');
      }
      line('network costs', `${fmt.sol(a.networkLamports)} SOL`, 'accounts, fees and rent to make the coin');
      line('buffer', `${fmt.sol(a.bufferLamports)} SOL`, 'comes back');
      box.appendChild(dl);
      const tot = el('div', 'ls-receipt-total');
      tot.append(el('span', '', 'you send'), el('b', '', `${fmt.sol(a.totalLamports)} SOL`));
      box.appendChild(tot);
      return box;
    }
    function stepDepositBefore() {
      head('send SOL to launch', `no wallet connection. you get a one-time address for this coin and send the exact amount from any wallet.`);
      const sec = section(null);
      if (s.quote && s.quote.amounts) sec.appendChild(receipt(s.quote.amounts));
      else { sec.appendChild(el('div', 'ls-box ls-loading', 'working out the amount')); requote(); }
      const ul = el('ul', 'ls-notes');
      const note = (ic, text) => { const li = el('li'); li.append(icon(ic), el('span', '', text)); ul.appendChild(li); };
      note('wallet', 'send it from a wallet you control. never from an exchange: their transfers can come late or in pieces.');
      note('undo', 'whatever isn\'t spent comes back to your payout wallet when the coin is live.');
      note('shield', 'if the launch fails, everything comes back on its own. nothing is made twice.');
      sec.appendChild(ul);
      const btn = nav(() => go('fees'), () => create(btn), 'get the deposit address', { noArrow: true });
    }

    const PHASE_HEAD = {
      waiting: ['waiting for your SOL', 'send the exact amount to this address. the launch starts by itself the moment it lands.'],
      launching: ['launching', 'your SOL arrived. it takes under a minute, and it keeps going if you close this.'],
    };
    function track(d) {
      const ol = el('ol', 'ls-track');
      const items = [
        ['received', 'SOL received', d.received && d.received.lamports ? `${fmt.sol(d.received.lamports)} of ${d.sol} SOL` : `${d.sol} SOL to the address above`],
        ['create', 'coin made', d.launch || !d.amounts.firstBuyLamports ? `on ${d.launchpadName}` : `on ${d.launchpadName}, with your first buy`],
        ['split', 'fee split locked', 'set once, on chain'],
        ['live', 'live', 'read back from the chain'],
      ];
      for (const [k, label, sub] of items) {
        const st = d.steps[k];
        if (st === 'skip') continue;
        const li = el('li', st || 'wait');
        const dot = el('i');
        if (st === 'done') dot.appendChild(icon('check'));
        const t = el('div');
        t.append(el('b', '', label), el('span', '', sub));
        if (k === 'create' && st === 'done' && d.launch && d.launch.links.createTx) t.appendChild(outLink(d.launch.links.createTx, 'transaction', 'ls-tx'));
        if (k === 'split' && st === 'done' && d.launch && d.launch.links.splitTx) t.appendChild(outLink(d.launch.links.splitTx, 'transaction', 'ls-tx'));
        li.append(dot, t);
        ol.appendChild(li);
      }
      return ol;
    }
    function stepDepositAfter() {
      const d = s.deposit;
      const [title, sub] = PHASE_HEAD[d.phase] || PHASE_HEAD.waiting;
      head(d.phase === 'launching' ? `launching $${d.coin.ticker}` : title, sub);
      const waiting = d.phase === 'waiting';
      if (!waiting) {
        const got = el('div', 'ls-box ls-got');
        const ck = el('span', 'ls-got-check');
        ck.appendChild(icon('check'));
        const t = el('div');
        t.append(el('b', '', `${fmt.sol((d.received && d.received.lamports) || d.amounts.totalLamports)} SOL received`), el('span', '', `at the one-time address ${short(d.address)}`));
        got.append(ck, t);
        body.appendChild(got);
      }
      const pay = el('div', 'ls-pay');
      const qr = el('div', 'ls-qr');
      if (d.qr) qr.appendChild(img(d.qr, 'QR code with the deposit address and the exact amount'));
      const info = el('div', 'ls-pay-info');
      const amt = el('div', 'ls-amount');
      amt.append(el('span', 'ls-label', 'send exactly'));
      const amtRow = el('div', 'ls-amount-row');
      amtRow.append(el('b', '', `${d.sol} SOL`), copyBtn(d.sol, 'copy amount'));
      amt.appendChild(amtRow);
      const addr = el('div', 'ls-address');
      addr.append(el('span', 'ls-label', 'to this address'));
      const code = el('code', '', d.address);
      addr.append(code, copyBtn(d.address, 'copy address'));
      info.append(amt, addr);
      if (waiting && d.payUrl) {
        const w = el('a', 'ls-wallet-link');
        w.href = d.payUrl;
        w.append(icon('wallet'), el('span', '', 'open in a wallet app'));
        info.appendChild(w);
      }
      pay.append(qr, info);
      if (waiting) body.appendChild(pay);

      if (waiting && d.received && d.received.lamports > 0 && d.received.missingLamports > 0) {
        const part = el('div', 'ls-box ls-partial');
        const pct = Math.min(100, (d.received.lamports / d.amounts.totalLamports) * 100);
        const bar = el('div', 'ls-progress');
        const i = el('i');
        i.style.width = pct + '%';
        bar.appendChild(i);
        part.append(el('p', '', `${fmt.sol(d.received.lamports)} SOL arrived. send ${fmt.sol(d.received.missingLamports)} SOL more to the same address.`), bar);
        body.appendChild(part);
      }
      const sec = section('status');
      sec.appendChild(track(d));
      if (d.problem) sec.appendChild(el('p', 'ls-problem', d.problem));
      if (waiting) {
        const exp = el('p', 'ls-hint ls-exp');
        exp.append(icon('clock'), el('span', '', `this address stays open until ${fmt.when(d.abandonAt)}. if the launch doesn't happen by then, anything sent comes back.`));
        sec.appendChild(exp);
      }
      if (waiting && d.refund && d.refund.available) {
        const b = el('button', 'lp-btn ghost ls-refund');
        b.type = 'button';
        b.append(icon('undo'), el('span', '', 'send my SOL back'));
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            s.deposit = { ...(await post(`/api/launch/${d.id}/refund`, {})).deposit, qr: d.qr };
            render();
            poll();
          } catch (e) {
            toast(e.message);
            b.disabled = false;
          }
        });
        sec.appendChild(b);
      } else if (waiting && d.received && d.received.lamports > 0 && d.refund && d.refund.from) {
        sec.appendChild(el('p', 'ls-hint', `changed your mind? you can ask for it back from ${fmt.when(d.refund.from)}.`));
      } else if (waiting && d.received && d.received.lamports === 0) {
        // nothing sent yet (the chain says so: an unread balance never counts as empty): the launchpad, the split or
        // the words can still change (a fresh address is made). The old address stays open until it expires, so it
        // says not to use it.
        const b = el('button', 'lp-btn ghost ls-refund');
        b.type = 'button';
        b.append(icon('back'), el('span', '', 'change something first'));
        b.addEventListener('click', () => {
          if (!b.dataset.sure) {
            b.dataset.sure = '1';
            b.lastChild.textContent = "sure? don't send to this address after";
            return;
          }
          s.deposit = null;
          if (ctx.save) ctx.save({ depositId: null });
          s.step = 'coin';
          s.maxStep = 3;
          clearTimeout(timer);
          render();
          toast("start again from here. don't send anything to the old address.");
        });
        sec.appendChild(b);
      }
      nav(null, close, 'close', { noArrow: true, note: waiting ? 'you can close this. the address stays open and the launch starts when the SOL lands.' : 'it keeps going if you close this.' });
      foot.querySelector('.lp-btn').classList.add('ghost');
    }

    // ================= 5. live =================
    function shareUrl(d) {
      const text = `$${d.coin.ticker} is live on ${d.launchpadName}.\n\nCA: ${d.launch.mint}`;
      return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(d.launch.links.coin || `${location.origin}/k/${coinId}`)}`;
    }
    function stepLive() {
      const d = s.deposit;
      const h = el('div', 'ls-live-head');
      const badge = el('span', 'ls-live-badge');
      badge.appendChild(icon('check'));
      h.append(badge);
      body.appendChild(h);
      head(`$${d.coin.ticker} is live`, `on ${d.launchpadName}${d.currency !== 'SOL' ? ` (${d.currency} pair)` : ''}${d.cluster === 'devnet' ? ', on devnet' : ''}. it's on chain and trading.`);
      const ca = el('div', 'ls-ca');
      const caTop = el('div', 'ls-ca-top');
      caTop.append(el('span', 'ls-label', 'contract address'), copyBtn(d.launch.mint, 'copy', 'solid'));
      ca.append(caTop, el('code', '', d.launch.mint));
      body.appendChild(ca);
      const acts = el('div', 'ls-acts');
      const act = (href, label, ic, primary) => {
        const a = el('a', 'ls-act' + (primary ? ' primary' : ''));
        a.href = href;
        if (/^https?:/.test(href) && !href.startsWith(location.origin)) { a.target = '_blank'; a.rel = 'noopener'; }
        a.append(icon(ic), el('span', '', label));
        acts.appendChild(a);
      };
      const L = d.launch.links;
      const site = siteOfUrl(L.coin);
      if (L.pad) act(L.pad.url, L.pad.label, 'out', true);
      if (L.chart) act(L.chart, 'chart', 'chart');
      act(L.mint, 'explorer', 'globe');
      if (site) act(site.path, 'website', 'globe');
      act(`/k/${coinId}`, `${B.name} page`, 'next');
      body.appendChild(acts);
      body.appendChild(site ? siteCard(site, { title: "your coin's website is live", version: d.launch.mint }) : siteCardFor(coinId, { title: "your coin's website is live", version: d.launch.mint, fresh: true }));
      const share = el('a', 'ls-share');
      share.href = shareUrl(d);
      share.target = '_blank';
      share.rel = 'noopener';
      share.append(el('span', '', 'share it on X'), icon('out'));
      body.appendChild(share);
      const fees = section(d.feeModel === 'split' ? 'creator fee split' : 'creator fees', d.feeModel === 'split' ? lockedChip(L.splitTx) : null);
      if (d.feeModel === 'split') fees.appendChild(splitTable(d.shares, { you: true }));
      else fees.appendChild(el('p', 'ls-line', `100% go to your wallet ${short(d.payout)}. ${B.name} takes nothing.${d.facts && d.facts.claim ? ' ' + d.facts.claim : ''}`));
      for (const r of d.returns || []) {
        const p = el('p', 'ls-line ls-return');
        p.append(icon('undo'), el('span', '', `${fmt.sol(r.lamports)} SOL ${r.what === 'leftover' ? 'left over came' : 'came'} back to ${short(r.to)}.`));
        if (r.tx) p.appendChild(outLink(r.tx, 'transaction', 'ls-tx'));
        fees.appendChild(p);
      }
      nav(null, close, 'done', { noArrow: true });
    }
    function lockedChip(tx) {
      const w = el('span', 'ls-locked');
      w.append(icon('lock'), el('span', '', 'locked on chain'));
      if (tx) {
        const a = outLink(tx, 'proof', 'ls-tx');
        w.appendChild(a);
      }
      return w;
    }

    // ================= the ends: refunded, failed, expired =================
    function stepEnd() {
      const d = s.deposit;
      const failed = !!d.problem && d.steps.create === 'fail';
      const back = (d.returns || []).filter((r) => r.what !== 'leftover');
      const h = el('div', 'ls-live-head');
      const badge = el('span', 'ls-live-badge muted');
      badge.appendChild(icon(d.phase === 'expired' ? 'clock' : 'undo'));
      h.appendChild(badge);
      body.appendChild(h);
      // the server's words are written while the SOL is still on its way; once it is back, say so
      const said = d.problem && d.phase === 'refunded' ? d.problem.replace(/is on its way back\.?$/, 'came back.') : d.problem;
      if (d.phase === 'expired') head('this address closed', "nothing arrived in 24 hours, so it closed. start again whenever you're ready.");
      else if (d.phase === 'refunding') head('sending your SOL back', said || 'the refund is on its way to your payout wallet.');
      else head(failed ? "the launch didn't go through" : 'your SOL is back', said || 'everything you sent went back to your payout wallet.');
      const sec = section(null);
      if (d.phase === 'refunding') sec.appendChild(el('p', 'ls-loading', `sending it to ${short(d.payout)} now. this takes a few seconds.`));
      if (back.length) {
        for (const r of back) {
          const p = el('div', 'ls-box ls-back');
          const t = el('div');
          t.append(el('b', '', `${fmt.sol(r.lamports)} SOL`), el('span', '', `back to ${short(r.to)}`));
          p.append(icon('undo'), t);
          if (r.tx) p.appendChild(outLink(r.tx, 'transaction', 'ls-tx'));
          sec.appendChild(p);
        }
      }
      if (d.phase !== 'refunding') sec.appendChild(el('p', 'ls-hint', 'the coin is still yours to launch. starting over makes a fresh address.'));
      foot.textContent = '';
      const left = el('div', 'ls-foot-l');
      foot.appendChild(left);
      const closeB = el('button', 'lp-btn ghost', 'close');
      closeB.type = 'button';
      closeB.addEventListener('click', close);
      foot.appendChild(closeB);
      if (d.phase !== 'refunding') {
        const again = el('button', 'lp-btn', 'start over');
        again.type = 'button';
        again.addEventListener('click', () => {
          s.deposit = null;
          if (ctx.save) ctx.save({ depositId: null });
          s.step = 'deposit';
          s.maxStep = 3;
          render();
        });
        foot.appendChild(again);
      }
    }

    // ================= a short message at the foot =================
    let toastT = null;
    function toast(text) {
      let t = root.querySelector('.ls-toast');
      if (!t) {
        t = el('div', 'ls-toast');
        t.setAttribute('role', 'alert');
        main.appendChild(t);
      }
      t.textContent = text;
      t.classList.add('on');
      clearTimeout(toastT);
      toastT = setTimeout(() => t.classList.remove('on'), 4200);
    }

    function render() {
      body.textContent = '';
      const d = s.deposit;
      let view;
      if (d && d.phase === 'live' && d.launch) view = stepLive;
      else if (d && ['refunded', 'expired', 'refunding'].includes(d.phase)) view = stepEnd;
      else if (d) { s.step = 'deposit'; view = stepDepositAfter; }
      else view = { coin: stepCoin, pad: stepPad, fees: stepFees, deposit: stepDepositBefore }[s.step] || stepCoin;
      if (d) s.step = 'deposit';
      sheet.dataset.view = view === stepLive ? 'live' : view === stepEnd ? 'end' : s.step;
      renderSteps();
      view();
      updateSide();
    }

    async function poll() {
      clearTimeout(timer);
      if (!alive || !s.deposit) return;
      const done = ['refunded', 'expired'].includes(s.deposit.phase) || (s.deposit.phase === 'live' && (s.deposit.returns || []).length);
      if (done) return;
      timer = setTimeout(async () => {
        if (!alive) return;
        try {
          const j = await api(`/api/launch/${s.deposit.id}`);
          const key = (x) => JSON.stringify([x.phase, x.steps, x.received, x.returns, x.problem, x.refund, x.launch]);
          const changed = key(j.deposit) !== key(s.deposit);
          s.deposit = { ...j.deposit, qr: s.deposit.qr };
          if (changed) render();
        } catch (e) { /* a missed poll: the next one tries again */ }
        poll();
      }, s.deposit.phase === 'waiting' ? 3500 : 2200);
    }

    // the coin's versions (their art) and a deposit made earlier in this browser
    (async () => {
      body.appendChild(el('div', 'ls-loading', 'one moment'));
      renderSteps();
      updateSide();
      const jobs = [];
      jobs.push((async () => {
        try {
          const r = await fetch('/api/kit/' + encodeURIComponent(coinId) + '?versions=1');
          const j = r.ok ? await r.json() : null;
          const vs = (j && j.versions) || [];
          if (vs.length > 1) {
            const kits = await Promise.all(vs.slice(-8).map((v) => fetch('/api/kit/' + encodeURIComponent(v.kitId)).then((x) => (x.ok ? x.json() : null)).catch(() => null)));
            s.versions = kits.filter((k) => k && k.kit).map((k) => ({ version: k.kit.version || 1, kitId: k.kit.id, logo: k.kit.logo, banner: k.kit.banner, ask: k.kit.ask }));
            const cur = s.versions.find((v) => v.kitId === s.art.kitId);
            if (cur) s.art.v = cur.version;
          }
        } catch (e) { /* one version shown */ }
      })());
      if (ctx.saved && ctx.saved.depositId) {
        jobs.push((async () => {
          try {
            const j = await api(`/api/launch/${ctx.saved.depositId}?qr=1`);
            s.deposit = j.deposit;
          } catch (e) { /* gone: start over */ }
        })());
      }
      await Promise.all(jobs);
      if (!alive) return;
      render();
      if (s.deposit) poll();
      else requote();
      const f = root.querySelector('.ls-body input, .ls-foot .lp-btn');
      if (f && matchMedia('(hover: hover)').matches) f.focus({ preventScroll: true });
    })();
    return placeholder;
  }

  // =====================================================================================================
  // public: the live box (a launched coin: market, contract, links, fees) and the coin's page
  // =====================================================================================================
  const stat = (label, value, cls) => {
    const d = el('div', 'ls-stat' + (cls ? ' ' + cls : ''));
    d.append(el('span', 'ls-label', label), el('b', '', value == null ? '—' : value));
    return d;
  };
  /** the four numbers of a launched coin from its market answer (null: none yet) */
  function statNumbers(m, cluster) {
    const curve = m && m.curve;
    const q = curve && curve.quote;
    const mcap = m && fmt.usd(m.mcapUsd) || (curve && ok(curve.mcap) ? `${fmt.compact(curve.mcap)} ${q}` : null);
    const price = m && fmt.price(m.priceUsd, '$') || (curve && ok(curve.price) ? fmt.price(curve.price, q) : null);
    const vol = m && fmt.usd(m.volume24hUsd);
    const chg = m && fmt.pct(m.change24hPct);
    const prog = curve ? (curve.complete ? 'graduated' : ok(curve.progressPct) ? `${trim(curve.progressPct, 1)}%` : null) : null;
    void cluster;
    return { mcap, price, vol, chg, prog, change: m && m.change24hPct };
  }
  function statsRow(coin, m) {
    const row = el('div', 'ls-stats');
    const n = statNumbers(m, coin.cluster);
    row.appendChild(stat('market cap', n.mcap));
    row.appendChild(stat('24h volume', n.vol));
    const ch = stat('24h change', n.chg);
    if (ok(n.change)) ch.classList.add(n.change >= 0 ? 'up' : 'down');
    row.appendChild(ch);
    if (n.prog) row.appendChild(stat('bonding curve', n.prog));
    else row.appendChild(stat('price', n.price));
    return row;
  }
  function sourceLine(m, cluster, launchpad) {
    const p = el('p', 'ls-source');
    if (!m || !m.source) {
      const pump = (launchpad || 'pumpfun') === 'pumpfun';
      p.textContent = cluster !== 'devnet'
        ? 'no market data yet. a new coin shows up on DexScreener within a minute or two.'
        : pump ? "the chain didn't answer this time. it tries again in 30 seconds." : 'devnet has no market data for this launchpad. on mainnet these numbers come from DexScreener.';
      return p;
    }
    p.textContent = m.source === 'dexscreener'
      ? `market data from DexScreener${m.curve ? ', bonding curve read from the chain' : ''}. updates every 30 seconds.`
      : `read straight from the ${cluster === 'devnet' ? 'devnet ' : ''}chain (the coin's bonding curve). updates every 30 seconds.`;
    return p;
  }

  /** The box under a launched coin (its chat and its page): live numbers, the contract, the links, the fees. */
  function liveBox(coin, opts = {}) {
    const box = el('section', 'lp ls-live-box');
    const top = el('div', 'ls-lb-top');
    const status = el('span', 'ls-live-chip');
    status.append(el('i'), el('span', '', `live on ${coin.launchpadName || 'pump.fun'}${coin.currency && coin.currency !== 'SOL' ? ` · ${coin.currency} pair` : ''}`));
    top.appendChild(status);
    if (coin.cluster === 'devnet') top.appendChild(devnetChip());
    if (coin.launchedAt) top.appendChild(el('span', 'ls-lb-when', `launched ${fmt.ago(coin.launchedAt)}`));
    box.appendChild(top);

    const statsHost = el('div', 'ls-lb-stats');
    statsHost.appendChild(statsRow(coin, null));
    const src = el('div');
    statsHost.appendChild(src);
    box.appendChild(statsHost);

    const ca = el('div', 'ls-ca compact');
    const caTop = el('div', 'ls-ca-top');
    caTop.append(el('span', 'ls-label', 'contract address'), copyBtn(coin.mint, 'copy', 'solid'));
    ca.append(caTop, el('code', '', coin.mint));
    box.appendChild(ca);

    const links = el('div', 'ls-acts row');
    const L = coin.links || {};
    const act = (href, label, ic, primary) => {
      if (!href) return;
      const a = el('a', 'ls-act' + (primary ? ' primary' : ''));
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.append(icon(ic), el('span', '', label));
      links.appendChild(a);
    };
    if (L.pad) act(L.pad.url, L.pad.label, 'out', true);
    act(L.chart, 'chart', 'chart');
    act(L.mint, 'explorer', 'globe');
    if (coin.x) act(coin.x, 'x', 'out');
    box.appendChild(links);

    const feeModel = coin.feeModel || 'split';
    const fees = el('div', 'ls-lb-fees');
    const fh = el('div', 'ls-sec-head');
    fh.appendChild(el('h3', '', feeModel === 'split' ? 'creator fee split' : 'creator fees'));
    if (feeModel === 'split' && coin.splitLocked !== false) {
      const w = el('span', 'ls-locked');
      w.append(icon('lock'), el('span', '', 'locked on chain at launch'));
      if (L.splitTx) w.appendChild(outLink(L.splitTx, 'proof', 'ls-tx'));
      fh.appendChild(w);
    }
    fees.appendChild(fh);
    if (feeModel === 'split') fees.appendChild(splitTable(coin.split || []));
    else {
      const p = el('p', 'ls-line');
      p.textContent = `100% to the creator's wallet ${short(coin.payout)}. ${B.name} takes nothing.`;
      fees.appendChild(p);
    }
    const f = coin.facts || {};
    const dl = el('dl', 'ls-facts small');
    const row = (k, v) => { if (v) dl.append(el('dt', '', k), el('dd', '', v)); };
    row('rate', f.rate);
    row('paid in', f.paidIn);
    row('how it pays', f.claim);
    row('after graduation', f.after);
    if (dl.children.length) fees.appendChild(dl);
    box.appendChild(fees);

    const meta = el('p', 'ls-lb-meta');
    const bits = [];
    if (coin.launchedAt) bits.push(`launched ${fmt.when(coin.launchedAt)}`);
    bits.push(coin.firstBuyLamports ? `creator's first buy ${fmt.sol(coin.firstBuyLamports)} SOL, in the launch transaction` : 'no first buy');
    bits.push(coin.allocation && coin.allocation.length ? `${coin.allocation.length} allocation buyers` : 'no other wallet bought in the launch block');
    meta.textContent = bits.join(' · ') + '. ';
    if (L.createTx) meta.appendChild(outLink(L.createTx, 'launch transaction', 'ls-tx'));
    box.appendChild(meta);

    // the numbers: now, then every 30 seconds while the box is on screen
    const id = coin.kitId;
    let t = null;
    const load = async () => {
      if (!box.isConnected && t !== null) return;
      const m = (await market([id]))[id] || null;
      statsHost.textContent = '';
      statsHost.append(statsRow(coin, m), sourceLine(m, coin.cluster, coin.launchpad));
      if (m && m.chart && L.chart !== m.chart) {
        const a = links.querySelector('a[href="' + (L.chart || '') + '"]');
        if (a) a.href = m.chart;
        L.chart = m.chart;
      }
      t = setTimeout(() => { if (box.isConnected && document.visibilityState !== 'hidden') load(); else if (box.isConnected) t = setTimeout(load, 30000); }, 30000);
    };
    void opts;
    setTimeout(load, 0);
    return box;
  }

  /** the coin's page data: its first kit, its versions, the version it launched with (or the latest) and its launch */
  async function coinPage(host, kitId) {
    let j = null;
    try {
      const r = await fetch('/api/kit/' + encodeURIComponent(kitId) + '?versions=1');
      if (r.ok) j = await r.json();
    } catch (e) { /* shown below */ }
    if (!j || !j.kit) return null;
    const coin = await launched(j.kit.root || kitId);
    let kit = j.latest || j.kit;
    if (coin && coin.versionId && coin.versionId !== kit.id) {
      try {
        const r = await fetch('/api/kit/' + encodeURIComponent(coin.versionId));
        if (r.ok) kit = (await r.json()).kit || kit;
      } catch (e) { /* the latest stands in */ }
    }
    return { kit, first: j.kit, versions: j.versions || [], coin, wrap: host };
  }

  /** This browser's own chat for a coin (app.js keeps them in localStorage), so its maker can launch from its page. */
  function myChatFor(coinId) {
    try {
      const list = JSON.parse(localStorage.getItem(`${B.id || 'wagbi'}.coins.v1`) || '[]');
      const rec = Array.isArray(list) && list.find((r) => r && typeof r.id === 'string' && (r.kit === coinId || (Array.isArray(r.turns) && r.turns.some((t) => t && t.kit === coinId))));
      return rec && /^[\w-]{1,40}$/.test(rec.id) ? rec.id : null;
    } catch (e) {
      return null;
    }
  }

  /** The coin's public page (/k/<id>) into host. Answers the kit shown (or null). */
  async function kitPage(host, kitId, o = {}) {
    const alive = o.alive || (() => true);
    host.textContent = '';
    const page = el('article', 'kp');
    const sk = el('div', 'kp-skel');
    sk.append(el('div', 'kp-skel-banner'), el('div', 'kp-skel-line'), el('div', 'kp-skel-line short'));
    page.appendChild(sk);
    host.appendChild(page);
    const p = await coinPage(host, kitId);
    if (!alive()) return null;
    page.textContent = '';
    if (!p) {
      const empty = el('div', 'kp-empty');
      empty.append(el('b', '', 'this coin is not here.'), el('span', '', `make your own below: one sentence is all it takes.`));
      page.appendChild(empty);
      return null;
    }
    const { kit, first, versions, coin } = p;
    const hero = el('div', 'kp-hero');
    const banner = el('div', 'kp-banner');
    if (kit.banner) banner.appendChild(img(kit.banner));
    const logo = el('div', 'kp-logo');
    if (coin ? coin.image || kit.logo : kit.logo) logo.appendChild(img(coin ? coin.image || kit.logo : kit.logo, `${kit.name}'s logo`));
    hero.append(banner, logo);
    const idRow = el('div', 'kp-id');
    const nameBox = el('div', 'kp-name');
    nameBox.append(el('h1', '', coin ? coin.name : kit.name), el('span', 'kp-tick', '$' + (coin ? coin.ticker : kit.ticker)));
    idRow.appendChild(nameBox);
    const state = el('span', coin ? 'ls-live-chip' : 'ls-chip');
    if (coin) state.append(el('i'), el('span', '', 'live'));
    else state.textContent = 'not launched yet';
    idRow.appendChild(state);
    const bio = el('p', 'kp-bio', coin ? coin.bio || kit.bio : kit.bio);
    const origin = el('p', 'kp-origin');
    origin.append(`made on ${B.name} from one sentence: `, el('q', '', first.sentence || kit.sentence));
    if (versions.length > 1) origin.append(` · version ${kit.version || 1} of ${versions.length}`);
    const card = el('div', 'kp-card');
    const cb = el('div', 'kp-card-body');
    cb.append(idRow, bio, origin);
    card.append(hero, cb);
    page.appendChild(card);
    page.appendChild(siteCardFor(first.root || first.id, { title: coin ? `${coin.name}'s website` : `${kit.name}'s website`, version: coin ? coin.mint : kit.id }));
    if (coin) {
      page.appendChild(liveBox(coin));
    } else {
      const nl = el('div', 'kp-notyet');
      const t = el('div');
      t.append(el('b', '', 'not launched yet'), el('span', '', `it launches from its chat on ${B.name}. when it does, its contract, live market and fee split show here.`));
      nl.appendChild(t);
      const mine = myChatFor(first.root || first.id);
      if (mine) {
        const a = el('a', 'lp-btn');
        a.href = '/coin/' + mine;
        a.append(el('span', '', 'launch it'), icon('next'));
        nl.appendChild(a);
      }
      page.appendChild(nl);
    }
    return kit;
  }

  // =====================================================================================================
  // the coins tab: launched coins first (with live numbers), then every coin made and not launched
  // =====================================================================================================
  const coinsState = { data: null, loading: false, at: 0, market: {}, more: { made: false, launched: false }, timer: null };
  function launchedRow(cn) {
    const li = el('li', 'cl-row');
    const a = el('a', 'cl-link');
    a.href = '/k/' + cn.id;
    a.setAttribute('aria-label', `${cn.name}, $${cn.ticker}, launched on ${cn.launch.launchpadName}`);
    const coin = el('div', 'cl-coin');
    const logo = el('span', 'cl-logo');
    if (cn.logo) logo.appendChild(img(cn.logo));
    const id = el('span', 'cl-id');
    const nm = el('b', '', cn.name);
    id.append(nm, el('span', '', '$' + cn.ticker));
    coin.append(logo, id);
    if (cn.launch.at && Date.now() - Date.parse(cn.launch.at) < 3600_000) coin.appendChild(chip('new', 'ink'));
    const pad = el('div', 'cl-pad');
    pad.append(el('span', '', cn.launch.launchpadName), el('small', '', fmt.ago(cn.launch.at)));
    const m = coinsState.market[cn.id];
    const n = statNumbers(m);
    const cell = (v, cls) => el('div', 'cl-num' + (cls ? ' ' + cls : ''), v == null ? '—' : v);
    const chg = cell(n.chg, 'chg' + (ok(n.change) ? (n.change >= 0 ? ' up' : ' down') : ''));
    const ca = el('div', 'cl-ca');
    const code = el('code', '', short(cn.launch.mint));
    code.title = cn.launch.mint;
    ca.append(code, copyBtn(cn.launch.mint, 'copy', 'icon'));
    const links = el('div', 'cl-links');
    const L = cn.launch.links || {};
    const lk = (href, label) => {
      if (!href) return;
      const x = el('a', 'cl-out', label);
      x.href = href;
      x.target = '_blank';
      x.rel = 'noopener';
      x.appendChild(icon('out'));
      links.appendChild(x);
    };
    if (siteOk(cn.site)) {
      const w = el('a', 'cl-out cl-site');
      w.href = cn.site.path;
      w.target = '_blank';
      w.rel = 'noopener';
      w.title = `${B.domain}${cn.site.path}`;
      w.setAttribute('aria-label', `${cn.name}'s website`);
      w.appendChild(icon('globe'));
      links.appendChild(w);
    }
    lk(L.pad && L.pad.url, L.pad ? L.pad.label.replace(/^open on /, '') : '');
    lk((m && m.chart) || L.chart, 'chart');
    if (!L.pad && !L.chart) lk(L.explorer, 'explorer');
    li.append(a, coin, pad, cell(n.mcap, 'mcap'), cell(n.vol, 'vol'), chg, cell(n.prog, 'prog'), ca, links);
    return li;
  }
  function madeCard(cn) {
    // the card opens the coin's page; its website link sits above that (a link can't hold a link)
    const card = el('div', 'cm-card');
    const a = el('a', 'cl-link');
    a.href = '/k/' + cn.id;
    a.setAttribute('aria-label', `${cn.name}, $${cn.ticker}, made from: ${cn.sentence}`);
    const logo = el('span', 'cm-logo');
    if (cn.logo) logo.appendChild(img(cn.logo));
    const id = el('span', 'cm-id');
    id.append(el('b', '', cn.name), el('span', '', '$' + cn.ticker));
    const q = el('span', 'cm-q', cn.sentence);
    const meta = el('span', 'cm-meta');
    meta.append(el('span', '', fmt.ago(cn.made) + (cn.versions > 1 ? ` · ${cn.versions} versions` : '')));
    if (siteOk(cn.site)) {
      const w = el('a', 'cm-site');
      w.href = cn.site.path;
      w.target = '_blank';
      w.rel = 'noopener';
      w.title = `${cn.name}'s website`;
      w.append(icon('globe'), el('span', '', `${B.domain}${cn.site.path}`));
      meta.appendChild(w);
    }
    card.append(a, logo, id, q, meta);
    return card;
  }
  function drawCoins(host) {
    const d = coinsState.data;
    host.textContent = '';
    if (!d) {
      const sk = el('div', 'cl-skel');
      for (let i = 0; i < 4; i++) sk.appendChild(el('i'));
      host.appendChild(sk);
      return;
    }
    // launched
    const ls = el('section', 'cl-sec');
    const lh = el('div', 'cl-head');
    const lt = el('h3', '', 'launched');
    lt.appendChild(el('span', 'cl-count', String(d.launched.length) + (d.launchedNext ? '+' : '')));
    lh.appendChild(lt);
    if (d.cluster === 'devnet') lh.appendChild(chip('devnet test: these launched on Solana devnet', 'warn'));
    lh.appendChild(el('span', 'cl-src', d.cluster === 'devnet' ? 'devnet numbers: pump.fun curves, read from the chain' : 'live numbers from DexScreener and the chain'));
    ls.appendChild(lh);
    if (d.launched.length) {
      const table = el('ul', 'coins-list cl-table');
      const hd = el('li', 'cl-row cl-th');
      hd.setAttribute('aria-hidden', 'true');
      ['coin', 'launchpad', 'market cap', '24h volume', '24h', 'curve', 'contract', ''].forEach((t, i) => hd.appendChild(el('div', ['cl-coin', 'cl-pad', 'cl-num mcap', 'cl-num vol', 'cl-num chg', 'cl-num prog', 'cl-ca', 'cl-links'][i], t)));
      table.appendChild(hd);
      d.launched.forEach((cn) => table.appendChild(launchedRow(cn)));
      ls.appendChild(table);
      if (d.launchedNext) {
        const more = el('button', 'lp-btn ghost cl-more', 'show more launched coins');
        more.type = 'button';
        more.addEventListener('click', () => loadCoins(host, 'launched'));
        ls.appendChild(more);
      }
    } else {
      const e = el('div', 'cl-empty');
      e.append(el('b', '', 'no coins launched yet.'), el('span', '', `make one, then launch it from its chat. it shows up here the moment it's live.`));
      ls.appendChild(e);
    }
    host.appendChild(ls);
    // made, not launched
    const ms = el('section', 'cl-sec');
    const mh = el('div', 'cl-head');
    const mt = el('h3', '', 'made, not launched yet');
    mt.appendChild(el('span', 'cl-count', String(d.coins.length) + (d.next ? '+' : '')));
    mh.appendChild(mt);
    ms.appendChild(mh);
    if (d.coins.length) {
      const grid = el('div', 'cm-grid');
      d.coins.forEach((cn) => grid.appendChild(madeCard(cn)));
      ms.appendChild(grid);
    } else {
      ms.appendChild(el('div', 'cl-empty', 'no coins here yet. make the first one.'));
    }
    if (d.next) {
      const more = el('button', 'lp-btn ghost cl-more', 'show more');
      more.type = 'button';
      more.addEventListener('click', () => loadCoins(host, 'made'));
      ms.appendChild(more);
    }
    host.appendChild(ms);
  }
  async function loadMarket(host) {
    const d = coinsState.data;
    if (!d || !d.launched.length) return;
    const m = await market(d.launched.map((x) => x.id));
    Object.assign(coinsState.market, m);
    if (host.isConnected) drawCoins(host);
  }
  async function loadCoins(host, more) {
    if (coinsState.loading) return;
    coinsState.loading = true;
    try {
      const d = coinsState.data;
      let q = '';
      if (more === 'made' && d && d.next) q = '?before=' + encodeURIComponent(d.next) + '&ln=1';
      if (more === 'launched' && d && d.launchedNext) q = '?only=launched&lbefore=' + encodeURIComponent(d.launchedNext);
      const j = await api('/api/coins' + q);
      if (!more || !d) coinsState.data = j;
      else if (more === 'made') coinsState.data = { ...d, coins: d.coins.concat(j.coins), next: j.next };
      else coinsState.data = { ...d, launched: d.launched.concat(j.launched), launchedNext: j.launchedNext };
      coinsState.at = Date.now();
    } catch (e) {
      coinsState.loading = false;
      if (!coinsState.data) {
        host.textContent = '';
        host.appendChild(el('div', 'cl-empty', 'could not load the coins. try again in a minute.'));
      }
      return;
    }
    coinsState.loading = false;
    drawCoins(host);
    loadMarket(host);
  }
  /** The coins tab into host (app.js shows the section). Live numbers refresh every 30 s while it is on screen. */
  function coinsTab(host) {
    drawCoins(host);
    if (Date.now() - coinsState.at > 20_000) loadCoins(host);
    else loadMarket(host);
    clearInterval(coinsState.timer);
    coinsState.timer = setInterval(() => {
      const sec = host.closest('section');
      if (!host.isConnected || (sec && sec.hidden)) return clearInterval(coinsState.timer);
      if (document.visibilityState === 'visible') loadMarket(host);
    }, 30_000);
  }

  // =====================================================================================================
  // the home strip: the newest launches, under the prompt
  // =====================================================================================================
  async function homeStrip(host) {
    if (!host) return;
    let j;
    try {
      j = await api('/api/coins?only=launched&ln=4');
    } catch (e) {
      return;
    }
    if (!j.launched || !j.launched.length) return;
    host.textContent = '';
    const head = el('div', 'hl-head');
    const h = el('h2', '', `launched on ${B.name}`);
    head.appendChild(h);
    if (j.cluster === 'devnet') head.appendChild(chip('devnet test', 'warn'));
    const all = el('a', 'hl-all');
    all.href = '/coins';
    all.append(el('span', '', 'all coins'), icon('next'));
    head.appendChild(all);
    const row = el('div', 'hl-row');
    const cards = {};
    for (const cn of j.launched.slice(0, 4)) {
      const a = el('a', 'hl-card');
      a.href = '/k/' + cn.id;
      const logo = el('span', 'hl-logo');
      if (cn.logo) logo.appendChild(img(cn.logo));
      const id = el('span', 'hl-id');
      id.append(el('b', '', cn.name), el('span', '', '$' + cn.ticker));
      const meta = el('span', 'hl-meta');
      const mc = el('b', '', '—');
      meta.append(el('span', '', `${cn.launch.launchpadName} · ${fmt.ago(cn.launch.at)}`), mc);
      a.append(logo, id, meta);
      row.appendChild(a);
      cards[cn.id] = mc;
    }
    host.append(head, row);
    host.hidden = false;
    const m = await market(Object.keys(cards));
    for (const [id, mc] of Object.entries(cards)) {
      const n = statNumbers(m[id]);
      if (n.mcap) mc.textContent = n.mcap;
      mc.title = 'market cap';
    }
  }
  homeStrip(document.getElementById('homeLaunched'));

  window.WagbiLaunch = { config, launched, market, open, coinPage, kitPage, liveBox, coinsTab, homeStrip, fmt, siteOf, pickSite, siteCard, siteCardFor, siteViewer };
})();
