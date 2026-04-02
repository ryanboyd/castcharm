"use strict";

// ============================================================
// Persistent in-page audio player — Spotify-style two-mode UI
// ============================================================
const Player = (() => {
  let _currentEp = null;  // { id, title, feedTitle, feedId, duration, resumeAt, imageUrl }
  let _audio = null;
  let _progressTimer = null;
  let _lastReportedPos = 0;
  let _lastDisplayedPct = -1;
  let _autoPlayedThreshold = 95;  // % of duration; 0 = disabled
  let _autoPlayedFired = false;   // prevent firing multiple times per episode
  let _sleepTimer = null;
  let _sleepMinutes = 0;          // 0 = off
  let _sleepEnd = null;
  let _sleepTickId = null;
  let _expanded = false;
  let _imageUrl = "";
  let _dragging = false;

  const _PODCAST_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40%" height="40%" opacity="0.4"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`;

  function _el(id) { return document.getElementById(id); }

  // ── Audio event wiring ─────────────────────────────────────

  function _initAudio() {
    if (_audio) return;
    _audio = new Audio();
    _audio.preload = "none";

    _audio.addEventListener("timeupdate", () => {
      const bar = _el("player-bar");
      if (!bar || bar.classList.contains("hidden")) return;
      const cur = _audio.currentTime;
      const dur = _audio.duration || 0;
      const pct = dur > 0 ? (cur / dur) * 100 : 0;

      // Mini bar progress
      const miniFill = _el("player-mini-progress-fill");
      if (miniFill) miniFill.style.width = pct + "%";

      // Full overlay progress + times — skip while user is dragging
      if (!_dragging) {
        const fullFill = _el("player-full-progress-fill");
        if (fullFill) fullFill.style.width = pct + "%";
        const thumb = _el("player-full-seek-thumb");
        if (thumb) thumb.style.left = pct + "%";
      }
      const timeCur = _el("player-time-current");
      const timeTotal = _el("player-time-total");
      if (timeCur) timeCur.textContent = _fmtTime(cur);
      if (timeTotal) timeTotal.textContent = _fmtTime(dur);

      // Report progress to server every 10 seconds
      if (_currentEp && Math.abs(cur - _lastReportedPos) >= 10) {
        _lastReportedPos = cur;
        API.updateProgress(_currentEp.id, Math.floor(cur)).catch(() => {});
      }

      // Auto-mark played at threshold
      if (_currentEp && !_autoPlayedFired && _autoPlayedThreshold > 0 && dur > 0) {
        if ((cur / dur) * 100 >= _autoPlayedThreshold) {
          _autoPlayedFired = true;
          API.togglePlayed(_currentEp.id).catch(() => {});
        }
      }

      // Update episode row listen bar (throttle to integer % changes)
      if (_currentEp && dur > 0) {
        const intPct = Math.min(100, Math.floor(pct));
        if (intPct !== _lastDisplayedPct) {
          _lastDisplayedPct = intPct;
          const row = document.getElementById(`ep-${_currentEp.id}`);
          if (row) {
            const fill = row.querySelector(".ep-listen-fill");
            const label = row.querySelector(".ep-listen-label");
            if (fill) fill.style.width = intPct + "%";
            if (label) label.textContent = intPct > 0 ? `${intPct}% listened` : "Started";
            // Inject bar if not present (episode just started, had no prior position)
            if (!row.querySelector(".ep-listen-bar-wrap")) {
              const info = row.querySelector(".episode-info");
              if (info) {
                info.insertAdjacentHTML("beforeend",
                  `<div class="ep-listen-bar-wrap">
                    <div class="ep-listen-bar"><div class="ep-listen-fill" style="width:${intPct}%"></div></div>
                    <span class="ep-listen-label">${intPct > 0 ? intPct + "% listened" : "Started"}</span>
                  </div>`);
              }
            }
          }
        }
      }
    });

    _audio.addEventListener("ended", () => {
      if (_currentEp && !_autoPlayedFired) {
        _autoPlayedFired = true;
        API.togglePlayed(_currentEp.id).catch(() => {});
      }
      _updatePlayIcons(_playIcon());
      _syncPlayBtns();
      // Auto-play next episode
      const epId = _currentEp?.id;
      if (epId) window._autoPlayNext?.(epId);
    });

    _audio.addEventListener("play", () => {
      _updatePlayIcons(_pauseIcon());
      _syncPlayBtns();
    });

    _audio.addEventListener("pause", () => {
      _updatePlayIcons(_playIcon());
      _syncPlayBtns();
    });
  }

  // ── Icon helpers ───────────────────────────────────────────

  function _playIcon() {
    // Shifted 1.5px right of geometric center to correct optical off-center illusion
    return '<polygon points="7 3 21 12 7 21"/>';
  }

  function _resumeIcon() {
    return '<line x1="4" y1="4" x2="4" y2="20" stroke-width="2.5"/><polygon points="8 3 21 12 8 21 8 3"/>';
  }

  function _pauseIcon() {
    return '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  }

  function _updatePlayIcons(svgContent) {
    const mini = _el("player-mini-play-icon");
    const full = _el("player-full-play-icon");
    if (mini) mini.innerHTML = svgContent;
    if (full) full.innerHTML = svgContent;
  }

  function _fmtTime(s) {
    if (!isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  }

  function _showBar() {
    const bar = _el("player-bar");
    if (bar) bar.classList.remove("hidden");
    document.body.classList.add("has-player");
  }

  // ── Artwork helper ─────────────────────────────────────────

  function _setArtwork(container, url) {
    if (!container) return;
    if (url) {
      container.innerHTML = `<img src="${url}" alt="" />
        <div class="player-art-fallback" style="display:none">${_PODCAST_ICON}</div>`;
    } else {
      container.innerHTML = `<div class="player-art-fallback">${_PODCAST_ICON}</div>`;
    }
  }

  // ── Expand / Collapse ──────────────────────────────────────

  function _expand() {
    if (_expanded) return;
    _expanded = true;
    _el("player-full")?.classList.add("open");
    document.body.classList.add("player-expanded");
    document.body.style.overflow = "hidden";
    history.pushState({ playerExpanded: true }, "");
  }

  function _collapse() {
    if (!_expanded) return;
    _expanded = false;
    _el("player-full")?.classList.remove("open");
    document.body.classList.remove("player-expanded");
    document.body.style.overflow = "";
  }

  // ── Sync play/pause icons on all episode rows ──────────────

  function _syncPlayBtns() {
    const playing = _currentEp && _audio && !_audio.paused;
    document.querySelectorAll(".ep-play-btn").forEach((btn) => {
      const epId = Number(btn.dataset.epId);
      const icon = btn.querySelector("svg");
      if (!icon) return;
      if (playing && epId === _currentEp.id) {
        icon.innerHTML = _pauseIcon();
        btn.title = "Pause";
      } else if (btn.dataset.resumable === "1") {
        icon.innerHTML = _resumeIcon();
        btn.title = "Resume";
      } else {
        icon.innerHTML = _playIcon();
        btn.title = "Play";
      }
    });
  }

  // ── Speed ──────────────────────────────────────────────────

  const _SPEEDS = [1, 1.25, 1.5, 1.75, 2];

  function _updateSpeedDisplay() {
    const el = _el("player-full-speed");
    if (el && _audio) el.textContent = _audio.playbackRate.toFixed(2).replace(/\.?0+$/, "") + "×";
  }

  function _loadPerFeedSpeed() {
    if (!_currentEp?.feedId || !_audio) return;
    const stored = localStorage.getItem(`podcast_speed_${_currentEp.feedId}`);
    if (stored) {
      _audio.playbackRate = parseFloat(stored) || 1;
      _updateSpeedDisplay();
    }
  }

  function _savePerFeedSpeed() {
    if (!_currentEp?.feedId || !_audio) return;
    localStorage.setItem(`podcast_speed_${_currentEp.feedId}`, _audio.playbackRate);
  }

  // ── Sleep timer ────────────────────────────────────────────

  const _SLEEP_OPTIONS = [0, 15, 30, 45, 60]; // 0 = off

  function _clearSleepTimer() {
    if (_sleepTimer) { clearTimeout(_sleepTimer); _sleepTimer = null; }
    if (_sleepTickId) { clearInterval(_sleepTickId); _sleepTickId = null; }
    _sleepEnd = null;
  }

  function _setSleepTimer(minutes) {
    _clearSleepTimer();
    _sleepMinutes = minutes;
    if (minutes === 0) {
      _updateSleepDisplay();
      return;
    }
    _sleepEnd = Date.now() + minutes * 60000;
    _sleepTimer = setTimeout(() => {
      if (_audio) _audio.pause();
      _clearSleepTimer();
      _sleepMinutes = 0;
      _updateSleepDisplay();
    }, minutes * 60000);
    _sleepTickId = setInterval(_updateSleepDisplay, 30000);
    _updateSleepDisplay();
  }

  function _updateSleepDisplay() {
    const el = _el("player-full-sleep-label");
    if (!el) return;
    if (!_sleepEnd || _sleepMinutes === 0) {
      el.textContent = "Sleep";
      return;
    }
    const remainMs = Math.max(0, _sleepEnd - Date.now());
    const remainMin = Math.ceil(remainMs / 60000);
    el.textContent = remainMin <= 0 ? "Sleep" : `${remainMin}m`;
  }

  // ── Public API ─────────────────────────────────────────────

  function togglePause() {
    if (!_audio) return;
    if (_audio.paused) _audio.play().catch(() => {});
    else _audio.pause();
  }

  function seek(deltaSecs) {
    if (!_audio) return;
    _audio.currentTime = Math.max(0, Math.min(_audio.duration || 0, _audio.currentTime + deltaSecs));
  }

  function currentId() { return _currentEp?.id ?? null; }
  function isPlaying() { return !!(_audio && !_audio.paused); }

  function setThreshold(pct) { _autoPlayedThreshold = pct; }

  function play(ep) {
    // ep: { id, title, feedTitle, feedId, resumeAt, imageUrl }
    _initAudio();
    _currentEp = ep;
    _lastReportedPos = ep.resumeAt || 0;
    _lastDisplayedPct = -1;
    _autoPlayedFired = false;
    _imageUrl = ep.imageUrl || "";

    const url = API.streamEpisode(ep.id);
    _audio.src = url;
    _audio.load();
    if (ep.resumeAt > 0) {
      _audio.addEventListener("loadedmetadata", () => {
        _audio.currentTime = ep.resumeAt;
      }, { once: true });
    }

    // Restore per-feed speed before playing
    _audio.addEventListener("loadedmetadata", _loadPerFeedSpeed, { once: true });

    _audio.play().catch(() => {});

    // Update mini bar
    const miniTitle = _el("player-mini-title");
    const miniFeed = _el("player-mini-feed");
    if (miniTitle) miniTitle.textContent = ep.title || "Untitled";
    if (miniFeed) miniFeed.textContent = ep.feedTitle || "";
    _setArtwork(_el("player-mini-art"), _imageUrl);

    // Update full overlay
    const fullTitle = _el("player-full-title");
    const fullFeed = _el("player-full-feed");
    if (fullTitle) fullTitle.textContent = ep.title || "Untitled";
    if (fullFeed) fullFeed.textContent = ep.feedTitle || "";
    _setArtwork(_el("player-full-art"), _imageUrl);

    // mediaSession integration
    if ("mediaSession" in navigator) {
      const artworkArr = _imageUrl
        ? [{ src: _imageUrl, sizes: "512x512", type: "image/jpeg" }]
        : [];
      navigator.mediaSession.metadata = new MediaMetadata({
        title: ep.title || "Untitled",
        artist: ep.feedTitle || "",
        artwork: artworkArr,
      });
      navigator.mediaSession.setActionHandler("play", () => _audio.play().catch(() => {}));
      navigator.mediaSession.setActionHandler("pause", () => _audio.pause());
      navigator.mediaSession.setActionHandler("seekbackward", () => seek(-30));
      navigator.mediaSession.setActionHandler("seekforward", () => seek(30));
    }

    _showBar();
    _updateSpeedDisplay();
    setTimeout(_syncPlayBtns, 50);
  }

  // ── Close / stop player ────────────────────────────────────

  function _closePlayer() {
    if (_audio) {
      _audio.pause();
      _audio.src = "";
    }
    _clearSleepTimer();
    _sleepMinutes = 0;
    _collapse();
    const bar = _el("player-bar");
    if (bar) bar.classList.add("hidden");
    document.body.classList.remove("has-player");
    _currentEp = null;
    _syncPlayBtns();
  }

  // ── DOM wiring ─────────────────────────────────────────────

  function _wire() {
    // ── Mini bar ──
    _el("player-mini")?.addEventListener("click", (e) => {
      if (e.target.closest("#player-mini-play")) return; // handled separately
      _expand();
    });

    _el("player-mini-play")?.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePause();
    });

    // ── Full overlay — collapse ──
    _el("player-full-collapse-btn")?.addEventListener("click", _collapse);

    // ── Full overlay — transport ──
    _el("player-full-play-btn")?.addEventListener("click", togglePause);
    _el("player-full-back-btn")?.addEventListener("click", () => seek(-30));
    _el("player-full-fwd-btn")?.addEventListener("click", () => seek(30));

    // ── Full overlay — seek bar (drag + click) ──
    {
      const seekEl = _el("player-full-seek");

      function _pctFromClientX(clientX) {
        const rect = seekEl.getBoundingClientRect();
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      }

      function _updateVisuals(pct) {
        const fill = _el("player-full-progress-fill");
        const thumb = _el("player-full-seek-thumb");
        if (fill) fill.style.width = (pct * 100) + "%";
        if (thumb) thumb.style.left = (pct * 100) + "%";
      }

      function _commitSeek(clientX) {
        if (!_audio || !_audio.duration) return;
        const pct = _pctFromClientX(clientX);
        _updateVisuals(pct);
        _audio.currentTime = pct * _audio.duration;
      }

      let _pendingSeekX = null;

      seekEl?.addEventListener("mousedown", (e) => {
        _dragging = true;
        _pendingSeekX = e.clientX;
        seekEl.classList.add("seeking");
        _updateVisuals(_pctFromClientX(e.clientX));
      });
      document.addEventListener("mousemove", (e) => {
        if (!_dragging) return;
        _pendingSeekX = e.clientX;
        _updateVisuals(_pctFromClientX(e.clientX));
      });
      document.addEventListener("mouseup", () => {
        if (!_dragging) return;
        _dragging = false;
        seekEl.classList.remove("seeking");
        if (_pendingSeekX !== null) { _commitSeek(_pendingSeekX); _pendingSeekX = null; }
      });

      seekEl?.addEventListener("touchstart", (e) => {
        _dragging = true;
        _pendingSeekX = e.touches[0].clientX;
        seekEl.classList.add("seeking");
        _updateVisuals(_pctFromClientX(e.touches[0].clientX));
      }, { passive: true });
      document.addEventListener("touchmove", (e) => {
        if (!_dragging) return;
        _pendingSeekX = e.touches[0].clientX;
        _updateVisuals(_pctFromClientX(e.touches[0].clientX));
      }, { passive: true });
      document.addEventListener("touchend", (e) => {
        if (!_dragging) return;
        _dragging = false;
        seekEl.classList.remove("seeking");
        const x = e.changedTouches[0].clientX;
        _commitSeek(x);
        _pendingSeekX = null;
      });
    }

    // ── Full overlay — speed ──
    _el("player-full-speed-btn")?.addEventListener("click", () => {
      if (!_audio) return;
      const cur = _audio.playbackRate;
      const idx = _SPEEDS.findIndex((r) => Math.abs(r - cur) < 0.01);
      _audio.playbackRate = _SPEEDS[(idx + 1) % _SPEEDS.length];
      _updateSpeedDisplay();
      _savePerFeedSpeed();
    });

    // ── Full overlay — volume ──
    _el("player-full-volume")?.addEventListener("input", (e) => {
      if (_audio) _audio.volume = e.target.value / 100;
    });

    // ── Full overlay — sleep ──
    _el("player-full-sleep-btn")?.addEventListener("click", () => {
      const cur = _sleepMinutes;
      const idx = _SLEEP_OPTIONS.indexOf(cur);
      const next = _SLEEP_OPTIONS[(idx + 1) % _SLEEP_OPTIONS.length];
      _setSleepTimer(next);
    });

    // ── Full overlay — mark played ──
    _el("player-full-mark-played")?.addEventListener("click", () => {
      if (!_currentEp) return;
      const epId = _currentEp.id;
      const wasPlaying = _audio && !_audio.paused;

      if (wasPlaying) {
        const duration = (_audio && _audio.duration && isFinite(_audio.duration))
          ? Math.floor(_audio.duration) : null;
        _audio.pause();
        _audio.src = "";
        _clearSleepTimer();
        _sleepMinutes = 0;
        _currentEp = null;
        _syncPlayBtns();
        _collapse();
        _el("player-bar")?.classList.add("hidden");
        document.body.classList.remove("has-player");

        const finish = () => {
          API.togglePlayed(epId).catch(() => {});
          const row = document.getElementById(`ep-${epId}`);
          const fill = row?.querySelector(".ep-listen-fill");
          const label = row?.querySelector(".ep-listen-label");
          if (fill) fill.style.width = "100%";
          if (label) { label.textContent = "100% listened"; label.classList.add("ep-listen-complete"); }
          row?.querySelector(".ep-listen-bar-wrap")?.classList.add("ep-complete");
          Toast.success("Marked as played");
        };

        if (duration) {
          API.updateProgress(epId, duration).then(finish).catch(finish);
        } else {
          finish();
        }
      } else {
        API.togglePlayed(epId)
          .then(() => Toast.success("Marked as played"))
          .catch((e) => Toast.error(e.message));
      }
    });

    // ── Full overlay — close ──
    _el("player-full-close-btn")?.addEventListener("click", _closePlayer);

    // ── Swipe to collapse ──
    let _touchStartY = 0;
    const fullEl = _el("player-full");
    if (fullEl) {
      fullEl.addEventListener("touchstart", (e) => {
        _touchStartY = e.touches[0].clientY;
      }, { passive: true });
      fullEl.addEventListener("touchend", (e) => {
        const dy = e.changedTouches[0].clientY - _touchStartY;
        if (dy > 80) _collapse();
      });
    }

    // ── Browser back collapses overlay ──
    window.addEventListener("popstate", () => {
      if (_expanded) _collapse();
    });
  }

  // ── Chevron / transport SVGs ───────────────────────────────

  const _SVG_CHEVRON_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><polyline points="6 9 12 15 18 9"/></svg>`;

  const _SVG_BACK30 = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="28" height="28">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
    <polyline points="3 3 3 8 8 8"/>
    <text x="12" y="12" font-size="7" fill="currentColor" stroke="none" font-weight="bold" text-anchor="middle" dominant-baseline="central">30</text>
  </svg>`;

  const _SVG_FWD30 = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="28" height="28">
    <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
    <polyline points="21 3 21 8 16 8"/>
    <text x="12" y="12" font-size="7" fill="currentColor" stroke="none" font-weight="bold" text-anchor="middle" dominant-baseline="central">30</text>
  </svg>`;

  const _SVG_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  const _SVG_CHECK_CIRCLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
  const _SVG_STOP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`;
  const _SVG_SPEAKER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;

  // ── Init ───────────────────────────────────────────────────

  function init() {
    const bar = document.createElement("div");
    bar.id = "player-bar";
    bar.className = "hidden";
    bar.innerHTML = `
      <!-- Mini bar -->
      <div id="player-mini">
        <div id="player-mini-seek">
          <div id="player-mini-progress-fill"></div>
        </div>
        <div id="player-mini-inner">
          <div id="player-mini-art">
            <div class="player-art-fallback">${_PODCAST_ICON}</div>
          </div>
          <div id="player-mini-info">
            <div id="player-mini-title">—</div>
            <div id="player-mini-feed"></div>
          </div>
          <button id="player-mini-play" title="Play/Pause">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22" id="player-mini-play-icon">
              ${_playIcon()}
            </svg>
          </button>
        </div>
      </div>

      <!-- Full overlay -->
      <div id="player-full">
        <!-- Top: header + artwork + info -->
        <div id="player-full-top">
          <div id="player-full-header">
            <button id="player-full-collapse-btn" title="Minimize">${_SVG_CHEVRON_DOWN}</button>
            <span id="player-full-header-label">Now Playing</span>
          </div>

          <div id="player-full-art">
            <div class="player-art-fallback">${_PODCAST_ICON}</div>
          </div>

          <div id="player-full-info">
            <div id="player-full-title">—</div>
            <div id="player-full-feed"></div>
          </div>
        </div>

        <!-- Bottom: seek + transport + secondary -->
        <div id="player-full-bottom">
          <div id="player-full-seek-wrap">
            <div id="player-full-seek">
              <div id="player-full-progress-fill"></div>
              <div id="player-full-seek-thumb"></div>
            </div>
            <div id="player-full-times">
              <span id="player-time-current">0:00</span>
              <span id="player-time-total">0:00</span>
            </div>
          </div>

          <div id="player-full-controls">
            <button id="player-full-back-btn" title="Back 30s">${_SVG_BACK30}</button>
            <button id="player-full-play-btn" title="Play/Pause">
              <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28" id="player-full-play-icon">
                ${_playIcon()}
              </svg>
            </button>
            <button id="player-full-fwd-btn" title="Forward 30s">${_SVG_FWD30}</button>
          </div>

          <div id="player-full-secondary">
            <button id="player-full-speed-btn" class="player-ctrl-btn" title="Playback speed">
              <span id="player-full-speed" class="player-ctrl-icon-text">1×</span>
              <span class="player-ctrl-label">Speed</span>
            </button>
            <button id="player-full-sleep-btn" class="player-ctrl-btn" title="Sleep timer">
              ${_SVG_MOON}
              <span id="player-full-sleep-label" class="player-ctrl-label">Sleep</span>
            </button>
            <button id="player-full-mark-played" class="player-ctrl-btn" title="Mark as played">
              ${_SVG_CHECK_CIRCLE}
              <span class="player-ctrl-label">Mark Played</span>
            </button>
            <button id="player-full-close-btn" class="player-ctrl-btn" title="Stop playback">
              ${_SVG_STOP}
              <span class="player-ctrl-label">Stop</span>
            </button>
          </div>

          <div id="player-full-volume-row">
            ${_SVG_SPEAKER}
            <input id="player-full-volume" type="range" min="0" max="100" value="100" title="Volume" />
          </div>
        </div>
      </div>`;
    document.body.appendChild(bar);
    _wire();
  }

  return { init, play, togglePause, seek, currentId, isPlaying, setThreshold, syncPlayBtns: _syncPlayBtns, resumeIcon: _resumeIcon, playIcon: _playIcon };
})();
