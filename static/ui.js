"use strict";

// ============================================================
// Toast notifications
// ============================================================
const Toast = {
  show(msg, type = "info", duration = 3500) {
    const container = document.getElementById("toast-container");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    const icons = { success: "✓", error: "✕", info: "ℹ" };
    const iconEl = document.createElement("span");
    iconEl.style.cssText = "font-weight:700;font-size:15px;flex-shrink:0";
    iconEl.textContent = icons[type] || "ℹ";
    const msgEl = document.createElement("span");
    msgEl.textContent = msg;  // textContent: message is never interpreted as HTML
    el.appendChild(iconEl);
    el.appendChild(msgEl);
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add("removing");
      el.addEventListener("animationend", () => el.remove());
    }, duration);
  },
  success: (m) => Toast.show(m, "success"),
  error: (m) => Toast.show(m, "error", 5000),
  info: (m) => Toast.show(m, "info"),
};

// ============================================================
// Modal
// ============================================================
const Modal = {
  open(title, bodyHTML, onOpen) {
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-body").innerHTML = bodyHTML;
    document.getElementById("modal-overlay").classList.remove("hidden");
    if (onOpen) onOpen(document.getElementById("modal-body"));
  },
  close() {
    document.getElementById("modal-overlay").classList.add("hidden");
    document.getElementById("modal-body").innerHTML = "";
    document.getElementById("modal").classList.remove("modal-wide");
  },
};

document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (window._opmlImporting) return;
  if (e.target === document.getElementById("modal-overlay")) Modal.close();
});

// ============================================================
// Global image error handler
// ============================================================
// Replaces all inline onerror= attributes on <img> elements.
// Hides the broken image; if the next sibling was hidden (display:none)
// it is a placeholder fallback — reveal it.
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img.tagName !== "IMG") return;
  img.style.display = "none";
  const sibling = img.nextElementSibling;
  if (sibling && sibling.style.display === "none") {
    sibling.style.display = "flex";
  }
}, true); // useCapture required — error events don't bubble

