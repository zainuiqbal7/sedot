//! Server kecil di 127.0.0.1 yang menerima link dari ekstensi browser (setara src/bridge.js).
//!
//! Keamanan: hanya mendengar di loopback dan HANYA menerima Origin ekstensi
//! (chrome-extension://, moz-extension://) atau tanpa Origin (program lokal).
//! Halaman web selalu mengirim Origin http(s)://, jadi website tidak bisa menyuruh Sedot mengunduh.

use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::future::Future;
use std::io::Read;
use std::pin::Pin;
use std::sync::{Arc, LazyLock};

pub const BRIDGE_PORT: u16 = 17345;
const MAX_BODY: usize = 512 * 1024; // cookie situs video bisa puluhan KB

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// Callback penanganan permintaan dari ekstensi.
pub type JobFn<J> = Box<dyn Fn(J) -> BoxFut<Result<String, String>> + Send + Sync>;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AddJob {
    pub url: String,
    pub filename: Option<String>,
    pub referer: Option<String>,
    pub cookie: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct VideoJob {
    pub url: String,
    pub cookies: Vec<Value>,
    /// Pilihan dari menu kualitas ekstensi (divalidasi ulang oleh aplikasi). None = buka dialog lengkap.
    pub request: Option<Value>,
    pub title: String,
}

pub struct Handlers {
    pub version: String,
    pub on_add: JobFn<AddJob>,
    pub on_video: Option<JobFn<VideoJob>>,
    pub on_seen: Box<dyn Fn() + Send + Sync>,
}

static EXT_ORIGIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(chrome-extension|moz-extension|extension)://[a-z0-9-]+/?$").unwrap()
});

pub fn origin_allowed(origin: Option<&str>) -> bool {
    origin.is_none_or(|o| EXT_ORIGIN.is_match(o))
}

pub struct Bridge {
    server: Arc<tiny_http::Server>,
}

impl Bridge {
    pub fn stop(&self) {
        self.server.unblock();
    }
}

fn str_field(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .filter(|s| s.len() < 16384)
        .map(str::to_owned)
}

/// Nyalakan server; tiap permintaan ditangani di thread sendiri, callback async dijalankan di runtime tokio.
pub fn start(port: u16, handlers: Handlers, rt: tokio::runtime::Handle) -> std::io::Result<Bridge> {
    let server = Arc::new(
        tiny_http::Server::http(("127.0.0.1", port))
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::AddrInUse, e.to_string()))?,
    );
    let handlers = Arc::new(handlers);
    let s = server.clone();
    std::thread::Builder::new()
        .name("sedot-bridge".into())
        .spawn(move || {
            for req in s.incoming_requests() {
                let h = handlers.clone();
                let rt = rt.clone();
                std::thread::spawn(move || handle(req, &h, &rt));
            }
        })?;
    Ok(Bridge { server })
}

fn respond(req: tiny_http::Request, code: u16, body: Option<Value>, origin: Option<&str>) {
    let mut res = match &body {
        Some(b) => tiny_http::Response::from_data(serde_json::to_vec(b).unwrap_or_default())
            .with_status_code(code),
        None => tiny_http::Response::from_data(Vec::new()).with_status_code(code),
    };
    let hdr = |k: &str, v: &str| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
    if body.is_some() {
        res.add_header(hdr("Content-Type", "application/json"));
    }
    if let Some(o) = origin {
        res.add_header(hdr("Access-Control-Allow-Origin", o));
        res.add_header(hdr("Access-Control-Allow-Headers", "Content-Type"));
        res.add_header(hdr("Access-Control-Allow-Methods", "GET, POST"));
    }
    let _ = req.respond(res);
}

