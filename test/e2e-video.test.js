'use strict';
// Uji menyeluruh fitur video: aplikasi sungguhan + yt-dlp + ffmpeg + server tiruan bergaya YouTube
// (gambar & suara terpisah, link kedaluwarsa, cookie login, subtitle). Juga tombol "Unduh video" ekstensi.
// Jalankan: npm run test:e2e:video   (Linux tanpa layar: xvfb-run -a …). Butuh yt-dlp & ffmpeg di PATH.
const { _electron, chromium } = require('playwright-core');
const ELECTRON = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.E2E_SHOTS || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const shot = (page, name) => (OUT ? page.screenshot({ path: path.join(OUT, name) }) : null);
async function waitFor(fn, ms = 30000, what = 'kondisi') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout menunggu ${what}`);
    await sleep(250);
  }
}

for (const bin of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
  try { execFileSync('which', [bin]); } catch { console.log(`LEWATI: ${bin} tidak ada di PATH`); process.exit(0); }
}

// ---------- Media uji: video 720p H.264 + audio AAC terpisah, seperti DASH YouTube ----------
const media = fs.mkdtempSync(path.join(os.tmpdir(), 'sedot-media-'));
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-t', '10', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2M', '-c:a', 'aac', '-b:a', '128k',
  '-f', 'dash', '-single_file', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a', path.join(media, 'src.mpd')]);
const FILES = { 'v.mp4': fs.readFileSync(path.join(media, 'src-stream0.mp4')), 'a.m4a': fs.readFileSync(path.join(media, 'src-stream1.mp4')) };
const SUB = 'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nHalo, ini subtitle uji.\n';

let gen = 0;
let expireFirst = true;
const servedByGen = {};
const cookiesSeen = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/watch.mpd') {
    gen++; // setiap kali info video dibaca, link baru diterbitkan (seperti YouTube)
    cookiesSeen.push(req.headers.cookie || '');
    res.writeHead(200, { 'Content-Type': 'application/dash+xml' });
    return res.end(`<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period>
