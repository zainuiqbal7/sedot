'use strict';
// Server kecil di 127.0.0.1 yang menerima link dari ekstensi browser.
//
// Keamanan: server ini hanya mendengar di loopback, dan HANYA menerima permintaan
// dari ekstensi browser (Origin chrome-extension:// atau moz-extension://) atau tanpa
// Origin sama sekali (program lokal). Halaman web biasa selalu mengirim Origin http(s)://,
// jadi website jahat tidak bisa menyuruh aplikasi ini mengunduh sesuatu.

const http = require('node:http');

const BRIDGE_PORT = 17345;
const MAX_BODY = 64 * 1024;

function originAllowed(origin) {
  if (origin === undefined) return true;
  return /^(chrome-extension|moz-extension|extension):\/\/[a-z0-9-]+\/?$/i.test(origin);
}

/**
 * @param {object} o
 * @param {(job: object) => Promise<string>} o.onAdd  dipanggil dengan {url, filename, referer, cookie, userAgent}
 * @param {string} o.version
 * @param {number} [o.port]
 */
function startBridge({ onAdd, version, port = BRIDGE_PORT }) {
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) return send(res, 403, { ok: false, error: 'origin ditolak' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    }
    if (req.method === 'OPTIONS') return send(res, 204);

    if (req.method === 'GET' && req.url === '/ping') {
      return send(res, 200, { ok: true, app: 'Sedot', version });
    }

    if (req.method === 'POST' && req.url === '/add') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return send(res, 415, { ok: false, error: 'harus application/json' });
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return send(res, 400, { ok: false, error: 'JSON tidak valid' });
      }
      const url = String(body?.url || '');
      if (!/^(https?|ftp):\/\//i.test(url)) return send(res, 400, { ok: false, error: 'URL harus http, https, atau ftp' });
      try {
        const gid = await onAdd({
          url,
          filename: str(body.filename),
          referer: str(body.referer),
          cookie: str(body.cookie),
          userAgent: str(body.userAgent),
        });
        return send(res, 200, { ok: true, gid });
      } catch (e) {
        return send(res, 500, { ok: false, error: String(e.message || e) });
      }
    }

    send(res, 404, { ok: false, error: 'tidak ditemukan' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function str(v) { return typeof v === 'string' && v.length < 16384 ? v : undefined; }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  if (obj === undefined) { res.writeHead(code); return res.end(); }
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

module.exports = { startBridge, BRIDGE_PORT, originAllowed };