// ============================================================
// Global data-action dispatcher
// ============================================================
// All inline onclick= attributes in templates are replaced with
// data-action="..." + data-* attributes and handled here.
// This lets us drop 'unsafe-inline' from the CSP script-src.
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  // ── Navigation ────────────────────────────────────────────
  if (action === "navigate") {
    if (el.dataset.epScroll) window._pendingEpScroll = Number(el.dataset.epScroll);
    if (el.dataset.dlTab)    window._pendingDLTab    = el.dataset.dlTab;
    Router.navigate(el.dataset.path);
    return;
  }

  // ── Search navigate (also hides search overlay) ───────────
  if (action === "search-navigate") {
    hideSearch();
    window._pendingEpScroll = Number(el.dataset.epId);
    Router.navigate(`/feeds/${el.dataset.feedId}`);
    return;
  }

  // ── Modal close ───────────────────────────────────────────
  if (action === "modal-close") { Modal.close(); return; }

  // ── Toggle collapsible panel ──────────────────────────────
  if (action === "toggle-panel") { togglePanel(el.dataset.panel); return; }

  // ── Play episode ──────────────────────────────────────────
  if (action === "play-episode") {
    e.stopPropagation();
    playEpisode(Number(el.dataset.epId), el.dataset.resume === "1");
    return;
  }

  // ── Toggle episode notes panel ───────────────────────────
  if (action === "toggle-ep-notes") { _toggleEpNotes(Number(el.dataset.epId)); return; }

  // ── Stop propagation only (dropdown wrapper divs) ─────────
  if (action === "stop-prop") { e.stopPropagation(); return; }

  // ── Toggle .ep-more-wrap open/closed ─────────────────────
  if (action === "toggle-more-wrap") {
    const w = el.closest(".ep-more-wrap");
    if (!w) return;
    w.toggleAttribute("data-open");
    if (w.hasAttribute("data-open")) {
      const d = w.querySelector(".ep-more-dropdown");
      if (d) positionDropdown(d);
    }
    document.querySelectorAll(".ep-more-wrap[data-open]").forEach(ow => {
      if (ow !== w) ow.removeAttribute("data-open");
    });
    return;
  }

  // ── Dismiss import banner ────────────────────────────────
  if (action === "dismiss-import-banner") {
    el.closest(".import-banner")?.parentElement && (el.closest(".import-banner").parentElement.style.display = "none");
    return;
  }

  // ── ep-more-wrap close-only (used on download <a> links) ─
  if (action === "ep-more-close") {
    el.closest(".ep-more-wrap")?.removeAttribute("data-open");
    return; // let default href/download proceed
  }

  // ── ep-more-wrap: close then run action ───────────────────
  if (action === "ep-more-close-seq") {
    el.closest(".ep-more-wrap")?.removeAttribute("data-open");
    const seqNum = el.dataset.seq !== "" ? Number(el.dataset.seq) : null;
    showSetNumberModal(Number(el.dataset.epId), seqNum, el.dataset.locked === "true");
    return;
  }
  if (action === "ep-more-close-tags") {
    el.closest(".ep-more-wrap")?.removeAttribute("data-open");
    showEpisodeTagsModal(Number(el.dataset.epId), JSON.parse(el.dataset.tags));
    return;
  }
  if (action === "ep-more-close-hide") {
    el.closest(".ep-more-wrap")?.removeAttribute("data-open");
    hideEpisode(Number(el.dataset.epId));
    return;
  }

  // ── Episode actions (feed-detail) ────────────────────────
  if (action === "bulk-toggle") {
    e.stopPropagation();
    _bulkToggle(Number(el.dataset.epId));
    return;
  }
  if (action === "unhide-episode") {
    e.stopPropagation();
    unhideEpisode(Number(el.dataset.epId));
    return;
  }
  if (action === "upload-ep-image") {
    e.stopPropagation();
    uploadEpisodeImageClick(Number(el.dataset.epId));
    return;
  }
  if (action === "queue-episode") {
    e.stopPropagation();
    queueEpisode(Number(el.dataset.epId));
    return;
  }
  if (action === "delete-episode-file") {
    e.stopPropagation();
    deleteEpisodeFile(Number(el.dataset.epId));
    return;
  }
  if (action === "cancel-episode") {
    e.stopPropagation();
    cancelEpisode(Number(el.dataset.epId));
    return;
  }
  if (action === "toggle-ep-played") {
    e.stopPropagation();
    toggleEpPlayed(Number(el.dataset.epId));
    return;
  }
  if (action === "unlink-feed") {
    unlinkSupplementaryFeed(Number(el.dataset.podcastId), Number(el.dataset.feedId));
    return;
  }
  if (action === "dismiss-feed-error") {
    window._dismissFeedError(Number(el.dataset.feedId));
    return;
  }
  if (action === "feed-autoclean-now") {
    _runFeedAutocleanNow(Number(el.dataset.feedId));
    return;
  }

  // ── Bulk-selection actions (feed-detail) ─────────────────
  if (action === "bulk-select-all")     { _bulkSelectAll();     return; }
  if (action === "bulk-select-none")    { _bulkSelectNone();    return; }
  if (action === "bulk-select-inverse") { _bulkSelectInverse(); return; }
  if (action === "bulk-act-close-download") {
    document.getElementById("bulk-apply-wrap")?.removeAttribute("data-open");
    _bulkAct("download");
    return;
  }
  if (action === "bulk-act-close-played") {
    document.getElementById("bulk-apply-wrap")?.removeAttribute("data-open");
    _bulkActPlayed();
    return;
  }
  if (action === "bulk-act-close-hidden") {
    document.getElementById("bulk-apply-wrap")?.removeAttribute("data-open");
    _bulkActHidden();
    return;
  }
  if (action === "bulk-act-close-delete") {
    document.getElementById("bulk-apply-wrap")?.removeAttribute("data-open");
    _bulkAct("delete_file");
    return;
  }

  // ── Dashboard ─────────────────────────────────────────────
  if (action === "add-feed")        { showAddFeedModal(); return; }
  if (action === "mark-cl-played")  { window._markCLPlayed(Number(el.dataset.epId)); return; }
  if (action === "refresh-suggestions") { window._refreshSuggestions(el); return; }

  // ── Downloads ─────────────────────────────────────────────
  if (action === "dl-tab") { switchDLTab(el.dataset.tab, el); return; }
  if (action === "dl-global-unplayed") {
    el.closest(".ep-more-wrap")?.removeAttribute("data-open");
    _doGlobalUnplayed();
    return;
  }
  if (action === "dl-global-all") {
    el.closest(".ep-more-wrap")?.removeAttribute("data-open");
    _doGlobalAll();
    return;
  }
  if (action === "dl-feed") {
    el.closest(".ep-more-wrap")?.removeAttribute("data-open");
    downloadFeedFromDL(Number(el.dataset.feedId), el.dataset.mode, el);
    return;
  }
  if (action === "dl-load-more") {
    _dlLoadMore(el.dataset.tab, Number(el.dataset.offset));
    return;
  }
  if (action === "dl-clear-list")  { _clearDLList(); return; }
  if (action === "dl-queue")       { queueEpisodeDL(Number(el.dataset.epId)); return; }
  if (action === "dl-cancel")      { cancelEpisodeDL(Number(el.dataset.epId)); return; }
  if (action === "dl-dismiss")     { dismissEpisodeDL(Number(el.dataset.epId)); return; }
  if (action === "dl-delete")      { deleteEpisodeFileDL(Number(el.dataset.epId)); return; }

  // ── Settings ──────────────────────────────────────────────
  if (action === "select-theme")   { selectTheme(el.dataset.theme); return; }
  if (action === "autoclean-now")  { _runAutocleanNow(); return; }
  if (action === "sec-update-credentials") { _secUpdateCredentials(); return; }
  if (action === "sec-disable-auth")       { _secDisableAuth(); return; }
  if (action === "sec-enable-auth")        { _secEnableAuth(); return; }
  if (action === "sec-do-disable") {
    Modal.close();
    _secDoDisable();
    return;
  }
  if (action === "settings-stay") {
    Modal.close();
    window._settingsPendingNav = null;
    return;
  }
  if (action === "settings-discard") { window._settingsNavDiscard(); return; }
  if (action === "settings-save")    { window._settingsNavSave(); return; }

  // ── Stats ─────────────────────────────────────────────────
  if (action === "stats-toggle-feed") {
    toggleFeedFocus(Number(el.dataset.feedId));
    return;
  }

  // ── Setup wizard ──────────────────────────────────────────
  if (action === "wiz-select-theme") { _wizardSelectTheme(el.dataset.theme); return; }
  if (action === "wiz-load-dir") {
    _loadDirBrowser(document.getElementById("wiz-dl-path")?.value || "/");
    return;
  }
  if (action === "wiz-select-dir") {
    const p = el.dataset.path;
    const inp = document.getElementById("wiz-dl-path");
    if (inp) inp.value = p;
    if (window._setupState) window._setupState.downloadPath = p;
    _loadDirBrowser(p);
    return;
  }
});

