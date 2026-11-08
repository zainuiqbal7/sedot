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

1. Unduh `sedot-extension.zip` dari halaman Releases yang sama, lalu ekstrak ke folder yang **tidak akan kamu hapus**, misalnya `Documents\sedot-extension`.
2. Buka `chrome://extensions` (untuk Edge: `edge://extensions`).
3. Nyalakan **Developer mode**, klik **Load unpacked**, lalu pilih folder hasil ekstrak tadi.
4. Sematkan ikon Sedot di toolbar. Klik ikonnya untuk memastikan statusnya **"Terhubung ke aplikasi Sedot"**.

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
| Resume | Jeda dan lanjutkan kapan saja. Antrean juga bertahan setelah aplikasi atau komputer di-restart |
| Dialog "Info unduhan" | Saat browser mengirim link, muncul jendela berisi nama file, ukuran (dideteksi sebelum unduh), kategori, folder, dan catatan. Folder bisa diingat per kategori. Tombolnya **Mulai unduh** (Enter), **Unduh nanti**, dan **Batal** (Esc). Bisa dimatikan di Pengaturan |
| Integrasi browser | Unduhan di Chrome/Edge otomatis dialihkan ke Sedot, termasuk cookie login dan referer |
| Klik kanan | Menu "Unduh dengan Sedot" untuk link, gambar, video, dan audio |
| Kategori | File yang selesai dipindah ke subfolder Video, Musik, Dokumen, Gambar, Program, Arsip, atau Lainnya |
| Antrean | Atur jumlah unduhan bersamaan dan batas kecepatan |
| Tray | Tetap berjalan di tray saat jendela ditutup, supaya ekstensi tetap bisa mengirim link |
| Coba lagi | Unduhan yang gagal bisa dilanjutkan dengan tombol **Lanjutkan** |
| Mode gelap | Mengikuti tema Windows |
| Update otomatis | Versi baru diunduh di latar belakang dari GitHub Releases |
| Jalan saat Windows menyala | Opsional, langsung ke tray supaya ekstensi selalu tersambung |

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

## Uji & struktur kode

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
