'use strict';
// Penghubung tampilan <-> Rust untuk versi Tauri (pengganti preload Electron).
// Bentuk API-nya sama persis (window.sedot / window.job / window.vid), jadi src/renderer dipakai apa adanya.
(() => {
  const T = window.__TAURI__;
  const invoke = (cmd, args) => T.core.invoke(cmd, args || {});
  const on = (ev, cb) => T.event.listen(ev, (e) => cb(e.payload));
  const id = new URLSearchParams(location.search).get('id');

  // Clipboard di webview butuh izin; ambil lewat aplikasi
  try {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: () => invoke('read_clipboard'), writeText: (t) => invoke('copy_text', { text: t }) }, configurable: true });
  } catch { /* biarkan bawaan */ }

  window.sedot = {
    state: () => invoke('state'),
    categories: () => invoke('categories'),
    onState: (cb) => on('state', cb),
    add: (urls, dir) => invoke('add', { urls, dir: dir || null }),
    addViaDialog: (url) => invoke('add_via_dialog', { url }),
    pause: (gids) => invoke('pause', { gids }),
    resume: (gids) => invoke('resume', { gids }),
    pauseAll: () => invoke('pause_all'),
    resumeAll: () => invoke('resume_all'),
    remove: (gids, deleteFiles) => invoke('remove', { gids, deleteFiles: !!deleteFiles }),
    open: (gid) => invoke('open_item', { gid }),
    reveal: (gid) => invoke('reveal', { gid }),
    getSettings: () => invoke('get_settings'),
    setSettings: (s) => invoke('set_settings', { s }),
    chooseDir: () => invoke('choose_dir', { current: null }),
    version: () => invoke('version'),
    installUpdate: () => invoke('install_update'),
    detail: (gid) => invoke('detail', { gid }),
    setLimit: (gid, kb) => invoke('set_limit', { gid, kb: Number(kb) || 0 }),
    replaceUrl: (gid, url) => invoke('replace_url', { gid, url }),
    copyText: (text) => invoke('copy_text', { text }),
    contextMenu: (items) => invoke('context_menu', { items }),
    setAfterAll: (action) => invoke('set_after_all', { action }),
    cancelCountdown: () => invoke('cancel_countdown'),
    acceptOffer: () => invoke('accept_offer'),
    dismissOffer: () => invoke('dismiss_offer'),
    extensionInfo: () => invoke('extension_info'),
    openExtensionDir: () => invoke('open_extension_dir'),
    openUrl: (url) => invoke('open_url', { url }),
  };

  // Jendela "Info unduhan"
  window.job = {
    get: () => invoke('job_get', { id }),
    onUpdate: (cb) => on(`job-update-${id}`, cb),
    chooseDir: (current) => invoke('choose_dir', { current: current || null }),
    decide: (d) => invoke('job_decide', { id, d }),
    reveal: () => invoke('job_reveal', { id }),
    resize: (h) => invoke('fit_window', { h: Math.ceil(h) }),
  };

  // Jendela "Unduh video" (Tahap 3)
  window.vid = {
    get: () => invoke('video_get', { id }),
    onUpdate: (cb) => on(`video-update-${id}`, cb),
    retry: () => invoke('video_retry', { id }),
    chooseDir: (current) => invoke('choose_dir', { current: current || null }),
    decide: (d) => invoke('video_decide', { id, d }),
    resize: (h) => invoke('fit_window', { h: Math.ceil(h) }),
  };
})();
