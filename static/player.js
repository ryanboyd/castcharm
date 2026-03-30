"use strict";

// ============================================================
// Persistent in-page audio player
// ============================================================
const Player = (() => {
  let _currentEp = null;  // { id, title, feedTitle, feedId, duration, resumeAt }
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
      _el("player-time").textContent = `${_fmtTime(cur)} / ${_fmtTime(dur)}`;
      const pct = dur > 0 ? (cur / dur) * 100 : 0;
      _el("player-progress-fill").style.width = pct + "%";

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
      _el("player-play-icon").innerHTML = _playIcon();
      _syncPlayBtns();
      // Auto-play next episode
      const epId = _currentEp?.id;
      if (epId) window._autoPlayNext?.(epId);
    });

    _audio.addEventListener("play", () => {
      _el("player-play-icon").innerHTML = _pauseIcon();
      _syncPlayBtns();
    });

    _audio.addEventListener("pause", () => {
      _el("player-play-icon").innerHTML = _playIcon();
      _syncPlayBtns();
    });
  }

  // ── Icon helpers ───────────────────────────────────────────

  function _playIcon() {
    return '<polygon points="5 3 19 12 5 21 5 3"/>';
  }

  function _resumeIcon() {
    // Play triangle shifted right with a vertical bar on the left — indicates "continue from here"
    return '<line x1="4" y1="4" x2="4" y2="20" stroke-width="2.5"/><polygon points="8 3 21 12 8 21 8 3"/>';
  }

  function _pauseIcon() {
    return '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
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
    const el = _el("player-speed");
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
    // Tick every 30s to update display
    _sleepTickId = setInterval(_updateSleepDisplay, 30000);
    _updateSleepDisplay();
  }

  function _updateSleepDisplay() {
    const el = _el("player-sleep-label");
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
    // ep: { id, title, feedTitle, feedId, resumeAt }
    _initAudio();
    _currentEp = ep;
    _lastReportedPos = ep.resumeAt || 0;
    _lastDisplayedPct = -1;
    _autoPlayedFired = false;

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

    const bar = _el("player-bar");
    if (bar) {
      _el("player-title").textContent = ep.title || "Untitled";
      _el("player-feed").textContent = ep.feedTitle || "";
    }

    // mediaSession integration
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: ep.title || "Untitled",
        artist: ep.feedTitle || "",
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

  // ── DOM wiring ─────────────────────────────────────────────

  function _wire() {
    _el("player-play-btn")?.addEventListener("click", () => {
      if (!_audio) return;
      if (_audio.paused) _audio.play().catch(() => {});
      else _audio.pause();
    });

    _el("player-back-btn")?.addEventListener("click", () => seek(-30));
    _el("player-fwd-btn")?.addEventListener("click", () => seek(30));

    _el("player-speed-btn")?.addEventListener("click", () => {
      if (!_audio) return;
      const cur = _audio.playbackRate;
      const idx = _SPEEDS.findIndex((r) => Math.abs(r - cur) < 0.01);
      _audio.playbackRate = _SPEEDS[(idx + 1) % _SPEEDS.length];
      _updateSpeedDisplay();
      _savePerFeedSpeed();
    });

    _el("player-volume")?.addEventListener("input", (e) => {
      if (_audio) _audio.volume = e.target.value / 100;
    });

    _el("player-seek")?.addEventListener("click", (e) => {
      if (!_audio || !_audio.duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      _audio.currentTime = pct * _audio.duration;
    });

    _el("player-sleep-btn")?.addEventListener("click", () => {
      const cur = _sleepMinutes;
      const idx = _SLEEP_OPTIONS.indexOf(cur);
      const next = _SLEEP_OPTIONS[(idx + 1) % _SLEEP_OPTIONS.length];
      _setSleepTimer(next);
    });

    _el("player-close-btn")?.addEventListener("click", () => {
      if (_audio) {
        _audio.pause();
        _audio.src = "";
      }
      _clearSleepTimer();
      _sleepMinutes = 0;
      const bar = _el("player-bar");
      if (bar) bar.classList.add("hidden");
      document.body.classList.remove("has-player");
      _currentEp = null;
      _syncPlayBtns();
    });

    _el("player-mark-played")?.addEventListener("click", () => {
      if (!_currentEp) return;
      const epId = _currentEp.id;
      const wasPlaying = _audio && !_audio.paused;

      if (wasPlaying) {
        // Stop playback and save position as full duration before marking
        const duration = (_audio && _audio.duration && isFinite(_audio.duration))
          ? Math.floor(_audio.duration) : null;
        _audio.pause();
        _audio.src = "";
        _clearSleepTimer();
        _sleepMinutes = 0;
        _currentEp = null;
        _syncPlayBtns();
        _el("player-bar")?.classList.add("hidden");

        const finish = () => {
          API.togglePlayed(epId).catch(() => {});
          // Update listen bar to 100%
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
  }

  function init() {
    const bar = document.createElement("div");
    bar.id = "player-bar";
    bar.className = "hidden";
    bar.innerHTML = `
      <div id="player-seek" title="Click to seek">
        <div id="player-progress-fill"></div>
      </div>
      <div id="player-inner">
        <div id="player-info">
          <div id="player-title">—</div>
          <div id="player-feed"></div>
        </div>
        <div id="player-controls">
          <button id="player-back-btn" title="Back 30s">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/>
              <text x="5" y="13" font-size="7" fill="currentColor" stroke="none" font-weight="bold">30</text>
            </svg>
          </button>
          <button id="player-play-btn" title="Play/Pause">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22" id="player-play-icon">
              ${_playIcon()}
            </svg>
          </button>
          <button id="player-fwd-btn" title="Forward 30s">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-3.5"/>
              <text x="5" y="13" font-size="7" fill="currentColor" stroke="none" font-weight="bold">30</text>
            </svg>
          </button>
          <button id="player-speed-btn" title="Playback speed"><span id="player-speed">1×</span></button>
        </div>
        <div id="player-right">
          <span id="player-time">0:00 / 0:00</span>
          <input id="player-volume" type="range" min="0" max="100" value="100" title="Volume" />
          <button id="player-sleep-btn" title="Sleep timer — cycles Off / 15m / 30m / 45m / 60m" class="btn-ghost-small">
            <span id="player-sleep-label">Sleep</span>
          </button>
          <button id="player-mark-played" title="Mark as played" class="btn-ghost-small">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
          <button id="player-close-btn" title="Close player" class="btn-ghost-small">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>`;
    document.body.appendChild(bar);
    _wire();
  }

  return { init, play, togglePause, seek, currentId, isPlaying, setThreshold, syncPlayBtns: _syncPlayBtns, resumeIcon: _resumeIcon, playIcon: _playIcon };
})();
