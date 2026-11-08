'use strict';
// Uji logika pilihan video dengan data tiruan berformat `yt-dlp -J` YouTube: node test/video.test.js
const assert = require('node:assert');
const v = require('../src/video');

const H = { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' };
const fmt = (o) => ({ protocol: 'https', url: `https://rr1.googlevideo.com/videoplayback?itag=${o.format_id}`, http_headers: H, ...o });
const yt = {
  id: 'YQRHrco73g4', extractor_key: 'Youtube', title: 'Alan Walker, K-391 - PLAY', uploader: 'Alan Walker', duration: 171,
  webpage_url: 'https://www.youtube.com/watch?v=YQRHrco73g4', language: 'en',
  formats: [
    { format_id: 'sb0', ext: 'mhtml', protocol: 'mhtml', format_note: 'storyboard', vcodec: 'none', acodec: 'none', url: 'x' },
    fmt({ format_id: '139', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.5', abr: 48, filesize: 1e6 }),
    fmt({ format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129, filesize: 2.7e6 }),
    fmt({ format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 135, filesize: 2.8e6 }),
    fmt({ format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, fps: 25, tbr: 500, filesize_approx: 9e6 }),
    fmt({ format_id: '134', ext: 'mp4', vcodec: 'avc1.4d401e', acodec: 'none', height: 360, fps: 25, tbr: 300, filesize: 5e6 }),
    fmt({ format_id: '136', ext: 'mp4', vcodec: 'avc1.64001f', acodec: 'none', height: 720, fps: 25, tbr: 1200, filesize: 20e6 }),
    fmt({ format_id: '247', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 720, fps: 25, tbr: 1400, filesize: 22e6 }),
    fmt({ format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, fps: 25, tbr: 2500, filesize: 45e6 }),
    fmt({ format_id: '248', ext: 'webm', vcodec: 'vp09.00.40.08', acodec: 'none', height: 1080, fps: 25, tbr: 2600, filesize: 40e6 }),
    fmt({ format_id: '399', ext: 'mp4', vcodec: 'av01.0.08M.08', acodec: 'none', height: 1080, fps: 25, tbr: 2000, filesize: 30e6 }),
    fmt({ format_id: '271', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1440, fps: 25, tbr: 9000, filesize: 150e6 }),
    fmt({ format_id: '96', ext: 'mp4', protocol: 'm3u8_native', vcodec: 'avc1', acodec: 'mp4a', height: 1080 }),
    { format_id: 'drm', ext: 'mp4', protocol: 'https', url: 'y', has_drm: true, vcodec: 'avc1', acodec: 'none', height: 2160 },
  ],
  subtitles: { id: [{ ext: 'json3', url: 'j', name: 'Indonesian' }, { ext: 'vtt', url: 'https://yt/sub-id.vtt', name: 'Indonesian' }], live_chat: [{ ext: 'json', url: 'z' }] },
  automatic_captions: { en: [{ ext: 'vtt', url: 'https://yt/auto-en.vtt', name: 'English' }], 'en-orig': [{ ext: 'vtt', url: 'https://yt/en-orig.vtt', name: 'English (Original)' }], fr: [{ ext: 'vtt', url: 'f', name: 'French' }], id: [{ ext: 'vtt', url: 'dup', name: 'Indonesian' }] },
};

const r = v.buildChoices(yt);
assert.strictEqual(r.key, 'Youtube:YQRHrco73g4');
assert.deepStrictEqual(r.choices.map((c) => c.label), ['1440p', '1080p', '720p', '360p', 'Audio MP3', 'Audio M4A']);
const c1080 = r.choices.find((c) => c.label === '1080p');
assert.deepStrictEqual(c1080.parts.map((p) => p.formatId), ['137', '140'], '1080p: H.264 diutamakan + audio M4A terbaik');
assert.match(c1080.detail, /H\.264/);
assert.strictEqual(c1080.size, 45e6 + 2.7e6);
assert.deepStrictEqual(r.choices.find((c) => c.label === '1440p').parts.map((p) => p.formatId), ['271', '140'], 'di atas 1080p hanya VP9');
assert.deepStrictEqual(r.choices.find((c) => c.label === '360p').parts.map((p) => p.formatId), ['134', '140'], 'video-only + audio diutamakan daripada progresif');
assert.strictEqual(r.defaultChoice, c1080.id, 'bawaan 1080p');
assert.deepStrictEqual(r.choices.find((c) => c.id === 'mp3').parts.map((p) => p.formatId), ['251'], 'MP3 dari audio kualitas tertinggi');
assert.deepStrictEqual(r.choices.find((c) => c.id === 'm4a').parts.map((p) => p.formatId), ['140']);
assert.ok(!r.choices.some((c) => c.parts.some((p) => ['96', 'drm', 'sb0'].includes(p.formatId))), 'm3u8, DRM, storyboard dibuang');
assert.ok(c1080.parts[0].headers.includes('User-Agent: Mozilla/5.0'), 'header dari yt-dlp ikut');
assert.deepStrictEqual(r.subtitles.map((s) => `${s.lang}:${s.url}`), ['id:https://yt/sub-id.vtt', 'en:https://yt/auto-en.vtt'],
  'subtitle manusia diutamakan (vtt), otomatis hanya id/en/bahasa asli tanpa duplikat (en-orig), live_chat & fr dibuang');

// Situs tanpa video terpisah (mis. TikTok): format gabungan
const tt = v.buildChoices({ id: '1', extractor_key: 'TikTok', title: 'tt', duration: 10, formats: [
  fmt({ format_id: 'h264_540', ext: 'mp4', vcodec: 'h264', acodec: 'aac', height: 1024, tbr: 1000 }),
  fmt({ format_id: 'bytevc1', ext: 'mp4', vcodec: 'h265', acodec: 'aac', height: 1024, tbr: 800 }),
  fmt({ format_id: 'dl', ext: 'mp4', vcodec: 'h264', acodec: 'aac', height: 576, tbr: 600, cookies: 'tt_chain=abc; Domain=.tiktok.com; Path=/; Secure; ttwid=xyz; Expires=1' }),
] });
assert.deepStrictEqual(tt.choices.map((c) => `${c.label}:${c.parts.map((p) => p.kind).join('+')}`), ['1024p:single', '576p:single']);
assert.ok(tt.choices[1].parts[0].headers.includes('Cookie: tt_chain=abc; ttwid=xyz'), 'cookie per format ikut, atribut dibuang');

// Halaman tanpa format http: kosong
assert.strictEqual(v.buildChoices({ id: 'x', formats: [fmt({ format_id: 'h', protocol: 'm3u8_native', vcodec: 'avc1', acodec: 'mp4a', height: 720 })] }).choices.length, 0);

// URL halaman video
for (const u of ['https://www.youtube.com/watch?v=YQRHrco73g4&list=RD', 'https://youtu.be/abc', 'https://www.youtube.com/shorts/abc',
  'https://music.youtube.com/watch?v=x', 'https://www.tiktok.com/@a/video/123', 'https://www.instagram.com/reel/abc/', 'https://x.com/a/status/1']) {
  assert.ok(v.isVideoPageUrl(u), u);
}
for (const u of ['https://www.youtube.com/', 'https://www.youtube.com/@alanwalker', 'https://example.com/a.mp4', 'bukan url']) assert.ok(!v.isVideoPageUrl(u), u);

// Error yt-dlp
assert.match(v.ytdlpError("ERROR: [youtube] x: Sign in to confirm you're not a bot"), /bukan bot/);
assert.match(v.ytdlpError('ERROR: [youtube] x: Private video'), /privat/);
assert.match(v.ytdlpError('ERROR: Unsupported URL: https://a'), /bukan halaman video/);
assert.match(v.ytdlpError('ERROR: something odd happened'), /something odd happened/);

// Cookie Netscape
const nc = v.cookiesToNetscape([{ domain: '.youtube.com', path: '/', secure: true, expirationDate: 1900000000.5, name: 'SID', value: 'a\tb' }, { domain: 'www.youtube.com', hostOnly: true, path: '/', name: 'x', value: '1' }]);
assert.strictEqual(nc, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\tab\nwww.youtube.com\tFALSE\t/\tFALSE\t0\tx\t1\n');

// Nama file
assert.strictEqual(v.safeTitle('Alan Walker: PLAY / K-391?'), 'Alan Walker PLAY K-391');
assert.strictEqual(v.safeTitle('...'), 'video');

assert.deepStrictEqual(r.subtitles.map((x) => x.name), ['Indonesia', 'Inggris (otomatis)'], 'nama bahasa dalam bahasa Indonesia');
console.log('OK video: pilihan kualitas (H.264 diutamakan), audio MP3/M4A, subtitle, situs format gabungan, URL video, error, cookie');
