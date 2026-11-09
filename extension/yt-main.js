'use strict';
// Berjalan di "dunia" halaman YouTube (MAIN world) supaya bisa membaca data pemutar:
// daftar kualitas + ukuran file yang SUDAH dimuat YouTube. Hanya membaca, tidak mengubah apa pun.
// Hasilnya dikirim ke yt.js (dunia ekstensi) lewat postMessage.
(() => {
  const QL = { hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240, tiny: 144 };

  function player() {
    return document.querySelector('ytd-reel-video-renderer[is-active] #shorts-player')
      || document.querySelector('ytd-reel-video-renderer[is-active] .html5-video-player')
      || document.getElementById('movie_player');
  }

  function read() {
    const p = player();
    let pr = null;
    try { pr = p?.getPlayerResponse?.() || null; } catch { /* API pemutar berubah */ }
    if (!pr && window.ytInitialPlayerResponse) pr = window.ytInitialPlayerResponse;
    const vd = pr?.videoDetails || {};
    const sd = pr?.streamingData || {};
    const formats = [...(sd.adaptiveFormats || []), ...(sd.formats || [])].map((f) => ({
      itag: f.itag,
      mime: String(f.mimeType || ''),
      height: Number(f.height) || 0,
      fps: Number(f.fps) || 0,
      size: Number(f.contentLength) || 0,
      bitrate: Number(f.bitrate) || 0,
    }));
    let levels = [];
    try { levels = (p?.getAvailableQualityLevels?.() || []).map((q) => QL[q]).filter(Boolean); } catch { /* tidak ada */ }
    return {
      videoId: vd.videoId || '',
      title: vd.title || '',
      seconds: Number(vd.lengthSeconds) || 0,
      isLive: !!vd.isLive,
      formats,
      levels,
    };
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'sedot-ext' || e.data.type !== 'formats-req') return;
    let data = null;
    try { data = read(); } catch { /* biarkan null: yt.js memakai cadangan */ }
    window.postMessage({ source: 'sedot-page', type: 'formats-res', id: e.data.id, data }, '*');
  });
})();
