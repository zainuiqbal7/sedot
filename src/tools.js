'use strict';
// Komponen video (yt-dlp + ffmpeg): diunduh sekali saat fitur video pertama kali dipakai,
// diverifikasi SHA-256, dan yt-dlp diperbarui berkala (YouTube sering berubah).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';

const SOURCES = {
  ytdlp: {
    url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    sums: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS',
    sumName: 'yt-dlp.exe',
  },
  ffmpeg: {
    url: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip',
    sums: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/checksums.sha256',
    sumName: 'ffmpeg-master-latest-win64-gpl-shared.zip',
  },
};

class Tools {
  /** @param {string} dir  folder penyimpanan, mis. <userData>/tools */
  constructor(dir) {
    this.dir = dir;
    this.installing = null;
  }

  exe(name) { return path.join(this.dir, IS_WIN ? `${name}.exe` : name); }

  /** Lokasi alat: folder Sedot dulu, lalu PATH (untuk pengembangan di Linux/macOS). */
  find(name) {
    if (fs.existsSync(this.exe(name))) return this.exe(name);
    try {
      const out = execFileSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const first = out.split(/\r?\n/).find(Boolean);
      if (first) return first.trim();
    } catch { /* tidak ada */ }
    return null;
  }

  ready() { return !!(this.find('yt-dlp') && this.find('ffmpeg')); }

  /**
   * Pastikan yt-dlp & ffmpeg ada. onProgress({ step, done, total }) dipanggil selama mengunduh.
   * Panggilan bersamaan berbagi satu proses unduh.
   */
  ensure(onProgress = () => {}) {
    if (this.ready()) return Promise.resolve();
    if (!IS_WIN) return Promise.reject(new Error('yt-dlp dan ffmpeg belum terpasang. Pasang lewat package manager (mis. "pip install yt-dlp" dan "sudo apt install ffmpeg").'));
    if (!this.installing) {
      this.installing = this.install(onProgress).finally(() => { this.installing = null; });
    }
    return this.installing;
  }

  async install(onProgress) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(this.dir, 'unduh-'));
    try {
      const totals = { ytdlp: 0, ffmpeg: 0 };
      const dones = { ytdlp: 0, ffmpeg: 0 };
      const report = (step) => onProgress({ step, done: dones.ytdlp + dones.ffmpeg, total: totals.ytdlp + totals.ffmpeg || 115e6 });

      if (!fs.existsSync(this.exe('yt-dlp'))) {
        const file = path.join(tmp, 'yt-dlp.exe');
        await download(SOURCES.ytdlp, file, (d, t) => { dones.ytdlp = d; totals.ytdlp = t; report('yt-dlp'); });
        fs.renameSync(file, this.exe('yt-dlp'));
      }
      if (!fs.existsSync(this.exe('ffmpeg'))) {
        const zip = path.join(tmp, 'ffmpeg.zip');
        await download(SOURCES.ffmpeg, zip, (d, t) => { dones.ffmpeg = d; totals.ffmpeg = t; report('ffmpeg'); });
        onProgress({ step: 'ekstrak', done: 1, total: 1 });
        const out = path.join(tmp, 'ffmpeg');
        fs.mkdirSync(out);
        // tar bawaan Windows 10+ (bsdtar) bisa membuka .zip; ambil ffmpeg.exe + DLL-nya saja
        await run(windowsTar(), ['-xf', zip, '-C', out, '--strip-components', '2', '*/bin/*.dll', '*/bin/ffmpeg.exe']);
        for (const f of fs.readdirSync(out)) fs.renameSync(path.join(out, f), path.join(this.dir, f));
      }
      this.writeStamp();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  stampFile() { return path.join(this.dir, 'update-check.json'); }
  writeStamp() { try { fs.writeFileSync(this.stampFile(), JSON.stringify({ at: Date.now() })); } catch { /* abaikan */ } }

  /** Perbarui yt-dlp milik Sedot paling sering tiap 3 hari (atau dipaksa saat ekstraksi gagal). */
  async updateYtDlp({ force = false } = {}) {
    const exe = this.exe('yt-dlp');
    if (!IS_WIN || !fs.existsSync(exe)) return false; // yt-dlp dari PATH diurus pemiliknya sendiri
    let last = 0;
    try { last = JSON.parse(fs.readFileSync(this.stampFile(), 'utf8')).at || 0; } catch { /* belum pernah */ }
    if (!force && Date.now() - last < 3 * 24 * 3600 * 1000) return false;
    this.writeStamp();
    try {
      await run(exe, ['-U'], 120000);
      return true;
    } catch {
      return false;
    }
  }
}

/** Unduh berkas dan tolak kalau SHA-256 tidak cocok dengan daftar checksum resmi rilis yang sama. */
async function download(src, dest, onProgress) {
  const sums = await (await fetchOk(src.sums)).text();
  const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(` ${src.sumName}`) || l.trim().endsWith(`*${src.sumName}`));
  const expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error(`Checksum ${src.sumName} tidak ditemukan.`);

  const res = await fetchOk(src.url);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  let done = 0;
  let lastReport = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    done += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (Date.now() - lastReport > 250) { lastReport = Date.now(); onProgress(done, total); }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  onProgress(done, total);
  const got = hash.digest('hex');
  if (got !== expected) {
    fs.rmSync(dest, { force: true });
    throw new Error(`File ${src.sumName} rusak atau tidak resmi (checksum tidak cocok). Coba lagi.`);
  }
}

async function fetchOk(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Gagal mengunduh komponen (HTTP ${res.status}). Periksa koneksi internet.`);
  return res;
}

/** tar bawaan Windows (bsdtar, bisa .zip). Hindari GNU tar dari Git yang tidak bisa membuka .zip. */
function windowsTar() {
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(sys) ? sys : 'tar';
}

function run(cmd, args, timeout = 300000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr || '') }));
      else resolve(String(stdout || ''));
    });
  });
}

module.exports = { Tools, run };
