'use strict';
// Pengelola unduhan video: satu "job" = 1–2 bagian (gambar + suara) yang diunduh aria2,
// lalu digabung ffmpeg. Di daftar unduhan, satu job tampil sebagai SATU baris.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildChoices, mergeArgs, ffmpeg, cookieHeaderFrom } = require('./video');

const TEMP = '.sedot-sementara';

class VideoJobs {
  /**
   * @param {object} d
   * @param {import('./store').JsonFile} d.store   penyimpanan job (videos.json)
   * @param {import('./store').JsonFile} d.meta    meta per gid aria2 (dipakai bersama main.js)
   * @param {() => any} d.getAria
   * @param {() => string|null} d.ffmpegPath
   * @param {(url: string, cookies?: object[]) => Promise<object>} d.probe  info mentah yt-dlp
   * @param {(job: object, finalPath: string, size: number) => void} d.onDone
   * @param {() => void} d.changed
   * @param {(p: string) => string} d.uniquePath
   */
  constructor(d) {
    Object.assign(this, d);
    this.merging = new Set();
  }

  get jobs() { return this.store.data; }
  get(id) { return this.jobs[id] || null; }
  isPart(gid) { return !!this.meta.data[gid]?.group; }
  save() { this.store.save(); this.meta.save(); }
  tempDir(job) { return path.join(job.dir, TEMP, job.id); }

  /** Job belum selesai untuk video yang sama (untuk ditawarkan "lanjutkan"). */
  findUnfinished(key) {
    return Object.values(this.jobs).find((j) => j.key === key) || null;
  }

  async create({ raw, choiceId, title, dir, subs = [], paused = false, description = '', connections = 8 }) {
    const aria = this.getAria();
    if (!aria) throw new Error('Mesin unduhan belum siap.');
    const data = buildChoices(raw);
    const choice = data.choices.find((c) => c.id === choiceId);
    if (!choice) throw new Error('Pilihan kualitas tidak ditemukan. Tutup dialog lalu coba lagi.');

    const id = crypto.randomBytes(8).toString('hex');
    const job = {
      id,
      key: data.key,
      title: data.title,
      uploader: data.uploader,
      outName: title,
      ext: choice.out,
      mode: choice.kind === 'audio' ? choice.id : 'video',
      label: choice.label,
      dir,
      pageUrl: data.pageUrl,
      site: data.site,
      addedAt: Date.now(),
      description,
      status: 'downloading',
      error: null,
      parts: [],
      subs: data.subtitles.filter((s) => subs.includes(s.lang)).map(({ lang, url, ext }) => ({ lang, url, ext })),
    };
    const tmp = this.tempDir(job);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      for (const p of choice.parts) {
        const gid = await aria.add(p.url, { dir: tmp, out: `${p.kind}.${p.ext}`, headers: p.headers, paused, connections });
        this.meta.data[gid] = { group: id, addedAt: job.addedAt };
        job.parts.push({ gid, kind: p.kind, formatId: p.formatId, ext: p.ext, complete: false, total: p.size || 0 });
      }
    } catch (e) {
      for (const p of job.parts) await aria.call('forceRemove', p.gid).catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    this.jobs[id] = job;
    this.save();
    this.changed();
    return id;
  }

