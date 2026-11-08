'use strict';
const el = document.getElementById('status');
fetch('http://127.0.0.1:17345/ping')
  .then((r) => r.json())
  .then((j) => { el.textContent = `Terhubung ke aplikasi Sedot ${j.version}`; el.className = 'status on'; })
  .catch(() => { el.textContent = 'Aplikasi Sedot tidak berjalan. Unduhan tetap memakai browser.'; el.className = 'status off'; });

const cb = document.getElementById('capture');
chrome.storage.local.get({ capture: true }).then((s) => { cb.checked = s.capture; });
cb.addEventListener('change', () => chrome.storage.local.set({ capture: cb.checked }));
