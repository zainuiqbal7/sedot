//! Mesin aplikasi Sedot versi Tauri (setara src/main.js tanpa fitur video):
//! polling aria2, finalisasi unduhan, taskbar/tray, cegah sleep, aksi setelah selesai, clipboard.

use crate::platform;
use crate::settings::Settings;
use sedot_core::aria2::{AddOptions, Aria2};
use sedot_core::bridge::AddJob;
use sedot_core::categories::name_from_url;
use sedot_core::helpers::{find_resumable, looks_downloadable};
use sedot_core::items::to_item;
use sedot_core::model::{now_ms, Item, Meta};
use sedot_core::store::JsonFile;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

#[derive(Clone, Serialize, Default)]
pub struct Stat {
    pub speed: u64,
    pub active: u64,
}

#[derive(Clone, Serialize)]
pub struct Countdown {
    pub action: String,
    pub label: String,
    pub left: i64,
}

#[derive(Clone, Serialize)]
pub struct Offer {
    pub url: String,
    pub name: String,
    pub video: bool,
}

/// Keadaan yang dikirim ke tampilan setiap detik (bentuk sama dengan versi Electron).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    pub items: Vec<Item>,
    pub stat: Stat,
    pub bridge: String,
    pub engine_error: Option<String>,
    pub after_all: String,
    pub countdown: Option<Countdown>,
    pub offer: Option<Offer>,
    pub extension_seen: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<Value>,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            items: vec![],
            stat: Stat::default(),
            bridge: "off".into(),
            engine_error: None,
            after_all: "none".into(),
            countdown: None,
            offer: None,
            extension_seen: 0,
            update: None,
        }
    }
}

/// Satu unduhan yang akan ditambahkan (dari tampilan, dialog, atau ekstensi).
#[derive(Default, Clone, Debug)]
pub struct NewJob {
    pub url: String,
    pub dir: Option<String>,
    pub filename: Option<String>,
    pub referer: Option<String>,
    pub cookie: Option<String>,
    pub user_agent: Option<String>,
    pub paused: bool,
    pub description: String,
    pub keep_place: bool,
    pub added_at: u64,
}

impl From<AddJob> for NewJob {
    fn from(j: AddJob) -> Self {
        Self {
            url: j.url,
            filename: j.filename,
            referer: j.referer,
            cookie: j.cookie,
            user_agent: j.user_agent,
            ..Default::default()
        }
    }
}

pub struct Engine {
    pub app: AppHandle,
    pub aria: RwLock<Option<Arc<Aria2>>>,
    pub settings: Mutex<JsonFile<Settings>>,
    pub history: Mutex<JsonFile<Vec<Item>>>,
    pub meta: Mutex<JsonFile<HashMap<String, Meta>>>,
    pub ui: Mutex<UiState>,
    pub quitting: AtomicBool,
    pub jobs: Mutex<HashMap<String, crate::jobdlg::JobEntry>>,
    pub last_clip: Mutex<Option<String>>,
    pub recent_urls: Mutex<HashMap<String, Instant>>,
    finalizing: Mutex<HashSet<String>>,
    polling: AtomicBool,
    was_busy: AtomicBool,
    keep_awake: AtomicBool,
}

pub const AFTER_ALL: [(&str, &str); 3] = [
    ("none", "Tidak ada"),
    ("sleep", "Sleep"),
    ("shutdown", "Matikan komputer"),
];
const COUNTDOWN_SECONDS: i64 = 60;

pub fn basename(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// "film.mkv" sudah ada -> "film (1).mkv"
pub fn unique_path(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let dir = p.parent().unwrap_or(Path::new("."));
    (1..1000)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|c| !c.exists())
        .unwrap_or_else(|| p.to_path_buf())
}

fn num(v: &Value) -> u64 {
    v.as_str().and_then(|s| s.parse().ok()).unwrap_or(0)
}

pub fn fmt_speed(b: u64) -> String {
    if b == 0 {
        return "0 B/s".into();
    }
    let u = ["B", "KB", "MB", "GB"];
    let i = ((b as f64).ln() / 1024f64.ln()).floor().min(3.0) as usize;
    let v = b as f64 / 1024f64.powi(i as i32);
    if i == 0 {
        format!("{v:.0} {}/s", u[i])
    } else {
        format!("{v:.1} {}/s", u[i])
    }
}

