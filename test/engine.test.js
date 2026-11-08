'use strict';
// Uji mesin: multi-koneksi, resume setelah aria2 dimatikan, dan keamanan bridge.
// Jalankan: node test/engine.test.js   (butuh aria2c di PATH atau ARIA2C=...)
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const { Aria2, sanitizeFilename } = require('../src/aria2');
const { startBridge } = require('../src/bridge');

const SIZE = 8 * 1024 * 1024;
const DATA = crypto.randomBytes(SIZE);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');
const PER_CONN_BPS = 1024 * 1024; // 1 MB/s per koneksi
let maxParallel = 0, open = 0;

function fileServer() {
  const s = http.createServer((req, res) => {
    let start = 0, end = SIZE - 1;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) { start = +m[1]; if (m[2]) end = Math.min(+m[2], SIZE - 1); }
    res.writeHead(m ? 206 : 200, {
      'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${SIZE}` } : {}),
      'Content-Type': 'application/octet-stream',
    });
    open++; maxParallel = Math.max(maxParallel, open);
    let pos = start;
    const t = setInterval(() => {
      if (res.destroyed) { clearInterval(t); return; }
      const n = Math.min(Math.floor(PER_CONN_BPS / 10), end + 1 - pos);
      res.write(DATA.subarray(pos, pos + n)); pos += n;
      if (pos > end) { clearInterval(t); res.end(); }
    }, 100);
    res.on('close', () => { clearInterval(t); open--; });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDone(a, gid, ms) {
  const t0 = Date.now();
  for (;;) {
    const st = await a.call('tellStatus', gid, ['status', 'completedLength', 'errorMessage', 'files']);
    if (st.status === 'complete') return st;
    if (st.status === 'error') throw new Error(st.errorMessage);
    if (Date.now() - t0 > ms) throw new Error('timeout ' + JSON.stringify(st));
    await sleep(200);
  }
}

(async () => {
  const bin = process.env.ARIA2C || execSync('which aria2c').toString().trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sedot-'));
  const srv = await fileServer();
  const url = `http://127.0.0.1:${srv.address().port}/folder/file%20uji.bin?x=1`;
  const mk = (port, opts) => new Aria2({ binPath: bin, port, sessionFile: path.join(tmp, 'session.txt'), downloadDir: tmp, options: opts });

  // 1. Multi-koneksi: 8MB @1MB/s per koneksi. Satu koneksi = 8 detik; 16 koneksi harus jauh lebih cepat.
  let a = mk(16801, { connections: 16 });
  await a.start();
  let t0 = Date.now();
  let gid = await a.add(url, { out: 'multi.bin' });
  let st = await waitDone(a, gid, 20000);
  const secs = (Date.now() - t0) / 1000;
  const got = crypto.createHash('sha256').update(fs.readFileSync(st.files[0].path)).digest('hex');
  assert.strictEqual(got, SHA, 'isi file multi-koneksi harus identik');
  assert.ok(maxParallel >= 4, `harus pakai banyak koneksi (dapat ${maxParallel})`);
  assert.ok(secs < 5, `multi-koneksi harus < 5 dtk (dapat ${secs})`);
  console.log(`OK multi-koneksi: ${secs.toFixed(1)} dtk, ${maxParallel} koneksi paralel, hash cocok`);

  // 2. Resume: mulai unduh, matikan aria2 di tengah jalan, nyalakan lagi -> harus lanjut dan selesai utuh.
  maxParallel = 0;
  await a.applyOptions({ connections: 2 }); // juga menguji pengaturan yang diubah saat aplikasi berjalan
  gid = await a.add(url, { out: 'resume.bin' });
  await sleep(1500);
  const mid = await a.call('tellStatus', gid, ['completedLength']);
  await a.stop();
  assert.ok(maxParallel <= 2, `pengaturan koneksi harus berlaku (dapat ${maxParallel})`);
  assert.ok(+mid.completedLength > 0 && +mid.completedLength < SIZE, 'harus berhenti di tengah');
  a = mk(16802, { connections: 16 });
  await a.start();
  const snap = await a.snapshot();
  const restored = snap.items.find((i) => i.gid === gid);
  assert.ok(restored, 'unduhan harus kembali dari session dengan gid yang sama');
  st = await waitDone(a, gid, 20000);
  const got2 = crypto.createHash('sha256').update(fs.readFileSync(st.files[0].path)).digest('hex');
  assert.strictEqual(got2, SHA, 'isi file hasil resume harus identik');
  console.log(`OK resume: berhenti di ${(mid.completedLength / 1048576).toFixed(1)} MB, dilanjut, hash cocok`);

  // 3. Bridge: ekstensi diterima, website ditolak.
  const added = [];
  const br = await startBridge({ version: 't', port: 17399, onAdd: async (j) => { added.push(j); return a.add(j.url, { out: j.filename }); } });
  const B = 'http://127.0.0.1:17399';
  let r = await fetch(B + '/add', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://situs-jahat.com' }, body: JSON.stringify({ url }) });
  assert.strictEqual(r.status, 403, 'origin website harus ditolak');
  r = await fetch(B + '/add', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: 'chrome-extension://abcdefgh' }, body: JSON.stringify({ url }) });
  assert.strictEqual(r.status, 415, 'non-JSON harus ditolak');
  r = await fetch(B + '/add', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abcdefgh' }, body: JSON.stringify({ url: 'file:///etc/passwd' }) });
  assert.strictEqual(r.status, 400, 'skema file:// harus ditolak');
  r = await fetch(B + '/add', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abcdefgh' }, body: JSON.stringify({ url, filename: '..\\..\\Windows\\evil.exe' }) });
  const j = await r.json();
  assert.ok(j.ok, JSON.stringify(j));
  st = await waitDone(a, j.gid, 20000);
  assert.strictEqual(path.dirname(st.files[0].path), tmp, 'nama file tidak boleh keluar dari folder unduhan');
  assert.strictEqual(path.basename(st.files[0].path), 'evil.exe');
  console.log('OK bridge: website ditolak, ekstensi diterima, path traversal dinetralkan');

  assert.strictEqual(sanitizeFilename('a<b>:c?.txt'), 'a_b__c_.txt');
  assert.strictEqual(sanitizeFilename('../..'), 'unduhan');

  br.close(); await a.stop(); srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('SEMUA UJI LULUS');
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
