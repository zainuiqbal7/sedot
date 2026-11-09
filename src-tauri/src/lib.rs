//! Sedot versi Rust/Tauri: merangkai plugin, tray, jendela, mesin aria2 & penghubung ekstensi.

mod commands;
mod engine;
mod jobdlg;
mod platform;
mod settings;

use engine::Engine;
use sedot_core::aria2::{find_aria2, free_port, Aria2};
use sedot_core::bridge::{self, Handlers, BRIDGE_PORT};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Tampilkan jendela utama; buat baru kalau sudah ditutup (ditutup ke tray melepas prosesnya).
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Sedot")
        .inner_size(1100.0, 680.0)
        .min_inner_size(760.0, 420.0)
        .center()
        .build();
}

pub fn set_autostart(app: &AppHandle, on: bool) {
    // Hanya untuk aplikasi terpasang (rilis): build pengembangan & alpha jangan didaftarkan ke Windows
    if cfg!(debug_assertions) || cfg!(feature = "alpha") {
        return;
    }
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    let _ = if on { al.enable() } else { al.disable() };
}

fn quit(app: &AppHandle) {
    if let Some(e) = app.try_state::<Arc<Engine>>() {
        e.quitting.store(true, Ordering::SeqCst);
    }
    app.exit(0);
}

fn on_menu(app: &AppHandle, id: &str) {
    if let Some(x) = id.strip_prefix("ctx:") {
        if let Some(tx) = app.state::<commands::MenuPick>().0.lock().unwrap().take() {
            let _ = tx.send(x.to_string());
        }
        return;
    }
    let e = app.state::<Arc<Engine>>().inner().clone();
    match id {
        "tray:open" => show_main(app),
        "tray:pause" | "tray:resume" => {
            let m = if id == "tray:pause" {
                "pauseAll"
            } else {
                "unpauseAll"
            };
            tauri::async_runtime::spawn(async move {
                if let Some(a) = e.aria() {
                    let _ = a.call(m, vec![]).await;
                }
            });
        }
        "tray:quit" => quit(app),
        _ => {}
    }
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "tray:open", "Buka Sedot", true, None::<&str>)?,
            &MenuItem::with_id(app, "tray:pause", "Jeda semua", true, None::<&str>)?,
            &MenuItem::with_id(app, "tray:resume", "Lanjutkan semua", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "tray:quit", "Keluar", true, None::<&str>)?,
        ],
    )?;
    let mut b = TrayIconBuilder::with_id("main")
        .tooltip("Sedot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = ev
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

/// Lokasi aria2c: folder sumber daya aplikasi, folder program, lalu folder bin/ repo (pengembangan), lalu PATH.
fn aria2_path(app: &AppHandle) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![];
    if let Ok(r) = app.path().resource_dir() {
        dirs.push(r.join("bin"));
    }
    if let Some(d) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|x| x.join("bin")))
    {
        dirs.push(d);
    }
    dirs.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("bin"),
    );
    let refs: Vec<&std::path::Path> = dirs.iter().map(PathBuf::as_path).collect();
    find_aria2(&refs)
}

