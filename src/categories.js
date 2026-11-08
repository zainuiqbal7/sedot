'use strict';
// Pengelompokan file berdasarkan ekstensi, seperti folder kategori di download manager.

const CATEGORIES = {
  Video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'ts'],
  Musik: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'],
  Dokumen: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'epub', 'odt'],
  Gambar: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic'],
  Program: ['exe', 'msi', 'apk', 'dmg', 'deb', 'rpm', 'appimage', 'msix'],
  Arsip: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
};

const BY_EXT = new Map();
for (const [cat, exts] of Object.entries(CATEGORIES)) for (const e of exts) BY_EXT.set(e, cat);

function extOf(name) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Ambil nama file dari URL (tanpa query string). */
function nameFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    return decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

function categoryOf(name) {
  return BY_EXT.get(extOf(name)) || 'Lainnya';
}

module.exports = { CATEGORIES: Object.keys(CATEGORIES).concat('Lainnya'), categoryOf, nameFromUrl, extOf };
