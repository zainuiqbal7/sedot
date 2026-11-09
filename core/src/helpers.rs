//! Fungsi murni (setara src/helpers.js): pesan error, peta segmen, pencocokan file, urutan, clipboard.

use crate::categories::{category_of, name_from_url};
use crate::model::Item;
use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq)]
pub struct Friendly {
    pub text: String,
    pub hint: String,
    pub expired: bool,
}

fn f(text: &str, hint: &str, expired: bool) -> Friendly {
    Friendly {
        text: text.into(),
        hint: hint.into(),
        expired,
    }
}

static STATUS_EQ: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"status=(\d{3})").unwrap());
static STATUS_ANY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b([45]\d\d)\b").unwrap());

/// Kode error aria2 -> pesan yang dimengerti orang awam + saran tindakan.
pub fn friendly_error(code: &str, msg: &str) -> Friendly {
    let status = STATUS_EQ
        .captures(msg)
        .or_else(|| STATUS_ANY.captures(msg))
        .map(|c| c[1].to_string())
        .unwrap_or_default();

    if ["401", "403", "410"].contains(&status.as_str())
        || code == "24"
        || msg.to_lowercase().contains("no uri available")
    {
        return f(
            "Link kedaluwarsa",
            "Link unduhan sudah tidak berlaku atau butuh login. Buka lagi halaman unduhannya di browser lalu klik download: Sedot akan menawarkan untuk melanjutkan file ini dari posisi terakhir.",
            true,
        );
    }
    if status == "404" || code == "3" {
        return f("File tidak ditemukan", "Server menjawab 404: file sudah dihapus atau link salah. Ambil link baru dari situsnya.", true);
    }
    if status == "429" || status == "503" || code == "29" {
        return f(
            "Server sibuk",
            "Server sedang membatasi atau penuh. Tunggu beberapa menit lalu klik Lanjutkan.",
            false,
        );
    }
    if status.starts_with('5') {
        return Friendly {
            text: format!("Server bermasalah ({status})"),
            hint: "Gangguan di sisi server. Coba lagi nanti dengan klik Lanjutkan.".into(),
            expired: false,
        };
    }
    let by_code = match code {
        "2" => Some(("Koneksi kehabisan waktu", "Server tidak merespons. Periksa internet lalu klik Lanjutkan.")),
        "5" => Some(("Unduhan terlalu lambat", "Kecepatan di bawah batas minimum. Klik Lanjutkan untuk mencoba lagi.")),
        "6" => Some(("Masalah jaringan", "Koneksi internet terputus. Setelah internet kembali, klik Lanjutkan.")),
        "8" => Some(("Server tidak mendukung lanjut", "Server ini tidak bisa melanjutkan unduhan yang terputus, jadi harus diulang dari awal.")),
        "9" => Some(("Disk penuh", "Ruang disk tidak cukup. Kosongkan ruang atau pilih folder di drive lain.")),
        "13" => Some(("File sudah ada", "File dengan nama sama sudah ada di folder tujuan.")),
        "14" => Some(("Gagal mengganti nama file", "Pastikan file tidak sedang dibuka program lain.")),
        "15" => Some(("Tidak bisa membuka file", "Pastikan file tidak sedang dibuka program lain.")),
        "16" => Some(("Tidak bisa membuat file", "Periksa izin folder tujuan atau pilih folder lain.")),
        "17" => Some(("Gagal menulis ke disk", "Periksa disk tujuan (penuh, dicabut, atau rusak).")),
        "18" => Some(("Tidak bisa membuat folder", "Periksa izin folder tujuan atau pilih folder lain.")),
        "19" => Some(("Server tidak ditemukan", "Nama server tidak bisa ditemukan. Periksa internet atau ejaan link.")),
        "23" => Some(("Terlalu banyak pengalihan", "Link mengalihkan terlalu banyak kali. Ambil link baru dari situsnya.")),
        _ => None,
    };
    if let Some((t, h)) = by_code {
        return f(t, h, false);
    }
    let hint = if msg.is_empty() {
        "Klik Lanjutkan untuk mencoba lagi.".to_string()
    } else {
        format!("{msg}. Klik Lanjutkan untuk mencoba lagi.")
    };
    Friendly {
        text: "Gagal".into(),
        hint,
        expired: false,
    }
}

/// Bitfield aria2 (hex, bit tertinggi = potongan pertama) -> rentang selesai dalam pecahan 0..1.
pub fn bitfield_runs(hex: &str, num_pieces: usize) -> Vec<(f64, f64)> {
    if hex.is_empty() || num_pieces == 0 {
        return vec![];
    }
    let bytes = hex.as_bytes();
    let n = num_pieces as f64;
    let mut runs = vec![];
    let mut start: Option<usize> = None;
    for i in 0..num_pieces {
        let nib = bytes
            .get(i >> 2)
            .and_then(|c| (*c as char).to_digit(16))
            .unwrap_or(0);
        let done = (nib >> (3 - (i & 3))) & 1 == 1;
        match (done, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                runs.push((s as f64 / n, i as f64 / n));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        runs.push((s as f64 / n, 1.0));
    }
    runs
}

const UNFINISHED: [&str; 3] = ["error", "paused", "waiting"];

fn same_file(i: &Item, filename: &str, size: u64) -> bool {
    i.name.to_lowercase() == filename.to_lowercase()
        && (size == 0 || i.total == 0 || i.total == size)
}

/// Unduhan lama yang belum selesai dengan nama (dan ukuran) sama, untuk dilanjutkan dengan link baru.
pub fn find_resumable<'a>(items: &'a [Item], filename: &str, size: u64) -> Option<&'a Item> {
    if filename.is_empty() {
        return None;
    }
    items
        .iter()
        .find(|i| UNFINISHED.contains(&i.status.as_str()) && same_file(i, filename, size))
}