// ============================================================
// Global input / change dispatcher
// ============================================================
// Handles oninput= and onchange= attributes replaced with data-action.
document.addEventListener("input", (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  if (action === "year-chart-slide")   { _yearChartSlide(e.target.value); return; }
  if (action === "filter-episodes")    { _filterEpisodes(); return; }
  if (action === "filter-feed-cards")  { filterFeedCards(); return; }
  if (action === "setup-dl-path") {
    if (window._setupState) window._setupState.downloadPath = e.target.value;
    return;
  }
  if (action === "ep-art-url-preview") {
    const p = document.getElementById("ep-art-modal-preview");
    if (p) { p.src = e.target.value; p.style.display = e.target.value ? "" : "none"; }
    return;
  }
});

document.addEventListener("change", (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  if (action === "autoclean-mode")      { _updateAutocleanModeHints(); return; }
  if (action === "feed-autoclean-mode") { _feedUpdateAutocleanMode(); return; }
});

// ============================================================
// Utilities
// ============================================================
// All datetimes from the API are naive UTC strings without a timezone suffix.
// _utcDate() appends "Z" so JS parses them correctly as UTC rather than local time.
function _utcDate(date) {
  if (!date) return null;
  if (date instanceof Date) return date;
  return new Date(date.includes("Z") || date.includes("+") ? date : date + "Z");
}

