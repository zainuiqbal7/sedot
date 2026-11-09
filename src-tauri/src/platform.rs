//! Urusan khusus Windows: cegah sleep, tanda "dari internet", sleep/matikan komputer.

use std::sync::mpsc;
use std::sync::OnceLock;

/// Cegah sleep selama ada unduhan. SetThreadExecutionState berlaku per thread, jadi
/// satu thread khusus memegang statusnya.
pub fn set_keep_awake(on: bool) {
    static TX: OnceLock<mpsc::Sender<bool>> = OnceLock::new();
    let tx = TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<bool>();
        std::thread::Builder::new()
            .name("sedot-power".into())
            .spawn(move || {
                for v in rx {
                    apply_keep_awake(v);
                }
            })
            .expect("thread power");
        tx
    });
    let _ = tx.send(on);
}

#[cfg(windows)]
fn apply_keep_awake(on: bool) {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };
    unsafe {
        SetThreadExecutionState(if on {
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        } else {
            ES_CONTINUOUS
        });
    }
}

#[cfg(not(windows))]
fn apply_keep_awake(_on: bool) {}

/// "Mark of the Web" seperti browser, supaya SmartScreen tetap memperingatkan saat .exe dibuka.
pub fn mark_from_internet(file: &str, url: &str) {
    if cfg!(windows) {
        let safe = if url.starts_with("http://") || url.starts_with("https://") {
            url.replace(['\r', '\n'], "")
        } else {
            String::new()
        };
        let body = if safe.is_empty() {
            "[ZoneTransfer]\r\nZoneId=3\r\n".to_string()
        } else {
            format!("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={safe}\r\n")
        };
        let _ = std::fs::write(format!("{file}:Zone.Identifier"), body);
    }
}

/// Jalankan aksi "setelah semua selesai". Hanya Windows; di sistem lain tidak melakukan apa-apa.
pub fn power_action(action: &str) {
    if !cfg!(windows) {
        return;
    }
    let mut cmd = match action {
        "shutdown" => {
            let mut c = std::process::Command::new("shutdown");
            c.args(["/s", "/t", "0"]);
            c
        }
        "sleep" => {
            let mut c = std::process::Command::new("powershell");
            c.args([
                "-NoProfile",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)",
            ]);
            c
        }
        _ => return,
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let _ = cmd.spawn();
}
