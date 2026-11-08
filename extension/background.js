'use strict';
// Menangkap unduhan di browser dan mengirimnya ke aplikasi Sedot (127.0.0.1:17345).
// Kalau aplikasi tidak berjalan, unduhan dibiarkan berjalan normal di browser.

const APP = 'http://127.0.0.1:17345';
const DEFAULTS = { capture: true, skipSmall: true };
const SMALL_BYTES = 256 * 1024; // file kecil lebih cepat langsung di browser, tanpa dialog

async function ping() {
  try { await fetch(`${APP}/ping`); } catch { /* aplikasi belum jalan */ }
}

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set(cur);
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'sedot-link', title: 'Unduh dengan Sedot', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'sedot-media', title: 'Unduh media ini dengan Sedot', contexts: ['image', 'audio'] });
    chrome.contextMenus.create({ id: 'sedot-page-video', title: 'Unduh video di halaman ini (Sedot)', contexts: ['page', 'video'] });
  });
  ping(); // supaya aplikasi langsung tahu ekstensi sudah terpasang
});
chrome.runtime.onStartup.addListener(ping);

async function cookieHeader(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

/** Halaman video yang ditangani yt-dlp (sama dengan isVideoPageUrl di aplikasi). */
function isVideoPage(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^(www|m|music)\./, '');
    const p = u.pathname;
    return (h === 'youtube.com' && (p === '/watch' || /^\/(shorts|live)\//.test(p))) || h === 'youtu.be'
      || (h === 'tiktok.com' && /\/video\/\d+/.test(p)) || (h === 'instagram.com' && /^\/(reel|reels|p|tv)\//.test(p))
      || ((h === 'x.com' || h === 'twitter.com') && /\/status\/\d+/.test(p)) || (h === 'facebook.com' && /^\/(watch|reel)|\/videos\//.test(p))
      || (h === 'vimeo.com' && /^\/\d+/.test(p));
  } catch {
    return false;
  }
}

/** Kirim halaman video ke aplikasi; cookie situs ikut supaya video yang butuh login/umur bisa dibaca. */
async function sendVideoToApp(url) {
  let cookies = [];
  try {
    cookies = (await chrome.cookies.getAll({ url })).map(({ name, value, domain, path, secure, hostOnly, expirationDate }) => ({ name, value, domain, path, secure, hostOnly, expirationDate }));
  } catch { /* tanpa cookie */ }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${APP}/video`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, cookies }), signal: ctrl.signal });
    return (await res.json()).ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'sedot-video' || typeof msg.url !== 'string') return false;
  sendVideoToApp(msg.url).then((ok) => {
    flashBadge(ok ? '✓' : '!', ok ? '#0f766e' : '#c2410c');
    reply({ ok });
  });
  return true; // jawab secara async
});

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
  const { capture, skipSmall } = await chrome.storage.local.get(DEFAULTS);
  if (!capture) return;
  if (item.incognito) return; // jangan bawa cookie mode penyamaran keluar dari browser
  if (item.state !== 'in_progress') return;
  if (item.byExtensionId) return; // unduhan dari ekstensi lain dibiarkan
  const url = item.finalUrl || item.url;
  if (!/^(https?|ftp):\/\//i.test(url)) return; // blob:, data:, dll. tidak bisa diunduh dari luar browser
  const size = item.totalBytes > 0 ? item.totalBytes : item.fileSize;
  if (skipSmall && size > 0 && size < SMALL_BYTES) return;
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
  if (info.menuItemId === 'sedot-page-video') {
    const page = info.pageUrl || tab?.url;
    const ok = page && /^https?:\/\//i.test(page) ? await sendVideoToApp(page) : false;
    flashBadge(ok ? '✓' : '!', ok ? '#0f766e' : '#c2410c');
    return;
  }
  const url = info.menuItemId === 'sedot-media' ? info.srcUrl : info.linkUrl;
  if (!url || !/^(https?|ftp):\/\//i.test(url)) { flashBadge('!', '#c2410c'); return; }
  // Link ke halaman video (mis. daftar video YouTube) -> dialog pilih kualitas
  const ok = isVideoPage(url) ? await sendVideoToApp(url) : await sendToApp({ url, referer: tab?.url });
  flashBadge(ok ? '✓' : '!', ok ? '#0f766e' : '#c2410c');
});
