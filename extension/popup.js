'use strict';
const el = document.getElementById('status');
fetch('http://127.0.0.1:17345/ping')
  .then((r) => r.json())
  .then((j) => { el.textContent = `Terhubung ke aplikasi Sedot ${j.version}`; el.className = 'status on'; })
  .catch(() => { el.textContent = 'Aplikasi Sedot tidak berjalan, jadi unduhan memakai browser. Buka Sedot dari Start Menu (mulai versi 0.5, Sedot menyala otomatis saat Windows menyala).'; el.className = 'status off'; });

for (const [id, def] of [['capture', true], ['skipSmall', true]]) {
  const cb = document.getElementById(id);
  chrome.storage.local.get({ [id]: def }).then((s) => { cb.checked = s[id]; });
  cb.addEventListener('change', () => chrome.storage.local.set({ [id]: cb.checked }));
}

// Tombol unduh video untuk tab yang sedang dibuka (YouTube, TikTok, Instagram, X, …)
const vbtn = document.getElementById('videoBtn');
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) return;
  vbtn.hidden = false;
  vbtn.onclick = () => {
    vbtn.disabled = true;
    vbtn.textContent = 'Mengirim…';
    chrome.runtime.sendMessage({ type: 'sedot-video', url: tab.url }, (r) => {
      vbtn.textContent = r?.ok ? 'Terkirim ke Sedot ✓' : 'Gagal: Sedot belum berjalan';
      if (r?.ok) setTimeout(() => window.close(), 900);
      else vbtn.disabled = false;
    });
  };
});
