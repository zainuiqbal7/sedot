# Sedot

Download manager untuk Windows yang mengunduh tiap file lewat banyak koneksi sekaligus. Unduhan bisa dilanjutkan setelah putus, dan ekstensi Chrome/Edge menangkap unduhan dari browser secara otomatis.

```
┌──────────────┐  link + cookie   ┌──────────────────┐  JSON-RPC   ┌─────────┐
│ Ekstensi     │ ───────────────▶ │ Aplikasi Sedot    │ ──────────▶ │ aria2c  │ ──▶ internet
│ Chrome/Edge  │  127.0.0.1:17345 │ (Electron)        │  localhost  │ (mesin) │    (16 koneksi/file)
└──────────────┘                  └──────────────────┘             └─────────┘
```

## Cara memasang (Windows)

1. Buka **[Releases](https://github.com/zainuiqbal7/sedot/releases/latest)**, lalu unduh `Sedot-Setup-x.y.z.exe`.
2. Jalankan installer-nya. Karena installer belum ditandatangani sertifikat berbayar, Windows SmartScreen akan menampilkan peringatan. Klik **More info**, lalu **Run anyway**.
3. Sedot muncul di Start Menu dan Desktop. Tidak perlu Node.js atau Terminal.

Kalau sebelumnya kamu menjalankan Sedot dengan `npm start`, pengaturan dan riwayatmu tetap terpakai karena lokasinya sama.

### Memasang ekstensi browser

Saat Sedot pertama kali dibuka, muncul panduan langkah demi langkah. Panduan yang sama bisa dibuka lagi dari ⚙ Pengaturan → **Panduan ekstensi browser**.

1. Klik **Buka folder ekstensi** di panduan itu. Foldernya ada di dalam folder instalasi Sedot, jadi ikut ter-update.
2. Buka `chrome://extensions` (untuk Edge: `edge://extensions`), lalu nyalakan **Developer mode**.
3. Klik **Load unpacked**, lalu pilih folder dari langkah 1.
4. Status bar Sedot berubah menjadi **"Ekstensi browser: terhubung"**.

> Kalau sebelumnya kamu memasang ekstensi dari `sedot-extension.zip`, hapus yang lama (**Remove**) supaya tidak ada dua ekstensi Sedot. Sedot memang mengabaikan link dobel, tapi lebih rapi kalau hanya satu.

### Update otomatis

Sedot mengecek versi baru di GitHub Releases saat dibuka, lalu setiap 6 jam. Kalau ada versi baru:

1. Update diunduh di latar belakang. Progresnya terlihat di status bar.
2. Setelah selesai, muncul tombol **Restart & pasang update**.
3. Kalau tombolnya tidak diklik, update tetap terpasang otomatis saat Sedot ditutup lewat tray, lalu *Keluar*.

## Untuk pengembang

### Menjalankan dari kode

```
npm install      # juga mengunduh aria2c.exe resmi + cek SHA-256
npm start
```

### Merilis versi baru

1. Naikkan `"version"` di `package.json`, misalnya `0.3.0` menjadi `0.3.1`, lalu commit dan push ke `main`.
2. Picu build lewat salah satu cara berikut:
   - Push tag dengan `git tag v0.3.1` lalu `git push origin v0.3.1`.
   - Atau buka tab **Actions**, pilih **Rilis**, lalu klik **Run workflow**.
3. GitHub Actions menjalankan uji, membangun installer di Windows, dan menerbitkannya di Releases. Semua Sedot yang terpasang akan ter-update sendiri.

Untuk membuat installer secara lokal tanpa menerbitkan: `npm run dist`. Hasilnya ada di `dist\`.

## Fitur

| Fitur | Keterangan |
|---|---|
| Multi-koneksi | Sampai 16 koneksi per file (bisa diatur) |
| **Lanjutkan dengan link baru** | Link kedaluwarsa (misalnya Gofile)? Klik download lagi di browser, dan Sedot menawarkan **"Lanjutkan unduhan lama dari 40%"**. Bagian yang sudah ada tetap dipakai. Bisa juga lewat klik kanan → *Ganti link…* |
| Integrasi browser | Unduhan di Chrome/Edge otomatis dialihkan ke Sedot, termasuk cookie login dan referer. File kecil (< 256 KB) dibiarkan diunduh browser |
| Dialog "Info unduhan" | Nama file, ukuran (dideteksi sebelum unduh), kategori, folder (bisa diingat per kategori), dan catatan. Ada peringatan kalau file yang sama sudah pernah diunduh |
| Panel detail | Klik satu unduhan untuk melihat peta segmen, daftar koneksi beserta kecepatannya, lokasi, link, waktu, dan **batas kecepatan khusus file itu** |
| Klik kanan | Buka file/folder, lanjutkan/jeda, ganti link, salin link, hapus |
| Pantau clipboard | Salin link file (video, musik, dokumen, program, arsip), lalu Sedot menawarkan untuk mengunduhnya |
| Seret & lepas | Seret link dari browser ke jendela Sedot |
| Setelah semua selesai | Sleep atau matikan komputer, dengan hitung mundur 60 detik yang bisa dibatalkan |
| Tidak sleep saat mengunduh | Laptop tidak tertidur selama ada unduhan berjalan (bisa dimatikan) |
| Taskbar | Progres total tampil di ikon taskbar Windows, kecepatan di judul jendela dan tooltip tray |
| Pesan error jelas | "Link kedaluwarsa", "Disk penuh", "Masalah jaringan", masing-masing dengan saran tindakan |
| Resume | Jeda dan lanjutkan kapan saja. Antrean bertahan setelah restart |
| Kategori | File selesai dipindah ke subfolder Video, Musik, Dokumen, Gambar, Program, Arsip, atau Lainnya |
| Urutkan | Klik judul kolom. Urutan bawaan: yang berjalan di atas, lalu yang terbaru |
| Update otomatis | Versi baru diunduh di latar belakang dari GitHub Releases |
| Ekstensi ikut ter-update | Ekstensi dipasang dari folder aplikasi, jadi ikut diperbarui bersama Sedot |
| Lainnya | Tray, jalan saat Windows menyala, mode gelap, batas kecepatan total, antrean |

**Pintasan keyboard:** `Ctrl+N` tambah URL · `Ctrl+F` cari · `↑/↓` pindah pilihan · `Spasi` jeda/lanjut · `Enter` buka file · `Delete` hapus · `Esc` tutup detail · `Ctrl+A` pilih semua.

## Keamanan

- Server penghubung ke ekstensi hanya mendengar di `127.0.0.1`. Server ini **menolak permintaan dari halaman web**, jadi website jahat tidak bisa menyuruh Sedot mengunduh sesuatu. Yang diterima hanya permintaan dari ekstensi.
- RPC aria2 memakai port acak dan token rahasia baru setiap kali aplikasi dibuka.
- Nama file dibersihkan, sehingga tidak bisa keluar dari folder unduhan (misalnya lewat `..\..\Windows`).
- File yang selesai diberi tanda "berasal dari internet" (*Mark of the Web*), sama seperti yang dilakukan browser. Dengan begitu, Windows SmartScreen tetap memperingatkan saat kamu membuka `.exe` hasil unduhan.
- Unduhan dari jendela **Incognito/InPrivate tidak ditangkap**, supaya cookie mode penyamaran tidak keluar dari browser.
- `aria2c.exe` diambil dari rilis resmi GitHub dan ditolak kalau hash SHA-256-nya tidak cocok.

## Keterbatasan yang diketahui

- **Unduhan yang memakai form POST** (jarang, misalnya beberapa portal pemerintah atau bank) tidak bisa diambil alih karena aria2 hanya melakukan GET. Matikan "Tangkap unduhan otomatis" di popup ekstensi untuk sementara.
- **Video grabber** (tombol "unduh video ini" di atas pemutar video) belum ada.
- Baru diuji dengan Chrome/Chromium. Edge memakai mesin yang sama, jadi seharusnya berfungsi juga. Firefox belum didukung.

## Uji & struktur kode

```
npm test          # uji cepat: fungsi murni + mesin (multi-koneksi, resume, keamanan bridge). Butuh aria2c di PATH
npm run test:e2e  # uji menyeluruh: membuka aplikasi sungguhan dan mengklik seperti pengguna (Linux: xvfb-run -a …)
npm run icons     # buat ulang ikon
```

Struktur:

```
src/main.js        proses utama Electron: tray, riwayat, kategori, IPC
src/aria2.js       menjalankan & mengendalikan aria2c lewat JSON-RPC
src/bridge.js      server lokal untuk ekstensi browser
src/helpers.js     fungsi murni yang dipakai proses utama & tampilan (pesan error, segmen, pencocokan, urutan)
src/probe.js       mengintip nama & ukuran file sebelum unduh
src/renderer/      tampilan (HTML/CSS/JS biasa, tanpa framework)
extension/         ekstensi Chrome/Edge (Manifest V3)
scripts/           pengambil aria2 & pembuat ikon
test/              uji otomatis
```

Lisensi: MIT. `aria2c.exe` berlisensi GPL-2.0 (lihat `bin/aria2-COPYING` setelah `npm install`).
