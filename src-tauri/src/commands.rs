//! Perintah yang dipanggil tampilan lewat ui-tauri/tauri-api.js (setara ipcMain.handle di main.js).

use crate::engine::{Engine, NewJob, AFTER_ALL};
use crate::jobdlg;
use sedot_core::categories::CATEGORIES;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, LogicalSize, Manager, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type Eng<'a> = State<'a, Arc<Engine>>;
type R<T> = Result<T, String>;

fn valid_gid(g: &str) -> bool {
    g.len() == 16 && g.chars().all(|c| c.is_ascii_hexdigit())
}
fn ids(gids: &[String]) -> Vec<String> {
    gids.iter().filter(|g| valid_gid(g)).cloned().collect()
}
fn http_url(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    l.starts_with("http://") || l.starts_with("https://") || l.starts_with("ftp://")
}

#[tauri::command]
pub fn state(e: Eng) -> Value {
    serde_json::to_value(e.ui.lock().unwrap().clone()).unwrap_or_default()
}

#[tauri::command]
pub fn categories() -> Vec<&'static str> {
    CATEGORIES.to_vec()
}

#[tauri::command]
pub fn version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn add(e: Eng<'_>, urls: Vec<String>, dir: Option<String>) -> R<Vec<Value>> {
    let mut out = vec![];
    for url in urls.iter().map(|u| u.trim()).filter(|u| !u.is_empty()) {
        if !http_url(url) {
            out.push(
                json!({ "url": url, "error": "URL harus diawali http://, https://, atau ftp://" }),
            );
            continue;
        }
        let dir = dir.clone().filter(|d| !d.trim().is_empty());
        match e
            .add_job(
                NewJob {
                    url: url.into(),
                    dir,
                    ..Default::default()
                },
                false,
            )
            .await
        {
            Ok(gid) => out.push(json!({ "url": url, "gid": gid })),
            Err(err) => out.push(json!({ "url": url, "error": err })),
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn add_via_dialog(e: Eng, url: String) {
    if http_url(url.trim()) {
        jobdlg::open(
            &e,
            NewJob {
                url: url.trim().into(),
                ..Default::default()
            },
        );
    }
}

#[tauri::command]
pub async fn pause(e: Eng<'_>, gids: Vec<String>) -> R<()> {
    if let Some(a) = e.aria() {
        for g in ids(&gids) {
            let _ = a.call("pause", vec![json!(g)]).await;
        }
    }
    e.poll_soon();
    Ok(())
}

#[tauri::command]
pub async fn resume(e: Eng<'_>, gids: Vec<String>) -> R<()> {
    let Some(a) = e.aria() else { return Ok(()) };
    for g in ids(&gids) {
        let Some(it) = e.find_item(&g) else { continue };
        if it.status == "paused" {
            let _ = a.call("unpause", vec![json!(g)]).await;
        } else if it.status == "error" && !it.url.is_empty() {
            // Coba lagi: folder & nama sama, aria2 melanjutkan bagian yang sudah ada
            let _ = e
                .replace_download(
                    &g,
                    NewJob {
                        url: it.url.clone(),
                        ..Default::default()
                    },
                    false,
                )
                .await;
        }
    }
    e.poll_soon();
    Ok(())
}

#[tauri::command]
pub async fn pause_all(e: Eng<'_>) -> R<()> {
    if let Some(a) = e.aria() {
        let _ = a.call("pauseAll", vec![]).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn resume_all(e: Eng<'_>) -> R<()> {
    if let Some(a) = e.aria() {
        let _ = a.call("unpauseAll", vec![]).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove(e: Eng<'_>, gids: Vec<String>, delete_files: bool) -> R<()> {
    for g in ids(&gids) {
        let Some(it) = e.find_item(&g) else { continue };
        let in_history = e.history.lock().unwrap().data.iter().any(|h| h.gid == g);
        if in_history {
            let mut h = e.history.lock().unwrap();
            h.data.retain(|x| x.gid != g);
            let _ = h.save();
        } else if let Some(a) = e.aria() {
            if ["active", "waiting", "paused"].contains(&it.status.as_str()) {
                let _ = a.call("forceRemove", vec![json!(g)]).await;
                a.wait_stopped(&g).await;
            }
            let _ = a.call("removeDownloadResult", vec![json!(g)]).await;
            let mut m = e.meta.lock().unwrap();
            if m.data.remove(&g).is_some() {
                let _ = m.save();
            }
        }
        if delete_files && !it.path.is_empty() {
            let _ = std::fs::remove_file(&it.path);
            let _ = std::fs::remove_file(format!("{}.aria2", it.path));
        }
    }
    e.poll_soon();
    Ok(())
}

#[tauri::command]
pub fn open_item(app: AppHandle, e: Eng, gid: String) -> Option<String> {
    match e.find_item(&gid) {
        Some(it)
            if it.status == "complete" && !it.path.is_empty() && Path::new(&it.path).exists() =>
        {
            app.opener()
                .open_path(it.path, None::<&str>)
                .err()
                .map(|x| x.to_string())
        }
        _ => Some("File tidak ditemukan (mungkin sudah dipindah atau dihapus).".into()),
    }
}

#[tauri::command]
pub fn reveal(app: AppHandle, e: Eng, gid: String) {
    let it = e.find_item(&gid);
    let path = it.as_ref().map(|i| i.path.clone()).unwrap_or_default();
    if !path.is_empty() && Path::new(&path).exists() {
        let _ = app.opener().reveal_item_in_dir(&path);
    } else if let Some(dir) = Path::new(&path).parent().filter(|_| !path.is_empty()) {
        let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
    } else if let Some(d) = it.map(|i| i.dir).filter(|d| !d.is_empty()) {
        let _ = app.opener().open_path(d, None::<&str>);
    } else {
        let _ = app
            .opener()
            .open_path(e.settings().download_dir, None::<&str>);
    }
}

#[tauri::command]
pub fn get_settings(e: Eng) -> Value {
    serde_json::to_value(e.settings()).unwrap_or_default()
}

#[tauri::command]
pub async fn set_settings(app: AppHandle, e: Eng<'_>, s: Value) -> R<Value> {
    let new = {
        let mut st = e.settings.lock().unwrap();
        if let Some(dir) = s["downloadDir"]
            .as_str()
            .map(str::trim)
            .filter(|d| !d.is_empty())
        {
            let p = std::path::absolute(dir).map_err(|x| x.to_string())?;
            std::fs::create_dir_all(&p).map_err(|x| format!("Folder tidak bisa dibuat: {x}"))?;
            st.data.download_dir = p.to_string_lossy().into_owned();
        }
        st.data.apply(&s);
        let _ = st.save();
        st.data.clone()
    };
    if s.get("openAtLogin").is_some() {
        crate::set_autostart(&app, new.open_at_login);
    }
    if let Some(a) = e.aria() {
        let _ = a.apply_options(new.aria_options()).await;
    }
    e.update_keep_awake(e.busy());
    serde_json::to_value(new).map_err(|x| x.to_string())
}

#[tauri::command]
pub async fn choose_dir(app: AppHandle, e: Eng<'_>, current: Option<String>) -> R<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_directory(
            current
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| e.settings().download_dir),
        )
        .pick_folder(move |f| {
            let _ = tx.send(f);
        });
    let picked = rx.await.ok().flatten();
    Ok(picked
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn install_update() {
    // Tahap 4: updater Tauri
}

fn parse_size(v: &str) -> u64 {
    let v = v.trim();
    let (n, mul) = match v.chars().last() {
        Some('K' | 'k') => (&v[..v.len() - 1], 1024),
        Some('M' | 'm') => (&v[..v.len() - 1], 1024 * 1024),
        _ => (v, 1),
    };
    n.parse::<f64>()
        .map(|x| (x * mul as f64) as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn detail(e: Eng<'_>, gid: String) -> R<Option<Value>> {
    let Some(it) = e.find_item(&gid) else {
        return Ok(None);
    };
    let mut base = json!({
        "gid": it.gid, "name": it.name, "path": it.path, "url": it.url, "status": it.status, "total": it.total, "done": it.done,
        "addedAt": it.added_at, "doneAt": it.done_at, "description": it.description,
        "error": it.error.clone().unwrap_or_default(), "errorHint": it.error_hint.clone().unwrap_or_default(),
        "errorRaw": it.error_raw.clone().unwrap_or_default(), "expired": it.expired,
        "exists": !it.path.is_empty() && Path::new(&it.path).exists(),
    });
    let Some(a) = e.aria().filter(|_| it.status != "complete") else {
        return Ok(Some(base));
    };
    if let Ok(st) = a
        .call(
            "tellStatus",
            vec![
                json!(gid),
                json!(["bitfield", "numPieces", "pieceLength", "connections"]),
            ],
        )
        .await
    {
        let servers = if it.status == "active" {
            a.call("getServers", vec![json!(gid)])
                .await
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let opt = a
            .call("getOption", vec![json!(gid)])
            .await
            .unwrap_or(Value::Null);
        let conns: Vec<Value> = servers[0]["servers"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|sv| {
                        let u = sv["currentUri"].as_str().or(sv["uri"].as_str()).unwrap_or("");
                        json!({ "host": sedot_core::categories::host_of(u), "speed": sv["downloadSpeed"].as_str().and_then(|x| x.parse::<u64>().ok()).unwrap_or(0) })
                    })
                    .collect()
            })
            .unwrap_or_default();
        base["bitfield"] = st["bitfield"].clone();
        base["numPieces"] = json!(st["numPieces"]
            .as_str()
            .and_then(|x| x.parse::<u64>().ok())
            .unwrap_or(0));
        base["connections"] = json!(conns);
        base["limitKB"] =
            json!(parse_size(opt["max-download-limit"].as_str().unwrap_or("0")) / 1024);
    }
    Ok(Some(base))
}

#[tauri::command]
pub async fn set_limit(e: Eng<'_>, gid: String, kb: f64) -> R<()> {
    if !valid_gid(&gid) {
        return Ok(());
    }
    let kb = kb.max(0.0).round() as u64;
    if let Some(a) = e.aria() {
        let _ = a.call("changeOption", vec![json!(gid), json!({ "max-download-limit": if kb > 0 { format!("{kb}K") } else { "0".into() } })]).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn replace_url(e: Eng<'_>, gid: String, url: String) -> R<Value> {
    if !valid_gid(&gid) {
        return Ok(json!({ "error": "Unduhan tidak valid." }));
    }
    if !http_url(url.trim()) {
        return Ok(json!({ "error": "Link harus diawali http:// atau https://" }));
    }
    Ok(
        match e
            .replace_download(
                &gid,
                NewJob {
                    url: url.trim().into(),
                    ..Default::default()
                },
                false,
            )
            .await
        {
            Ok(_) => json!({ "ok": true }),
            Err(x) => json!({ "error": x }),
        },
    )
}

#[tauri::command]
pub fn copy_text(app: AppHandle, e: Eng, text: String) {
    *e.last_clip.lock().unwrap() = Some(text.clone()); // salinan dari Sedot tidak ditawarkan balik
    let _ = app.clipboard().write_text(text);
}

#[tauri::command]
pub fn read_clipboard(app: AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
}

/// Pilihan menu klik kanan yang sedang ditunggu.
#[derive(Default)]
pub struct MenuPick(pub Mutex<Option<tokio::sync::oneshot::Sender<String>>>);

#[tauri::command]
pub async fn context_menu(
    app: AppHandle,
    window: WebviewWindow,
    pick: State<'_, MenuPick>,
    items: Vec<Value>,
) -> R<Option<String>> {
    let menu = Menu::new(&app).map_err(|x| x.to_string())?;
    for it in &items {
        if it["sep"].as_bool() == Some(true) {
            menu.append(&PredefinedMenuItem::separator(&app).map_err(|x| x.to_string())?)
                .map_err(|x| x.to_string())?;
        } else {
            let id = format!("ctx:{}", it["id"].as_str().unwrap_or(""));
            let label = it["label"].as_str().unwrap_or("");
            let item = MenuItem::with_id(
                &app,
                id,
                label,
                it["enabled"].as_bool() != Some(false),
                None::<&str>,
            )
            .map_err(|x| x.to_string())?;
            menu.append(&item).map_err(|x| x.to_string())?;
        }
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    *pick.0.lock().unwrap() = Some(tx); // menu sebelumnya (kalau ada) dianggap batal
    window.popup_menu(&menu).map_err(|x| x.to_string())?;
    Ok(tokio::time::timeout(Duration::from_secs(60), rx)
        .await
        .ok()
        .and_then(Result::ok))
}

#[tauri::command]
pub fn set_after_all(e: Eng, action: String) {
    if AFTER_ALL.iter().any(|a| a.0 == action) {
        let cancel = action == "none";
        e.ui.lock().unwrap().after_all = action;
        if cancel {
            e.cancel_countdown();
        }
        e.send();
    }
}

#[tauri::command]
pub fn cancel_countdown(e: Eng) {
    e.cancel_countdown();
    e.send();
}

#[tauri::command]
pub fn accept_offer(e: Eng) {
    e.accept_offer();
}

#[tauri::command]
pub fn dismiss_offer(e: Eng) {
    e.ui.lock().unwrap().offer = None;
    e.send();
}

pub fn extension_dir(app: &AppHandle) -> PathBuf {
    let packed = app.path().resource_dir().map(|d| d.join("extension"));
    match packed {
        Ok(p) if p.join("manifest.json").exists() => p,
        _ => Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("extension"),
    }
}

#[tauri::command]
pub fn extension_info(app: AppHandle, e: Eng) -> Value {
    json!({ "dir": extension_dir(&app).to_string_lossy(), "seen": e.ui.lock().unwrap().extension_seen })
}

#[tauri::command]
pub fn open_extension_dir(app: AppHandle) {
    let _ = app
        .opener()
        .open_path(extension_dir(&app).to_string_lossy(), None::<&str>);
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) {
    // hanya link milik Sedot (halaman rilis & panduan), bukan sembarang URL
    if url.starts_with("https://github.com/zainuiqbal7/sedot") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

// ---------- Dialog "Info unduhan" ----------

#[tauri::command]
pub fn job_get(window: WebviewWindow, e: Eng, id: String) -> R<Option<Value>> {
    jobdlg::check(&window, &id)?;
    Ok(jobdlg::get(&e, &id))
}

#[tauri::command]
pub async fn job_decide(window: WebviewWindow, e: Eng<'_>, id: String, d: Value) -> R<Value> {
    jobdlg::check(&window, &id)?;
    Ok(jobdlg::decide(&e, &window, &id, d)
        .await
        .unwrap_or_else(|x| json!({ "error": x })))
}

#[tauri::command]
pub fn job_reveal(app: AppHandle, window: WebviewWindow, e: Eng, id: String) -> R<()> {
    jobdlg::check(&window, &id)?;
    if let Some(p) = jobdlg::reveal_duplicate(&e, &id) {
        let _ = app.opener().reveal_item_in_dir(p);
    }
    Ok(())
}

/// Sesuaikan tinggi jendela dialog dengan isinya.
#[tauri::command]
pub fn fit_window(window: WebviewWindow, h: f64) {
    if !(window.label().starts_with("job-") || window.label().starts_with("video-")) {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let w = window
        .inner_size()
        .map(|s| s.width as f64 / scale)
        .unwrap_or(640.0);
    let _ = window.set_size(LogicalSize::new(w, h.clamp(200.0, 760.0)));
}
