// ==UserScript==
// @name         Bilibili Live Audio Only (Modified)
// @name:zh-CN   哔哩哔哩直播纯音频模式（修改版）
// @namespace    https://github.com/qponh/Bilibili-Live-Audio-Only-Modified-
// @version      1.4.35
// @description  Based on original by 天冰致琴. Adds audio-only playback with single-pipeline guards, stream refresh, volume, Bilibili web-fullscreen controls, and in-tab screenshots that are never written to disk.
// @description:zh-CN  基于原作者「天冰致琴」的脚本修改。为哔哩哔哩直播增加纯音频模式、封面背景、弹幕与音频控制，并显示流量；截图为“截图→新标签页打开→自动删除临时数据”，不写入本地文件。
// @author       qponh
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
// @downloadURL  https://raw.githubusercontent.com/qponh/Bilibili-Live-Audio-Only-Modified-/main/bilibili-live-audio-only.user.js
// @updateURL    https://raw.githubusercontent.com/qponh/Bilibili-Live-Audio-Only-Modified-/main/bilibili-live-audio-only.user.js
// @homepageURL  https://github.com/qponh/Bilibili-Live-Audio-Only-Modified-
// @supportURL   https://github.com/qponh/Bilibili-Live-Audio-Only-Modified-/issues
// ==/UserScript==

