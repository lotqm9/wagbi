// the launch, on a coin's chat: review -> launchpad (its currency, its own options, the first buy) -> fees -> pay ->
// live (LAUNCH-SPEC.md). payment is a deposit address: no wallet connection. the server (api/launch) makes the coin
// when the SOL lands. on pump.fun the creator fees are split (wagbi's cut locked in); on every other launchpad the
// creator keeps all of them and wagbi takes nothing.
// also the coin's public page (/k/<kit id>): the coin, and once it is live its contract, links and fees.
(() => {
  const B = window.BRAND || { name: 'wagbi', domain: 'wagbi.fun' };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const solText = (lamports) => {
    const v = Math.round(lamports);
    const whole = Math.floor(v / 1e9);
    const frac = String(v % 1e9).padStart(9, '0').replace(/0+$/, '');
    return whole + (frac ? '.' + frac : '');
  };
  const pctText = (bps) => (bps / 100).toString().replace(/\.0+$/, '') + '%';
  const short = (a) => (a && a.length > 12 ? a.slice(0, 4) + '...' + a.slice(-4) : a || '');
  const toBps = (v) => {
    const n = Number(String(v).replace('%', '').trim());
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  };

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

  function copyBtn(text, label) {
    const b = el('button', 'lp-copy', label || 'copy');
    b.type = 'button';
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        const t = el('textarea');
        t.value = text;
        document.body.appendChild(t);
        t.select();
        try { document.execCommand('copy'); } catch (x) { /* nothing more to try */ }
        t.remove();
      }
      b.textContent = 'copied';
      setTimeout(() => (b.textContent = label || 'copy'), 1600);
    });
    return b;
  }
  const link = (href, text) => {
    const a = el('a', 'lp-link', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  };
  function field(label, input, hint) {
    const f = el('label', 'lp-field');
    f.append(el('span', 'lp-label', label), input);
    if (hint) f.appendChild(el('span', 'lp-hint', hint));
    return f;
  }
  function input(value, attrs = {}) {
    const i = el(attrs.multiline ? 'textarea' : 'input', 'lp-input');
    if (!attrs.multiline) i.type = 'text';
    i.value = value || '';
    for (const [k, v] of Object.entries(attrs)) if (k !== 'multiline') i.setAttribute(k, v);
    i.spellcheck = false;
    return i;
  }

  // the split as a list (live page and pay step)
  function splitList(shares, feeLabel) {
    const ul = el('ul', 'lp-split');
    for (const s of shares) {
      const li = el('li');
      const who = s.role === 'creator' ? 'creator' : s.role === 'wagbi' ? feeLabel || B.name : 'wallet';
      li.append(el('span', 'lp-split-who', who), el('code', '', short(s.address)), el('b', '', pctText(s.bps)));
      li.title = s.address;
      ul.appendChild(li);
    }
    return ul;
  }

  const STEPS = [['review', 'review'], ['type', 'launchpad'], ['fees', 'fees and rewards'], ['pay', 'pay'], ['live', 'live']];
  const PHASE = {
    waiting: 'waiting for your SOL',
    launching: 'SOL received. launching your coin',
    live: 'live',
    refunding: 'sending your SOL back',
    refunded: 'your SOL was sent back',
    expired: 'this deposit closed with nothing in it',
  };

  /**
   * The launch flow, inside `host`. ctx: { kitId, name, ticker, bio, logo, banner, saved: { depositId }, save(fields) }
   */
  function open(host, ctx, c) {
    const s = {
      step: 'review',
      name: ctx.name || '', ticker: ctx.ticker || '', bio: ctx.bio || '', x: '',
      chain: 'solana', launchpad: 'pumpfun', currency: 'SOL', type: 'normal', firstBuy: '', options: {},
      payout: '', creatorPct: String((10000 - c.fee.bps) / 100), wallets: [],
      quote: null, deposit: null, busy: false, err: '',
    };
    const panel = el('section', 'lp');
    panel.setAttribute('aria-label', 'launch your coin');
    const head = el('div', 'lp-head');
    const title = el('h3', '', 'launch your coin');
    const close = el('button', 'lp-x', 'close');
    close.type = 'button';
    head.append(title, close);
    if (c.cluster === 'devnet') head.appendChild(el('span', 'lp-devnet', 'devnet test: devnet SOL only'));
    const tabs = el('ol', 'lp-tabs');
    const body = el('div', 'lp-body');
    const foot = el('div', 'lp-foot');
    const err = el('p', 'lp-err');
    err.setAttribute('role', 'alert');
    panel.append(head, tabs, body, err, foot);
    host.appendChild(panel);

    let timer = null;
    let alive = true;
    close.addEventListener('click', () => {
      alive = false;
      clearTimeout(timer);
      panel.remove();
      if (ctx.onClose) ctx.onClose();
    });

    const at = () => STEPS.findIndex(([k]) => k === s.step);
    const paying = () => !!s.deposit;
    function go(step) {
      s.step = step;
      s.err = '';
      render();
      panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    function setErr(text) {
      s.err = text || '';
      err.textContent = s.err;
    }
    // the picked launchpad and currency (as the config lists them), and their options with defaults filled in
    const padOf = () => (c.launchpads || []).find((l) => l.id === s.launchpad) || null;
    const curOf = () => {
      const pad = padOf();
      return (pad && pad.currencies.find((x) => x.id === s.currency)) || null;
    };
    const optsOf = () => {
      const cur = curOf();
      const out = {};
      for (const o of (cur && cur.options) || []) out[o.id] = s.options[o.id] != null ? s.options[o.id] : o.default;
      return out;
    };
    const creatorKeeps = () => (padOf() || {}).feeModel === 'creator';
    const padName = () => (padOf() || { name: 'the launchpad' }).name;

    function renderTabs() {
      tabs.textContent = '';
      STEPS.forEach(([k, label], i) => {
        const li = el('li', i === at() ? 'now' : i < at() ? 'done' : '');
        const b = el('button', '', `${i + 1}. ${label}`);
        b.type = 'button';
        b.disabled = !(i < at() && !paying());
        b.addEventListener('click', () => go(k));
        li.appendChild(b);
        tabs.appendChild(li);
      });
    }

    function nav(back, next, nextLabel) {
      foot.textContent = '';
      if (back) {
        const b = el('button', 'lp-btn ghost', 'back');
        b.type = 'button';
        b.addEventListener('click', back);
        foot.appendChild(b);
      }
      if (next) {
        const n = el('button', 'lp-btn', nextLabel || 'continue');
        n.type = 'button';
        n.addEventListener('click', next);
        foot.appendChild(n);
        return n;
      }
      return null;
    }

    // 1. review
    function review() {
      const name = input(s.name, { maxlength: '32', 'aria-label': 'name' });
      const ticker = input(s.ticker, { maxlength: '11', 'aria-label': 'ticker' });
      const bio = input(s.bio, { multiline: true, maxlength: '280', rows: '2', 'aria-label': 'bio' });
      const x = input(s.x, { placeholder: 'x.com/yourcoin (optional)', 'aria-label': 'x account' });
      name.addEventListener('input', () => (s.name = name.value));
      ticker.addEventListener('input', () => (s.ticker = ticker.value.replace(/^\$/, '').toUpperCase().replace(/[^A-Z0-9]/g, '')));
      ticker.addEventListener('blur', () => (ticker.value = s.ticker));
      bio.addEventListener('input', () => (s.bio = bio.value));
      x.addEventListener('input', () => (s.x = x.value));

      const look = el('div', 'lp-look');
      const lb = el('div', 'lp-look-banner');
      const ll = el('div', 'lp-look-logo');
      if (ctx.banner) lb.appendChild(Object.assign(new Image(), { src: ctx.banner, alt: '' }));
      if (ctx.logo) ll.appendChild(Object.assign(new Image(), { src: ctx.logo, alt: '' }));
      look.append(lb, ll);

      const grid = el('div', 'lp-grid');
      grid.append(field('name', name), field('ticker', ticker, '2 to 10 letters or numbers'));
      body.append(
        look,
        el('p', 'lp-hint', 'the logo and banner are the ones made above. the launchpad shows the logo.'),
        grid,
        field('bio', bio, 'shown on the launchpad under the name'),
        field('x account', x),
        el('p', 'lp-hint', `the launchpad will link to this coin's ${B.name} page:`),
      );
      body.lastChild.append(' ', link(`${location.origin}/k/${ctx.coinId || ctx.kitId}`, `${B.domain}/k/${ctx.coinId || ctx.kitId}`));
      nav(null, () => {
        if (!s.name.trim()) return setErr('give the coin a name.');
        if (!/^[A-Z0-9]{2,10}$/.test(s.ticker)) return setErr('the ticker must be 2 to 10 letters or numbers.');
        if (s.bio.length > 280) return setErr('the bio is too long.');
        go('type');
      });
    }

    // 2. launchpad: chain, launchpad, currency, launch type and the first buy
    let quoteTimer = null;
    async function requote(out) {
      const v = s.firstBuy.trim() === '' ? 0 : Number(s.firstBuy);
      if (!Number.isFinite(v) || v < 0) return (out.textContent = 'type an amount of SOL, or leave it empty.');
      try {
        const q = await post('/api/launch/quote', { firstBuySol: v, chain: s.chain, launchpad: s.launchpad, currency: s.currency, options: optsOf() });
        s.quote = q;
        out.textContent = v > 0 && q.firstBuy ? `buys about ${Math.round(q.firstBuy.pctOfSupply * 10) / 10}% of the supply. you'll send ${q.sol} SOL in all.` : `no first buy. you'll send ${q.sol} SOL for network costs.`;
      } catch (e) {
        out.textContent = e.message;
      }
    }
    // the picker: chain -> launchpad -> currency. what isn't wired yet shows, marked soon, and can't be picked.
    function pickGroup(label, items, current, onPick, cls) {
      const g = el('div', 'lp-pick');
      g.appendChild(el('span', 'lp-label', label));
      const row = el('div', 'lp-pick-row ' + (cls || ''));
      for (const it of items) {
        const b = el('button', 'lp-opt' + (it.id === current ? ' on' : '') + (it.status !== 'live' ? ' soon' : ''));
        b.type = 'button';
        b.disabled = it.status !== 'live';
        if (it.why && it.status !== 'live') b.title = it.why;
        b.setAttribute('aria-pressed', String(it.id === current));
        const top = el('span', 'lp-opt-top');
        top.append(el('b', '', it.name || it.id));
        if (it.status !== 'live') top.appendChild(el('em', '', 'soon'));
        b.appendChild(top);
        if (it.blurb) b.appendChild(el('span', 'lp-opt-blurb', it.blurb));
        if (it.why && it.status !== 'live') b.appendChild(el('span', 'lp-opt-why', it.why));
        b.addEventListener('click', () => onPick(it.id));
        row.appendChild(b);
      }
      g.appendChild(row);
      return g;
    }
    // a launchpad's own options (curve, market caps, fees...), each a row of choices, like a launch screen
    function optionFields(cur) {
      const box = el('div', 'lp-opts');
      for (const o of (cur && cur.options) || []) {
        const g = el('div', 'lp-pick');
        g.appendChild(el('span', 'lp-label', o.label));
        const row = el('div', 'lp-pick-row chips');
        const now = String(s.options[o.id] != null ? s.options[o.id] : o.default);
        for (const ch of o.choices || []) {
          const b = el('button', 'lp-opt' + (ch.id === now ? ' on' : ''));
          b.type = 'button';
          b.setAttribute('aria-pressed', String(ch.id === now));
          b.appendChild(el('b', '', ch.label));
          b.addEventListener('click', () => { s.options[o.id] = ch.id; render(); });
          row.appendChild(b);
        }
        g.appendChild(row);
        if (o.hint) g.appendChild(el('span', 'lp-hint', o.hint));
        box.appendChild(g);
      }
      return box;
    }
    function picker() {
      const pads = (c.launchpads || []).filter((l) => l.chain === s.chain);
      let pad = padOf();
      if (!pad || pad.chain !== s.chain) {
        pad = pads.find((l) => l.status === 'live') || pads[0];
        if (pad) s.launchpad = pad.id;
      }
      const curs = pad ? pad.currencies : [{ id: 'SOL', status: 'live' }];
      if (!curs.some((x) => x.id === s.currency && x.status === 'live')) {
        const live = curs.find((x) => x.status === 'live');
        if (live) s.currency = live.id;
      }
      body.append(
        pickGroup('blockchain', c.chains || [{ id: 'solana', name: 'Solana', status: 'live' }], s.chain, (id) => { s.chain = id; render(); }, 'chips'),
        pickGroup('launchpad', pads, s.launchpad, (id) => { s.launchpad = id; s.options = {}; render(); }),
        pickGroup('launch currency', curs.map((x) => ({ ...x, name: x.id })), s.currency, (id) => { s.currency = id; render(); }, 'chips'),
      );
      const cur = curOf();
      if (cur && cur.note) body.appendChild(el('p', 'lp-hint', cur.note));
      if (cur && (cur.options || []).length) body.appendChild(optionFields(cur));
      if (pad && pad.feeModel === 'creator' && pad.status === 'live') body.appendChild(el('p', 'lp-note', pad.feeNote || `you keep all the creator fees on ${pad.name}. ${B.name} takes nothing.`));
      type(true);
    }

    function type(inPicker) {
      body.appendChild(el('span', 'lp-label', 'launch type'));
      const cards = el('div', 'lp-cards');
      const normal = el('label', 'lp-card on');
      const r1 = el('input');
      r1.type = 'radio';
      r1.name = 'lp-type';
      r1.checked = true;
      normal.append(r1, el('b', '', 'normal'), el('span', '', 'a public launch. anyone can buy from the first second.'));
      const buy = input(s.firstBuy, { inputmode: 'decimal', placeholder: '0', 'aria-label': 'first buy in SOL' });
      const out = el('p', 'lp-hint lp-quote', '');
      buy.addEventListener('input', () => {
        s.firstBuy = buy.value.replace(',', '.');
        clearTimeout(quoteTimer);
        quoteTimer = setTimeout(() => requote(out), 350);
      });
      const buyBox = el('div', 'lp-buy');
      const cur = curOf();
      if (!cur || cur.firstBuy) {
        buyBox.append(field(`first buy (optional, up to ${c.firstBuy.maxSol} SOL)`, buy, 'you buy in the same transaction that makes the coin, so nobody gets in before you. the coins go to your payout wallet.'), out);
      } else {
        s.firstBuy = '';
        buyBox.append(el('p', 'lp-hint', `no first buy on ${padName()} with ${s.currency}.`), out);
      }
      normal.appendChild(buyBox);

      const alloc = el('label', 'lp-card off');
      const r2 = el('input');
      r2.type = 'radio';
      r2.name = 'lp-type';
      r2.disabled = true;
      alloc.append(r2, el('b', '', 'private allocation'), el('span', '', `invited buyers each pay their own SOL and get their coins in the launch block, up to ${c.allocation.maxBuyers} buyers and ${c.allocation.maxPct}% of the supply. every buyer and their share is shown on the coin's page.`), el('em', '', 'not open yet'));
      cards.append(normal, alloc);
      body.append(cards);
      requote(out);
      void inPicker;
      nav(() => go('review'), () => {
        const cur = curOf();
        if (!cur || cur.status !== 'live') return setErr((cur && cur.why) || "that launchpad isn't open yet. pick one that is.");
        const v = s.firstBuy.trim() === '' ? 0 : Number(s.firstBuy);
        if (!Number.isFinite(v) || v < 0 || (v > 0 && (v < c.firstBuy.minSol || v > c.firstBuy.maxSol))) return setErr(`the first buy can be empty, or ${c.firstBuy.minSol} to ${c.firstBuy.maxSol} SOL.`);
        go('fees');
      });
    }

    // 3. fees. on a creator-fee launchpad: just the payout wallet, and the plain words
    function creatorFees() {
      const pad = padOf() || {};
      const a = input(s.payout, { placeholder: 'solana wallet address', 'aria-label': 'your payout wallet' });
      a.addEventListener('input', () => (s.payout = a.value.trim()));
      body.append(
        el('p', 'lp-lead', `you keep all the creator fees on ${pad.name}. ${B.name} takes nothing.`),
        field('your payout wallet', a, 'the coin\'s creator fees, the first-buy coins and any SOL sent back all go here. a wallet you control, not an exchange.'),
      );
      if (pad.feeNote) body.appendChild(el('p', 'lp-note', pad.feeNote));
      nav(() => go('type'), () => {
        if (!ADDR.test(s.payout)) return setErr('paste your payout wallet address (a wallet you control, not an exchange).');
        if (c.fee.wallet && s.payout === c.fee.wallet) return setErr(`that's ${B.name}'s own fee wallet. use your own wallet.`);
        go('pay');
      });
    }
    function fees() {
      if (creatorKeeps()) return creatorFees();
      const cur = curOf() || {};
      const maxWallets = cur.maxWallets || c.maxWallets;
      const maxExtra = maxWallets - 2;
      const rows = el('div', 'lp-rows');
      const total = el('p', 'lp-total');
      const feePct = c.fee.bps / 100;
      const sum = () => toBps(s.creatorPct) + c.fee.bps + s.wallets.reduce((a, w) => a + (toBps(w.pct) || 0), 0);
      const showTotal = () => {
        const t = sum();
        total.classList.toggle('ok', t === 10000);
        total.textContent = Number.isNaN(t) ? 'total: check the numbers' : t === 10000 ? 'total: 100%' : t < 10000 ? `total: ${pctText(t)}. add ${pctText(10000 - t)} to reach 100%.` : `total: ${pctText(t)}. that's ${pctText(t - 10000)} too much.`;
      };
      function row(label, addr, pct, opts = {}) {
        const r = el('div', 'lp-row' + (opts.fixed ? ' fixed' : ''));
        const who = el('span', 'lp-row-who', label);
        let a;
        if (opts.fixed) {
          a = el('span', 'lp-row-fixed', opts.fixedText);
        } else {
          a = input(addr, { placeholder: 'solana wallet address', 'aria-label': `${label} wallet` });
          a.addEventListener('input', () => opts.onAddr(a.value.trim()));
        }
        let p;
        if (opts.fixed) {
          p = el('span', 'lp-pct-fixed', `${feePct}%`);
        } else {
          p = input(pct, { inputmode: 'decimal', 'aria-label': `${label} share` });
          p.classList.add('lp-pct');
          p.addEventListener('input', () => {
            opts.onPct(p.value.replace(',', '.'));
            showTotal();
          });
        }
        const pctBox = el('span', 'lp-pct-box');
        pctBox.append(p);
        if (!opts.fixed) pctBox.appendChild(el('i', '', '%'));
        r.append(who, a, pctBox);
        if (opts.remove) {
          const x = el('button', 'lp-rm', 'remove');
          x.type = 'button';
          x.addEventListener('click', opts.remove);
          r.appendChild(x);
        } else {
          r.appendChild(el('span', 'lp-rm-space'));
        }
        return r;
      }
      function draw() {
        rows.textContent = '';
        rows.appendChild(row('you', s.payout, s.creatorPct, { onAddr: (v) => (s.payout = v), onPct: (v) => (s.creatorPct = v) }));
        rows.appendChild(row(B.name, '', '', { fixed: true, fixedText: 'platform cut, fixed' }));
        s.wallets.forEach((w, i) => {
          rows.appendChild(row(`wallet ${i + 2}`, w.address, w.pct, {
            onAddr: (v) => (w.address = v),
            onPct: (v) => (w.pct = v),
            remove: () => { s.wallets.splice(i, 1); draw(); },
          }));
        });
        if (s.wallets.length > maxExtra) s.wallets.length = maxExtra;
        add.disabled = s.wallets.length >= maxExtra;
        add.textContent = s.wallets.length >= maxExtra ? `${maxWallets} wallets is the most` : '+ add wallet';
        showTotal();
      }
      const add = el('button', 'lp-add', '+ add wallet');
      add.type = 'button';
      add.addEventListener('click', () => {
        if (s.wallets.length < maxExtra) s.wallets.push({ address: '', pct: '' });
        draw();
        const last = rows.querySelector('.lp-row:last-child input');
        if (last) last.focus();
      });
      body.append(
        el('p', 'lp-lead', 'who gets the creator fees from every trade. your wallet also gets the first-buy coins and any SOL sent back.'),
        rows, add, total,
        el('p', 'lp-note', `the split is locked at launch. nobody can change it after, ${B.name} included.`),
      );
      draw();
      nav(() => go('type'), () => {
        if (!ADDR.test(s.payout)) return setErr('paste your payout wallet address (a wallet you control, not an exchange).');
        for (const [i, w] of s.wallets.entries()) {
          if (!ADDR.test(w.address)) return setErr(`wallet ${i + 2} isn't a solana address.`);
          if (!(toBps(w.pct) > 0)) return setErr(`give wallet ${i + 2} a share above 0%.`);
        }
        if (!(toBps(s.creatorPct) > 0)) return setErr('your share must be above 0%.');
        const all = [s.payout, ...s.wallets.map((w) => w.address)];
        if (new Set(all).size !== all.length) return setErr('the same wallet is in the split twice.');
        if (c.fee.wallet && all.includes(c.fee.wallet)) return setErr(`that's ${B.name}'s own fee wallet. use your own wallets.`);
        if (sum() !== 10000) return setErr('the split must add up to exactly 100%.');
        go('pay');
      });
    }

    // 4. pay
    async function create(btn) {
      if (s.busy) return;
      s.busy = true;
      btn.disabled = true;
      btn.textContent = 'making your address';
      setErr('');
      try {
        const split = creatorKeeps() ? {} : { creatorBps: toBps(s.creatorPct), wallets: s.wallets.map((w) => ({ address: w.address, bps: toBps(w.pct) })) };
        const j = await post('/api/launch', {
          kitId: ctx.kitId, chain: s.chain, launchpad: s.launchpad, currency: s.currency, type: 'normal', name: s.name.trim(), ticker: s.ticker, bio: s.bio.trim(), x: s.x.trim() || null,
          payout: s.payout, ...split, options: optsOf(),
          firstBuySol: s.firstBuy.trim() === '' ? 0 : Number(s.firstBuy),
        });
        s.deposit = j.deposit;
        if (ctx.save) ctx.save({ depositId: j.deposit.id });
        render();
        poll();
      } catch (e) {
        setErr(e.message);
        btn.disabled = false;
        btn.textContent = 'get deposit address';
      } finally {
        s.busy = false;
      }
    }

    function payBefore() {
      const q = s.quote && s.quote.amounts;
      const lines = el('dl', 'lp-sum');
      const add = (k, v) => lines.append(el('dt', '', k), el('dd', '', v));
      if (q) {
        if (q.firstBuyLamports) add('first buy (with 5% slippage room)', `${solText(q.firstBuyMaxLamports)} SOL`);
        add('network costs', `${solText(q.networkLamports)} SOL`);
        add('buffer (comes back)', `${solText(q.bufferLamports)} SOL`);
        add('you send', `${solText(q.totalLamports)} SOL`);
      }
      body.append(
        el('p', 'lp-lead', creatorKeeps() ? `$${s.ticker}: ${s.name.trim()}, on ${padName()}${s.currency !== 'SOL' ? ` (${s.currency})` : ''}. you keep all the creator fees.` : `$${s.ticker}: ${s.name.trim()}, on ${padName()}${s.currency !== 'SOL' ? ` (${s.currency} pair)` : ''}. ${s.wallets.length ? `${s.wallets.length + 2} wallets` : `you and ${B.name}`} in the split.`),
        lines,
        el('p', 'lp-note', 'you get a one-time address for this coin. send the exact amount from any wallet, but never from an exchange. leftover SOL comes back to your payout wallet, and a failed launch refunds everything automatically.'),
      );
      const btn = nav(() => go('fees'), () => create(btn), 'get deposit address');
    }

    function payAfter() {
      const d = s.deposit;
      const box = el('div', 'lp-pay');
      const qr = el('div', 'lp-qr');
      if (d.qr) qr.appendChild(Object.assign(new Image(), { src: d.qr, alt: 'QR code with the address and the amount' }));
      const info = el('div', 'lp-pay-info');
      const amount = el('div', 'lp-amount');
      amount.append(el('span', 'lp-label', 'send exactly'), el('b', '', `${d.sol} SOL`), copyBtn(d.sol, 'copy amount'));
      const addr = el('div', 'lp-addr');
      addr.append(el('span', 'lp-label', 'to this address'), el('code', '', d.address), copyBtn(d.address, 'copy address'));
      const st = el('div', 'lp-status');
      const steps = el('ol', 'lp-progress');
      for (const [k, label] of [['received', 'received'], ['create', 'coin made'], ['split', 'split locked'], ['live', 'live']]) {
        if (d.steps[k] === 'skip') continue;
        const li = el('li', d.steps[k]);
        li.append(el('i'), el('span', '', label));
        steps.appendChild(li);
      }
      st.append(el('p', 'lp-phase', d.phase === 'live' ? `live on ${d.launchpadName || 'pump.fun'}` : PHASE[d.phase] || d.phase), steps);
      if (d.received && d.phase === 'waiting' && d.received.lamports > 0 && d.received.missingLamports > 0) st.appendChild(el('p', 'lp-hint', `received ${solText(d.received.lamports)} SOL. ${solText(d.received.missingLamports)} SOL to go.`));
      if (d.problem) st.appendChild(el('p', 'lp-problem', d.problem));
      for (const r of d.returns || []) {
        const p = el('p', 'lp-hint', `${solText(r.lamports)} SOL sent back to ${short(r.to)} (${r.what}). `);
        if (r.tx) p.appendChild(link(r.tx, 'transaction'));
        st.appendChild(p);
      }
      if (d.refund && d.refund.available) {
        const b = el('button', 'lp-btn ghost', 'send my SOL back');
        b.type = 'button';
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            s.deposit = (await post(`/api/launch/${d.id}/refund`, {})).deposit;
            render();
          } catch (e) {
            setErr(e.message);
            b.disabled = false;
          }
        });
        st.appendChild(b);
      }
      info.append(amount, addr);
      box.append(qr, info);
      body.append(
        box,
        el('p', 'lp-note', 'send from any wallet, not an exchange. leftover SOL comes back to your payout wallet; a failed launch refunds automatically.'),
        st,
      );
      foot.textContent = '';
    }

    // 5. live
    function live() {
      const d = s.deposit;
      const mint = d.launch.mint;
      const ca = el('div', 'lp-addr');
      ca.append(el('span', 'lp-label', 'contract address'), el('code', '', mint), copyBtn(mint, 'copy'));
      const links = el('p', 'lp-links');
      const pad = d.launch.links.pad || (d.launch.links.pump ? { url: d.launch.links.pump, label: 'open on pump.fun' } : null);
      if (pad) links.append(link(pad.url, pad.label));
      links.append(link(`${location.origin}/k/${d.kitId}`, `the coin's ${B.name} page`), link(d.launch.links.mint, 'solscan'));
      body.append(el('p', 'lp-lead', `$${d.coin.ticker} is live on ${d.launchpadName || 'pump.fun'}.`), ca, links);
      if (d.feeModel === 'creator') body.append(el('p', 'lp-label', 'creator fees'), el('p', 'lp-hint', `all of them go to your wallet ${short(d.payout)}. ${B.name} takes nothing.`));
      else body.append(el('p', 'lp-label', 'creator fee split, locked'), splitList(d.shares));
      for (const r of d.returns || []) body.appendChild(el('p', 'lp-hint', `${solText(r.lamports)} SOL of leftover sent back to ${short(r.to)}.`));
      foot.textContent = '';
    }

    function render() {
      body.textContent = '';
      setErr(s.err);
      if (s.deposit && s.deposit.phase === 'live' && s.deposit.launch) s.step = 'live';
      else if (s.deposit) s.step = 'pay';
      renderTabs();
      if (s.step === 'review') review();
      else if (s.step === 'type') picker();
      else if (s.step === 'fees') fees();
      else if (s.step === 'pay') (s.deposit ? payAfter : payBefore)();
      else live();
    }

    async function poll() {
      clearTimeout(timer);
      if (!alive || !s.deposit || !document.contains(panel)) return;
      const doneish = ['refunded', 'expired'].includes(s.deposit.phase) || (s.deposit.phase === 'live' && (s.deposit.returns || []).length);
      if (doneish) return;
      timer = setTimeout(async () => {
        if (!alive || !document.contains(panel)) return;
        try {
          const j = await api(`/api/launch/${s.deposit.id}`);
          const key = (d) => JSON.stringify([d.phase, d.steps, d.received, d.returns, d.problem, d.refund, d.launch]);
          const changed = key(j.deposit) !== key(s.deposit);
          s.deposit = { ...j.deposit, qr: s.deposit.qr };
          if (changed) render();
        } catch (e) { /* a missed poll; the next one tries again */ }
        poll();
      }, s.deposit.phase === 'waiting' ? 4000 : 2500);
    }

    // resume a deposit made earlier in this browser
    (async () => {
      if (ctx.saved && ctx.saved.depositId) {
        try {
          const j = await api(`/api/launch/${ctx.saved.depositId}?qr=1`);
          s.deposit = j.deposit;
        } catch (e) { /* gone: start over */ }
      }
      render();
      if (s.deposit) poll();
    })();
    return panel;
  }

  // ---------- the coin's public page: /k/<kit id> ----------
  // the coin (a conversation, by its first kit's id): the version it launched with, else its latest version
  async function coinPage(host, kitId) {
    const wrap = el('div', 'lp-page');
    host.appendChild(wrap);
    let j = null;
    try {
      const r = await fetch('/api/kit/' + encodeURIComponent(kitId) + '?versions=1');
      if (r.ok) j = await r.json();
    } catch (e) { /* shown below */ }
    if (!j || !j.kit) {
      wrap.appendChild(el('p', 'note', 'this coin is not here.'));
      return null;
    }
    const coin = await launched(kitId);
    let kit = j.latest || j.kit;
    if (coin && coin.versionId && coin.versionId !== kit.id) {
      try {
        const r = await fetch('/api/kit/' + encodeURIComponent(coin.versionId));
        if (r.ok) kit = (await r.json()).kit || kit;
      } catch (e) { /* the latest stands in */ }
    }
    return { kit, first: j.kit, versions: j.versions || [], coin, wrap };
  }

  /** The "live" box on the coin's public page. */
  function liveBox(coin) {
    const box = el('section', 'lp lp-public');
    const mint = coin.mint;
    const ca = el('div', 'lp-addr');
    ca.append(el('span', 'lp-label', 'contract address'), el('code', '', mint), copyBtn(mint, 'copy'));
    const links = el('p', 'lp-links');
    const pad = coin.links.pad || (coin.links.pump ? { url: coin.links.pump, label: 'open on pump.fun' } : null);
    if (pad) links.append(link(pad.url, pad.label));
    links.append(link(coin.links.mint, 'solscan'));
    if (coin.x) links.append(link(coin.x, 'x'));
    const where = coin.launchpadName || 'pump.fun';
    const creatorKeepsAll = coin.feeModel === 'creator';
    box.append(
      el('h3', '', coin.cluster === 'devnet' ? `live on ${where}, devnet (a test)` : `live on ${where}`),
      ca, links,
      el('p', 'lp-label', creatorKeepsAll ? 'creator fees' : 'creator fee split, locked at launch'),
      creatorKeepsAll ? el('p', 'lp-hint', `all of them go to the creator's wallet ${short(coin.payout)}. ${B.name} takes nothing.`) : splitList(coin.split),
      el('p', 'lp-label', 'private allocation'),
      el('p', 'lp-hint', coin.allocation && coin.allocation.length ? '' : 'none. no wallet bought in the launch block except the creator\'s first buy.'),
    );
    if (coin.allocation && coin.allocation.length) {
      const ul = el('ul', 'lp-split');
      for (const a of coin.allocation) {
        const li = el('li');
        li.append(el('span', 'lp-split-who', 'buyer'), el('code', '', short(a.wallet)), el('b', '', `${a.pctOfSupply}%`));
        li.title = a.wallet;
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    return box;
  }

  window.WagbiLaunch = { config, launched, open, coinPage, liveBox };
})();
