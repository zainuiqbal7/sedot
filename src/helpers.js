'use strict';
// Fungsi murni (tanpa Electron) supaya mudah diuji: pesan error, peta segmen, pencocokan file, pengurutan.

/**
 * Ubah kode error aria2 menjadi pesan yang dimengerti orang awam + saran tindakan.
 * Daftar kode: https://aria2.github.io/manual/en/html/aria2c.html#exit-status
 */
function friendlyError(code, msg = '') {
  code = String(code ?? '');
  const status = (/status=(\d{3})/.exec(msg) || /\b([45]\d\d)\b/.exec(msg) || [])[1] || '';

  if (['401', '403', '410'].includes(status) || code === '24') {
    return {
      text: 'Link kedaluwarsa',
      hint: 'Link unduhan sudah tidak berlaku atau butuh login. Buka lagi halaman unduhannya di browser lalu klik download: Sedot akan menawarkan untuk melanjutkan file ini dari posisi terakhir.',
      expired: true,
    };
  }
  if (status === '404' || code === '3') {
    return { text: 'File tidak ditemukan', hint: 'Server menjawab 404: file sudah dihapus atau link salah. Ambil link baru dari situsnya.', expired: true };
  }
  if (['429', '503'].includes(status) || code === '29') {
    return { text: 'Server sibuk', hint: 'Server sedang membatasi atau penuh. Tunggu beberapa menit lalu klik Lanjutkan.' };
  }
  if (status.startsWith('5')) return { text: `Server bermasalah (${status})`, hint: 'Gangguan di sisi server. Coba lagi nanti dengan klik Lanjutkan.' };

  const byCode = {
    2: ['Koneksi kehabisan waktu', 'Server tidak merespons. Periksa internet lalu klik Lanjutkan.'],
    5: ['Unduhan terlalu lambat', 'Kecepatan di bawah batas minimum. Klik Lanjutkan untuk mencoba lagi.'],
    6: ['Masalah jaringan', 'Koneksi internet terputus. Setelah internet kembali, klik Lanjutkan.'],
    8: ['Server tidak mendukung lanjut', 'Server ini tidak bisa melanjutkan unduhan yang terputus, jadi harus diulang dari awal.'],
    9: ['Disk penuh', 'Ruang disk tidak cukup. Kosongkan ruang atau pilih folder di drive lain.'],
    13: ['File sudah ada', 'File dengan nama sama sudah ada di folder tujuan.'],
    14: ['Gagal mengganti nama file', 'Pastikan file tidak sedang dibuka program lain.'],
    15: ['Tidak bisa membuka file', 'Pastikan file tidak sedang dibuka program lain.'],
    16: ['Tidak bisa membuat file', 'Periksa izin folder tujuan atau pilih folder lain.'],
    17: ['Gagal menulis ke disk', 'Periksa disk tujuan (penuh, dicabut, atau rusak).'],
    18: ['Tidak bisa membuat folder', 'Periksa izin folder tujuan atau pilih folder lain.'],
    19: ['Server tidak ditemukan', 'Nama server tidak bisa ditemukan. Periksa internet atau ejaan link.'],
    23: ['Terlalu banyak pengalihan', 'Link mengalihkan terlalu banyak kali. Ambil link baru dari situsnya.'],
  };
  if (byCode[code]) return { text: byCode[code][0], hint: byCode[code][1] };
  return { text: 'Gagal', hint: msg ? `${msg}. Klik Lanjutkan untuk mencoba lagi.` : 'Klik Lanjutkan untuk mencoba lagi.' };
}

/**
 * Bitfield aria2 (hex, bit tertinggi = potongan pertama) -> daftar rentang yang sudah selesai,
 * dalam pecahan 0..1. Contoh: [{ from: 0, to: 0.25 }, { from: 0.5, to: 0.6 }].
 */
function bitfieldRuns(hex, numPieces) {
  numPieces = Number(numPieces) || 0;
  if (!hex || !numPieces) return [];
  const runs = [];
  let start = -1;
  for (let i = 0; i < numPieces; i++) {
    const nib = parseInt(hex[i >> 2] || '0', 16);
    const done = (nib >> (3 - (i & 3))) & 1;
    if (done && start < 0) start = i;
    if (!done && start >= 0) { runs.push({ from: start / numPieces, to: i / numPieces }); start = -1; }
  }
  if (start >= 0) runs.push({ from: start / numPieces, to: 1 });
  return runs;
}

const UNFINISHED = ['error', 'paused', 'waiting'];

/**
 * Cari unduhan lama yang belum selesai dengan nama (dan ukuran, kalau diketahui) yang sama,
 * supaya link baru bisa dipakai untuk melanjutkannya alih-alih mengulang dari nol.
 */
function findResumable(items, filename, size) {
  if (!filename) return null;
  const n = filename.toLowerCase();
  return items.find((i) => UNFINISHED.includes(i.status) && i.name.toLowerCase() === n
    && (!size || !i.total || i.total === size)) || null;
}

/** File yang sama yang sedang diunduh atau sudah selesai (untuk peringatan dobel). */
function findDuplicate(items, filename, size) {
  if (!filename) return null;
  const n = filename.toLowerCase();
  return items.find((i) => ['complete', 'active'].includes(i.status) && i.name.toLowerCase() === n
    && (!size || !i.total || i.total === size)) || null;
}

const STATUS_RANK = { active: 0, waiting: 1, paused: 2, error: 3, complete: 4 };

/**
 * Urutan bawaan: yang sedang berjalan di atas, lalu antre, dijeda, gagal, selesai.
 * Di dalam tiap kelompok: yang terbaru di atas.
 */
function sortItems(items, key = 'smart', dir = 1) {
  const recency = (i) => i.doneAt || i.addedAt || 0;
  const cmp = {
    smart: (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || recency(b) - recency(a),
    name: (a, b) => a.name.localeCompare(b.name, 'id', { numeric: true, sensitivity: 'base' }),
    size: (a, b) => a.total - b.total,
    progress: (a, b) => (a.total ? a.done / a.total : 0) - (b.total ? b.done / b.total : 0),
    speed: (a, b) => a.speed - b.speed,
    status: (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9),
    added: (a, b) => recency(a) - recency(b),
  }[key] || (() => 0);
  return [...items].sort((a, b) => cmp(a, b) * (key === 'smart' ? 1 : dir));
}

/** Link yang layak ditawarkan untuk diunduh saat disalin ke clipboard. */
function looksDownloadable(text, categoryOf, nameFromUrl) {
  if (typeof text !== 'string' || text.length > 2048) return false;
  const t = text.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return false;
  const cat = categoryOf(nameFromUrl(t));
  return cat !== 'Lainnya' && cat !== 'Gambar';
}

const api = { friendlyError, bitfieldRuns, findResumable, findDuplicate, sortItems, looksDownloadable };
// Dipakai di dua tempat: proses utama (require) dan tampilan (<script>, tanpa Node).
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.SedotHelpers = api;
