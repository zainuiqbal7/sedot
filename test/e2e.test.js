'use strict';
// Uji menyeluruh (E2E): menjalankan aplikasi Sedot sungguhan dan mengklik seperti pengguna.
// Jalankan: npm run test:e2e   (Linux tanpa layar: xvfb-run -a npm run test:e2e)
// Screenshot disimpan ke folder di E2E_SHOTS kalau variabel itu diisi.
const { _electron } = require('playwright-core');
const ELECTRON = require('electron');
const ROOT = require('path').join(__dirname, '..');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const OUT = process.env.E2E_SHOTS || null;
const shot = (page, name) => (OUT ? page.screenshot({ path: path.join(OUT, name) }) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZE = 30 * 1024 * 1024;
const byteAt = (i) => (i * 31 + (i >> 8)) & 255;
const DATA = Buffer.alloc(SIZE); for (let i = 0; i < SIZE; i++) DATA[i] = byteAt(i);
let oldBudget = SIZE * 0.4, servedNew = 0, served = {};
const log = (...a) => console.log(...a);

const srv = http.createServer((req, res) => {
  const u0 = new URL(req.url, 'http://x'); const slow = u0.searchParams.has('slow');
  const m0 = /^\/t\/(\w+)\/(.+)$/.exec(u0.pathname);
  if (!m0) { res.writeHead(404); return res.end(); }
  const [, token, rawName] = m0; const name = decodeURIComponent(rawName);
  if (!(req.headers.cookie || '').includes('accountToken=abc')) { res.writeHead(403); return res.end(); }
  if (token === 'old' && oldBudget <= 0) { res.writeHead(403); return res.end('expired'); }
  let s = 0, e = SIZE - 1; const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) { s = +m[1]; if (m[2]) e = Math.min(+m[2], SIZE - 1); }
  res.writeHead(m ? 206 : 200, { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, ...(m ? { 'Content-Range': `bytes ${s}-${e}/${SIZE}` } : {}) });
  let p = s;
  const t = setInterval(() => {
    if (res.destroyed) return clearInterval(t);
    if (token === 'old' && oldBudget <= 0) { clearInterval(t); res.destroy(); return; } // link mati di tengah jalan
    const n = Math.min(32768, e + 1 - p);
    res.write(DATA.subarray(p, p + n)); p += n;
    if (token === 'old') oldBudget -= n; else servedNew += n;
    served[token] = (served[token] || 0) + n;
    if (p > e) { clearInterval(t); res.end(); }
  }, slow ? 200 : 20);
  res.on('close', () => clearInterval(t));
}).listen(18190, '127.0.0.1');
const U = (tok, name) => `http://127.0.0.1:18190/t/${tok}/${encodeURIComponent(name)}`;

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-'));
  const app = await _electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', ROOT], env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') } });
  const main = await app.firstWindow();
  await main.setViewportSize({ width: 1100, height: 700 });
  await sleep(1500);
  // tangkap menu klik kanan (menu asli tidak bisa diklik Playwright)
  await app.evaluate(({ Menu }) => { Menu.prototype.popup = function () { global.__menu = this; }; });

  // 1. Sambutan pertama kali
  assert.ok(await main.$eval('#dlgExt', (d) => d.open), 'dialog sambutan harus muncul saat pertama dibuka');
  log('OK 1. dialog sambutan pertama kali');
  await shot(main, '01-sambutan.png');
  await main.click('#extDone'); await sleep(300);

  // 2. Ekstensi terdeteksi saat ping
  await fetch('http://127.0.0.1:17345/ping', { headers: { Origin: 'chrome-extension://abc' } }); await sleep(1300);
  assert.match(await main.textContent('#sbBridge'), /terhubung/);
  assert.ok(await main.$eval('#btnExtGuide', (b) => b.hidden));
  log('OK 2. ekstensi terdeteksi');

  const send = (url) => fetch('http://127.0.0.1:17345/add', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abc' }, body: JSON.stringify({ url, cookie: 'accountToken=abc', referer: 'https://gofile.io/d/x' }) }).then((r) => r.json());
  const NAME = 'Otakudesu.io_KMRBK--06_Mkv1080p.mkv';

  // 3. Unduh dengan link lama -> kedaluwarsa di 40%
  let wp = app.waitForEvent('window'); await send(U('old', NAME)); let w = await wp; await sleep(1500);
  await w.click('#start').catch(() => {}); // dialog menutup diri
  for (let i = 0; i < 60; i++) { await sleep(500); const st = await main.$$eval('#rows tr', (rs) => rs.map((r) => r.children[5].innerText)); if (st.some((s) => /kedaluwarsa/i.test(s))) break; }
  const rowsAfterExpire = await main.$$eval('#rows tr', (rs) => rs.map((r) => [r.children[0].innerText, r.children[5].innerText, r.children[2].innerText.replace(/\n/g, ' ')]));
  assert.deepStrictEqual(rowsAfterExpire.map((r) => r[1]), ['Link kedaluwarsa']);
  await main.click('#rows tr:has-text("KMRBK")'); await sleep(1300);
  assert.ok(!(await main.$eval('#detail', (d) => d.hidden)), 'panel detail tampil');
  assert.match(await main.textContent('#dErrorText'), /kedaluwarsa/);
  assert.ok(await main.$$eval('#dSeg i', (x) => x.length) > 0, 'bar segmen terisi');
  log('OK 3. link kedaluwarsa terdeteksi + panel detail');
  await shot(main, '02-kedaluwarsa.png');

  // 4. Klik download lagi (link baru) -> dialog menawarkan lanjut
  wp = app.waitForEvent('window'); await send(U('new', NAME)); w = await wp; await sleep(1800);
  const offer = await w.evaluate(() => ({ shown: !document.getElementById('resumeBox').hidden, title: document.getElementById('resumeTitle').textContent, btn: document.getElementById('start').textContent, locked: document.getElementById('filename').disabled }));
  assert.ok(offer.shown && offer.locked && /dari 40%/.test(offer.title) && offer.btn === 'Lanjutkan unduh', JSON.stringify(offer));
  await shot(w, '03-dialog-lanjut.png');
  await w.keyboard.press('Enter').catch(() => {}); // dialog langsung tertutup setelah Enter
  for (let i = 0; i < 80; i++) { await sleep(500); const st = await main.$$eval('#rows tr', (rs) => rs.map((r) => r.children[5].innerText)); if (st.includes('Selesai')) break; }
  const rows4 = await main.$$eval('#rows tr', (rs) => rs.map((r) => [r.children[0].innerText, r.children[5].innerText]));
  const dl = (await main.evaluate(() => sedot.getSettings())).downloadDir;
  const file = path.join(dl, 'Video', NAME);
  const got = fs.readFileSync(file);
  assert.strictEqual(rows4.filter((r) => r[0] === NAME).length, 1, 'tidak boleh ada baris dobel');
  assert.ok(got.length === SIZE && got.equals(DATA), 'isi file harus identik');
  assert.ok(servedNew < SIZE * 0.75, `link baru hanya mengambil sisa (dapat ${servedNew})`);
  log(`OK 4. lanjut dengan link baru: file utuh, link baru hanya ${(servedNew / 1048576).toFixed(1)} MB dari ${SIZE / 1048576} MB`);

  // 5. Pengurutan kolom
  await main.click('th[data-sort="name"]'); await sleep(200);
  assert.strictEqual(await main.$eval('th[data-sort="name"]', (t) => t.dataset.dir), 'asc');
  log('OK 5. urut kolom');

  // 6. Unduhan aktif: detail koneksi + batas kecepatan per file + klik kanan
  wp = app.waitForEvent('window'); await send(U('new', 'Episode 07.mkv') + '?slow=1'); w = await wp; await sleep(1200); await w.click('#start').catch(() => {}); // dialog menutup diri await sleep(2500);
  await main.click('#rows tr:has-text("Episode 07")'); await sleep(1500);
  const conns = await main.$$eval('#dConns li', (l) => l.map((x) => x.innerText.replace(/\n/g, ' ')));
  assert.ok(conns.length > 1 && /KB\/s|MB\/s/.test(conns[0]), JSON.stringify(conns));
  await shot(main, '04-detail-aktif.png');
  await main.fill('#dLimit', '500'); await main.click('#dLimitApply'); await sleep(8000);
  const doneOf = () => main.evaluate(async () => (await sedot.state()).items.find((i) => i.name === 'Episode 07.mkv').done);
  const d0 = await doneOf(); await sleep(10000); const d1 = await doneOf();
  await shot(main, '04b-detail-terbatas.png');
  const kbps = Math.round((d1 - d0) / 10 / 1024);
  assert.ok(kbps > 0 && kbps < 650, `batas per file harus berlaku (dapat ${kbps} KB/s)`);
  await main.click('#rows tr:has-text("Episode 07")', { button: 'right' }); await sleep(300);
  const labels = await app.evaluate(() => global.__menu.items.map((i) => (i.type === 'separator' ? '—' : `${i.label}${i.enabled ? '' : ' (mati)'}`)));
  assert.ok(labels.includes('Jeda') && labels.includes('Buka file (mati)') && labels.includes('Ganti link…'), labels.join('|'));
  await app.evaluate(() => global.__menu.items.find((i) => i.label === 'Salin link').click()); await sleep(300);
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /Episode%2007/);
  log(`OK 6. koneksi, batas per file (${kbps} KB/s), klik kanan, salin link`);
  await main.fill('#dLimit', '0'); await main.click('#dLimitApply');

  // 7. Setelah semua selesai -> hitung mundur, lalu dibatalkan
  await main.selectOption('#afterAll', 'sleep');
  for (let i = 0; i < 60; i++) { await sleep(500); if (!(await main.$eval('#countdown', (d) => d.hidden))) break; }
  assert.match(await main.textContent('#countdownText'), /Sleep dalam \d+ detik/);
  await shot(main, '05-hitung-mundur.png');
  await main.click('#btnCancelCountdown'); await sleep(500);
  assert.ok(await main.$eval('#countdown', (d) => d.hidden));
  assert.strictEqual(await main.$eval('#afterAll', (s) => s.value), 'none');
  log('OK 7. hitung mundur setelah semua selesai + batal');

  // 8. Clipboard: salin link file -> tawaran muncul
  await app.evaluate(({ clipboard }) => clipboard.writeText('http://127.0.0.1:18190/t/new/Soundtrack%20OP.mp3')); await sleep(1600);
  assert.ok(!(await main.$eval('#offer', (d) => d.hidden)));
  assert.strictEqual(await main.textContent('#offerName'), 'Soundtrack OP.mp3');
  await shot(main, '06-clipboard.png');
  wp = app.waitForEvent('window'); await main.click('#btnOfferYes'); w = await wp; await sleep(800);
  assert.strictEqual(await w.title(), 'Info unduhan'); await w.keyboard.press('Escape').catch(() => {}); await sleep(500);
  await app.evaluate(({ clipboard }) => clipboard.writeText('https://contoh.com/artikel-berita')); await sleep(1500);
  assert.ok(await main.$eval('#offer', (d) => d.hidden), 'link halaman biasa tidak ditawarkan');
  log('OK 8. tawaran clipboard');

  // 9. Seret-lepas link
  wp = app.waitForEvent('window');
  await main.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/uri-list', 'http://127.0.0.1:18190/t/new/Seret.zip'); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
  w = await wp; await sleep(1000); assert.strictEqual(await w.inputValue('#filename'), 'Seret.zip'); log('OK 9. seret-lepas link'); await w.keyboard.press('Escape').catch(() => {}); await sleep(400);

  // 10. Peringatan duplikat
  wp = app.waitForEvent('window'); await send(U('new', NAME) + '?lagi=1'); w = await wp; await sleep(1800);
  assert.ok(await w.evaluate(() => !document.getElementById('dupBox').hidden), 'peringatan duplikat');
  log('OK 10. peringatan file dobel');
  await shot(w, '07-duplikat.png');
  await w.keyboard.press('Escape').catch(() => {}); await sleep(400);

  // 11. Dua ekstensi kirim link sama -> hanya satu dialog
  let wins = 0; const onWin = () => wins++; app.on('window', onWin);
  await Promise.all([send(U('new', 'Dobel.zip')), send(U('new', 'Dobel.zip'))]); await sleep(1500);
  app.off('window', onWin);
  assert.strictEqual(wins, 1);
  log('OK 11. dua ekstensi kirim link sama -> satu dialog');
  for (const x of app.windows()) if (x !== main) await x.keyboard.press('Escape').catch(() => {});

  // 12. Tampilan akhir + ukuran sempit
  await main.click('#rows tr:has-text("KMRBK")'); await sleep(1200);
  await shot(main, '08-selesai-detail.png');
  await main.click('#rows tr:has-text("Episode 07")'); await sleep(1200);
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; }); await sleep(800);
  await shot(main, '10-gelap.png');
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; }); await sleep(300);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 560)); await sleep(800);
  const ov = await main.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(ov.sw <= ov.cw, 'tidak boleh ada scroll horizontal di 800px');
  log('OK 12. tata letak 800px');
  log('SEMUA UJI E2E LULUS');
  await shot(main, '09-sempit.png');

  await app.evaluate(({ app }) => app.quit()); srv.close(); process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
