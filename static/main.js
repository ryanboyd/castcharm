"use strict";

// ============================================================
// Wire static-shell event handlers (previously inline onclick= in index.html)
// We do this here rather than inline so we can ship a strict CSP that blocks
// external script sources. All referenced functions are defined in the scripts
// loaded before main.js (router.js, ui.js, search.js).
// ============================================================
document.getElementById("sidebar-overlay").addEventListener("click", closeSidebar);
document.getElementById("nav-search-btn").addEventListener("click", showSearch);
document.getElementById("hamburger").addEventListener("click", toggleSidebar);
document.getElementById("mobile-header-logo").addEventListener("click", () => Router.navigate("/"));
document.getElementById("modal-close").addEventListener("click", () => Modal.close());

// ============================================================
// Register routes and boot
// ============================================================
Router.register("/", viewDashboard);
Router.register("/feeds", viewFeeds);
Router.register("/feeds/:id", viewFeedDetail);
Router.register("/downloads", viewDownloads);
Router.register("/settings", viewSettings);
Router.register("/stats", viewStats);
Router.register("/logs", viewLogs);

// Initialize persistent audio player
Player.init();

// Called whenever an API response returns 401 (session expired, etc.)
window._onAuthRequired = function() {
  if (typeof _statusInterval !== "undefined") clearInterval(_statusInterval);
  showLoginOverlay();
};

// ── Storage helpers ───────────────────────────────────────────────────────────

function _clearAppStorage() {
  // Collect first — iterating localStorage while removing is unreliable.
  const remove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k === "cc_theme" || k.startsWith("podcast_speed_")) remove.push(k);
  }
  remove.forEach((k) => localStorage.removeItem(k));
}

// ── Boot sequence ─────────────────────────────────────────────────────────────
// Check auth/setup state before starting the app. This is the single entry
// point that decides whether to show the setup wizard, the login screen, or
// the normal app shell.
async function _bootApp() {
  try {
    const auth = await API.getAuthStatus();

    if (!auth.setup_complete) {
      // Redirect to root so the URL is clean during setup
      history.replaceState(null, "", "/#/");
      // Wipe all app localStorage on a fresh install. The DB is gone so any
      // surviving keys (theme, per-feed playback speeds, etc.) belong to a
      // previous instance and must not bleed through.
      _clearAppStorage();
      applyTheme("midnight");
      showSetupWizard();
      return;
    }

    if (auth.auth_enabled && !auth.logged_in) {
      history.replaceState(null, "", "/#/");
      const cachedTheme = localStorage.getItem("cc_theme") || "midnight";
      applyTheme(cachedTheme);
      showLoginOverlay();
      return;
    }

    // Normal app boot
    _startApp();
  } catch (_) {
    // Server unreachable — try to start anyway (middleware will return 401s)
    _startApp();
  }
}

function _startApp() {
  // Reveal the app shell now that we know we're allowed to render it
  document.getElementById("app").style.display = "";
  // Apply theme and start polling
  API.getSettings().then((s) => {
    const theme = s.theme || "midnight";
    localStorage.setItem("cc_theme", theme);
    applyTheme(theme);
    Player.setThreshold(s.auto_played_threshold ?? 95);
    window._appTimezone = s.timezone || "UTC";
    // Show/hide logout button based on auth state
    _updateAuthNav(s);
  }).catch(() => {});
  startStatusPolling();
  Router.handle();
}

