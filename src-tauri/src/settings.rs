//! Pengaturan (settings.json). Nama field sama dengan versi Electron supaya bisa dipindah apa adanya.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub download_dir: String,
    pub connections: u32,
    pub max_concurrent: u32,
    #[serde(rename = "speedLimitKB")]
    pub speed_limit_kb: u64,
    pub categorize: bool,
    pub minimize_to_tray: bool,
    pub notify: bool,
    pub ask_before_download: bool,
    pub category_dirs: BTreeMap<String, String>,
    pub open_at_login: bool,
    pub prevent_sleep: bool,
    pub watch_clipboard: bool,
    pub onboarded: bool,
    pub settings_version: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_dir: String::new(), // diisi saat start: <Downloads>/Sedot
            connections: 16,
            max_concurrent: 3,
            speed_limit_kb: 0,
            categorize: true,
            minimize_to_tray: true,
            notify: true,
            ask_before_download: true,
            category_dirs: BTreeMap::new(),
            open_at_login: true,
            prevent_sleep: true,
            watch_clipboard: true,
            onboarded: false,
            settings_version: 2,
        }
    }
}

impl Settings {
    pub fn aria_options(&self) -> sedot_core::aria2::Options {
        sedot_core::aria2::Options {
            connections: self.connections,
            max_concurrent: self.max_concurrent,
            speed_limit_kb: self.speed_limit_kb,
        }
    }

    /// Terapkan perubahan dari tampilan (hanya field yang dikirim; angka dibatasi).
    pub fn apply(&mut self, s: &serde_json::Value) {
        let num = |k: &str, lo: u64, hi: u64, cur: u64| {
            s.get(k)
                .and_then(serde_json::Value::as_f64)
                .map(|v| (v.round() as u64).clamp(lo, hi))
                .unwrap_or(cur)
        };
        self.connections = num("connections", 1, 16, self.connections as u64) as u32;
        self.max_concurrent = num("maxConcurrent", 1, 20, self.max_concurrent as u64) as u32;
        self.speed_limit_kb = num("speedLimitKB", 0, 10_000_000, self.speed_limit_kb);
        let flag =
            |k: &str, cur: bool| s.get(k).and_then(serde_json::Value::as_bool).unwrap_or(cur);
        self.categorize = flag("categorize", self.categorize);
        self.minimize_to_tray = flag("minimizeToTray", self.minimize_to_tray);
        self.notify = flag("notify", self.notify);
        self.ask_before_download = flag("askBeforeDownload", self.ask_before_download);
        self.prevent_sleep = flag("preventSleep", self.prevent_sleep);
        self.watch_clipboard = flag("watchClipboard", self.watch_clipboard);
        self.onboarded = flag("onboarded", self.onboarded);
        self.open_at_login = flag("openAtLogin", self.open_at_login);
    }

    /// Folder tujuan per kategori: yang diingat, subfolder kategori, atau folder utama.
    pub fn dir_for(&self, cat: &str) -> String {
        if let Some(d) = self.category_dirs.get(cat) {
            return d.clone();
        }
        if self.categorize {
            std::path::Path::new(&self.download_dir)
                .join(cat)
                .to_string_lossy()
                .into_owned()
        } else {
            self.download_dir.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baca_pengaturan_electron() {
        let old = r#"{"downloadDir":"C:\\Users\\a\\Downloads\\Sedot","connections":8,"speedLimitKB":500,"categoryDirs":{"Video":"D:\\Anime"},"openAtLogin":false,"settingsVersion":2,"lainLain":1}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert_eq!(
            (s.connections, s.speed_limit_kb, s.open_at_login),
            (8, 500, false)
        );
        assert_eq!(s.dir_for("Video"), "D:\\Anime");
        assert!(s.notify, "field yang tidak ada memakai bawaan");
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["speedLimitKB"], 500);
        assert_eq!(back["maxConcurrent"], 3);
    }

    #[test]
    fn terapkan_dari_tampilan() {
        let mut s = Settings::default();
        s.apply(&serde_json::json!({ "connections": 99, "maxConcurrent": 0, "speedLimitKB": 250.4, "notify": false, "x": true }));
        assert_eq!(
            (s.connections, s.max_concurrent, s.speed_limit_kb, s.notify),
            (16, 1, 250, false)
        );
    }
}