async fn start_engine(app: AppHandle, e: Arc<Engine>, data_dir: PathBuf) {
    // aria2
    let s = e.settings();
    let started = async {
        let bin = aria2_path(&app).ok_or("aria2c tidak ditemukan. Pasang ulang Sedot.")?;
        std::fs::create_dir_all(&s.download_dir).map_err(|x| x.to_string())?;
        let a = Aria2::new(
            bin,
            free_port().map_err(|x| x.to_string())?,
            data_dir.join("aria2.session"),
            PathBuf::from(&s.download_dir),
            s.aria_options(),
        );
        a.start().await.map_err(|x| x.to_string())?;
        Ok::<_, String>(Arc::new(a))
    }
    .await;
    match started {
        Ok(a) => *e.aria.write().unwrap() = Some(a),
        Err(err) => e.ui.lock().unwrap().engine_error = Some(err),
    }

    // Penghubung ekstensi
    let port = std::env::var("SEDOT_BRIDGE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(BRIDGE_PORT);
    let (e1, e2) = (e.clone(), e.clone());
    let br = bridge::start(
        port,
        Handlers {
            version: app.package_info().version.to_string(),
            on_add: Box::new(move |j| {
                let e = e1.clone();
                Box::pin(async move { e.on_browser_job(j).await })
            }),
            on_video: None, // Tahap 3
            on_seen: Box::new(move || {
                e2.ui.lock().unwrap().extension_seen = sedot_core::model::now_ms();
            }),
        },
        tokio::runtime::Handle::current(),
    );
    e.ui.lock().unwrap().bridge = match br {
        Ok(b) => {
            std::mem::forget(b); // hidup selama aplikasi berjalan
            "on".into()
        }
        Err(x) if x.kind() == std::io::ErrorKind::AddrInUse => "port-in-use".into(),
        Err(_) => "error".into(),
    };

    e.start_clipboard_watch();
    loop {
        e.poll().await;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .manage(commands::MenuPick::default())
        .on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()))
        .on_window_event(|w, ev| match ev {
            WindowEvent::CloseRequested { .. } if w.label() == "main" => {
                // ✕ = tutup ke tray (jendela dilepas, Sedot tetap jalan); kecuali dimatikan di Pengaturan
                let tray = w
                    .app_handle()
                    .try_state::<Arc<Engine>>()
                    .map(|e| e.settings().minimize_to_tray)
                    .unwrap_or(true);
                if !tray {
                    quit(w.app_handle());
                }
            }
            WindowEvent::Destroyed => jobdlg::forget(w.app_handle(), w.label()),
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            // Pengguna versi Electron: pindahkan pengaturan, riwayat & antrean (sekali)
            if let Ok(cfg) = app.path().config_dir() {
                Engine::migrate_from_electron(&cfg.join("Sedot"), &data_dir);
            }
            let e = Arc::new(Engine::new(handle.clone(), &data_dir));
            {
                let mut s = e.settings.lock().unwrap();
                if s.data.download_dir.is_empty() {
                    let base = app
                        .path()
                        .download_dir()
                        .unwrap_or_else(|_| data_dir.clone());
                    s.data.download_dir = base.join("Sedot").to_string_lossy().into_owned();
                    let _ = s.save();
                }
            }
            app.manage(e.clone());
            create_tray(&handle)?;
            set_autostart(&handle, e.settings().open_at_login);
            // Dinyalakan bersama Windows: langsung ke tray tanpa jendela (hemat RAM)
            if !std::env::args().any(|a| a == "--hidden") {
                show_main(&handle);
            }
            tauri::async_runtime::spawn(start_engine(handle, e, data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::state,
            commands::categories,
            commands::version,
            commands::add,
            commands::add_via_dialog,
            commands::pause,
            commands::resume,
            commands::pause_all,
            commands::resume_all,
            commands::remove,
            commands::open_item,
            commands::reveal,
            commands::get_settings,
            commands::set_settings,
            commands::choose_dir,
            commands::install_update,
            commands::detail,
            commands::set_limit,
            commands::replace_url,
            commands::copy_text,
            commands::read_clipboard,
            commands::context_menu,
            commands::set_after_all,
            commands::cancel_countdown,
            commands::accept_offer,
            commands::dismiss_offer,
            commands::extension_info,
            commands::open_extension_dir,
            commands::open_url,
            commands::job_get,
            commands::job_decide,
            commands::job_reveal,
            commands::fit_window,
        ])
        .build(tauri::generate_context!())
        .expect("gagal menyiapkan Sedot");

    app.run(|app, ev| match ev {
        // Jendela terakhir ditutup: tetap hidup di tray (kecuali pengguna memilih Keluar)
        RunEvent::ExitRequested {
            api, code: None, ..
        } => {
            let quitting = app
                .try_state::<Arc<Engine>>()
                .is_some_and(|e| e.quitting.load(Ordering::SeqCst));
            if !quitting {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            if let Some(e) = app.try_state::<Arc<Engine>>() {
                if let Some(a) = e.aria() {
                    tauri::async_runtime::block_on(a.stop());
                }
                let _ = e.history.lock().unwrap().save();
                let _ = e.settings.lock().unwrap().save();
                let _ = e.meta.lock().unwrap().save();
            }
        }
        _ => {}
    });
}
