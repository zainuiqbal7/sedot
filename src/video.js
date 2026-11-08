'use strict';
// Unduh video dari situs (YouTube, TikTok, Instagram, X, …) memakai yt-dlp untuk MEMBACA info & link,
// lalu aria2 (multi-koneksi) untuk mengunduh, dan ffmpeg untuk menggabungkan gambar + suara.

const { execFile } = require('node:child_process');

const AUDIO_EXT = ['m4a', 'mp3', 'opus', 'ogg', 'aac', 'wav', 'flac', 'weba'];
const HTTP = ['https', 'http'];

/** Halaman yang kemungkinan besar berisi video (untuk clipboard & Tambah URL). */
function isVideoPageUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const h = u.hostname.replace(/^(www|m|music)\./, '');
  const p = u.pathname;
  if (h === 'youtube.com') return p === '/watch' || /^\/(shorts|live)\/[\w-]+/.test(p);
  if (h === 'youtu.be') return p.length > 1;
  if (h === 'tiktok.com') return /\/video\/\d+/.test(p);
  if (h === 'vm.tiktok.com' || h === 'vt.tiktok.com' || h === 'fb.watch') return p.length > 1;
  if (h === 'instagram.com') return /^\/(reel|reels|p|tv)\//.test(p);
  if (h === 'x.com' || h === 'twitter.com') return /\/status\/\d+/.test(p);
  if (h === 'facebook.com') return /^\/(watch|reel)|\/videos\//.test(p);
  if (h === 'vimeo.com') return /^\/\d+/.test(p);
  if (h === 'dailymotion.com') return p.startsWith('/video/');
  if (h === 'bilibili.com') return p.startsWith('/video/');
  return false;
}

const CODEC_RANK = (v = '') => (v.startsWith('avc1') ? 3 : /^vp0?9/.test(v) ? 2 : v.startsWith('av01') ? 1 : 0);
const CODEC_NAME = (v = '') => (v.startsWith('avc1') ? 'H.264' : /^vp0?9/.test(v) ? 'VP9' : v.startsWith('av01') ? 'AV1' : '');

function kindOf(f) {
  const v = f.vcodec;
  const a = f.acodec;
  if (v === 'none' && a !== 'none') return 'audio';
  if (a === 'none' && v && v !== 'none') return 'video';
  if (v == null && a == null && !f.height && !f.width && AUDIO_EXT.includes(f.ext)) return 'audio';
  return 'both';
}

function sizeOf(f, duration) {
  return f.filesize || f.filesize_approx || (f.tbr && duration ? Math.round(f.tbr * 125 * duration) : 0);
}

/** "a=1; Domain=.x; Path=/; b=2; Secure" (format cookies yt-dlp) -> "a=1; b=2" */
function cookieHeaderFrom(s) {
  if (!s) return '';
  const attrs = new Set(['domain', 'path', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'comment', 'version']);
  return s.split(/;\s*/).filter((t) => t.includes('=') && !attrs.has(t.split('=')[0].trim().toLowerCase())).join('; ');
}

function partOf(f, kind, duration) {
  const headers = Object.entries(f.http_headers || {}).map(([k, v]) => `${k}: ${v}`);
  const cookie = cookieHeaderFrom(f.cookies);
  if (cookie) headers.push(`Cookie: ${cookie}`);
  return { formatId: String(f.format_id), kind, ext: f.ext, url: f.url, headers, size: sizeOf(f, duration) };
}

/**
 * Info JSON dari `yt-dlp -J` -> pilihan unduhan yang mudah dipahami.
 * Video: satu pilihan per resolusi (H.264 diutamakan supaya bisa diputar di mana saja).
 * Audio: MP3 (dikonversi) dan M4A (asli, tanpa konversi) bila tersedia.
 */