impl Engine {
    pub fn new(app: AppHandle, data_dir: &Path) -> Self {
        Self {
            app,
            aria: RwLock::new(None),
            settings: Mutex::new(JsonFile::open(data_dir.join("settings.json"))),
            history: Mutex::new(JsonFile::open(data_dir.join("history.json"))),
            meta: Mutex::new(JsonFile::open(data_dir.join("meta.json"))),
            ui: Mutex::new(UiState::default()),
            quitting: AtomicBool::new(false),
            jobs: Mutex::default(),
            last_clip: Mutex::new(None),
            recent_urls: Mutex::default(),
            finalizing: Mutex::default(),
            polling: AtomicBool::new(false),
            was_busy: AtomicBool::new(false),
            keep_awake: AtomicBool::new(false),
        }
    }

    pub fn aria(&self) -> Option<Arc<Aria2>> {
        self.aria.read().unwrap().clone()
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().data.clone()
    }

    pub fn find_item(&self, gid: &str) -> Option<Item> {
        self.ui
            .lock()
            .unwrap()
            .items
            .iter()
            .find(|i| i.gid == gid)
            .cloned()
    }

    pub fn notify(&self, title: &str, body: &str) {
        if self.settings().notify {
            let _ = self
                .app
                .notification()
                .builder()
                .title(title)
                .body(body)
                .show();
        }
    }

    /// Kirim keadaan terbaru ke jendela utama (kalau sedang terbuka).
    pub fn send(&self) {
        if let Some(w) = self.app.get_webview_window("main") {
            if w.is_visible().unwrap_or(false) {
                let ui = self.ui.lock().unwrap().clone();
                let _ = self.app.emit_to("main", "state", ui);
            }
        }
    }

