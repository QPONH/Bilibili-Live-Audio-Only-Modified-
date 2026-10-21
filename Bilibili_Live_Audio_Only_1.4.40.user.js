// ==UserScript==
// @name         Bilibili Live Audio Only 1.4.40
// @name:zh-CN   哔哩哔哩直播纯音频模式 1.4.40
// @namespace    https://bilibili-live-audio-only.userscript.local/
// @version      1.4.40
// @description  Audio-only Bilibili live (bandwidth saving). Floating panel only, stream refresh, volume, screenshots, traffic, flv.js CDN fallbacks.
// @description:zh-CN 哔哩哔哩直播纯音频（省流量）。仅悬浮窗、流刷新、音量、内存截图、流量；flv.js 多 CDN 回退。
// @author       天冰致琴
// @license      MIT
// @match        https://live.bilibili.com/*
// @require      https://cdn.jsdelivr.net/npm/flv.js@1.6.2/dist/flv.min.js
// @run-at       document-end
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        unsafeWindow
// @noframes
// @compatible   chrome
// @compatible   edge
// ==/UserScript==

(() => {
  'use strict';

  // 目标：只拉音频流，停掉原生视频，降低带宽。
  const CONFIG_DEFAULTS = {
    apiTimeoutMs: 10000,
    playerWaitMs: 6000,
    bufferTimeoutMs: 12000,
    mediaInitTimeoutMs: 4000,
    screenshotFrameTimeoutMs: 10000,
    screenshotLoadTimeoutMs: 30000,
    reconnectDelayMs: 3000,
    watchdogMs: 1500,
    refreshStreamMs: 45 * 60 * 1000,
    maxReconnects: 8,
    flvjsWaitMs: 20000,
  };
  const CONFIG = {};
  for (const [k, fb] of Object.entries(CONFIG_DEFAULTS)) {
    const v = Number(GM_getValue(`wait_${k}`, fb));
    CONFIG[k] = Number.isFinite(v) && v >= 500 && v <= 300000 ? v : fb;
  }
  const saveWait = (k, v) => {
    const n = Math.max(500, Math.min(300000, Math.round(Number(v))));
    if (!Number.isFinite(n)) return false;
    CONFIG[k] = n;
    GM_setValue(`wait_${k}`, n);
    return true;
  };

  const state = {
    roomId: getRoomId(),
    enabled: false,
    connecting: false,
    waitingGesture: false,
    userPaused: false,
    mediaElement: null,
    flvPlayer: null,
    pipelineGeneration: null,
    livePlayer: null,
    nativeStopped: false,
    volume: 1,
    muted: false,
    coverUrl: '',
    watchdogTimer: null,
    refreshTimer: null,
    reconnectTimer: null,
    reconnectCount: 0,
    generation: 0,
    buttonVisible: Boolean(GM_getValue('pageButtonVisible', true)),
    autoStartAudioOnly: Boolean(GM_getValue('autoStartAudioOnly', false)),
    panelMinimized: Boolean(GM_getValue('panelMinimized', false)),
    panelLeft: Number(GM_getValue('panelLeft', NaN)),
    panelTop: Number(GM_getValue('panelTop', NaN)),
    panelDrag: null,
    ignoreMinimizedClick: false,
    screenshotBusy: false,
    trafficSpeedKBps: null,
    trafficMonitorTimer: null,
  };
  if (!state.roomId) return;

  const log = (level, msg, data) => {
    let line = `[BLAO] ${msg}`;
    if (data !== undefined) {
      try {
        line += ` ${JSON.stringify(data instanceof Error ? { name: data.name, message: data.message } : data)}`;
      } catch { line += ` ${String(data)}`; }
    }
    (console[level] || console.log).call(console, line);
  };
  log('info', '脚本已加载', { version: '1.4.40', roomId: state.roomId });

  function getRoomId() {
    const m = location.pathname.match(/^\/(?:blanc\/)?(\d+)(?:\/|$)/);
    return m ? m[1] : '';
  }
  function getLivePlayer() {
    return (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).livePlayer || null;
  }
  function getNativeVideo() {
    return document.querySelector('#live-player video');
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---- flv.js（省流核心依赖）----
  const FLV_CDNS = [
    'https://cdn.jsdelivr.net/npm/flv.js@1.6.2/dist/flv.min.js',
    'https://unpkg.com/flv.js@1.6.2/dist/flv.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/flv.js/1.6.2/flv.min.js',
    'https://cdn.bootcdn.net/ajax/libs/flv.js/1.6.2/flv.min.js',
    'https://cdn.staticfile.net/flv.js/1.6.2/flv.min.js',
  ];
  function getFlvjs() {
    if (window.flvjs?.createPlayer) return window.flvjs;
    try {
      const pw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : null;
      if (pw?.flvjs?.createPlayer) { window.flvjs = pw.flvjs; return window.flvjs; }
    } catch {}
    return null;
  }
  function loadScript(src, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const exist = document.querySelector(`script[data-blao-flvjs][src="${src}"]`);
      if (exist) {
        setTimeout(() => getFlvjs() ? resolve(getFlvjs()) : reject(new Error(`已有标签但未就绪: ${src}`)), 2000);
        return;
      }
      const s = document.createElement('script');
      s.src = src; s.async = true; s.dataset.blaoFlvjs = '1';
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; s.remove(); reject(new Error(`超时: ${src}`)); } }, timeoutMs);
      s.onload = () => setTimeout(() => {
        if (done) return;
        const api = getFlvjs();
        if (api) { done = true; clearTimeout(t); resolve(api); }
        else { done = true; clearTimeout(t); s.remove(); reject(new Error(`无全局对象: ${src}`)); }
      }, 50);
      s.onerror = () => { if (!done) { done = true; clearTimeout(t); s.remove(); reject(new Error(`失败: ${src}`)); } };
      (document.head || document.documentElement).appendChild(s);
    });
  }
  let flvPromise = null;
  async function ensureFlvjs(timeoutMs = CONFIG.flvjsWaitMs) {
    const cur = getFlvjs();
    if (cur) return cur;
    if (flvPromise) return flvPromise;
    flvPromise = (async () => {
      const deadline = Date.now() + timeoutMs;
      const end = Date.now() + Math.min(2500, timeoutMs);
      while (Date.now() < end) {
        const a = getFlvjs();
        if (a) { log('info', 'flv.js 来自 @require'); return a; }
        await sleep(80);
      }
      const errs = [];
      for (const src of FLV_CDNS) {
        if (Date.now() >= deadline) break;
        try {
          log('info', '动态加载 flv.js', { src });
          const api = await loadScript(src, Math.min(10000, deadline - Date.now()));
          log('info', 'flv.js 加载成功', { src });
          return api;
        } catch (e) {
          errs.push(e?.message || String(e));
          log('warn', 'CDN 失败', { src, message: e?.message });
        }
      }
      flvPromise = null;
      throw new Error(`flv.js 未加载。${errs.slice(-2).join(' | ')}`);
    })();
    try { return await flvPromise; } catch (e) { flvPromise = null; throw e; }
  }

  // ---- API / 播放器 ----
  async function waitForLivePlayer() {
    const deadline = Date.now() + CONFIG.playerWaitMs;
    while (Date.now() < deadline) {
      const p = getLivePlayer();
      if (p?.stopPlayback) return p;
      await sleep(100);
    }
    const p = getLivePlayer();
    if (p?.stopPlayback) return p;
    throw new Error('B站播放器尚未就绪，请稍后再试');
  }
  async function fetchWithTimeout(url, opts = {}, ms = CONFIG.apiTimeoutMs) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try { return await fetch(url, { ...opts, signal: c.signal }); }
    catch (e) {
      if (e?.name === 'AbortError') throw new Error(`请求超时（${Math.round(ms / 1000)} 秒）`);
      throw e;
    } finally { clearTimeout(t); }
  }
  function buildAudioApiUrl(roomId) {
    const p = new URLSearchParams({
      appkey: 'iVGUTjsxvpLeuDCf', build: '6215200', c_locale: 'zh_CN', channel: 'bili',
      codec: '0', device: 'android', device_name: 'VTR-AL00', dolby: '1', format: '0,2',
      free_type: '0', http: '1', mask: '0', mobi_app: 'android', network: 'wifi',
      no_playurl: '0', only_audio: '1', only_video: '0', platform: 'android', play_type: '0',
      protocol: '0,1', qn: '10000', s_locale: 'zh_CN',
      statistics: '{"appId":1,"platform":3,"version":"6.21.5","abtest":""}',
      ts: String(Math.floor(Date.now() / 1000)), room_id: String(roomId),
    });
    return `https://api.live.bilibili.com/xlive/app-room/v2/index/getRoomPlayInfo?${p}`;
  }
  async function getAudioOnlyUrl(roomId) {
    let res;
    try {
      res = await fetchWithTimeout(buildAudioApiUrl(roomId), {
        credentials: 'include', headers: { Accept: 'application/json, text/plain, */*' },
      });
    } catch (e) { throw new Error(`获取纯音频地址失败：${e?.message || e}`); }
    if (!res.ok) throw new Error(`取流接口 HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== 0) throw new Error(`Bilibili 接口错误：${json.code} ${json.message || ''}`);
    if (json.data?.live_status !== 1) throw new Error('直播间当前未开播');
    for (const stream of json.data?.playurl_info?.playurl?.stream || []) {
      if (stream.protocol_name !== 'http_stream') continue;
      for (const fmt of stream.format || []) {
        if (fmt.format_name !== 'flv') continue;
        for (const codec of fmt.codec || []) {
          if (!codec?.base_url || !codec.url_info?.length || codec.is_pushing === false) continue;
          const info = codec.url_info.find(i => i?.host && !/^https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/i.test(i.host)) || codec.url_info[0];
          if (!info?.host) continue;
          return `${info.host}${codec.base_url}${info.extra || ''}`.replace(/^http:\/\//i, 'https://');
        }
      }
    }
    throw new Error('接口没有返回可用的纯音频 FLV 地址');
  }

  // ---- 封面（不拉视频画面，只显示静态图）----
  function getCoverFromPage() {
    const pw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const ri = pw.__NEPTUNE_IS_MY_WAIFU__?.roomInfoRes?.data?.room_info ||
      pw.__INITIAL_STATE__?.roomInfo || pw.__INITIAL_STATE__?.room_info || {};
    const cands = [
      ri.cover, ri.keyframe, ri.user_cover, ri.background,
      document.querySelector('#live-player .web-player-video-cover-img-wrap img')?.currentSrc,
      document.querySelector('#live-player .web-player-video-cover-img-wrap img')?.src,
      document.querySelector('meta[property="og:image"]')?.content,
    ];
    return cands.find(v => /^https?:\/\//i.test(v || '')) || '';
  }
  async function fetchRoomCover(roomId) {
    try {
      const res = await fetchWithTimeout(
        `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`,
        { credentials: 'include', headers: { Accept: 'application/json' } }, 4000
      );
      if (!res.ok) return '';
      const j = await res.json();
      if (j.code !== 0 || !j.data) return '';
      return j.data.cover || j.data.user_cover || j.data.keyframe || j.data.background || '';
    } catch { return ''; }
  }
  function applyCover() {
    const box = document.querySelector('#live-player');
    if (!box) return;
    const active = state.enabled || state.connecting;
    box.classList.toggle('blao-active', active);
    let layer = box.querySelector(':scope > #blao-cover-layer');
    if (active) {
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'blao-cover-layer';
        layer.setAttribute('aria-hidden', 'true');
        box.appendChild(layer);
      }
      layer.style.backgroundImage = state.coverUrl ? `url("${state.coverUrl.replace(/"/g, '\\"')}")` : 'none';
      layer.style.display = state.coverUrl ? 'block' : 'none';
    } else {
      layer?.remove();
    }
    suppressNativeErrorArtwork();
    ensureAudioToolbar();
    updateAudioToolbar();
  }
  function suppressNativeErrorArtwork() {
    if (!state.enabled && !state.connecting) return;
    const player = document.querySelector('#live-player');
    if (!player) return;
    player.querySelectorAll('img[src*="error@1x.png"], img[src*="error@2x.png"], img[src*="/images/error"]').forEach(img => {
      img.style.setProperty('display', 'none', 'important');
      const p = img.parentElement;
      if (p && /error|offline|player-tip/i.test(`${p.id || ''} ${p.className || ''}`)) {
        p.style.setProperty('display', 'none', 'important');
      }
    });
  }
  function loadCoverInBackground(roomId, gen) {
    if (!state.coverUrl) { state.coverUrl = getCoverFromPage(); applyCover(); }
    fetchRoomCover(roomId).then(url => {
      if (url && gen === state.generation) { state.coverUrl = url; applyCover(); }
    });
  }

  // 仅用于开启时同步一下音量到纯音频播放器，不做关闭时还原
  function syncVolumeFromNative() {
    try {
      const info = getLivePlayer()?.getPlayerInfo?.();
      if (typeof info?.volume?.value === 'number') state.volume = Math.max(0, Math.min(1, info.volume.value / 100));
      if (typeof info?.volume?.disabled === 'boolean') state.muted = info.volume.disabled;
    } catch {}
    const v = getNativeVideo();
    if (v) {
      if (Number.isFinite(v.volume)) state.volume = v.volume;
      state.muted = v.muted;
    }
  }
  function stopNativePlayer() {
    const p = state.livePlayer || getLivePlayer();
    if (!p?.stopPlayback) throw new Error('无法调用 B站播放器 stopPlayback()');
    p.stopPlayback(); // 关键：真正省流量靠这里停掉视频流
    state.nativeStopped = true;
  }
  function enterWebFullscreen(player = state.livePlayer || getLivePlayer()) {
    if (!player?.setFullscreenStatus) return false;
    try { player.setFullscreenStatus(1); return true; } catch { return false; }
  }

  // ---- 播放器内音频条 ----
  let audioToolbar, audioPlayBtn, audioRefreshBtn, audioMuteBtn, audioVol, audioStateLabel;
  function ensureAudioToolbar() {
    const box = document.querySelector('#live-player');
    if (!box) return;
    if (audioToolbar?.isConnected && audioToolbar.parentElement === box) return;
    audioToolbar = document.createElement('div');
    audioToolbar.id = 'blao-audio-toolbar';
    audioToolbar.setAttribute('aria-label', '纯音频控制栏');

    audioPlayBtn = document.createElement('button');
    audioPlayBtn.type = 'button';
    audioPlayBtn.addEventListener('click', () => {
      if (state.userPaused || !state.mediaElement) {
        resumeAudioStream().catch(e => setStatus(`恢复播放失败：${e?.message || e}`, 'error'));
      } else {
        pauseAudioStreamForReal();
      }
      updateAudioToolbar();
    });

    audioRefreshBtn = document.createElement('button');
    audioRefreshBtn.type = 'button';
    audioRefreshBtn.textContent = '↻';
    audioRefreshBtn.title = '刷新音频流';
    audioRefreshBtn.addEventListener('click', () => {
      refreshAudioStreamManually().catch(e => setStatus(`刷新失败：${e?.message || e}`, 'error'));
    });

    audioMuteBtn = document.createElement('button');
    audioMuteBtn.type = 'button';
    audioMuteBtn.addEventListener('click', () => {
      const m = state.mediaElement;
      const muted = m ? (m.muted || m.volume === 0) : state.muted;
      if (muted) {
        state.muted = false;
        if (m) { m.muted = false; if (m.volume === 0) m.volume = state.volume > 0 ? state.volume : 1; }
      } else {
        state.muted = true;
        if (m) m.muted = true;
      }
      updateAudioToolbar();
    });

    audioVol = document.createElement('input');
    audioVol.type = 'range';
    audioVol.min = '0'; audioVol.max = '100'; audioVol.step = '1';
    audioVol.addEventListener('input', () => {
      const val = Number(audioVol.value) / 100;
      state.volume = val;
      const m = state.mediaElement;
      if (m) {
        m.volume = val;
        if (val > 0 && m.muted) m.muted = false;
        state.muted = m.muted;
      } else state.muted = val <= 0;
      updateAudioToolbar();
    });

    const spacer = document.createElement('span');
    spacer.className = 'blao-audio-spacer';
    audioStateLabel = document.createElement('span');
    audioStateLabel.className = 'blao-audio-state';
    audioToolbar.append(audioPlayBtn, audioRefreshBtn, audioMuteBtn, audioVol, spacer, audioStateLabel);
    box.appendChild(audioToolbar);
  }
  function updateAudioToolbar() {
    ensureAudioToolbar();
    if (!audioToolbar) return;
    const active = state.enabled || state.connecting || state.waitingGesture;
    audioToolbar.style.display = active ? 'flex' : 'none';
    const m = state.mediaElement;
    if (audioPlayBtn) {
      audioPlayBtn.textContent = m && !m.paused ? '❚❚' : '▶';
      audioPlayBtn.disabled = !state.enabled || state.connecting;
      if (state.userPaused && state.enabled && !state.connecting) audioPlayBtn.disabled = false;
    }
    if (audioRefreshBtn) {
      audioRefreshBtn.disabled = !state.enabled || state.connecting || state.userPaused;
      audioRefreshBtn.textContent = state.connecting ? '…' : '↻';
    }
    if (audioMuteBtn) {
      const muted = !m || m.muted || m.volume === 0;
      audioMuteBtn.textContent = muted ? '🔇' : '🔊';
      audioMuteBtn.disabled = !state.enabled || state.connecting;
    }
    if (audioVol && document.activeElement !== audioVol) {
      audioVol.value = String(Math.round((m ? m.volume : state.volume) * 100));
      audioVol.disabled = !state.enabled || state.connecting;
    }
    if (audioStateLabel) {
      audioStateLabel.textContent = state.connecting ? '正在连接…'
        : state.waitingGesture ? '点击播放'
        : state.userPaused ? '已暂停（流已停止）'
        : m?.paused ? '已暂停' : '纯音频播放中';
    }
  }

  // ---- 纯音频管道（省流量核心）----
  function destroyAudioPipeline() {
    if (state.flvPlayer) {
      try { state.flvPlayer.pause(); } catch {}
      try { state.flvPlayer.unload(); } catch {}
      try { state.flvPlayer.detachMediaElement(); } catch {}
      try { state.flvPlayer.destroy(); } catch {}
      state.flvPlayer = null;
    }
    state.pipelineGeneration = null;
    if (state.mediaElement) {
      try { state.mediaElement.pause(); } catch {}
      state.mediaElement.remove();
      state.mediaElement = null;
    }
    updateAudioToolbar();
  }
  function createAudioPipeline(url, gen = state.generation) {
    destroyAudioPipeline();
    const flvjs = getFlvjs();
    if (!flvjs?.createPlayer) throw new Error('flv.js 未加载');
    if (!flvjs.isSupported()) throw new Error('当前浏览器不支持 flv.js / MSE');

    const media = document.createElement('video');
    media.id = 'blao-audio-media';
    media.style.display = 'none';
    media.autoplay = false;
    media.controls = false;
    media.preload = 'auto';
    media.volume = state.volume;
    media.muted = state.muted;
    document.body.appendChild(media);

    // hasVideo: false —— 只解码音频，不拉视频轨
    const player = flvjs.createPlayer(
      { type: 'flv', isLive: true, hasVideo: false, hasAudio: true, url },
      { enableWorker: false, enableStashBuffer: false, stashInitialSize: 128, lazyLoad: false,
        deferLoadAfterSourceOpen: false, autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30, autoCleanupMinBackwardDuration: 15 }
    );
    state.mediaElement = media;
    state.flvPlayer = player;
    state.pipelineGeneration = gen;

    const onChange = () => { if (state.mediaElement === media) updateAudioToolbar(); };
    media.addEventListener('play', onChange);
    media.addEventListener('pause', onChange);
    media.addEventListener('volumechange', onChange);
    player.attachMediaElement(media);
    updateAudioToolbar();

    if (flvjs.Events?.STATISTICS_INFO) {
      player.on(flvjs.Events.STATISTICS_INFO, info => {
        if (state.flvPlayer !== player) return;
        const sp = Number(info?.speed);
        state.trafficSpeedKBps = Number.isFinite(sp) && sp >= 0 ? sp : null;
        updateTraffic();
      });
    }
    player.load();
    if (flvjs.Events?.ERROR) {
      player.on(flvjs.Events.ERROR, () => {
        if (state.flvPlayer === player && state.enabled) scheduleReconnect('音频流中断');
      });
    }
    media.addEventListener('stalled', () => {
      if (state.mediaElement === media && state.enabled) scheduleReconnect('音频缓冲中断');
    });
    return media;
  }
  function getBufferedSeconds(media) {
    try {
      if (!media?.buffered?.length) return 0;
      let t = 0;
      for (let i = 0; i < media.buffered.length; i++) t += Math.max(0, media.buffered.end(i) - media.buffered.start(i));
      return t;
    } catch { return 0; }
  }
  async function waitForAudioBuffer(media, ms = CONFIG.bufferTimeoutMs) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (media !== state.mediaElement) throw new Error('纯音频播放器已被替换');
      const buf = getBufferedSeconds(media);
      if (media.readyState >= 2 || buf >= 0.15) {
        setStatus(buf > 0 ? `纯音频已缓冲 ${buf.toFixed(1)} 秒，正在切换…` : '纯音频已就绪，正在切换…', 'warning');
        return;
      }
      setStatus(buf > 0 ? `正在缓冲纯音频… ${buf.toFixed(1)} 秒` : `正在缓冲纯音频… ${((Date.now() - start) / 1000).toFixed(1)} 秒`, 'warning');
      await sleep(200);
    }
    throw new Error(`纯音频缓冲超时（readyState=${media.readyState}, buffered=${getBufferedSeconds(media).toFixed(1)}s）`);
  }
  async function waitForMediaInit(media, ms = CONFIG.mediaInitTimeoutMs) {
    if (!media || media.readyState >= 1) { await sleep(80); return; }
    await new Promise(resolve => {
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(t); media.removeEventListener('loadedmetadata', fin); media.removeEventListener('canplay', fin); resolve(); };
      const t = setTimeout(fin, ms);
      media.addEventListener('loadedmetadata', fin, { once: true });
      media.addEventListener('canplay', fin, { once: true });
    });
    await sleep(80);
  }
  async function playAudioMedia() {
    const media = state.mediaElement;
    if (!media) throw new Error('纯音频播放器未创建');
    await waitForMediaInit(media);
    let lastErr = null;
    for (let i = 0; i < 5; i++) {
      if (media !== state.mediaElement) throw new Error('纯音频播放器已被替换');
      try {
        await media.play();
        state.waitingGesture = false;
        state.reconnectCount = 0;
        setStatus('纯音频播放中（仅音频流，省流量）', 'success');
        updateButton();
        return true;
      } catch (e) {
        lastErr = e;
        if (e?.name === 'NotAllowedError') {
          state.waitingGesture = true;
          setStatus('浏览器阻止自动播放，请再点一次“播放音频”', 'warning');
          updateButton();
          return false;
        }
        if (e?.name === 'AbortError' || /interrupted by a call to pause/i.test(String(e?.message || ''))) {
          await sleep(180 + i * 180);
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error('纯音频播放启动失败');
  }

  // ---- 生命周期 ----
  function pauseAudioStreamForReal() {
    if (state.userPaused) return;
    state.userPaused = true;
    state.generation += 1;
    if (state.refreshTimer) { clearTimeout(state.refreshTimer); state.refreshTimer = null; }
    clearReconnect();
    state.trafficSpeedKBps = 0;
    destroyAudioPipeline(); // pause 不够，必须卸掉 flv 下载
    updateTraffic();
    updateAudioToolbar();
    setStatus('已暂停：音频流已停止；恢复时会重新连接', 'success');
  }
  async function resumeAudioStream() {
    if (!state.enabled || state.connecting || !state.userPaused) return;
    const gen = state.generation;
    state.connecting = true;
    updateAudioToolbar();
    setStatus('正在重新连接音频流…', 'warning');
    try {
      await ensureFlvjs();
      const url = await getAudioOnlyUrl(state.roomId);
      if (!state.enabled || gen !== state.generation) return;
      const media = createAudioPipeline(url, gen);
      await waitForAudioBuffer(media);
      if (!state.enabled || gen !== state.generation) return;
      state.userPaused = false;
      state.connecting = false;
      await playAudioMedia();
      if (!state.enabled || gen !== state.generation) return;
      scheduleRefresh(gen);
      updateAudioToolbar();
    } catch (e) {
      if (gen === state.generation) {
        state.connecting = false;
        state.userPaused = true;
        destroyAudioPipeline();
        setStatus(`恢复播放失败：${e?.message || e}`, 'error');
        updateAudioToolbar();
      }
    }
  }
  async function refreshAudioStreamManually() {
    if (!state.enabled || state.connecting) return;
    const gen = state.generation;
    const wasPlaying = Boolean(state.mediaElement && !state.mediaElement.paused);
    if (state.refreshTimer) { clearTimeout(state.refreshTimer); state.refreshTimer = null; }
    clearReconnect();
    state.connecting = true;
    updateAudioToolbar();
    setStatus('正在刷新音频流…', 'warning');
    try {
      await ensureFlvjs();
      const url = await getAudioOnlyUrl(state.roomId);
      if (!state.enabled || gen !== state.generation) return;
      createAudioPipeline(url, gen);
      if (wasPlaying) await playAudioMedia();
      if (!state.enabled || gen !== state.generation) return;
      state.connecting = false;
      setStatus('音频流已刷新', 'success');
      scheduleRefresh(gen);
    } catch (e) {
      state.connecting = false;
      setStatus(`刷新音频流失败：${e?.message || e}`, 'error');
      if (state.enabled && gen === state.generation) scheduleReconnect('手动刷新失败');
    } finally { updateAudioToolbar(); }
  }
  function startWatchdog() {
    stopWatchdog();
    // 防止原生视频又偷偷开始拉流
    state.watchdogTimer = setInterval(() => {
      if (!state.enabled) return;
      suppressNativeErrorArtwork();
      const v = getNativeVideo();
      if (!v) return;
      const src = v.currentSrc || v.src || '';
      if (src.startsWith('blob:') && !v.paused) {
        try { (state.livePlayer || getLivePlayer())?.stopPlayback?.(); state.nativeStopped = true; } catch {}
      }
    }, CONFIG.watchdogMs);
  }
  function stopWatchdog() {
    if (state.watchdogTimer) { clearInterval(state.watchdogTimer); state.watchdogTimer = null; }
  }
  function scheduleRefresh(gen) {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(async () => {
      state.refreshTimer = null;
      if (!state.enabled || state.userPaused || gen !== state.generation) return;
      try {
        await ensureFlvjs();
        const url = await getAudioOnlyUrl(state.roomId);
        if (!state.enabled || state.userPaused || gen !== state.generation) return;
        createAudioPipeline(url, gen);
        await playAudioMedia();
        scheduleRefresh(gen);
      } catch (e) {
        if (state.enabled && gen === state.generation) {
          setStatus(`刷新音频流失败：${e?.message || e}`, 'error');
          scheduleReconnect('刷新失败');
        }
      }
    }, CONFIG.refreshStreamMs);
  }
  function clearReconnect() {
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  }
  function scheduleReconnect(reason) {
    if (!state.enabled || state.userPaused || state.reconnectTimer) return;
    if (state.reconnectCount >= CONFIG.maxReconnects) {
      setStatus('自动重连次数已用完，请关闭后重新开启', 'error');
      return;
    }
    state.reconnectCount += 1;
    const gen = state.generation;
    setStatus(`${reason}，${CONFIG.reconnectDelayMs / 1000} 秒后重连（${state.reconnectCount}/${CONFIG.maxReconnects}）`, 'warning');
    state.reconnectTimer = setTimeout(async () => {
      state.reconnectTimer = null;
      if (!state.enabled || state.userPaused || gen !== state.generation) return;
      try {
        await ensureFlvjs();
        const url = await getAudioOnlyUrl(state.roomId);
        if (!state.enabled || state.userPaused || gen !== state.generation) return;
        createAudioPipeline(url, gen);
        await playAudioMedia();
        scheduleRefresh(gen);
      } catch (e) {
        setStatus(`重连失败：${e?.message || e}`, 'error');
        scheduleReconnect('继续重连');
      }
    }, CONFIG.reconnectDelayMs);
  }

  async function enableAudioOnly() {
    if (state.connecting || state.enabled) return;
    state.connecting = true;
    state.userPaused = false;
    state.trafficSpeedKBps = null;
    updateTraffic();
    state.generation += 1;
    const gen = state.generation;
    updateButton();
    setStatus('正在获取纯音频地址…', 'warning');
    state.coverUrl = getCoverFromPage();
    loadCoverInBackground(state.roomId, gen);
    try {
      setStatus('正在准备 flv.js…', 'warning');
      await ensureFlvjs();
      if (gen !== state.generation) return;
      let url, livePlayer;
      if (state.autoStartAudioOnly) {
        livePlayer = await waitForLivePlayer();
        if (gen !== state.generation) return;
        state.livePlayer = livePlayer;
        enterWebFullscreen(livePlayer);
        syncVolumeFromNative();
        stopNativePlayer(); // 尽早停视频流
        url = await getAudioOnlyUrl(state.roomId);
        if (gen !== state.generation || !state.connecting) return;
      } else {
        [url, livePlayer] = await Promise.all([getAudioOnlyUrl(state.roomId), waitForLivePlayer()]);
        if (gen !== state.generation) return;
        state.livePlayer = livePlayer;
        enterWebFullscreen(livePlayer);
        syncVolumeFromNative();
      }
      setStatus('正在缓冲纯音频…', 'warning');
      const media = createAudioPipeline(url, gen);
      await waitForAudioBuffer(media);
      if (gen !== state.generation) return;
      if (!state.nativeStopped) { enterWebFullscreen(livePlayer); stopNativePlayer(); }
      state.enabled = true;
      state.connecting = false;
      applyCover();
      updateAudioToolbar();
      await playAudioMedia();
      startWatchdog();
      scheduleRefresh(gen);
      updateButton();
    } catch (e) {
      if (gen !== state.generation) {
        if (state.pipelineGeneration === gen) destroyAudioPipeline();
        return;
      }
      state.connecting = false;
      state.enabled = false;
      state.waitingGesture = false;
      destroyAudioPipeline();
      applyCover();
      updateAudioToolbar();
      updateButton();
      if (state.nativeStopped) {
        try { state.livePlayer?.reload?.(); } catch {}
        state.nativeStopped = false;
      }
      setStatus(`开启失败：${e?.message || e}`, 'error');
      console.error('[Bilibili Live Audio Only]', e);
    }
  }
  async function resumeAfterGesture() {
    try { await playAudioMedia(); } catch (e) { setStatus(`播放失败：${e?.message || e}`, 'error'); }
  }
  function disableAudioOnly() {
    state.generation += 1;
    state.enabled = false;
    state.connecting = false;
    state.waitingGesture = false;
    state.userPaused = false;
    state.trafficSpeedKBps = null;
    updateTraffic();
    updateAudioToolbar();
    clearReconnect();
    stopWatchdog();
    if (state.refreshTimer) { clearTimeout(state.refreshTimer); state.refreshTimer = null; }
    destroyAudioPipeline();
    const player = state.livePlayer || getLivePlayer();
    if (state.nativeStopped && player?.reload) {
      try {
        player.reload();
        setStatus('已恢复视频模式', 'success');
      } catch { setStatus('恢复视频失败，请刷新页面', 'error'); }
    } else {
      setStatus('已关闭纯音频模式', '');
    }
    state.nativeStopped = false;
    state.livePlayer = null;
    applyCover();
    updateButton();
  }

  // ---- 流量显示（方便确认是否在省流）----
  let lastResAt = performance.now();
  let lastResBytes = new Map();
  let progBytes = 0, appendBytes = 0, progStart = performance.now(), lastProgAt = 0;
  let probeInstalled = false;
  function isLiveUrl(u) {
    return /\.(?:flv|m3u8|m4s|ts|mp4)(?:[?#]|$)|live-bvc|\/(?:live|playback)/i.test(String(u || ''));
  }
  function installTrafficProbe() {
    if (probeInstalled) return;
    const pw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const proto = pw.XMLHttpRequest?.prototype;
    if (proto && !proto.__blaoTraffic && typeof proto.open === 'function') {
      try {
        const oOpen = proto.open, oSend = proto.send;
        Object.defineProperty(proto, '__blaoTraffic', { value: true });
        proto.open = function(m, u, ...a) { try { this.__blaoUrl = String(u || ''); } catch {} return oOpen.call(this, m, u, ...a); };
        proto.send = function(...a) {
          if (!this.__blaoTracked && isLiveUrl(this.__blaoUrl)) {
            this.__blaoTracked = true;
            this.__blaoLoaded = 0;
            this.addEventListener('progress', e => {
              const loaded = Number(e?.loaded);
              if (!Number.isFinite(loaded) || loaded < 0) return;
              let d = loaded - (this.__blaoLoaded || 0);
              if (d < 0) d = loaded;
              this.__blaoLoaded = loaded;
              if (state.enabled || state.connecting) return;
              if (d > 0 && d < 128 * 1024 * 1024) { progBytes += d; lastProgAt = performance.now(); }
            });
          }
          return oSend.apply(this, a);
        };
      } catch {}
    }
    const sb = pw.SourceBuffer?.prototype;
    if (sb && !sb.__blaoTraffic && typeof sb.appendBuffer === 'function') {
      try {
        const o = sb.appendBuffer;
        Object.defineProperty(sb, '__blaoTraffic', { value: true });
        sb.appendBuffer = function(data) {
          if (!state.enabled && !state.connecting) {
            let size = 0;
            if (data instanceof ArrayBuffer) size = data.byteLength;
            else if (ArrayBuffer.isView(data)) size = data.byteLength;
            if (size > 0 && size < 128 * 1024 * 1024) { appendBytes += size; lastProgAt = performance.now(); }
          }
          return o.apply(this, arguments);
        };
      } catch {}
    }
    probeInstalled = Boolean(proto?.__blaoTraffic || sb?.__blaoTraffic);
  }
  function pollTraffic() {
    if (state.enabled && state.userPaused) { state.trafficSpeedKBps = 0; updateTraffic(); return; }
    if (state.enabled && state.flvPlayer) { updateTraffic(); return; }
    const now = performance.now();
    const elapsed = Math.max(250, now - progStart);
    const rb = progBytes, ab = appendBytes;
    progBytes = 0; appendBytes = 0; progStart = now;
    let found = false;
    try {
      const p = getLivePlayer();
      const roots = [p?.getPlayerInfo?.(), p?.getStatisticsInfo?.(), p?.statisticsInfo].filter(Boolean);
      for (const root of roots) {
        const scan = (o, d) => {
          if (!o || typeof o !== 'object' || d > 3) return null;
          for (const [k, v] of Object.entries(o)) {
            if (/speed|netSpeed|downloadSpeed|recvSpeed/i.test(k) && Number.isFinite(Number(v)) && Number(v) >= 0) return Number(v);
            if (v && typeof v === 'object' && /stat|speed|network/i.test(k)) {
              const r = scan(v, d + 1); if (r !== null) return r;
            }
          }
          return null;
        };
        const r = scan(root, 0);
        if (r !== null) { state.trafficSpeedKBps = r; found = true; break; }
      }
    } catch {}
    if (!found) {
      const bytes = rb > 0 ? rb : ab;
      if (bytes > 0) { state.trafficSpeedKBps = bytes / (elapsed / 1000) / 1024; found = true; }
      else if (lastProgAt && now - lastProgAt < 2500) { state.trafficSpeedKBps = 0; found = true; }
    }
    if (!found) {
      try {
        const entries = performance.getEntriesByType('resource');
        const cur = new Map();
        let bytes = 0;
        for (const e of entries) {
          if (!/\.(?:flv|m4s|ts|mp4)/i.test(e.name)) continue;
          const size = Number(e.transferSize || e.encodedBodySize || 0);
          if (size > 0) {
            cur.set(e.name, size);
            const prev = lastResBytes.get(e.name) || 0;
            if (size > prev) bytes += size - prev;
          }
        }
        if (bytes > 0) state.trafficSpeedKBps = bytes / (Math.max(250, now - lastResAt) / 1000) / 1024;
        lastResBytes = cur;
        lastResAt = now;
      } catch {}
    }
    if (!found && state.trafficSpeedKBps == null) state.trafficSpeedKBps = null;
    updateTraffic();
  }
  installTrafficProbe();
  state.trafficMonitorTimer = setInterval(() => {
    if (!probeInstalled) installTrafficProbe();
    pollTraffic();
  }, 1000);

  // ---- 悬浮窗 UI（仅此一种，无贴边热区）----
  const anchor = document.createElement('div');
  anchor.id = 'blao-anchor';
  const panel = document.createElement('div');
  panel.id = 'blao-panel';
  const panelHeader = document.createElement('div');
  panelHeader.id = 'blao-panel-header';
  panelHeader.title = '拖动移动面板';
  const panelTitle = document.createElement('span');
  panelTitle.id = 'blao-panel-title';
  panelTitle.textContent = '纯音频控制';
  const minimizeBtn = document.createElement('button');
  minimizeBtn.id = 'blao-panel-minimize';
  minimizeBtn.type = 'button';
  minimizeBtn.textContent = '−';
  minimizeBtn.title = '最小化';
  panelHeader.append(panelTitle, minimizeBtn);
  const minimizedWidget = document.createElement('button');
  minimizedWidget.id = 'blao-minimized-widget';
  minimizedWidget.type = 'button';
  minimizedWidget.textContent = '🎧 纯音频';
  minimizedWidget.title = '单击恢复；拖动可移动';
  const button = document.createElement('button');
  button.id = 'blao-button';
  const status = document.createElement('div');
  status.id = 'blao-status';
  const screenshotBtn = document.createElement('button');
  screenshotBtn.id = 'blao-screenshot-button';
  screenshotBtn.type = 'button';
  screenshotBtn.textContent = '截取当前帧';
  screenshotBtn.title = '截图在新标签打开，关闭即删';
  const autoStartBtn = document.createElement('button');
  autoStartBtn.id = 'blao-auto-start-button';
  autoStartBtn.type = 'button';
  const updateAutoStartBtn = () => {
    autoStartBtn.textContent = `默认启动纯音频：${state.autoStartAudioOnly ? '已开启' : '已关闭'}`;
  };
  updateAutoStartBtn();

  const settings = document.createElement('details');
  settings.id = 'blao-settings';
  const sum = document.createElement('summary');
  sum.textContent = '等待时间设置';
  const fields = document.createElement('div');
  fields.id = 'blao-settings-fields';
  const waitItems = [
    ['apiTimeoutMs', '接口请求超时', 1, 300],
    ['playerWaitMs', '等待播放器就绪', 1, 120],
    ['bufferTimeoutMs', '等待音频缓冲', 1, 300],
    ['mediaInitTimeoutMs', '等待音频初始化', 1, 120],
    ['screenshotFrameTimeoutMs', '等待截图画面', 1, 120],
    ['screenshotLoadTimeoutMs', '后台截图等待', 1, 300],
    ['reconnectDelayMs', '断线重连间隔', 1, 120],
    ['flvjsWaitMs', '等待 flv.js', 5, 60],
  ];
  for (const [key, label, min, max] of waitItems) {
    const row = document.createElement('label');
    row.className = 'blao-setting-row';
    const t = document.createElement('span');
    t.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min); input.max = String(max); input.step = '1';
    input.value = String(Math.round(CONFIG[key] / 1000));
    input.addEventListener('change', () => {
      let s = Number(input.value);
      if (!Number.isFinite(s)) { input.value = String(Math.round(CONFIG[key] / 1000)); return; }
      s = Math.max(min, Math.min(max, Math.round(s)));
      input.value = String(s);
      saveWait(key, s * 1000);
      setStatus(`${label}已设为 ${s} 秒`, 'success');
    });
    const unit = document.createElement('span');
    unit.textContent = '秒';
    row.append(t, input, unit);
    fields.appendChild(row);
  }
  settings.append(sum, fields);

  const traffic = document.createElement('div');
  traffic.id = 'blao-traffic';
  traffic.textContent = '流量：-- KB/s';
  function formatRate(sp) {
    if (!Number.isFinite(sp) || sp < 0) return '-- KB/s';
    return sp > 1024 ? `${(sp / 1024).toFixed(2)} MB/s` : `${sp.toFixed(1)} KB/s`;
  }
  function updateTraffic() { traffic.textContent = `流量：${formatRate(state.trafficSpeedKBps)}`; }

  function injectStyle() {
    if (document.getElementById('blao-style')) return;
    const style = document.createElement('style');
    style.id = 'blao-style';
    style.textContent = `
#blao-anchor{position:fixed;z-index:2147483647;pointer-events:auto;right:auto;width:auto;height:auto;max-width:calc(100vw - 16px)}
#blao-anchor[data-hidden="1"]{display:none!important}
#blao-panel{position:relative;box-sizing:border-box;width:242px;max-width:calc(100vw - 16px);padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:10px;background:rgba(24,24,28,.94);box-shadow:0 6px 22px rgba(0,0,0,.35);color:#fff;font:13px/1.45 system-ui,sans-serif;backdrop-filter:blur(8px)}
#blao-panel-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;padding:0 0 8px;border-bottom:1px solid rgba(255,255,255,.14);cursor:grab;user-select:none;touch-action:none}
#blao-panel-header:active{cursor:grabbing}
#blao-panel-title{min-width:0;overflow:hidden;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
#blao-panel-minimize{flex:0 0 28px;width:28px;height:24px;padding:0;border:1px solid rgba(255,255,255,.22);border-radius:6px;background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font:18px/1 system-ui}
#blao-anchor[data-minimized="1"] #blao-panel{display:none!important}
#blao-minimized-widget{display:none;box-sizing:border-box;align-items:center;justify-content:center;padding:9px 12px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:rgba(24,24,28,.96);box-shadow:0 6px 22px rgba(0,0,0,.38);color:#fff;font:650 13px/1.2 system-ui;white-space:nowrap;cursor:grab;user-select:none;touch-action:none}
#blao-minimized-widget:hover{filter:brightness(1.12)}
#blao-anchor[data-minimized="1"] #blao-minimized-widget{display:flex}
#blao-button{width:100%;border:0;border-radius:7px;padding:8px 10px;cursor:pointer;background:#00aeec;color:#fff;font:inherit;font-weight:650}
#blao-button:hover,#blao-screenshot-button:hover,#blao-auto-start-button:hover{filter:brightness(1.06)}
#blao-screenshot-button,#blao-auto-start-button{width:100%;margin-top:7px;border:1px solid rgba(255,255,255,.2);border-radius:7px;padding:7px 10px;cursor:pointer;background:rgba(255,255,255,.1);color:#fff;font:inherit}
#blao-screenshot-button:disabled,#blao-button:disabled{cursor:wait;opacity:.7}
#blao-status{margin-top:7px;color:#aaa;font-size:12px;word-break:break-word}
#blao-status[data-kind="success"]{color:#7ee787}
#blao-status[data-kind="warning"]{color:#ffd166}
#blao-status[data-kind="error"]{color:#ff7b72}
#blao-settings{margin-top:8px;padding-top:7px;border-top:1px solid rgba(255,255,255,.14)}
#blao-settings summary{cursor:pointer;color:#ddd;user-select:none}
#blao-settings-fields{max-height:260px;overflow-y:auto;margin-top:6px}
.blao-setting-row{display:grid;grid-template-columns:minmax(0,1fr) 54px 20px;gap:4px;margin:5px 0;color:#ddd;font-size:11px}
.blao-setting-row input{box-sizing:border-box;width:54px;border:1px solid rgba(255,255,255,.22);border-radius:4px;padding:3px;background:rgba(0,0,0,.35);color:#fff;font:inherit}
#blao-traffic{margin-top:5px;color:#9bdcff;font-size:12px;font-variant-numeric:tabular-nums}
#live-player.blao-active{position:relative!important;background-color:#000!important;isolation:isolate!important}
#blao-cover-layer{position:absolute!important;inset:0!important;z-index:2!important;pointer-events:none!important;background-color:#111!important;background-position:center!important;background-repeat:no-repeat!important;background-size:contain!important}
#live-player.blao-active [class*="danmaku"],#live-player.blao-active [class*="danmu"],#live-player.blao-active canvas{z-index:4!important}
#live-player.blao-active>video,#live-player.blao-active video{visibility:hidden!important}
#live-player.blao-active .web-player-video-cover-img-wrap{display:none!important}
#live-player.blao-active img[src*="error"]{display:none!important}
#blao-audio-toolbar{position:absolute!important;z-index:2147483000!important;left:0!important;right:0!important;bottom:0!important;display:flex!important;align-items:center!important;gap:10px!important;box-sizing:border-box!important;min-height:48px!important;padding:8px 14px!important;color:#fff!important;background:linear-gradient(transparent,rgba(0,0,0,.88))!important;pointer-events:auto!important;font:13px/1.2 Arial,sans-serif!important}
#blao-audio-toolbar button{appearance:none!important;flex:0 0 auto!important;min-width:32px!important;height:30px!important;border:0!important;border-radius:4px!important;padding:0 7px!important;color:#fff!important;background:rgba(255,255,255,.12)!important;cursor:pointer!important;font:inherit!important}
#blao-audio-toolbar button:hover{background:rgba(255,255,255,.25)!important}
#blao-audio-toolbar input[type=range]{flex:0 1 130px!important;width:130px!important;min-width:55px!important;margin:0!important;accent-color:#00aeec!important;cursor:pointer!important}
#blao-audio-toolbar .blao-audio-spacer{flex:1 1 auto!important}
#blao-audio-toolbar .blao-audio-state{opacity:.85!important;white-space:nowrap!important}
#live-player:not(.blao-active) #blao-audio-toolbar{display:none!important}
`;
    (document.head || document.documentElement).appendChild(style);
  }

  function syncPageButtonVisibility() { anchor.dataset.hidden = state.buttonVisible ? '0' : '1'; }
  function savePanelState() {
    GM_setValue('panelMinimized', state.panelMinimized);
    if (Number.isFinite(state.panelLeft) && Number.isFinite(state.panelTop)) {
      GM_setValue('panelLeft', Math.round(state.panelLeft));
      GM_setValue('panelTop', Math.round(state.panelTop));
    }
  }
  function updatePanelWindowState(persist = false) {
    anchor.dataset.minimized = state.panelMinimized ? '1' : '0';
    anchor.style.right = 'auto';
    anchor.style.left = '0px';
    anchor.style.top = '72px';
    const rect = anchor.getBoundingClientRect();
    const m = 8;
    const maxL = Math.max(m, window.innerWidth - rect.width - m);
    const maxT = Math.max(m, window.innerHeight - rect.height - m);
    const reqL = Number.isFinite(state.panelLeft) && state.panelLeft >= 0 ? state.panelLeft : Math.round((window.innerWidth - rect.width) / 2);
    const reqT = Number.isFinite(state.panelTop) && state.panelTop >= 0 ? state.panelTop : 72;
    state.panelLeft = Math.round(Math.max(m, Math.min(maxL, reqL)));
    state.panelTop = Math.round(Math.max(m, Math.min(maxT, reqT)));
    anchor.style.left = `${state.panelLeft}px`;
    anchor.style.top = `${state.panelTop}px`;
    if (persist) savePanelState();
  }
  function minimizePanel() {
    const r = panel.getBoundingClientRect();
    state.panelLeft = Math.max(8, r.right - 108);
    state.panelTop = r.top;
    state.panelMinimized = true;
    updatePanelWindowState(true);
  }
  function restorePanel() {
    state.panelMinimized = false;
    state.ignoreMinimizedClick = false;
    updatePanelWindowState(true);
  }
  function beginDrag(e) {
    if (e.isPrimary === false || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.currentTarget === panelHeader && e.target.closest('button')) return;
    if (state.panelDrag) return;
    const startRect = state.panelMinimized
      ? minimizedWidget.getBoundingClientRect()
      : anchor.getBoundingClientRect();
    state.panelDrag = {
      pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
      offsetX: e.clientX - startRect.left, offsetY: e.clientY - startRect.top,
      moved: false, fromMinimized: state.panelMinimized,
    };
    if (e.currentTarget === panelHeader) e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    document.addEventListener('pointermove', moveDrag, true);
    document.addEventListener('pointerup', endDrag, true);
    document.addEventListener('pointercancel', endDrag, true);
  }
  function moveDrag(e) {
    const d = state.panelDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved && (Math.abs(e.clientX - d.startX) > 3 || Math.abs(e.clientY - d.startY) > 3)) d.moved = true;
    if (!d.moved) return;
    e.preventDefault();
    const rect = anchor.getBoundingClientRect();
    const m = 8;
    state.panelLeft = Math.round(Math.max(m, Math.min(window.innerWidth - rect.width - m, e.clientX - d.offsetX)));
    state.panelTop = Math.round(Math.max(m, Math.min(window.innerHeight - rect.height - m, e.clientY - d.offsetY)));
    anchor.style.left = `${state.panelLeft}px`;
    anchor.style.top = `${state.panelTop}px`;
  }
  function endDrag(e) {
    const d = state.panelDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    state.panelDrag = null;
    document.removeEventListener('pointermove', moveDrag, true);
    document.removeEventListener('pointerup', endDrag, true);
    document.removeEventListener('pointercancel', endDrag, true);
    if (d.moved) {
      savePanelState();
      if (d.fromMinimized) state.ignoreMinimizedClick = true;
    }
    if (state.ignoreMinimizedClick) setTimeout(() => { state.ignoreMinimizedClick = false; }, 0);
  }
  minimizeBtn.addEventListener('click', minimizePanel);
  panelHeader.addEventListener('pointerdown', beginDrag);
  minimizedWidget.addEventListener('pointerdown', beginDrag);
  minimizedWidget.addEventListener('click', e => {
    if (state.ignoreMinimizedClick) { e.preventDefault(); e.stopPropagation(); state.ignoreMinimizedClick = false; return; }
    restorePanel();
  });
  window.addEventListener('resize', () => updatePanelWindowState(true));

  function setStatus(text, kind = '') {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  // menus
  let menuAudioId = null, menuBtnId = null, menuAutoId = null, menuSig = '';
  function unregisterMenus() {
    for (const id of [menuAudioId, menuBtnId, menuAutoId]) {
      if (id != null) try { GM_unregisterMenuCommand(id); } catch {}
    }
    menuAudioId = menuBtnId = menuAutoId = null;
  }
  let lastToggleAt = 0;
  async function toggleAudioOnly() {
    const now = Date.now();
    if (now - lastToggleAt < 350) return;
    lastToggleAt = now;
    if (state.waitingGesture) await resumeAfterGesture();
    else if (state.enabled || state.connecting) disableAudioOnly();
    else await enableAudioOnly();
    refreshMenus();
  }
  function togglePageBtn() {
    state.buttonVisible = !state.buttonVisible;
    GM_setValue('pageButtonVisible', state.buttonVisible);
    syncPageButtonVisibility();
    refreshMenus(true);
  }
  function refreshMenus(force = false) {
    const on = state.enabled || state.connecting || state.waitingGesture;
    const sig = `${on}|${state.buttonVisible}|${state.autoStartAudioOnly}`;
    if (!force && sig === menuSig) return;
    unregisterMenus();
    menuAudioId = GM_registerMenuCommand(on ? '关闭纯音频' : '开启纯音频', () => toggleAudioOnly().catch(console.error));
    menuBtnId = GM_registerMenuCommand(state.buttonVisible ? '隐藏网页按钮' : '显示网页按钮', togglePageBtn);
    menuAutoId = GM_registerMenuCommand(
      state.autoStartAudioOnly ? '默认启动纯音频：已开启（点击关闭）' : '默认启动纯音频：已关闭（点击开启）',
      () => {
        state.autoStartAudioOnly = !state.autoStartAudioOnly;
        GM_setValue('autoStartAudioOnly', state.autoStartAudioOnly);
        refreshMenus(true);
        setStatus(state.autoStartAudioOnly ? '已开启默认纯音频' : '已关闭默认纯音频', 'success');
      }
    );
    menuSig = sig;
  }
  function updateButton() {
    if (state.connecting) {
      button.textContent = '正在连接…';
      button.disabled = true;
      refreshMenus();
      return;
    }
    button.disabled = false;
    button.textContent = state.waitingGesture ? '播放音频' : state.enabled ? '恢复视频' : '开启纯音频';
    refreshMenus();
  }
  button.addEventListener('click', () => {
    toggleAudioOnly().catch(e => { setStatus(`操作失败：${e?.message || e}`, 'error'); console.error(e); });
  });

  // screenshot
  async function waitForVideoFrame(video, ms = CONFIG.screenshotFrameTimeoutMs) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (video?.readyState >= 2 && video.videoWidth > 0) return;
      await sleep(150);
    }
    throw new Error('等待直播视频画面超时');
  }
  function createScreenshotBlob(video) {
    return new Promise((resolve, reject) => {
      if (!video || video.videoWidth <= 0) return reject(new Error('当前没有可截取的视频帧'));
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      const ctx = c.getContext('2d');
      if (!ctx) return reject(new Error('无法创建截图画布'));
      try { ctx.drawImage(video, 0, 0); } catch (e) { return reject(new Error(`读取帧失败：${e?.message || e}`)); }
      c.toBlob(b => b ? resolve(b) : reject(new Error('无法生成 PNG')), 'image/png');
    });
  }
  function saveScreenshotFile(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    const p = n => String(n).padStart(2, '0');
    a.href = url;
    a.download = `bilibili_live_${state.roomId}_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.png`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function showScreenshot(video, tab = null) {
    const blob = await createScreenshotBlob(video);
    const objUrl = URL.createObjectURL(blob);
    let deleted = false, watcher = null;
    const del = () => {
      if (deleted) return;
      deleted = true;
      if (watcher) clearInterval(watcher);
      try { URL.revokeObjectURL(objUrl); } catch {}
    };
    let opened = false, shown = null;
    try {
      if (tab && !tab.closed) { tab.location.href = objUrl; opened = true; shown = tab; }
    } catch {}
    if (!opened && typeof GM_openInTab === 'function') {
      try { shown = GM_openInTab(objUrl, { active: true, insert: true, setParent: true }) || null; opened = true; } catch {}
    }
    if (!opened) {
      try { const w = window.open(objUrl, '_blank'); if (w) { opened = true; shown = w; } } catch {}
    }
    if (!opened) {
      del();
      saveScreenshotFile(blob);
      setStatus('无法打开新标签，已改为保存 PNG', 'warning');
      return;
    }
    if (tab && shown !== tab) {
      try { if (!tab.closed && tab.location.href === 'about:blank') tab.close(); } catch {}
    }
    if (shown) {
      watcher = setInterval(() => {
        let closed = false;
        try { closed = shown.closed === true; } catch { closed = true; }
        if (closed) del();
      }, 1000);
    }
    setTimeout(del, 10 * 60 * 1000);
  }
  async function captureCurrentFrame(tab = null) {
    if (state.screenshotBusy) { try { tab?.close(); } catch {} return; }
    state.screenshotBusy = true;
    screenshotBtn.disabled = true;
    let frame = null, obs = null;
    try {
      if (state.connecting) throw new Error('纯音频正在连接，请稍后再截图');
      if (state.waitingGesture) throw new Error('请先启动纯音频播放');
      if (!(state.enabled || state.connecting || state.waitingGesture)) {
        const v = getNativeVideo();
        await waitForVideoFrame(v);
        await showScreenshot(v, tab);
        setStatus('截图已在新标签页打开（关闭即删）', 'success');
        return;
      }
      setStatus('正在后台加载画面…', 'warning');
      frame = document.createElement('iframe');
      frame.title = '后台截图';
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('allow', "autoplay 'none'");
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: '640px', height: '360px', opacity: '0.01', pointerEvents: 'none', border: '0' });
      const muteAll = () => {
        try {
          const doc = frame?.contentDocument, win = frame?.contentWindow;
          if (!doc || !win) return;
          const visit = d => {
            if (!d) return;
            for (const m of d.querySelectorAll('video, audio')) {
              try { m.muted = true; m.volume = 0; } catch {}
            }
            for (const f of d.querySelectorAll('iframe')) try { visit(f.contentDocument); } catch {}
          };
          visit(doc);
          for (const p of [win.livePlayer, win.__LIVE_PLAYER__, win.player].filter(Boolean)) {
            try { p.setVolume?.(0); p.setMute?.(true); p.setMuted?.(true); } catch {}
          }
        } catch {}
      };
      frame.addEventListener('load', () => {
        muteAll();
        try {
          if (frame.contentDocument?.documentElement && !obs) {
            obs = new MutationObserver(muteAll);
            obs.observe(frame.contentDocument.documentElement, { childList: true, subtree: true });
          }
        } catch {}
      });
      document.body.appendChild(frame);
      frame.src = `${location.origin}/${state.roomId}`;
      const deadline = Date.now() + CONFIG.screenshotLoadTimeoutMs;
      let video = null;
      while (Date.now() < deadline) {
        if (!frame.isConnected) throw new Error('后台截图页面已关闭');
        muteAll();
        try {
          video = frame.contentDocument?.querySelector('#live-player video');
          if (video?.readyState >= 2 && video.videoWidth > 0) break;
        } catch {}
        await sleep(200);
      }
      if (!video?.videoWidth) throw new Error('等待后台视频超时');
      try { video.muted = true; video.volume = 0; } catch {}
      await waitForVideoFrame(video);
      muteAll();
      await showScreenshot(video, tab);
      setStatus('截图已在新标签页打开（关闭即删）', 'success');
    } catch (e) {
      try { if (tab && !tab.closed && tab.location.href === 'about:blank') tab.close(); } catch {}
      setStatus(`截图失败：${e?.message || e}`, 'error');
      console.error('[BLAO] screenshot', e);
    } finally {
      try { obs?.disconnect(); } catch {}
      try { frame?.remove(); } catch {}
      state.screenshotBusy = false;
      screenshotBtn.disabled = false;
    }
  }
  screenshotBtn.addEventListener('click', () => {
    let tab = null;
    try { tab = window.open('about:blank', '_blank'); } catch {}
    captureCurrentFrame(tab).catch(e => {
      try { if (tab && !tab.closed && tab.location.href === 'about:blank') tab.close(); } catch {}
      setStatus(`截图失败：${e?.message || e}`, 'error');
    });
  });
  autoStartBtn.addEventListener('click', () => {
    state.autoStartAudioOnly = !state.autoStartAudioOnly;
    GM_setValue('autoStartAudioOnly', state.autoStartAudioOnly);
    updateAutoStartBtn();
    refreshMenus(true);
    setStatus(state.autoStartAudioOnly ? '已开启默认启动纯音频' : '已关闭默认启动纯音频', 'success');
  });

  panel.append(panelHeader, button, screenshotBtn, autoStartBtn, status, traffic, settings);
  anchor.append(panel, minimizedWidget);

  function mountUi() {
    injectStyle();
    if (!document.documentElement.contains(anchor)) {
      (document.body || document.documentElement).appendChild(anchor);
      updatePanelWindowState(false);
    }
    syncPageButtonVisibility();
    applyCover();
    updateButton();
    if (!state.enabled && !state.connecting && !state.waitingGesture && !status.textContent) {
      setStatus(`房间 ${state.roomId} · 视频模式`);
    }
  }

  mountUi();
  waitForLivePlayer().then(p => enterWebFullscreen(p)).catch(() => {});
  refreshMenus(true);
  ensureFlvjs().then(() => log('info', 'flv.js 预加载完成')).catch(e => log('warn', 'flv.js 预加载未成功', { message: e?.message }));

  if (state.autoStartAudioOnly) {
    setTimeout(() => {
      if (state.autoStartAudioOnly && !state.enabled && !state.connecting) {
        toggleAudioOnly().catch(e => setStatus(`自动开启失败：${e?.message || e}`, 'error'));
      }
    }, 0);
  }

  setInterval(mountUi, 3000);
  let lastRoom = state.roomId;
  setInterval(() => {
    const next = getRoomId();
    if (!next || next === lastRoom) return;
    lastRoom = next;
    if (state.enabled || state.connecting) disableAudioOnly();
    state.roomId = next;
    state.coverUrl = '';
    setStatus(`房间 ${state.roomId} · 视频模式`);
    applyCover();
  }, 1000);

  window.addEventListener('beforeunload', () => {
    state.generation += 1;
    clearReconnect();
    stopWatchdog();
    unregisterMenus();
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    destroyAudioPipeline();
  });
})();