/// File sama yang sedang diunduh atau sudah selesai (untuk peringatan dobel).
pub fn find_duplicate<'a>(items: &'a [Item], filename: &str, size: u64) -> Option<&'a Item> {
    if filename.is_empty() {
        return None;
    }
    items.iter().find(|i| {
        ["complete", "active"].contains(&i.status.as_str()) && same_file(i, filename, size)
    })
}

fn status_rank(s: &str) -> u8 {
    match s {
        "active" | "merging" | "preparing" => 0,
        "waiting" => 1,
        "paused" => 2,
        "error" => 3,
        "complete" => 4,
        _ => 9,
    }
}

/// Urutan bawaan: berjalan, antre, dijeda, gagal, selesai; di dalam kelompok yang terbaru di atas.
pub fn sort_smart(items: &mut [Item]) {
    let recency = |i: &Item| if i.done_at > 0 { i.done_at } else { i.added_at };
    items.sort_by(|a, b| {
        status_rank(&a.status)
            .cmp(&status_rank(&b.status))
            .then(recency(b).cmp(&recency(a)))
    });
}

/// Link yang layak ditawarkan saat disalin ke clipboard (file, bukan halaman/gambar).
pub fn looks_downloadable(text: &str) -> bool {
    let t = text.trim();
    if text.len() > 2048
        || !(t.starts_with("http://") || t.starts_with("https://"))
        || t.chars().any(char::is_whitespace)
    {
        return false;
    }
    !matches!(category_of(&name_from_url(t)), "Lainnya" | "Gambar")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, status: &str, total: u64) -> Item {
        Item {
            gid: name.into(),
            name: name.into(),
            status: status.into(),
            total,
            ..Default::default()
        }
    }

    #[test]
    fn pesan_error() {
        assert_eq!(
            friendly_error("22", "Response status is not successful. status=403").text,
            "Link kedaluwarsa"
        );
        assert!(friendly_error("22", "status=403").expired);
        assert_eq!(
            friendly_error("24", "Authorization failed.").text,
            "Link kedaluwarsa"
        );
        assert_eq!(
            friendly_error("1", "No URI available.").text,
            "Link kedaluwarsa"
        );
        assert_eq!(
            friendly_error("3", "Resource not found").text,
            "File tidak ditemukan"
        );
        assert_eq!(friendly_error("22", "status=503").text, "Server sibuk");
        assert_eq!(
            friendly_error("22", "status=502").text,
            "Server bermasalah (502)"
        );
        assert_eq!(friendly_error("9", "").text, "Disk penuh");
        assert_eq!(
            friendly_error("6", "Network problem").text,
            "Masalah jaringan"
        );
        let x = friendly_error("99", "aneh");
        assert_eq!(x.text, "Gagal");
        assert!(x.hint.contains("aneh"));
    }

    #[test]
    fn peta_segmen() {
        assert_eq!(bitfield_runs("f0", 8), vec![(0.0, 0.5)]);
        assert_eq!(bitfield_runs("a0", 4), vec![(0.0, 0.25), (0.5, 0.75)]);
        assert_eq!(bitfield_runs("ff", 8), vec![(0.0, 1.0)]);
        assert_eq!(bitfield_runs("", 8), vec![]);
        assert_eq!(bitfield_runs("e", 3), vec![(0.0, 1.0)]);
    }

    #[test]
    fn lanjut_dengan_link_baru() {
        let items = vec![
            item("Ep 06.mkv", "error", 1000),
            item("Ep 07.mkv", "complete", 2000),
            item("Ep 08.mkv", "active", 3000),
        ];
        assert_eq!(
            find_resumable(&items, "ep 06.mkv", 1000).unwrap().gid,
            "Ep 06.mkv"
        );
        assert!(find_resumable(&items, "Ep 06.mkv", 0).is_some());
        assert!(find_resumable(&items, "Ep 06.mkv", 999).is_none());
        assert!(find_resumable(&items, "Ep 07.mkv", 2000).is_none());
        assert_eq!(
            find_duplicate(&items, "Ep 07.mkv", 2000).unwrap().gid,
            "Ep 07.mkv"
        );
        assert_eq!(
            find_duplicate(&items, "Ep 08.mkv", 3000).unwrap().gid,
            "Ep 08.mkv"
        );
        assert!(find_duplicate(&items, "Ep 09.mkv", 1).is_none());
    }

    #[test]
    fn urutan() {
        let mut v = vec![
            Item {
                name: "b".into(),
                status: "complete".into(),
                done_at: 5,
                ..Default::default()
            },
            Item {
                name: "a".into(),
                status: "active".into(),
                added_at: 1,
                ..Default::default()
            },
            Item {
                name: "c".into(),
                status: "complete".into(),
                done_at: 9,
                ..Default::default()
            },
            Item {
                name: "p".into(),
                status: "paused".into(),
                added_at: 2,
                ..Default::default()
            },
        ];
        sort_smart(&mut v);
        assert_eq!(
            v.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
            ["a", "p", "c", "b"]
        );
    }

    #[test]
    fn clipboard() {
        assert!(looks_downloadable("https://x.com/a/film.mkv"));
        assert!(looks_downloadable("https://x.com/setup.exe?token=1"));
        assert!(!looks_downloadable("https://x.com/artikel"));
        assert!(!looks_downloadable("https://x.com/foto.jpg"));
        assert!(!looks_downloadable("lihat https://x.com/a.zip"));
    }
}
