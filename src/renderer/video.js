'use strict';
/* global vid */

const $ = (id) => document.getElementById(id);
let info = null;
let dirDirty = false;

function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtDur(s) {
  s = Math.round(s || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function show(next) {
  info = next;
  const ready = info.state === 'ready';
  $('busy').hidden = ready;
  $('form').hidden = !ready;
  if (!ready) return showBusy();
  renderReady();
}

function showBusy() {
  const err = info.state === 'error';
  $('spinner').className = `spinner${err ? ' err' : ''}`;
  $('busyActions').hidden = !err;
  $('busyBar').hidden = info.state !== 'tools';
  if (info.state === 'tools') {
    $('busyTitle').textContent = 'Menyiapkan komponen video (sekali saja)';
    const pct = info.total ? Math.floor((info.done / info.total) * 100) : 0;
    $('busyFill').style.width = `${pct}%`;
    $('busyText').textContent = info.step === 'ekstrak' ? 'Memasang…' : `Mengunduh yt-dlp & ffmpeg: ${fmtBytes(info.done) || '0 MB'} dari ${fmtBytes(info.total) || '±115 MB'}`;
  } else if (err) {
    $('busyTitle').textContent = 'Video tidak bisa diunduh';
    $('busyText').textContent = info.message;
  } else {
    $('busyTitle').textContent = 'Membaca info video…';
    $('busyText').textContent = host(info.url);
  }
  vid.resize(err ? 260 : 220);
}

function renderReady() {
  $('title').textContent = info.title;
  $('title').title = info.title;
  $('meta').textContent = [info.uploader, fmtDur(info.duration), info.site].filter(Boolean).join(' · ');
  $('thumb').hidden = !info.thumbnail;
  if (info.thumbnail) $('thumb').src = info.thumbnail;

  const box = $('choices');
  if (!box.dataset.done) {
    const vids = info.choices.filter((c) => c.kind === 'video');
    const auds = info.choices.filter((c) => c.kind === 'audio');
    const row = (c) => `<label class="choice"><input type="radio" name="q" value="${c.id}"><span><b>${esc(c.label)}</b> <span class="d">${esc(c.detail || '')}</span></span><span class="sz">${c.size ? `~${fmtBytes(c.size)}` : ''}</span></label>`;
    box.innerHTML = vids.map(row).join('') + (auds.length && vids.length ? '<div class="sep-row">Audio saja</div>' : '') + auds.map(row).join('');
    const def = box.querySelector(`input[value="${CSS.escape(info.defaultChoice || '')}"]`) || box.querySelector('input');
    if (def) def.checked = true;
    box.dataset.done = '1';

    $('subsBox').hidden = !info.subtitles.length;
    $('subs').innerHTML = info.subtitles.map((s) => `<label><input type="checkbox" value="${esc(s.lang)}"${s.lang === 'id' ? ' checked' : ''}> ${esc(s.name)}</label>`).join('');
    $('filename').value = info.fileTitle;
    $('dir').value = info.dirs.video;
    onChoice();
  }

  $('resumeBox').hidden = !info.resume;
  if (info.resume) $('resumeTitle').textContent = `Lanjutkan unduhan lama dari ${info.resume.pct}% (${info.resume.label})`;
  applyLock();
  fit();
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function current() {
  const id = $('choices').querySelector('input:checked')?.value;
  return info.choices.find((c) => c.id === id) || null;
}

function onChoice() {
  const c = current();
  if (!c) return;
  $('ext').textContent = `.${c.out}`;
  if (!dirDirty) $('dir').value = c.kind === 'audio' ? info.dirs.audio : info.dirs.video;
  $('subsBox').hidden = !info.subtitles.length || c.kind === 'audio';
  fit();
}

function applyLock() {
  const lock = !!info.resume && $('resumeChk').checked;
  $('choices').classList.toggle('locked', lock);
  for (const id of ['filename', 'dir', 'pick']) $(id).disabled = lock;
  $('subs').querySelectorAll('input').forEach((i) => { i.disabled = lock; });
  $('start').textContent = lock ? 'Lanjutkan unduh' : 'Mulai unduh';
}

function fit() {
  const f = $('form');
  const cs = getComputedStyle(f);
  const kids = [...f.children].filter((k) => !k.hidden && k.offsetParent !== null);
  vid.resize(parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + kids.reduce((a, k) => a + k.offsetHeight, 0) + (kids.length - 1) * 12);
}

$('choices').addEventListener('change', onChoice);
$('resumeChk').addEventListener('change', applyLock);
$('dir').addEventListener('input', () => { dirDirty = true; });
$('pick').onclick = async () => { const d = await vid.chooseDir($('dir').value); if (d) { $('dir').value = d; dirDirty = true; } };
$('retry').onclick = () => vid.retry();
$('close2').onclick = () => vid.decide({ action: 'cancel' });

let busy = false;
async function decide(action) {
  if (busy) return;
  const c = current();
  if (action !== 'cancel' && !c && !(info.resume && $('resumeChk').checked)) return;
  busy = true;
  $('error').hidden = true;
  for (const b of ['start', 'later', 'cancel']) $(b).disabled = true;
  const r = await vid.decide({
    action,
    choiceId: c?.id,
    title: $('filename').value,
    dir: $('dir').value,
    subs: c?.kind === 'video' ? [...$('subs').querySelectorAll('input:checked')].map((i) => i.value) : [],
    resumeId: info.resume && $('resumeChk').checked ? info.resume.id : undefined,
  });
  if (r?.error) {
    $('error').textContent = r.error;
    $('error').hidden = false;
    for (const b of ['start', 'later', 'cancel']) $(b).disabled = false;
    busy = false;
    fit();
  }
}
$('form').addEventListener('submit', (e) => { e.preventDefault(); decide('start'); });
$('later').onclick = () => decide('later');
$('cancel').onclick = () => decide('cancel');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') vid.decide({ action: 'cancel' }); });

(async () => {
  const first = await vid.get();
  if (first) show(first);
  vid.onUpdate(show);
})();