    pub fn poll_soon(self: &Arc<Self>) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move { me.poll().await });
    }

    pub async fn poll(self: &Arc<Self>) {
        if self.aria().is_none() || self.polling.swap(true, Ordering::SeqCst) {
            self.send();
            return;
        }
        if let Err(e) = self.poll_inner().await {
            self.ui.lock().unwrap().engine_error =
                Some(format!("Mesin unduhan tidak merespons: {e}"));
        }
        self.polling.store(false, Ordering::SeqCst);
        self.send();
    }

    async fn poll_inner(self: &Arc<Self>) -> Result<(), String> {
        let aria = self.aria().ok_or("mesin belum siap")?;
        let (raw, stat) = aria.snapshot().await.map_err(|e| e.to_string())?;
        let meta = self.meta.lock().unwrap().data.clone();
        let live: Vec<Item> = raw
            .iter()
            .map(|s| to_item(s, meta.get(s["gid"].as_str().unwrap_or(""))))
            .filter(|i| meta.get(&i.gid).is_none_or(|m| m.group.is_empty())) // bagian video / komponen disembunyikan
            .collect();
        for it in &live {
            if it.status == "complete" && self.finalizing.lock().unwrap().insert(it.gid.clone()) {
                let (me, it) = (self.clone(), it.clone());
                tauri::async_runtime::spawn(async move { me.finalize(it).await });
            }
        }
        let live_ids: HashSet<String> = live.iter().map(|i| i.gid.clone()).collect();
        let done: Vec<Item> = self
            .history
            .lock()
            .unwrap()
            .data
            .iter()
            .filter(|h| !live_ids.contains(&h.gid))
            .map(|h| Item {
                status: "complete".into(),
                done: h.total,
                speed: 0,
                ..h.clone()
            })
            .collect();
        {
            let mut ui = self.ui.lock().unwrap();
            ui.items = live
                .into_iter()
                .filter(|i| i.status != "removed")
                .chain(done)
                .collect();
            ui.stat = Stat {
                speed: num(&stat["downloadSpeed"]),
                active: num(&stat["numActive"]),
            };
            ui.engine_error = None;
        }
        self.after_poll();
        Ok(())
    }

    /// Sekali saat unduhan selesai: pindah ke folder kategori, tandai asal internet, simpan riwayat.
    async fn finalize(self: Arc<Self>, it: Item) {
        let m = self
            .meta
            .lock()
            .unwrap()
            .data
            .get(&it.gid)
            .cloned()
            .unwrap_or_default();
        let s = self.settings();
        let mut final_path = it.path.clone();
        let in_root = Path::new(&final_path)
            .parent()
            .is_some_and(|p| p == Path::new(&s.download_dir));
        if !m.keep_place && s.categorize && !final_path.is_empty() && in_root {
            let target = unique_path(
                &Path::new(&s.download_dir)
                    .join(&it.category)
                    .join(basename(&final_path)),
            );
            if target
                .parent()
                .is_some_and(|d| std::fs::create_dir_all(d).is_ok())
                && std::fs::rename(&final_path, &target).is_ok()
            {
                final_path = target.to_string_lossy().into_owned();
            }
        }
        if !final_path.is_empty() {
            platform::mark_from_internet(&final_path, &it.url);
        }
        let name = if final_path.is_empty() {
            it.name.clone()
        } else {
            basename(&final_path)
        };
        {
            let mut h = self.history.lock().unwrap();
            h.data.insert(
                0,
                Item {
                    gid: it.gid.clone(),
                    name: name.clone(),
                    path: final_path.clone(),
                    url: it.url.clone(),
                    total: it.total,
                    category: it.category.clone(),
                    description: m.description.clone(),
                    added_at: m.added_at,
                    done_at: now_ms(),
                    ..Default::default()
                },
            );
            h.data.truncate(2000);
            let _ = h.save();
        }
        {
            let mut mm = self.meta.lock().unwrap();
            mm.data.remove(&it.gid);
            let _ = mm.save();
        }
        if let Some(a) = self.aria() {
            let _ = a.call("removeDownloadResult", vec![json!(it.gid)]).await;
        }
        self.notify("Unduhan selesai", &name);
        self.finalizing.lock().unwrap().remove(&it.gid);
    }

    /// Taskbar, judul, tooltip tray, cegah sleep, dan aksi "setelah semua selesai".
    fn after_poll(self: &Arc<Self>) {
        let (busy, total, done, speed, count) = {
            let ui = self.ui.lock().unwrap();
            let running: Vec<&Item> = ui
                .items
                .iter()
                .filter(|i| {
                    ["active", "waiting", "merging", "preparing"].contains(&i.status.as_str())
                })
                .collect();
            let sized: Vec<&&Item> = running.iter().filter(|i| i.total > 0).collect();
            (
                !running.is_empty(),
                sized.iter().map(|i| i.total).sum::<u64>(),
                sized.iter().map(|i| i.done).sum::<u64>(),
                ui.stat.speed,
                running.len(),
            )
        };
        if let Some(w) = self.app.get_webview_window("main") {
            use tauri::window::{ProgressBarState, ProgressBarStatus};
            let state = if !busy {
                ProgressBarState {
                    status: Some(ProgressBarStatus::None),
                    progress: None,
                }
            } else if total == 0 {
                ProgressBarState {
                    status: Some(ProgressBarStatus::Indeterminate),
                    progress: None,
                }
            } else {
                ProgressBarState {
                    status: Some(ProgressBarStatus::Normal),
                    progress: (done * 100).checked_div(total),
                }
            };
            let _ = w.set_progress_bar(state);
            let _ = w.set_title(&if busy {
                format!("Sedot · ↓ {}", fmt_speed(speed))
            } else {
                "Sedot".into()
            });
        }
        if let Some(t) = self.app.tray_by_id("main") {
            let tip = if busy {
                format!("Sedot\n↓ {} · {count} berjalan", fmt_speed(speed))
            } else {
                "Sedot".into()
            };
            let _ = t.set_tooltip(Some(tip));
        }
        self.update_keep_awake(busy);
        let was = self.was_busy.swap(busy, Ordering::SeqCst);
        let (after, has_cd) = {
            let ui = self.ui.lock().unwrap();
            (ui.after_all.clone(), ui.countdown.is_some())
        };
        if was && !busy && after != "none" && !has_cd {
            self.start_countdown(&after);
        }
    }

    pub fn update_keep_awake(&self, busy: bool) {
        let want = busy && self.settings().prevent_sleep;
        if self.keep_awake.swap(want, Ordering::SeqCst) != want {
            platform::set_keep_awake(want);
        }
    }

    pub fn busy(&self) -> bool {
        self.was_busy.load(Ordering::SeqCst)
    }

    fn start_countdown(self: &Arc<Self>, action: &str) {
        let label = AFTER_ALL
            .iter()
            .find(|a| a.0 == action)
            .map(|a| a.1)
            .unwrap_or(action)
            .to_string();
        self.ui.lock().unwrap().countdown = Some(Countdown {
            action: action.into(),
            label: label.clone(),
            left: COUNTDOWN_SECONDS,
        });
        crate::show_main(&self.app);
        self.notify(
            "Semua unduhan selesai",
            &format!("{label} dalam {COUNTDOWN_SECONDS} detik. Buka Sedot untuk membatalkan."),
        );
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let fire = {
                    let mut ui = me.ui.lock().unwrap();
                    let Some(cd) = ui.countdown.as_mut() else {
                        break;
                    }; // dibatalkan
                    cd.left -= 1;
                    if cd.left <= 0 {
                        let a = cd.action.clone();
                        ui.countdown = None;
                        ui.after_all = "none".into(); // sekali jalan
                        Some(a)
                    } else {
                        None
                    }
                };
                me.send();
                if let Some(a) = fire {
                    platform::power_action(&a);
                    break;
                }
            }
        });
        self.send();
    }

    pub fn cancel_countdown(&self) {
        let mut ui = self.ui.lock().unwrap();
        ui.countdown = None;
        ui.after_all = "none".into();
    }

    // ---------- Unduhan ----------

    pub async fn add_job(
        self: &Arc<Self>,
        job: NewJob,
        from_browser: bool,
    ) -> Result<String, String> {
        let aria = self.aria().ok_or_else(|| {
            self.ui
                .lock()
                .unwrap()
                .engine_error
                .clone()
                .unwrap_or("mesin unduhan belum siap".into())
        })?;
        let dir = job
            .dir
            .clone()
            .unwrap_or_else(|| self.settings().download_dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Folder tidak bisa dibuat: {e}"))?;
        let gid = aria
            .add(
                &job.url,
                &AddOptions {
                    dir: Some(dir),
                    out: job.filename.clone().filter(|f| !f.is_empty()),
                    referer: job.referer.clone(),
                    cookie: job.cookie.clone(),
                    user_agent: job.user_agent.clone(),
                    paused: job.paused,
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        {
            let mut m = self.meta.lock().unwrap();
            m.data.insert(
                gid.clone(),
                Meta {
                    description: job.description.clone(),
                    keep_place: job.keep_place,
                    added_at: if job.added_at > 0 {
                        job.added_at
                    } else {
                        now_ms()
                    },
                    group: String::new(),
                },
            );
            let _ = m.save();
        }
        if from_browser {
            let name = job
                .filename
                .clone()
                .filter(|f| !f.is_empty())
                .unwrap_or_else(|| name_from_url(&job.url));
            self.notify(
                "Sedot mengambil alih unduhan",
                if name.is_empty() { &job.url } else { &name },
            );
        }
        self.poll_soon();
        Ok(gid)
    }

    /// Ganti link unduhan yang belum selesai tanpa kehilangan bagian yang sudah terunduh
    /// (folder + nama sama => aria2 melanjutkan dari file .aria2).
    pub async fn replace_download(
        self: &Arc<Self>,
        gid: &str,
        job: NewJob,
        paused: bool,
    ) -> Result<String, String> {
        let aria = self.aria().ok_or("mesin unduhan belum siap")?;
        let it = self.find_item(gid).ok_or("Unduhan lama tidak ditemukan.")?;
        if it.status == "complete" {
            return Err("Unduhan ini sudah selesai.".into());
        }
        let m = self
            .meta
            .lock()
            .unwrap()
            .data
            .get(gid)
            .cloned()
            .unwrap_or_default();
        if ["active", "waiting", "paused"].contains(&it.status.as_str()) {
            let _ = aria.call("forceRemove", vec![json!(gid)]).await;
            aria.wait_stopped(gid).await;
        }
        let _ = aria.call("removeDownloadResult", vec![json!(gid)]).await;
        self.meta.lock().unwrap().data.remove(gid);
        let (dir, filename) = if it.path.is_empty() {
            (None, Some(it.name.clone()))
        } else {
            (
                Path::new(&it.path)
                    .parent()
                    .map(|p| p.to_string_lossy().into_owned()),
                Some(basename(&it.path)),
            )
        };
        let pct = (it.done * 100).checked_div(it.total).unwrap_or(0);
        let new_gid = self
            .add_job(
                NewJob {
                    dir,
                    filename,
                    paused,
                    description: m.description,
                    keep_place: m.keep_place,
                    added_at: m.added_at,
                    ..job
                },
                false,
            )
            .await?;
        self.notify(
            "Melanjutkan unduhan",
            &format!("{}: lanjut dari {pct}% dengan link baru", it.name),
        );
        Ok(new_gid)
    }

    /// Link dari ekstensi browser.
    pub async fn on_browser_job(self: &Arc<Self>, job: AddJob) -> Result<String, String> {
        {
            // Dua ekstensi Sedot bisa mengirim link yang sama: cukup sekali
            let mut r = self.recent_urls.lock().unwrap();
            r.retain(|_, t| t.elapsed() < Duration::from_secs(5));
            if r.contains_key(&job.url) {
                return Ok("duplikat-diabaikan".into());
            }
            r.insert(job.url.clone(), Instant::now());
        }
        if self.settings().ask_before_download {
            return Ok(crate::jobdlg::open(self, job.into()));
        }
        let name = job
            .filename
            .clone()
            .unwrap_or_else(|| name_from_url(&job.url));
        let old = {
            let ui = self.ui.lock().unwrap();
            find_resumable(&ui.items, &name, 0).map(|i| i.gid.clone())
        };
        match old {
            Some(gid) => self.replace_download(&gid, job.into(), false).await,
            None => self.add_job(job.into(), true).await,
        }
    }

    // ---------- Clipboard ----------

    pub fn start_clipboard_watch(self: &Arc<Self>) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            *me.last_clip.lock().unwrap() = me.app.clipboard().read_text().ok(); // isi lama tidak ditawarkan
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if !me.settings().watch_clipboard {
                    continue;
                }
                let Ok(t) = me.app.clipboard().read_text() else {
                    continue;
                };
                {
                    let mut last = me.last_clip.lock().unwrap();
                    if last.as_deref() == Some(t.as_str()) {
                        continue;
                    }
                    *last = Some(t.clone());
                }
                let url = t.trim().to_string();
                if !looks_downloadable(&t)
                    || me.ui.lock().unwrap().items.iter().any(|i| i.url == url)
                {
                    continue;
                }
                let name = name_from_url(&url);
                me.ui.lock().unwrap().offer = Some(Offer {
                    url,
                    name: name.clone(),
                    video: false,
                });
                me.send();
                me.notify(
                    "Link unduhan disalin",
                    &format!("{name}\nBuka Sedot untuk mengunduh."),
                );
            }
        });
    }

    pub fn accept_offer(self: &Arc<Self>) {
        let offer = self.ui.lock().unwrap().offer.take();
        self.send();
        if let Some(o) = offer {
            crate::jobdlg::open(
                self,
                NewJob {
                    url: o.url,
                    ..Default::default()
                },
            );
        }
    }

    /// Folder data lama versi Electron -> folder versi Tauri (sekali, saat pertama dijalankan).
    pub fn migrate_from_electron(old_dir: &Path, new_dir: &Path) -> Vec<String> {
        let mut moved = vec![];
        if new_dir.join("settings.json").exists() || !old_dir.join("settings.json").exists() {
            return moved;
        }
        let _ = std::fs::create_dir_all(new_dir);
        for f in [
            "settings.json",
            "history.json",
            "meta.json",
            "videos.json",
            "aria2.session",
        ] {
            if std::fs::copy(old_dir.join(f), new_dir.join(f)).is_ok() {
                moved.push(f.to_string());
            }
        }
        moved
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nama_unik_dan_kecepatan() {
        let d = tempfile_dir();
        let p = d.join("film.mkv");
        assert_eq!(unique_path(&p), p);
        std::fs::write(&p, "x").unwrap();
        assert_eq!(unique_path(&p), d.join("film (1).mkv"));
        assert_eq!(fmt_speed(0), "0 B/s");
        assert_eq!(fmt_speed(512), "512 B/s");
        assert_eq!(fmt_speed(2_621_440), "2.5 MB/s");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn pindah_data_dari_electron() {
        let base = tempfile_dir();
        let (old, new) = (base.join("Sedot"), base.join("id.sedot.app"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("settings.json"), r#"{"connections":8}"#).unwrap();
        std::fs::write(old.join("history.json"), "[]").unwrap();
        assert_eq!(
            Engine::migrate_from_electron(&old, &new),
            ["settings.json", "history.json"]
        );
        std::fs::write(old.join("settings.json"), r#"{"connections":2}"#).unwrap();
        assert!(
            Engine::migrate_from_electron(&old, &new).is_empty(),
            "hanya sekali: data baru tidak ditimpa"
        );
        assert!(std::fs::read_to_string(new.join("settings.json"))
            .unwrap()
            .contains('8'));
        let _ = std::fs::remove_dir_all(base);
    }

    fn tempfile_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("sedot-uji-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