// fmt renders a date string.  When isApproximate is true we wrap the value in a
// dotted underline with a tooltip explaining that the date was inferred rather than
// read from metadata — this happens for files imported without ID3 date tags.
function fmt(date, isApproximate) {
  if (!date) return "—";
  const d = _utcDate(date);
  if (!d || isNaN(d)) return "—";
  const s = d.toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    timeZone: window._appTimezone || "UTC",
  });
  if (!isApproximate) return s;
  return `<span title="Approximate date — no date metadata found in this file. Set a date in the ID3 tags to resolve this." style="border-bottom:1px dashed var(--text-2);cursor:help">${s}~</span>`;
}

// fmtDateTime renders a date+time string in the configured server timezone.
function fmtDateTime(date) {
  if (!date) return "—";
  const d = _utcDate(date);
  if (!d || isNaN(d)) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: window._appTimezone || "UTC",
  });
}

function fmtBytes(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function timeAgo(date) {
  if (!date) return "never";
  const d = _utcDate(date);
  if (!d || isNaN(d)) return "never";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function statusBadge(status) {
  const map = {
    pending: ["badge-default", "Not Downloaded"],
    queued: ["badge-warning", "Queued"],
    downloading: ["badge-primary", "Downloading"],
    downloaded: ["badge-success", "Downloaded"],
    failed: ["badge-error", "Failed"],
    skipped: ["badge-default", "Skipped"],
  };
  const [cls, label] = map[status] || ["badge-default", status];
  return `<span class="badge status-badge ${cls}">${label}</span>`;
}

function svg(path, extra = "") {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ${extra}>${path}</svg>`;
}

const _PODCAST_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40%" height="40%" opacity="0.5"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`;

function artImg(url, fallbackEmoji = "", size = "", paused = false) {
  const placeholder = fallbackEmoji
    ? `<div class="feed-card-art-placeholder">${fallbackEmoji}</div>`
    : `<div class="feed-card-art-placeholder">${_PODCAST_SVG}</div>`;
  const inner = url
    ? `<img src="${url}" alt="" loading="lazy" />
       <div class="feed-card-art-placeholder" style="display:none">${fallbackEmoji || _PODCAST_SVG}</div>`
    : placeholder;
  const pauseOverlay = paused
    ? `<div class="art-paused-overlay">
         <svg viewBox="0 0 24 24" fill="currentColor" width="40%" height="40%">
           <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
         </svg>
       </div>`
    : "";
  const style = size
    ? `style="width:${size};height:${size};position:relative"`
    : `style="width:100%;height:100%;position:relative"`;
  return `<div ${style}>${inner}${pauseOverlay}</div>`;
}

/**
 * Render a standardised episode play/pause/resume button.
 * Handles all three states: currently playing (pause icon), resumable (|▶ icon), play from start (▶ icon).
 * Uses `ep-play-btn` + `data-ep-id` so Player._syncPlayBtns() keeps it live.
 */
function epPlayBtn(ep, { extraClasses = "" } = {}) {
  const playing   = Player.currentId() === ep.id && Player.isPlaying();
  const resumable = !ep.played && (ep.play_position_seconds > 0);
  const icon = playing   ? svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>')
             : resumable ? svg(Player.resumeIcon())
             :             svg(Player.playIcon());
  const title = playing ? "Pause" : resumable ? "Resume" : "Play";
  return `<button class="btn btn-ghost btn-sm btn-icon ep-play-btn${extraClasses ? " " + extraClasses : ""}"
          data-action="play-episode" data-ep-id="${ep.id}"${resumable ? ' data-resume="1"' : ''}
          ${resumable ? 'data-resumable="1"' : ''}
          title="${title}">${icon}</button>`;
}

function toggle(label, name, checked, hint = "") {
  return `<div class="form-group">
    <div class="flex items-center gap-2">
      <label class="toggle">
        <input type="checkbox" name="${name}" ${checked ? "checked" : ""} />
        <span class="toggle-slider"></span>
      </label>
      <span class="form-check-label">${label}</span>
    </div>
    ${hint ? `<div class="form-hint">${hint}</div>` : ""}
  </div>`;
}

function collectForm(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") {
      data[el.name] = el.checked;
    } else if (el.value !== "") {
      const num = el.dataset.numeric;
      data[el.name] = num ? Number(el.value) : el.value;
    }
  }
  return data;
}

window.togglePanel = function (id) {
  document.getElementById(id).classList.toggle("open");
};

// ============================================================
// Dropdown viewport boundary detection
// ============================================================
// Reposition a dropdown element so it stays within the viewport.
// Resets left/right first to measure the natural position, then
// flips if the dropdown would be clipped at the right or left edge.
function positionDropdown(el) {
  el.style.right = "";
  el.style.left = "";
  const rect = el.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) {
    el.style.right = "0";
    el.style.left = "auto";
  } else if (rect.left < 8) {
    el.style.left = "0";
    el.style.right = "auto";
  }
}

