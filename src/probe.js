'use strict';
// Mengintip nama file & ukuran sebelum unduhan dimulai, tanpa mengunduh isinya.
// Caranya: minta 1 byte pertama saja (Range: bytes=0-0), baca header, lalu putuskan koneksi.

const { nameFromUrl } = require('./categories');

/**
 * @param {object} job { url, cookie, referer, userAgent }
 * @returns {Promise<{ filename: string, size: number, resumable: boolean, finalUrl: string }>}
 */
async function probe(job, timeoutMs = 8000) {
  const headers = { Range: 'bytes=0-0' };
  if (job.cookie) headers.Cookie = job.cookie.replace(/[\r\n]/g, '');
  if (job.referer) headers.Referer = job.referer;
  if (job.userAgent) headers['User-Agent'] = job.userAgent;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(job.url, { headers, redirect: 'follow', signal: ctrl.signal });
    res.body?.cancel().catch(() => {});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let size = 0;
    const cr = res.headers.get('content-range');
    const m = cr && /\/(\d+)\s*$/.exec(cr);
    if (m) size = Number(m[1]);
    else if (res.status === 200) size = Number(res.headers.get('content-length')) || 0;
    return {
      filename: filenameFromDisposition(res.headers.get('content-disposition')) || nameFromUrl(res.url || job.url),
      size,
      resumable: res.status === 206,
      finalUrl: res.url || job.url,
    };
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/** Mendukung filename*=UTF-8''nama%20file.mkv dan filename="nama file.mkv". */
function filenameFromDisposition(cd) {
  if (!cd) return '';
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (star) {
    try { return decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')); } catch { /* lanjut */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(cd);
  if (plain) return (plain[2] ?? plain[1]).trim();
  return '';
}

module.exports = { probe, filenameFromDisposition };
