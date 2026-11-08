'use strict';
/* global job */

const ICONS = {
  Video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  Musik: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  Dokumen: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
  Gambar: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  Program: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01"/>',
  Arsip: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M10 13h4"/>',
  Lainnya: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ICONS.Lainnya}</svg>`;
const $ = (id) => document.getElementById(id);

function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

let dirs = {};
const dirty = new Set(); // kolom yang sudah diubah pengguna tidak ditimpa hasil deteksi otomatis

function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }

function showInfo(info) {
  $('url').value = info.url;
  if (!dirty.has('filename') && info.filename) $('filename').value = info.filename;
  if (!dirty.has('category')) $('category').value = info.category;
  if (!dirty.has('dir')) $('dir').value = dirs[$('category').value] || info.dir;
  refreshHeader();

  const size = $('size');
  if (info.probing) { size.textContent = 'Memeriksa…'; size.className = 'size wait'; }
  else if (info.size) { size.textContent = fmtBytes(info.size); size.className = 'size'; }
  else { size.textContent = 'Ukuran tidak diketahui'; size.className = 'size wait'; }

  const parts = [hostOf(info.url)];
  if (!info.probing) {
    if (info.probeError) parts.push(`server belum menjawab (${info.probeError}); unduhan tetap bisa dicoba`);
    else parts.push(info.resumable ? 'bisa dijeda & dilanjutkan' : 'server tidak mendukung lanjut/potong, unduh dengan 1 koneksi');
  }
  $('sub').textContent = parts.filter(Boolean).join(' · ');

  // File yang dulu gagal/terjeda: tawarkan lanjut dengan link baru
  resume = info.resume || null;
  $('resumeBox').hidden = !resume;
  if (resume) {
    const why = resume.status === 'error' ? (resume.error || 'gagal') : resume.status === 'paused' ? 'dijeda' : 'menunggu';
    $('resumeTitle').textContent = `Lanjutkan unduhan lama dari ${resume.pct}%`;
    $('resumeText').textContent = `"${resume.name}" pernah diunduh sebagian (${why.toLowerCase()}). Bagian yang sudah ada dipakai, sisanya diambil lewat link baru ini.`;
  }
  dup = info.duplicate || null;
  $('dupBox').hidden = !dup || !!resume;
  if (dup) {
    $('dupText').textContent = dup.status === 'active' ? 'File ini sedang diunduh di Sedot.' : 'File dengan nama & ukuran sama sudah pernah diunduh. Kalau dilanjutkan, file baru diberi nama berbeda.';
    $('dupReveal').hidden = dup.status !== 'complete';
  }
  applyResumeLock();
  fit();
}

let resume = null;
let dup = null;

function applyResumeLock() {
  const lock = !!resume && $('resumeChk').checked;
  for (const id of ['category', 'filename', 'dir', 'pick', 'remember']) $(id).disabled = lock;
  document.querySelector('.fields').classList.toggle('locked', lock);
  $('start').textContent = lock ? 'Lanjutkan unduh' : 'Mulai unduh';
}

/** Sesuaikan tinggi jendela dengan isi (kotak tambahan bisa muncul setelah deteksi). */
function fit() {
  const f = $('form');
  const cs = getComputedStyle(f);
  const kids = [...f.children].filter((k) => !k.hidden && k.offsetParent !== null);
  const h = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + kids.reduce((a, k) => a + k.offsetHeight, 0) + (kids.length - 1) * 12;
  job.resize(h);
}

$('resumeChk').addEventListener('change', applyResumeLock);
$('dupReveal').onclick = () => job.reveal();

function refreshHeader() {
  const cat = $('category').value;
  $('title').textContent = $('filename').value || '(nama ditentukan server)';
  $('title').title = $('title').textContent;
  $('typeIcon').innerHTML = icon(cat);
  $('rememberText').textContent = `Ingat folder ini untuk kategori "${cat}"`;
}

$('filename').addEventListener('input', () => { dirty.add('filename'); refreshHeader(); });
$('category').addEventListener('change', () => {
  dirty.add('category');
  if (!dirty.has('dir')) $('dir').value = dirs[$('category').value] || $('dir').value;
  refreshHeader();
});
$('dir').addEventListener('input', () => dirty.add('dir'));
$('pick').onclick = async () => {
  const d = await job.chooseDir($('dir').value);
  if (d) { $('dir').value = d; dirty.add('dir'); }
};

let busy = false;
async function decide(action) {
  if (busy) return;
  busy = true;
  $('error').hidden = true;
  for (const b of ['start', 'later', 'cancel']) $(b).disabled = true;
  const r = await job.decide({
    action,
    dir: $('dir').value,
    filename: $('filename').value,
    category: $('category').value,
    remember: $('remember').checked,
    description: $('desc').value,
    dontAsk: $('dontAsk').checked,
    resumeGid: resume && $('resumeChk').checked ? resume.gid : undefined,
  });
  if (r?.error) {
    $('error').textContent = r.error;
    $('error').hidden = false;
    for (const b of ['start', 'later', 'cancel']) $(b).disabled = false;
    busy = false;
  }
}

$('form').addEventListener('submit', (e) => { e.preventDefault(); decide('start'); });
$('later').onclick = () => decide('later');
$('cancel').onclick = () => decide('cancel');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') decide('cancel'); });

(async () => {
  const data = await job.get();
  if (!data) { $('title').textContent = 'Dialog sudah tidak berlaku'; return; }
  dirs = data.dirs;
  $('category').innerHTML = data.categories.map((c) => `<option>${c}</option>`).join('');
  showInfo(data.info);
  job.onUpdate(showInfo);
  $('start').focus();
})();
