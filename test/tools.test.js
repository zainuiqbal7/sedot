'use strict';
// Uji pengunduh komponen video lewat aria2: checksum, ekstrak zip, progres ke banyak pendengar, tolak file palsu.
// Jalankan: node test/tools.test.js   (butuh aria2c, dan bsdtar untuk membuka .zip di Linux)
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { Aria2 } = require('../src/aria2');
const { Tools } = require('../src/tools');

let bsdtar;
try { bsdtar = execFileSync('which', ['bsdtar'], { encoding: 'utf8' }).trim(); } catch { console.log('LEWATI tools: bsdtar tidak ada'); process.exit(0); }

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sedot-tools-'));
// "tar" bawaan Windows bisa membuka .zip; di Linux pakai bsdtar dengan nama tar
const shim = path.join(tmp, 'shim');
fs.mkdirSync(shim);
fs.symlinkSync(bsdtar, path.join(shim, 'tar'));
process.env.PATH = `${shim}:${process.env.PATH}`;

// File tiruan: yt-dlp.exe + zip ffmpeg dengan struktur rilis aslinya
const ytdlp = crypto.randomBytes(3 * 1024 * 1024);
const zdir = path.join(tmp, 'z', 'ffmpeg-master-latest-win64-gpl-shared', 'bin');
fs.mkdirSync(zdir, { recursive: true });
fs.writeFileSync(path.join(zdir, 'ffmpeg.exe'), crypto.randomBytes(1024 * 1024));
fs.writeFileSync(path.join(zdir, 'avcodec-63.dll'), crypto.randomBytes(2 * 1024 * 1024));
fs.writeFileSync(path.join(zdir, 'ffplay.exe'), 'tidak dibutuhkan');
const zipFile = path.join(tmp, 'ff.zip');
execFileSync(bsdtar, ['-a', '-cf', zipFile, '-C', path.join(tmp, 'z'), 'ffmpeg-master-latest-win64-gpl-shared']);
const zip = fs.readFileSync(zipFile);

let fakeYtdlp = false;
const srv = http.createServer((req, res) => {
  const body = {
    '/y/SHA2-256SUMS': `${sha(ytdlp)}  yt-dlp.exe\n${'0'.repeat(64)}  yt-dlp_linux\n`,
    '/y/yt-dlp.exe': fakeYtdlp ? Buffer.concat([ytdlp.subarray(1), Buffer.from('x')]) : ytdlp,
    '/f/checksums.sha256': `${sha(zip)}  ffmpeg-master-latest-win64-gpl-shared.zip\n`,
    '/f/ffmpeg.zip': zip,
  }[req.url];
  if (body === undefined) { res.writeHead(404); return res.end(); }
  const buf = Buffer.from(body);
  let s = 0;
  let e = buf.length - 1;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) { s = +m[1]; if (m[2]) e = Math.min(+m[2], buf.length - 1); }
  res.writeHead(m ? 206 : 200, { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', ...(m ? { 'Content-Range': `bytes ${s}-${e}/${buf.length}` } : {}) });
  res.end(buf.subarray(s, e + 1));
}).listen(0, '127.0.0.1');

(async () => {
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const sources = {
    ytdlp: { url: `${base}/y/yt-dlp.exe`, sums: `${base}/y/SHA2-256SUMS`, sumName: 'yt-dlp.exe' },
    ffmpeg: { url: `${base}/f/ffmpeg.zip`, sums: `${base}/f/checksums.sha256`, sumName: 'ffmpeg-master-latest-win64-gpl-shared.zip' },
  };
  const aria = new Aria2({ binPath: execFileSync('which', ['aria2c'], { encoding: 'utf8' }).trim(), port: 16971, sessionFile: path.join(tmp, 's'), downloadDir: tmp });
  await aria.start();
  // pengunduh yang sama dengan di main.js (disederhanakan): aria2 + tunggu selesai
  const downloader = async (url, dir, out, onProgress) => {
    const gid = await aria.add(url, { dir, out, connections: 4 });
    for (;;) {
      await new Promise((r) => setTimeout(r, 100));
      const st = await aria.call('tellStatus', gid, ['status', 'completedLength', 'totalLength', 'files', 'errorMessage']);
      onProgress(+st.completedLength, +st.totalLength);
      if (st.status === 'complete') return st.files[0].path;
      if (st.status === 'error') throw new Error(st.errorMessage);
    }
  };

  const makeTools = (dir) => {
    const t = new Tools(dir, downloader, sources);
    t.forceInstall = true;
    // tiru Windows: nama .exe dan hanya folder Sedot sendiri (mesin uji punya yt-dlp/ffmpeg di PATH)
    t.exe = (n) => path.join(dir, `${n}.exe`);
    t.find = (n) => (fs.existsSync(t.exe(n)) ? t.exe(n) : null);
    return t;
  };

  // 1. Pemasangan normal; dipanggil dua kali bersamaan: satu proses unduh, dua pendengar progres
  const dir = path.join(tmp, 'tools');
  const t = makeTools(dir);
  const seenA = [];
  const seenB = [];
  await Promise.all([t.ensure((p) => seenA.push(p)), t.ensure((p) => seenB.push(p))]);
  const got = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(got, ['avcodec-63.dll', 'ffmpeg.exe', 'update-check.json', 'yt-dlp.exe'], 'ffplay.exe tidak ikut, folder sementara bersih');
  assert.ok(fs.readFileSync(path.join(dir, 'yt-dlp.exe')).equals(ytdlp));
  assert.ok(t.ready());
  for (const seen of [seenA, seenB]) {
    assert.ok(seen.length >= 3, 'progres sampai ke kedua pendengar');
    assert.strictEqual(seen[0].step, 'mulai');
    assert.ok(seen[0].total > 100e6, 'perkiraan total dari awal (bukan 0)');
    assert.ok(seen.some((p) => p.step === 'ekstrak'));
  }
  const last = seenA.filter((p) => p.step !== 'ekstrak').pop();
  assert.strictEqual(last.done, ytdlp.length + zip.length, 'total asli menggantikan perkiraan');
  assert.strictEqual(last.total, ytdlp.length + zip.length);
  console.log('OK 1. yt-dlp + ffmpeg (+DLL) terpasang lewat aria2; ffplay.exe tidak ikut; progres ke 2 pendengar');

  // 2. File palsu (checksum tidak cocok) ditolak, tidak ada yang terpasang
  fakeYtdlp = true;
  const dir2 = path.join(tmp, 'tools2');
  const t2 = makeTools(dir2);
  await assert.rejects(t2.ensure(), /checksum tidak cocok/);
  assert.deepStrictEqual(fs.readdirSync(dir2), [], 'tidak ada sisa file');
  assert.ok(!t2.ready());
  console.log('OK 2. yt-dlp palsu ditolak (checksum), folder tetap bersih');
  console.log('OK tools');
  await aria.stop();
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
