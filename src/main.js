'use strict';
// Proses utama Electron: menyalakan aria2, menyimpan riwayat, tray, dan menjembatani UI.

const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, Notification, nativeImage, clipboard, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { execFileSync, execFile } = require('node:child_process');

const { Aria2 } = require('./aria2');
const { startBridge } = require('./bridge');
const { JsonFile } = require('./store');
const { categoryOf, nameFromUrl, CATEGORIES } = require('./categories');
const { probe } = require('./probe');
const { friendlyError, findResumable, findDuplicate, looksDownloadable } = require('./helpers');

const IS_WIN = process.platform === 'win32';
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

let win = null;
let tray = null;
let aria = null;
let settings = null;
let history = null;
let meta = null; // gid -> { description, keepPlace, addedAt } untuk unduhan yang belum selesai
let quitting = false;
let pollTimer = null;
let lastState = { items: [], stat: {}, bridge: 'off', engineError: null, afterAll: 'none', countdown: null, offer: null, extensionSeen: 0 };
const finalizing = new Set();

// Wajib di Windows supaya notifikasi muncul atas nama "Sedot" dan bisa diklik.
if (IS_WIN) app.setAppUserModelId('id.sedot.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(boot);
}

// ---------- Startup ----------

async function boot() {
  const userData = app.getPath('userData');
  settings = new JsonFile(path.join(userData, 'settings.json'), {
    downloadDir: path.join(app.getPath('downloads'), 'Sedot'),
    connections: 16,
    maxConcurrent: 3,
    speedLimitKB: 0,
    categorize: true,
    minimizeToTray: true,
    notify: true,
    askBeforeDownload: true,
    categoryDirs: {},
    openAtLogin: false,
    preventSleep: true,
    watchClipboard: true,
    onboarded: false,
  });
  history = new JsonFile(path.join(userData, 'history.json'), []);
  meta = new JsonFile(path.join(userData, 'meta.json'), {});

  createWindow({ hidden: process.argv.includes('--hidden') });
  createTray();
  setupUpdater();

  try {
    fs.mkdirSync(settings.data.downloadDir, { recursive: true });
    aria = new Aria2({
      binPath: findAria2(),
      port: await freePort(),
      sessionFile: path.join(userData, 'aria2.session'),
      downloadDir: settings.data.downloadDir,
      options: settings.data,
    });
    await aria.start();
  } catch (e) {
    aria = null;
    lastState.engineError = String(e.message || e);
  }

  try {
    await startBridge({ version: app.getVersion(), onAdd: onBrowserJob, onSeen: () => { lastState.extensionSeen = Date.now(); } });
    lastState.bridge = 'on';
  } catch (e) {
    lastState.bridge = e.code === 'EADDRINUSE' ? 'port-in-use' : 'error';
  }

  pollTimer = setInterval(poll, 1000);
  poll();
  startClipboardWatch();
}

