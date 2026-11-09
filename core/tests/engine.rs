//! Uji mesin dengan aria2c sungguhan (setara test/engine.test.js):
//! multi-koneksi, lanjut setelah aria2 dimatikan, dan keamanan penghubung ekstensi.
//! Butuh aria2c di PATH; kalau tidak ada, uji dilewati.

use sedot_core::aria2::{find_aria2, free_port, AddOptions, Aria2, Options};
use sedot_core::bridge::{self, AddJob, Handlers};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SIZE: usize = 8 * 1024 * 1024;
const PER_CONN_BPS: usize = 1024 * 1024; // 1 MB/s per koneksi

/// Pembaca yang mengirim data pelan-pelan (meniru server yang membatasi tiap koneksi ke 1 MB/s).
/// Pembatasnya berbasis waktu, karena tiny_http membaca dalam potongan kecil.
struct Slow {
    data: Arc<Vec<u8>>,
    pos: usize,
    end: usize,
    sent: usize,
    start: Instant,
    open: Arc<AtomicUsize>,
}
impl Read for Slow {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.end {
            return Ok(0);
        }
        let n = buf.len().min(self.end - self.pos).min(64 * 1024);
        let due = Duration::from_secs_f64((self.sent + n) as f64 / PER_CONN_BPS as f64);
        if let Some(wait) = due.checked_sub(self.start.elapsed()) {
            std::thread::sleep(wait);
        }
        buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
        self.pos += n;
        self.sent += n;
        Ok(n)
    }
}
impl Drop for Slow {
    fn drop(&mut self) {
        self.open.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Server file sederhana (socket TCP biasa, satu permintaan per koneksi) yang mendukung Range
/// dan membatasi tiap koneksi ke 1 MB/s. Sengaja tanpa pustaka HTTP supaya perilakunya pasti.
fn file_server(data: Arc<Vec<u8>>, max_parallel: Arc<AtomicUsize>) -> u16 {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let open = Arc::new(AtomicUsize::new(0));
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let (data, open, max_parallel) = (data.clone(), open.clone(), max_parallel.clone());
            std::thread::spawn(move || {
                let mut reader = BufReader::new(conn.try_clone().unwrap());
                let mut range = None;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        range = Some(v.trim().to_string());
                    }
                }
                let (mut s, mut e) = (0usize, SIZE - 1);
                if let Some(r) = &range {
                    let (a, b) = r.split_once('-').unwrap();
                    s = a.parse().unwrap();
                    if !b.is_empty() {
                        e = b.parse::<usize>().unwrap().min(SIZE - 1);
                    }
                }
                let now = open.fetch_add(1, Ordering::SeqCst) + 1;
                max_parallel.fetch_max(now, Ordering::SeqCst);
                let mut w = conn;
                let head = if range.is_some() {
                    format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {s}-{e}/{SIZE}\r\nConnection: close\r\n\r\n", e + 1 - s)
                } else {
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {SIZE}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n")
                };
                let mut body = Slow {
                    data,
                    pos: s,
                    end: e + 1,
                    sent: 0,
                    start: Instant::now(),
                    open,
                };
                if w.write_all(head.as_bytes()).is_ok() {
                    let _ = std::io::copy(&mut body, &mut w);
                }
            });
        }
    });
    port
}