  /**
   * Dipanggil tiap polling dengan peta gid -> item aria2. Mengembalikan baris-baris video untuk daftar.
   * Sekalian: mencatat bagian yang selesai, dan memulai penggabungan saat semua bagian sudah lengkap.
   */
  compose(live) {
    const aria = this.getAria();
    const items = [];
    for (const job of Object.values(this.jobs)) {
      const states = job.parts.map((p) => {
        if (p.complete) return { status: 'complete', total: p.total, done: p.total, speed: 0, connections: 0 };
        const it = live.get(p.gid);
        if (it?.status === 'complete') {
          p.complete = true;
          p.total = it.total;
          p.path = it.path;
          this.save();
          aria?.call('removeDownloadResult', p.gid).catch(() => {});
          return { status: 'complete', total: it.total, done: it.total, speed: 0, connections: 0 };
        }
        return it || { status: 'missing', total: p.total, done: 0, speed: 0, connections: 0 };
      });

      let status;
      let err = null;
      if (job.status === 'merging') status = 'merging';
      else if (job.status === 'error') { status = 'error'; err = job.error; }
      else if (states.every((s) => s.status === 'complete')) {
        status = 'merging';
        this.merge(job);
      } else {
        const bad = states.find((s) => s.status === 'error' || s.status === 'missing' || s.status === 'removed');
        if (bad) {
          status = 'error';
          err = bad.expired || bad.status !== 'error'
            ? { text: 'Link kedaluwarsa', hint: 'Klik Coba lagi: Sedot akan mengambil link baru otomatis dan melanjutkan dari posisi terakhir.', expired: true }
            : { text: bad.error || 'Gagal', hint: bad.errorHint || 'Klik Coba lagi.' };
          if (bad.errorRaw) err.raw = bad.errorRaw;
        } else if (states.some((s) => s.status === 'active')) status = 'active';
        else if (states.some((s) => s.status === 'waiting')) status = 'waiting';
        else status = 'paused';
      }

      items.push({
        gid: job.id,
        isVideo: true,
        name: `${job.outName}.${job.ext}`,
        path: '',
        dir: job.dir,
        url: job.pageUrl,
        status,
        total: states.reduce((a, s) => a + (s.total || 0), 0),
        done: states.reduce((a, s) => a + (s.done || 0), 0),
        speed: states.reduce((a, s) => a + (s.speed || 0), 0),
        connections: states.reduce((a, s) => a + (s.connections || 0), 0),
        category: job.mode === 'video' ? 'Video' : 'Musik',
        addedAt: job.addedAt,
        description: job.description || '',
        ...(err ? { error: err.text, errorHint: err.hint, expired: !!err.expired, errorRaw: err.raw || '' } : {}),
        partsInfo: job.parts.map((p, i) => ({
          label: p.kind === 'video' ? `Gambar ${job.label}` : p.kind === 'audio' ? 'Suara' : `Video ${job.label}`,
          pct: states[i].total ? Math.floor((states[i].done / states[i].total) * 100) : 0,
          speed: states[i].speed || 0,
          status: states[i].status,
        })),
      });
    }
    return items;
  }

  async merge(job) {
    if (this.merging.has(job.id)) return;
    this.merging.add(job.id);
    job.status = 'merging';
    job.error = null;
    this.save();
    this.changed();
    try {
      const ff = this.ffmpegPath();
      if (!ff) throw new Error('ffmpeg tidak ditemukan');
      const order = { video: 0, single: 0, audio: 1 };
      const inputs = [...job.parts].sort((a, b) => order[a.kind] - order[b.kind]).map((p) => p.path);
      for (const f of inputs) if (!f || !fs.existsSync(f)) throw new Error('bagian unduhan hilang dari disk');

      let out = this.uniquePath(path.join(job.dir, `${job.outName}.${job.ext}`));
      try {
        await ffmpeg(ff, mergeArgs({ mode: job.mode, inputs, out, title: job.title, artist: job.uploader }));
      } catch (e) {
        if (job.mode !== 'video') throw e;
        // Kombinasi codec yang tidak muat di MP4: pakai MKV (diputar oleh VLC, MPC, dll.)
        fs.rmSync(out, { force: true });
        out = this.uniquePath(path.join(job.dir, `${job.outName}.mkv`));
        await ffmpeg(ff, mergeArgs({ mode: job.mode, inputs, out, title: job.title, artist: job.uploader }));
      }
      await this.saveSubtitles(job, out, ff);
      fs.rmSync(this.tempDir(job), { recursive: true, force: true });
      try { fs.rmdirSync(path.join(job.dir, TEMP)); } catch { /* masih ada job lain */ }
      for (const p of job.parts) delete this.meta.data[p.gid];
      delete this.jobs[job.id];
      this.save();
      this.onDone(job, out, fs.statSync(out).size);
    } catch (e) {
      job.status = 'error';
      job.error = { text: 'Gagal menggabungkan', hint: `${e.message || e}. Klik Coba lagi untuk mengulang penggabungan.`, merge: true };
      this.save();
    } finally {
      this.merging.delete(job.id);
      this.changed();
    }
  }

  async saveSubtitles(job, out, ff) {
    const base = out.replace(/\.[^.\\/]+$/, '');
    for (const s of job.subs || []) {
      try {
        const res = await fetch(s.url);
        if (!res.ok) continue;
        const lang = s.lang.replace(/-orig$/, '').replace(/[^\w-]/g, '');
        const raw = `${base}.${lang}.${s.ext}`;
        fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
        if (s.ext !== 'srt') {
          try {
            await ffmpeg(ff, ['-i', raw, `${base}.${lang}.srt`]); // .srt dibaca hampir semua pemutar
            fs.rmSync(raw, { force: true });
          } catch { /* biarkan format aslinya */ }
        }
      } catch { /* subtitle opsional: jangan gagalkan unduhan */ }
    }
  }

