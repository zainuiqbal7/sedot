'use strict';
// Penyimpanan JSON sederhana untuk pengaturan dan riwayat unduhan yang sudah selesai.

const fs = require('node:fs');
const path = require('node:path');

class JsonFile {
  constructor(file, defaults) {
    this.file = file;
    this.data = structuredClone(defaults);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(defaults)) { if (Array.isArray(raw)) this.data = raw; }
      else this.data = { ...this.data, ...raw };
    } catch { /* pertama kali / rusak: pakai bawaan */ }
    this.timer = null;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file); // tulis atomik supaya file tidak rusak kalau listrik mati
  }
}

module.exports = { JsonFile };
