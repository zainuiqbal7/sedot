//! Dialog "Info unduhan" (setara openJobDialog di main.js): nama, ukuran, kategori, folder,
//! lanjutkan unduhan lama dengan link baru, peringatan file dobel.

use crate::engine::{Engine, NewJob};
use sedot_core::categories::{category_of, name_from_url, CATEGORIES};
use sedot_core::helpers::{find_duplicate, find_resumable};
use sedot_core::probe::probe;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub struct JobEntry {
    pub job: NewJob,
    pub info: Value,
}

static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn label(id: &str) -> String {
    format!("job-{id}")
}

/// Isi info dengan unduhan lama yang cocok (untuk dilanjutkan) atau duplikat (untuk diperingatkan).
fn match_existing(engine: &Engine, info: &mut Value) {
    let ui = engine.ui.lock().unwrap();
    let name = info["filename"].as_str().unwrap_or("").to_string();
    let size = info["size"].as_u64().unwrap_or(0);
    let old = find_resumable(&ui.items, &name, size);
    info["resume"] = old.map_or(Value::Null, |o| {
        json!({ "gid": o.gid, "name": o.name, "pct": (o.done * 100).checked_div(o.total).unwrap_or(0), "status": o.status, "error": o.error.clone().unwrap_or_default() })
    });
    info["duplicate"] = if old.is_some() {
        Value::Null
    } else {
        find_duplicate(&ui.items, &name, size).map_or(
            Value::Null,
            |d| json!({ "gid": d.gid, "status": d.status, "path": d.path }),
        )
    };
}

pub fn open(engine: &Arc<Engine>, job: NewJob) -> String {
    let id = (SEQ.fetch_add(1, Ordering::SeqCst) + 1).to_string();
    let s = engine.settings();
    let name0 = job
        .filename
        .clone()
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| name_from_url(&job.url));
    let cat = category_of(&name0);
    let mut info = json!({ "url": job.url, "filename": name0, "category": cat, "dir": s.dir_for(cat), "size": 0, "probing": true });
    match_existing(engine, &mut info);
    engine.jobs.lock().unwrap().insert(
        id.clone(),
        JobEntry {
            job: job.clone(),
            info,
        },
    );

    let lbl = label(&id);
    let _ = WebviewWindowBuilder::new(
        &engine.app,
        &lbl,
        WebviewUrl::App(format!("job.html?id={id}").into()),
    )
    .title("Info unduhan")
    .inner_size(640.0, 380.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .always_on_top(true)
    .center()
    .build();

    let (me, id2) = (engine.clone(), id.clone());
    tauri::async_runtime::spawn(async move {
        let r = probe(
            &job.url,
            job.cookie.as_deref(),
            job.referer.as_deref(),
            job.user_agent.as_deref(),
        )
        .await;
        let info = {
            let mut jobs = me.jobs.lock().unwrap();
            let Some(entry) = jobs.get_mut(&id2) else {
                return;
            }; // dialog sudah ditutup
            let s = me.settings();
            match r {
                Ok(p) => {
                    let name = job
                        .filename
                        .clone()
                        .filter(|f| !f.is_empty())
                        .or(Some(p.filename).filter(|f| !f.is_empty()))
                        .unwrap_or(name0);
                    let cat = category_of(&name);
                    entry.info["size"] = json!(p.size);
                    entry.info["resumable"] = json!(p.resumable);
                    entry.info["category"] = json!(cat);
                    entry.info["dir"] = json!(s.dir_for(cat));
                    entry.info["filename"] = json!(name);
                }
                Err(e) => entry.info["probeError"] = json!(e),
            }
            entry.info["probing"] = json!(false);
            entry.info.clone()
        };
        let mut info = info;
        match_existing(&me, &mut info);
        if let Some(e) = me.jobs.lock().unwrap().get_mut(&id2) {
            e.info = info.clone();
        }
        let _ = me
            .app
            .emit_to(label(&id2).as_str(), &format!("job-update-{id2}"), info);
    });
    format!("dialog-{id}")
}

/// Pastikan permintaan datang dari jendela dialog milik job itu sendiri.
pub fn check(window: &tauri::WebviewWindow, id: &str) -> Result<(), String> {
    if window.label() == label(id) {
        Ok(())
    } else {
        Err("Dialog sudah tidak berlaku.".into())
    }
}

pub fn get(engine: &Engine, id: &str) -> Option<Value> {
    let jobs = engine.jobs.lock().unwrap();
    let e = jobs.get(id)?;
    let s = engine.settings();
    let dirs: serde_json::Map<String, Value> = CATEGORIES
        .iter()
        .map(|c| (c.to_string(), json!(s.dir_for(c))))
        .collect();
    Some(json!({ "info": e.info, "categories": CATEGORIES, "dirs": dirs }))
}

pub async fn decide(
    engine: &Arc<Engine>,
    window: &tauri::WebviewWindow,
    id: &str,
    d: Value,
) -> Result<Value, String> {
    let (job, info) = {
        let jobs = engine.jobs.lock().unwrap();
        let e = jobs.get(id).ok_or("Dialog sudah tidak berlaku.")?;
        (e.job.clone(), e.info.clone())
    };
    let action = d["action"].as_str().unwrap_or("cancel");
    if action == "cancel" {
        let _ = window.close();
        return Ok(json!({ "ok": true }));
    }
    let paused = action == "later";

    // Lanjutkan unduhan lama dengan link baru (mis. link Gofile kedaluwarsa)
    if let Some(rg) = d["resumeGid"].as_str() {
        if info["resume"]["gid"].as_str() == Some(rg) {
            engine.replace_download(rg, job, paused).await?;
            let _ = window.close();
            return Ok(json!({ "ok": true }));
        }
    }

    let dir = d["dir"]
        .as_str()
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| info["dir"].as_str().unwrap_or("").to_owned());
    std::fs::create_dir_all(&dir).map_err(|e| format!("Folder tidak bisa dibuat: {e}"))?;
    {
        let mut s = engine.settings.lock().unwrap();
        let cat = d["category"].as_str().unwrap_or("");
        if d["remember"].as_bool() == Some(true) && CATEGORIES.contains(&cat) {
            s.data.category_dirs.insert(cat.to_string(), dir.clone());
        }
        if d["dontAsk"].as_bool() == Some(true) {
            s.data.ask_before_download = false;
        }
        let _ = s.save();
    }
    let filename = d["filename"]
        .as_str()
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(str::to_owned);
    let description: String = d["description"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(500)
        .collect();
    engine
        .add_job(
            NewJob {
                dir: Some(dir),
                filename: filename.clone(),
                paused,
                description,
                keep_place: true,
                ..job.clone()
            },
            false,
        )
        .await?;
    let _ = window.close();
    if action == "start" {
        engine.notify(
            "Mulai mengunduh",
            filename
                .as_deref()
                .unwrap_or(info["filename"].as_str().unwrap_or(&job.url)),
        );
    }
    Ok(json!({ "ok": true }))
}

pub fn reveal_duplicate(engine: &Engine, id: &str) -> Option<String> {
    let jobs = engine.jobs.lock().unwrap();
    let p = jobs.get(id)?.info["duplicate"]["path"]
        .as_str()?
        .to_string();
    std::path::Path::new(&p).exists().then_some(p)
}

pub fn forget(app: &tauri::AppHandle, label: &str) {
    if let Some(id) = label.strip_prefix("job-") {
        if let Some(e) = app.try_state::<Arc<Engine>>() {
            e.jobs.lock().unwrap().remove(id);
        }
    }
}
