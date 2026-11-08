'use strict';
// Menangkap unduhan di browser dan mengirimnya ke aplikasi Sedot (127.0.0.1:17345).
// Kalau aplikasi tidak berjalan, unduhan dibiarkan berjalan normal di browser.

const APP = 'http://127.0.0.1:17345';
const DEFAULTS = { capture: true };

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set(cur);
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'sedot-link', title: 'Unduh dengan Sedot', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'sedot-media', title: 'Unduh media ini dengan Sedot', contexts: ['image', 'video', 'audio'] });
  });
});

async function cookieHeader(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

async function sendToApp({ url, referer, filename }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(`${APP}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        referer: referer || undefined,
        filename: filename || undefined,
        cookie: (await cookieHeader(url)) || undefined,
        userAgent: navigator.userAgent,
      }),
      signal: ctrl.signal,
    });
    const body = await res.json();
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
}

const captured = new Set();

chrome.downloads.onCreated.addListener(async (item) => {
  const { capture } = await chrome.storage.local.get(DEFAULTS);
  if (!capture) return;
  if (item.incognito) return; // jangan bawa cookie mode penyamaran keluar dari browser
  if (item.state !== 'in_progress') return;
  if (item.byExtensionId) return; // unduhan dari ekstensi lain dibiarkan
  const url = item.finalUrl || item.url;
  if (!/^(https?|ftp):\/\//i.test(url)) return; // blob:, data:, dll. tidak bisa diunduh dari luar browser
  if (captured.has(url)) return;

  // Jeda dulu supaya browser tidak terus mengunduh selagi kita bertanya ke aplikasi.
  chrome.downloads.pause(item.id).catch(() => {});
  const ok = await sendToApp({ url, referer: item.referrer });
  if (ok) {
    captured.add(url);
    setTimeout(() => captured.delete(url), 10000);
    await chrome.downloads.cancel(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
    flashBadge('✓', '#0f766e');
  } else {
    chrome.downloads.resume(item.id).catch(() => {}); // aplikasi tidak aktif: lanjutkan di browser
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'sedot-media' ? info.srcUrl : info.linkUrl;
  if (!url || !/^(https?|ftp):\/\//i.test(url)) { flashBadge('!', '#c2410c'); return; }
  const ok = await sendToApp({ url, referer: tab?.url });
  flashBadge(ok ? '✓' : '!', ok ? '#0f766e' : '#c2410c');
});
