'use strict';
// Membuat ikon PNG (kotak teal + panah bawah) tanpa dependensi apa pun.
// Jalankan: node scripts/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function inside(x, y) {
  // koordinat 0..1
  const r = 0.22, m = 0.04;
  const cx = Math.min(Math.max(x, m + r), 1 - m - r), cy = Math.min(Math.max(y, m + r), 1 - m - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return 0; // di luar kotak bulat
  const shaft = Math.abs(x - 0.5) < 0.075 && y > 0.2 && y < 0.56;
  const head = y >= 0.44 && y <= 0.7 && Math.abs(x - 0.5) <= (0.7 - y) * 1.05;
  const tray = y > 0.76 && y < 0.84 && x > 0.24 && x < 0.76;
  return shaft || head || tray ? 2 : 1;
}

function png(size) {
  const S = 4; // supersampling untuk tepi halus
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const v = inside((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
        if (v === 1) bg++; else if (v === 2) fg++;
      }
      const n = S * S, a = (bg + fg) / n;
      const t = bg + fg ? fg / (bg + fg) : 0;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(15 + (255 - 15) * t);
      raw[o + 1] = Math.round(118 + (255 - 118) * t);
      raw[o + 2] = Math.round(110 + (255 - 110) * t);
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.mkdirSync(path.join(root, 'extension', 'icons'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), png(256));
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(root, 'extension', 'icons', `${s}.png`), png(s));
console.log('ikon dibuat');
