'use strict';
const el = document.getElementById('status');
fetch('http://127.0.0.1:17345/ping')
  .then((r) => r.json())
  .then((j) => { el.textContent = `Terhubung ke aplikasi Sedot ${j.version}`; el.className = 'status on'; })
  .catch(() => { el.textContent = 'Aplikasi Sedot tidak berjalan. Unduhan tetap memakai browser.'; el.className = 'status off'; });

for (const [id, def] of [['capture', true], ['skipSmall', true]]) {
  const cb = document.getElementById(id);
  chrome.storage.local.get({ [id]: def }).then((s) => { cb.checked = s[id]; });
  cb.addEventListener('change', () => chrome.storage.local.set({ [id]: cb.checked }));
}