<AdaptationSet mimeType="video/mp4" contentType="video"><Representation id="137" codecs="avc1.64001f" width="1280" height="720" frameRate="25" bandwidth="2000000"><BaseURL>v.mp4?t=${gen}</BaseURL></Representation></AdaptationSet>
<AdaptationSet mimeType="audio/mp4" contentType="audio"><Representation id="140" codecs="mp4a.40.2" audioSamplingRate="44100" bandwidth="130000"><BaseURL>a.m4a?t=${gen}</BaseURL></Representation></AdaptationSet>
<AdaptationSet mimeType="text/vtt" contentType="text" lang="id"><Representation id="sub" bandwidth="256"><BaseURL>sub-id.vtt</BaseURL></Representation></AdaptationSet>
</Period></MPD>`);
  }
  if (u.pathname === '/sub-id.vtt') { res.writeHead(200, { 'Content-Type': 'text/vtt' }); return res.end(SUB); }
  const data = FILES[u.pathname.slice(1)];
  const t = Number(u.searchParams.get('t'));
  if (!data) { res.writeHead(404); return res.end(); }
  if (t < gen) { res.writeHead(403); return res.end('expired'); } // link lama mati
  const key = `${u.pathname}@${t}`;
  let s = 0;
  let e = data.length - 1;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) { s = +m[1]; if (m[2]) e = Math.min(+m[2], data.length - 1); }
  res.writeHead(m ? 206 : 200, { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', ...(m ? { 'Content-Range': `bytes ${s}-${e}/${data.length}` } : {}) });
  let p = s;
  const iv = setInterval(() => {
    if (res.destroyed) return clearInterval(iv);
    // link pertama "kedaluwarsa" setelah ±40% video terkirim
    if (expireFirst && t === 1 && u.pathname === '/v.mp4' && (servedByGen[key] || 0) > data.length * 0.4) { clearInterval(iv); res.destroy(); return; }
    const n = Math.min(16384, e + 1 - p);
    res.write(data.subarray(p, p + n));
    p += n;
    servedByGen[key] = (servedByGen[key] || 0) + n;
    if (p > e) { clearInterval(iv); res.end(); }
  }, 25);
  res.on('close', () => clearInterval(iv));
}).listen(18195, '127.0.0.1');
const PAGE = 'http://127.0.0.1:18195/watch.mpd';
// setelah link pertama mati, permintaan berikutnya ke t=1 ditolak
const origEmit = srv.emit.bind(srv);
srv.emit = (ev, req, res) => {
  if (ev === 'request' && expireFirst && /[?&]t=1\b/.test(req.url) && req.url.startsWith('/v.mp4') && (servedByGen['/v.mp4@1'] || 0) > FILES['v.mp4'].length * 0.4) {
    res.writeHead(403); res.end('expired'); return true;
  }
  return origEmit(ev, req, res);
};

const ffprobe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f], { encoding: 'utf8' }));

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sedot-v-'));
  const cfg = path.join(home, '.config', 'Sedot');
  fs.mkdirSync(cfg, { recursive: true });
  // pengguna lama v0.4 (openAtLogin false, belum ada settingsVersion) -> harus dimigrasi
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ onboarded: true, openAtLogin: false }));
  const app = await _electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', ROOT], env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
  const main = await app.firstWindow();
  await main.setViewportSize({ width: 1100, height: 680 });
  await sleep(1500);

  const st = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.strictEqual(st.openAtLogin, true, 'migrasi: jalan saat Windows menyala jadi aktif');
  assert.strictEqual(st.settingsVersion, 2);
  log('OK 1. migrasi pengaturan: jalan otomatis saat Windows menyala');

  const sendVideo = (url, cookies = []) => fetch('http://127.0.0.1:17345/video', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abc' }, body: JSON.stringify({ url, cookies }) }).then((r) => r.json());
  const openDialog = async (cookies) => {
    const wp = app.waitForEvent('window');
    const r = await sendVideo(PAGE, cookies);
    assert.ok(r.ok, JSON.stringify(r));
    const w = await wp;
    await waitFor(() => w.evaluate(() => !document.getElementById('form').hidden || /tidak bisa/.test(document.getElementById('busyTitle').textContent)), 60000, 'dialog video siap');
    return w;
  };
  const rows = () => main.$$eval('#rows tr', (rs) => rs.map((r) => ({ name: r.children[0].innerText, status: r.children[5].innerText })));

  // 2. Dialog video: kualitas, audio, subtitle, cookie login ikut
  let w = await openDialog([{ name: 'SID', value: 'login123', domain: '127.0.0.1', path: '/', secure: false, hostOnly: true }]);
  const dlg = await w.evaluate(() => ({
    choices: [...document.querySelectorAll('#choices .choice')].map((c) => c.querySelector('b').textContent),
    checked: document.querySelector('#choices input:checked')?.closest('.choice').querySelector('b').textContent,
    subs: [...document.querySelectorAll('#subs input')].map((i) => `${i.value}:${i.checked}`),
    ext: document.getElementById('ext').textContent,
    dir: document.getElementById('dir').value,
    file: document.getElementById('filename').value,
  }));
  assert.deepStrictEqual(dlg.choices, ['720p', 'Audio MP3', 'Audio M4A']);
  assert.strictEqual(dlg.checked, '720p');
  assert.deepStrictEqual(dlg.subs, ['id:true'], 'subtitle Indonesia tercentang otomatis');
  assert.strictEqual(dlg.ext, '.mp4');
  assert.match(dlg.dir, /Sedot[/\\]Video$/);
  assert.ok(cookiesSeen[0].includes('SID=login123'), `cookie browser harus ikut ke yt-dlp (dapat "${cookiesSeen[0]}")`);
  assert.ok(!fs.readdirSync(path.join(cfg, 'tmp')).some((f) => f.startsWith('cookies-')), 'file cookie sementara langsung dihapus');
  await shot(w, 'v1-dialog.png');
  log('OK 2. dialog video: 720p/MP3/M4A, subtitle id, cookie login terkirim lalu file cookie dihapus');

  // 3. Mulai -> link kedaluwarsa di tengah jalan -> Coba lagi -> lanjut -> digabung
  await w.click('#start').catch(() => {}); // dialog menutup diri
  const vname = `${dlg.file}.mp4`;
  await waitFor(async () => { const rr = await rows(); return rr.some((r) => r.name === vname && /kedaluwarsa/i.test(r.status)); }, 60000, 'link video kedaluwarsa');
  assert.strictEqual((await rows()).filter((r) => r.name === vname).length, 1, 'gambar + suara tampil sebagai satu baris');
  await main.click(`#rows tr:has-text("${vname}")`);
  await sleep(1200);
  const parts = await main.$$eval('#dConns li', (l) => l.map((x) => x.innerText.replace(/\n/g, ' ')));
  assert.ok(parts.some((p) => p.startsWith('Gambar 720p')) && parts.some((p) => p.startsWith('Suara')), JSON.stringify(parts));
  assert.strictEqual(await main.textContent('#dConnTitle'), 'Bagian');
  await shot(main, 'v2-kedaluwarsa.png');
  await main.click('#btnResume');
  const finalPath = path.join(dlg.dir, vname);
  await waitFor(() => fs.existsSync(finalPath) && !fs.existsSync(path.join(dlg.dir, '.sedot-sementara')), 90000, 'video selesai digabung');
  await waitFor(async () => (await rows()).some((r) => r.name === vname && r.status === 'Selesai'), 10000, 'status selesai');
  const pr = ffprobe(finalPath);
  const kinds = pr.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort();
  assert.deepStrictEqual(kinds, ['audio:aac', 'video:h264']);
  assert.strictEqual(pr.streams.find((s) => s.codec_type === 'video').height, 720);
  assert.ok(Math.abs(Number(pr.format.duration) - 10) < 0.6, `durasi ${pr.format.duration}`);
  const srt = path.join(dlg.dir, `${dlg.file}.id.srt`);
  assert.ok(fs.existsSync(srt) && fs.readFileSync(srt, 'utf8').includes('Halo, ini subtitle uji.'), 'subtitle .srt di samping video');
  const again = servedByGen[`/v.mp4@${gen}`] || 0;
  assert.ok(again < FILES['v.mp4'].length * 0.8, `lanjut, bukan ulang dari nol (link baru mengirim ${again} dari ${FILES['v.mp4'].length})`);
  log(`OK 3. kedaluwarsa -> Coba lagi -> link baru otomatis; hasil MP4 H.264+AAC 720p 10 dtk + subtitle .srt; link baru hanya ${Math.round((again / FILES['v.mp4'].length) * 100)}% file`);

  // 4. Audio MP3 -> folder Musik
  expireFirst = false;
  w = await openDialog();
  await w.click('#choices .choice:has-text("Audio MP3")');
  const mp3dir = await w.inputValue('#dir');
  assert.match(mp3dir, /Sedot[/\\]Musik$/, 'audio otomatis ke folder Musik');
  assert.strictEqual(await w.textContent('#ext'), '.mp3');
  assert.ok(await w.evaluate(() => document.getElementById('subsBox').hidden), 'subtitle disembunyikan untuk audio');
  await w.click('#start').catch(() => {}); // dialog menutup diri
  const mp3 = path.join(mp3dir, `${dlg.file}.mp3`);
  await waitFor(() => fs.existsSync(mp3) && !fs.existsSync(path.join(mp3dir, '.sedot-sementara')), 60000, 'MP3 selesai');
  const pa = ffprobe(mp3);
  assert.deepStrictEqual(pa.streams.map((s) => `${s.codec_type}:${s.codec_name}`), ['audio:mp3']);
  log('OK 4. Audio MP3 dikonversi, masuk folder Musik');

  // 5. Unduh nanti -> dijeda -> hapus -> bagian sementara bersih
  w = await openDialog();
  await w.click('#later').catch(() => {});
  const v2 = `${dlg.file}.mp4`;
  await waitFor(async () => (await rows()).some((r) => r.status === 'Dijeda'), 10000, 'item dijeda');
  const pausedRow = (await rows()).find((r) => r.status === 'Dijeda');
  assert.strictEqual(pausedRow.name, v2);
  await main.click('#rows tr:has-text("Dijeda")');
  await main.keyboard.press('Delete');
  await main.click('#removeSubmit');
  await waitFor(async () => !(await rows()).some((r) => r.status === 'Dijeda'), 10000, 'item terhapus');
  await sleep(500);
  assert.ok(!fs.existsSync(path.join(dlg.dir, '.sedot-sementara')), 'folder sementara dibersihkan');
  log('OK 5. Unduh nanti (dijeda) lalu hapus: bagian sementara dibersihkan');

  // 6. Clipboard link YouTube -> tawaran "Unduh video"
  await app.evaluate(({ clipboard }) => clipboard.writeText('https://www.youtube.com/watch?v=YQRHrco73g4&list=RDx'));
  await waitFor(() => main.$eval('#offer', (d) => !d.hidden), 5000, 'tawaran clipboard');
  assert.strictEqual(await main.textContent('#offerLead'), 'Link video disalin:');
  assert.strictEqual(await main.textContent('#btnOfferYes'), 'Unduh video');
  await shot(main, 'v3-selesai.png');
  await main.click('#btnOfferNo');
  log('OK 6. salin link YouTube -> tawaran "Unduh video"');

  // 7. Tambah URL dengan halaman video -> dialog video (bukan unduhan file biasa)
  const wp = app.waitForEvent('window');
  await main.click('#btnAdd');
  await main.fill('#addUrls', 'https://youtu.be/YQRHrco73g4');
  await main.click('#addSubmit');
  const w7 = await wp;
  assert.match(w7.url(), /video\.html/);
  await w7.evaluate(() => window.close()).catch(() => {});
  log('OK 7. Tambah URL dengan link YouTube -> dialog video');

  // 7b. Jalur cepat (menu kualitas): langsung masuk daftar tanpa dialog. Minta 1080p, video hanya punya 720p.
  let dialogs = 0;
  const countDlg = () => dialogs++;
  app.on('window', countDlg);
  const quickSend = (request, title) => fetch('http://127.0.0.1:17345/video', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abc' }, body: JSON.stringify({ url: PAGE, cookies: [], request, title }) }).then((r) => r.json());
  assert.ok((await quickSend({ kind: 'video', height: 1080 }, 'Lagu Cepat')).ok);
  await waitFor(() => main.evaluate(async () => (await sedot.state()).items.some((i) => i.isVideo && i.status !== 'complete')), 3000, 'baris video muncul seketika');
  const qfile = path.join(dlg.dir, `${dlg.file}.mp4`);
  const before = fs.existsSync(qfile) ? fs.statSync(qfile).mtimeMs : 0;
  await waitFor(async () => (await rows()).filter((r) => r.status === 'Selesai').length >= 3, 60000, 'unduhan cepat selesai');
  const quickRow = await main.evaluate(async () => (await sedot.state()).items.find((i) => i.status === 'complete' && /\(1\)\.mp4$|watch \(1\)\.mp4$/.test(i.name)) || null);
  assert.ok(quickRow, 'nama dari judul video asli; file sama sudah ada -> diberi (1)');
  assert.deepStrictEqual(ffprobe(quickRow.path).streams.map((x) => x.height).filter(Boolean), [720], 'minta 1080p, dapat yang tertinggi tersedia (720p)');
  void before;
  assert.ok((await quickSend({ kind: 'mp3' }, 'Audio Cepat')).ok);
  await waitFor(async () => (await rows()).filter((r) => r.status === 'Selesai').length >= 4, 60000, 'MP3 cepat selesai');
  app.off('window', countDlg);
  assert.strictEqual(dialogs, 0, 'jalur cepat tidak membuka dialog');
  const wBadP = app.waitForEvent('window');
  assert.strictEqual((await quickSend({ kind: 'exe' }, 'x')).ok, true); // permintaan tidak valid -> jatuh ke dialog lengkap
  const wBad = await wBadP;
  assert.match(wBad.url(), /video\.html/);
  await wBad.evaluate(() => window.close()).catch(() => {});
  log('OK 7b. jalur cepat: 1080p diminta -> 720p tersedia, MP3; tanpa dialog; permintaan tak valid -> dialog');

  // 7c. RAM: tutup jendela ke tray -> proses tampilan dilepas; buka lagi dari tray -> data tetap ada
  const procs = async () => (await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => m.type))).sort();
  const withWin = await procs();
  await main.close();
  await sleep(1500);
  const trayOnly = await procs();
  assert.ok(!trayOnly.includes('Tab'), `jendela tertutup -> tidak ada proses tampilan (dapat ${trayOnly.join(',')})`);
  assert.ok((await fetch('http://127.0.0.1:17345/ping', { headers: { Origin: 'chrome-extension://abc' } })).ok, 'Sedot tetap berjalan di tray');
  const reopened = app.waitForEvent('window');
  await app.evaluate(({ app: a }) => a.emit('second-instance')); // sama seperti membuka Sedot lagi dari Start Menu
  const main2 = await reopened;
  await waitFor(async () => (await main2.$$eval('#rows tr', (r) => r.length)) >= 4, 10000, 'daftar muncul lagi');
  log(`OK 7c. RAM: proses ${withWin.join('+')} -> di tray ${trayOnly.join('+')}; buka lagi, daftar utuh`);

  const exited = new Promise((r) => app.process().once('exit', r));
  await app.evaluate(({ app: a }) => a.quit());
  await Promise.race([exited, sleep(10000)]); // tunggu port 17345 dilepas

  // 8. Tombol "Unduh video" ekstensi di halaman bergaya YouTube (tanpa aplikasi: server tiruan menangkap kiriman)
  let exe = null;
  try { exe = chromium.executablePath(); if (!fs.existsSync(exe)) exe = null; } catch { /* tidak ada */ }
  exe = exe || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : process.env.CHROMIUM_PATH);
  if (!exe) { log('LEWATI 8: Chromium tidak tersedia'); }
  else {
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sedot-ext-'));
    fs.cpSync(path.join(ROOT, 'extension'), extDir, { recursive: true });
    const man = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
    for (const c of man.content_scripts) c.matches.push('http://127.0.0.1/*'); // halaman uji lokal ikut dicocokkan
    fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(man));
    const got = [];
    const stub = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        if (req.url === '/video') got.push(JSON.parse(b));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.origin || '*' });
        res.end(JSON.stringify({ ok: true }));
      });
    }).listen(17345, '127.0.0.1');
    const page = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'PREF=tema; Path=/' });
      const pr = { videoDetails: { videoId: 'YQRHrco73g4', title: 'Alan Walker - PLAY', lengthSeconds: '171' }, streamingData: { adaptiveFormats: [
        { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080, fps: 25, contentLength: '45000000', bitrate: 2500000 },
        { itag: 248, mimeType: 'video/webm; codecs="vp9"', height: 1080, fps: 25, contentLength: '40000000', bitrate: 2600000 },
        { itag: 136, mimeType: 'video/mp4; codecs="avc1.4d401f"', height: 720, fps: 25, contentLength: '20000000', bitrate: 1200000 },
        { itag: 134, mimeType: 'video/mp4; codecs="avc1.4d401e"', height: 360, fps: 25, contentLength: '5000000', bitrate: 300000 },
        { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', contentLength: '2700000', bitrate: 129000 },
        { itag: 251, mimeType: 'audio/webm; codecs="opus"', contentLength: '2800000', bitrate: 135000 },
      ] } };
      res.end(`<style>#movie_player{position:relative;width:860px;height:480px;background:#000}</style><h1 class="ytd-watch-metadata">Alan Walker - PLAY</h1><div id="movie_player" class="html5-video-player paused-mode"></div><script>
        window.playerClicks=0; window.keys=0;
        const p=document.getElementById("movie_player"); p.addEventListener("mousedown",()=>window.playerClicks++); document.addEventListener("keydown",()=>window.keys++);
        p.getPlayerResponse=()=>(${JSON.stringify(pr)});
      </script>`);
    }).listen(18196, '127.0.0.1');
    const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'prof-')), {
      executablePath: exe, headless: false, args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });
    const tab = await ctx.newPage();
    await tab.goto('http://127.0.0.1:18196/watch?v=YQRHrco73g4&list=RDabc&index=21');
    const btn = await tab.waitForSelector('#sedot-video-btn', { timeout: 10000 });
    assert.strictEqual(await btn.innerText(), 'Unduh video');
    await btn.click();
    await tab.waitForSelector('#sedot-video-menu', { timeout: 5000 });
    const menu = await tab.$$eval('#sedot-video-menu .sedot-item', (b) => b.map((x) => [...x.children].map((c) => c.textContent).filter(Boolean).join(' ')));
    const aligned = await tab.$$eval('#sedot-video-menu .sedot-item .sz', (z) => new Set(z.filter((x) => x.textContent).map((x) => Math.round(x.getBoundingClientRect().right))).size);
    assert.strictEqual(aligned, 1, 'semua ukuran rata kanan di garis yang sama');
    assert.deepStrictEqual(menu, ['1080p HD MP4 45 MB', '720p HD MP4 22 MB', '360p MP4 7 MB', 'Audio MP3 192 kbps ~4 MB', 'Audio M4A kualitas asli 3 MB', 'Pilihan lain… subtitle, folder, nama file'],
      'menu kualitas dari data pemutar: H.264 diutamakan, ukuran = gambar + suara');
    await tab.keyboard.press('ArrowDown');
    await tab.keyboard.press('Escape');
    assert.strictEqual(await tab.$('#sedot-video-menu'), null, 'Esc menutup menu');
    assert.strictEqual(await tab.evaluate(() => window.keys), 0, 'tombol keyboard di menu tidak sampai ke pemutar YouTube');
    await btn.click();
    await shot(tab, 'v4-menu-youtube.png');
    await tab.click('#sedot-video-menu .sedot-item:has-text("720p")');
    await tab.waitForFunction(() => document.getElementById('sedot-video-btn').dataset.state === 'ok', null, { timeout: 10000 });
    await shot(tab, 'v4-tombol-youtube.png');
    assert.strictEqual(got.length, 1);
    assert.deepStrictEqual(got[0].request, { kind: 'video', height: 720 });
    assert.strictEqual(got[0].title, 'Alan Walker - PLAY');
    assert.strictEqual(got[0].url, 'https://www.youtube.com/watch?v=YQRHrco73g4', 'playlist dibuang, hanya video ini');
    assert.ok(Array.isArray(got[0].cookies), 'cookie ikut dikirim');
    assert.strictEqual(await tab.evaluate(() => window.playerClicks), 0, 'klik tombol & menu tidak menjeda/memutar video');
    await btn.click();
    await tab.click('#sedot-video-menu .sedot-item.more');
    await tab.waitForFunction(() => document.getElementById('sedot-video-btn').dataset.state === 'ok', null, { timeout: 10000 });
    assert.strictEqual(got[1].request, null, 'Pilihan lain… -> dialog lengkap di aplikasi');
    await ctx.close();
    stub.close();
    page.close();
    log('OK 8. tombol + menu kualitas di pemutar: daftar & ukuran dari pemutar, kirim pilihan + URL bersih + cookie, tidak mengganggu pemutar');
  }

  srv.close();
  log('SEMUA UJI E2E VIDEO LULUS');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
