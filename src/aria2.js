'use strict';
// Menjalankan aria2c sebagai proses latar dan berbicara dengannya lewat JSON-RPC.
// File ini sengaja tidak bergantung pada Electron supaya bisa diuji dengan Node biasa.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');

const STATUS_KEYS = [
  'gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed',
  'connections', 'files', 'dir', 'errorCode', 'errorMessage',
];

class Aria2 {
  /**
   * @param {object} o
   * @param {string} o.binPath      lokasi aria2c / aria2c.exe
   * @param {number} o.port         port RPC (hanya 127.0.0.1)
   * @param {string} o.sessionFile  file untuk menyimpan antrean agar bisa dilanjut setelah restart
   * @param {string} o.downloadDir  folder unduhan bawaan
   * @param {object} [o.options]    opsi aria2 tambahan (connections, maxConcurrent, speedLimit)
   */
  constructor(o) {
    this.binPath = o.binPath;
    this.port = o.port;
    this.sessionFile = o.sessionFile;
    this.downloadDir = o.downloadDir;
    this.options = o.options || {};
    this.secret = crypto.randomBytes(16).toString('hex');
    this.proc = null;
    this.nextId = 1;
  }

  buildArgs() {
    const conn = clamp(this.options.connections ?? 16, 1, 16);
    const args = [
      '--enable-rpc=true',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${this.port}`,
      `--rpc-secret=${this.secret}`,
      `--dir=${this.downloadDir}`,
      '--continue=true',
      `--max-connection-per-server=${conn}`,
      `--split=${conn}`,
      '--min-split-size=1M',
      `--max-concurrent-downloads=${clamp(this.options.maxConcurrent ?? 3, 1, 20)}`,
      `--max-overall-download-limit=${speedLimitArg(this.options.speedLimitKB)}`,
      '--auto-file-renaming=true',
      '--allow-overwrite=false',
      '--file-allocation=none',
      '--disk-cache=32M',
      '--retry-wait=3',
      '--max-tries=5',
      '--console-log-level=warn',
      '--summary-interval=0',
      `--save-session=${this.sessionFile}`,
      '--save-session-interval=5',
      `--stop-with-process=${process.pid}`, // aria2 ikut mati kalau aplikasi crash
    ];
    if (fs.existsSync(this.sessionFile)) args.push(`--input-file=${this.sessionFile}`);
    return args;
  }

  async start() {
    if (!fs.existsSync(this.binPath)) {
      throw new Error(`aria2c tidak ditemukan di: ${this.binPath}`);
    }
    this.proc = spawn(this.binPath, this.buildArgs(), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    this.proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const exited = new Promise((resolve) => this.proc.once('exit', (code) => resolve(code)));

    // Tunggu sampai RPC siap (maks ~5 detik).
    for (let i = 0; i < 50; i++) {
      const done = await Promise.race([exited.then((c) => ({ exited: c })), sleep(100)]);
      if (done && 'exited' in done) throw new Error(`aria2c berhenti (kode ${done.exited}): ${stderr.trim()}`);
      try { await this.call('getVersion'); return; } catch { /* belum siap */ }
    }
    throw new Error('aria2c tidak merespons RPC dalam 5 detik');
  }

  async stop() {
    if (!this.proc) return;
    try {
      await this.call('saveSession'); // antrean sudah aman tersimpan, jadi boleh langsung dimatikan
      await this.call('forceShutdown');
    } catch { /* abaikan */ }
    const p = this.proc;
    this.proc = null;
    if (p.exitCode !== null) return;
    await Promise.race([new Promise((r) => p.once('exit', r)), sleep(1500)]);
    if (p.exitCode === null) p.kill();
  }

  async call(method, ...params) {
    return this.rawCall(`aria2.${method}`, [`token:${this.secret}`, ...params]);
  }

  async rawCall(method, params) {
    const res = await fetch(`http://127.0.0.1:${this.port}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: String(this.nextId++), method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || 'aria2 error');
    return body.result;
  }

  /** Satu panggilan untuk semua status, supaya polling tiap detik tetap ringan. */
  async snapshot() {
    const tok = `token:${this.secret}`;
    const calls = [
      { methodName: 'aria2.tellActive', params: [tok, STATUS_KEYS] },
      { methodName: 'aria2.tellWaiting', params: [tok, 0, 1000, STATUS_KEYS] },
      { methodName: 'aria2.tellStopped', params: [tok, 0, 1000, STATUS_KEYS] },
      { methodName: 'aria2.getGlobalStat', params: [tok] },
    ];
    const r = await this.rawCall('system.multicall', [calls]);
    for (const x of r) if (!Array.isArray(x)) throw new Error(x.message || 'multicall gagal');
    const [[active], [waiting], [stopped], [stat]] = r;
    return { items: [...active, ...waiting, ...stopped], stat };
  }

  /**
   * @param {string} url
   * @param {object} [o] { dir, out, referer, cookie, userAgent }
   */
  add(url, o = {}) {
    const opts = {};
    if (o.dir) opts.dir = o.dir;
    if (o.out) opts.out = sanitizeFilename(o.out);
    if (o.referer) opts.referer = o.referer;
    if (o.userAgent) opts['user-agent'] = o.userAgent;
    const headers = [];
    if (o.cookie) headers.push(`Cookie: ${o.cookie.replace(/[\r\n]/g, '')}`);
    if (headers.length) opts.header = headers;
    return this.call('addUri', [url], opts);
  }

  applyOptions(o) {
    this.options = { ...this.options, ...o };
    const conn = String(clamp(this.options.connections ?? 16, 1, 16));
    return this.call('changeGlobalOption', {
      'max-connection-per-server': conn,
      split: conn,
      'max-concurrent-downloads': String(clamp(this.options.maxConcurrent ?? 3, 1, 20)),
      'max-overall-download-limit': speedLimitArg(this.options.speedLimitKB),
    });
  }
}

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function speedLimitArg(kb) {
  kb = Number(kb);
  return Number.isFinite(kb) && kb > 0 ? `${Math.round(kb)}K` : '0';
}

/** Hilangkan karakter yang tidak boleh ada di nama file Windows dan cegah path traversal. */
function sanitizeFilename(name) {
  let s = String(name).split(/[\\/]/).pop() || '';
  s = s.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  return s.slice(0, 200) || 'unduhan';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { Aria2, sanitizeFilename };
