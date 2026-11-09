'use strict';
// Menyiapkan tampilan untuk versi Tauri: salin src/renderer apa adanya + penghubung tauri-api.js.
// Satu sumber tampilan untuk Electron & Tauri; hasilnya (src-tauri/ui-dist) tidak masuk git.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src-tauri', 'ui-dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const r = path.join(root, 'src', 'renderer');
for (const f of fs.readdirSync(r)) {
  const src = path.join(r, f);
  if (!fs.statSync(src).isFile()) continue;
  let text = fs.readFileSync(src, 'utf8');
  if (f.endsWith('.html')) {
    text = text
      .replaceAll('../helpers.js', 'helpers.js')
      .replaceAll('../../assets/icon.png', 'icon.png')
      // IPC Tauri memakai ipc:// (Linux/macOS) atau http://ipc.localhost (Windows)
      .replace("default-src 'self';", "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost;");
    const first = text.indexOf('<script');
    if (first < 0) throw new Error(`${f}: tidak ada <script>`);
    text = `${text.slice(0, first)}<script src="tauri-api.js"></script>\n  ${text.slice(first)}`;
  }
  fs.writeFileSync(path.join(out, f), text);
}
fs.copyFileSync(path.join(root, 'src', 'helpers.js'), path.join(out, 'helpers.js'));
fs.copyFileSync(path.join(root, 'assets', 'icon.png'), path.join(out, 'icon.png'));
fs.copyFileSync(path.join(root, 'ui-tauri', 'tauri-api.js'), path.join(out, 'tauri-api.js'));
console.log(`[build-ui] ${fs.readdirSync(out).length} file -> ${path.relative(root, out)}`);
