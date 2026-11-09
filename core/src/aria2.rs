//! Menjalankan aria2c sebagai proses latar dan berbicara dengannya lewat JSON-RPC (setara src/aria2.js).

use rand::RngCore;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub const STATUS_KEYS: [&str; 10] = [
    "gid",
    "status",
    "totalLength",
    "completedLength",
    "downloadSpeed",
    "connections",
    "files",
    "dir",
    "errorCode",
    "errorMessage",
];

#[derive(Clone, Debug)]
pub struct Options {
    pub connections: u32,
    pub max_concurrent: u32,
    pub speed_limit_kb: u64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            connections: 16,
            max_concurrent: 3,
            speed_limit_kb: 0,
        }
    }
}

/// Opsi untuk satu unduhan.
#[derive(Default, Clone, Debug)]
pub struct AddOptions {
    pub dir: Option<String>,
    pub out: Option<String>,
    pub referer: Option<String>,
    pub cookie: Option<String>,
    pub user_agent: Option<String>,
    pub paused: bool,
    pub headers: Vec<String>,
    pub connections: Option<u32>,
}

pub struct Aria2 {
    pub bin_path: PathBuf,
    pub port: u16,
    pub session_file: PathBuf,
    pub download_dir: PathBuf,
    pub options: std::sync::Mutex<Options>,
    secret: String,
    child: Mutex<Option<Child>>,
    http: reqwest::Client,
    next_id: AtomicU64,
}

#[derive(Debug)]
pub struct RpcError(pub String);
impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for RpcError {}
pub type Result<T> = std::result::Result<T, RpcError>;
fn err<E: std::fmt::Display>(e: E) -> RpcError {
    RpcError(e.to_string())
}

fn clamp(n: u32, lo: u32, hi: u32) -> u32 {
    n.clamp(lo, hi)
}

fn speed_limit_arg(kb: u64) -> String {
    if kb > 0 {
        format!("{kb}K")
    } else {
        "0".into()
    }
}

