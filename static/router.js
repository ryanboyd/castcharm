"use strict";

// ============================================================
// Router (hash-based SPA)
// ============================================================
const Router = {
  routes: {},
  register(path, handler) { this.routes[path] = handler; },
  async navigate(path) {
    window.location.hash = path.startsWith("#") ? path : "#" + path;
  },
  async handle() {
    const hash = window.location.hash || "#/";
    const path = hash.slice(1) || "/";

    // Update nav active state
    for (const a of document.querySelectorAll(".nav-item")) {
      const view = a.dataset.view;
      const active =
        (view === "dashboard" && (path === "/" || path === "")) ||
        (view !== "dashboard" && path.startsWith("/" + view));
      a.classList.toggle("active", active);
    }

    // Find matching route
    for (const [pattern, handler] of Object.entries(this.routes)) {
      const regex = new RegExp(
        "^" + pattern.replace(/:[^/]+/g, "([^/]+)") + "$"
      );
      const m = path.match(regex);
      if (m) {
        // Cancel any pending timers when navigating away
        if (window._syncPollTimer) { clearInterval(window._syncPollTimer); window._syncPollTimer = null; }
        if (window._logsInterval)  { clearInterval(window._logsInterval);  window._logsInterval  = null; }
        if (typeof _stopDLPoll === "function") _stopDLPoll();
        window._onSyncIdle     = null;
        window._onDownloadIdle = null;
        window._onStatusPoll   = null;
        const content = document.getElementById("content");
        content.innerHTML = `<div class="loading-spinner"><div class="spinner"></div></div>`;
        try {
          await handler(...m.slice(1));
        } catch (e) {
          content.innerHTML = `<div class="page"><div class="empty-state">
            <div class="empty-state-icon">⚠</div>
            <div class="empty-state-title">Error loading page</div>
            <div class="empty-state-desc">${e.message}</div>
          </div></div>`;
        }
        return;
      }
    }
    Router.navigate("/");
  },
};

window.addEventListener("hashchange", (e) => {
  closeSidebar();
  if (window._settingsDirty) {
    // Restore the previous URL in the address bar without firing another hashchange
    const oldHash = "#" + (e.oldURL.split("#")[1] || "/");
    history.replaceState(null, "", oldHash);
    window._settingsPendingNav = e.newURL.split("#")[1] || "/";
    _showSettingsNavGuard();
    return;
  }
  Router.handle();
});

function _showSettingsNavGuard() {
  Modal.open("Unsaved Changes", `
    <p style="color:var(--text-2);font-size:14px;margin-bottom:20px">Your settings have unsaved changes. Would you like to save them before leaving?</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-action="settings-stay">Stay</button>
      <button class="btn btn-ghost" data-action="settings-discard">Discard</button>
      <button class="btn btn-primary" data-action="settings-save">Save &amp; Leave</button>
    </div>
  `);
}

window._settingsNavDiscard = function() {
  window._settingsDirty = false;
  const path = window._settingsPendingNav;
  window._settingsPendingNav = null;
  Modal.close();
  if (path) Router.navigate(path);
};

window._settingsNavSave = async function() {
  const path = window._settingsPendingNav;
  window._settingsPendingNav = null;
  Modal.close();
  if (typeof window._settingsSave === "function") {
    const ok = await window._settingsSave();
    if (ok && path) Router.navigate(path);
  } else if (path) {
    window._settingsDirty = false;
    Router.navigate(path);
  }
};

function toggleSidebar() {
  const s = document.getElementById("sidebar");
  const o = document.getElementById("sidebar-overlay");
  const open = s.classList.toggle("open");
  o.classList.toggle("open", open);
}

function closeSidebar() {
  document.getElementById("sidebar")?.classList.remove("open");
  document.getElementById("sidebar-overlay")?.classList.remove("open");
}

// ============================================================
// Status polling
// ============================================================

// _setNavBadge is the single authoritative writer for the sidebar download count badge.
// All other code paths that need to update it must call this function so the
// show/hide mechanism (style.display) is always applied consistently.
window._setNavBadge = function (n) {
  const badge = document.getElementById("dl-nav-badge");
  if (!badge) return;
  badge.textContent = n > 0 ? n : "";
  badge.style.display = n > 0 ? "" : "none";
};
let _statusInterval;
let _statusBusy = false;
// _statusSeq lets us discard stale in-flight responses: every call to updateStatus()
// takes a snapshot of the counter; if a newer call has already landed by the time
// this one resolves, we skip the DOM update so the UI never shows outdated data.
let _statusSeq = 0;
// Track previous syncing count so we can fire window._onSyncIdle when a sync finishes.
let _prevSyncingCount    = 0;
let _prevDownloadingCount = 0;

// startStatusPolling fires an immediate status fetch then sets up an adaptive interval:
// 3 s when something is happening (downloads, syncs, imports), 10 s when idle.
// When the busy state changes we tear down the current interval and restart so the
// new cadence takes effect immediately rather than waiting for the current tick to expire.
function startStatusPolling() {
  updateStatus();
  _statusInterval = setInterval(async () => {
    const s = await updateStatus();

    // Fire the sync-idle hook when syncing transitions from active → done.
    // Views that care (feeds list, dashboard) set window._onSyncIdle to a refresh fn.
    const nowSyncing = s?.syncing_count ?? 0;
    if (_prevSyncingCount > 0 && nowSyncing === 0 && typeof window._onSyncIdle === "function") {
      window._onSyncIdle();
    }
    _prevSyncingCount = nowSyncing;

    // Fire the download-idle hook when all downloads finish.
    const nowDownloading = (s?.active_downloads ?? 0) + (s?.download_queue_size ?? 0);
    if (_prevDownloadingCount > 0 && nowDownloading === 0 && typeof window._onDownloadIdle === "function") {
      window._onDownloadIdle();
    }
    _prevDownloadingCount = nowDownloading;

    // Let the active view patch itself on every tick while something is happening.
    if (s && typeof window._onStatusPoll === "function") window._onStatusPoll(s);

    const nowBusy = s && (
      !s.scheduler_running ||
      (s.syncing_count ?? 0) > 0 ||
      s.active_downloads > 0 ||
      s.download_queue_size > 0 ||
      (s.importing_count ?? 0) > 0 ||
      s.scanning
    );
    if (nowBusy !== _statusBusy) {
      _statusBusy = nowBusy;
      clearInterval(_statusInterval);
      startStatusPolling();
    }
  }, _statusBusy ? 3000 : 10000);
}