async fn wait_done(a: &Aria2, gid: &str, secs: u64) -> Value {
    let t0 = Instant::now();
    loop {
        let st = a
            .call(
                "tellStatus",
                vec![
                    json!(gid),
                    json!(["status", "completedLength", "errorMessage", "files"]),
                ],
            )
            .await
            .unwrap();
        match st["status"].as_str() {
            Some("complete") => return st,
            Some("error") => panic!("unduhan gagal: {}", st["errorMessage"]),
            _ => {}
        }
        assert!(t0.elapsed().as_secs() < secs, "timeout: {st}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mesin_multi_koneksi_resume_dan_bridge() {
    let Some(bin) = find_aria2(&[]) else {
        eprintln!("LEWATI: aria2c tidak ada di PATH");
        return;
    };
    let data: Arc<Vec<u8>> = Arc::new((0..SIZE).map(|i| (i * 31 + (i >> 8)) as u8).collect());
    let want = sha(&data);
    let max_parallel = Arc::new(AtomicUsize::new(0));
    let port = file_server(data.clone(), max_parallel.clone());
    let url = format!("http://127.0.0.1:{port}/folder/file%20uji.bin?x=1");
    let tmp = tempfile::tempdir().unwrap();
    let mk = |opts: Options| {
        Aria2::new(
            bin.clone(),
            free_port().unwrap(),
            tmp.path().join("session.txt"),
            tmp.path().to_path_buf(),
            opts,
        )
    };

    // 1. Multi-koneksi: 8 MB @ 1 MB/s per koneksi. Satu koneksi = 8 detik.
    let a = mk(Options {
        connections: 16,
        ..Default::default()
    });
    a.start().await.unwrap();
    let t0 = Instant::now();
    let gid = a
        .add(
            &url,
            &AddOptions {
                out: Some("multi.bin".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let st = wait_done(&a, &gid, 20).await;
    let secs = t0.elapsed().as_secs_f64();
    let path = st["files"][0]["path"].as_str().unwrap().to_string();
    assert_eq!(
        sha(&std::fs::read(&path).unwrap()),
        want,
        "isi file identik"
    );
    assert!(
        max_parallel.load(Ordering::SeqCst) >= 4,
        "banyak koneksi paralel"
    );
    assert!(secs < 5.0, "multi-koneksi harus < 5 dtk (dapat {secs:.1})");
    println!(
        "OK multi-koneksi: {secs:.1} dtk, {} koneksi paralel",
        max_parallel.load(Ordering::SeqCst)
    );

    // 2. Resume: pengaturan diubah saat berjalan (2 koneksi), matikan aria2 di tengah, nyalakan lagi.
    max_parallel.store(0, Ordering::SeqCst);
    a.apply_options(Options {
        connections: 2,
        ..Default::default()
    })
    .await
    .unwrap();
    let gid = a
        .add(
            &url,
            &AddOptions {
                out: Some("resume.bin".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let mid: u64 = a
        .call("tellStatus", vec![json!(gid), json!(["completedLength"])])
        .await
        .unwrap()["completedLength"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    a.stop().await;
    assert!(
        max_parallel.load(Ordering::SeqCst) <= 2,
        "pengaturan koneksi berlaku"
    );
    assert!(
        mid > 0 && (mid as usize) < SIZE,
        "berhenti di tengah ({mid})"
    );
    let a = mk(Options::default());
    a.start().await.unwrap();
    let (items, _) = a.snapshot().await.unwrap();
    assert!(
        items.iter().any(|i| i["gid"] == gid),
        "kembali dari session dengan gid sama"
    );
    let st = wait_done(&a, &gid, 30).await;
    assert_eq!(
        sha(&std::fs::read(st["files"][0]["path"].as_str().unwrap()).unwrap()),
        want,
        "hasil resume identik"
    );
    println!(
        "OK resume: berhenti di {:.1} MB, dilanjut, hash cocok",
        mid as f64 / 1048576.0
    );

    // 3. Penghubung ekstensi
    let a = Arc::new(a);
    let added: Arc<Mutex<Vec<AddJob>>> = Arc::default();
    let (a2, added2) = (a.clone(), added.clone());
    let seen = Arc::new(AtomicUsize::new(0));
    let seen2 = seen.clone();
    let bport = free_port().unwrap();
    let br = bridge::start(
        bport,
        Handlers {
            version: "t".into(),
            on_add: Box::new(move |j| {
                let (a, added) = (a2.clone(), added2.clone());
                Box::pin(async move {
                    added.lock().unwrap().push(j.clone());
                    a.add(
                        &j.url,
                        &AddOptions {
                            out: j.filename.clone(),
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(|e| e.to_string())
                })
            }),
            on_video: None,
            on_seen: Box::new(move || {
                seen2.fetch_add(1, Ordering::SeqCst);
            }),
        },
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    let b = format!("http://127.0.0.1:{bport}");
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    let post = |ct: &'static str, origin: &'static str, body: Value| {
        c.post(format!("{b}/add"))
            .header("Content-Type", ct)
            .header("Origin", origin)
            .body(body.to_string())
            .send()
    };
    assert_eq!(
        post(
            "application/json",
            "https://situs-jahat.com",
            json!({ "url": url })
        )
        .await
        .unwrap()
        .status(),
        403,
        "website ditolak"
    );
    assert_eq!(
        post(
            "text/plain",
            "chrome-extension://abcdefgh",
            json!({ "url": url })
        )
        .await
        .unwrap()
        .status(),
        415,
        "non-JSON ditolak"
    );
    assert_eq!(
        post(
            "application/json",
            "chrome-extension://abcdefgh",
            json!({ "url": "file:///etc/passwd" })
        )
        .await
        .unwrap()
        .status(),
        400,
        "file:// ditolak"
    );
    let r: Value = post(
        "application/json",
        "chrome-extension://abcdefgh",
        json!({ "url": url, "filename": "..\\..\\Windows\\evil.exe" }),
    )
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(r["ok"], true, "{r}");
    let st = wait_done(&a, r["gid"].as_str().unwrap(), 30).await;
    let p = std::path::PathBuf::from(st["files"][0]["path"].as_str().unwrap());
    assert_eq!(
        p.parent().unwrap(),
        tmp.path(),
        "tidak boleh keluar dari folder unduhan"
    );
    assert_eq!(p.file_name().unwrap(), "evil.exe");
    let ping: Value = c
        .get(format!("{b}/ping"))
        .header("Origin", "chrome-extension://x")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ping["app"], "Sedot");
    assert!(seen.load(Ordering::SeqCst) >= 3, "kontak ekstensi tercatat");
    assert_eq!(
        c.post(format!("{b}/video"))
            .header("Content-Type", "application/json")
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        404,
        "tanpa handler video -> 404"
    );
    assert_eq!(added.lock().unwrap().len(), 1);
    println!("OK bridge: website ditolak, ekstensi diterima, path traversal dinetralkan");
    br.stop();
    a.stop().await;
}