/// Hilangkan karakter terlarang di Windows dan cegah path traversal.
pub fn sanitize_filename(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| {
            if "<>:\"|?*".contains(c) || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_start_matches('.').trim();
    let cut: String = cleaned.chars().take(200).collect();
    if cut.is_empty() {
        "unduhan".into()
    } else {
        cut
    }
}

impl Aria2 {
    pub fn new(
        bin_path: PathBuf,
        port: u16,
        session_file: PathBuf,
        download_dir: PathBuf,
        options: Options,
    ) -> Self {
        let mut b = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut b);
        Self {
            bin_path,
            port,
            session_file,
            download_dir,
            options: std::sync::Mutex::new(options),
            secret: hex::encode(b),
            child: Mutex::new(None),
            http: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("klien http"),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn build_args(&self) -> Vec<String> {
        let o = self.options.lock().unwrap().clone();
        let conn = clamp(o.connections, 1, 16);
        let mut args = vec![
            "--enable-rpc=true".to_string(),
            "--rpc-listen-all=false".into(),
            format!("--rpc-listen-port={}", self.port),
            format!("--rpc-secret={}", self.secret),
            format!("--dir={}", self.download_dir.display()),
            "--continue=true".into(),
            format!("--max-connection-per-server={conn}"),
            format!("--split={conn}"),
            "--min-split-size=1M".into(),
            format!(
                "--max-concurrent-downloads={}",
                clamp(o.max_concurrent, 1, 20)
            ),
            format!(
                "--max-overall-download-limit={}",
                speed_limit_arg(o.speed_limit_kb)
            ),
            "--auto-file-renaming=true".into(),
            "--allow-overwrite=false".into(),
            "--file-allocation=none".into(),
            "--disk-cache=32M".into(),
            "--retry-wait=3".into(),
            "--max-tries=5".into(),
            "--console-log-level=warn".into(),
            "--summary-interval=0".into(),
            format!("--save-session={}", self.session_file.display()),
            "--save-session-interval=5".into(),
            format!("--stop-with-process={}", std::process::id()), // aria2 ikut mati kalau Sedot crash
        ];
        if self.session_file.exists() {
            args.push(format!("--input-file={}", self.session_file.display()));
        }
        args
    }

    pub async fn start(&self) -> Result<()> {
        if !self.bin_path.exists() {
            return Err(RpcError(format!(
                "aria2c tidak ditemukan di: {}",
                self.bin_path.display()
            )));
        }
        let mut cmd = Command::new(&self.bin_path);
        cmd.args(self.build_args())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: tanpa jendela konsol
        }
        let mut child = cmd.spawn().map_err(err)?;
        for _ in 0..50 {
            if let Ok(Some(status)) = child.try_wait() {
                let mut msg = String::new();
                if let Some(mut e) = child.stderr.take() {
                    use tokio::io::AsyncReadExt;
                    let _ = e.read_to_string(&mut msg).await;
                }
                return Err(RpcError(format!(
                    "aria2c berhenti ({status}): {}",
                    msg.trim()
                )));
            }
            if self.call("getVersion", vec![]).await.is_ok() {
                *self.child.lock().await = Some(child);
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = child.kill().await;
        Err(RpcError("aria2c tidak merespons RPC dalam 5 detik".into()))
    }

    pub async fn stop(&self) {
        let Some(mut child) = self.child.lock().await.take() else {
            return;
        };
        let _ = self.call("saveSession", vec![]).await; // antrean tersimpan, jadi boleh langsung dimatikan
        let _ = self.call("forceShutdown", vec![]).await;
        if tokio::time::timeout(Duration::from_millis(1500), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }

    pub async fn call(&self, method: &str, params: Vec<Value>) -> Result<Value> {
        let mut p = vec![json!(format!("token:{}", self.secret))];
        p.extend(params);
        self.raw_call(&format!("aria2.{method}"), Value::Array(p))
            .await
    }

    async fn raw_call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let res = self
            .http
            .post(format!("http://127.0.0.1:{}/jsonrpc", self.port))
            .json(&body)
            .send()
            .await
            .map_err(err)?;
        let v: Value = res.json().await.map_err(err)?;
        if let Some(e) = v.get("error") {
            return Err(RpcError(
                e.get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("aria2 error")
                    .to_string(),
            ));
        }
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Semua status dalam satu panggilan (aktif + antre + berhenti + statistik).
    pub async fn snapshot(&self) -> Result<(Vec<Value>, Value)> {
        let tok = json!(format!("token:{}", self.secret));
        let keys = json!(STATUS_KEYS);
        let calls = json!([
            { "methodName": "aria2.tellActive", "params": [tok, keys] },
            { "methodName": "aria2.tellWaiting", "params": [tok, 0, 1000, keys] },
            { "methodName": "aria2.tellStopped", "params": [tok, 0, 1000, keys] },
            { "methodName": "aria2.getGlobalStat", "params": [tok] },
        ]);
        let r = self.raw_call("system.multicall", json!([calls])).await?;
        let arr = r
            .as_array()
            .ok_or_else(|| RpcError("multicall gagal".into()))?;
        let mut items = vec![];
        for (i, x) in arr.iter().enumerate() {
            let inner = x.as_array().and_then(|a| a.first()).ok_or_else(|| {
                RpcError(
                    x.get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("multicall gagal")
                        .into(),
                )
            })?;
            if i < 3 {
                items.extend(inner.as_array().cloned().unwrap_or_default());
            } else {
                return Ok((items, inner.clone()));
            }
        }
        Err(RpcError("multicall tidak lengkap".into()))
    }

    pub async fn add(&self, url: &str, o: &AddOptions) -> Result<String> {
        let mut opts = serde_json::Map::new();
        if let Some(d) = &o.dir {
            opts.insert("dir".into(), json!(d));
        }
        if let Some(out) = &o.out {
            opts.insert("out".into(), json!(sanitize_filename(out)));
        }
        if let Some(r) = &o.referer {
            opts.insert("referer".into(), json!(r));
        }
        if let Some(ua) = &o.user_agent {
            opts.insert("user-agent".into(), json!(ua));
        }
        if o.paused {
            opts.insert("pause".into(), json!("true")); // "Unduh nanti"
        }
        let mut headers: Vec<String> = o
            .headers
            .iter()
            .map(|h| h.replace(['\r', '\n'], ""))
            .filter(|h| {
                h.split_once(':').is_some_and(|(k, v)| {
                    !k.is_empty()
                        && k.chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                        && !v.trim().is_empty()
                })
            })
            .filter(|h| !(o.cookie.is_some() && h.to_ascii_lowercase().starts_with("cookie:")))
            .collect();
        if let Some(c) = &o.cookie {
            headers.push(format!("Cookie: {}", c.replace(['\r', '\n'], "")));
        }
        if !headers.is_empty() {
            opts.insert("header".into(), json!(headers));
        }
        if let Some(c) = o.connections {
            let c = clamp(c, 1, 16).to_string();
            opts.insert("split".into(), json!(c));
            opts.insert("max-connection-per-server".into(), json!(c));
        }
        let gid = self
            .call("addUri", vec![json!([url]), Value::Object(opts)])
            .await?;
        Ok(gid.as_str().unwrap_or_default().to_string())
    }

    pub async fn apply_options(&self, o: Options) -> Result<()> {
        *self.options.lock().unwrap() = o.clone();
        let conn = clamp(o.connections, 1, 16).to_string();
        self.call(
            "changeGlobalOption",
            vec![json!({
                "max-connection-per-server": conn,
                "split": conn,
                "max-concurrent-downloads": clamp(o.max_concurrent, 1, 20).to_string(),
                "max-overall-download-limit": speed_limit_arg(o.speed_limit_kb),
            })],
        )
        .await
        .map(|_| ())
    }

    /// Tunggu sampai unduhan berhenti (dipakai sebelum menghapus file atau mengganti link).
    pub async fn wait_stopped(&self, gid: &str) {
        for _ in 0..20 {
            match self
                .call("tellStatus", vec![json!(gid), json!(["status"])])
                .await
            {
                Ok(v) if matches!(v["status"].as_str(), Some("removed" | "complete" | "error")) => {
                    return
                }
                Err(_) => return,
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    }
}

/// Cari aria2c: folder aplikasi dulu, lalu PATH.
pub fn find_aria2(candidates: &[&Path]) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        "aria2c.exe"
    } else {
        "aria2c"
    };
    for dir in candidates {
        let p = dir.join(exe);
        if p.exists() {
            return Some(p);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(exe))
        .find(|p| p.exists())
}

/// Port bebas di 127.0.0.1.
pub fn free_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nama_file_aman() {
        assert_eq!(sanitize_filename("a<b>:c?.txt"), "a_b__c_.txt");
        assert_eq!(sanitize_filename("../.."), "unduhan");
        assert_eq!(sanitize_filename("..\\..\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(sanitize_filename(".tersembunyi"), "tersembunyi");
    }
}
