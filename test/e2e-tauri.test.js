'use strict';
// Uji menyeluruh versi Rust/Tauri: aplikasi sungguhan dikendalikan lewat WebDriver (tauri-driver + WebKitWebDriver).
// Setara test/e2e.test.js, ditambah: pindah data dari versi Electron dan pengukuran RAM.
// Jalankan (Linux): cargo build -p sedot && xvfb-run -a node test/e2e-tauri.test.js
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = process.env.SEDOT_BIN || path.join(ROOT, 'target', 'debug', 'sedot');
const OUT = process.env.E2E_SHOTS || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
async function waitFor(fn, ms = 30000, what = 'kondisi') {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    const v = await fn().catch((e) => { last = e; return null; });
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout menunggu ${what}${last ? ` (error terakhir: ${last.message})` : ''}`);
    await sleep(250);
  }
}
for (const bin of ['tauri-driver', 'WebKitWebDriver', 'aria2c', 'xclip']) {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); } catch { console.log(`LEWATI: ${bin} tidak ada`); process.exit(0); }
}
if (!fs.existsSync(BIN)) { console.log(`LEWATI: ${BIN} belum dibangun (cargo build -p sedot)`); process.exit(0); }

// ---------- Server tiruan: link kedaluwarsa setelah 40%, cookie login, Content-Disposition ----------
const SIZE = 30 * 1024 * 1024;
const DATA = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) DATA[i] = (i * 31 + (i >> 8)) & 255;
let oldBudget = SIZE * 0.4;
let servedNew = 0;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const slow = u.searchParams.has('slow');
  const m0 = /^\/t\/(\w+)\/(.+)$/.exec(u.pathname);
  if (!m0) { res.writeHead(404); return res.end(); }
  const [, token, raw] = m0;
  if (!(req.headers.cookie || '').includes('accountToken=abc')) { res.writeHead(403); return res.end(); }
  if (token === 'old' && oldBudget <= 0) { res.writeHead(403); return res.end('expired'); }
  let s = 0;
  let e = SIZE - 1;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) { s = +m[1]; if (m[2]) e = Math.min(+m[2], SIZE - 1); }
  res.writeHead(m ? 206 : 200, { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', 'Content-Disposition': `attachment; filename*=UTF-8''${raw}`, ...(m ? { 'Content-Range': `bytes ${s}-${e}/${SIZE}` } : {}) });
  let p = s;
  const t = setInterval(() => {
    if (res.destroyed) return clearInterval(t);
    if (token === 'old' && oldBudget <= 0) { clearInterval(t); res.destroy(); return; }
    const n = Math.min(32768, e + 1 - p);
    res.write(DATA.subarray(p, p + n));
    p += n;
    if (token === 'old') oldBudget -= n; else servedNew += n;
    if (p > e) { clearInterval(t); res.end(); }
  }, slow ? 200 : 20);
  res.on('close', () => clearInterval(t));
}).listen(18190, '127.0.0.1');
const U = (tok, name) => `http://127.0.0.1:18190/t/${tok}/${encodeURIComponent(name)}`;

// ---------- Klien WebDriver kecil ----------
const WD = 'http://127.0.0.1:4444';
let sid = null;
async function wd(method, p, body) {
  const r = await fetch(`${WD}${p.replace(':sid', sid)}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`WebDriver ${method} ${p}: ${JSON.stringify(j.value || j).slice(0, 300)}`);
  return j.value;
}
const js = (script, ...args) => wd('POST', '/session/:sid/execute/sync', { script, args });
const jsAsync = (script, ...args) => wd('POST', '/session/:sid/execute/async', { script, args });
const handles = () => wd('GET', '/session/:sid/window/handles');
const use = (handle) => wd('POST', '/session/:sid/window', { handle });
const shot = async (name) => { if (OUT) fs.writeFileSync(path.join(OUT, name), Buffer.from(await wd('GET', '/session/:sid/screenshot'), 'base64')); };
// WebKit menambahkan baris baru di akhir innerText (Chromium tidak), jadi dirapikan
const rows = () => js("return [...document.querySelectorAll('#rows tr')].map((r) => [r.children[0].innerText.trim(), r.children[5].innerText.trim(), r.children[2].innerText.replace(/\\s+/g, ' ').trim()])");
const sedot = (call) => jsAsync(`const done = arguments[arguments.length - 1]; Promise.resolve(${call}).then(done, (e) => done({ __err: String(e) }));`);

/** Jendela dialog baru (selain yang sudah dikenal). */
async function newWindow(known) {
  return waitFor(async () => (await handles()).find((h) => !known.includes(h)), 15000, 'jendela dialog');
}

/** RAM (MB) proses Sedot + proses WebKit miliknya, dibaca dari /proc (RSS). */
function ramMB(pid) {
  const kids = (p) => {
    try { return execFileSync('pgrep', ['-P', String(p)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; }
  };
  const all = [];
  const walk = (p) => { all.push(p); for (const k of kids(p)) walk(k); };
  walk(pid);
  const rows = all.map((p) => {
    try {
      const st = fs.readFileSync(`/proc/${p}/status`, 'utf8');
      const name = /Name:\s+(\S+)/.exec(st)[1];
      const rss = Number(/VmRSS:\s+(\d+)/.exec(st)?.[1] || 0) / 1024;
      return [name, Math.round(rss)];
    } catch { return null; }
  }).filter(Boolean).filter(([n]) => n !== 'aria2c');
  return { rows, total: rows.reduce((a, r) => a + r[1], 0) };
}

let driverProc = null;
process.on('exit', () => { try { driverProc?.kill(); } catch { /* sudah mati */ } });

(async () => {
  // Rumah sementara + data lama versi Electron (~/.config/Sedot) untuk diuji pemindahannya
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sedot-tauri-'));
  const oldDir = path.join(home, '.config', 'Sedot');
  fs.mkdirSync(oldDir, { recursive: true });
  const dl = path.join(home, 'Unduhan', 'Sedot');
  fs.writeFileSync(path.join(oldDir, 'settings.json'), JSON.stringify({ downloadDir: dl, connections: 16, onboarded: false, openAtLogin: false, settingsVersion: 2 }));
  fs.writeFileSync(path.join(oldDir, 'history.json'), JSON.stringify([{ gid: 'aaaaaaaaaaaaaaaa', name: 'Dari Electron.mp4', path: path.join(dl, 'Video', 'Dari Electron.mp4'), url: 'https://x/a.mp4', total: 1234, category: 'Video', doneAt: 1 }]));

  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const driver = driverProc = spawn('tauri-driver', ['--native-driver', '/usr/bin/WebKitWebDriver'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  await waitFor(() => fetch(`${WD}/status`).then((r) => r.ok), 15000, 'tauri-driver');
  sid = (await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: BIN } } } })).sessionId;
  const main = (await handles())[0];
  await waitFor(() => js("return document.getElementById('version').textContent"), 20000, 'tampilan siap');

  // 1. Data Electron pindah + sambutan
  const migrated = path.join(home, '.local', 'share', 'id.sedot.app', 'history.json');
  assert.ok(fs.existsSync(migrated), 'riwayat Electron dipindah');
  await waitFor(async () => (await rows()).some((r) => r[0] === 'Dari Electron.mp4' && r[1] === 'Selesai'), 10000, 'riwayat lama tampil');
  assert.ok(await js("return document.getElementById('dlgExt').open"), 'sambutan pertama kali');
  assert.strictEqual(await js("return document.getElementById('version').textContent"), 'Versi 0.9.0');
  await shot('t1-sambutan.png');
  await js("document.getElementById('extDone').click()");
  log('OK 1. data versi Electron (pengaturan + riwayat) pindah otomatis; sambutan muncul');

  // 2. Ekstensi terdeteksi
  await fetch('http://127.0.0.1:17345/ping', { headers: { Origin: 'chrome-extension://abc' } });
  await waitFor(async () => /terhubung/.test(await js("return document.getElementById('sbBridge').textContent")), 5000, 'ekstensi terhubung');
  log('OK 2. ekstensi terdeteksi');

  const send = (url) => fetch('http://127.0.0.1:17345/add', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abc' }, body: JSON.stringify({ url, cookie: 'accountToken=abc', referer: 'https://gofile.io/d/x' }) }).then((r) => r.json());
  const NAME = 'Otakudesu.io_KMRBK--06_Mkv1080p.mkv';

  // 3. Link lama kedaluwarsa di 40%
  let known = await handles();
  assert.ok((await send(U('old', NAME))).ok);
  let dlg = await newWindow(known);
  await use(dlg);
  await waitFor(() => js("return document.getElementById('size').textContent === '30.0 MB'"), 10000, 'ukuran terdeteksi');
  assert.strictEqual(await js("return document.getElementById('title').textContent"), NAME);
  await shot('t2-dialog.png');
  await js("document.getElementById('start').click()");
  await use(main);
  await waitFor(async () => (await rows()).some((r) => r[0] === NAME && /kedaluwarsa/i.test(r[1])), 60000, 'link kedaluwarsa');
  await js(`[...document.querySelectorAll('#rows tr')].find((r) => r.innerText.includes(${JSON.stringify(NAME)})).click()`);
  await waitFor(() => js("return !document.getElementById('detail').hidden && document.querySelectorAll('#dSeg i').length > 0"), 5000, 'panel detail');
  await shot('t3-kedaluwarsa.png');
  log('OK 3. link kedaluwarsa terdeteksi + panel detail');

  // 4. Link baru -> lanjutkan
  known = await handles();
  await send(U('new', NAME));
  dlg = await newWindow(known);
  await use(dlg);
  const offer = await waitFor(() => js("const b = document.getElementById('resumeBox'); return !b.hidden && { title: document.getElementById('resumeTitle').textContent, btn: document.getElementById('start').textContent, locked: document.getElementById('filename').disabled }"), 10000, 'tawaran lanjut');
  assert.ok(/dari 40%/.test(offer.title) && offer.btn === 'Lanjutkan unduh' && offer.locked, JSON.stringify(offer));
  await js("document.getElementById('start').click()");
  await use(main);
  await waitFor(async () => (await rows()).some((r) => r[0] === NAME && r[1] === 'Selesai'), 60000, 'selesai');
  const file = path.join(dl, 'Video', NAME);
  assert.ok(fs.readFileSync(file).equals(DATA), 'isi file identik');
  assert.strictEqual((await rows()).filter((r) => r[0] === NAME).length, 1);
  assert.ok(servedNew < SIZE * 0.75, `hanya sisa (${servedNew})`);
  log(`OK 4. lanjut dengan link baru: file identik, link baru ${(servedNew / 1048576).toFixed(1)} MB dari 30 MB`);

  // 5. Urut kolom
  await js("document.querySelector('th[data-sort=\"name\"]').click()");
  assert.strictEqual(await js("return document.querySelector('th[data-sort=\"name\"]').dataset.dir"), 'asc');
  log('OK 5. urut kolom');

  // 6. Koneksi + batas kecepatan per file
  known = await handles();
  await send(`${U('new', 'Episode 07.mkv')}?slow=1`);
  dlg = await newWindow(known);
  await use(dlg);
  await waitFor(() => js("return document.getElementById('size').textContent === '30.0 MB'"), 10000, 'dialog ep 7');
  await js("document.getElementById('start').click()");
  await use(main);
  await waitFor(async () => (await rows()).some((r) => r[0] === 'Episode 07.mkv' && r[1] === 'Mengunduh'), 15000, 'ep 7 berjalan');
  await js("[...document.querySelectorAll('#rows tr')].find((r) => r.innerText.includes('Episode 07')).click()");
  const conns = await waitFor(async () => { const c = await js("return [...document.querySelectorAll('#dConns li')].map((x) => x.innerText.trim())"); return c.length > 1 && c; }, 10000, 'koneksi');
  await js("document.getElementById('dLimit').value = '500'; document.getElementById('dLimitApply').click()");
  await sleep(8000);
  const doneOf = async () => (await sedot('window.sedot.state()')).items.find((i) => i.name === 'Episode 07.mkv').done;
  const d0 = await doneOf();
  await sleep(10000);
  const kbps = Math.round(((await doneOf()) - d0) / 10 / 1024);
  assert.ok(kbps > 0 && kbps < 650, `batas per file (${kbps} KB/s)`);
  assert.strictEqual(await js("return document.getElementById('dLimit').value"), '500');
  await shot('t4-detail.png');
  await js("document.getElementById('dLimit').value = '0'; document.getElementById('dLimitApply').click()");
  log(`OK 6. ${conns.length} koneksi tampil, batas per file ${kbps} KB/s`);

  // 7. Hitung mundur setelah semua selesai + batal
  await js("const s = document.getElementById('afterAll'); s.value = 'sleep'; s.dispatchEvent(new Event('change'))");
  await waitFor(() => js("return !document.getElementById('countdown').hidden"), 60000, 'hitung mundur');
  assert.match(await js("return document.getElementById('countdownText').textContent"), /Sleep dalam \d+ detik/);
  await js("document.getElementById('btnCancelCountdown').click()");
  await waitFor(() => js("return document.getElementById('countdown').hidden && document.getElementById('afterAll').value === 'none'"), 5000, 'batal');
  log('OK 7. hitung mundur + batal');

  // 8. Clipboard (disalin oleh "aplikasi lain" lewat xclip)
  const clip = (t) => new Promise((r) => { const p = spawn('xclip', ['-selection', 'clipboard'], { env }); p.stdin.end(t); p.on('exit', r); });
  await clip('http://127.0.0.1:18190/t/new/Soundtrack%20OP.mp3');
  await waitFor(() => js("return !document.getElementById('offer').hidden"), 5000, 'tawaran clipboard');
  assert.strictEqual(await js("return document.getElementById('offerName').textContent"), 'Soundtrack OP.mp3');
  known = await handles();
  await js("document.getElementById('btnOfferYes').click()");
  dlg = await newWindow(known);
  await use(dlg);
  await js("document.getElementById('cancel').click()");
  await use(main);
  await clip('https://contoh.com/artikel-berita');
  await sleep(1500);
  assert.ok(await js("return document.getElementById('offer').hidden"), 'halaman biasa tidak ditawarkan');
  log('OK 8. tawaran clipboard');

  // 9. Peringatan duplikat
  known = await handles();
  await send(`${U('new', NAME)}?lagi=1`);
  dlg = await newWindow(known);
  await use(dlg);
  await waitFor(() => js("return !document.getElementById('dupBox').hidden"), 10000, 'peringatan duplikat');
  await js("document.getElementById('cancel').click()");
  await use(main);
  log('OK 9. peringatan file dobel');

  // 10. Link sama dari dua ekstensi -> satu dialog
  known = await handles();
  await Promise.all([send(U('new', 'Dobel.zip')), send(U('new', 'Dobel.zip'))]);
  await sleep(2500);
  const fresh = (await handles()).filter((h) => !known.includes(h));
  assert.strictEqual(fresh.length, 1, 'satu dialog');
  await use(fresh[0]);
  await js("document.getElementById('cancel').click()");
  await use(main);
  log('OK 10. link sama dikirim 2x -> satu dialog');

  // 11. Tata letak 800px
  await wd('POST', '/session/:sid/window/rect', { width: 800, height: 560 });
  await sleep(800);
  assert.ok(await js('return document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'tanpa scroll horizontal');
  await shot('t5-sempit.png');
  await wd('POST', '/session/:sid/window/rect', { width: 1100, height: 680 });
  log('OK 11. tata letak 800px');

  // 12. RAM: jendela terbuka (sesi ini) vs di tray. "Di tray" diukur seperti saat dinyalakan bersama Windows
  //     (--hidden, tanpa jendela), karena WebDriver ikut mematikan aplikasi saat jendela terakhir ditutup.
  const pid = Number(execFileSync('pgrep', ['-n', '-f', `^${BIN}`], { encoding: 'utf8' }).trim());
  await sleep(3000);
  const open = ramMB(pid);
  await wd('DELETE', '/session/:sid').catch(() => {});
  driver.kill();
  try { process.kill(pid); } catch { /* sudah keluar */ }
  await waitFor(async () => !(await fetch('http://127.0.0.1:17345/ping').then(() => true, () => false)), 10000, 'aplikasi pertama keluar');
  // Pastikan tidak ada sisa proses Sedot (kunci "satu instance" & port penghubung harus sudah lepas)
  try { execFileSync('pkill', ['-f', `^${BIN}`]); } catch { /* tidak ada */ }
  await waitFor(async () => { try { execFileSync('pgrep', ['-f', `^${BIN}`]); return false; } catch { return true; } }, 10000, 'semua proses Sedot berhenti');
  let hiddenErr = '';
  const hidden = spawn(BIN, ['--hidden'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  hidden.stderr.on('data', (d) => { hiddenErr = (hiddenErr + d).slice(-4000); });
  let hiddenExit = null;
  hidden.on('exit', (c, sig) => { hiddenExit = `${c ?? ''}${sig ?? ''}`; });
  try {
    await waitFor(() => fetch('http://127.0.0.1:17345/ping').then((r) => r.ok), 30000, 'Sedot di tray (--hidden) menjawab');
  } catch (e) {
    let ps = '';
    try { ps = execFileSync('ps', ['-eo', 'pid,stat,args'], { encoding: 'utf8' }).split('\n').filter((l) => /sedot|WebKit/.test(l)).join('\n'); } catch { /* abaikan */ }
    throw new Error(`${e.message}\n  keluar: ${hiddenExit}\n  stderr: ${hiddenErr.split('\n').filter((l) => !/dbus|libEGL|MESA|Gtk-WARNING/i.test(l)).slice(-15).join('\n  ')}\n  proses:\n${ps}`);
  }
  await sleep(5000);
  const tray = ramMB(hidden.pid);
  assert.ok(!tray.rows.some(([n]) => /WebKitWebProces/.test(n)), 'di tray tidak ada proses tampilan');
  hidden.kill();
  log(`OK 12. RAM jendela terbuka ${open.total} MB [${open.rows.map((r) => r.join(' ')).join(', ')}] | di tray ${tray.total} MB [${tray.rows.map((r) => r.join(' ')).join(', ')}]`);

  srv.close();
  log('SEMUA UJI E2E TAURI LULUS');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