function _fmtTime(isoStr) {
  if (!isoStr) return "";
  const hasOffset = isoStr.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(isoStr);
  const d = new Date(hasOffset ? isoStr : isoStr + "Z");
  if (isNaN(d)) return isoStr;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function _statusItem(dotClass, main, sub) {
  return `<div class="status-item">
    <span class="status-dot ${dotClass}"></span>
    <div class="status-item-text">
      <span class="status-item-main">${main}</span>
      ${sub ? `<span class="status-item-sub">${sub}</span>` : ""}
    </div>
  </div>`;
}

async function updateStatus() {
  const mySeq = ++_statusSeq;
  const container = document.getElementById("status-items");

  try {
    const s = await API.getStatus();

    // A newer call already landed — discard this stale response
    if (mySeq !== _statusSeq) return s;

    const items = [];

    if (!s.scheduler_running) {
      items.push(_statusItem("error", "Scheduler offline", "Background tasks are not running"));
    } else {
      // — Active operations (one item each) —
      if (s.scanning) {
        items.push(_statusItem("active", "Scanning downloads folder", "Looking for untracked podcasts…"));
      }
      if ((s.syncing_count ?? 0) > 0) {
        const n = s.syncing_count;
        items.push(_statusItem("active", `Syncing ${n} feed${n > 1 ? "s" : ""}`, "Checking for new episodes"));
      }
      if (s.active_downloads > 0 || s.download_queue_size > 0) {
        const total = (s.active_downloads ?? 0) + (s.download_queue_size ?? 0);
        const main = `Downloading ${total} episode${total !== 1 ? "s" : ""}`;
        const parts = [];
        if (s.active_downloads > 0) parts.push(`${s.active_downloads} active`);
        if (s.download_queue_size > 0) parts.push(`${s.download_queue_size} queued`);
        items.push(_statusItem("active", main, parts.join(", ")));
      }
      if ((s.importing_count ?? 0) > 0) {
        const n = s.importing_count;
        items.push(_statusItem("active",
          `Importing files${n > 1 ? ` (${n} podcasts)` : ""}`, "Reading audio file metadata…"));
      }
      if (s.xml_regenerating) {
        items.push(_statusItem("active", "Regenerating feed files", "Rebuilding complete-feed.xml for all podcasts…"));
      }
      if (s.opml_generating) {
        items.push(_statusItem("active", "Exporting OPML", "Writing castcharm-export.opml…"));
      }
      if (s.autoclean_running) {
        items.push(_statusItem("active", "Running auto-cleanup", "Deleting episode files per cleanup settings…"));
      }

      // — Persistent warnings —
      if (s.download_window_paused) {
        const sub = s.download_window_next_open
          ? `Resumes at ${_fmtTime(s.download_window_next_open)}`
          : "Downloads are queued";
        items.push(_statusItem("warn", "Downloads paused", sub));
      }
      if (s.episodes_failed > 0) {
        items.push(_statusItem("warn",
          `${s.episodes_failed} episode${s.episodes_failed > 1 ? "s" : ""} failed to download`,
          "Check individual feeds for details"));
      }

      // — Idle / ready —
      if (items.length === 0) {
        items.push(_statusItem("ok", "All good", null));
      }

      // — Next sync (always shown when scheduled, hidden while actively syncing) —
      if (s.next_sync_at && !((s.syncing_count ?? 0) > 0)) {
        const raw = s.next_sync_at;
        const hasOffset = raw.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(raw);
        const ts = hasOffset ? raw : raw + "Z";
        const diffMs  = new Date(ts) - Date.now();
        const diffMin = Math.max(0, Math.round(diffMs / 60000));
        const syncLabel = diffMin < 1 ? "Syncing soon…"
          : diffMin < 60 ? `Next sync in ${diffMin}m`
          : (() => {
              const h = Math.floor(diffMin / 60);
              const m = diffMin % 60;
              return `Next sync in ${h}h${m > 0 ? ` ${m}m` : ""}`;
            })();
        items.push(_statusItem("ok", syncLabel, null));
      }
    }

    if (container) container.innerHTML = items.join("");

    // Nav badge for downloads
    _setNavBadge(s.active_downloads + s.download_queue_size);

    // Keep the Downloads page tab-header badges live regardless of which subtab
    // is active.  _setTabBadge is a no-op when the elements aren't in the DOM.
    if (typeof window._setTabBadge === "function") {
      window._setTabBadge("badge-inprogress", (s.active_downloads ?? 0) + (s.download_queue_size ?? 0));
      window._setTabBadge("badge-failed", s.episodes_failed ?? 0, "badge-error");
    }

    const verEl = document.getElementById("app-version");
    if (verEl && s.version) verEl.textContent = `v${s.version}`;

    return s;
  } catch (_) {
    if (container) container.innerHTML = _statusItem("error", "Cannot reach server", "Check that the app is running");
    return null;
  }
}