  async pause(id) {
    const aria = this.getAria();
    const job = this.get(id);
    if (!job || !aria) return;
    for (const p of job.parts) if (!p.complete) await aria.call('pause', p.gid).catch(() => {});
  }

  /** Lanjutkan; bagian yang gagal/kedaluwarsa diambilkan link baru lewat yt-dlp. */
  async resume(id, cookies) {
    const aria = this.getAria();
    const job = this.get(id);
    if (!job || !aria) return;
    if (job.status === 'error' && job.error?.merge) {
      job.status = 'downloading';
      job.error = null;
      this.save();
      return;
    }
    const need = [];
    for (const p of job.parts) {
      if (p.complete) continue;
      let st = null;
      try { st = (await aria.call('tellStatus', p.gid, ['status'])).status; } catch { /* gid hilang */ }
      if (st === 'paused') await aria.call('unpause', p.gid).catch(() => {});
      else if (!st || st === 'error' || st === 'removed') need.push(p);
    }
    if (need.length) await this.refresh(job, need, cookies);
  }

  async refresh(job, parts, cookies) {
    const aria = this.getAria();
    let raw;
    try {
      raw = await this.probe(job.pageUrl, cookies);
    } catch (e) {
      job.status = 'error';
      job.error = { text: 'Gagal mengambil link baru', hint: `${e.message} Buka lagi videonya di browser lalu klik Unduh video: Sedot akan menawarkan untuk melanjutkan.` };
      this.save();
      this.changed();
      throw e;
    }
    const formats = new Map((raw.formats || []).map((f) => [String(f.format_id), f]));
    for (const p of parts) {
      const f = formats.get(p.formatId);
      if (!f?.url) {
        job.status = 'error';
        job.error = { text: 'Kualitas ini tidak tersedia lagi', hint: 'Hapus unduhan ini lalu unduh ulang dengan kualitas lain.' };
        this.save();
        this.changed();
        throw new Error(job.error.text);
      }
      await aria.call('forceRemove', p.gid).catch(() => {});
      await waitGone(aria, p.gid);
      await aria.call('removeDownloadResult', p.gid).catch(() => {});
      delete this.meta.data[p.gid];
      const headers = Object.entries(f.http_headers || {}).map(([k, v]) => `${k}: ${v}`);
      const cookie = cookieHeaderFrom(f.cookies);
      if (cookie) headers.push(`Cookie: ${cookie}`);
      // folder + nama sama => aria2 melanjutkan dari file .aria2 yang sudah ada
      p.gid = await aria.add(f.url, { dir: this.tempDir(job), out: `${p.kind}.${p.ext}`, headers, connections: 8 });
      this.meta.data[p.gid] = { group: job.id, addedAt: job.addedAt };
    }
    job.status = 'downloading';
    job.error = null;
    this.save();
    this.changed();
  }

  async remove(id) {
    const aria = this.getAria();
    const job = this.get(id);
    if (!job) return;
    for (const p of job.parts) {
      if (!p.complete && aria) {
        await aria.call('forceRemove', p.gid).catch(() => {});
        await waitGone(aria, p.gid);
      }
      await aria?.call('removeDownloadResult', p.gid).catch(() => {});
      delete this.meta.data[p.gid];
    }
    // Bagian sementara tidak berguna tanpa job-nya: selalu dibersihkan
    fs.rmSync(this.tempDir(job), { recursive: true, force: true });
    try { fs.rmdirSync(path.join(job.dir, TEMP)); } catch { /* masih dipakai */ }
    delete this.jobs[id];
    this.save();
    this.changed();
  }

  async setLimit(id, kb) {
    const aria = this.getAria();
    const job = this.get(id);
    if (!job || !aria) return;
    const each = kb ? Math.max(1, Math.round(kb / job.parts.filter((p) => !p.complete).length || 1)) : 0;
    for (const p of job.parts) if (!p.complete) await aria.call('changeOption', p.gid, { 'max-download-limit': each ? `${each}K` : '0' }).catch(() => {});
  }
}

async function waitGone(aria, gid) {
  for (let i = 0; i < 20; i++) {
    try {
      const s = await aria.call('tellStatus', gid, ['status']);
      if (['removed', 'complete', 'error'].includes(s.status)) return;
    } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
}

module.exports = { VideoJobs, TEMP };