function buildChoices(info) {
  const duration = info.duration || 0;
  const usable = (info.formats || []).filter((f) => f.url && HTTP.includes(f.protocol || 'https')
    && !f.has_drm && f.ext !== 'mhtml' && f.format_note !== 'storyboard');

  const audios = usable.filter((f) => kindOf(f) === 'audio').sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
  const bestAudio = audios[0] || null;
  const bestM4a = audios.find((f) => f.ext === 'm4a' || (f.acodec || '').startsWith('mp4a')) || null;
  const mergeAudio = bestM4a || bestAudio;

  const byHeight = new Map();
  for (const f of usable) {
    const k = kindOf(f);
    if (k === 'audio') continue;
    if (k === 'video' && !mergeAudio) continue; // gambar tanpa suara tidak berguna
    const h = f.height || 0;
    const score = [k === 'video' ? 1 : 0, CODEC_RANK(f.vcodec), f.fps || 0, f.tbr || 0];
    const cur = byHeight.get(h);
    if (!cur || cmpScore(score, cur.score) > 0) byHeight.set(h, { f, k, score });
  }

  const choices = [];
  for (const [h, { f, k }] of [...byHeight].sort((a, b) => b[0] - a[0])) {
    const parts = k === 'video' ? [partOf(f, 'video', duration), partOf(mergeAudio, 'audio', duration)] : [partOf(f, 'single', duration)];
    const fps = f.fps && f.fps > 30 ? Math.round(f.fps) : '';
    const codec = CODEC_NAME(f.vcodec);
    choices.push({
      id: `v${h}${fps}-${f.format_id}`,
      kind: 'video',
      label: h ? `${h}p${fps}` : 'Video',
      detail: ['MP4', codec, h >= 720 ? 'HD' : ''].filter(Boolean).join(' · '),
      height: h,
      size: parts.reduce((a, p) => a + p.size, 0),
      out: 'mp4',
      parts,
    });
  }

  if (bestAudio) {
    const kbps = Math.round(bestAudio.abr || bestAudio.tbr || 0);
    choices.push({ id: 'mp3', kind: 'audio', label: 'Audio MP3', detail: '192 kbps', size: duration ? Math.round(192 * 125 * duration) : 0, out: 'mp3', parts: [partOf(bestAudio, 'audio', duration)] });
    if (bestM4a) {
      const k2 = Math.round(bestM4a.abr || bestM4a.tbr || kbps);
      choices.push({ id: 'm4a', kind: 'audio', label: 'Audio M4A', detail: `asli${k2 ? ` · ${k2} kbps` : ''}, tanpa konversi`, size: sizeOf(bestM4a, duration), out: 'm4a', parts: [partOf(bestM4a, 'audio', duration)] });
    }
  }

  // Bawaan: 1080p kalau ada (besar tapi wajar), kalau tidak resolusi tertinggi di bawahnya
  const vids = choices.filter((c) => c.kind === 'video');
  const def = vids.find((c) => c.height && c.height <= 1080) || vids[0] || choices[0] || null;

  return {
    id: info.id,
    key: `${info.extractor_key || info.extractor || 'web'}:${info.id}`,
    title: info.title || info.id || 'video',
    uploader: info.uploader || info.channel || '',
    duration,
    thumbnail: info.thumbnail || '',
    site: info.extractor_key || info.extractor || '',
    pageUrl: info.webpage_url || info.original_url || '',
    isLive: !!info.is_live,
    choices,
    defaultChoice: def ? def.id : null,
    subtitles: pickSubtitles(info),
  };
}

