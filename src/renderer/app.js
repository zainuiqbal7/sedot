'use strict';
/* global sedot, SedotHelpers */

const H = SedotHelpers; // fungsi bersama dengan proses utama (src/helpers.js)

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  all: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  down: '<path d="M12 4v12M6 11l6 6 6-6M5 20h14"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
  puzzle: '<path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z"/>',
  power: '<path d="M12 3v9M6.3 7.3a8 8 0 1 0 11.4 0"/>',
  clip: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  Video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  Musik: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  Dokumen: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
  Gambar: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  Program: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01"/>',
  Arsip: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M10 13h4"/>',
  Lainnya: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ICONS.Lainnya}</svg>`;
document.querySelectorAll('[data-ic]').forEach((el) => { el.innerHTML = icon(el.dataset.ic); });

const STATUS = { active: 'Mengunduh', waiting: 'Antre', paused: 'Dijeda', complete: 'Selesai', error: 'Gagal', removed: 'Dihapus', merging: 'Menggabungkan…' };
const $ = (id) => document.getElementById(id);

let state = { items: [], stat: {}, bridge: 'off', engineError: null };
let filter = 'all';
let query = '';
let sortKey = 'smart';
let sortDir = 1;
const selected = new Set();
let anchor = null; // untuk shift+klik
let categories = [];

// ---------- Format ----------
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtEta(it) {
  if (it.status !== 'active' || !it.speed || !it.total) return '';
  let s = Math.round((it.total - it.done) / it.speed);
  if (s < 60) return `${s} dtk`;
  const m = Math.floor(s / 60); s %= 60;
  if (m < 60) return `${m} mnt ${s} dtk`;
  return `${Math.floor(m / 60)} jam ${m % 60} mnt`;
}
function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const statusText = (it) => (it.status === 'error' ? it.error || STATUS.error : STATUS[it.status] || it.status);

// ---------- Filter / sidebar ----------
const FIXED = [
  { id: 'all', label: 'Semua', ic: 'all', test: () => true },
  { id: 'active', label: 'Berjalan', ic: 'down', test: (i) => ['active', 'waiting', 'paused', 'merging'].includes(i.status) },
  { id: 'complete', label: 'Selesai', ic: 'check', test: (i) => i.status === 'complete' },
  { id: 'error', label: 'Gagal', ic: 'alert', test: (i) => i.status === 'error' },
];
function testFilter(i) {
  const f = FIXED.find((x) => x.id === filter);
  const okFilter = f ? f.test(i) : i.category === filter;
  return okFilter && (!query || i.name.toLowerCase().includes(query) || (i.description || '').toLowerCase().includes(query));
}
function renderSidebar() {
  const count = (t) => state.items.filter(t).length;
  const btn = (id, label, ic, n) => `<button data-f="${esc(id)}" aria-current="${filter === id}"><span class="ic">${icon(ic)}</span>${esc(label)}<span class="count">${n || ''}</span></button>`;
  let html = FIXED.map((f) => btn(f.id, f.label, f.ic, count(f.test))).join('');
  html += '<div class="group">Kategori</div>';
  html += categories.map((c) => btn(c, c, c, count((i) => i.category === c))).join('');
  if ($('filters').dataset.html !== html) { $('filters').innerHTML = html; $('filters').dataset.html = html; }
}
$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  filter = b.dataset.f;
  selected.clear();
  render();
});
$('search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });

// ---------- Pengurutan (klik judul kolom) ----------
document.querySelectorAll('th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey !== k) { sortKey = k; sortDir = k === 'name' ? 1 : -1; }
    else if (sortDir === (k === 'name' ? 1 : -1)) sortDir = -sortDir;
    else sortKey = 'smart'; // klik ketiga: kembali ke urutan bawaan
    render();
  });
});
function renderSortHeaders() {
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    const on = th.dataset.sort === sortKey;
    th.dataset.dir = on ? (sortDir > 0 ? 'asc' : 'desc') : '';
    th.setAttribute('aria-sort', on ? (sortDir > 0 ? 'ascending' : 'descending') : 'none');
  });
}

// ---------- Tabel ----------
const rowsEl = $('rows');
const rowMap = new Map();

function visible() { return H.sortItems(state.items.filter(testFilter), sortKey, sortDir); }

function render() {
  renderSidebar();
  renderSortHeaders();
  const list = visible();
  const seen = new Set();
  let prev = null;
  for (const it of list) {
    seen.add(it.gid);
    let tr = rowMap.get(it.gid);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.gid = it.gid;
      tr.innerHTML = `<td class="c-name"><div class="name"><span class="ic"></span><span class="t"></span></div></td>
        <td class="c-size"></td><td class="c-prog"><div class="bar"><i></i></div><div class="pct"></div></td>
        <td class="c-speed"></td><td class="c-eta"></td><td class="c-status"></td>`;
      rowMap.set(it.gid, tr);
    }
    updateRow(tr, it);
    // jaga urutan tanpa membangun ulang semua baris
    const want = prev ? prev.nextSibling : rowsEl.firstChild;
    if (want !== tr) rowsEl.insertBefore(tr, want);
    prev = tr;
  }
  for (const [gid, tr] of rowMap) if (!seen.has(gid)) { tr.remove(); rowMap.delete(gid); }
  for (const g of [...selected]) if (!seen.has(g)) selected.delete(g);

  $('empty').hidden = list.length > 0;
  $('empty').querySelector('.empty-title').textContent = state.items.length ? 'Tidak ada yang cocok' : 'Belum ada unduhan';
  $('emptyText').hidden = state.items.length > 0;
  $('btnAddEmpty').hidden = state.items.length > 0;

  renderStatus();
  updateButtons();
  renderDetailShell();
}

function updateRow(tr, it) {
  const c = tr.children;
  const ic = c[0].querySelector('.ic');
  if (ic.dataset.cat !== it.category) { ic.innerHTML = icon(it.category); ic.dataset.cat = it.category; }
  c[0].querySelector('.t').textContent = it.name;
  c[0].title = [it.name, it.description, it.url].filter(Boolean).join('\n');
  c[1].textContent = it.total ? (it.status === 'complete' ? fmtBytes(it.total) : `${fmtBytes(it.done)} / ${fmtBytes(it.total)}`) : (it.done ? fmtBytes(it.done) : '—');
  const pct = it.total ? Math.floor((it.done / it.total) * 100) : (it.status === 'complete' ? 100 : 0);
  const bar = c[2].firstChild;
  bar.className = `bar${it.status === 'error' ? ' err' : it.status === 'complete' ? ' ok' : it.status === 'merging' ? ' busy' : ''}`;
  bar.firstChild.style.width = `${pct}%`;
  const known = it.total > 0 || it.status === 'complete';
  c[2].lastChild.textContent = !known ? (it.status === 'error' ? '' : '—') : `${pct}%${it.status === 'active' && it.connections ? ` · ${it.connections} koneksi` : ''}`;
  c[3].textContent = it.status === 'active' ? `${fmtBytes(it.speed)}/s` : '';
  c[4].textContent = fmtEta(it);
  c[5].textContent = statusText(it);
  c[5].className = `c-status st-${it.status}`;
  c[5].title = it.errorHint || '';
  tr.classList.toggle('sel', selected.has(it.gid));
}

function renderStatus() {
  $('sbSpeed').textContent = `↓ ${fmtBytes(state.stat.speed || 0)}/s`;
  $('sbActive').textContent = state.stat.active ? `${state.stat.active} aktif` : '';

  const b = $('sbBridge');
  const seen = !!state.extensionSeen;
  if (state.bridge === 'port-in-use') b.textContent = 'Ekstensi: port 17345 dipakai program lain';
  else if (state.bridge === 'error') b.textContent = 'Ekstensi: penghubung gagal dinyalakan';
  else b.textContent = seen ? 'Ekstensi browser: terhubung' : 'Ekstensi browser: belum terdeteksi';
  b.className = `link small${seen && state.bridge === 'on' ? ' on' : ''}`;
  b.title = 'Panduan memasang ekstensi browser';
  $('btnExtGuide').hidden = seen;

  const u = state.update;
  $('sbUpdate').textContent = !u ? '' : u.status === 'downloading' ? `Mengunduh update ${u.version}… ${u.percent || 0}%` : `Versi ${u.version} siap`;
  $('btnUpdate').hidden = u?.status !== 'ready';

  if (document.activeElement !== $('afterAll')) $('afterAll').value = state.afterAll || 'none';

  const cd = state.countdown;
  $('countdown').hidden = !cd;
  if (cd) $('countdownText').textContent = `Semua unduhan selesai. ${cd.label} dalam ${cd.left} detik.`;

  $('offer').hidden = !state.offer;
  if (state.offer) {
    $('offerLead').textContent = state.offer.video ? 'Link video disalin:' : 'Link unduhan disalin:';
    $('offerName').textContent = state.offer.name || state.offer.url;
    $('btnOfferYes').textContent = state.offer.video ? 'Unduh video' : 'Unduh';
  }

  const banner = $('banner');
  banner.hidden = !state.engineError;
  banner.textContent = state.engineError || '';
}

function selItems() { return state.items.filter((i) => selected.has(i.gid)); }
function updateButtons() {
  const s = selItems();
  $('btnPause').disabled = !s.some((i) => i.status === 'active' || i.status === 'waiting');
  $('btnResume').disabled = !s.some((i) => i.status === 'paused' || i.status === 'error');
  $('btnRemove').disabled = s.length === 0;
}

function selectOnly(gid) { selected.clear(); selected.add(gid); anchor = gid; detailClosed = false; }

rowsEl.addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const gid = tr.dataset.gid;
  if (e.shiftKey && anchor) {
    const ids = visible().map((i) => i.gid);
    const [a, b] = [ids.indexOf(anchor), ids.indexOf(gid)].sort((x, y) => x - y);
    if (!e.ctrlKey) selected.clear();
    ids.slice(a, b + 1).forEach((g) => selected.add(g));
  } else if (e.ctrlKey || e.metaKey) {
    selected.has(gid) ? selected.delete(gid) : selected.add(gid);
    anchor = gid;
  } else {
    selectOnly(gid);
  }
  render();
  refreshDetail();
});
// Klik di area kosong tabel = batal pilih
$('tableWrap').addEventListener('click', (e) => {
  if (e.target.closest('tr') || e.target.closest('button')) return;
  selected.clear();
  render();
});
rowsEl.addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr');
  if (tr) openOrReveal(tr.dataset.gid);
});
async function openOrReveal(gid) {
  const it = state.items.find((i) => i.gid === gid);
  if (it?.status === 'complete') {
    const err = await sedot.open(gid);
    if (err) alert(err);
  } else sedot.reveal(gid);
}

// ---------- Klik kanan ----------
rowsEl.addEventListener('contextmenu', async (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  e.preventDefault();
  if (!selected.has(tr.dataset.gid)) { selectOnly(tr.dataset.gid); render(); refreshDetail(); }
  const s = selItems();
  const one = s.length === 1 ? s[0] : null;
  const canPause = s.some((i) => i.status === 'active' || i.status === 'waiting');
  const canResume = s.some((i) => i.status === 'paused' || i.status === 'error');
  const items = [
    { id: 'open', label: 'Buka file', accel: 'Enter', enabled: one?.status === 'complete' },
    { id: 'reveal', label: 'Buka folder', enabled: !!one },
    { sep: true },
    { id: 'resume', label: one?.status === 'error' ? 'Coba lagi' : 'Lanjutkan', accel: 'Space', enabled: canResume },
    { id: 'pause', label: 'Jeda', accel: 'Space', enabled: canPause },
    { id: 'replace', label: 'Ganti link…', enabled: !!one && one.status !== 'complete' && !one.isVideo },
    { sep: true },
    { id: 'copy', label: s.length > 1 ? `Salin ${s.length} link` : 'Salin link', enabled: s.some((i) => i.url) },
    { sep: true },
    { id: 'remove', label: s.length > 1 ? `Hapus ${s.length} unduhan…` : 'Hapus…', accel: 'Delete' },
  ];
  const id = await sedot.contextMenu(items);
  runAction(id);
});

function runAction(id) {
  const s = selItems();
  const one = s.length === 1 ? s[0] : null;
  if (id === 'open' && one) openOrReveal(one.gid);
  else if (id === 'reveal' && one) sedot.reveal(one.gid);
  else if (id === 'resume') sedot.resume([...selected]);
  else if (id === 'pause') sedot.pause([...selected]);
  else if (id === 'replace' && one) openReplace(one);
  else if (id === 'copy') sedot.copyText(s.map((i) => i.url).filter(Boolean).join('\n'));
  else if (id === 'remove') openRemove();
}

// ---------- Panel detail ----------
let detailClosed = false;
let detailGid = null;
let detailData = null;

function detailTarget() {
  if (detailClosed || selected.size !== 1) return null;
  return state.items.find((i) => selected.has(i.gid)) || null;
}

function renderDetailShell() {
  const it = detailTarget();
  $('detail').hidden = !it;
  if (!it) { detailGid = null; return; }
  if (detailGid !== it.gid) { detailGid = it.gid; detailData = null; refreshDetail(); }
  $('dIcon').innerHTML = icon(it.category);
  $('dName').textContent = it.name;
  $('dName').title = it.name;
  $('dOpen').hidden = it.status !== 'complete';
  $('dReplace').hidden = it.status === 'complete' || !!it.isVideo;
  $('dConnTitle').textContent = it.isVideo ? 'Bagian' : 'Koneksi';
  const err = it.status === 'error';
  $('dError').hidden = !err;
  if (err) { $('dErrorText').textContent = `${it.error}.`; $('dErrorHint').textContent = it.errorHint || ''; $('dError').title = it.errorRaw || ''; }
  drawSegments(it);
}

function drawSegments(it) {
  const seg = $('dSeg');
  const complete = it.status === 'complete';
  let runs;
  if (complete) runs = [{ from: 0, to: 1 }];
  else if (detailData?.gid === it.gid && detailData.numPieces) runs = H.bitfieldRuns(detailData.bitfield, detailData.numPieces);
  else runs = it.total ? [{ from: 0, to: it.done / it.total }] : [];
  if (!runs.length && it.done > 0 && it.total) runs = [{ from: 0, to: it.done / it.total }];
  // Digambar lewat DOM (bukan atribut style di HTML) karena CSP aplikasi melarang style inline.
  const key = runs.map((r) => `${r.from.toFixed(4)}-${r.to.toFixed(4)}`).join(',');
  if (seg.dataset.key !== key) {
    seg.replaceChildren(...runs.map((r) => {
      const el = document.createElement('i');
      el.style.left = `${(r.from * 100).toFixed(3)}%`;
      el.style.width = `${Math.max(0.15, (r.to - r.from) * 100).toFixed(3)}%`;
      return el;
    }));
    seg.dataset.key = key;
  }
  seg.className = `seg${it.status === 'error' ? ' err' : complete ? ' ok' : ''}`;
  const pct = it.total ? Math.floor((it.done / it.total) * 100) : complete ? 100 : 0;
  const pieces = detailData?.numPieces ? ` · ${detailData.numPieces} potongan` : '';
  $('dSegText').textContent = it.total ? `${fmtBytes(it.done)} dari ${fmtBytes(it.total)} (${pct}%)${complete ? '' : pieces}` : complete ? 'Selesai' : 'Ukuran belum diketahui';
}

async function refreshDetail() {
  const it = detailTarget();
  if (!it) return;
  const d = await sedot.detail(it.gid);
  if (!d || d.gid !== detailTarget()?.gid) return;
  detailData = d;
  $('dPath').textContent = d.path || (d.isVideo ? `${d.dir} (dibuat setelah selesai digabung)` : '(belum dibuat)');
  $('dPath').title = d.path || d.dir || '';
  $('dUrl').textContent = d.url || '—';
  $('dUrl').title = d.url || '';
  $('dCopy').disabled = !d.url;
  $('dAdded').textContent = fmtTime(d.addedAt);
  const complete = d.status === 'complete';
  $('dDoneLbl').hidden = !complete;
  $('dDone').hidden = !complete;
  $('dDone').textContent = fmtTime(d.doneAt);
  $('dNoteLbl').hidden = !d.description;
  $('dNote').hidden = !d.description;
  $('dNote').textContent = d.description;
  $('dSide').hidden = complete;
  if (!complete) {
    const conns = d.connections || [];
    $('dConns').innerHTML = conns.length
      ? conns.map((c, i) => `<li><span>${d.isVideo ? '' : `${i + 1}. `}${esc(c.host)}</span><span>${c.speed || !d.isVideo ? `${fmtBytes(c.speed)}/s` : ''}</span></li>`).join('')
      : `<li class="muted">${d.status === 'active' ? 'Menyambung…' : 'Tidak ada koneksi aktif'}</li>`;
    $('dLimitWrap').hidden = d.status === 'merging';
    if (document.activeElement !== $('dLimit')) $('dLimit').value = d.limitKB || 0;
  }
  drawSegments(state.items.find((i) => i.gid === d.gid) || d);
}
setInterval(() => { if (!$('detail').hidden && !document.hidden) refreshDetail(); }, 1000);

$('dClose').onclick = () => { detailClosed = true; render(); };
$('dOpen').onclick = () => detailGid && openOrReveal(detailGid);
$('dReveal').onclick = () => detailGid && sedot.reveal(detailGid);
$('dCopy').onclick = () => detailData?.url && sedot.copyText(detailData.url);
$('dReplace').onclick = () => { const it = detailTarget(); if (it) openReplace(it); };
$('dLimitApply').onclick = async () => {
  if (!detailGid) return;
  await sedot.setLimit(detailGid, Number($('dLimit').value) || 0);
  $('dLimitApply').textContent = 'Diterapkan';
  setTimeout(() => { $('dLimitApply').textContent = 'Terapkan'; }, 1500);
};
$('dLimit').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('dLimitApply').click(); });

// ---------- Ganti link ----------
let replaceGid = null;
function openReplace(it) {
  replaceGid = it.gid;
  $('replaceName').textContent = it.name;
  $('replaceUrl').value = '';
  $('replaceError').hidden = true;
  $('dlgReplace').showModal();
  $('replaceUrl').focus();
}
$('formReplace').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('replaceSubmit').disabled = true;
  const r = await sedot.replaceUrl(replaceGid, $('replaceUrl').value);
  $('replaceSubmit').disabled = false;
  if (r?.error) { $('replaceError').textContent = r.error; $('replaceError').hidden = false; return; }
  $('dlgReplace').close();
});

// ---------- Aksi ----------
$('btnPause').onclick = () => sedot.pause([...selected]);
$('btnResume').onclick = () => sedot.resume([...selected]);
$('btnPauseAll').onclick = () => sedot.pauseAll();
$('btnResumeAll').onclick = () => sedot.resumeAll();
$('btnRemove').onclick = openRemove;
$('btnAdd').onclick = openAdd;
$('btnAddEmpty').onclick = openAdd;
$('btnSettings').onclick = openSettings;
$('btnUpdate').onclick = () => sedot.installUpdate();
$('btnCancelCountdown').onclick = () => sedot.cancelCountdown();
$('afterAll').onchange = (e) => sedot.setAfterAll(e.target.value);
$('btnOfferYes').onclick = () => sedot.acceptOffer();
$('btnOfferNo').onclick = () => sedot.dismissOffer();
$('sbBridge').onclick = () => openExtGuide();
$('btnExtGuide').onclick = () => openExtGuide();
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
  if (e.target.matches('input, textarea, select')) {
    if (e.key === 'Escape' && e.target === $('search')) { $('search').value = ''; query = ''; e.target.blur(); render(); }
    return;
  }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); openAdd(); }
  else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); visible().forEach((i) => selected.add(i.gid)); render(); }
  else if (e.key === 'Delete' && selected.size) openRemove();
  else if (e.key === 'Escape') { if (!$('detail').hidden) { detailClosed = true; } else selected.clear(); render(); }
  else if (e.key === ' ' && selected.size) {
    e.preventDefault();
    const s = selItems();
    if (s.some((i) => i.status === 'active' || i.status === 'waiting')) sedot.pause([...selected]);
    else sedot.resume([...selected]);
  } else if (e.key === 'Enter' && selected.size === 1) openOrReveal([...selected][0]);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const ids = visible().map((i) => i.gid);
    if (!ids.length) return;
    const cur = anchor ? ids.indexOf(anchor) : -1;
    const next = ids[Math.max(0, Math.min(ids.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))];
    selectOnly(next);
    render();
    refreshDetail();
    rowMap.get(next)?.scrollIntoView({ block: 'nearest' });
  }
});

// ---------- Seret & lepas link ke jendela ----------
let dragDepth = 0;
const linksFrom = (dt) => (dt.getData('text/uri-list') || dt.getData('text/plain') || '')
  .split(/\r?\n/).map((s) => s.trim()).filter((s) => /^(https?|ftp):\/\//i.test(s));
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropHint').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropHint').hidden = true;
  const urls = linksFrom(e.dataTransfer);
  if (urls.length === 1) sedot.addViaDialog(urls[0]);
  else if (urls.length > 1) sedot.add(urls);
});

// Tambah
async function openAdd() {
  const s = await sedot.getSettings();
  $('addDir').value = s.downloadDir;
  $('addError').hidden = true;
  let clip = '';
  try { clip = (await navigator.clipboard.readText()).trim(); } catch { /* tidak ada izin */ }
  $('addUrls').value = /^(https?|ftp):\/\/\S+$/i.test(clip) ? clip : '';
  $('dlgAdd').showModal();
  $('addUrls').focus();
}
$('addDirPick').onclick = async () => { const d = await sedot.chooseDir(); if (d) $('addDir').value = d; };
$('addUrls').addEventListener('input', () => { $('addError').hidden = true; });
$('formAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const urls = $('addUrls').value.split(/\s+/).filter(Boolean);
  if (!urls.length) { showAddError('Tempel minimal satu link.'); return; }
  $('addSubmit').disabled = true;
  try {
    const res = await sedot.add(urls, $('addDir').value.trim());
    const bad = res.filter((r) => r.error);
    if (bad.length) {
      showAddError(bad.map((b) => `${b.url}: ${b.error}`).join('\n'));
      $('addUrls').value = bad.map((b) => b.url).join('\n');
    } else $('dlgAdd').close();
  } finally {
    $('addSubmit').disabled = false;
  }
});
function showAddError(msg) { $('addError').textContent = msg; $('addError').hidden = false; }

// Hapus
function openRemove() {
  const s = selItems();
  if (!s.length) return;
  $('removeTitle').textContent = s.length === 1 ? `Hapus "${s[0].name}"?` : `Hapus ${s.length} unduhan?`;
  $('removeNames').textContent = s.length > 1 ? s.slice(0, 5).map((i) => i.name).join(', ') + (s.length > 5 ? ', …' : '') : '';
  $('removeFiles').checked = false;
  $('removeSubmit').textContent = s.length === 1 ? 'Hapus unduhan' : `Hapus ${s.length} unduhan`;
  $('dlgRemove').showModal();
}
$('removeFiles').addEventListener('change', (e) => {
  const n = selected.size;
  $('removeSubmit').textContent = e.target.checked ? (n === 1 ? 'Hapus unduhan + file' : `Hapus ${n} unduhan + file`) : (n === 1 ? 'Hapus unduhan' : `Hapus ${n} unduhan`);
});
$('formRemove').addEventListener('submit', async (e) => {
  e.preventDefault();
  await sedot.remove([...selected], $('removeFiles').checked);
  selected.clear();
  $('dlgRemove').close();
});

// Panduan ekstensi
async function openExtGuide(welcome = false) {
  const info = await sedot.extensionInfo();
  $('extTitle').textContent = welcome ? 'Selamat datang di Sedot' : 'Pasang ekstensi browser';
  $('extDir').textContent = info.dir;
  $('extStatus').textContent = info.seen
    ? 'Ekstensi sudah terhubung. Kalau sebelumnya kamu memasang ekstensi Sedot dari file zip, hapus yang lama (Remove) supaya unduhan tidak masuk dua kali.'
    : 'Status: ekstensi belum terdeteksi. Setelah dipasang, klik ikon Sedot di toolbar browser sekali.';
  $('extStatus').className = `ext-status${info.seen ? ' on' : ''}`;
  $('dlgExt').showModal();
}
$('extOpenDir').onclick = () => sedot.openExtensionDir();
$('extCopyUrl').onclick = () => { sedot.copyText('chrome://extensions'); $('extCopyUrl').textContent = 'Tersalin'; setTimeout(() => { $('extCopyUrl').textContent = 'Salin'; }, 1500); };
$('dlgExt').addEventListener('close', () => sedot.setSettings({ onboarded: true }));
$('setExt').onclick = () => { $('dlgSettings').close(); openExtGuide(); };

// Pengaturan
async function openSettings() {
  const s = await sedot.getSettings();
  $('setDir').value = s.downloadDir;
  $('setConn').value = s.connections;
  $('setConc').value = s.maxConcurrent;
  $('setLimit').value = s.speedLimitKB;
  $('setCat').checked = s.categorize;
  $('setTray').checked = s.minimizeToTray;
  $('setNotify').checked = s.notify;
  $('setAsk').checked = s.askBeforeDownload;
  $('setLogin').checked = s.openAtLogin;
  $('setClip').checked = s.watchClipboard;
  $('setSleep').checked = s.preventSleep;
  $('dlgSettings').showModal();
}
$('setDirPick').onclick = async () => { const d = await sedot.chooseDir(); if (d) $('setDir').value = d; };
$('formSettings').addEventListener('submit', async (e) => {
  e.preventDefault();
  await sedot.setSettings({
    downloadDir: $('setDir').value,
    connections: +$('setConn').value,
    maxConcurrent: +$('setConc').value,
    speedLimitKB: +$('setLimit').value,
    categorize: $('setCat').checked,
    minimizeToTray: $('setTray').checked,
    notify: $('setNotify').checked,
    askBeforeDownload: $('setAsk').checked,
    openAtLogin: $('setLogin').checked,
    watchClipboard: $('setClip').checked,
    preventSleep: $('setSleep').checked,
  });
  $('dlgSettings').close();
});

// ---------- Mulai ----------
(async () => {
  categories = (await sedot.categories()).filter((c) => c !== 'Lainnya').concat('Lainnya');
  $('version').textContent = `Versi ${await sedot.version()}`;
  state = await sedot.state();
  render();
  sedot.onState((s) => { state = s; render(); });
  const s = await sedot.getSettings();
  if (!s.onboarded) openExtGuide(true);
})();
