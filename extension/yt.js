'use strict';
// Tombol "Unduh video" + menu kualitas di pemutar YouTube (mirip IDM: klik -> pilih kualitas -> mulai).
// Data kualitas & ukuran dibaca dari pemutar oleh yt-main.js; pilihan dikirim ke aplikasi Sedot lewat background.js.
// YouTube memakai Trusted Types, jadi semua elemen dibuat lewat DOM (tanpa innerHTML).
(() => {
  const BTN_ID = 'sedot-video-btn';
  const MENU_ID = 'sedot-video-menu';
  const LABEL = { idle: 'Unduh video', sending: 'Mengirim…', ok: 'Masuk ke Sedot ✓', fail: 'Sedot belum berjalan' };

  // ---------- Halaman & pemutar ----------
  function videoId() {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    return (/^\/(shorts|live)\/([\w-]+)/.exec(u.pathname) || [])[2] || null;
  }
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

  // ---------- Data kualitas dari pemutar (lewat yt-main.js) ----------
  let reqSeq = 0;
  function askPage() {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${++reqSeq}`;
      const t = setTimeout(() => { window.removeEventListener('message', on); resolve(null); }, 600);
      function on(e) {
        if (e.source !== window || e.data?.source !== 'sedot-page' || e.data.type !== 'formats-res' || e.data.id !== id) return;
        clearTimeout(t);
        window.removeEventListener('message', on);
        resolve(e.data.data || null);
      }
      window.addEventListener('message', on);
      window.postMessage({ source: 'sedot-ext', type: 'formats-req', id }, '*');
    });
  }

  function fmtSize(n) {
    if (!n) return '';
    return n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1048576))} MB`;
  }

  /** Data pemutar -> baris menu. Ukuran = gambar + suara, seperti yang nanti benar-benar diunduh. */
  function menuItems(d) {
    const items = [];
    const fm = Array.isArray(d?.formats) ? d.formats : [];
    const audios = fm.filter((f) => f.mime.startsWith('audio/')).sort((a, b) => b.bitrate - a.bitrate);
    const m4a = audios.find((f) => f.mime.includes('mp4')) || null;
    const byH = new Map();
    for (const f of fm) {
      if (!f.mime.startsWith('video/') || !f.height) continue;
      const avc = f.mime.includes('avc1') ? 1 : 0; // Sedot mengutamakan H.264 (diputar di mana saja)
      const cur = byH.get(f.height);
      if (!cur || avc > cur.avc || (avc === cur.avc && f.bitrate > cur.f.bitrate)) byH.set(f.height, { f, avc });
    }
    let heights = [...byH.keys()];
    if (!heights.length) heights = [...new Set(d?.levels || [])]; // cadangan: daftar kualitas pemutar tanpa ukuran
    heights.sort((a, b) => b - a);
    for (const h of heights) {
      const f = byH.get(h)?.f;
      const fps = f && f.fps > 30 ? f.fps : '';
      const size = f?.size ? f.size + (m4a?.size || audios[0]?.size || 0) : 0;
      items.push({ label: `${h}p${fps}`, tag: h >= 720 ? 'HD' : '', detail: 'MP4', size, request: { kind: 'video', height: h } });
    }
    if (items.length || audios.length) {
      items.push({ sep: true });
      items.push({ label: 'Audio MP3', detail: '192 kbps', size: d?.seconds ? d.seconds * 192 * 125 : 0, request: { kind: 'mp3' } });
      if (m4a || !audios.length) items.push({ label: 'Audio M4A', detail: 'kualitas asli', size: m4a?.size || 0, request: { kind: 'm4a' } });
    }
    items.push({ sep: true });
    items.push({ label: 'Pilihan lain…', detail: 'subtitle, folder, nama file', request: null, more: true });
    return items;
  }

  // ---------- Tombol ----------
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

  const stop = (el) => { for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'click', 'keydown']) el.addEventListener(ev, (e) => e.stopPropagation()); };

  function send(btn, request) {
    const url = videoUrl();
    if (!url) return;
    setState(btn, 'sending');
    const title = document.querySelector('#title h1, h1.ytd-watch-metadata')?.textContent?.trim() || document.title.replace(/\s*-\s*YouTube\s*$/, '');
    chrome.runtime.sendMessage({ type: 'sedot-video', url, request, title }, (r) => {
      if (chrome.runtime.lastError || !r?.ok) setState(btn, 'fail', 'Buka aplikasi Sedot dulu (Start Menu), lalu klik lagi.');
      else setState(btn, 'ok');
    });
  }

  // ---------- Menu ----------
  function closeMenu() {
    document.getElementById(MENU_ID)?.remove();
    document.getElementById(BTN_ID)?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outside, true);
  }
  function outside(e) {
    if (!e.target.closest?.(`#${MENU_ID}, #${BTN_ID}`)) closeMenu();
  }

  async function openMenu(btn) {
    if (document.getElementById(MENU_ID)) { closeMenu(); return; }
    const want = videoId();
    let data = await askPage();
    if (data && data.videoId && want && data.videoId !== want) data = null; // data lama (pindah video tanpa muat ulang)
    if (data?.isLive) { send(btn, null); return; } // siaran langsung: biar aplikasi yang menjelaskan
    const items = menuItems(data);

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.className = 'sedot-menu';
    menu.setAttribute('role', 'menu');
    const head = document.createElement('div');
    head.className = 'sedot-menu-head';
    head.textContent = 'Unduh dengan Sedot';
    menu.append(head);
    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 'sedot-sep'; menu.append(s); continue; }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `sedot-item${it.more ? ' more' : ''}`;
      b.setAttribute('role', 'menuitem');
      const l = document.createElement('b');
      l.textContent = it.label;
      b.append(l);
      const t = document.createElement('span'); // selalu ada (boleh kosong) supaya kolom ukuran tetap rata kanan
      t.className = 'tag';
      t.textContent = it.tag || '';
      b.append(t);
      const dt = document.createElement('span');
      dt.className = 'd';
      dt.textContent = it.detail || '';
      b.append(dt);
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = it.size ? `${it.request?.kind === 'mp3' ? '~' : ''}${fmtSize(it.size)}` : '';
      b.append(sz);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        send(btn, it.request); // request null = buka dialog lengkap di Sedot
      });
      menu.append(b);
    }
    stop(menu);
    menu.addEventListener('keydown', (e) => {
      const list = [...menu.querySelectorAll('.sedot-item')];
      const i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); btn.focus(); }
    });
    btn.parentElement.append(menu);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', outside, true);
    menu.querySelector('.sedot-item')?.focus({ preventScroll: true });
  }

  function makeButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'sedot-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    btn.append(icon(), label);
    setState(btn, 'idle');
    stop(btn); // jangan sampai klik tombol ikut menjeda/memutar video
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (btn.dataset.state === 'sending') return;
      openMenu(btn);
    });
    return btn;
  }

  let lastVid = null;
  function ensure() {
    const vid = videoId();
    if (vid !== lastVid) { lastVid = vid; closeMenu(); }
    const player = vid && activePlayer();
    let btn = document.getElementById(BTN_ID);
    if (!player) { btn?.remove(); closeMenu(); return; }
    if (!btn) btn = makeButton();
    if (btn.parentElement !== player) { player.append(btn); closeMenu(); }
  }

  setInterval(ensure, 1000);
  document.addEventListener('yt-navigate-finish', ensure);
  ensure();
})();