// ============================================================
// Animated removal
// ============================================================
/**
 * Smoothly remove an element: fade out, then collapse its height, then remove
 * from the DOM.  Safe to call on already-removing or already-removed elements.
 * onDone() is called after the element is removed.
 */
function animateRemove(el, onDone) {
  if (!el || el._removing) return;
  el._removing = true;
  el.style.pointerEvents = "none";

  // Read height now so the browser commits the layout before we start animating.
  const h = el.offsetHeight;
  el.style.overflow = "hidden";
  el.style.height = h + "px";

  // Second offsetHeight read forces the browser to commit height: Xpx before
  // we set it to 0, ensuring the CSS transition actually fires.
  void el.offsetHeight;

  el.style.transition =
    "opacity 0.15s ease, " +
    "height 0.22s ease 0.1s, " +
    "margin-top 0.22s ease 0.1s, " +
    "margin-bottom 0.22s ease 0.1s, " +
    "padding-top 0.22s ease 0.1s, " +
    "padding-bottom 0.22s ease 0.1s";
  el.style.opacity = "0";
  el.style.height = "0";
  el.style.marginTop = "0";
  el.style.marginBottom = "0";
  el.style.paddingTop = "0";
  el.style.paddingBottom = "0";

  // 0.1 (delay) + 0.22 (duration) = 0.32 s → wait a touch longer to be safe
  setTimeout(() => {
    el.remove();
    if (onDone) onDone();
  }, 340);
}

// animateEnter is the exact reverse of animateRemove: the element starts
// fully collapsed (height 0, opacity 0) and expands to its natural height
// while fading in.  We read scrollHeight before collapsing so the transition
// knows its target, then force a reflow to commit the start state.
function animateEnter(el) {
  if (!el) return;
  const h = el.scrollHeight;
  el.style.overflow = "hidden";
  el.style.height = "0";
  el.style.opacity = "0";
  void el.offsetHeight; // commit collapsed state before transition starts
  el.style.transition =
    "opacity 0.15s ease 0.1s, " +
    "height 0.22s ease";
  el.style.height = h + "px";
  el.style.opacity = "1";
  setTimeout(() => {
    el.style.transition = "";
    el.style.height = "";
    el.style.overflow = "";
  }, 340);
}

// ── Shared escape helpers ───────────────────────────────────────────────────

