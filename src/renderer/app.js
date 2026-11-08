'use strict';
/* global sedot */

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

const STATUS = { active: 'Mengunduh', waiting: 'Antre', paused: 'Dijeda', complete: 'Selesai', error: 'Gagal', removed: 'Dihapus' };
const $ = (id) => document.getElementById(id);

let state = { items: [], stat: {}, bridge: 'off', engineError: null };
let filter = 'all';
let query = '';
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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Filter / sidebar ----------
const FIXED = [
  { id: 'all', label: 'Semua', ic: 'all', test: () => true },
  { id: 'active', label: 'Berjalan', ic: 'down', test: (i) => ['active', 'waiting', 'paused'].includes(i.status) },
  { id: 'complete', label: 'Selesai', ic: 'check', test: (i) => i.status === 'complete' },
  { id: 'error', label: 'Gagal', ic: 'alert', test: (i) => i.status === 'error' },
];
function testFilter(i) {
  const f = FIXED.find((x) => x.id === filter);
  const okFilter = f ? f.test(i) : i.category === filter;
  return okFilter && (!query || i.name.toLowerCase().includes(query));
}
function renderSidebar() {
  const count = (t) => state.items.filter(t).length;
  const btn = (id, label, ic, n) => `<button data-f="${esc(id)}" aria-current="${filter === id}"><span class="ic">${icon(ic)}</span>${esc(label)}<span class="count">${n || ''}</span></button>`;
  let html = FIXED.map((f) => btn(f.id, f.label, f.ic, count(f.test))).join('');
  html += '<div class="group">Kategori</div>';
  html += categories.map((c) => btn(c, c, c, count((i) => i.category === c))).join('');
  $('filters').innerHTML = html;
}
$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  filter = b.dataset.f;
  selected.clear();
  render();
});
$('search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });

// ---------- Tabel ----------
const rowsEl = $('rows');
const rowMap = new Map();

function visible() { return state.items.filter(testFilter); }

function render() {
  renderSidebar();
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
  $('empty').querySelector('p:nth-child(2)').hidden = state.items.length > 0;
  $('btnAddEmpty').hidden = state.items.length > 0;

  renderStatus();
  updateButtons();
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
  bar.className = `bar${it.status === 'error' ? ' err' : it.status === 'complete' ? ' ok' : ''}`;
  bar.firstChild.style.width = `${pct}%`;
  const known = it.total > 0 || it.status === 'complete';
  c[2].lastChild.textContent = !known ? (it.status === 'error' ? '' : '—') : `${pct}%${it.status === 'active' && it.connections ? ` · ${it.connections} koneksi` : ''}`;
  c[3].textContent = it.status === 'active' ? `${fmtBytes(it.speed)}/s` : '';
  c[4].textContent = fmtEta(it);
  c[5].textContent = STATUS[it.status] || it.status;
  c[5].className = `c-status st-${it.status}`;
  c[5].title = it.error || '';
  tr.classList.toggle('sel', selected.has(it.gid));
}

function renderStatus() {
  $('sbSpeed').textContent = `↓ ${fmtBytes(state.stat.speed || 0)}/s`;
  $('sbActive').textContent = state.stat.active ? `${state.stat.active} aktif` : '';
  const b = $('sbBridge');
  const label = { on: 'Ekstensi browser: siap', 'port-in-use': 'Ekstensi browser: port 17345 dipakai program lain', error: 'Ekstensi browser: gagal dinyalakan', off: '' };
  b.textContent = label[state.bridge] ?? '';
  b.className = state.bridge === 'on' ? 'on' : '';
  const u = state.update;
  $('sbUpdate').textContent = !u ? '' : u.status === 'downloading' ? `Mengunduh update ${u.version}… ${u.percent || 0}%` : `Versi ${u.version} siap`;
  $('btnUpdate').hidden = u?.status !== 'ready';
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
    selected.clear(); selected.add(gid); anchor = gid;
  }
  render();
});
rowsEl.addEventListener('dblclick', async (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const it = state.items.find((i) => i.gid === tr.dataset.gid);
  if (it?.status === 'complete') {
    const err = await sedot.open(it.gid);
    if (err) alert(err);
  } else sedot.reveal(tr.dataset.gid);
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
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || e.target.matches('input, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); openAdd(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); visible().forEach((i) => selected.add(i.gid)); render(); }
  else if (e.key === 'Delete' && selected.size) openRemove();
  else if (e.key === ' ' && selected.size) {
    e.preventDefault();
    const s = selItems();
    if (s.some((i) => i.status === 'active' || i.status === 'waiting')) sedot.pause([...selected]);
    else sedot.resume([...selected]);
  } else if (e.key === 'Enter' && selected.size === 1) rowsEl.querySelector('tr.sel')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
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
})();
