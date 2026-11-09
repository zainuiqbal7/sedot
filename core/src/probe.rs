//! Mengintip nama file & ukuran sebelum unduhan dimulai (setara src/probe.js):
//! minta 1 byte pertama (Range: bytes=0-0), baca header, lalu putuskan koneksi.

use crate::categories::name_from_url;
use std::time::Duration;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProbeResult {
    pub filename: String,
    pub size: u64,
    pub resumable: bool,
    pub final_url: String,
}

pub async fn probe(
    url: &str,
    cookie: Option<&str>,
    referer: Option<&str>,
    user_agent: Option<&str>,
) -> Result<ProbeResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url).header("Range", "bytes=0-0");
    if let Some(c) = cookie {
        req = req.header("Cookie", c.replace(['\r', '\n'], ""));
    }
    if let Some(r) = referer {
        req = req.header("Referer", r);
    }
    if let Some(ua) = user_agent {
        req = req.header("User-Agent", ua);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let h = res.headers();
    let get = |k: &str| {
        h.get(k)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    let mut size = get("content-range")
        .rsplit('/')
        .next()
        .and_then(|t| t.trim().parse().ok())
        .unwrap_or(0);
    if size == 0 && status.as_u16() == 200 {
        size = get("content-length").parse().unwrap_or(0);
    }
    let final_url = res.url().to_string();
    let mut filename = filename_from_disposition(&get("content-disposition"));
    if filename.is_empty() {
        filename = name_from_url(&final_url);
    }
    Ok(ProbeResult {
        filename,
        size,
        resumable: status.as_u16() == 206,
        final_url,
    })
}

/// Mendukung filename*=UTF-8''nama%20file.mkv dan filename="nama file.mkv".
pub fn filename_from_disposition(cd: &str) -> String {
    if cd.is_empty() {
        return String::new();
    }
    let lower = cd.to_ascii_lowercase();
    if let Some(i) = lower.find("filename*") {
        let rest = cd[i..].split_once('=').map(|x| x.1).unwrap_or("");
        let val = rest
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches('"');
        if let Some((_, enc)) = val.split_once("''") {
            if let Ok(s) = percent_encoding::percent_decode_str(enc).decode_utf8() {
                return s.into_owned();
            }
        }
    }
    let mut from = 0;
    while let Some(i) = lower[from..].find("filename") {
        let at = from + i;
        let after = &cd[at + "filename".len()..];
        if let Some(rest) = after.trim_start().strip_prefix('=') {
            let rest = rest.trim_start();
            if let Some(q) = rest.strip_prefix('"') {
                return q.split('"').next().unwrap_or("").to_string();
            }
            return rest.split(';').next().unwrap_or("").trim().to_string();
        }
        from = at + "filename".len();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_disposition() {
        assert_eq!(
            filename_from_disposition(
                "attachment; filename*=UTF-8''Magical%E2%98%85Explorer%2007.mkv"
            ),
            "Magical★Explorer 07.mkv"
        );
        assert_eq!(
            filename_from_disposition("attachment; filename=\"a b.zip\""),
            "a b.zip"
        );
        assert_eq!(
            filename_from_disposition("attachment; filename=plain.pdf; size=3"),
            "plain.pdf"
        );
        assert_eq!(filename_from_disposition(""), "");
    }
}
