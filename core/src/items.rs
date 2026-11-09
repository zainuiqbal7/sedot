//! Status mentah aria2 -> baris daftar unduhan (setara toItem() di main.js).

use crate::categories::{category_of, host_of, name_from_url};
use crate::helpers::friendly_error;
use crate::model::{Item, Meta};
use serde_json::Value;

fn num(v: &Value) -> u64 {
    v.as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| v.as_u64())
        .unwrap_or(0)
}

fn basename(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or("").to_string()
}

pub fn to_item(s: &Value, meta: Option<&Meta>) -> Item {
    let f = &s["files"][0];
    let url = f["uris"][0]["uri"].as_str().unwrap_or("").to_string();
    let path = f["path"].as_str().unwrap_or("").to_string();
    let gid = s["gid"].as_str().unwrap_or("").to_string();
    let mut name = basename(&path);
    if name.is_empty() {
        name = name_from_url(&url);
    }
    if name.is_empty() {
        name = host_of(&url);
    }
    if name.is_empty() {
        name = gid.clone();
    }
    let status = s["status"].as_str().unwrap_or("").to_string();
    let mut item = Item {
        category: category_of(&name).to_string(),
        name,
        path,
        url,
        total: num(&s["totalLength"]),
        done: num(&s["completedLength"]),
        speed: num(&s["downloadSpeed"]),
        connections: num(&s["connections"]) as u32,
        description: meta.map(|m| m.description.clone()).unwrap_or_default(),
        added_at: meta.map(|m| m.added_at).unwrap_or(0),
        gid,
        status,
        ..Default::default()
    };
    if item.status == "error" {
        let code = s["errorCode"].as_str().unwrap_or("");
        let msg = s["errorMessage"].as_str().unwrap_or("");
        let fe = friendly_error(code, msg);
        item.error = Some(fe.text);
        item.error_hint = Some(fe.hint);
        item.expired = fe.expired;
        item.error_raw = Some(msg.to_string());
    }
    item
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn baris_dari_status_aria2() {
        let s = json!({ "gid": "0123456789abcdef", "status": "active", "totalLength": "1000", "completedLength": "250", "downloadSpeed": "50", "connections": "4",
            "files": [{ "path": "/unduh/Video/film.mkv", "uris": [{ "uri": "https://x.com/film.mkv" }] }] });
        let m = Meta {
            description: "ep 7".into(),
            added_at: 5,
            ..Default::default()
        };
        let it = to_item(&s, Some(&m));
        assert_eq!(
            (
                it.name.as_str(),
                it.category.as_str(),
                it.total,
                it.done,
                it.connections
            ),
            ("film.mkv", "Video", 1000, 250, 4)
        );
        assert_eq!((it.description.as_str(), it.added_at), ("ep 7", 5));
        assert!(it.error.is_none());
        // JSON untuk tampilan: camelCase, field kosong tidak dikirim
        let j = serde_json::to_value(&it).unwrap();
        assert_eq!(j["addedAt"], 5);
        assert!(j.get("error").is_none() && j.get("isVideo").is_none());
    }

    #[test]
    fn nama_cadangan_dan_error() {
        let s = json!({ "gid": "g", "status": "error", "errorCode": "22", "errorMessage": "Response status is not successful. status=403",
            "files": [{ "path": "", "uris": [{ "uri": "https://contoh.com/" }] }] });
        let it = to_item(&s, None);
        assert_eq!(it.name, "contoh.com", "tanpa nama file -> nama host");
        assert_eq!(it.error.as_deref(), Some("Link kedaluwarsa"));
        assert!(it.expired);
        let j = serde_json::to_value(&it).unwrap();
        assert_eq!(
            j["errorHint"].as_str().map(|h| h.contains("browser")),
            Some(true)
        );
    }
}