(() => {
  'use strict';

  // User-adjustable wait times are persisted by Tampermonkey.
  const CONFIG_DEFAULTS = {
    apiTimeoutMs: 10000,
    playerWaitMs: 6000,
    bufferTimeoutMs: 12000,
    mediaInitTimeoutMs: 4000,
    nativeRestoreTimeoutMs: 10000,
    screenshotFrameTimeoutMs: 10000,
    screenshotLoadTimeoutMs: 30000,
    reconnectDelayMs: 3000,
    watchdogMs: 1500,
    refreshStreamMs: 45 * 60 * 1000,
    maxReconnects: 8,
  };
  const CONFIG = {};
  for (const [key, fallback] of Object.entries(CONFIG_DEFAULTS)) {
    const saved = Number(GM_getValue(`wait_${key}`, fallback));
    CONFIG[key] = Number.isFinite(saved) && saved >= 500 && saved <= 300000 ? saved : fallback;
  }
  function saveWaitSetting(key, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    const bounded = Math.max(500, Math.min(300000, Math.round(n)));
    CONFIG[key] = bounded;
    GM_setValue(`wait_${key}`, bounded);
    return true;
  }

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
    panelRevealTimer: null,
    screenshotBusy: false,
    nativeSettings: null,
    streamHost: '',
    trafficSpeedKBps: null,
    trafficMonitorTimer: null,
  };

  if (!state.roomId) return;

  // Keep diagnostics as one plain-text console line so users can copy them without expanding objects.
  function logBLAO(level, message, data) {
    let line = `[BLAO] ${message}`;
    if (data !== undefined) {
      try {
        const normalized = data instanceof Error
          ? { name: data.name, message: data.message, stack: data.stack }
          : data;
        line += ` ${JSON.stringify(normalized)}`;
      } catch (err) {
        line += ` ${String(data)}`;
      }
    }
    const logger = console[level] || console.log;
    logger.call(console, line);
  }

  logBLAO('info', '脚本已加载', { version: '1.4.35', roomId: state.roomId, href: location.href });

  function getRoomId() {
    const m = location.pathname.match(/^\/(?:blanc\/)?(\d+)(?:\/|$)/);
    return m ? m[1] : '';
  }

  function getLivePlayer() {
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    return pageWindow.livePlayer || null;
  }

  function enterWebFullscreen(player = state.livePlayer || getLivePlayer()) {
    if (!player || typeof player.setFullscreenStatus !== 'function') return false;
    try {
      player.setFullscreenStatus(1);
      logBLAO('info', '请求开启网页全屏');
      return true;
    } catch (err) {
      logBLAO('warn', '开启网页全屏失败', { message: err?.message || String(err) });
      return false;
    }
  }
  function getNativeVideo() {
    return document.querySelector('#live-player video');
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitForLivePlayer() {
    const deadline = Date.now() + CONFIG.playerWaitMs;

    while (Date.now() < deadline) {
      const player = getLivePlayer();
      if (player && typeof player.stopPlayback === 'function') {
        return player;
      }
      await sleep(100);
    }

    const player = getLivePlayer();
    if (player && typeof player.stopPlayback === 'function') return player;

    throw new Error('B站播放器尚未就绪，请稍后再试');
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.apiTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function buildAudioApiUrl(roomId) {
    const p = new URLSearchParams({
      appkey: 'iVGUTjsxvpLeuDCf',
      build: '6215200',
      c_locale: 'zh_CN',
      channel: 'bili',
      codec: '0',
      device: 'android',
      device_name: 'VTR-AL00',
      dolby: '1',
      format: '0,2',
      free_type: '0',
      http: '1',
      mask: '0',
      mobi_app: 'android',
      network: 'wifi',
      no_playurl: '0',
      only_audio: '1',
      only_video: '0',
      platform: 'android',
      play_type: '0',
      protocol: '0,1',
      qn: '10000',
      s_locale: 'zh_CN',
      statistics: '{"appId":1,"platform":3,"version":"6.21.5","abtest":""}',
      ts: String(Math.floor(Date.now() / 1000)),
      room_id: String(roomId),
    });

    return `https://api.live.bilibili.com/xlive/app-room/v2/index/getRoomPlayInfo?${p}`;
  }

  async function getAudioOnlyUrl(roomId) {
    let response;

    try {
      response = await fetchWithTimeout(buildAudioApiUrl(roomId), {
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
        },
      });
    } catch (err) {
      throw new Error(`获取纯音频地址失败：${err?.message || err}`);
    }

    if (!response.ok) {
      throw new Error(`取流接口 HTTP ${response.status}`);
    }

    const json = await response.json();

    if (json.code !== 0) {
      throw new Error(`Bilibili 接口错误：${json.code} ${json.message || ''}`);
    }

    if (json.data?.live_status !== 1) {
      throw new Error('直播间当前未开播');
    }

    const streams = json.data?.playurl_info?.playurl?.stream || [];

    for (const stream of streams) {
      if (stream.protocol_name !== 'http_stream') continue;

      for (const format of stream.format || []) {
        if (format.format_name !== 'flv') continue;

        for (const codec of format.codec || []) {
          if (!codec?.base_url ||
              !Array.isArray(codec.url_info) ||
              codec.url_info.length === 0 ||
              codec.is_pushing === false) {
            continue;
          }

          const info =
            codec.url_info.find(item =>
              item?.host && !/^https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/i.test(item.host)
            ) || codec.url_info[0];

          if (!info?.host) continue;

          return `${info.host}${codec.base_url}${info.extra || ''}`
            .replace(/^http:\/\//i, 'https://');
        }
      }
    }

    throw new Error('接口没有返回可用的纯音频 FLV 地址');
  }

  function getCoverFromPage() {
    // Live-room initialization data contains the room's own cover more reliably
    // than og:image, which can be a generic Bilibili site image.
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const roomInfo = pageWindow.__NEPTUNE_IS_MY_WAIFU__?.roomInfoRes?.data?.room_info ||
      pageWindow.__INITIAL_STATE__?.roomInfo ||
      pageWindow.__INITIAL_STATE__?.room_info || {};
    const candidates = [
      roomInfo.cover,
      roomInfo.keyframe,
      roomInfo.user_cover,
      roomInfo.background,
      document.querySelector('#live-player .web-player-video-cover-img-wrap img')?.currentSrc,
      document.querySelector('#live-player .web-player-video-cover-img-wrap img')?.src,
      document.querySelector('meta[property="og:image"]')?.content,
      document.querySelector('meta[name="twitter:image"]')?.content,
      document.querySelector('link[rel="image_src"]')?.href,
    ];

    return candidates.find(v => /^https?:\/\//i.test(v || '')) || '';
  }

  async function fetchRoomCover(roomId) {
    try {
      const url =
        `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`;
      const response = await fetchWithTimeout(url, {
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' },
      }, 4000);

      if (!response.ok) return '';

      const json = await response.json();
      if (json.code !== 0 || !json.data) return '';

      return json.data.cover ||
        json.data.user_cover ||
        json.data.keyframe ||
        json.data.background ||
        '';
    } catch {
      return '';
    }
  }

  function applyCover() {
    const container = document.querySelector('#live-player');
    if (!container) return;

    const active = state.enabled || state.connecting;
    container.classList.toggle('blao-active', active);

    // A dedicated layer is required because #live-player's own background is
    // covered by opaque child wrappers in the current Bilibili player.
    let coverLayer = container.querySelector(':scope > #blao-cover-layer');
    if (active) {
      if (!coverLayer) {
        coverLayer = document.createElement('div');
        coverLayer.id = 'blao-cover-layer';
        coverLayer.setAttribute('aria-hidden', 'true');
        container.appendChild(coverLayer);
      }
      if (state.coverUrl) {
        coverLayer.style.backgroundImage = `url("${state.coverUrl.replace(/"/g, '\\"')}")`;
        coverLayer.style.display = 'block';
      } else {
        coverLayer.style.backgroundImage = 'none';
        coverLayer.style.display = 'none';
      }
    } else {
      coverLayer?.remove();
      container.style.removeProperty('--blao-cover');
    }

    suppressNativeErrorArtwork();
    ensureAudioToolbar();
    updateAudioToolbar();
  }

  function suppressNativeErrorArtwork() {
    if (!state.enabled && !state.connecting) return;

    const player = document.querySelector('#live-player');
    if (!player) return;

    const errorImages = player.querySelectorAll(
      'img[src*="error@1x.png"], img[src*="error@2x.png"], img[src*="/images/error"]'
    );

    // Hide only the error artwork itself. The previous size-based ancestor
    // hiding could accidentally hide the whole video layer, including danmaku,
    // room cover and control overlays, because they share the same dimensions.
    for (const img of errorImages) {
      img.style.setProperty('display', 'none', 'important');
      const parent = img.parentElement;
      const parentLabel = `${parent?.id || ''} ${typeof parent?.className === 'string' ? parent.className : ''}`;
      if (parent && /error|offline|player-tip/i.test(parentLabel)) {
        parent.style.setProperty('display', 'none', 'important');
      }
    }
  }

  function loadCoverInBackground(roomId, generation) {
    if (!state.coverUrl) {
      state.coverUrl = getCoverFromPage();
      applyCover();
    }

    fetchRoomCover(roomId).then(url => {
      if (!url || generation !== state.generation) return;
      state.coverUrl = url;
      applyCover();
    });
  }

  function captureNativeSettings() {
    captureNativeVolume();
    const player = getLivePlayer();
    let danmaku = null;
    try {
      const info = player?.getPlayerInfo?.();
      const candidates = [
        info?.danmaku?.enabled, info?.danmaku?.status,
        info?.setting?.danmaku, info?.settings?.danmaku,
      ];
      const value = candidates.find(v => typeof v === 'boolean');
      if (typeof value === 'boolean') danmaku = value;
    } catch {}
    if (danmaku === null) {
      const controls = [...document.querySelectorAll('#live-player button, #live-player [role="button"]')];
      const button = controls.find(el => /弹幕|danmaku/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`));
      if (button) {
        const pressed = button.getAttribute('aria-pressed');
        const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.textContent || ''}`;
        if (pressed === 'true' || pressed === 'false') danmaku = pressed === 'true';
        else if (/关闭弹幕|关闭.*danmaku/i.test(label)) danmaku = true;
        else if (/开启弹幕|打开弹幕|开启.*danmaku/i.test(label)) danmaku = false;
      }
    }
    state.nativeSettings = { volume: state.volume, muted: state.muted, danmaku };
  }

  async function restoreNativeSettings(player) {
    const saved = state.nativeSettings;
    if (!saved) return;
    // reload() recreates Bilibili's player asynchronously; wait for its media/control layer.
    const deadline = Date.now() + CONFIG.nativeRestoreTimeoutMs;
    while (Date.now() < deadline) {
      const video = getNativeVideo();
      if (video) {
        try {
          video.volume = saved.volume;
          video.muted = saved.muted;
        } catch {}
        try {
          if (player?.setVolume && Number.isFinite(saved.volume)) {
            player.setVolume(Math.round(saved.volume * 100));
          }
        } catch {}
        break;
      }
      await sleep(150);
    }
    if (typeof saved.danmaku === 'boolean') {
      // Only toggle when the current state is explicitly exposed by the page controls.
      const controls = [...document.querySelectorAll('#live-player button, #live-player [role="button"]')];
      const button = controls.find(el => /弹幕|danmaku/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`));
      if (button) {
        const pressed = button.getAttribute('aria-pressed');
        const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.textContent || ''}`;
        let current = null;
        if (pressed === 'true' || pressed === 'false') current = pressed === 'true';
        else if (/关闭弹幕|关闭.*danmaku/i.test(label)) current = true;
        else if (/开启弹幕|打开弹幕|开启.*danmaku/i.test(label)) current = false;
        if (current !== null && current !== saved.danmaku) button.click();
      }
    }
  }

  function captureNativeVolume() {
    const player = getLivePlayer();

    try {
      const info = player?.getPlayerInfo?.();
      const value = info?.volume?.value;
      const disabled = info?.volume?.disabled;

      if (typeof value === 'number' && Number.isFinite(value)) {
        state.volume = Math.max(0, Math.min(1, value / 100));
      }
      if (typeof disabled === 'boolean') {
        state.muted = disabled;
      }
    } catch {
    }

    const video = getNativeVideo();
    if (video) {
      if (Number.isFinite(video.volume)) state.volume = video.volume;
      state.muted = video.muted;
    }
  }

  function stopNativePlayer() {
    const player = state.livePlayer || getLivePlayer();

    if (!player || typeof player.stopPlayback !== 'function') {
      throw new Error('无法调用 B站播放器 stopPlayback()');
    }

    player.stopPlayback();
    state.nativeStopped = true;
  }

  // Bilibili may remove or replace native control handlers when stopPlayback()
  // is called. Use an explicit toolbar inside the player instead of relying on
  // private Bilibili DOM labels and event handlers.
  function updateNativeVolumeControlState() {
    const media = state.mediaElement;
    const container = document.querySelector('#live-player');
    if (!media || !container) return;
    container.dataset.blaoAudioPaused = media.paused ? '1' : '0';
    container.dataset.blaoAudioMuted = (media.muted || media.volume === 0) ? '1' : '0';
    container.dataset.blaoAudioVolume = String(media.volume);
  }

  let audioToolbar = null;
  let audioPlayButton = null;
  let audioRefreshButton = null;
  let audioMuteButton = null;
  let audioVolumeSlider = null;
  let audioStateLabel = null;

  async function refreshAudioStreamManually() {
    if (!state.enabled || state.connecting) return;
    const generation = state.generation;
    const wasPlaying = Boolean(state.mediaElement && !state.mediaElement.paused);

    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }
    clearReconnect();
    state.connecting = true;
    updateAudioToolbar();
    setStatus('正在刷新音频流…', 'warning');

    try {
      const url = await getAudioOnlyUrl(state.roomId);
      if (!state.enabled || generation !== state.generation) return;
      createAudioPipeline(url, generation);
      if (wasPlaying) {
        await playAudioMedia();
      }
      if (!state.enabled || generation !== state.generation) return;
      state.connecting = false;
      setStatus('音频流已刷新', 'success');
      scheduleRefresh(generation);
    } catch (err) {
      state.connecting = false;
      setStatus(`刷新音频流失败：${err?.message || err}`, 'error');
      if (state.enabled && generation === state.generation) {
        scheduleReconnect('手动刷新失败');
      }
    } finally {
      updateAudioToolbar();
    }
  }

  function findBilibiliWebModeControl() {
    // The current live-room player uses a Svelte controller. Prefer the visible
    // native "网页模式" control in its right-area, then fall back to the legacy
    // dedicated web-fullscreen button. Never click an arbitrary right-area button.
    const isVisible = (el) => {
      if (!el?.getClientRects?.().length) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
    };
    const labelOf = (el) => {
      if (!el) return '';
      const attrs = [
        el.getAttribute?.('aria-label'), el.getAttribute?.('title'),
        el.getAttribute?.('data-title'), el.getAttribute?.('data-text'),
        el.getAttribute?.('data-tip'), el.getAttribute?.('data-tooltip'),
        el.getAttribute?.('aria-description'),
        typeof el.className === 'string' ? el.className : '',
        el.textContent || '',
      ];
      // Tooltips/icons are sometimes placed inside the clickable wrapper.
      for (const n of el.querySelectorAll?.('[title], [data-title], [data-text], [data-tip], [data-tooltip], [aria-label], title, use') || []) {
        attrs.push(
          n.getAttribute?.('aria-label') || '', n.getAttribute?.('title') || '',
          n.getAttribute?.('data-title') || '', n.getAttribute?.('data-text') || '',
          n.getAttribute?.('data-tip') || '', n.getAttribute?.('data-tooltip') || '',
          n.textContent || '', n.getAttribute?.('href') || '', n.getAttribute?.('xlink:href') || ''
        );
      }
      return attrs.filter(Boolean).join(' ').replace(/\s+/g, ' ').toLowerCase();
    };
    const isWebModeLabel = (el) => {
      if (!el || el.closest?.('#blao-audio-toolbar')) return false;
      const label = labelOf(el);
      return /网页模式|退出网页模式|网页全屏|退出网页全屏|web\s*mode|web.?screen|web.?fullscreen|fullscreen.?web|page.?full/.test(label);
    };
    const toClickableControl = (el, boundary) => {
      if (!el || !boundary) return null;
      // The label may be carried by an inner icon/tooltip. Find its nearest
      // interactive ancestor without climbing out of this specific control.
      for (let node = el; node && node !== boundary; node = node.parentElement) {
        if (node.matches?.('button, [role="button"], [tabindex], [data-title], [title], [aria-label]')) {
          return node;
        }
      }
      // Live-room Svelte controls can be clickable divs without role/tabindex.
      // The native control's direct child in .right-area is the correct target.
      let node = el;
      while (node?.parentElement && node.parentElement !== boundary) node = node.parentElement;
      return node && node !== boundary ? node : el;
    };

    // Current live-room native controller: its buttons are labeled "网页模式"
    // and "全屏模式" (not necessarily "网页全屏"). The whole bar is mounted
    // dynamically when the pointer enters the bottom of the player.
    const rightArea = document.querySelector(
      '#web-player-controller-wrap-el .live-web-player-controller .right-area, ' +
      '.live-web-player-controller .right-area'
    );
    if (rightArea && isVisible(rightArea)) {
      const directChildren = Array.from(rightArea.children)
        .filter(el => !el.matches?.('.ext-nodes, .blao-audio-toolbar') && !el.closest?.('#blao-audio-toolbar'));
      for (const child of directChildren) {
        if (isVisible(child) && isWebModeLabel(child)) {
          return toClickableControl(child, rightArea);
        }
        // A nested element can own the tooltip while the direct child is the
        // actual clickable Svelte item.
        for (const nested of child.querySelectorAll?.('*') || []) {
          if (isVisible(nested) && isWebModeLabel(nested)) {
            return toClickableControl(nested, rightArea);
          }
        }
      }
    }

    // Older/legacy live player DOM, checked explicitly. These selectors were
    // previously listed but accidentally excluded by slicing the selector list.
    const legacySelectors = [
      '.bilibili-live-player-video-controller-web-fullscreen-btn button',
      '.bilibili-live-player-video-controller-web-fullscreen-btn [role="button"]',
      '.bilibili-live-player-video-controller-web-fullscreen-btn',
      'button[data-title="网页模式"]', '[role="button"][data-title="网页模式"]',
      'button[title="网页模式"]', '[role="button"][title="网页模式"]',
      'button[aria-label="网页模式"]', '[role="button"][aria-label="网页模式"]',
      'button[data-title="网页全屏"]', 'button[data-title="退出网页全屏"]',
      'button[title="网页全屏"]', 'button[title="退出网页全屏"]',
    ];
    for (const selector of legacySelectors) {
      let elements = [];
      try { elements = document.querySelectorAll(selector); } catch {}
      for (const el of elements) {
        if (isVisible(el) && !el.closest?.('#blao-audio-toolbar')) return el;
      }
    }

    // Last, inspect the native bar by semantic labels only. Do not return the
    // first generic button from .right-area, because that can be "全屏模式".
    if (rightArea) {
      for (const el of rightArea.querySelectorAll('button, [role="button"], [tabindex], [title], [data-title], [aria-label]')) {
        if (isVisible(el) && isWebModeLabel(el)) return el;
      }
    }
    return null;
  }

  function isBilibiliWebModeActive() {
    // Current live-room player marks web mode by making #fullscreen-container
    // the Fullscreen API element. The room container's CSS class may remain
    // "normal", so class-name checks alone are not reliable.
    const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    const target = document.querySelector('#fullscreen-container');
    if (target && fullscreen === target) return true;

    // Compatibility with old player implementations that change the native
    // button label after entering web mode.
    const exitControl = document.querySelector(
      '.bilibili-live-player-video-controller-web-fullscreen-btn button[data-title*="退出"], ' +
      '.bilibili-live-player-video-controller-web-fullscreen-btn button[title*="退出"], ' +
      '#web-player-controller-wrap-el [data-title="退出网页模式"], ' +
      '#web-player-controller-wrap-el [title="退出网页模式"], ' +
      '#web-player-controller-wrap-el [aria-label="退出网页模式"]'
    );
    if (exitControl && exitControl.getClientRects?.().length) return true;
    return false;
  }

  function getWebModeDiagnosticSnapshot() {
    const selectors = [
      '#web-player-controller-wrap-el',
      '#web-player-controller-wrap-el .live-web-player-controller',
      '#web-player-controller-wrap-el .live-web-player-controller .right-area',
      '.live-web-player-controller .right-area',
      '#web-player-controller-wrap-el .live-web-player-controller .right-area > *',
      '.bilibili-live-player-video-controller-web-fullscreen-btn',
      '.bilibili-live-player-video-controller-web-fullscreen-btn button',
      '#fullscreen-container', '#live-player-ctnr', '#live-player'
    ];
    const counts = {};
    for (const selector of selectors) {
      try { counts[selector] = document.querySelectorAll(selector).length; }
      catch (err) { counts[selector] = `ERROR: ${err.message}`; }
    }
    const roots = [
      document.querySelector('#web-player-controller-wrap-el'),
      document.querySelector('#live-player-ctnr'),
      document.querySelector('#live-player')
    ].filter(Boolean);
    const candidates = [];
    const seen = new Set();
    for (const root of roots) {
      for (const el of root.querySelectorAll('button, [role="button"], [tabindex], [class*="fullscreen"], [class*="webscreen"], [class*="web-full"]')) {
        if (seen.has(el)) continue;
        seen.add(el);
        const text = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-title'), el.getAttribute('data-text'), el.className, el.textContent]
          .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 180);
        const rect = el.getBoundingClientRect();
        candidates.push({
          tag: el.tagName,
          text,
          visible: Boolean(el.getClientRects().length) && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden',
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          html: (el.outerHTML || '').slice(0, 180)
        });
      }
    }
    return {
      href: location.href,
      roomId: state.roomId,
      controllerLabels: Array.from(document.querySelectorAll('#web-player-controller-wrap-el .live-web-player-controller .right-area > *'))
        .slice(0, 12).map(el => [el.tagName, String(el.className || '').slice(0, 90), [el.getAttribute('title'), el.getAttribute('data-title'), el.getAttribute('aria-label'), el.textContent].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 100)]),
      urlPath: location.pathname,
      fullscreenElement: document.fullscreenElement ? `${document.fullscreenElement.tagName}#${document.fullscreenElement.id || ''}.${String(document.fullscreenElement.className || '').slice(0, 100)}` : null,
      counts,
      candidates: candidates.slice(0, 15)
    };
  }

  function toggleBilibiliWebFullscreen(attempt = 0) {
    if (attempt === 0) {
      logBLAO('info', '收到网页模式按钮点击，优先扫描新版 Svelte 原生控制栏');
      setStatus('网页模式诊断：正在扫描 B 站原生控件…', 'warning');
    }
    const match = findBilibiliWebModeControl();
    if (match) {
      const wasActive = isBilibiliWebModeActive();
      const details = {
        tag: match.tagName,
        title: match.getAttribute?.('data-title') || match.getAttribute?.('title') || match.getAttribute?.('aria-label') || '',
        className: typeof match.className === 'string' ? match.className : '',
        html: (match.outerHTML || '').slice(0, 700)
      };
      logBLAO('info', '找到候选原生控件，准备点击', details);
      try {
        match.click();
      } catch (err) {
        logBLAO('error', '点击原生控件抛出异常', { error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err), details });
        setStatus(`点击 B 站控件失败：${err?.message || err}`, 'error');
        return;
      }
      setStatus('已点击候选控件，正在检查模式是否改变…', 'warning');
      setTimeout(() => {
        const isActive = isBilibiliWebModeActive();
        const snapshot = getWebModeDiagnosticSnapshot();
        if (isActive !== wasActive) {
          logBLAO('info', '网页模式状态已变化', { wasActive, isActive, details, snapshot });
          setStatus(isActive ? 'B 站网页全屏已开启' : '已退出 B 站网页全屏', 'success');
        } else {
          logBLAO('warn', '找到并点击了候选控件，但模式状态未变化', { wasActive, isActive, details, snapshot });
          setStatus('已点到候选控件，但模式未变化。请复制 Console 中对应的 [BLAO] 单行文本日志发来。', 'error');
        }
      }, 900);
      return;
    }

    if (attempt === 0) {
      const playerContainer = document.querySelector('#live-player-ctnr, .live-player-ctnr, #live-player');
      const rect = playerContainer?.getBoundingClientRect();
      if (playerContainer && rect && rect.width > 0 && rect.height > 0) {
        const x = Math.max(rect.left + 2, Math.min(rect.right - 2, rect.right - 24));
        const y = Math.max(rect.top + 2, Math.min(rect.bottom - 2, rect.bottom - 18));
        for (const type of ['mouseenter', 'mousemove', 'mouseover']) {
          playerContainer.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window, clientX: x, clientY: y }));
        }
        document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, view: window, clientX: x, clientY: y }));
      }
    }
    if (attempt < 12) {
      setTimeout(() => toggleBilibiliWebFullscreen(attempt + 1), 200);
      return;
    }
    const snapshot = getWebModeDiagnosticSnapshot();
    logBLAO('warn', '多次扫描仍未找到网页模式控件（已扫描新版与旧版控件）', snapshot);
    setStatus('未找到 B 站网页模式按钮。诊断日志已输出到 Console，筛选 [BLAO] 后复制对应的一整行文本日志；本版本日志不需要展开对象。', 'error');
  }

  function pauseAudioStreamForReal() {
    if (state.userPaused) return;
    state.userPaused = true;
    state.generation += 1; // Invalidate pending URL/refresh/reconnect work.
    if (state.refreshTimer) { clearTimeout(state.refreshTimer); state.refreshTimer = null; }
    clearReconnect();
    state.trafficSpeedKBps = 0;
    destroyAudioPipeline(); // pause() alone does not stop a live flv.js download.
    updateTraffic();
    updateAudioToolbar();
    setStatus('已暂停：音频流已停止；恢复播放时会重新连接', 'success');
  }

  async function resumeAudioStream() {
    if (!state.enabled || state.connecting || !state.userPaused) return;
    const generation = state.generation;
    state.connecting = true;
    updateAudioToolbar();
    setStatus('正在重新连接音频流…', 'warning');
    try {
      const url = await getAudioOnlyUrl(state.roomId);
      if (!state.enabled || generation !== state.generation) return;
      try { state.streamHost = new URL(url).hostname; } catch { state.streamHost = ''; }
      const media = createAudioPipeline(url, generation);
      await waitForAudioBuffer(media);
      if (!state.enabled || generation !== state.generation) return;
      state.userPaused = false;
      state.connecting = false;
      await playAudioMedia();
      if (!state.enabled || generation !== state.generation) return;
      scheduleRefresh(generation);
      updateAudioToolbar();
    } catch (err) {
      if (generation === state.generation) {
        state.connecting = false;
        state.userPaused = true;
        destroyAudioPipeline();
        setStatus(`恢复播放失败：${err?.message || err}`, 'error');
        updateAudioToolbar();
      }
    }
  }

  function ensureAudioToolbar() {
    const container = document.querySelector('#live-player');
    if (!container) return;
    if (audioToolbar && audioToolbar.isConnected && audioToolbar.parentElement === container) return;

    audioToolbar = document.createElement('div');
    audioToolbar.id = 'blao-audio-toolbar';
    audioToolbar.setAttribute('aria-label', '纯音频控制栏');

    audioPlayButton = document.createElement('button');
    audioPlayButton.type = 'button';
    audioPlayButton.addEventListener('click', () => {
      const media = state.mediaElement;
      if (state.userPaused || !media) {
        resumeAudioStream().catch(err => setStatus(`恢复播放失败：${err?.message || err}`, 'error'));
      } else if (media.paused) {
        // If media was paused by the browser, treat this as a real stream stop too.
        pauseAudioStreamForReal();
      } else {
        pauseAudioStreamForReal();
      }
      updateAudioToolbar();
    });

    audioRefreshButton = document.createElement('button');
    audioRefreshButton.type = 'button';
    audioRefreshButton.textContent = '↻';
    audioRefreshButton.title = '刷新音频流';
    audioRefreshButton.setAttribute('aria-label', '刷新音频流');
    audioRefreshButton.addEventListener('click', () => {
      refreshAudioStreamManually().catch(err => {
        setStatus(`刷新音频流失败：${err?.message || err}`, 'error');
      });
    });

    audioMuteButton = document.createElement('button');
    audioMuteButton.type = 'button';
    audioMuteButton.addEventListener('click', () => {
      const media = state.mediaElement;
      const muted = media ? (media.muted || media.volume === 0) : state.muted;
      if (muted) {
        state.muted = false;
        if (media) {
          media.muted = false;
          if (media.volume === 0) media.volume = state.volume > 0 ? state.volume : 1;
        }
      } else {
        state.muted = true;
        if (media) media.muted = true;
      }
      updateAudioToolbar();
    });

    audioVolumeSlider = document.createElement('input');
    audioVolumeSlider.type = 'range';
    audioVolumeSlider.min = '0';
    audioVolumeSlider.max = '100';
    audioVolumeSlider.step = '1';
    audioVolumeSlider.setAttribute('aria-label', '音量');
    audioVolumeSlider.addEventListener('input', () => {
      const media = state.mediaElement;
      const value = Number(audioVolumeSlider.value) / 100;
      state.volume = value;
      if (media) {
        media.volume = value;
        if (value > 0 && media.muted) media.muted = false;
        state.muted = media.muted;
      } else if (value > 0) {
        state.muted = false;
      } else {
        state.muted = true;
      }
      updateAudioToolbar();
    });

    const spacer = document.createElement('span');
    spacer.className = 'blao-audio-spacer';

    audioStateLabel = document.createElement('span');
    audioStateLabel.className = 'blao-audio-state';
    audioToolbar.append(audioPlayButton, audioRefreshButton, audioMuteButton, audioVolumeSlider, spacer, audioStateLabel);
    container.appendChild(audioToolbar);
  }

  function updateAudioToolbar() {
    ensureAudioToolbar();
    if (!audioToolbar) return;

    const active = state.enabled || state.connecting || state.waitingGesture;
    audioToolbar.style.display = active ? 'flex' : 'none';
    const media = state.mediaElement;

    if (audioPlayButton) {
      audioPlayButton.textContent = media && !media.paused ? '❚❚' : '▶';
      audioPlayButton.setAttribute('aria-label', media && !media.paused ? '暂停音频' : '播放音频');
      audioPlayButton.disabled = !state.enabled || state.connecting;
      // A deliberate pause destroys the media element; the play button must remain usable.
      if (state.userPaused && state.enabled && !state.connecting) audioPlayButton.disabled = false;
    }
    if (audioRefreshButton) {
      audioRefreshButton.disabled = !state.enabled || state.connecting || state.userPaused;
      audioRefreshButton.textContent = state.connecting ? '…' : '↻';
    }
    if (audioMuteButton) {
      const muted = !media || media.muted || media.volume === 0;
      audioMuteButton.textContent = muted ? '🔇' : '🔊';
      audioMuteButton.setAttribute('aria-label', muted ? '取消静音' : '静音');
      audioMuteButton.disabled = !state.enabled || state.connecting;
    }
    if (audioVolumeSlider) {
      if (document.activeElement !== audioVolumeSlider) {
        audioVolumeSlider.value = String(Math.round((media ? media.volume : state.volume) * 100));
      }
      audioVolumeSlider.disabled = !state.enabled || state.connecting;
    }
    if (audioStateLabel) {
      audioStateLabel.textContent = state.connecting
        ? '正在连接…'
        : state.waitingGesture
          ? '点击播放'
          : state.userPaused
          ? '已暂停（流已停止）'
          : media && media.paused
            ? '已暂停'
            : '纯音频播放中';
    }
  }

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

  function createAudioPipeline(url, generation = state.generation) {
    // There must be exactly one owned FLV pipeline at a time. A generation token
    // prevents late async work from a previous toggle from creating an orphan stream.
    destroyAudioPipeline();

    if (!window.flvjs || typeof window.flvjs.createPlayer !== 'function') {
      throw new Error('flv.js 未加载');
    }

    if (!window.flvjs.isSupported()) {
      throw new Error('当前浏览器不支持 flv.js / MSE');
    }

    const media = document.createElement('video');
    media.id = 'blao-audio-media';
    media.style.display = 'none';
    media.autoplay = false;
    media.controls = false;
    media.preload = 'auto';
    media.volume = state.volume;
    media.muted = state.muted;
    document.body.appendChild(media);

    const player = window.flvjs.createPlayer({
      type: 'flv',
      isLive: true,
      hasVideo: false,
      hasAudio: true,
      url,
    }, {
      enableWorker: false,
      enableStashBuffer: false,
      stashInitialSize: 128,
      lazyLoad: false,
      deferLoadAfterSourceOpen: false,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 30,
      autoCleanupMinBackwardDuration: 15,
    });

    state.mediaElement = media;
    state.flvPlayer = player;
    state.pipelineGeneration = generation;

    media.addEventListener('play', () => {
      if (state.mediaElement !== media) return;
      updateNativeVolumeControlState(); updateAudioToolbar();
    });
    media.addEventListener('pause', () => {
      if (state.mediaElement !== media) return;
      updateNativeVolumeControlState(); updateAudioToolbar();
    });
    media.addEventListener('volumechange', () => {
      if (state.mediaElement !== media) return;
      updateNativeVolumeControlState(); updateAudioToolbar();
    });
    player.attachMediaElement(media);
    updateNativeVolumeControlState();
    updateAudioToolbar();

    // flv.js statisticsInfo.speed is the recent download rate in KB/s, not a
    // cumulative byte counter. Register before load() so the first report is not missed.
    if (window.flvjs.Events?.STATISTICS_INFO) {
      player.on(window.flvjs.Events.STATISTICS_INFO, info => {
        if (state.flvPlayer !== player || state.mediaElement !== media) return;
        const speed = Number(info?.speed);
        state.trafficSpeedKBps = Number.isFinite(speed) && speed >= 0 ? speed : null;
        updateTraffic();
      });
    }

    player.load();

    if (window.flvjs.Events?.ERROR) {
      player.on(window.flvjs.Events.ERROR, () => {
        if (state.flvPlayer === player && state.mediaElement === media && state.enabled) {
          scheduleReconnect('音频流中断');
        }
      });
    }

    media.addEventListener('stalled', () => {
      if (state.mediaElement === media && state.flvPlayer === player && state.enabled) {
        scheduleReconnect('音频缓冲中断');
      }
    });

    return media;
  }

  function getBufferedSeconds(media) {
    try {
      if (!media?.buffered || media.buffered.length === 0) return 0;

      let total = 0;
      for (let i = 0; i < media.buffered.length; i += 1) {
        total += Math.max(0, media.buffered.end(i) - media.buffered.start(i));
      }
      return total;
    } catch {
      return 0;
    }
  }

  async function waitForAudioBuffer(media, timeoutMs = CONFIG.bufferTimeoutMs) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      if (media !== state.mediaElement) {
        throw new Error('纯音频播放器已被替换');
      }

      const bufferedSeconds = getBufferedSeconds(media);

      if (media.readyState >= 2 || bufferedSeconds >= 0.15) {
        setStatus(
          bufferedSeconds > 0
            ? `纯音频已缓冲 ${bufferedSeconds.toFixed(1)} 秒，正在切换…`
            : '纯音频已就绪，正在切换…',
          'warning'
        );
        return;
      }

      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      setStatus(
        bufferedSeconds > 0
          ? `正在缓冲纯音频… ${bufferedSeconds.toFixed(1)} 秒`
          : `正在缓冲纯音频… ${elapsed} 秒`,
        'warning'
      );

      await sleep(200);
    }

    const bufferedSeconds = getBufferedSeconds(media);
    throw new Error(
      `纯音频缓冲超时（readyState=${media.readyState}, buffered=${bufferedSeconds.toFixed(1)}s）`
    );
  }

  async function waitForMediaInit(media, timeoutMs = CONFIG.mediaInitTimeoutMs) {
    if (!media) return;

    if (media.readyState >= 1) {
      await sleep(80);
      return;
    }

    await new Promise(resolve => {
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        media.removeEventListener('loadedmetadata', finish);
        media.removeEventListener('canplay', finish);
        resolve();
      };

      const timer = setTimeout(finish, timeoutMs);
      media.addEventListener('loadedmetadata', finish, { once: true });
      media.addEventListener('canplay', finish, { once: true });
    });

    await sleep(80);
  }

  async function playAudioMedia() {
    const media = state.mediaElement;
    if (!media) throw new Error('纯音频播放器未创建');

    await waitForMediaInit(media);

    let lastError = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (media !== state.mediaElement) {
        throw new Error('纯音频播放器已被替换');
      }

      try {
        await media.play();

        state.waitingGesture = false;
        state.reconnectCount = 0;
        setStatus('纯音频播放中，弹幕和聊天保留', 'success');
        updateButton();
        return true;
      } catch (err) {
        lastError = err;

        if (err?.name === 'NotAllowedError') {
          state.waitingGesture = true;
          setStatus('浏览器阻止自动播放，请再点一次“播放音频”', 'warning');
          updateButton();
          return false;
        }

        if (err?.name === 'AbortError' ||
            /interrupted by a call to pause/i.test(String(err?.message || ''))) {
          await sleep(180 + attempt * 180);
          continue;
        }

        throw err;
      }
    }

    throw lastError || new Error('纯音频播放启动失败');
  }

  function startWatchdog() {
    stopWatchdog();

    state.watchdogTimer = setInterval(() => {
      if (!state.enabled) return;

      suppressNativeErrorArtwork();

      const video = getNativeVideo();
      if (!video) return;

      const src = video.currentSrc || video.src || '';

      if (src.startsWith('blob:') && !video.paused) {
        try {
          (state.livePlayer || getLivePlayer())?.stopPlayback?.();
          state.nativeStopped = true;
        } catch {
        }
      }
    }, CONFIG.watchdogMs);
  }

  function stopWatchdog() {
    if (state.watchdogTimer) {
      clearInterval(state.watchdogTimer);
      state.watchdogTimer = null;
    }
  }

  function scheduleRefresh(generation) {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);

    state.refreshTimer = setTimeout(async () => {
      state.refreshTimer = null;
      if (!state.enabled || state.userPaused || generation !== state.generation) return;

      try {
        const url = await getAudioOnlyUrl(state.roomId);
        if (!state.enabled || state.userPaused || generation !== state.generation) return;
        createAudioPipeline(url, generation);
        await playAudioMedia();
        scheduleRefresh(generation);
      } catch (err) {
        if (state.enabled && generation === state.generation) {
          setStatus(`刷新音频流失败：${err?.message || err}`, 'error');
          scheduleReconnect('刷新失败');
        }
      }
    }, CONFIG.refreshStreamMs);
  }

  function clearReconnect() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function scheduleReconnect(reason) {
    if (!state.enabled || state.userPaused || state.reconnectTimer) return;

    if (state.reconnectCount >= CONFIG.maxReconnects) {
      setStatus('自动重连次数已用完，请关闭后重新开启', 'error');
      return;
    }

    state.reconnectCount += 1;
    const generation = state.generation;

    setStatus(
      `${reason}，${CONFIG.reconnectDelayMs / 1000} 秒后重连（${state.reconnectCount}/${CONFIG.maxReconnects}）`,
      'warning'
    );

    state.reconnectTimer = setTimeout(async () => {
      state.reconnectTimer = null;
      if (!state.enabled || state.userPaused || generation !== state.generation) return;

      try {
        const url = await getAudioOnlyUrl(state.roomId);
        if (!state.enabled || state.userPaused || generation !== state.generation) return;
        createAudioPipeline(url, generation);
        await playAudioMedia();
        scheduleRefresh(generation);
      } catch (err) {
        setStatus(`重连失败：${err?.message || err}`, 'error');
        scheduleReconnect('继续重连');
      }
    }, CONFIG.reconnectDelayMs);
  }

  async function enableAudioOnly() {
    if (state.connecting || state.enabled) return;

    state.connecting = true;
    state.userPaused = false;
    state.trafficSpeedKBps = null;
    state.streamHost = '';
    updateTraffic();
    state.generation += 1;
    const generation = state.generation;
    updateButton();
    setStatus('正在获取纯音频地址…', 'warning');

    state.coverUrl = getCoverFromPage();
    loadCoverInBackground(state.roomId, generation);

    try {
      let url;
      let livePlayer;

      if (state.autoStartAudioOnly) {
        // In default-audio mode, stop the native video as soon as its player API
        // is ready, rather than waiting for the audio stream to finish buffering.
        livePlayer = await waitForLivePlayer();
        if (generation !== state.generation) return;

        state.livePlayer = livePlayer;
        enterWebFullscreen(livePlayer);
        captureNativeSettings();
        stopNativePlayer();

        url = await getAudioOnlyUrl(state.roomId);
        if (generation !== state.generation || !state.connecting) return;
      } else {
        [url, livePlayer] = await Promise.all([
          getAudioOnlyUrl(state.roomId),
          waitForLivePlayer(),
        ]);

        if (generation !== state.generation) return;

        state.livePlayer = livePlayer;
        enterWebFullscreen(livePlayer);
        captureNativeSettings();
      }

      try { state.streamHost = new URL(url).hostname; } catch { state.streamHost = ''; }

      setStatus('正在缓冲纯音频…', 'warning');
      const media = createAudioPipeline(url, generation);
      await waitForAudioBuffer(media);

      if (generation !== state.generation) return;

      if (!state.nativeStopped) {
        enterWebFullscreen(livePlayer);
        stopNativePlayer();
      }

      state.enabled = true;
      state.connecting = false;
      applyCover();
      updateAudioToolbar();

      await playAudioMedia();

      startWatchdog();
      scheduleRefresh(generation);
      updateButton();
    } catch (err) {
      // An enable attempt may finish after the user has already toggled the mode
      // off or started a newer attempt. Only its own generation may clean up state.
      if (generation !== state.generation) {
        if (state.pipelineGeneration === generation) destroyAudioPipeline();
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

      setStatus(`开启失败：${err?.message || err}`, 'error');
      console.error('[Bilibili Live Audio Only]', err);
    }
  }

  async function resumeAfterGesture() {
    try {
      await playAudioMedia();
    } catch (err) {
      setStatus(`播放失败：${err?.message || err}`, 'error');
    }
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

    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }

    destroyAudioPipeline();

    const player = state.livePlayer || getLivePlayer();

    let restorePromise = Promise.resolve();
    if (state.nativeStopped && player && typeof player.reload === 'function') {
      try {
        player.reload();
        restorePromise = restoreNativeSettings(player);
        setStatus('正在恢复视频及播放器设置…', 'warning');
        restorePromise.then(() => setStatus('已恢复视频模式（已尝试还原音量与弹幕设置）', 'success'))
          .catch(() => setStatus('视频已恢复，但部分设置可能未还原', 'warning'));
      } catch {
        setStatus('恢复视频失败，请刷新页面', 'error');
      }
    } else {
      setStatus('已关闭纯音频模式', '');
    }

    state.nativeStopped = false;
    state.livePlayer = null;
    applyCover();
    updateButton();
  }

  const anchor = document.createElement('div');
  anchor.id = 'blao-anchor';

  const hotzone = document.createElement('div');
  hotzone.id = 'blao-hotzone';

  const panel = document.createElement('div');
  panel.id = 'blao-panel';

  const button = document.createElement('button');
  button.id = 'blao-button';

  const status = document.createElement('div');
  status.id = 'blao-status';

  const screenshotButton = document.createElement('button');
  screenshotButton.id = 'blao-screenshot-button';
  screenshotButton.type = 'button';
  screenshotButton.textContent = '截取当前帧';
  screenshotButton.title = '截图后在新标签页打开；关闭该标签页即自动删除临时图片数据，不写入本地文件';

  const autoStartButton = document.createElement('button');
  autoStartButton.id = 'blao-auto-start-button';
  autoStartButton.type = 'button';

  function updateAutoStartButton() {
    autoStartButton.textContent = `默认启动纯音频：${state.autoStartAudioOnly ? '已开启' : '已关闭'}`;
    autoStartButton.setAttribute('aria-pressed', String(state.autoStartAudioOnly));
  }

  updateAutoStartButton();

  const settings = document.createElement('details');
  settings.id = 'blao-settings';
  const settingsSummary = document.createElement('summary');
  settingsSummary.textContent = '等待时间设置';
  const settingsFields = document.createElement('div');
  settingsFields.id = 'blao-settings-fields';
  const waitSettings = [
    ['apiTimeoutMs', '接口请求超时', '秒', 1, 300, 10],
    ['playerWaitMs', '等待播放器就绪', '秒', 1, 120, 6],
    ['bufferTimeoutMs', '等待音频缓冲', '秒', 1, 300, 12],
    ['mediaInitTimeoutMs', '等待音频初始化', '秒', 1, 120, 4],
    ['nativeRestoreTimeoutMs', '恢复视频播放器等待', '秒', 1, 120, 10],
    ['screenshotFrameTimeoutMs', '等待截图画面', '秒', 1, 120, 10],
    ['screenshotLoadTimeoutMs', '后台截图页面等待', '秒', 1, 300, 30],
    ['reconnectDelayMs', '断线重连间隔', '秒', 1, 120, 3],
  ];
  for (const [key, labelText, unit, min, max, fallback] of waitSettings) {
    const label = document.createElement('label');
    label.className = 'blao-setting-row';
    const text = document.createElement('span');
    text.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(Math.round(CONFIG[key] / 1000));
    input.title = `${min}–${max} 秒，修改后自动保存`;
    input.dataset.waitKey = key;
    input.addEventListener('change', () => {
      const seconds = Number(input.value);
      if (!Number.isFinite(seconds)) {
        input.value = String(Math.round(CONFIG[key] / 1000));
        return;
      }
      const boundedSeconds = Math.max(min, Math.min(max, Math.round(seconds)));
      input.value = String(boundedSeconds);
      saveWaitSetting(key, boundedSeconds * 1000);
      setStatus(`${labelText}已设为 ${boundedSeconds} 秒`, 'success');
    });
    const suffix = document.createElement('span');
    suffix.textContent = unit;
    label.append(text, input, suffix);
    settingsFields.appendChild(label);
  }
  settings.append(settingsSummary, settingsFields);

  const traffic = document.createElement('div');
  traffic.id = 'blao-traffic';
  traffic.textContent = '流量：-- KB/s';
  traffic.title = '当前下载速率；纯音频时读取 flv.js，视频模式尝试读取 B 站播放器统计或媒体请求进度';

  function formatTrafficRate(speed) {
    if (!Number.isFinite(speed) || speed < 0) return '-- KB/s';
    if (speed > 1024) return `${(speed / 1024).toFixed(2)} MB/s`;
    return `${speed.toFixed(1)} KB/s`;
  }

  function updateTraffic() {
    traffic.textContent = `流量：${formatTrafficRate(state.trafficSpeedKBps)}`;
  }

  // Native Bilibili players do not always expose the same statistics shape.
  // Probe their documented/public info objects first, then sample ongoing FLV/HLS
  // XHR progress as a fallback. Resource Timing alone is insufficient for a
  // never-ending live stream because its entry may not finalize until disconnect.
  let lastResourceSampleAt = performance.now();
  let lastResourceBytes = new Map();
  let nativeProgressWindowBytes = 0;
  let nativeAppendWindowBytes = 0;
  let nativeProgressWindowStart = performance.now();
  let nativeLastProgressAt = 0;
  let nativeTrafficProbeInstalled = false;

  function isLiveMediaRequest(url) {
    return /\.(?:flv|m3u8|m4s|ts|mp4)(?:[?#]|$)|live-bvc|\/(?:live|playback)[^?#]*(?:flv|m4s|ts)(?:[?#]|$)/i.test(String(url || ''));
  }

  function installNativeTrafficProbe() {
    if (nativeTrafficProbeInstalled) return;
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const XHR = pageWindow.XMLHttpRequest;
    const proto = XHR?.prototype;

    if (proto && !proto.__blaoTrafficProbeInstalled &&
        typeof proto.open === 'function' && typeof proto.send === 'function') {
      try {
        const originalOpen = proto.open;
        const originalSend = proto.send;
        Object.defineProperty(proto, '__blaoTrafficProbeInstalled', { value: true, configurable: true });
        proto.open = function(method, url, ...args) {
          try { this.__blaoTrafficUrl = String(url || ''); } catch {}
          return originalOpen.call(this, method, url, ...args);
        };
        proto.send = function(...args) {
          if (!this.__blaoTrafficTracked && isLiveMediaRequest(this.__blaoTrafficUrl)) {
            this.__blaoTrafficTracked = true;
            this.__blaoTrafficLoaded = 0;
            this.addEventListener('progress', event => {
              const loaded = Number(event?.loaded);
              if (!Number.isFinite(loaded) || loaded < 0) return;
              let delta = loaded - (Number(this.__blaoTrafficLoaded) || 0);
              if (delta < 0) delta = loaded;
              this.__blaoTrafficLoaded = loaded;
              if (state.enabled || state.connecting) return;
              if (delta > 0 && delta < 128 * 1024 * 1024) {
                nativeProgressWindowBytes += delta;
                nativeLastProgressAt = performance.now();
              }
            });
          }
          return originalSend.apply(this, args);
        };
      } catch (err) {
        console.warn('[Bilibili Live Audio Only] 无法安装 XHR 流量探针', err);
      }
    }

    // Some current Bilibili player builds use MSE SourceBuffer append calls.
    // Sampling appended fragment sizes also works for a media request that was
    // already in progress before this userscript's XHR hook was installed.
    const SourceBuffer = pageWindow.SourceBuffer;
    const sourceProto = SourceBuffer?.prototype;
    if (sourceProto && !sourceProto.__blaoTrafficProbeInstalled &&
        typeof sourceProto.appendBuffer === 'function') {
      try {
        const originalAppendBuffer = sourceProto.appendBuffer;
        Object.defineProperty(sourceProto, '__blaoTrafficProbeInstalled', { value: true, configurable: true });
        sourceProto.appendBuffer = function(data) {
          if (!state.enabled && !state.connecting) {
            let size = 0;
            if (data instanceof ArrayBuffer) size = data.byteLength;
            else if (ArrayBuffer.isView(data)) size = data.byteLength;
            if (size > 0 && size < 128 * 1024 * 1024) {
              nativeAppendWindowBytes += size;
              nativeLastProgressAt = performance.now();
            }
          }
          return originalAppendBuffer.apply(this, arguments);
        };
      } catch (err) {
        console.warn('[Bilibili Live Audio Only] 无法安装 MSE 流量探针', err);
      }
    }

    nativeTrafficProbeInstalled = Boolean(
      proto?.__blaoTrafficProbeInstalled || sourceProto?.__blaoTrafficProbeInstalled
    );
  }

  function readNativeTrafficSpeedKBps() {
    const player = getLivePlayer();
    if (!player) return null;
    const roots = [];
    try { roots.push(player.getPlayerInfo?.()); } catch {}
    try { roots.push(player.getStatisticsInfo?.()); } catch {}
    try { roots.push(player.statisticsInfo); } catch {}
    try { roots.push(player.player?.statisticsInfo); } catch {}
    try { roots.push(player._player?.statisticsInfo); } catch {}
    try { roots.push(player.corePlayer?.statisticsInfo); } catch {}

    const visited = new Set();
    const rateKeys = new Set([
      'speed', 'currentSpeed', 'netSpeed', 'networkSpeed', 'downloadSpeed',
      'receiveSpeed', 'recvSpeed', 'pullSpeed', 'download_rate', 'current_speed',
    ]);
    const scan = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 4 || visited.has(value)) return null;
      visited.add(value);
      let entries;
      try { entries = Object.entries(value); } catch { return null; }
      for (const [key, raw] of entries) {
        if (!rateKeys.has(key)) continue;
        const number = Number(raw);
        if (Number.isFinite(number) && number >= 0 && number <= 10 ** 9) return number;
      }
      for (const [key, child] of entries) {
        if (child && typeof child === 'object' &&
            /statistics|network|speed|traffic|player|info|stream|stat/i.test(key)) {
          const result = scan(child, depth + 1);
          if (result !== null) return result;
        }
      }
      return null;
    };
    for (const root of roots) {
      const result = scan(root, 0);
      if (result !== null) return result;
    }
    return null;
  }

  function pollNativeTrafficRate() {
    // A deliberate pause destroys the flv.js player; don't show stale native
    // player/resource-timing rates as if the audio stream were still active.
    if (state.enabled && state.userPaused) {
      state.trafficSpeedKBps = 0;
      updateTraffic();
      return;
    }
    // flv.js reports its own current download rate in audio-only mode.
    if (state.enabled && state.flvPlayer) {
      updateTraffic();
      return;
    }
    let found = false;
    const nativeSpeed = readNativeTrafficSpeedKBps();

    // Sample probe counters on every tick, even when Bilibili exposes a rate,
    // so later fallback values cover only the current interval.
    const sampleNow = performance.now();
    const elapsed = Math.max(250, sampleNow - nativeProgressWindowStart);
    const requestBytes = nativeProgressWindowBytes;
    const appendedBytes = nativeAppendWindowBytes;
    nativeProgressWindowBytes = 0;
    nativeAppendWindowBytes = 0;
    nativeProgressWindowStart = sampleNow;

    const nativeVideo = getNativeVideo();
    // A zero from the player object may be an uninitialized/stale statistic;
    // prefer measured activity when available. A real paused video is zero.
    if (nativeSpeed !== null && (nativeSpeed > 0 || nativeVideo?.paused)) {
      state.trafficSpeedKBps = nativeSpeed;
      found = true;
    }

    // Fallback: prefer observed network transfer bytes, then MSE fragment bytes.
    // The latter is an estimate of media throughput when the native stream
    // request was opened before this script could attach an XHR progress listener.
    if (!found) {
      const bytes = requestBytes > 0 ? requestBytes : appendedBytes;
      if (bytes > 0) {
        state.trafficSpeedKBps = bytes / (elapsed / 1000) / 1024;
        found = true;
      } else if (nativeLastProgressAt && sampleNow - nativeLastProgressAt < 2500) {
        state.trafficSpeedKBps = 0;
        found = true;
      }
    }

    // Fallback: estimate bytes/sec from completed media-resource entries. This
    // is a real interval rate, not the lifetime/cumulative transfer size.
    if (!found) {
      try {
        const now = performance.now();
        const entries = performance.getEntriesByType('resource');
        const current = new Map();
        let bytes = 0;
        for (const e of entries) {
          if (!/\.(?:flv|m4s|ts|mp4)(?:[?#]|$)|\/(?:live|playback).*?(?:flv|m4s|ts)(?:[?#]|$)/i.test(e.name)) continue;
          const size = Number(e.transferSize || e.encodedBodySize || 0);
          if (size > 0) {
            current.set(e.name, size);
            const previous = lastResourceBytes.get(e.name) || 0;
            if (size > previous) bytes += size - previous;
          }
        }
        const elapsed = Math.max(250, now - lastResourceSampleAt);
        if (bytes > 0) {
          state.trafficSpeedKBps = bytes / (elapsed / 1000) / 1024;
          found = true;
        }
        lastResourceBytes = current;
        lastResourceSampleAt = now;
      } catch {}
    }
    if (!found) state.trafficSpeedKBps = null;
    updateTraffic();
  }

  installNativeTrafficProbe();
  state.trafficMonitorTimer = setInterval(() => {
    // A SPA navigation may reinitialize Bilibili's request layer.
    if (!nativeTrafficProbeInstalled) installNativeTrafficProbe();
    pollNativeTrafficRate();
  }, 1000);
  pollNativeTrafficRate();


  function injectStyle() {
    if (document.getElementById('blao-style')) return;

    const style = document.createElement('style');
    style.id = 'blao-style';
    style.textContent = `
      #blao-anchor {
        position: fixed;
        right: 0;
        top: 72px;
        z-index: 2147483647;
        width: 22px;
        height: 108px;
        pointer-events: auto;
      }

      #blao-anchor[data-hidden="1"] {
        display: none !important;
      }

      #blao-hotzone {
        position: absolute;
        right: 0;
        top: 0;
        width: 22px;
        height: 108px;
        background: transparent;
      }

      #blao-panel {
        position: absolute;
        right: 10px;
        top: 0;
        width: 220px;
        padding: 10px;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 10px;
        background: rgba(24,24,28,.94);
        box-shadow: 0 6px 22px rgba(0,0,0,.35);
        color: #fff;
        font: 13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        backdrop-filter: blur(8px);
        opacity: 0;
        transform: translateX(calc(100% + 28px));
        pointer-events: none;
        transition: opacity .16s ease, transform .16s ease;
      }

      #blao-anchor:hover #blao-panel,
      #blao-anchor[data-reveal="1"] #blao-panel {
        opacity: 1;
        transform: translateX(0);
        pointer-events: auto;
      }

      #blao-button {
        width: 100%;
        border: 0;
        border-radius: 7px;
        padding: 8px 10px;
        cursor: pointer;
        background: #00aeec;
        color: #fff;
        font: inherit;
        font-weight: 650;
      }

      #blao-button:hover,
      #blao-screenshot-button:hover,
      #blao-auto-start-button:hover {
        filter: brightness(1.06);
      }

      #blao-screenshot-button,
      #blao-auto-start-button {
        width: 100%;
        margin-top: 7px;
        border: 1px solid rgba(255,255,255,.2);
        border-radius: 7px;
        padding: 7px 10px;
        cursor: pointer;
        background: rgba(255,255,255,.10);
        color: #fff;
        font: inherit;
      }

      #blao-auto-start-button {
        width: 100%;
        margin-top: 7px;
        border: 1px solid rgba(255,255,255,.2);
        border-radius: 7px;
        padding: 7px 10px;
        cursor: pointer;
        background: rgba(255,255,255,.10);
        color: #fff;
        font: inherit;
      }

      #blao-screenshot-button:disabled {
        cursor: wait;
        opacity: .65;
      }

      #blao-button:disabled {
        cursor: wait;
        opacity: .72;
      }

      #blao-status {
        margin-top: 7px;
        color: #aaa;
        font-size: 12px;
        word-break: break-word;
      }

      #blao-status[data-kind="success"] { color: #7ee787; }
      #blao-status[data-kind="warning"] { color: #ffd166; }
      #blao-status[data-kind="error"] { color: #ff7b72; }

      #blao-settings {
        margin-top: 8px;
        padding-top: 7px;
        border-top: 1px solid rgba(255,255,255,.14);
      }
      #blao-settings summary {
        cursor: pointer;
        color: #ddd;
        user-select: none;
      }
      #blao-settings-fields {
        max-height: 260px;
        overflow-y: auto;
        margin-top: 6px;
        padding-right: 2px;
      }
      .blao-setting-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 54px 20px;
        align-items: center;
        gap: 4px;
        margin: 5px 0;
        color: #ddd;
        font-size: 11px;
      }
      .blao-setting-row input {
        box-sizing: border-box;
        width: 54px;
        min-width: 0;
        border: 1px solid rgba(255,255,255,.22);
        border-radius: 4px;
        padding: 3px;
        background: rgba(0,0,0,.35);
        color: #fff;
        font: inherit;
      }
      #blao-traffic {
        margin-top: 5px;
        color: #9bdcff;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }

      #live-player.blao-active {
        position: relative !important;
        background-color: #000 !important;
        background-image: none !important;
        isolation: isolate !important;
      }

      #blao-cover-layer {
        position: absolute !important;
        inset: 0 !important;
        z-index: 2 !important;
        pointer-events: none !important;
        background-color: #111 !important;
        background-position: center center !important;
        background-repeat: no-repeat !important;
        background-size: contain !important;
      }

      /* Keep Bilibili's transparent danmaku layer above our still cover image. */
      #live-player.blao-active [class*="danmaku"],
      #live-player.blao-active [class*="danmu"],
      #live-player.blao-active canvas {
        z-index: 4 !important;
      }

      #live-player.blao-active > video,
      #live-player.blao-active video {
        visibility: hidden !important;
      }

      /* The native cover/loading layer can cover both our still image and the
         danmaku. Replace it with #blao-cover-layer while audio-only is active. */
      #live-player.blao-active .web-player-video-cover-img-wrap {
        display: none !important;
      }

      #live-player.blao-active img[src*="error@1x.png"],
      #live-player.blao-active img[src*="error@2x.png"],
      #live-player.blao-active img[src*="/images/error"] {
        display: none !important;
      }

      #live-player.blao-active div:has(> img[src*="error@1x.png"]),
      #live-player.blao-active div:has(> img[src*="error@2x.png"]) {
        display: none !important;
      }

      #blao-audio-toolbar {
        position: absolute !important;
        z-index: 2147483000 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
        box-sizing: border-box !important;
        min-height: 48px !important;
        padding: 8px 14px !important;
        color: #fff !important;
        background: linear-gradient(transparent, rgba(0,0,0,.88)) !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        transition: none !important;
        font: 13px/1.2 Arial, sans-serif !important;
      }

      #blao-audio-toolbar button {
        appearance: none !important;
        flex: 0 0 auto !important;
        min-width: 32px !important;
        height: 30px !important;
        border: 0 !important;
        border-radius: 4px !important;
        padding: 0 7px !important;
        color: #fff !important;
        background: rgba(255,255,255,.12) !important;
        cursor: pointer !important;
        font: inherit !important;
      }

      #blao-audio-toolbar button:hover {
        background: rgba(255,255,255,.25) !important;
      }

      #blao-audio-toolbar input[type="range"] {
        flex: 0 1 130px !important;
        width: 130px !important;
        min-width: 55px !important;
        margin: 0 !important;
        accent-color: #00aeec !important;
        cursor: pointer !important;
      }

      #blao-audio-toolbar .blao-audio-spacer {
        flex: 1 1 auto !important;
      }

      #blao-audio-toolbar .blao-audio-state {
        opacity: .85 !important;
        white-space: nowrap !important;
        user-select: none !important;
      }

      #live-player:not(.blao-active) #blao-audio-toolbar {
        display: none !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function syncPageButtonVisibility() {
    anchor.dataset.hidden = state.buttonVisible ? '0' : '1';
  }

  function revealPanelTemporarily(ms = 2600) {
    if (!state.buttonVisible) return;

    anchor.dataset.reveal = '1';
    if (state.panelRevealTimer) clearTimeout(state.panelRevealTimer);

    state.panelRevealTimer = setTimeout(() => {
      state.panelRevealTimer = null;
      if (!state.connecting && !state.waitingGesture) {
        anchor.dataset.reveal = '0';
      }
    }, ms);
  }

  function setStatus(text, kind = '') {
    status.textContent = text;
    status.dataset.kind = kind;
    revealPanelTemporarily();
  }

  let menuAudioId = null;
  let menuButtonId = null;
  let menuAutoStartId = null;
  let menuSignature = '';

  function unregisterMenus() {
    for (const id of [menuAudioId, menuButtonId, menuAutoStartId]) {
      if (id == null) continue;
      try { GM_unregisterMenuCommand(id); } catch {}
    }
    menuAudioId = null;
    menuButtonId = null;
    menuAutoStartId = null;
  }

  let lastToggleAt = 0;
  async function toggleAudioOnly() {
    // Ignore double-clicks that can otherwise switch off and immediately start
    // another asynchronous stream acquisition. A later click can still cancel
    // a connection attempt normally.
    const now = Date.now();
    if (now - lastToggleAt < 350) return;
    lastToggleAt = now;

    if (state.waitingGesture) {
      await resumeAfterGesture();
    } else if (state.enabled || state.connecting) {
      disableAudioOnly();
    } else {
      await enableAudioOnly();
    }
    refreshMenuCommands();
  }

  function togglePageButtonVisibility() {
    state.buttonVisible = !state.buttonVisible;
    GM_setValue('pageButtonVisible', state.buttonVisible);
    syncPageButtonVisibility();

    if (state.buttonVisible) {
      revealPanelTemporarily(3200);
    }

    refreshMenuCommands(true);
  }

  function refreshMenuCommands(force = false) {
    const audioOn = state.enabled || state.connecting || state.waitingGesture;
    const signature = `${audioOn}|${state.buttonVisible}|${state.autoStartAudioOnly}`;
    if (!force && signature === menuSignature) return;

    unregisterMenus();

    menuAudioId = GM_registerMenuCommand(
      audioOn ? '关闭纯音频' : '开启纯音频',
      () => { toggleAudioOnly().catch(console.error); }
    );

    menuButtonId = GM_registerMenuCommand(
      state.buttonVisible ? '隐藏网页按钮' : '显示网页按钮',
      () => togglePageButtonVisibility()
    );

    menuAutoStartId = GM_registerMenuCommand(
      state.autoStartAudioOnly
        ? '默认启动纯音频：已开启（点击关闭）'
        : '默认启动纯音频：已关闭（点击开启）',
      () => {
        state.autoStartAudioOnly = !state.autoStartAudioOnly;
        GM_setValue('autoStartAudioOnly', state.autoStartAudioOnly);
        refreshMenuCommands(true);

        setStatus(
          state.autoStartAudioOnly
            ? '已开启默认纯音频；下次打开直播页面时自动切换'
            : '已关闭默认纯音频；下次打开直播页面时使用视频模式',
          'success'
        );
      }
    );

    menuSignature = signature;
  }

  function updateButton() {
    if (state.connecting) {
      button.textContent = '正在连接…';
      button.disabled = true;
      anchor.dataset.reveal = '1';
      refreshMenuCommands();
      return;
    }

    button.disabled = false;

    if (state.waitingGesture) {
      button.textContent = '播放音频';
      anchor.dataset.reveal = '1';
    } else if (state.enabled) {
      button.textContent = '恢复视频';
    } else {
      button.textContent = '开启纯音频';
    }

    refreshMenuCommands();
  }

  button.addEventListener('click', () => {
    toggleAudioOnly().catch((error) => {
      setStatus(`操作失败：${error?.message || error}`, 'error');
      console.error('[Bilibili Live Audio Only]', error);
    });
  });

  async function waitForVideoFrame(video, timeoutMs = CONFIG.screenshotFrameTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          video.videoWidth > 0 && video.videoHeight > 0) return;
      await sleep(150);
    }
    throw new Error('等待直播视频画面超时');
  }

  function createScreenshotBlob(video) {
    return new Promise((resolve, reject) => {
      if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
        reject(new Error('当前没有可截取的视频帧'));
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('无法创建截图画布'));
        return;
      }
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch (err) {
        reject(new Error(`读取视频帧失败：${err?.message || err}`));
        return;
      }
      canvas.toBlob(blob => {
        if (!blob) {
          reject(new Error('浏览器未能生成 PNG；直播源可能限制画布读取'));
          return;
        }
        resolve(blob);
      }, 'image/png');
    });
  }

  // Screenshot pipeline: capture -> open -> delete. The PNG is displayed in a
  // tab straight from a blob URL instead of being downloaded, so nothing is
  // written to the local disk and there is no saved file left to clean up.
  // The temporary blob data ("delete" step) is dropped as soon as that tab is
  // closed, with a 10-minute backstop so nothing lingers in memory.
  function buildScreenshotFilename() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `bilibili_live_${state.roomId}_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
  }

  // Only used when the browser refuses to open any tab at all: the captured
  // frame would otherwise be lost, so that single failure case still falls back
  // to a normal file download.
  function saveScreenshotAsFile(blob) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = buildScreenshotFilename();
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }

  async function showScreenshot(video, screenshotTab = null) {
    const blob = await createScreenshotBlob(video);
    const objectUrl = URL.createObjectURL(blob);

    let deleted = false;
    let closeWatcher = null;
    const deleteScreenshotData = () => {
      if (deleted) return;
      deleted = true;
      if (closeWatcher) {
        clearInterval(closeWatcher);
        closeWatcher = null;
      }
      try { URL.revokeObjectURL(objectUrl); } catch {}
    };
    const watchTabClose = tab => {
      if (!tab) return false;
      closeWatcher = setInterval(() => {
        let closed = false;
        try { closed = tab.closed === true; } catch { closed = true; }
        if (closed) deleteScreenshotData();
      }, 1000);
      return true;
    };

    // The tab is opened synchronously from the screenshot click handler, before
    // asynchronous frame capture. Navigating that tab later avoids popup blocking
    // and intentionally switches the user to the captured PNG.
    let opened = false;
    let shownTab = null;
    try {
      if (screenshotTab && !screenshotTab.closed) {
        screenshotTab.location.href = objectUrl;
        opened = true;
        shownTab = screenshotTab;
      }
    } catch (err) {
      console.warn('[Bilibili Live Audio Only] screenshot tab navigation failed', err);
    }
    if (!opened) {
      try {
        if (typeof GM_openInTab === 'function') {
          shownTab = GM_openInTab(objectUrl, { active: true, insert: true, setParent: true }) || null;
          opened = true;
        }
      } catch (err) {
        console.warn('[Bilibili Live Audio Only] screenshot tab open failed', err);
      }
    }
    if (!opened) {
      try {
        const win = window.open(objectUrl, '_blank');
        if (win) {
          opened = true;
          shownTab = win;
        }
      } catch {}
    }

    if (!opened) {
      deleteScreenshotData();
      saveScreenshotAsFile(blob);
      setStatus('无法打开新标签页（可能被浏览器拦截），已改为保存 PNG 文件', 'warning');
      return;
    }

    // The image was shown through another tab: do not leave the pre-opened blank
    // tab behind as well.
    if (screenshotTab && shownTab !== screenshotTab) {
      try {
        if (!screenshotTab.closed && screenshotTab.location.href === 'about:blank') screenshotTab.close();
      } catch {}
    }

    // Delete the temporary image data once the shown tab is gone. Even when the
    // tab object exposes no "closed" flag, the backstop still removes it; the
    // image is already rendered by then, so the view is unaffected.
    if (!watchTabClose(shownTab)) {
      logBLAO('info', '无法跟踪截图标签页的关闭状态，将在 10 分钟后自动删除临时图片数据');
    }
    setTimeout(deleteScreenshotData, 10 * 60_000);
  }

  async function captureCurrentFrame(screenshotTab = null) {
    if (state.screenshotBusy) {
      try { screenshotTab?.close(); } catch {}
      return;
    }
    state.screenshotBusy = true;
    screenshotButton.disabled = true;
    let helperFrame = null;
    let muteObserver = null;
    try {
      if (state.connecting) throw new Error('纯音频正在连接，请稍后再截图');
      if (state.waitingGesture) throw new Error('请先启动纯音频播放，再尝试截图');

      if (!(state.enabled || state.connecting || state.waitingGesture)) {
        const video = getNativeVideo();
        await waitForVideoFrame(video);
        await showScreenshot(video, screenshotTab);
        setStatus('截图已在新标签页打开（关闭标签页即自动删除，不写入本地文件）', 'success');
        return;
      }

      // A new tab is not suitable here: browsers normally activate it and page
      // scripts cannot reliably force the original tab to remain active. Use a
      // hidden same-origin iframe instead and block autoplay where supported.
      setStatus('正在后台加载画面并生成截图…', 'warning');
      helperFrame = document.createElement('iframe');
      helperFrame.title = '后台截图画面';
      helperFrame.setAttribute('aria-hidden', 'true');
      // Explicitly deny autoplay in the helper browsing context. The sandbox
      // alone did not reliably prevent a one-shot audio blip on some builds.
      helperFrame.setAttribute('allow', "autoplay 'none'; microphone 'none'; camera 'none'");
      // Do not grant autoplay to the helper page. The click that triggered the
      // screenshot can otherwise provide transient user activation to the new
      // iframe and briefly start its live audio before our mute observer runs.
      // Keep scripts and same-origin access so the script can read the video frame.
      helperFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      Object.assign(helperFrame.style, {
        position: 'fixed', left: '-10000px', top: '0', width: '640px', height: '360px',
        opacity: '0.01', pointerEvents: 'none', border: '0',
      });

      const muteFrameVideos = () => {
        try {
          const doc = helperFrame?.contentDocument;
          const win = helperFrame?.contentWindow;
          if (!doc || !win) return;

          // Mute media in the room document and any same-origin nested player frames.
          const visited = new Set();
          const muteDocumentTree = rootDoc => {
            if (!rootDoc || visited.has(rootDoc)) return;
            visited.add(rootDoc);
            for (const media of rootDoc.querySelectorAll('video, audio')) {
              try {
                media.muted = true; media.defaultMuted = true; media.volume = 0;
                media.setAttribute('muted', ''); media.setAttribute('volume', '0');
                // Keep video decoding so the screenshot frame remains available.
                media.addEventListener('play', () => { try { media.muted = true; media.volume = 0; } catch {} }, { once: true });
              } catch {}
            }
            for (const frame of rootDoc.querySelectorAll('iframe')) {
              try { muteDocumentTree(frame.contentDocument); } catch {}
            }
          };
          muteDocumentTree(doc);

          // Bilibili player APIs differ between player builds. Call only known
          // mute/volume methods when exposed; a missing method is not treated as success.
          const players = [win.livePlayer, win.__LIVE_PLAYER__, win.player].filter(Boolean);
          for (const player of players) {
            try { if (typeof player.setVolume === 'function') player.setVolume(0); } catch {}
            try { if (typeof player.setMute === 'function') player.setMute(true); } catch {}
            try { if (typeof player.setMuted === 'function') player.setMuted(true); } catch {}
            try { if (typeof player.mute === 'function') player.mute(true); } catch {}
            try { if (typeof player.volume === 'function') player.volume(0); } catch {}
          }

          // Fallback: activate the visible mute control if the player's own
          // control bar exposes one. Avoid clicking an already-muted control.
          const controls = [...doc.querySelectorAll('button, [role="button"]')];
          const muteButton = controls.find(el => {
            const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`;
            return /静音|取消静音|mute|volume/i.test(label);
          });
          if (muteButton) {
            const label = `${muteButton.getAttribute('aria-label') || ''} ${muteButton.getAttribute('title') || ''} ${muteButton.textContent || ''}`;
            const pressed = muteButton.getAttribute('aria-pressed');
            const appearsMuted = pressed === 'true' || /取消静音|unmute/i.test(label) || /muted|volume-off/i.test(muteButton.className || '');
            if (!appearsMuted && /静音|mute/i.test(label)) muteButton.click();
          }
        } catch {}
      };

      const observeFrameDocument = () => {
        muteFrameVideos();
        try {
          const doc = helperFrame?.contentDocument;
          if (doc?.documentElement && !muteObserver) {
            muteObserver = new MutationObserver(muteFrameVideos);
            muteObserver.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
          }
        } catch {}
      };
      helperFrame.addEventListener('load', observeFrameDocument);
      document.body.appendChild(helperFrame);
      helperFrame.src = `${location.origin}/${state.roomId}`;

      const deadline = Date.now() + CONFIG.screenshotLoadTimeoutMs;
      let video = null;
      while (Date.now() < deadline) {
        if (!helperFrame.isConnected) throw new Error('后台截图页面已被关闭');
        observeFrameDocument();
        try {
          video = helperFrame.contentDocument?.querySelector('#live-player video');
          if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              video.videoWidth > 0 && video.videoHeight > 0) break;
        } catch {}
        await sleep(200);
      }
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
        throw new Error('等待后台视频画面超时；B站可能阻止隐藏页面播放');
      }
      muteFrameVideos();
      try { video.muted = true; video.volume = 0; } catch {}
      await waitForVideoFrame(video, CONFIG.screenshotFrameTimeoutMs);
      muteFrameVideos();
      await showScreenshot(video, screenshotTab);
      setStatus('截图已在新标签页打开（关闭标签页即自动删除，不写入本地文件）', 'success');
    } catch (err) {
      try { if (screenshotTab && !screenshotTab.closed && screenshotTab.location.href === 'about:blank') screenshotTab.close(); } catch {}
      const message = err?.message || String(err);
      setStatus(`截图失败：${message}`, 'error');
      console.error('[Bilibili Live Audio Only] screenshot', err);
    } finally {
      try { muteObserver?.disconnect(); } catch {}
      try { helperFrame?.remove(); } catch {}
      state.screenshotBusy = false;
      screenshotButton.disabled = false;
    }
  }

  screenshotButton.addEventListener('click', () => {
    // Open the viewer tab synchronously during the trusted click, then point it
    // at the captured PNG when asynchronous capture completes. The image lives in
    // memory only: nothing is downloaded, and closing the tab deletes it.
    let screenshotTab = null;
    try { screenshotTab = window.open('about:blank', '_blank'); } catch {}
    captureCurrentFrame(screenshotTab).catch(err => {
      try { if (screenshotTab && !screenshotTab.closed && screenshotTab.location.href === 'about:blank') screenshotTab.close(); } catch {}
      setStatus(`截图失败：${err?.message || err}`, 'error');
    });
  });

  autoStartButton.addEventListener('click', () => {
    state.autoStartAudioOnly = !state.autoStartAudioOnly;
    GM_setValue('autoStartAudioOnly', state.autoStartAudioOnly);
    updateAutoStartButton();
    refreshMenuCommands(true);
    setStatus(
      state.autoStartAudioOnly
        ? '已开启默认启动纯音频；之后打开直播页面会自动尝试启用纯音频'
        : '已关闭默认启动纯音频；之后打开直播页面将使用视频模式',
      'success'
    );
  });

  panel.append(button, screenshotButton, autoStartButton, status, traffic, settings);
  anchor.append(hotzone, panel);

  function mountUi() {
    injectStyle();

    if (!document.documentElement.contains(anchor)) {
      (document.body || document.documentElement).appendChild(anchor);
    }

    syncPageButtonVisibility();
    applyCover();
    updateButton();

    if (!state.enabled &&
        !state.connecting &&
        !state.waitingGesture &&
        !status.textContent) {
      setStatus(`房间 ${state.roomId} · 视频模式`);
    }
  }

  mountUi();
  waitForLivePlayer().then(player => enterWebFullscreen(player)).catch(err => logBLAO('warn', '页面自动网页全屏未执行', { message: err?.message || String(err) }));
  refreshMenuCommands(true);
  revealPanelTemporarily(1800);

  if (state.autoStartAudioOnly) {
    // Start automatically on each live-room page load. The persisted preference
    // is global across rooms and browser sessions.
    setTimeout(() => {
      if (state.autoStartAudioOnly && !state.enabled && !state.connecting) {
        toggleAudioOnly().catch(error => {
          setStatus(`自动开启纯音频失败：${error?.message || error}`, 'error');
          console.error('[Bilibili Live Audio Only]', error);
        });
      }
    }, 0);
  }

  setInterval(mountUi, 3000);

  let lastRoomId = state.roomId;
  setInterval(() => {
    const nextRoomId = getRoomId();
    if (!nextRoomId || nextRoomId === lastRoomId) return;

    lastRoomId = nextRoomId;

    if (state.enabled || state.connecting) {
      disableAudioOnly();
    }

    state.roomId = nextRoomId;
    state.coverUrl = '';
    setStatus(`房间 ${state.roomId} · 视频模式`);
    applyCover();
  }, 1000);

  window.addEventListener('beforeunload', () => {
    state.generation += 1;
    clearReconnect();
    stopWatchdog();
    unregisterMenus();
    if (state.panelRevealTimer) clearTimeout(state.panelRevealTimer);
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    destroyAudioPipeline();
  });
})();