function _updateAuthNav(settings) {
  API.getAuthStatus().then((auth) => {
    const slot = document.getElementById("logout-slot");
    if (!slot) return;
    if (!auth.auth_enabled) { slot.innerHTML = ""; return; }
    if (document.getElementById("logout-btn")) return;
    const btn = document.createElement("button");
    btn.id        = "logout-btn";
    btn.type      = "button";
    btn.className = "nav-item";
    btn.style.cssText = "width:100%;border:none;background:none;cursor:pointer;border-bottom:1px solid var(--border);padding-bottom:10px;border-radius:0";
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>Log Out`;
    btn.onclick = async () => {
      await API.logout().catch(() => {});
      window.location.reload();
    };
    slot.appendChild(btn);
  }).catch(() => {});
}

_bootApp();

// ============================================================
// Keyboard shortcuts
// ============================================================
document.addEventListener("keydown", (e) => {
  // Cmd/Ctrl+K — open search from anywhere
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    if (typeof showSearch === "function") showSearch();
    return;
  }

  // Skip when typing in an input
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
  if (e.metaKey || e.ctrlKey) return;

  switch (e.key) {
    case "1": Router.navigate("/"); break;
    case "2": Router.navigate("/feeds"); break;
    case "3": Router.navigate("/downloads"); break;
    case "4": Router.navigate("/settings"); break;
    case "5": Router.navigate("/stats"); break;
    case "6": Router.navigate("/logs"); break;
    case " ":
      if (Player.currentId() !== null) { e.preventDefault(); Player.togglePause(); }
      break;
    case "ArrowLeft":
      if (Player.currentId() !== null) { e.preventDefault(); Player.seek(-30); }
      break;
    case "ArrowRight":
      if (Player.currentId() !== null) { e.preventDefault(); Player.seek(30); }
      break;
  }
});

// ============================================================
// Real-time download progress + status polling
// ============================================================
const _monitoredIds = new Set(); // episode IDs we know are active

// _patchEpRow updates a single episode row in the per-feed view without re-rendering
// the whole list.  It handles three distinct cases in priority order.
function _patchEpRow(ep, activeProgress = {}) {
  const row = document.getElementById(`ep-${ep.id}`);
  if (!row) return;

  const prevStatus = row.dataset.status;

  // Case 1 — Terminal state (downloaded / failed): we want to animate the progress
  // bar to 100% before replacing the row so the user sees the fill complete rather
  // than blinking out.  The _completing flag prevents a double-trigger while the
  // 330ms animation is in flight.
  if (ep.status === "downloaded" || ep.status === "failed") {
    if (row._completing) return;
    if (prevStatus === "downloading") {
      row._completing = true;
      const fill = row.querySelector(".progress-fill");
      if (fill) { fill.style.transition = "width 0.3s ease-out"; fill.style.width = "100%"; }
      row.style.pointerEvents = "none";
      setTimeout(() => {
        row._completing = false;
        if (typeof window.updateEpisodeRow === "function") window.updateEpisodeRow(ep);
      }, 330);
    } else {
      if (typeof window.updateEpisodeRow === "function") window.updateEpisodeRow(ep);
    }
    return;
  }

  // Case 2 — queued → downloading transition: we replace the whole row rather than
  // patching in place because the queued CSS rule applies `width: 100% !important`
  // via a pulse animation.  Patching data-status and then setting a small width
  // would trigger a 2-second reverse animation (100% → current%).  A fresh element
  // has no animation history and starts the fill at the correct position.
  if (prevStatus === "queued" && ep.status === "downloading") {
    if (typeof window.updateEpisodeRow === "function") window.updateEpisodeRow(ep);
    return;
  }

  // Case 3 — Steady-state: patch data-status, the status badge, and the progress
  // fill in place to avoid the layout churn of a full row replacement.
  row.dataset.status = ep.status;

  const meta = row.querySelector(".episode-meta");
  if (meta) {
    const badges = meta.querySelectorAll(".badge");
    const statusLabels = new Set(["Not Downloaded", "Queued", "Downloading", "Downloaded", "Failed", "Skipped"]);
    for (const b of badges) {
      if (statusLabels.has(b.textContent.trim())) {
        b.outerHTML = statusBadge(ep.status);
        break;
      }
    }
  }

  const info = row.querySelector(".episode-info");
  if (info) {
    let bar = row.querySelector(".progress-bar");
    if (ep.status === "downloading" || ep.status === "queued") {
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "progress-bar";
        bar.innerHTML = '<div class="progress-fill"></div>';
        info.appendChild(bar);
      }
      const fill = bar.querySelector(".progress-fill");
      if (fill) {
        const pct = ep.status === "downloading"
          ? (activeProgress[String(ep.id)] ?? ep.download_progress)
          : 0;
        fill.style.width = pct + "%";
      }
    } else {
      if (bar) bar.remove();
    }
  }
}

// We poll every 2 s to keep in-progress download rows up to date throughout the app.
// The downloads page In Progress tab manages its own poll (_doPollTick) with identical
// timing, so we skip when that tab is active to avoid redundant requests.
setInterval(async () => {
  try {
    if (!_statusBusy && _monitoredIds.size === 0) return;

    // The downloads page In Progress tab has its own dedicated poll (_doPollTick).
    // Skip here to avoid redundant fetches and conflicting DOM writes.
    if (window._dlActiveTab === "inprogress") return;

    const [downloading, queued, activeProgress] = await Promise.all([
      API.getEpisodes({ status: "downloading", limit: 50 }),
      API.getEpisodes({ status: "queued", limit: 50 }),
      API.getActiveProgress(),
    ]);
    const allActive = [...downloading, ...queued];
    const currentIds = new Set(allActive.map((e) => e.id));

    for (const ep of allActive) {
      _monitoredIds.add(ep.id);
      _patchEpRow(ep, activeProgress);
    }

    // Episodes that were active but are no longer — fetch final state and re-render.
    for (const id of [..._monitoredIds]) {
      if (!currentIds.has(id)) {
        _monitoredIds.delete(id);
        try {
          const ep = await API.getEpisode(id);
          _patchEpRow(ep, activeProgress);
        } catch (_) {}
      }
    }
  } catch (_) {}
}, 2000);
