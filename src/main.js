'use strict';
// Proses utama Electron: menyalakan aria2, menyimpan riwayat, tray, dan menjembatani UI.

const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

const { Aria2 } = require('./aria2');
const { startBridge } = require('./bridge');
const { JsonFile } = require('./store');
const { categoryOf, nameFromUrl, CATEGORIES } = require('./categories');
const { probe } = require('./probe');

const IS_WIN = process.platform === 'win32';
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

let win = null;
let tray = null;
let aria = null;
let settings = null;
let history = null;
let meta = null; // gid -> { description, keepPlace } untuk unduhan yang belum selesai
let quitting = false;
let pollTimer = null;
let lastState = { items: [], stat: {}, bridge: 'off', engineError: null };
const finalizing = new Set();

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
  });
  history = new JsonFile(path.join(userData, 'history.json'), []);
  meta = new JsonFile(path.join(userData, 'meta.json'), {});

  createWindow();
  createTray();

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
    await startBridge({ version: app.getVersion(), onAdd: (job) => (settings.data.askBeforeDownload ? openJobDialog(job) : addJob(job, true)) });
    lastState.bridge = 'on';
  } catch (e) {
    lastState.bridge = e.code === 'EADDRINUSE' ? 'port-in-use' : 'error';
  }

  pollTimer = setInterval(poll, 1000);
  poll();
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

function createWindow() {
  win = new BrowserWindow({
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
  app.exit(0);
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
  if (job.description || job.keepPlace) {
    meta.data[gid] = { description: job.description || '', keepPlace: !!job.keepPlace };
    meta.save();
  }
  if (fromBrowser && settings.data.notify && Notification.isSupported()) {
    new Notification({ title: 'Sedot mengambil alih unduhan', body: job.filename || nameFromUrl(job.url) || job.url }).show();
  }
  poll();
  return gid;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
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
    error: s.errorMessage || '',
    description: meta.data[s.gid]?.description || '',
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
      const dir = it.path ? path.dirname(it.path) : undefined;
      await addJob({ url: it.url, dir, filename: it.path ? path.basename(it.path) : undefined }).catch(() => {});
      await aria?.call('removeDownloadResult', g).catch(() => {});
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
  for (const k of ['categorize', 'minimizeToTray', 'notify', 'askBeforeDownload']) if (typeof s[k] === 'boolean') d[k] = s[k];
  settings.save();
  await aria?.applyOptions(d).catch(() => {});
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

ipcMain.handle('job:decide', async (e, d) => {
  const entry = jobFor(e, d?.id);
  if (!entry) return { error: 'Dialog sudah tidak berlaku.' };
  if (d.action === 'cancel') { entry.win.close(); return { ok: true }; }

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
