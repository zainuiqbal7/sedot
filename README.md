# Sedot

Download manager untuk Windows yang mengunduh tiap file lewat banyak koneksi sekaligus. Unduhan bisa dilanjutkan setelah putus, dan ekstensi Chrome/Edge menangkap unduhan dari browser secara otomatis.

```
┌──────────────┐  link + cookie   ┌──────────────────┐  JSON-RPC   ┌─────────┐
│ Ekstensi     │ ───────────────▶ │ Aplikasi Sedot    │ ──────────▶ │ aria2c  │ ──▶ internet
│ Chrome/Edge  │  127.0.0.1:17345 │ (Electron)        │  localhost  │ (mesin) │    (16 koneksi/file)
└──────────────┘                  └──────────────────┘             └─────────┘
```

## Cara menjalankan (Windows)

1. Pasang **Node.js 22 LTS** atau lebih baru dari https://nodejs.org (pilih "LTS", lalu Next, Next, Finish).
2. Ekstrak folder `sedot`, lalu buka **PowerShell** di dalam folder itu. Caranya: klik kanan di ruang kosong folder, pilih *Open in Terminal*.
3. Pasang dependensi. Langkah ini juga otomatis mengunduh `aria2c.exe` resmi dan memeriksa hash SHA-256-nya:
   ```
   npm install
   ```
4. Jalankan aplikasinya:
   ```
   npm start
   ```

### Memasang ekstensi browser

1. Buka `chrome://extensions` (untuk Edge: `edge://extensions`).
2. Nyalakan **Developer mode** (pojok kanan atas di Chrome, sidebar kiri di Edge).
3. Klik **Load unpacked**, lalu pilih folder `sedot\extension`.
4. Sematkan ikon Sedot di toolbar. Klik ikonnya untuk memastikan statusnya **"Terhubung ke aplikasi Sedot"**.

### Membuat installer `.exe` (opsional)

```
npm run dist
```

Hasilnya ada di folder `dist\`: installer biasa dan versi *portable*. Karena installer ini tidak ditandatangani, Windows SmartScreen akan menampilkan peringatan. Klik *More info*, lalu *Run anyway*.

## Fitur

| Fitur | Keterangan |
|---|---|
| Multi-koneksi | Sampai 16 koneksi per file (bisa diatur) |
| Resume | Jeda dan lanjutkan kapan saja. Antrean juga bertahan setelah aplikasi atau komputer di-restart |
| Dialog "Info unduhan" | Saat browser mengirim link, muncul jendela berisi nama file, ukuran (dideteksi sebelum unduh), kategori, folder, dan catatan. Folder bisa diingat per kategori. Tombolnya **Mulai unduh** (Enter), **Unduh nanti**, dan **Batal** (Esc). Bisa dimatikan di Pengaturan |
| Integrasi browser | Unduhan di Chrome/Edge otomatis dialihkan ke Sedot, termasuk cookie login dan referer |
| Klik kanan | Menu "Unduh dengan Sedot" untuk link, gambar, video, dan audio |
| Kategori | File yang selesai dipindah ke subfolder Video, Musik, Dokumen, Gambar, Program, Arsip, atau Lainnya |
| Antrean | Atur jumlah unduhan bersamaan dan batas kecepatan |
| Tray | Tetap berjalan di tray saat jendela ditutup, supaya ekstensi tetap bisa mengirim link |
| Coba lagi | Unduhan yang gagal bisa dilanjutkan dengan tombol **Lanjutkan** |
| Mode gelap | Mengikuti tema Windows |

**Pintasan keyboard:** `Ctrl+N` tambah URL, `Spasi` jeda/lanjut, `Delete` hapus, `Enter` buka file, `Ctrl+A` pilih semua.

## Keamanan

- Server penghubung ke ekstensi hanya mendengar di `127.0.0.1`. Server ini **menolak permintaan dari halaman web**, jadi website jahat tidak bisa menyuruh Sedot mengunduh sesuatu. Yang diterima hanya permintaan dari ekstensi.
- RPC aria2 memakai port acak dan token rahasia baru setiap kali aplikasi dibuka.
- Nama file dibersihkan, sehingga tidak bisa keluar dari folder unduhan (misalnya lewat `..\..\Windows`).
- File yang selesai diberi tanda "berasal dari internet" (*Mark of the Web*), sama seperti yang dilakukan browser. Dengan begitu, Windows SmartScreen tetap memperingatkan saat kamu membuka `.exe` hasil unduhan.
- Unduhan dari jendela **Incognito/InPrivate tidak ditangkap**, supaya cookie mode penyamaran tidak keluar dari browser.
- `aria2c.exe` diambil dari rilis resmi GitHub dan ditolak kalau hash SHA-256-nya tidak cocok.

## Keterbatasan yang diketahui

- **Unduhan yang memakai form POST** (jarang, misalnya beberapa portal pemerintah atau bank) tidak bisa diambil alih karena aria2 hanya melakukan GET. Matikan "Tangkap unduhan otomatis" di popup ekstensi untuk sementara.
- **File yang sangat kecil** kadang sudah selesai diunduh browser sebelum sempat dibatalkan, sehingga file-nya ada dua.
- **Video grabber** (tombol "unduh video ini" di atas pemutar video) belum ada.
- Baru diuji dengan Chrome/Chromium. Edge memakai mesin yang sama, jadi seharusnya berfungsi juga. Firefox belum didukung.

## Pengembangan

```
npm test          # uji mesin: multi-koneksi, resume, keamanan bridge (butuh aria2c di PATH)
npm run icons     # buat ulang ikon
```

Struktur:

```
src/main.js        proses utama Electron: tray, riwayat, kategori, IPC
src/aria2.js       menjalankan & mengendalikan aria2c lewat JSON-RPC
src/bridge.js      server lokal untuk ekstensi browser
src/renderer/      tampilan (HTML/CSS/JS biasa, tanpa framework)
extension/         ekstensi Chrome/Edge (Manifest V3)
scripts/           pengambil aria2 & pembuat ikon
test/              uji otomatis
```

Lisensi: MIT. `aria2c.exe` berlisensi GPL-2.0 (lihat `bin/aria2-COPYING` setelah `npm install`).