function findAria2() {
  const exe = IS_WIN ? 'aria2c.exe' : 'aria2c';
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', exe), // setelah di-package
    path.join(__dirname, '..', 'bin', exe),             // mode pengembangan
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [exe], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  } catch { /* tidak ada di PATH */ }
  throw new Error(
    `aria2c tidak ditemukan. Jalankan "npm run get-aria2" (Windows) atau pasang aria2 lalu buka ulang aplikasi.`,
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// ---------- Window & tray ----------

function createWindow({ hidden = false } = {}) {
  win = new BrowserWindow({
    show: !hidden, // saat dinyalakan otomatis bersama Windows, langsung ke tray
    width: 1100,
    height: 680,
    minWidth: 760,
    minHeight: 420,
    title: 'Sedot',
    icon: ICON,
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Link eksternal dibuka di browser, bukan di dalam aplikasi.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (!quitting && settings?.data.minimizeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('show', send);
  win.on('closed', () => { win = null; });
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
    tray = new Tray(img);
  } catch {
    tray = null;
    return;
  }
  tray.setToolTip('Sedot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Buka Sedot', click: showWindow },
    { label: 'Jeda semua', click: () => aria?.call('pauseAll').catch(() => {}) },
    { label: 'Lanjutkan semua', click: () => aria?.call('unpauseAll').catch(() => {}) },
    { type: 'separator' },
    { label: 'Keluar', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', async (e) => {
  if (!aria) return;
  e.preventDefault();
  clearInterval(pollTimer);
  const a = aria;
  aria = null;
  await a.stop().catch(() => {});
  history?.flush();
  settings?.flush();
  meta?.flush();
  app.quit(); // aria sudah null, jadi kali ini keluar sungguhan (dan installer update bisa berjalan)
});
app.on('window-all-closed', () => {
  if (!tray) { quitting = true; app.quit(); }
});

// ---------- Unduhan ----------

async function addJob(job, fromBrowser = false) {
  if (!aria) throw new Error(lastState.engineError || 'mesin unduhan belum siap');
  const dir = job.dir || settings.data.downloadDir;
  fs.mkdirSync(dir, { recursive: true });
  const gid = await aria.add(job.url, {
    dir,
    out: job.filename,
    referer: job.referer,
    cookie: job.cookie,
    userAgent: job.userAgent,
    paused: job.paused,
  });
  meta.data[gid] = { description: job.description || '', keepPlace: !!job.keepPlace, addedAt: job.addedAt || Date.now() };
  meta.save();
  if (fromBrowser && settings.data.notify && Notification.isSupported()) {
    new Notification({ title: 'Sedot mengambil alih unduhan', body: job.filename || nameFromUrl(job.url) || job.url }).show();
  }
  poll();
  return gid;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function errorFields(s) {
  const f = friendlyError(s.errorCode, s.errorMessage);
  return { error: f.text, errorHint: f.hint, expired: !!f.expired, errorRaw: s.errorMessage || '' };
}

function toItem(s) {
  const f = s.files?.[0] || {};
  const url = f.uris?.[0]?.uri || '';
  const name = (f.path && path.basename(f.path)) || nameFromUrl(url) || hostOf(url) || s.gid;
  return {
    gid: s.gid,
    name,
    path: f.path || '',
    url,
    status: s.status,
    total: Number(s.totalLength) || 0,
    done: Number(s.completedLength) || 0,
    speed: Number(s.downloadSpeed) || 0,
    connections: Number(s.connections) || 0,
    category: categoryOf(name),
    ...(s.status === 'error' ? errorFields(s) : {}),
    description: meta.data[s.gid]?.description || '',
    addedAt: meta.data[s.gid]?.addedAt || 0,
  };
}

let polling = false;
async function poll() {
  if (!aria || polling) { send(); return; }
  polling = true;
  try {
    const snap = await aria.snapshot();
    const live = snap.items.map(toItem);
    for (const it of live) {
      if (it.status === 'complete' && !finalizing.has(it.gid)) finalize(it);
    }
    const liveIds = new Set(live.map((i) => i.gid));
    const done = history.data.filter((h) => !liveIds.has(h.gid)).map((h) => ({ ...h, status: 'complete', done: h.total, speed: 0 }));
    lastState.items = [...live.filter((i) => i.status !== 'removed'), ...done];
    lastState.stat = { speed: Number(snap.stat.downloadSpeed) || 0, active: Number(snap.stat.numActive) || 0 };
    lastState.engineError = null;
    afterPoll();
  } catch (e) {
    lastState.engineError = `Mesin unduhan tidak merespons: ${e.message || e}`;
  } finally {
    polling = false;
  }
  send();
}

/** Dipanggil sekali saat unduhan selesai: pindah ke folder kategori, tandai asal internet, simpan riwayat. */
async function finalize(it) {
  finalizing.add(it.gid);
  try {
    let finalPath = it.path;
    const m = meta.data[it.gid] || {};
    if (!m.keepPlace && settings.data.categorize && finalPath && path.dirname(finalPath) === path.resolve(settings.data.downloadDir)) {
      const target = uniquePath(path.join(settings.data.downloadDir, it.category, path.basename(finalPath)));
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(finalPath, target);
        finalPath = target;
      } catch { /* biarkan di tempat asal */ }
    }
    if (IS_WIN && finalPath) markFromInternet(finalPath, it.url);
    history.data.unshift({
      gid: it.gid,
      name: path.basename(finalPath || it.name),
      path: finalPath,
      url: it.url,
      total: it.total,
      category: it.category,
      description: m.description || undefined,
      addedAt: m.addedAt || undefined,
      doneAt: Date.now(),
    });
    delete meta.data[it.gid];
    meta.save();
    history.data = history.data.slice(0, 2000);
    history.save();
    await aria?.call('removeDownloadResult', it.gid).catch(() => {});
    if (settings.data.notify && Notification.isSupported()) {
      const n = new Notification({ title: 'Unduhan selesai', body: path.basename(finalPath || it.name) });
      n.on('click', () => finalPath && shell.showItemInFolder(finalPath));
      n.show();
    }
  } finally {
    finalizing.delete(it.gid);
  }
}

/**
 * Tambahkan "Mark of the Web" seperti yang dilakukan browser, supaya Windows SmartScreen
 * tetap memperingatkan saat file .exe hasil unduhan dibuka.
 */
function markFromInternet(file, url) {
  try {
    const safeUrl = /^https?:\/\//i.test(url) ? url.replace(/[\r\n]/g, '') : '';
    fs.writeFileSync(`${file}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\n${safeUrl ? `HostUrl=${safeUrl}\r\n` : ''}`);
  } catch { /* bukan NTFS, abaikan */ }
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; i < 1000; i++) {
    const c = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
  return p;
}

function send() {
  if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('state', lastState);
}

function findItem(gid) {
  return lastState.items.find((i) => i.gid === gid);
}

function ids(gids) {
  return Array.isArray(gids) ? gids.filter((g) => typeof g === 'string' && /^[0-9a-f]{16}$/.test(g)) : [];
}

async function waitStopped(gid) {
  for (let i = 0; i < 20; i++) {
    try {
      const s = await aria.call('tellStatus', gid, ['status']);
      if (s.status === 'removed' || s.status === 'complete' || s.status === 'error') return;
    } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function unlinkQuiet(p) {
  try { fs.unlinkSync(p); } catch { /* sudah tidak ada */ }
}

// ---------- IPC dari UI ----------

ipcMain.handle('state', () => lastState);
ipcMain.handle('version', () => app.getVersion());
ipcMain.handle('installUpdate', () => {
  if (lastState.update?.status !== 'ready' || !autoUpdater) return;
  quitting = true;
  autoUpdater.quitAndInstall(true, true); // diam-diam, lalu buka lagi Sedot versi baru
});
ipcMain.handle('categories', () => CATEGORIES);

ipcMain.handle('add', async (_e, { urls, dir }) => {
  const list = (Array.isArray(urls) ? urls : []).map((u) => String(u).trim()).filter(Boolean);
  const results = [];
  for (const url of list) {
    if (!/^(https?|ftp):\/\//i.test(url)) { results.push({ url, error: 'URL harus diawali http://, https://, atau ftp://' }); continue; }
    try { results.push({ url, gid: await addJob({ url, dir: typeof dir === 'string' && dir ? dir : undefined }) }); }
    catch (e) { results.push({ url, error: String(e.message || e) }); }
  }
  return results;
});

ipcMain.handle('pause', async (_e, gids) => {
  for (const g of ids(gids)) await aria?.call('pause', g).catch(() => {});
  poll();
});

ipcMain.handle('resume', async (_e, gids) => {
  for (const g of ids(gids)) {
    const it = findItem(g);
    if (!it) continue;
    if (it.status === 'paused') await aria?.call('unpause', g).catch(() => {});
    else if (it.status === 'error' && it.url) {
      // Coba lagi: daftarkan ulang ke folder dan nama yang sama, aria2 akan melanjutkan bagian yang sudah ada.
      await replaceDownload(g, { url: it.url }).catch(() => {});
    }
  }
  poll();
});

ipcMain.handle('pauseAll', () => aria?.call('pauseAll').catch(() => {}));
ipcMain.handle('resumeAll', () => aria?.call('unpauseAll').catch(() => {}));

ipcMain.handle('remove', async (_e, { gids, deleteFiles }) => {
  for (const g of ids(gids)) {
    const it = findItem(g);
    if (!it) continue;
    const inHistory = history.data.some((h) => h.gid === g);
    if (inHistory) {
      history.data = history.data.filter((h) => h.gid !== g);
      history.save();
    } else if (aria) {
      if (['active', 'waiting', 'paused'].includes(it.status)) {
        await aria.call('forceRemove', g).catch(() => {});
        await waitStopped(g);
      }
      await aria.call('removeDownloadResult', g).catch(() => {});
      if (meta.data[g]) { delete meta.data[g]; meta.save(); }
    }
    if (deleteFiles && it.path) {
      unlinkQuiet(it.path);
      unlinkQuiet(`${it.path}.aria2`);
    }
  }
  poll();
});

ipcMain.handle('open', (_e, gid) => {
  const it = findItem(gid);
  if (it?.status === 'complete' && it.path && fs.existsSync(it.path)) return shell.openPath(it.path);
  return 'File tidak ditemukan (mungkin sudah dipindah atau dihapus).';
});

ipcMain.handle('reveal', (_e, gid) => {
  const it = findItem(gid);
  if (it?.path && fs.existsSync(it.path)) shell.showItemInFolder(it.path);
  else if (it?.path) shell.openPath(path.dirname(it.path));
  else shell.openPath(settings.data.downloadDir);
});

ipcMain.handle('getSettings', () => settings.data);

ipcMain.handle('setSettings', async (_e, s) => {
  const d = settings.data;
  if (typeof s.downloadDir === 'string' && s.downloadDir.trim()) {
    const dir = path.resolve(s.downloadDir.trim());
    fs.mkdirSync(dir, { recursive: true });
    d.downloadDir = dir;
  }
  const num = (v, lo, hi, def) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : def);
  d.connections = num(s.connections, 1, 16, d.connections);
  d.maxConcurrent = num(s.maxConcurrent, 1, 20, d.maxConcurrent);
  d.speedLimitKB = num(s.speedLimitKB, 0, 10_000_000, d.speedLimitKB);
  if (typeof s.openAtLogin === 'boolean') {
    d.openAtLogin = s.openAtLogin;
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: d.openAtLogin, args: ['--hidden'] });
  }
  for (const k of ['categorize', 'minimizeToTray', 'notify', 'askBeforeDownload', 'preventSleep', 'watchClipboard', 'onboarded']) if (typeof s[k] === 'boolean') d[k] = s[k];
  settings.save();
  await aria?.applyOptions(d).catch(() => {});
  if (!d.preventSleep) updatePowerBlock();
  return d;
});

ipcMain.handle('chooseDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.data.downloadDir });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- Dialog "Info unduhan" (muncul saat browser mengirim link) ----------

const jobs = new Map();
let jobSeq = 0;

/** Folder tujuan untuk sebuah kategori: folder yang diingat, atau subfolder kategori, atau folder utama. */
function dirFor(cat) {
  const remembered = settings.data.categoryDirs?.[cat];
  if (remembered) return remembered;
  return settings.data.categorize ? path.join(settings.data.downloadDir, cat) : settings.data.downloadDir;
}

function openJobDialog(job) {
  const id = String(++jobSeq);
  const name0 = job.filename || nameFromUrl(job.url) || '';
  const category = categoryOf(name0);
  const entry = { job, info: { url: job.url, filename: name0, category, dir: dirFor(category), size: 0, probing: true }, win: null };
  jobs.set(id, entry);
  matchExisting(entry.info);

  const w = new BrowserWindow({
    width: 640,
    height: 380,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: 'Info unduhan',
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'job-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  entry.win = w;
  w.loadFile(path.join(__dirname, 'renderer', 'job.html'), { query: { id } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.once('ready-to-show', () => { w.show(); w.focus(); });
  w.on('closed', () => jobs.delete(id));

  probe(job)
    .then((r) => {
      const name = job.filename || r.filename || name0;
      Object.assign(entry.info, { size: r.size, resumable: r.resumable, filename: name, category: categoryOf(name) });
      entry.info.dir = dirFor(entry.info.category);
    })
    .catch((e) => { entry.info.probeError = String(e.message || e); })
    .finally(() => {
      entry.info.probing = false;
      matchExisting(entry.info);
      if (!w.isDestroyed()) w.webContents.send('job:update', entry.info);
    });

  return Promise.resolve(`dialog-${id}`);
}

/** Pastikan permintaan IPC datang dari jendela dialog milik job itu sendiri. */
function jobFor(e, id) {
  const entry = jobs.get(String(id));
  return entry && entry.win && !entry.win.isDestroyed() && e.sender === entry.win.webContents ? entry : null;
}

ipcMain.handle('job:get', (e, id) => {
  const entry = jobFor(e, id);
  if (!entry) return null;
  return {
    info: entry.info,
    categories: CATEGORIES,
    dirs: Object.fromEntries(CATEGORIES.map((c) => [c, dirFor(c)])),
  };
});

ipcMain.handle('job:chooseDir', async (e, { id, current }) => {
  const entry = jobFor(e, id);
  if (!entry) return null;
  const r = await dialog.showOpenDialog(entry.win, { properties: ['openDirectory', 'createDirectory'], defaultPath: current || settings.data.downloadDir });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('job:reveal', (e, id) => {
  const p = jobFor(e, id)?.info.duplicate?.path;
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
});

ipcMain.handle('job:resize', (e, { id, h }) => {
  const entry = jobFor(e, id);
  if (entry && Number.isFinite(h)) entry.win.setContentSize(640, Math.max(300, Math.min(720, Math.ceil(h))));
});

ipcMain.handle('job:decide', async (e, d) => {
  const entry = jobFor(e, d?.id);
  if (!entry) return { error: 'Dialog sudah tidak berlaku.' };
  if (d.action === 'cancel') { entry.win.close(); return { ok: true }; }

  // Lanjutkan unduhan lama dengan link baru (mis. link Gofile kedaluwarsa)
  if (d.resumeGid && entry.info.resume?.gid === d.resumeGid) {
    try {
      await replaceDownload(d.resumeGid, entry.job, { paused: d.action === 'later' });
    } catch (err) {
      return { error: String(err.message || err) };
    }
    entry.win.close();
    return { ok: true };
  }

  const dir = typeof d.dir === 'string' && d.dir.trim() ? path.resolve(d.dir.trim()) : entry.info.dir;
  const filename = typeof d.filename === 'string' ? d.filename.trim() : '';
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { error: `Folder tidak bisa dibuat: ${err.message}` };
  }
  if (d.remember && CATEGORIES.includes(d.category)) {
    settings.data.categoryDirs = { ...settings.data.categoryDirs, [d.category]: dir };
  }
  if (d.dontAsk) settings.data.askBeforeDownload = false;
  settings.save();

  try {
    await addJob({
      ...entry.job,
      dir,
      filename: filename || undefined,
      paused: d.action === 'later',
      description: typeof d.description === 'string' ? d.description.slice(0, 500) : '',
      keepPlace: true, // pengguna sudah memilih folder sendiri: jangan dipindah lagi
    });
  } catch (err) {
    return { error: String(err.message || err) };
  }
  entry.win.close();
  if (d.action === 'start' && settings.data.notify && Notification.isSupported()) {
    new Notification({ title: 'Mulai mengunduh', body: filename || entry.info.filename || entry.job.url }).show();
  }
  return { ok: true };
});

// ---------- Update otomatis (GitHub Releases) ----------

let autoUpdater = null;

function setupUpdater() {
  if (!app.isPackaged) return; // mode pengembangan (npm start) tidak mengecek update
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // kalau tidak di-restart manual, terpasang saat Sedot ditutup

  autoUpdater.on('update-available', (info) => {
    lastState.update = { status: 'downloading', version: info.version, percent: 0 };
    send();
  });
  autoUpdater.on('download-progress', (p) => {
    if (lastState.update) lastState.update.percent = Math.round(p.percent);
    send();
  });
  autoUpdater.on('update-downloaded', (info) => {
    lastState.update = { status: 'ready', version: info.version };
    send();
    if (settings.data.notify && Notification.isSupported()) {
      const n = new Notification({ title: `Sedot ${info.version} siap dipasang`, body: 'Klik untuk restart sekarang, atau biarkan: terpasang otomatis saat Sedot ditutup.' });
      n.on('click', () => { quitting = true; autoUpdater.quitAndInstall(true, true); });
      n.show();
    }
  });
  autoUpdater.on('error', () => {
    if (lastState.update?.status === 'downloading') lastState.update = null;
    send();
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, 6 * 60 * 60 * 1000); // cek lagi tiap 6 jam
}

// ---------- Unduhan dari browser ----------

const recentUrls = new Map();

function onBrowserJob(job) {
  // Dua ekstensi Sedot (mis. versi zip lama + versi bawaan aplikasi) bisa mengirim link yang sama: cukup sekali.
  const now = Date.now();
  for (const [u, t] of recentUrls) if (now - t > 5000) recentUrls.delete(u);
  if (recentUrls.has(job.url)) return Promise.resolve('duplikat-diabaikan');
  recentUrls.set(job.url, now);

  if (settings.data.askBeforeDownload) return openJobDialog(job);
  // Tanpa dialog: kalau ini file yang dulu gagal/terjeda, otomatis lanjutkan dengan link baru.
  const name = job.filename || nameFromUrl(job.url);
  const old = findResumable(lastState.items, name, 0);
  if (old) return replaceDownload(old.gid, job);
  return addJob(job, true);
}

/** Isi info dialog dengan unduhan lama yang cocok (untuk dilanjutkan) atau duplikat (untuk diperingatkan). */
function matchExisting(info) {
  const old = findResumable(lastState.items, info.filename, info.size);
  info.resume = old ? { gid: old.gid, name: old.name, pct: old.total ? Math.floor((old.done / old.total) * 100) : 0, status: old.status, error: old.error || '' } : null;
  const dup = old ? null : findDuplicate(lastState.items, info.filename, info.size);
  info.duplicate = dup ? { gid: dup.gid, status: dup.status, path: dup.path } : null;
}

/**
 * Ganti link sebuah unduhan yang belum selesai, tanpa kehilangan bagian yang sudah terunduh.
 * aria2 menyimpan progres di file "<nama>.aria2"; dengan folder + nama yang sama ia melanjutkan dari situ.
 */
async function replaceDownload(gid, job, { paused = false } = {}) {
  if (!aria) throw new Error(lastState.engineError || 'mesin unduhan belum siap');
  const it = findItem(gid);
  if (!it) throw new Error('Unduhan lama tidak ditemukan.');
  if (it.status === 'complete') throw new Error('Unduhan ini sudah selesai.');
  const m = meta.data[gid] || {};
  if (['active', 'waiting', 'paused'].includes(it.status)) {
    await aria.call('forceRemove', gid).catch(() => {});
    await waitStopped(gid);
  }
  await aria.call('removeDownloadResult', gid).catch(() => {});
  delete meta.data[gid];
  const newGid = await addJob({
    url: job.url,
    cookie: job.cookie,
    referer: job.referer,
    userAgent: job.userAgent,
    dir: it.path ? path.dirname(it.path) : undefined,
    filename: it.path ? path.basename(it.path) : it.name,
    paused,
    description: m.description,
    keepPlace: m.keepPlace,
    addedAt: m.addedAt,
  });
  if (settings.data.notify && Notification.isSupported()) {
    new Notification({ title: 'Melanjutkan unduhan', body: `${it.name}: lanjut dari ${it.total ? Math.floor((it.done / it.total) * 100) : 0}% dengan link baru` }).show();
  }
  return newGid;
}

// ---------- Setelah setiap polling: taskbar, tray, sleep, aksi "setelah semua selesai" ----------

let sleepBlockId = null;
let wasBusy = false;

function afterPoll() {
  const running = lastState.items.filter((i) => i.status === 'active' || i.status === 'waiting');
  const busy = running.length > 0;

  // Progres di ikon taskbar Windows
  if (win && !win.isDestroyed()) {
    const sized = running.filter((i) => i.total > 0);
    const total = sized.reduce((a, i) => a + i.total, 0);
    const done = sized.reduce((a, i) => a + i.done, 0);
    win.setProgressBar(busy ? (total ? done / total : 2) : -1); // 2 = mode "tidak tentu"
    win.setTitle(busy ? `Sedot · ↓ ${fmtSpeed(lastState.stat.speed)}` : 'Sedot');
  }
  tray?.setToolTip(busy ? `Sedot\n↓ ${fmtSpeed(lastState.stat.speed)} · ${running.length} berjalan` : 'Sedot');

  updatePowerBlock(busy);

  // Semua unduhan (yang tidak dijeda) baru saja selesai -> jalankan aksi pilihan pengguna
  if (wasBusy && !busy && lastState.afterAll !== 'none' && !lastState.countdown) startCountdown(lastState.afterAll);
  wasBusy = busy;
}

function updatePowerBlock(busy = wasBusy) {
  const want = busy && settings.data.preventSleep;
  if (want && sleepBlockId === null) sleepBlockId = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && sleepBlockId !== null) { powerSaveBlocker.stop(sleepBlockId); sleepBlockId = null; }
}

function fmtSpeed(b) {
  if (!b) return '0 B/s';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(3, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}/s`;
}

const AFTER_ALL = { none: 'Tidak ada', sleep: 'Sleep', shutdown: 'Matikan komputer' };
const COUNTDOWN_SECONDS = 60;
let countdownTimer = null;

function startCountdown(action) {
  lastState.countdown = { action, label: AFTER_ALL[action], left: COUNTDOWN_SECONDS };
  showWindow();
  if (settings.data.notify && Notification.isSupported()) {
    new Notification({ title: 'Semua unduhan selesai', body: `${AFTER_ALL[action]} dalam ${COUNTDOWN_SECONDS} detik. Buka Sedot untuk membatalkan.` }).show();
  }
  countdownTimer = setInterval(() => {
    if (!lastState.countdown) return;
    lastState.countdown.left -= 1;
    if (lastState.countdown.left <= 0) {
      clearInterval(countdownTimer);
      lastState.countdown = null;
      lastState.afterAll = 'none'; // sekali jalan, supaya besok tidak mati sendiri
      runPowerAction(action);
    }
    send();
  }, 1000);
  send();
}

function cancelCountdown() {
  clearInterval(countdownTimer);
  lastState.countdown = null;
  lastState.afterAll = 'none';
  send();
}

function runPowerAction(action) {
  if (!IS_WIN) return; // hanya didukung di Windows
  if (action === 'shutdown') execFile('shutdown', ['/s', '/t', '0']);
  if (action === 'sleep') {
    execFile('powershell', ['-NoProfile', '-Command',
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"]);
  }
}

ipcMain.handle('setAfterAll', (_e, action) => {
  if (!AFTER_ALL[action]) return;
  lastState.afterAll = action;
  if (action === 'none' && lastState.countdown) cancelCountdown();
  send();
});
ipcMain.handle('cancelCountdown', () => cancelCountdown());

// ---------- Pantau clipboard: tawarkan link unduhan yang disalin ----------

let lastClip = null;

/** Di Electron versi baru clipboard.readText() mengembalikan Promise; di versi lama langsung teks. */
async function readClipboard() {
  try {
    const t = await clipboard.readText();
    return typeof t === 'string' ? t : '';
  } catch {
    return null;
  }
}

async function startClipboardWatch() {
  lastClip = await readClipboard(); // jangan tawarkan isi clipboard lama
  let busy = false;
  setInterval(async () => {
    if (!settings.data.watchClipboard || busy) return;
    busy = true;
    try {
      const t = await readClipboard();
      if (t === null || t === lastClip) return;
      lastClip = t;
      if (!looksDownloadable(t, categoryOf, nameFromUrl)) return;
      const url = t.trim();
      if (lastState.items.some((i) => i.url === url)) return;
      lastState.offer = { url, name: nameFromUrl(url) };
      send();
      if (settings.data.notify && Notification.isSupported()) {
        const n = new Notification({ title: 'Link unduhan disalin', body: `${lastState.offer.name}\nKlik untuk mengunduh dengan Sedot.` });
        n.on('click', () => acceptOffer());
        n.show();
      }
    } finally {
      busy = false;
    }
  }, 1000);
}

function acceptOffer() {
  const o = lastState.offer;
  lastState.offer = null;
  send();
  if (o) openJobDialog({ url: o.url });
}

ipcMain.handle('acceptOffer', () => acceptOffer());
ipcMain.handle('dismissOffer', () => { lastState.offer = null; send(); });

/** Satu link dari UI (seret-lepas) lewat dialog info, supaya ukuran & nama terlihat dulu. */
ipcMain.handle('addViaDialog', (_e, url) => {
  if (typeof url === 'string' && /^(https?|ftp):\/\//i.test(url.trim())) openJobDialog({ url: url.trim() });
});

// ---------- Panel detail ----------

ipcMain.handle('detail', async (_e, gid) => {
  const it = findItem(gid);
  if (!it) return null;
  const base = {
    gid: it.gid, name: it.name, path: it.path, url: it.url, status: it.status, total: it.total, done: it.done,
    addedAt: it.addedAt || 0, doneAt: it.doneAt || 0, description: it.description || '',
    error: it.error || '', errorHint: it.errorHint || '', errorRaw: it.errorRaw || '', expired: !!it.expired,
    exists: it.path ? fs.existsSync(it.path) : false,
  };
  if (it.status === 'complete' || !aria) return base;
  try {
    const st = await aria.call('tellStatus', gid, ['bitfield', 'numPieces', 'pieceLength', 'connections']);
    const servers = it.status === 'active' ? await aria.call('getServers', gid).catch(() => []) : [];
    const opt = await aria.call('getOption', gid).catch(() => ({}));
    return {
      ...base,
      bitfield: st.bitfield || '',
      numPieces: Number(st.numPieces) || 0,
      connections: (servers[0]?.servers || []).map((sv) => ({ host: hostOf(sv.currentUri || sv.uri), speed: Number(sv.downloadSpeed) || 0 })),
      limitKB: Math.round(parseSize(opt['max-download-limit']) / 1024),
    };
  } catch {
    return base;
  }
});

function parseSize(v) {
  const m = /^(\d+(?:\.\d+)?)([KM]?)$/i.exec(String(v || '0'));
  if (!m) return 0;
  return Number(m[1]) * (m[2].toUpperCase() === 'M' ? 1048576 : m[2].toUpperCase() === 'K' ? 1024 : 1);
}

ipcMain.handle('setLimit', async (_e, { gid, kb }) => {
  if (!ids([gid]).length || !aria) return;
  kb = Math.max(0, Math.round(Number(kb) || 0));
  await aria.call('changeOption', gid, { 'max-download-limit': kb ? `${kb}K` : '0' }).catch(() => {});
});

ipcMain.handle('replaceUrl', async (_e, { gid, url }) => {
  if (!ids([gid]).length) return { error: 'Unduhan tidak valid.' };
  if (typeof url !== 'string' || !/^(https?|ftp):\/\//i.test(url.trim())) return { error: 'Link harus diawali http:// atau https://' };
  try {
    await replaceDownload(gid, { url: url.trim() });
    return { ok: true };
  } catch (e) {
    return { error: String(e.message || e) };
  }
});

ipcMain.handle('copyText', async (_e, t) => {
  if (typeof t !== 'string') return;
  lastClip = t; // salinan dari Sedot sendiri tidak perlu ditawarkan balik
  await clipboard.writeText(t);
});

// ---------- Menu klik kanan (menu asli Windows) ----------

ipcMain.handle('contextMenu', (e, items) => new Promise((resolve) => {
  if (!Array.isArray(items) || !win) return resolve(null);
  let done = false;
  const pick = (id) => { if (!done) { done = true; resolve(id); } };
  const menu = Menu.buildFromTemplate(items.map((x) => (x.sep
    ? { type: 'separator' }
    : { label: String(x.label), enabled: x.enabled !== false, accelerator: x.accel, registerAccelerator: false, click: () => pick(x.id) })));
  menu.popup({ window: BrowserWindow.fromWebContents(e.sender) || win, callback: () => setTimeout(() => pick(null), 100) });
}));

// ---------- Ekstensi browser (ikut terpasang bersama aplikasi) ----------

function extensionDir() {
  const packed = path.join(process.resourcesPath || '', 'extension');
  return app.isPackaged && fs.existsSync(packed) ? packed : path.join(__dirname, '..', 'extension');
}

ipcMain.handle('extensionInfo', () => ({ dir: extensionDir(), seen: lastState.extensionSeen }));
ipcMain.handle('openExtensionDir', () => shell.openPath(extensionDir()));
ipcMain.handle('openUrl', (_e, url) => {
  // hanya link yang memang dipakai UI (halaman rilis & panduan), bukan sembarang URL
  if (typeof url === 'string' && url.startsWith('https://github.com/zainuiqbal7/sedot')) shell.openExternal(url);
});