function escHTML(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escJS(s) {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ── Shared "Sync All Feeds" button wiring ───────────────────────────────────

// ── Timezone combobox ─────────────────────────────────────────────────────────
// initTzCombo(inputEl, dropdownEl, allZones, initialValue, onChange)
// Wires a text input + dropdown div into a searchable timezone picker.
function initTzCombo(inputEl, dropdownEl, allZones, initialValue, onChange) {
  let current = initialValue;
  inputEl.value = current;

  const renderList = (zones) => {
    dropdownEl.innerHTML = zones.map(z =>
      `<div class="tz-option${z === current ? " tz-highlighted" : ""}" data-tz="${escHTML(z)}">${escHTML(z)}</div>`
    ).join("") || `<div class="tz-option" style="color:var(--text-3);cursor:default">No matches</div>`;
    dropdownEl.querySelector(".tz-highlighted")?.scrollIntoView({ block: "nearest" });
  };

  const openWith = (query) => {
    const q = query.toLowerCase();
    const filtered = q ? allZones.filter(z => z.toLowerCase().includes(q)) : allZones;
    renderList(filtered);
    dropdownEl.classList.add("open");
  };

  const commit = (value) => {
    if (!allZones.includes(value)) return;
    current = value;
    inputEl.value = value;
    dropdownEl.classList.remove("open");
    onChange(value);
  };

  inputEl.addEventListener("focus",  () => openWith(inputEl.value === current ? "" : inputEl.value));
  inputEl.addEventListener("input",  () => openWith(inputEl.value));
  inputEl.addEventListener("blur",   () => setTimeout(() => {
    dropdownEl.classList.remove("open");
    inputEl.value = current; // restore if user typed something invalid
  }, 160));

  dropdownEl.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".tz-option[data-tz]");
    if (opt) commit(opt.dataset.tz);
  });

  inputEl.addEventListener("keydown", (e) => {
    const isOpen = dropdownEl.classList.contains("open");
    if (!isOpen && (e.key === "ArrowDown" || e.key === "Enter")) {
      openWith(""); return;
    }
    if (!isOpen) return;
    const opts = [...dropdownEl.querySelectorAll(".tz-option[data-tz]")];
    const hi = dropdownEl.querySelector(".tz-highlighted");
    const idx = hi ? opts.indexOf(hi) : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      opts.forEach(o => o.classList.remove("tz-highlighted"));
      (opts[idx + 1] ?? opts[0])?.classList.add("tz-highlighted");
      dropdownEl.querySelector(".tz-highlighted")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      opts.forEach(o => o.classList.remove("tz-highlighted"));
      (opts[idx - 1] ?? opts[opts.length - 1])?.classList.add("tz-highlighted");
      dropdownEl.querySelector(".tz-highlighted")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const active = dropdownEl.querySelector(".tz-highlighted[data-tz]");
      if (active) commit(active.dataset.tz);
    } else if (e.key === "Escape") {
      dropdownEl.classList.remove("open");
      inputEl.value = current;
    }
  });
}

function wireSyncAllBtn(selector) {
  document.querySelector(selector)?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Syncing\u2026";
    try {
      await API.syncAllFeeds();
      document.querySelectorAll("#feeds-grid .badge-error").forEach(el => el.remove());
      updateStatus();
      Toast.success("Sync started for all active feeds");
    } catch (err) {
      Toast.error(err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>')} Sync All Feeds`;
    }
  });
}

// ============================================================
// Directory browser component (reusable folder picker)
// ============================================================
const DirBrowser = {
  async load(containerId, inputId, path) {
    const el = document.getElementById(containerId);
    const input = document.getElementById(inputId);
    if (!el) return;
    el.innerHTML = `<div style="padding:8px 12px;color:var(--text-3);font-size:12px">Loading\u2026</div>`;
    try {
      const data = await API.browseDirs(path || "/");
      if (input) input.value = data.path;
      const rows = [];
      if (data.parent !== null) {
        rows.push(`<div class="dir-entry dir-up" data-path="${data.parent}">
          <span class="dir-icon">\u2191</span><span>..</span></div>`);
      }
      for (const entry of data.entries) {
        rows.push(`<div class="dir-entry" data-path="${entry.path}">
          <span class="dir-icon">\uD83D\uDCC1</span><span>${escHTML(entry.name)}</span></div>`);
      }
      if (!data.entries.length && data.parent === null) {
        rows.push(`<div style="padding:8px 12px;color:var(--text-3);font-size:12px">No subdirectories</div>`);
      }
      el.innerHTML = `<div class="dir-browser-path">${escHTML(data.path)}</div>${rows.join("")}`;
      el.querySelectorAll(".dir-entry[data-path]").forEach(div => {
        div.addEventListener("click", () => DirBrowser.load(containerId, inputId, div.dataset.path));
      });
    } catch (err) {
      el.innerHTML = `<div style="padding:8px 12px;color:var(--error);font-size:12px">${escHTML(err.message)}</div>`;
    }
  }
};
