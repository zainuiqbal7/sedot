'use strict';
// Uji fungsi murni: node test/helpers.test.js
const assert = require('node:assert');
const h = require('../src/helpers');
const { categoryOf, nameFromUrl } = require('../src/categories');

// Pesan error
assert.strictEqual(h.friendlyError(22, 'Response status is not successful. status=403').text, 'Link kedaluwarsa');
assert.ok(h.friendlyError(22, 'status=403').expired);
assert.strictEqual(h.friendlyError(24, 'Authorization failed.').text, 'Link kedaluwarsa');
assert.strictEqual(h.friendlyError(1, 'No URI available.').text, 'Link kedaluwarsa', 'multi-koneksi: semua link ditolak');
assert.strictEqual(h.friendlyError(3, 'Resource not found').text, 'File tidak ditemukan');
assert.strictEqual(h.friendlyError(22, 'status=503').text, 'Server sibuk');
assert.strictEqual(h.friendlyError(9, '').text, 'Disk penuh');
assert.strictEqual(h.friendlyError(6, 'Network problem').text, 'Masalah jaringan');
assert.strictEqual(h.friendlyError(99, 'aneh').text, 'Gagal');
assert.ok(h.friendlyError(99, 'aneh').hint.includes('aneh'));

// Peta segmen: 8 potongan, hex "f0" = 4 pertama selesai
assert.deepStrictEqual(h.bitfieldRuns('f0', 8), [{ from: 0, to: 0.5 }]);
assert.deepStrictEqual(h.bitfieldRuns('a0', 4), [{ from: 0, to: 0.25 }, { from: 0.5, to: 0.75 }]);
assert.deepStrictEqual(h.bitfieldRuns('ff', 8), [{ from: 0, to: 1 }]);
assert.deepStrictEqual(h.bitfieldRuns('', 8), []);
assert.deepStrictEqual(h.bitfieldRuns('e', 3), [{ from: 0, to: 1 }]); // bit sisa diabaikan

// Lanjutkan dengan link baru
const items = [
  { gid: 'a', name: 'Ep 06.mkv', status: 'error', total: 1000, done: 400 },
  { gid: 'b', name: 'Ep 07.mkv', status: 'complete', total: 2000, done: 2000 },
  { gid: 'c', name: 'Ep 08.mkv', status: 'active', total: 3000, done: 10 },
];
assert.strictEqual(h.findResumable(items, 'ep 06.mkv', 1000).gid, 'a');
assert.strictEqual(h.findResumable(items, 'Ep 06.mkv', 0).gid, 'a', 'ukuran belum diketahui tetap cocok');
assert.strictEqual(h.findResumable(items, 'Ep 06.mkv', 999), null, 'ukuran beda = file beda');
assert.strictEqual(h.findResumable(items, 'Ep 07.mkv', 2000), null, 'yang selesai bukan untuk dilanjutkan');
assert.strictEqual(h.findDuplicate(items, 'Ep 07.mkv', 2000).gid, 'b');
assert.strictEqual(h.findDuplicate(items, 'Ep 08.mkv', 3000).gid, 'c');
assert.strictEqual(h.findDuplicate(items, 'Ep 09.mkv', 1), null);

// Urutan
const s = h.sortItems([
  { name: 'b', status: 'complete', doneAt: 5, total: 1, done: 1, speed: 0 },
  { name: 'a', status: 'active', addedAt: 1, total: 1, done: 0, speed: 9 },
  { name: 'c', status: 'complete', doneAt: 9, total: 1, done: 1, speed: 0 },
  { name: 'Ep 10', status: 'paused', addedAt: 2, total: 1, done: 0, speed: 0 },
]);
assert.deepStrictEqual(s.map((i) => i.name), ['a', 'Ep 10', 'c', 'b']);
assert.deepStrictEqual(h.sortItems([{ name: 'Ep 10' }, { name: 'Ep 9' }], 'name', 1).map((i) => i.name), ['Ep 9', 'Ep 10'], 'urutan angka alami');

// Clipboard
const ok = (t) => h.looksDownloadable(t, categoryOf, nameFromUrl);
assert.ok(ok('https://x.com/a/film.mkv'));
assert.ok(ok('https://x.com/setup.exe?token=1'));
assert.ok(!ok('https://x.com/artikel'), 'halaman biasa tidak ditawarkan');
assert.ok(!ok('https://x.com/foto.jpg'), 'gambar tidak ditawarkan');
assert.ok(!ok('lihat https://x.com/a.zip'), 'harus link saja');

console.log('OK helpers: pesan error, peta segmen, lanjut-dengan-link-baru, urutan, clipboard');
