//! Bentuk data yang dikirim ke tampilan. Nama field sama persis dengan versi Electron (camelCase),
//! supaya tampilan (src/renderer) dan data lama (history.json, settings.json) bisa dipakai apa adanya.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    pub gid: String,
    pub name: String,
    pub path: String,
    pub url: String,
    pub status: String,
    pub total: u64,
    pub done: u64,
    pub speed: u64,
    pub connections: u32,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_hint: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub expired: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_raw: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub added_at: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub done_at: u64,
    // --- khusus unduhan video ---
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_video: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prep_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prep_pct: Option<f64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub parts_info: Vec<PartInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PartInfo {
    pub label: String,
    pub pct: u32,
    pub speed: u64,
    pub status: String,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
