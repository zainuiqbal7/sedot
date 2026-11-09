use std::path::Path;
use std::process::Command;

fn main() {
    // Tampilan (src/renderer + penghubung Tauri) ditanam ke aplikasi saat kompilasi.
    // Siapkan ui-dist di sini supaya `cargo build`/`cargo test` selalu jalan dari keadaan bersih,
    // dan perubahan tampilan otomatis ikut masuk.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    for p in ["src/renderer", "src/helpers.js", "ui-tauri/tauri-api.js", "assets/icon.png", "scripts/build-ui.js"] {
        println!("cargo:rerun-if-changed={}", root.join(p).display());
    }
    let ok = Command::new("node")
        .arg(root.join("scripts").join("build-ui.js"))
        .current_dir(&root)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        panic!("Gagal menyiapkan tampilan (node scripts/build-ui.js). Pastikan Node.js terpasang.");
    }
    tauri_build::build()
}
