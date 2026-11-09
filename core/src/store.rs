//! Penyimpanan JSON sederhana dengan tulis atomik (setara src/store.js).

use serde::{de::DeserializeOwned, Serialize};
use std::path::{Path, PathBuf};

pub struct JsonFile<T> {
    pub path: PathBuf,
    pub data: T,
}

impl<T: Serialize + DeserializeOwned + Default> JsonFile<T> {
    /// Baca file; kalau belum ada atau rusak, pakai nilai bawaan.
    pub fn open(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { path, data }
    }

    /// Tulis ke file sementara lalu ganti nama, supaya file tidak rusak kalau listrik mati.
    pub fn save(&self) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_vec_pretty(&self.data).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(&tmp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn simpan_dan_baca_ulang() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sub").join("data.json");
        let mut f: JsonFile<HashMap<String, u32>> = JsonFile::open(&p);
        assert!(f.data.is_empty());
        f.data.insert("a".into(), 1);
        f.save().unwrap();
        assert_eq!(JsonFile::<HashMap<String, u32>>::open(&p).data["a"], 1);
        std::fs::write(&p, "{rusak").unwrap();
        assert!(
            JsonFile::<HashMap<String, u32>>::open(&p).data.is_empty(),
            "file rusak -> bawaan"
        );
    }
}
