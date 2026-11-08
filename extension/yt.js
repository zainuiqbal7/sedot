'use strict';
// Tombol "Unduh video" di pemutar YouTube. Halaman dikirim ke aplikasi Sedot lewat background.js.
// Catatan: YouTube memakai Trusted Types, jadi elemen dibuat lewat DOM (tanpa innerHTML).
(() => {
  const BTN_ID = 'sedot-video-btn';
  const LABEL = { idle: 'Unduh video', sending: 'Mengirim…', ok: 'Terkirim ke Sedot ✓', fail: 'Sedot belum berjalan' };

  function videoUrl() {
    const u = new URL(location.href);
    const v = u.searchParams.get('v');
    if (u.pathname === '/watch' && v) return `https://www.youtube.com/watch?v=${v}`; // tanpa playlist
    const m = /^\/(shorts|live)\/([\w-]+)/.exec(u.pathname);
    return m ? `https://www.youtube.com/${m[1]}/${m[2]}` : null;
  }

  function activePlayer() {
    return document.querySelector('ytd-reel-video-renderer[is-active] .html5-video-player')
      || document.querySelector('#movie_player.html5-video-player')
      || null;
  }

  function icon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M12 4v11M7 10l5 5 5-5M5 20h14');
    svg.append(p);
    return svg;
  }

  function setState(btn, state, title) {
    btn.dataset.state = state;
    btn.querySelector('span').textContent = LABEL[state];
    btn.title = title || 'Unduh video ini dengan Sedot';
    clearTimeout(btn._t);
    if (state === 'ok' || state === 'fail') btn._t = setTimeout(() => setState(btn, 'idle'), state === 'ok' ? 2500 : 5000);
  }

  function makeButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'sedot-btn';
    const label = document.createElement('span');
    btn.append(icon(), label);
    setState(btn, 'idle');
    // jangan sampai klik tombol ikut menjeda/memutar video
    for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) btn.addEventListener(ev, (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const url = videoUrl();
      if (!url || btn.dataset.state === 'sending') return;
      setState(btn, 'sending');
      chrome.runtime.sendMessage({ type: 'sedot-video', url }, (r) => {
        if (chrome.runtime.lastError || !r?.ok) setState(btn, 'fail', 'Buka aplikasi Sedot dulu (Start Menu), lalu klik lagi.');
        else setState(btn, 'ok');
      });
    });
    return btn;
  }

  function ensure() {
    const player = videoUrl() && activePlayer();
    let btn = document.getElementById(BTN_ID);
    if (!player) { btn?.remove(); return; }
    if (!btn) btn = makeButton();
    if (btn.parentElement !== player) player.append(btn);
  }

  setInterval(ensure, 1000);
  document.addEventListener('yt-navigate-finish', ensure);
  ensure();
})();