function cmpScore(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const LANG_ID = {
  id: 'Indonesia', en: 'Inggris', ja: 'Jepang', ko: 'Korea', zh: 'Mandarin', 'zh-Hans': 'Mandarin (Sederhana)', 'zh-Hant': 'Mandarin (Tradisional)',
  ms: 'Melayu', ar: 'Arab', es: 'Spanyol', fr: 'Prancis', de: 'Jerman', pt: 'Portugis', ru: 'Rusia', th: 'Thai', vi: 'Vietnam',
  hi: 'Hindi', tr: 'Turki', it: 'Italia', nl: 'Belanda', tl: 'Tagalog', jv: 'Jawa', su: 'Sunda',
};

function pickSubtitles(info) {
  const out = [];
  const take = (entries, auto, lang) => {
    if (!Array.isArray(entries) || !entries.length) return;
    const e = entries.find((x) => x.ext === 'vtt') || entries.find((x) => x.ext === 'srt') || entries[0];
    if (!e?.url) return;
    const base = lang.replace(/-orig$/, '');
    out.push({ lang, name: (LANG_ID[base] || entries[0].name || lang) + (auto ? ' (otomatis)' : ''), auto, url: e.url, ext: e.ext || 'vtt' });
  };
  for (const [lang, entries] of Object.entries(info.subtitles || {})) if (lang !== 'live_chat') take(entries, false, lang);
  const want = new Set(['id', 'en', info.language].filter(Boolean));
  for (const [lang, entries] of Object.entries(info.automatic_captions || {})) {
    const base = lang.replace(/-orig$/, '');
    if (!want.has(base) && !lang.endsWith('-orig')) continue;
    if (out.some((s) => s.lang === base)) continue; // sudah ada versi buatan manusia
    take(entries, true, lang);
  }
  return out;
}

/** Pesan error yt-dlp -> bahasa yang dimengerti. */
function ytdlpError(stderr = '') {
  const s = String(stderr);
  const rules = [
    [/confirm you.?re not a bot/i, 'YouTube meminta verifikasi "bukan bot". Pastikan kamu sudah login YouTube di browser, lalu klik Unduh video lagi dari halaman videonya.'],
    [/confirm your age|age.restricted|inappropriate for some users/i, 'Video ini dibatasi umur. Login YouTube di browser, lalu klik Unduh video lagi dari halaman videonya.'],
    [/private video/i, 'Video ini privat, jadi tidak bisa diunduh.'],
    [/members.only|join this channel/i, 'Video ini khusus anggota channel.'],
    [/\bDRM\b/i, 'Video ini dilindungi DRM, jadi tidak bisa diunduh.'],
    [/is live|live event|premieres in|will begin in/i, 'Siaran langsung atau premiere belum bisa diunduh. Coba lagi setelah siarannya selesai.'],
    [/unsupported url/i, 'Alamat ini bukan halaman video yang dikenali.'],
    [/video unavailable|not available|has been removed|no longer available/i, 'Video tidak tersedia (dihapus, privat, atau dibatasi di wilayahmu).'],
    [/getaddrinfo|timed out|unable to download webpage|connection (reset|refused)|network/i, 'Tidak bisa menghubungi situsnya. Periksa koneksi internet lalu coba lagi.'],
    [/requested format is not available|no video formats/i, 'Tidak ada format video yang bisa diunduh dari halaman ini.'],
  ];
  for (const [re, msg] of rules) if (re.test(s)) return msg;
  const last = s.split(/\r?\n/).filter((l) => /ERROR/.test(l)).pop() || s.trim().split(/\r?\n/).pop() || '';
  return `Gagal membaca info video. ${last.replace(/^ERROR:\s*/, '').slice(0, 300)}`.trim();
}

/** Cookie dari ekstensi (chrome.cookies) -> file format Netscape untuk yt-dlp. */
function cookiesToNetscape(cookies) {
  const clean = (v) => String(v ?? '').replace(/[\t\r\n]/g, '');
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of Array.isArray(cookies) ? cookies : []) {
    if (!c?.name || !c.domain) continue;
    const domain = c.hostOnly ? clean(c.domain).replace(/^\./, '') : `.${clean(c.domain).replace(/^\./, '')}`;
    lines.push([domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', clean(c.path || '/'), c.secure ? 'TRUE' : 'FALSE',
      Math.floor(c.expirationDate || 0), clean(c.name), clean(c.value)].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Jalankan `yt-dlp -J` dan kembalikan info mentah.
 * @param {object} o { ytdlp, url, cookiesFile, jsRuntime }  jsRuntime = path Node/Electron untuk tantangan JS YouTube
 */
function probeVideo({ ytdlp, url, cookiesFile, jsRuntime }) {
  const args = ['-J', '--no-playlist', '--ignore-config', '--no-warnings', '--no-progress'];
  if (jsRuntime) args.push('--js-runtimes', `node:${jsRuntime}`);
  if (cookiesFile) args.push('--cookies', cookiesFile);
  args.push('--', url);
  return new Promise((resolve, reject) => {
    execFile(ytdlp, args, {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, // supaya Sedot.exe bisa berperan sebagai Node bagi yt-dlp
    }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(ytdlpError(stderr || err.message)));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(ytdlpError(stderr || 'keluaran yt-dlp tidak bisa dibaca')));
      }
    });
  });
}

/** Gabungkan / konversi dengan ffmpeg. */
function ffmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, timeout: 6 * 3600 * 1000, maxBuffer: 16 * 1024 * 1024 },
      (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split(/\r?\n/).pop())) : resolve()));
  });
}

function mergeArgs({ mode, inputs, out, title, artist }) {
  const meta = ['-metadata', `title=${title || ''}`, ...(artist ? ['-metadata', `artist=${artist}`] : [])];
  if (mode === 'mp3') return ['-i', inputs[0], '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', ...meta, out];
  if (mode === 'm4a') return ['-i', inputs[0], '-vn', '-c:a', 'copy', ...meta, out];
  const mp4 = /\.(mp4|m4v|mov)$/i.test(out) ? ['-movflags', '+faststart'] : []; // opsi khusus wadah MP4
  if (inputs.length === 1) return ['-i', inputs[0], '-c', 'copy', ...mp4, ...meta, out];
  return ['-i', inputs[0], '-i', inputs[1], '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', ...mp4, ...meta, out];
}

function safeTitle(t) {
  const s = String(t || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return (s || 'video').slice(0, 150);
}

module.exports = { isVideoPageUrl, buildChoices, ytdlpError, cookiesToNetscape, cookieHeaderFrom, probeVideo, ffmpeg, mergeArgs, safeTitle, kindOf };
