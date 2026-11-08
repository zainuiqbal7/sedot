'use strict';
// Mengunduh aria2c.exe resmi (Windows 64-bit) ke folder bin/, dengan verifikasi SHA-256.
// Otomatis dijalankan oleh "npm install". Di Linux/macOS: pasang aria2 lewat package manager.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const URL = 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip';
const SHA256 = '67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288';
const INNER = 'aria2-1.37.0-win-64bit-build1';

const binDir = path.join(__dirname, '..', 'bin');
const target = path.join(binDir, 'aria2c.exe');

(async () => {
  if (process.platform !== 'win32' && !process.argv.includes('--force')) {
    console.log('[get-aria2] Bukan Windows: lewati. Pasang aria2 dari package manager (mis. "sudo apt install aria2" / "brew install aria2").');
    return;
  }
  if (fs.existsSync(target)) { console.log('[get-aria2] aria2c.exe sudah ada.'); return; }

  console.log('[get-aria2] Mengunduh aria2 1.37.0 …');
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== SHA256) throw new Error(`Hash tidak cocok! diharapkan ${SHA256}, dapat ${got}. File ditolak.`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aria2-'));
  const zip = path.join(tmp, 'aria2.zip');
  fs.writeFileSync(zip, buf);
  execFileSync('tar', ['-xf', zip, '-C', tmp]); // tar bawaan Windows 10+ bisa membuka .zip
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(path.join(tmp, INNER, 'aria2c.exe'), target);
  for (const f of ['COPYING', 'README.html']) {
    const p = path.join(tmp, INNER, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(binDir, `aria2-${f}`));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`[get-aria2] Selesai: ${target}`);
})().catch((e) => {
  console.error(`[get-aria2] Gagal: ${e.message}`);
  console.error('Unduh manual dari https://github.com/aria2/aria2/releases lalu taruh aria2c.exe di folder bin/.');
  process.exitCode = 1;
});