fn handle(mut req: tiny_http::Request, h: &Handlers, rt: &tokio::runtime::Handle) {
    let header = |name: &'static str| {
        req.headers()
            .iter()
            .find(|x| x.field.equiv(name))
            .map(|x| x.value.as_str().to_string())
    };
    let origin = header("Origin");
    let ctype = header("Content-Type").unwrap_or_default();
    if !origin_allowed(origin.as_deref()) {
        return respond(
            req,
            403,
            Some(json!({ "ok": false, "error": "origin ditolak" })),
            None,
        );
    }
    let origin = origin.as_deref();
    if origin.is_some() {
        (h.on_seen)();
    }
    let method = req.method().clone();
    let url = req.url().to_string();
    if method == tiny_http::Method::Options {
        return respond(req, 204, None, origin);
    }
    if method == tiny_http::Method::Get && url == "/ping" {
        return respond(
            req,
            200,
            Some(json!({ "ok": true, "app": "Sedot", "version": h.version })),
            origin,
        );
    }
    let is_post = method == tiny_http::Method::Post;
    if !(is_post && (url == "/add" || (url == "/video" && h.on_video.is_some()))) {
        return respond(
            req,
            404,
            Some(json!({ "ok": false, "error": "tidak ditemukan" })),
            origin,
        );
    }
    if !ctype.starts_with("application/json") {
        return respond(
            req,
            415,
            Some(json!({ "ok": false, "error": "harus application/json" })),
            origin,
        );
    }
    let mut buf = Vec::new();
    if req
        .as_reader()
        .take(MAX_BODY as u64 + 1)
        .read_to_end(&mut buf)
        .is_err()
        || buf.len() > MAX_BODY
    {
        return respond(
            req,
            413,
            Some(json!({ "ok": false, "error": "terlalu besar" })),
            origin,
        );
    }
    let Ok(body) = serde_json::from_slice::<Value>(&buf) else {
        return respond(
            req,
            400,
            Some(json!({ "ok": false, "error": "JSON tidak valid" })),
            origin,
        );
    };
    let target = body
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let lower = target.to_ascii_lowercase();

    if url == "/add" {
        if !(lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("ftp://"))
        {
            return respond(
                req,
                400,
                Some(json!({ "ok": false, "error": "URL harus http, https, atau ftp" })),
                origin,
            );
        }
        let job = AddJob {
            url: target,
            filename: str_field(&body, "filename"),
            referer: str_field(&body, "referer"),
            cookie: str_field(&body, "cookie"),
            user_agent: str_field(&body, "userAgent"),
        };
        return match rt.block_on((h.on_add)(job)) {
            Ok(gid) => respond(req, 200, Some(json!({ "ok": true, "gid": gid })), origin),
            Err(e) => respond(req, 500, Some(json!({ "ok": false, "error": e })), origin),
        };
    }

    // /video
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return respond(
            req,
            400,
            Some(json!({ "ok": false, "error": "URL harus http atau https" })),
            origin,
        );
    }
    let cookies = body
        .get("cookies")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .take(500)
                .filter(|c| {
                    c.get("name").is_some_and(Value::is_string)
                        && c.get("domain").is_some_and(Value::is_string)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let job = VideoJob {
        url: target,
        cookies,
        request: body.get("request").filter(|r| r.is_object()).cloned(),
        title: str_field(&body, "title")
            .map(|t| t.chars().take(300).collect())
            .unwrap_or_default(),
    };
    let on_video = h.on_video.as_ref().expect("dicek di atas");
    match rt.block_on(on_video(job)) {
        Ok(id) => respond(req, 200, Some(json!({ "ok": true, "id": id })), origin),
        Err(e) => respond(req, 500, Some(json!({ "ok": false, "error": e })), origin),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asal_permintaan() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("chrome-extension://abcdefgh")));
        assert!(origin_allowed(Some("moz-extension://1234-abcd/")));
        assert!(!origin_allowed(Some("https://situs-jahat.com")));
        assert!(!origin_allowed(Some("chrome-extension://abc/../x")));
        assert!(!origin_allowed(Some("null")));
    }
}
