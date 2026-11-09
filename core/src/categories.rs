//! Pengelompokan file berdasarkan ekstensi (setara src/categories.js).

pub const CATEGORIES: [&str; 7] = [
    "Video", "Musik", "Dokumen", "Gambar", "Program", "Arsip", "Lainnya",
];

const TABLE: &[(&str, &[&str])] = &[
    (
        "Video",
        &[
            "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "3gp", "ts",
        ],
    ),
    (
        "Musik",
        &["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus"],
    ),
    (
        "Dokumen",
        &[
            "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "epub", "odt",
        ],
    ),
    (
        "Gambar",
        &["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic"],
    ),
    (
        "Program",
        &["exe", "msi", "apk", "dmg", "deb", "rpm", "appimage", "msix"],
    ),
    (
        "Arsip",
        &["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"],
    ),
];

/// Ekstensi (huruf kecil, tanpa titik) bila 1–10 karakter alfanumerik.
pub fn ext_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((_, ext))
            if !ext.is_empty()
                && ext.len() <= 10
                && ext.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            ext.to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

pub fn category_of(name: &str) -> &'static str {
    let ext = ext_of(name);
    for (cat, exts) in TABLE {
        if exts.contains(&ext.as_str()) {
            return cat;
        }
    }
    "Lainnya"
}

/// Nama file dari URL (segmen path terakhir, tanpa query, sudah di-decode).
pub fn name_from_url(u: &str) -> String {
    let Ok(parsed) = url::Url::parse(u) else {
        return String::new();
    };
    let last = parsed
        .path_segments()
        .and_then(|mut s| s.rfind(|x| !x.is_empty()))
        .unwrap_or("");
    percent_encoding::percent_decode_str(last)
        .decode_utf8_lossy()
        .into_owned()
}

pub fn host_of(u: &str) -> String {
    url::Url::parse(u)
        .ok()
        .and_then(|x| x.host_str().map(str::to_owned))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kategori() {
        assert_eq!(category_of("Film.MKV"), "Video");
        assert_eq!(category_of("lagu.mp3"), "Musik");
        assert_eq!(category_of("setup.exe"), "Program");
        assert_eq!(category_of("tanpa-ekstensi"), "Lainnya");
        assert_eq!(category_of("aneh.abcdefghijk"), "Lainnya");
    }

    #[test]
    fn nama_dari_url() {
        assert_eq!(
            name_from_url("https://x.com/a/file%20uji.bin?x=1"),
            "file uji.bin"
        );
        assert_eq!(name_from_url("https://x.com/a/b/"), "b");
        assert_eq!(name_from_url("https://x.com/"), "");
        assert_eq!(name_from_url("bukan url"), "");
        assert_eq!(
            host_of("https://www.youtube.com/watch?v=1"),
            "www.youtube.com"
        );
    }
}
