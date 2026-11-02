// A coin's website, the little that runs in the browser: copy buttons, the bar's edge on scroll, sections easing in,
// and a launched coin's numbers kept fresh (every 30 seconds while the page is open, from /api/site?market=<coin>).
// No outside requests. The page works without it; the numbers just stay as the server drew them.
(() => {
  const root = document.documentElement;
  root.classList.add('js');

  // copy the contract
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('[data-copy]');
    if (!b) return;
    const text = b.getAttribute('data-copy') || '';
    let done = false;
    try {
      await navigator.clipboard.writeText(text);
      done = true;
    } catch (err) {
      const t = document.createElement('textarea');
      t.value = text;
      t.setAttribute('readonly', '');
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      try { done = document.execCommand('copy'); } catch (x) { /* nothing more to try */ }
      t.remove();
    }
    if (!done) return;
    const label = b.querySelector('span');
    const was = label ? label.textContent : null;
    b.classList.add('done');
    if (label) label.textContent = 'copied';
    clearTimeout(b._t);
    b._t = setTimeout(() => {
      b.classList.remove('done');
      if (label) label.textContent = was;
    }, 1600);
  });

  // the bar gets its edge once the page moves
  const bar = document.querySelector('.bar');
  const edge = () => bar && bar.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', edge, { passive: true });
  edge();

  // sections ease in as they come into view
  const items = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        en.target.classList.add('in');
        io.unobserve(en.target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    items.forEach((el) => io.observe(el));
  } else {
    items.forEach((el) => el.classList.add('in'));
  }

  // a launched coin's numbers
  const live = document.querySelector('[data-live]');
  if (!live) return;
  const coin = live.getAttribute('data-live');
  if (!/^[A-Za-z0-9_-]{16}$/.test(coin)) return;
  const set = (k, v, cls) => {
    document.querySelectorAll(`[data-n="${k}"]`).forEach((el) => {
      if (el.tagName === 'PROGRESS') {
        if (typeof v === 'number') el.value = v;
        return;
      }
      el.textContent = v == null ? '—' : v;
      if (cls !== undefined) {
        el.classList.toggle('up', cls === 'up');
        el.classList.toggle('down', cls === 'down');
      }
    });
  };
  const src = document.querySelector('[data-src]');
  async function load() {
    if (document.visibilityState === 'hidden') return;
    try {
      const r = await fetch(`/api/site?market=${encodeURIComponent(coin)}`, { headers: { accept: 'application/json' } });
      const j = await r.json();
      if (!r.ok || !j.ok || !j.n) return;
      const n = j.n;
      set('mcap', n.mcap);
      set('vol', n.vol);
      set('chg', n.chg, n.change == null ? '' : n.change >= 0 ? 'up' : 'down');
      set('price', n.price);
      if (n.prog != null) set('prog', n.prog);
      if (typeof n.progPct === 'number') set('progbar', Math.round(n.progPct));
      if (src && j.src) src.textContent = j.src;
    } catch (e) { /* the numbers stay as they are */ }
  }
  setInterval(load, 30_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
})();
