"use strict";

// Close any open episode "..." dropdown when clicking elsewhere (one-time global)
document.addEventListener("click", () => {
  document.querySelectorAll(".ep-more-wrap[data-open]").forEach(el => el.removeAttribute("data-open"));
});

// Parse an itunes:duration string to integer seconds (mirrors backend logic)
function _parseDurSecs(dur) {
  if (!dur) return 0;
  const s = dur.trim();
  if (/^[\d.]+$/.test(s)) return Math.round(parseFloat(s)) || 0;
  const parts = s.split(":");
  try {
    if (parts.length === 3) return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + Math.round(parseFloat(parts[2]));
    if (parts.length === 2) return parseInt(parts[0]) * 60 + Math.round(parseFloat(parts[1]));
  } catch (_) {}
  return 0;
}

// ============================================================
// Global playback helpers (used by dashboard, feed-detail, etc.)
// ============================================================
window.playEpisode = async function (epId) {
  if (Player.currentId() === epId) {
    Player.togglePause();
    return;
  }
  try {
    let ep = await API.getEpisode(epId);
    // If the episode was already fully played, restart from the beginning
    if (ep.played) {
      const [reset] = await Promise.all([
        API.updateProgress(epId, 0),
        API.togglePlayed(epId),   // sets played → false
      ]);
      ep = await API.getEpisode(epId);
      if (typeof updateEpisodeRow === "function") updateEpisodeRow(ep);
    }
    Player.play({
      id: ep.id,
      title: ep.title || "Untitled",
      feedTitle: ep.feed_title || window._epState?.feed?.title || "",
      feedId: ep.feed_id,
      resumeAt: ep.play_position_seconds || 0,
    });
  } catch (e) { Toast.error(e.message); }
};

window.toggleEpPlayed = async function (epId) {
  try {
    const ep = await API.togglePlayed(epId);
    if (!ep.played) { await API.updateProgress(epId, 0); ep.play_position_seconds = 0; }
    if (typeof updateEpisodeRow === "function") updateEpisodeRow(ep);
    Toast.info(ep.played ? "Marked as played" : "Marked as unplayed");
    updateStatus();
  } catch (e) { Toast.error(e.message); }
};

// Called by the player when an episode ends — play the next downloaded, unplayed episode
window._autoPlayNext = function (currentEpId) {
  const rows = [...document.querySelectorAll("#episode-list .episode-item")];
  const currentIdx = rows.findIndex((r) => r.id === `ep-${currentEpId}`);
  if (currentIdx === -1) return;
  for (let i = currentIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.dataset.status === "downloaded" && !r.dataset.played) {
      const nextId = Number(r.id.replace("ep-", ""));
      if (nextId) window.playEpisode(nextId);
      return;
    }
  }
};

// ============================================================
// Feed detail view
// ============================================================
// Refresh just the episode list without touching the rest of the page
async function _refreshEpisodeList() {
  const { id, feed, batch, order } = window._epState || {};
  if (!id) return;
  const eps = await API.getFeedEpisodesWithHidden(id, batch, 0, order || "desc");
  window._epState.offset = eps.length;
  const list = document.getElementById("episode-list");
  if (list) list.innerHTML = eps.map((ep) => episodeRow(ep, feed)).join("");
  Player.syncPlayBtns();
}

// Refresh just the feed header stats + last-checked text
async function _refreshFeedStats() {
  const { id } = window._epState || {};
  if (!id) return;
  const updated = await API.getFeed(id);
  window._epState.feed = updated;
  const statsEl = document.querySelector(".feed-header-stats");
  if (statsEl) statsEl.innerHTML = `
    <span class="feed-stat">${updated.episode_count} episode${updated.episode_count !== 1 ? "s" : ""}</span>
    <span class="feed-stat-sep">·</span>
    <span class="feed-stat">${updated.downloaded_count} downloaded</span>
    ${updated.available_count > 0 ? `<span class="feed-stat-sep">·</span><span class="feed-stat">${updated.available_count} not downloaded</span>` : ""}
    ${updated.unplayed_count > 0 ? `<span class="feed-stat-sep">·</span><span class="feed-stat">${updated.unplayed_count} unplayed</span>` : ""}
  `;
  const lastChecked = document.querySelector(".feed-last-checked");
  if (lastChecked) {
    lastChecked.textContent = updated.last_checked
      ? `Last checked ${fmtDateTime(updated.last_checked)}`
      : "Never checked";
  }
  _renderFeedErrorBanner(updated);
  window._feedDetailDL?.refresh();
  return updated;
}

function _renderFeedErrorBanner(feed) {
  const banner = document.getElementById("feed-error-banner");
  if (!banner) return;
  if (feed.last_error) {
    banner.style.display = "";
    banner.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:10px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             style="width:16px;height:16px;flex-shrink:0;margin-top:1px;color:var(--error)">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span style="flex:1;font-size:13px;color:var(--error);word-break:break-word">${escHTML(feed.last_error)}</span>
        <button class="btn btn-ghost btn-sm" onclick="window._dismissFeedError(${feed.id})"
                style="flex-shrink:0;font-size:12px;padding:2px 8px">Dismiss</button>
      </div>`;
  } else {
    banner.style.display = "none";
    banner.innerHTML = "";
  }
}

// _pollImportBanner checks the import status for a feed and shows the progress banner
// if an import is running or recently finished.  It polls until the job settles, then
// does a surgical episode+stats refresh so the new episodes appear without a full reload.
// Extracted as a standalone function so it can be called both on page load and immediately
// after the user starts a new import from the Import Files modal.
async function _pollImportBanner(feedId) {
  const banner = document.getElementById("import-banner");
  if (!banner) return;

  function _renderBanner(s) {
    if (!s) { banner.style.display = "none"; return; }
    const isRunning = s.status === "running";
    const pct = s.total > 0 ? Math.round((s.processed / s.total) * 100) : 0;
    banner.style.display = "";
    banner.innerHTML = `
      <div class="import-banner ${isRunning ? "import-banner-running" : s.status === "error" ? "import-banner-error" : "import-banner-done"}">
        <div class="import-banner-msg">
          ${isRunning
            ? `${svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>', 'width="14" height="14" class="spin"')} Importing files… ${s.processed}/${s.total}`
            : s.status === "error"
            ? `${svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>', 'width="14" height="14"')} ${s.message}`
            : `${svg('<polyline points="20 6 9 17 4 12"/>', 'width="14" height="14"')} ${s.message}`}
        </div>
        ${isRunning ? `<div class="import-banner-bar"><div class="import-banner-fill" style="width:${pct}%"></div></div>` : ""}
        ${!isRunning ? `<button class="import-banner-close" onclick="this.closest('.import-banner').parentElement.style.display='none'">×</button>` : ""}
      </div>`;
  }

  try {
    const s = await API.getImportStatus(feedId);
    _renderBanner(s);
    if (s.status === "running") {
      const pollId = setInterval(async () => {
        try {
          const s2 = await API.getImportStatus(feedId);
          _renderBanner(s2);
          if (s2.status !== "running") {
            clearInterval(pollId);
            if (s2.status === "done" && (s2.matched + s2.created) > 0) {
              await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]);
            }
          }
        } catch (_) { clearInterval(pollId); }
      }, 1500);
    }
  } catch (_) {
    // 404 means no import job yet — that's expected on a fresh page load
  }
}

// _syncHiddenBadge applies a count delta (+1 on hide, -1 on unhide) to the
// "N hidden" badge.  Hidden episodes are always loaded and visible in the list
// (grayed out); this badge is purely informational.
function _syncHiddenBadge(delta) {
  const state = window._epState;
  if (!state?.feed) return;
  state.feed.hidden_count = (state.feed.hidden_count || 0) + delta;
  const n = state.feed.hidden_count;

  let badge = document.getElementById("hidden-count-badge");
  if (n > 0) {
    if (badge) {
      badge.textContent = `${n} hidden`;
    } else {
      document.querySelector("#episodes-panel .panel-header-title")
        ?.insertAdjacentHTML("beforeend",
          `<span class="badge badge-default" id="hidden-count-badge" style="opacity:0.6">${n} hidden</span>`);
    }
  } else {
    badge?.remove();
  }
}

// _syncDownloadButtons adjusts the "Download Unplayed (N)" and "Download All (N)"
// button labels when an episode is hidden or unhidden.
// delta: +1 when hiding (episode leaves the available pool), -1 when unhiding.
// Build the download button HTML for a given feed state (used on initial render and after poll).
function _buildDlBtnHtml(feed, queueCount = 0) {
  const dlIcon = svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>');
  const caretToggle = `const w=this.closest('.ep-more-wrap');w.toggleAttribute('data-open');if(w.hasAttribute('data-open')){const d=w.querySelector('.ep-more-dropdown');if(d)positionDropdown(d);}document.querySelectorAll('.ep-more-wrap[data-open]').forEach(el=>el!==w&&el.removeAttribute('data-open'))`;
  const caret = svg('<polyline points="6 9 12 15 18 9"/>');

  // Build the download button(s).
  const hasAvailable = feed?.available_count > 0;
  const hasUnplayed  = feed?.unplayed_available_count > 0;
  const activeDownloads = queueCount > 0;

  let btnHtml = "";
  if (hasUnplayed) {
    // Active split button: "Download Unplayed" primary + "Download All" in dropdown
    btnHtml = `<div class="ep-more-wrap" onclick="event.stopPropagation()">
      <button class="btn btn-primary btn-sm btn-split-main" id="btn-dl-unplayed-feed">
        ${dlIcon} Download Unplayed (${feed.unplayed_available_count})
      </button>
      <button class="btn btn-primary btn-sm btn-split-caret" onclick="${caretToggle}">${caret}</button>
      <div class="ep-more-dropdown" style="right:0;left:auto;min-width:190px">
        <button id="btn-dl-unplayed-feed-dd">Download Unplayed (${feed.unplayed_available_count})</button>
        <button id="btn-dl-all-feed">Download All (${feed.available_count})</button>
      </div>
    </div>`;
  } else if (hasAvailable) {
    if (activeDownloads) {
      // Unplayed all queued; played episodes still pending — disabled unplayed + active download-all
      btnHtml = `<div class="ep-more-wrap" onclick="event.stopPropagation()">
        <button class="btn btn-primary btn-sm btn-split-main" id="btn-dl-unplayed-feed" disabled
                title="All unplayed episodes are queued or downloaded">
          ${dlIcon} Download Unplayed
        </button>
        <button class="btn btn-primary btn-sm btn-split-caret" onclick="${caretToggle}">${caret}</button>
        <div class="ep-more-dropdown" style="right:0;left:auto;min-width:190px">
          <button id="btn-dl-unplayed-feed-dd" disabled>Download Unplayed</button>
          <button id="btn-dl-all-feed">Download All (${feed.available_count})</button>
        </div>
      </div>`;
    } else {
      // No unplayed pending, no active downloads — just "Download All"
      btnHtml = `<button class="btn btn-primary btn-sm" id="btn-dl-all-feed">
        ${dlIcon} Download All (${feed.available_count})
      </button>`;
    }
  } else if (activeDownloads) {
    // Everything queued or downloading — show disabled buttons
    btnHtml = `<div class="ep-more-wrap" onclick="event.stopPropagation()">
      <button class="btn btn-primary btn-sm btn-split-main" id="btn-dl-unplayed-feed" disabled
              title="All unplayed episodes are queued or downloaded">
        ${dlIcon} Download Unplayed
      </button>
      <button class="btn btn-primary btn-sm btn-split-caret" disabled>${caret}</button>
      <div class="ep-more-dropdown" style="right:0;left:auto;min-width:190px">
        <button id="btn-dl-unplayed-feed-dd" disabled>Download Unplayed</button>
        <button id="btn-dl-all-feed" disabled>Download All</button>
      </div>
    </div>`;
  }

  // When downloads are in progress, append a compact indicator + cancel — but keep
  // the download button active so the user can queue more without waiting.
  if (queueCount > 0) {
    const progressHtml = `<span style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-3);white-space:nowrap">
      <span id="dl-progress-count">${queueCount} downloading</span>
      <button class="btn btn-ghost btn-sm" id="btn-dl-cancel-feed"
              style="color:var(--error);padding:2px 6px;font-size:12px"
              title="Cancel all queued downloads for this podcast">Cancel</button>
    </span>`;
    return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${btnHtml}${progressHtml}</div>`;
  }

  return btnHtml;
}

function _syncDownloadButtons(ep, delta) {
  const state = window._epState;
  if (!state?.feed) return;
  // Only pending/failed episodes with a download URL affect the downloadable pool.
  // delta = +1 when hiding (episode leaves pool), -1 when unhiding (joins pool).
  if ((ep.status !== "pending" && ep.status !== "failed") || !ep.enclosure_url) return;

  state.feed.available_count = Math.max(0, (state.feed.available_count || 0) - delta);
  if (!ep.played && !(ep.play_position_seconds > 0)) {
    state.feed.unplayed_available_count = Math.max(0, (state.feed.unplayed_available_count || 0) - delta);
  }
  window._feedDetailDL?.refresh();
}

// _wireFileUpdatesBtn injects (if absent) and wires the "Apply File Updates" button.
// We call it both during initial page render (where the button may already be in the
// template) and from the episode-tags modal (where saving tags may trigger the need
// for this button mid-session without a full page reload).
function _wireFileUpdatesBtn(feedId) {
  if (!document.getElementById("btn-update-filenames")) {
    const anchor = document.getElementById("btn-toggle-active");
    if (!anchor) return;
    anchor.insertAdjacentHTML("afterend",
      `<button class="btn btn-ghost btn-sm" id="btn-update-filenames">
         ${svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>')}
         Apply File Updates
       </button>`);
  }
  const btn = document.getElementById("btn-update-filenames");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Applying…";
    try {
      const r = await API.applyFileUpdates(feedId);
      const parts = [];
      if (r.renamed > 0) parts.push(`${r.renamed} file${r.renamed !== 1 ? "s" : ""} renamed`);
      if (r.tagged > 0)  parts.push(`${r.tagged} file${r.tagged !== 1 ? "s" : ""} tagged`);
      const msg = parts.length ? parts.join(", ") : "No changes needed";
      Toast.success(msg + (r.errors.length ? ` (${r.errors.length} error${r.errors.length !== 1 ? "s" : ""})` : ""));
      btn.remove();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Apply File Updates";
      Toast.error(e.message);
    }
  });
}

async function viewFeedDetail(feedId) {
  // Cancel any in-flight polls from a previous view
  if (window._syncPollTimer) {
    clearInterval(window._syncPollTimer);
    window._syncPollTimer = null;
  }
  if (window._feedDLPollTimer) {
    clearInterval(window._feedDLPollTimer);
    window._feedDLPollTimer = null;
  }
  // Clear the per-episode download coordinator so stale callbacks from a previous
  // feed page can't accidentally trigger poll/restore on this one.
  window._feedDetailDL = null;

  const id = Number(feedId);

  // Block navigation to a feed that is currently being deleted
  if (window._deletingFeedIds?.has(id)) {
    Router.navigate("/feeds");
    return;
  }
  const [feed, id3Tags, rssSources, settings, supplementary, initialQueueCount] = await Promise.all([
    API.getFeed(id),
    API.getID3Tags(),
    API.getFeedRSSSources(id),
    API.getSettings(),
    API.getSupplementary(id),
    API.get(`/api/feeds/${id}/queue-count`).then(r => r.count).catch(() => 0),
  ]);
  const EP_BATCH = settings.episode_page_size || 10000;
  const episodes = await API.getFeedEpisodesWithHidden(id, EP_BATCH, 0);
  window._epState = { id, feed, offset: episodes.length, batch: EP_BATCH, statusFilter: "all" };

  // Store ID3 tag definitions globally so the tags modal can use them
  window._id3TagDefs = id3Tags;

  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page">
      <a class="back-btn" href="#/feeds">
        ${svg('<polyline points="15 18 9 12 15 6"/>')} Back to Feeds
      </a>

      <!-- Feed header -->
      <div class="feed-header">
        <div class="feed-header-art">${artImg(feed.custom_image_url || feed.image_url, "", "", !feed.active)}</div>
        <div class="feed-header-info">
          <div class="feed-header-title">${feed.title || feed.url}</div>
          <div class="feed-header-author">${feed.author || ""}</div>
          <div class="feed-last-checked">
            ${feed.last_checked
              ? `Last checked ${fmtDateTime(feed.last_checked)}`
              : "Never checked"}
          </div>
          <div class="feed-header-stats">
            <span class="feed-stat">${feed.episode_count} episode${feed.episode_count !== 1 ? "s" : ""}</span>
            <span class="feed-stat-sep">·</span>
            <span class="feed-stat">${feed.downloaded_count} downloaded</span>
            ${feed.available_count > 0 ? `<span class="feed-stat-sep">·</span><span class="feed-stat">${feed.available_count} not downloaded</span>` : ""}
            ${feed.unplayed_count > 0 ? `<span class="feed-stat-sep">·</span><span class="feed-stat">${feed.unplayed_count} unplayed</span>` : ""}
          </div>
          <div id="feed-error-banner" style="${feed.last_error ? "" : "display:none"};margin-top:8px;padding:8px 10px;background:var(--error-bg, color-mix(in srgb, var(--error) 12%, transparent));border:1px solid color-mix(in srgb, var(--error) 30%, transparent);border-radius:6px">
            ${feed.last_error ? `
            <div style="display:flex;align-items:flex-start;gap:10px">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                   style="width:16px;height:16px;flex-shrink:0;margin-top:1px;color:var(--error)">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span style="flex:1;font-size:13px;color:var(--error);word-break:break-word">${escHTML(feed.last_error)}</span>
              <button class="btn btn-ghost btn-sm" onclick="window._dismissFeedError(${feed.id})"
                      style="flex-shrink:0;font-size:12px;padding:2px 8px">Dismiss</button>
            </div>` : ""}
          </div>
          ${feed.description ? `<div class="feed-header-desc">${feed.description}</div>` : ""}
          <div class="feed-header-actions">
            <button class="btn btn-primary btn-sm" id="btn-sync-feed">
              ${svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>')}
              Sync Feed
            </button>
            <button class="btn btn-ghost btn-sm" id="btn-toggle-active">
              ${feed.active ? "Pause Feed" : "Resume Feed"}
            </button>
            ${feed.needs_rename ? `<button class="btn btn-ghost btn-sm" id="btn-update-filenames">
              ${svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>')}
              Apply File Updates
            </button>` : ""}
            <div class="ep-more-wrap" id="import-menu-wrap">
              <button class="btn btn-ghost btn-sm" id="btn-import-menu">
                ${svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>')}
                Import / Archive
                ${svg('<polyline points="6 9 12 15 18 9"/>', 'width="12" height="12"')}
              </button>
              <div class="ep-more-dropdown" style="left:0;right:auto;min-width:200px">
                <button id="btn-upload-feed-xml">
                  ${svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="12 18 12 12"/><polyline points="9 15 12 12 15 15"/>',  'width="14" height="14"')}
                  Upload Feed XML…
                </button>
                <button id="btn-import-files">
                  ${svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',  'width="14" height="14"')}
                  Import from Path…
                </button>
                <button id="btn-download-clean-rss">
                  ${svg('<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',  'width="14" height="14"')}
                  Export Complete RSS Feed Archive
                </button>
              </div>
            </div>
            <button class="btn btn-danger btn-sm" id="btn-delete-feed">Delete Feed</button>
          </div>
        </div>
      </div>

      <!-- Import banner (shown when an import is running or just finished) -->
      <div id="import-banner" style="display:none"></div>

      <!-- Settings panel -->
      <div class="panel" id="settings-panel">
        <div class="panel-header" onclick="togglePanel('settings-panel')">
          <div class="panel-header-title">
            ${svg('<circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/>', 'width="16" height="16"')}
            Feed Settings
          </div>
          <svg class="panel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
        <div class="panel-body">
          <form id="feed-settings-form">
            <div class="form-group">
              <label class="form-label">Feed URL</label>
              <input class="form-control" name="url" type="url"
                     value="${feed.url}" />
              <div class="form-hint">Changing this will not affect existing episodes — future syncs will use the new URL.</div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Download Path Override</label>
                <input class="form-control" name="download_path"
                       value="${feed.download_path || ""}"
                       placeholder="Leave blank to use global default" />
                <div class="form-hint">Absolute path inside the container, e.g. /downloads/tech</div>
              </div>
              <div class="form-group">
                <label class="form-label">Check Interval (minutes)</label>
                <input class="form-control" name="check_interval" type="number" min="1"
                       value="${feed.check_interval || ""}" data-numeric="1"
                       placeholder="Global default (${settings.check_interval} min)" />
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Custom Cover Art</label>
              <div style="display:flex;gap:10px;align-items:center">
                ${feed.image_url
                  ? `<img id="feed-art-preview" src="${feed.image_url}"
                          style="width:56px;height:56px;border-radius:8px;object-fit:cover;flex-shrink:0"
                          onerror="this.style.display='none'" />`
                  : `<div id="feed-art-preview" style="width:56px;height:56px;border-radius:8px;background:var(--bg-3);flex-shrink:0;display:flex;align-items:center;justify-content:center">${_PODCAST_SVG}</div>`}
                <div style="display:flex;flex-direction:column;gap:6px">
                  <input type="file" id="feed-cover-file" accept="image/*" style="display:none" />
                  <button type="button" class="btn btn-ghost btn-sm" id="btn-choose-cover">
                    ${svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>')}
                    ${feed.has_custom_cover ? "Replace image…" : "Choose image…"}
                  </button>
                  ${feed.has_custom_cover
                    ? `<button type="button" class="btn btn-ghost btn-sm" id="btn-remove-cover" style="color:var(--error)">Remove custom art</button>`
                    : ""}
                </div>
              </div>
              <div class="form-hint" id="feed-cover-hint">
                ${feed.has_custom_cover ? "Using custom cover art." : "Upload an image to override the RSS-provided artwork."}
              </div>
            </div>

            ${toggle("Auto-download new episodes", "auto_download_new",
              feed.auto_download_new !== null ? feed.auto_download_new : settings.auto_download_new,
              "Automatically queue new episodes when first detected. Overrides global setting.")}

            <div class="form-group">
              <label class="form-label">Auto-cleanup</label>
              ${settings.autoclean_enabled ? `
                ${toggle("Exclude from auto-cleanup", "autoclean_exclude",
                  feed.autoclean_exclude ?? false,
                  "When excluded, this feed is skipped by the global scheduled cleanup.")}
                <div class="form-hint" style="margin-top:4px">
                  Global cleanup is enabled. Configure options in
                  <a href="#/settings" style="color:var(--primary)">Settings → Storage</a>.
                </div>
              ` : `
                ${toggle("Enable auto-cleanup for this feed", "autoclean_enabled",
                  feed.autoclean_enabled ?? false,
                  "Automatically delete episode files on a schedule. Only active when global auto-cleanup is off.")}
                <div id="feed-autoclean-cfg" style="${feed.autoclean_enabled ? "" : "display:none"};margin-left:40px">
                  <div class="form-hint" style="color:var(--warning);margin-bottom:6px">⚠ This permanently deletes audio files from disk.</div>
                  <div class="form-group" style="margin-bottom:10px">
                    <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
                      <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;color:var(--text-2)">
                        <input type="radio" name="autoclean_mode" value="unplayed"
                               ${(feed.autoclean_mode || "unplayed") === "unplayed" ? "checked" : ""}
                               style="margin-top:3px;flex-shrink:0"
                               onchange="_feedUpdateAutocleanMode()" />
                        <span>
                          <strong style="color:var(--text)">Keep unplayed episodes</strong><br>
                          <span style="font-size:11px;color:var(--text-3)">Deletes any episode you've fully played. Partially listened episodes are never deleted.</span>
                        </span>
                      </label>
                      <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;color:var(--text-2)">
                        <input type="radio" name="autoclean_mode" value="recent"
                               ${(feed.autoclean_mode || "unplayed") === "recent" ? "checked" : ""}
                               style="margin-top:3px;flex-shrink:0"
                               onchange="_feedUpdateAutocleanMode()" />
                        <span>
                          <strong style="color:var(--text)">Keep N most recent episodes</strong><br>
                          <span style="font-size:11px;color:var(--text-3)">Deletes the oldest downloads once the count exceeds N. Unplayed episodes are never deleted.</span>
                        </span>
                      </label>
                    </div>
                  </div>
                  <div id="feed-autoclean-count-row" style="${(feed.autoclean_mode || "unplayed") === "unplayed" ? "display:none" : ""}">
                    <div class="form-group" style="margin-bottom:10px">
                      <label class="form-label">Keep count (N)</label>
                      <input class="form-control" name="keep_latest" type="number"
                             min="1" value="${feed.keep_latest ?? 10}" data-numeric="1"
                             style="max-width:120px" />
                    </div>
                  </div>
                  <div style="margin-bottom:4px">
                    <button type="button" class="btn btn-ghost btn-sm" id="btn-run-feed-autoclean"
                            onclick="_runFeedAutocleanNow(${feed.id})">
                      ${svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>')}
                      Run cleanup now
                    </button>
                  </div>
                </div>
              `}
            </div>

            <div class="divider"></div>

            ${toggle("Date prefix in filename (YYYY-MM-DD)", "filename_date_prefix",
              feed.filename_date_prefix !== null ? feed.filename_date_prefix : settings.filename_date_prefix,
              "Prepends the episode publication date to the filename.")}

            ${toggle("Episode number prefix in filename", "filename_episode_number",
              feed.filename_episode_number !== null ? feed.filename_episode_number : settings.filename_episode_number,
              "Prepends the sequential episode number to the filename (e.g. 042 - Title.mp3). Number is based on oldest→newest across all feeds in this podcast. Will appear after the date prefix if that option is enabled.")}

            <div class="form-group">
              <label class="form-label">Start episode numbering at</label>
              <input class="form-control" name="episode_number_start" type="number" min="1"
                     value="${feed.episode_number_start ?? 1}" data-numeric="1"
                     style="max-width:120px" />
              <div class="form-hint">The oldest episode gets this number; later episodes increment by 1. To anchor numbering mid-feed, use the ··· menu on any episode row.</div>
              <button type="button" class="btn btn-ghost btn-sm" id="btn-renumber-all" style="margin-top:6px">
                Renumber all episodes…
              </button>
            </div>

            ${toggle("Organize into year subfolders", "organize_by_year",
              feed.organize_by_year !== null ? feed.organize_by_year : settings.organize_by_year,
              "Creates a subfolder per release year inside the feed folder.")}

            ${toggle("Save XML metadata sidecar", "save_xml",
              feed.save_xml !== null ? feed.save_xml : settings.save_xml,
              "Saves a .xml file next to each audio file with full RSS metadata.")}

            <!-- ID3 section -->
            <div class="divider"></div>
            ${toggle("Write ID3 tags to audio files", "id3_enabled", feed.id3_enabled,
              "Writes metadata from the RSS feed into the audio file's ID3/MP4 tags.")}

            <div id="id3-section" style="${feed.id3_enabled ? "" : "display:none"}">
              <div class="section-title" style="margin-top:14px">Tag Mapping</div>
              <div class="form-hint" style="margin-bottom:10px">
                Choose which RSS field to write into each ID3 tag. Leave a row blank to skip that tag.
              </div>
              <div style="overflow-x:auto">
                <table class="id3-table">
                  <thead>
                    <tr>
                      <th>ID3 Tag</th>
                      <th>Source Field</th>
                    </tr>
                  </thead>
                  <tbody id="id3-mapping-rows">
                    ${id3Tags.map((tag) => {
                      const currentMapping = feed.id3_field_mapping || settings.default_id3_mapping || {};
                      const selected = currentMapping[tag.tag] || "";
                      return `<tr>
                        <td><strong>${tag.tag}</strong><br><span style="color:var(--text-3);font-size:11px">${tag.label}</span></td>
                        <td>
                          <select class="form-control form-control-sm" name="id3_${tag.tag}" style="font-size:12.5px">
                            <option value="">— skip —</option>
                            ${rssSources.map((s) =>
                              `<option value="${s.field}" ${selected === s.field ? "selected" : ""}>${s.label}</option>`
                            ).join("")}
                          </select>
                        </td>
                      </tr>`;
                    }).join("")}
                  </tbody>
                </table>
              </div>
            </div>

            <div class="modal-actions" style="border:none;padding:0;margin-top:16px">
              <button type="submit" class="btn btn-primary">Save Settings</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Supplementary feeds -->
      <div class="panel ${supplementary.length > 0 ? "open" : ""}" id="supplementary-panel">
        <div class="panel-header" onclick="togglePanel('supplementary-panel')">
          <div class="panel-header-title">
            ${svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>', 'width="16" height="16"')}
            Supplementary Feeds
            ${supplementary.length > 0 ? `<span class="badge badge-default">${supplementary.length}</span>` : ""}
          </div>
          <svg class="panel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
        <div class="panel-body">
          <div class="form-hint" style="margin-bottom:12px">
            Link additional RSS feeds for this podcast — useful for paid subscriber feeds, bonus content feeds, or any alternate feed whose episodes belong in the same folder. Episodes are merged and duplicates skipped automatically.
          </div>
          <div id="supplementary-feed-list">
            ${supplementary.length === 0
              ? `<div style="color:var(--text-3);font-size:13px;margin-bottom:12px">No supplementary feeds linked yet.</div>`
              : supplementary.map((sf) => `
                <div class="episode-item" style="padding:8px 0;border-bottom:1px solid var(--border)" id="sf-${sf.id}">
                  <div class="episode-art" style="width:32px;height:32px;flex-shrink:0">
                    ${sf.image_url
                      ? `<img src="${sf.image_url}" style="width:32px;height:32px;border-radius:4px;object-fit:cover" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="episode-art-placeholder" style="width:32px;height:32px;display:none">${_PODCAST_SVG}</div>`
                      : `<div class="episode-art-placeholder" style="width:32px;height:32px">${_PODCAST_SVG}</div>`}
                  </div>
                  <div class="episode-info">
                    <div class="episode-title" style="font-size:13px">${sf.title || sf.url}</div>
                    <div class="episode-meta">
                      <span>${sf.episode_count} episodes${sf.skipped_count > 0 ? ` (${sf.skipped_count} duplicate${sf.skipped_count === 1 ? "" : "s"})` : ""}</span>
                      <span>${sf.downloaded_count} downloaded</span>
                      ${sf.last_error ? `<span style="color:var(--error)">⚠ ${sf.last_error.slice(0,60)}</span>` : ""}
                    </div>
                  </div>
                  <div class="episode-actions">
                    <button class="btn btn-ghost btn-sm" onclick="unlinkSupplementaryFeed(${id}, ${sf.id})">Unlink</button>
                  </div>
                </div>`).join("")}
          </div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <input class="form-control" id="supplementary-url-input" placeholder="RSS feed URL" style="flex:1" />
            <button class="btn btn-primary btn-sm" id="btn-add-supplementary">Add</button>
          </div>
          ${feed.primary_feed_id ? `<div class="form-hint" style="margin-top:8px;color:var(--warning)">
            This feed is itself a supplementary feed linked to another podcast.
          </div>` : ""}
        </div>
      </div>

      <!-- Episodes list -->
      <div class="panel open" id="episodes-panel">
        <div class="panel-header" onclick="togglePanel('episodes-panel')">
          <div class="panel-header-title">
            ${svg('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>', 'width="16" height="16"')}
            Episodes
            <span class="badge badge-default">${episodes.length}</span>
            ${feed.hidden_count > 0 ? `<span class="badge badge-default" id="hidden-count-badge" style="opacity:0.6">${feed.hidden_count} hidden</span>` : ""}
          </div>
          <div style="display:flex;gap:8px;align-items:center" onclick="event.stopPropagation()">
            ${feed.hidden_count > 0 ? `<button class="btn btn-ghost btn-sm" id="btn-show-hidden">
              Show Hidden
            </button>` : ""}
            ${feed.episode_count > 0 ? `<button class="btn btn-ghost btn-sm" id="btn-mark-all-played">Mark all played</button>` : ""}
            <span id="dl-btn-area">${_buildDlBtnHtml(feed, initialQueueCount)}</span>
            <svg class="panel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </div>
        </div>
        <div class="panel-body" style="padding:0">
          <div id="select-bar">
            <div class="bulk-row-top">
              <button class="btn btn-ghost btn-sm" id="btn-bulk-select">Select Episodes</button>
              <div id="bulk-action-bar" class="hidden">
                <span id="bulk-count">0 selected</span>
                <button class="btn btn-ghost btn-sm" onclick="_bulkSelectAll()">Select All</button>
                <button class="btn btn-ghost btn-sm" onclick="_bulkSelectNone()">Select None</button>
                <button class="btn btn-ghost btn-sm" onclick="_bulkSelectInverse()">Select Inverse</button>
              </div>
            </div>
            <div class="bulk-row-actions hidden" id="bulk-act-row">
              <span class="bulk-actions-label">Apply to selected:</span>
              <button class="btn btn-ghost btn-sm bulk-act-btn" id="bulk-btn-download" disabled onclick="_bulkAct('download')">Download</button>
              <button class="btn btn-ghost btn-sm bulk-act-btn" id="bulk-btn-played" disabled onclick="_bulkActPlayed()">Mark Played</button>
              <button class="btn btn-ghost btn-sm bulk-act-btn" id="bulk-btn-hidden" disabled onclick="_bulkActHidden()">Hide</button>
              <button class="btn btn-danger btn-sm bulk-act-btn" id="bulk-btn-delete" disabled onclick="_bulkAct('delete_file')">Delete Files</button>
            </div>
          </div>
          <div style="border-bottom:1px solid var(--border);padding-top:10px">
            <div style="display:flex;align-items:center;gap:8px;padding:0 12px 8px">
              <input class="form-control" id="ep-filter" placeholder="Filter by title…"
                     style="flex:1;max-width:min(260px, calc(100vw - 160px));height:30px;font-size:13px"
                     oninput="_filterEpisodes()" />
              <button class="btn btn-ghost btn-sm" id="btn-sort-order" title="Toggle sort order">
                Sort Oldest First
              </button>
            </div>
            <div class="ep-filter-row" id="ep-status-pills">
              <button class="ep-filter-pill active" data-sf="all">All</button>
              <button class="ep-filter-pill" data-sf="downloaded">Downloaded</button>
              <button class="ep-filter-pill" data-sf="unplayed">Unplayed</button>
              <button class="ep-filter-pill" data-sf="active">In Progress</button>
              <button class="ep-filter-pill" data-sf="failed">Failed</button>
              <button class="ep-filter-pill" data-sf="hidden">Hidden</button>
            </div>
          </div>
          <div class="episode-list" id="episode-list">
            ${episodes.length === 0
              ? `<div class="empty-state"><div class="empty-state-icon">${svg('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>', 'style="width:40px;height:40px;display:block;margin:0 auto"')}</div>
                 <div class="empty-state-title">No episodes found</div>
                 <div class="empty-state-desc">Sync the feed to fetch episodes.</div></div>`
              : episodes.map((ep) => episodeRow(ep, feed)).join("")}
          </div>
          ${episodes.length >= EP_BATCH
            ? `<div style="padding:12px;text-align:center">
                 <button class="btn btn-ghost btn-sm" id="btn-load-more-eps">
                   Load more episodes
                 </button>
               </div>`
            : (episodes.length > 0
                ? `<div id="ep-total-bar" style="padding:8px 16px;color:var(--text-3);font-size:12px;text-align:center">
                     ${episodes.length} episode${episodes.length !== 1 ? "s" : ""} total
                   </div>`
                : "")}
        </div>
      </div>
    </div>`;

  // Wire up buttons
  window._onSyncIdle = _refreshFeedStats;

  document.getElementById("btn-sync-feed").addEventListener("click", async () => {
    try {
      await API.syncFeed(id);
      updateStatus();
      Toast.success("Feed sync triggered");
    } catch (e) { Toast.error(e.message); }
  });

  // Poll for sync completion on newly-added feeds (episode count is 0, sync not yet done)
  if (!feed.initial_sync_complete) {
    let polls = 0;
    window._syncPollTimer = setInterval(async () => {
      polls++;
      if (polls > 60) {
        clearInterval(window._syncPollTimer);
        window._syncPollTimer = null;
        return;
      }
      try {
        const updated = await API.getFeed(id);
        if (updated.initial_sync_complete) {
          clearInterval(window._syncPollTimer);
          window._syncPollTimer = null;
          await _refreshFeedStats();
          await _refreshEpisodeList();
        }
      } catch (_) {}
    }, 2500);
  }

  // Episode filter — combines text search and status pill
  window._filterEpisodes = function () {
    const q  = (document.getElementById("ep-filter")?.value || "").toLowerCase();
    const sf = window._epState?.statusFilter || "all";
    const rows = [...document.querySelectorAll("#episode-list .episode-item")];
    let visible = 0;
    rows.forEach((row) => {
      const title  = (row.dataset.title  || "").toLowerCase();
      const status =  row.dataset.status || "";
      const played =  row.dataset.played === "1";
      const textOk = !q || title.includes(q);
      let   sfOk   = true;
      const isHidden = row.dataset.hidden === "1";
      if      (sf === "hidden")     sfOk = isHidden;
      else if (sf === "downloaded") sfOk = !isHidden && status === "downloaded";
      else if (sf === "unplayed")   sfOk = !isHidden && !played;
      else if (sf === "active")     sfOk = !isHidden && (status === "queued" || status === "downloading");
      else if (sf === "failed")     sfOk = !isHidden && status === "failed";
      // "all" shows everything including hidden (they remain grayed out)
      const show = textOk && sfOk;
      row.style.display = show ? "" : "none";
      if (show) visible++;
    });
    const total = rows.length;
    const bar = document.getElementById("ep-total-bar");
    if (bar) {
      const isFiltered = visible < total;
      bar.textContent = isFiltered
        ? `${visible} episode${visible !== 1 ? "s" : ""} shown · ${total} total`
        : `${total} episode${total !== 1 ? "s" : ""} total`;
    }
  };

  // Status filter pills
  document.getElementById("ep-status-pills")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sf]");
    if (!btn) return;
    window._epState.statusFilter = btn.dataset.sf;
    document.querySelectorAll("#ep-status-pills .ep-filter-pill").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    window._filterEpisodes();
  });

  // Sort order toggle
  window._epState.order = "desc";
  document.getElementById("btn-sort-order")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-sort-order");
    const newOrder = window._epState.order === "desc" ? "asc" : "desc";
    window._epState.order = newOrder;
    btn.textContent = newOrder === "desc" ? "Sort Oldest First" : "Sort Newest First";
    btn.disabled = true;
    try {
      const eps = await API.getFeedEpisodesWithHidden(id, EP_BATCH, 0, newOrder);
      window._epState.offset = eps.length;
      const list = document.getElementById("episode-list");
      if (list) list.innerHTML = eps.map((ep) => episodeRow(ep, feed)).join("");
      Player.syncPlayBtns();
    } catch (e) { Toast.error(e.message); }
    btn.disabled = false;
  });

  // Mark all as played
  document.getElementById("btn-mark-all-played")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-mark-all-played");
    btn.disabled = true;
    btn.textContent = "Marking…";
    try {
      const r = await API.markAllPlayed(id);
      Toast.success(`${r.updated} episode${r.updated !== 1 ? "s" : ""} marked as played`);
      updateStatus();
      await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]);
      // _refreshFeedStats updates window._epState.feed with fresh counts; rebuild buttons now
      _rebuildDlArea(0);
      btn.disabled = false;
      btn.textContent = "Mark all played";
    } catch (e) {
      Toast.error(e.message);
      btn.disabled = false;
      btn.textContent = "Mark all played";
    }
  });

  document.getElementById("btn-toggle-active").addEventListener("click", async () => {
    try {
      await API.updateFeed(id, { active: !feed.active });
      feed.active = !feed.active;
      window._epState.feed = feed;
      Toast.success(`Feed ${feed.active ? "resumed" : "paused"}`);
      const toggleBtn = document.getElementById("btn-toggle-active");
      if (toggleBtn) toggleBtn.textContent = feed.active ? "Pause Feed" : "Resume Feed";
      const artWrap = document.querySelector(".feed-header-art");
      if (artWrap) artWrap.innerHTML = artImg(feed.custom_image_url || feed.image_url, "", "", !feed.active);
    } catch (e) { Toast.error(e.message); }
  });

  document.getElementById("btn-choose-cover").addEventListener("click", () => {
    document.getElementById("feed-cover-file").click();
  });

  document.getElementById("feed-cover-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const btn = document.getElementById("btn-choose-cover");
    btn.disabled = true;
    btn.textContent = "Uploading…";
    // Show local preview immediately
    const preview = document.getElementById("feed-art-preview");
    if (preview?.tagName === "IMG") preview.src = URL.createObjectURL(file);
    try {
      await API.uploadFeedCover(id, file);
      feed.has_custom_cover = true;
      Toast.success("Cover art updated");
      btn.disabled = false;
      btn.textContent = "Replace image…";
      const hint = document.getElementById("feed-cover-hint");
      if (hint) hint.textContent = "Using custom cover art.";
      if (!document.getElementById("btn-remove-cover")) {
        btn.insertAdjacentHTML("afterend", `<button type="button" class="btn btn-ghost btn-sm" id="btn-remove-cover" style="color:var(--error)">Remove custom art</button>`);
        document.getElementById("btn-remove-cover").addEventListener("click", removeCoverHandler);
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = feed.has_custom_cover ? "Replace image…" : "Choose image…";
      Toast.error(e.message);
    }
  });

  async function removeCoverHandler() {
    const btn = document.getElementById("btn-remove-cover");
    if (btn) btn.disabled = true;
    try {
      await API.removeFeedCover(id);
      feed.has_custom_cover = false;
      Toast.success("Custom cover art removed");
      const preview = document.getElementById("feed-art-preview");
      if (preview?.tagName === "IMG") preview.src = feed.image_url || "";
      const chooseBtn = document.getElementById("btn-choose-cover");
      if (chooseBtn) chooseBtn.textContent = "Choose image…";
      const hint = document.getElementById("feed-cover-hint");
      if (hint) hint.textContent = "Upload an image to override the RSS-provided artwork.";
      if (btn) btn.remove();
    } catch (e) {
      if (btn) btn.disabled = false;
      Toast.error(e.message);
    }
  }
  document.getElementById("btn-remove-cover")?.addEventListener("click", removeCoverHandler);

  // Wire the "Apply File Updates" button if the feed currently has pending renames/tags.
  // We delegate to the shared helper so the same logic can be triggered mid-session
  // when episode tags are saved (which may create a rename need without a page reload).
  if (document.getElementById("btn-update-filenames")) _wireFileUpdatesBtn(id);

  // Import / Archive dropdown menu
  document.getElementById("btn-import-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    const wrap = document.getElementById("import-menu-wrap");
    wrap.toggleAttribute("data-open");
  });

  document.getElementById("btn-upload-feed-xml").addEventListener("click", () => {
    document.getElementById("import-menu-wrap").removeAttribute("data-open");
    showUploadFeedXmlModal(id, feed);
  });

  document.getElementById("btn-import-files").addEventListener("click", () => {
    document.getElementById("import-menu-wrap").removeAttribute("data-open");
    showImportFilesModal(id, feed);
  });

  document.getElementById("btn-download-clean-rss").addEventListener("click", () => {
    document.getElementById("import-menu-wrap").removeAttribute("data-open");
    window.location.href = `/api/feeds/${id}/clean-rss`;
  });

  document.getElementById("btn-renumber-all")?.addEventListener("click", () => {
    showRenumberModal(id);
  });

  document.getElementById("btn-delete-feed").addEventListener("click", () => {
    showDeleteFeedModal(feed);
  });

  document.getElementById("btn-add-supplementary").addEventListener("click", async () => {
    const input = document.getElementById("supplementary-url-input");
    const url = input.value.trim();
    if (!url) return;
    const btn = document.getElementById("btn-add-supplementary");
    btn.disabled = true;
    try {
      await API.addSupplementary(id, url);
      Toast.info("Supplementary feed added — syncing episodes…");
      input.value = "";
      btn.disabled = false;
      const subs = await API.getSupplementary(id);
      const listEl = document.getElementById("supplementary-feed-list");
      if (listEl) {
        listEl.innerHTML = subs.length === 0
          ? `<div style="color:var(--text-3);font-size:13px;margin-bottom:12px">No supplementary feeds linked yet.</div>`
          : subs.map((sf) => `
            <div class="episode-item" style="padding:8px 0;border-bottom:1px solid var(--border)" id="sf-${sf.id}">
              <div class="episode-art" style="width:32px;height:32px;flex-shrink:0">
                ${sf.image_url
                  ? `<img src="${sf.image_url}" style="width:32px;height:32px;border-radius:4px;object-fit:cover" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="episode-art-placeholder" style="width:32px;height:32px;display:none">${_PODCAST_SVG}</div>`
                  : `<div class="episode-art-placeholder" style="width:32px;height:32px">${_PODCAST_SVG}</div>`}
              </div>
              <div class="episode-info">
                <div class="episode-title" style="font-size:13px">${sf.title || sf.url}</div>
                <div class="episode-meta">
                  <span>${sf.episode_count} episodes${sf.skipped_count > 0 ? ` (${sf.skipped_count} duplicate${sf.skipped_count === 1 ? "" : "s"})` : ""}</span>
                  <span>${sf.downloaded_count} downloaded</span>
                  ${sf.last_error ? `<span style="color:var(--error)">⚠ ${sf.last_error.slice(0, 60)}</span>` : ""}
                </div>
              </div>
              <div class="episode-actions">
                <button class="btn btn-ghost btn-sm" onclick="unlinkSupplementaryFeed(${id}, ${sf.id})">Unlink</button>
              </div>
            </div>`).join("");
        const badge = document.querySelector("#supplementary-panel .panel-header .badge");
        if (badge) badge.textContent = subs.length;
      }
    } catch (e) {
      btn.disabled = false;
      Toast.error(e.message);
    }
  });

  // ── Feed download queue polling ────────────────────────────────────────────
  // Tracks queued+downloading episodes for this podcast group and keeps the
  // download buttons in a "Downloading (N remaining)" state until the queue drains.
  // Only episodes for THIS feed count; other podcasts' queues are ignored.

  function _rebuildDlArea(queueCount) {
    const area = document.getElementById("dl-btn-area");
    if (!area) return;
    area.innerHTML = _buildDlBtnHtml(window._epState?.feed, queueCount);
    _wireDlBtns();
  }

  function _setDlBtnsQueuing(count) {
    // Update the count label in-place if possible to avoid re-wiring buttons.
    const label = document.getElementById("dl-progress-count");
    if (label) {
      label.textContent = `${count} downloading`;
      return;
    }
    // No indicator yet — the download button area exists but the progress indicator
    // hasn't been injected (e.g. first tick after queueEpisode). Full rebuild.
    _rebuildDlArea(count);
  }

  async function _restoreDlBtns() {
    try {
      const updated = await API.getFeed(id);
      if (!document.getElementById("dl-btn-area")) return;
      window._epState.feed = updated;
      _rebuildDlArea(0);
    } catch (_) {}
  }

  async function _feedDLPollTick() {
    if (!document.getElementById("dl-btn-area")) {
      // User navigated away — stop the poll
      clearInterval(window._feedDLPollTimer);
      window._feedDLPollTimer = null;
      return;
    }
    try {
      const { count } = await API.get(`/api/feeds/${id}/queue-count`);
      if (!document.getElementById("dl-btn-area")) return; // navigated away during fetch
      if (count === 0) {
        clearInterval(window._feedDLPollTimer);
        window._feedDLPollTimer = null;
        updateStatus();
        await Promise.all([_refreshEpisodeList(), _restoreDlBtns()]);
      } else {
        _setDlBtnsQueuing(count);
      }
    } catch (_) {}
  }

  function _startFeedDLPoll() {
    if (window._feedDLPollTimer) return;
    window._feedDLPollTimer = setInterval(_feedDLPollTick, 2000);
    _feedDLPollTick(); // immediate first tick
  }

  function _disableDlBtns() {
    ["btn-dl-unplayed-feed", "btn-dl-unplayed-feed-dd", "btn-dl-all-feed",
     "btn-split-caret"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
    // Also disable any caret button adjacent to the split main
    document.querySelectorAll("#dl-btn-area .btn-split-caret").forEach(el => { el.disabled = true; });
  }

  function _wireDlBtns() {
    document.getElementById("btn-dl-unplayed-feed")?.addEventListener("click", () => {
      _disableDlBtns();
      _doDownloadUnplayed();
    });
    document.getElementById("btn-dl-unplayed-feed-dd")?.addEventListener("click", (e) => {
      e.currentTarget.closest(".ep-more-wrap")?.removeAttribute("data-open");
      _disableDlBtns();
      _doDownloadUnplayed();
    });
    document.getElementById("btn-dl-all-feed")?.addEventListener("click", (e) => {
      e.currentTarget.closest(".ep-more-wrap")?.removeAttribute("data-open");
      _disableDlBtns();
      _doDownloadAll();
    });
    document.getElementById("btn-dl-cancel-feed")?.addEventListener("click", async () => {
      try {
        const r = await API.cancelFeedQueued(id);
        clearInterval(window._feedDLPollTimer);
        window._feedDLPollTimer = null;
        Toast.info(`Cancelled ${r.cancelled} download${r.cancelled !== 1 ? "s" : ""}`);
        updateStatus();
        await Promise.all([_refreshEpisodeList(), _restoreDlBtns()]);
      } catch (e) { Toast.error(e.message); }
    });
  }

  const _doDownloadUnplayed = async () => {
    try {
      const r = await API.downloadUnplayedFeed(id);
      updateStatus();
      if (r.queued > 0) {
        Toast.info(`Queued ${r.queued} unplayed episode${r.queued !== 1 ? "s" : ""} for download`);
        // Zero out unplayed count so the rebuilt button renders disabled
        const feed = window._epState?.feed;
        if (feed) feed.unplayed_available_count = 0;
        _rebuildDlArea(r.queued);
        _startFeedDLPoll();
      } else {
        Toast.info("No unplayed episodes to download");
        await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]);
      }
    } catch (e) { Toast.error(e.message); }
  };
  const _doDownloadAll = async () => {
    try {
      const r = await API.downloadAllFeed(id);
      updateStatus();
      if (r.queued > 0) {
        Toast.info(`Queued ${r.queued} episode${r.queued !== 1 ? "s" : ""} for download`);
        // Zero out both counts so the rebuilt buttons render disabled
        const feed = window._epState?.feed;
        if (feed) { feed.available_count = 0; feed.unplayed_available_count = 0; }
        _rebuildDlArea(r.queued);
        _startFeedDLPoll();
      } else {
        Toast.info("No episodes to download");
        await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]);
      }
    } catch (e) { Toast.error(e.message); }
  };

  _wireDlBtns();

  // Rebuild the button area using the current cached feed counts + whatever the
  // progress indicator currently shows as its queue count (so we don't need an
  // extra API call just to redraw the button).
  function _refreshDlArea() {
    const label = document.getElementById("dl-progress-count");
    const qCount = label ? (parseInt(label.textContent) || 0) : 0;
    _rebuildDlArea(qCount);
  }

  // Expose closures so global episode handlers (queueEpisode, cancelEpisode) can
  // interact with this feed's download poll without being inside the closure.
  window._feedDetailDL = { startPoll: _startFeedDLPoll, restore: _restoreDlBtns, refresh: _refreshDlArea };

  // If there are already queued/downloading episodes for this feed when the page loads
  // (e.g., triggered from a different page), start the poll immediately.
  // initialQueueCount was already fetched alongside the feed data — no extra round trip.
  if (initialQueueCount > 0) _startFeedDLPoll();

  document.getElementById("btn-load-more-eps")?.addEventListener("click", loadMoreEpisodes);

  // Bulk select mode
  let _bulkIds = new Set();
  function _allEpIds() {
    // Only include episodes currently visible (not hidden by the active filter)
    return [...document.querySelectorAll(".ep-checkbox")]
      .filter((el) => el.closest(".episode-item")?.style.display !== "none")
      .map((el) => Number(el.dataset.epId));
  }

  function _updateBulkButtons() {
    const ids = [..._bulkIds];
    const hasSelection = ids.length > 0;

    // Enable/disable action buttons based on whether anything is selected
    for (const btn of document.querySelectorAll(".bulk-act-btn")) {
      btn.disabled = !hasSelection;
    }

    if (!hasSelection) return;

    // Played smart button: "Mark Unplayed" only if ALL selected are already played
    const playedBtn = document.getElementById("bulk-btn-played");
    if (playedBtn) {
      const allPlayed = ids.every((id) => document.getElementById(`ep-${id}`)?.dataset.played === "1");
      playedBtn.textContent = allPlayed ? "Mark Unplayed" : "Mark Played";
    }

    // Hidden smart button: "Unhide" only if ALL selected are already hidden
    const hiddenBtn = document.getElementById("bulk-btn-hidden");
    if (hiddenBtn) {
      const allHidden = ids.every((id) => document.getElementById(`ep-${id}`)?.dataset.hidden === "1");
      hiddenBtn.textContent = allHidden ? "Unhide" : "Hide";
    }
  }

  function _syncCheckboxes() {
    for (const cb of document.querySelectorAll(".ep-checkbox")) {
      cb.checked = _bulkIds.has(Number(cb.dataset.epId));
    }
    const countEl = document.getElementById("bulk-count");
    if (countEl) countEl.textContent = `${_bulkIds.size} selected`;
    _updateBulkButtons();
  }

  window._bulkToggle = (epId) => {
    if (_bulkIds.has(epId)) _bulkIds.delete(epId);
    else _bulkIds.add(epId);
    const cb = document.querySelector(`.ep-checkbox[data-ep-id="${epId}"]`);
    if (cb) cb.checked = _bulkIds.has(epId);
    const countEl = document.getElementById("bulk-count");
    if (countEl) countEl.textContent = `${_bulkIds.size} selected`;
    _updateBulkButtons();
  };

  window._bulkActPlayed = () => {
    const allPlayed = [..._bulkIds].every((id) => document.getElementById(`ep-${id}`)?.dataset.played === "1");
    window._bulkAct(allPlayed ? "mark_unplayed" : "mark_played");
  };

  window._bulkActHidden = () => {
    const allHidden = [..._bulkIds].every((id) => document.getElementById(`ep-${id}`)?.dataset.hidden === "1");
    window._bulkAct(allHidden ? "unhide" : "hide");
  };

  window._bulkSelectAll = () => {
    _bulkIds = new Set(_allEpIds());
    _syncCheckboxes();
  };

  window._bulkSelectNone = () => {
    _bulkIds = new Set();
    _syncCheckboxes();
  };

  window._bulkSelectInverse = () => {
    const all = _allEpIds();
    _bulkIds = new Set(all.filter((id) => !_bulkIds.has(id)));
    _syncCheckboxes();
  };
  window._bulkCancel = () => {
    _bulkIds = new Set();
    _syncCheckboxes();
    document.getElementById("bulk-action-bar")?.classList.add("hidden");
    document.getElementById("bulk-act-row")?.classList.add("hidden");
    document.getElementById("episode-list")?.classList.remove("bulk-mode");
    const btn = document.getElementById("btn-bulk-select");
    if (btn) { btn.textContent = "Select Episodes"; btn.classList.remove("btn-cancel-select"); }
  };
  window._bulkAct = async (action) => {
    const ids = [..._bulkIds];
    if (!ids.length) return Toast.info("No episodes selected");
    // For delete_file we only want to operate on episodes that actually have a
    // downloaded file — passing the full selection would inflate the affected count
    // and ask the backend to process IDs it has nothing to do for.
    let actIds = ids;
    if (action === "delete_file") {
      actIds = ids.filter((id) => document.getElementById(`ep-${id}`)?.dataset.status === "downloaded");
      if (!actIds.length) return Toast.info("None of the selected episodes have a downloaded file");
      if (!confirm(`Delete files for ${actIds.length} episode${actIds.length !== 1 ? "s" : ""}?`)) return;
    }
    if (action === "download" && ids.length > 20 && !confirm(`Queue ${ids.length} episodes for download?`)) return;
    try {
      const r = await API.bulkAction(actIds, action);
      const n = r.affected;
      const ep = n !== 1 ? "episodes" : "episode";
      const actionMessages = {
        download:      `${n} ${ep} queued for download`,
        delete_file:   `${n} ${ep} deleted`,
        mark_played:   `${n} ${ep} marked as played`,
        mark_unplayed: `${n} ${ep} marked as unplayed`,
        hide:          `${n} ${ep} hidden`,
        unhide:        `${n} ${ep} unhidden`,
      };
      Toast.success(actionMessages[action] || `${n} ${ep} updated`);
      await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]);
      updateStatus();
      _syncCheckboxes();
    } catch (e) { Toast.error(e.message); }
  };

  document.getElementById("btn-bulk-select")?.addEventListener("click", () => {
    const active = document.getElementById("episode-list")?.classList.toggle("bulk-mode");
    document.getElementById("bulk-action-bar")?.classList.toggle("hidden", !active);
    document.getElementById("bulk-act-row")?.classList.toggle("hidden", !active);
    const btn = document.getElementById("btn-bulk-select");
    if (btn) {
      btn.textContent = active ? "Cancel Select Episodes" : "Select Episodes";
      btn.classList.toggle("btn-cancel-select", !!active);
    }
    if (!active) window._bulkCancel();
  });

  // Wire per-feed autoclean toggle visibility
  const feedAutocleanToggle = document.querySelector('[name="autoclean_enabled"]');
  if (feedAutocleanToggle) {
    feedAutocleanToggle.addEventListener("change", function() {
      const cfg = document.getElementById("feed-autoclean-cfg");
      if (cfg) cfg.style.display = this.checked ? "" : "none";
      if (this.checked) {
        // Default to "unplayed" mode when first enabling
        const radio = document.querySelector('input[name="autoclean_mode"][value="unplayed"]');
        if (radio) { radio.checked = true; _feedUpdateAutocleanMode(); }
      }
    });
  }

  // ID3 toggle visibility
  document.querySelector('[name="id3_enabled"]').addEventListener("change", (e) => {
    document.getElementById("id3-section").style.display = e.target.checked ? "" : "none";
  });

  // Settings form submit
  document.getElementById("feed-settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const raw = collectForm(form);

    const mapping = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("id3_") && v) {
        mapping[k.slice(4)] = v;
      }
    }

    const payload = {
      url: raw.url || feed.url,
      active: feed.active,
      id3_enabled: raw.id3_enabled ?? false,
      id3_field_mapping: mapping,
      filename_date_prefix: raw.filename_date_prefix ?? false,
      filename_episode_number: raw.filename_episode_number ?? true,
      organize_by_year: raw.organize_by_year ?? false,
      save_xml: raw.save_xml ?? false,
      auto_download_new: raw.auto_download_new ?? true,
      episode_number_start: raw.episode_number_start ? Number(raw.episode_number_start) : 1,
    };
    if (raw.download_path) payload.download_path = raw.download_path;
    if (raw.check_interval) payload.check_interval = raw.check_interval;

    // Validate per-feed autoclean: mode="recent" requires a count
    if (!settings.autoclean_enabled && raw.autoclean_enabled
        && (raw.autoclean_mode || "unplayed") === "recent" && !raw.keep_latest) {
      Toast.error("Auto-cleanup mode 'Keep N most recent' requires a keep count");
      return;
    }

    if (settings.autoclean_enabled) {
      // Global autoclean is on — only the exclude toggle is shown
      payload.autoclean_exclude = raw.autoclean_exclude ?? false;
    } else {
      // Per-feed autoclean — full UI is shown
      payload.autoclean_exclude = false;
      payload.autoclean_enabled = raw.autoclean_enabled ?? false;
      payload.autoclean_mode    = raw.autoclean_mode || "unplayed";
      payload.keep_latest = (raw.autoclean_enabled && (raw.autoclean_mode || "unplayed") === "recent" && raw.keep_latest)
        ? Number(raw.keep_latest) : null;
      payload.keep_unplayed = true;
    }

    try {
      await API.updateFeed(id, payload);
      Toast.success("Feed settings saved");
    } catch (err) {
      Toast.error(err.message);
    }
  });

  // Show import status banner if an import is running or recently finished.
  // We call the shared helper directly; it can also be triggered post-modal to avoid
  // a full page reload when a new import is started from the Import Files dialog.
  _pollImportBanner(id);

  // Jump to a specific episode if requested (e.g. from dashboard)
  if (window._pendingEpScroll) {
    const targetId = window._pendingEpScroll;
    window._pendingEpScroll = null;
    requestAnimationFrame(() => {
      const row = document.getElementById(`ep-${targetId}`);
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.add("ep-highlight");
        setTimeout(() => row.classList.remove("ep-highlight"), 5100);
      }
    });
  }
}


async function loadMoreEpisodes() {
  const { id, feed, offset, batch, order } = window._epState;
  const btn = document.getElementById("btn-load-more-eps");
  if (btn) btn.textContent = "Loading…";
  try {
    const more = await API.getFeedEpisodesWithHidden(id, batch, offset, order || "desc");
    const list = document.getElementById("episode-list");
    if (list) {
      list.insertAdjacentHTML("beforeend", more.map((ep) => episodeRow(ep, feed)).join(""));
      for (const ep of more) {
        document.getElementById(`ep-${ep.id}`)?.classList.add("entering");
      }
    }
    window._epState.offset += more.length;

    const container = btn?.parentElement;
    if (!container) return;
    if (more.length < batch) {
      const total = window._epState.offset;
      container.innerHTML = `<div id="ep-total-bar" style="padding:8px 16px;color:var(--text-3);font-size:12px;text-align:center">${total} episode${total !== 1 ? "s" : ""} total</div>`;
    } else {
      if (btn) btn.textContent = "Load more episodes";
    }
  } catch (e) {
    if (btn) btn.textContent = "Load more episodes";
    Toast.error(e.message);
  }
}


function _sanitizeNotes(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed,form").forEach((el) => el.remove());
  doc.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((a) => {
      if (a.name.startsWith("on")) el.removeAttribute(a.name);
      if (a.name === "href" && a.value.toLowerCase().trimStart().startsWith("javascript:")) el.removeAttribute(a.name);
    });
    if (el.tagName === "A") { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
  });
  return doc.body.innerHTML;
}

window._feedUpdateAutocleanMode = function() {
  const unplayed = document.querySelector('input[name="autoclean_mode"][value="unplayed"]')?.checked;
  const row = document.getElementById("feed-autoclean-count-row");
  if (row) row.style.display = unplayed ? "none" : "";
  if (!unplayed) {
    // "recent" mode: ensure keep_latest is valid
    const input = document.querySelector('[name="keep_latest"]');
    if (input && !input.value) input.value = "10";
  }
};

window._dismissFeedError = async function(feedId) {
  try {
    await API.clearFeedError(feedId);
    const banner = document.getElementById("feed-error-banner");
    if (banner) { banner.style.display = "none"; banner.innerHTML = ""; }
    if (window._epState?.feed) window._epState.feed.last_error = null;
  } catch (e) { Toast.error(e.message); }
};

window._runFeedAutocleanNow = async function(feedId) {
  const mode = document.querySelector('input[name="autoclean_mode"]:checked')?.value || "unplayed";
  const msg = mode === "unplayed"
    ? "This will permanently delete files for all fully-played episodes in this podcast. Continue?"
    : "This will permanently delete episode files beyond the keep count for this podcast. Continue?";
  if (!confirm(msg)) return;

  const btn = document.getElementById("btn-run-feed-autoclean");
  if (!btn) return;
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.textContent = "Running…";
  try {
    const res = await API.runFeedAutoclean(feedId);
    Toast.success(`Cleanup complete — ${res.deleted} file${res.deleted !== 1 ? "s" : ""} deleted`);
  } catch (e) {
    Toast.error(e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
};

window._toggleEpNotes = function (id) {
  const row = document.getElementById(`ep-${id}`);
  if (!row) return;
  if (document.getElementById("episode-list")?.classList.contains("bulk-mode")) {
    window._bulkToggle(id);
  } else {
    row.toggleAttribute("data-notes-open");
  }
};

function episodeRow(ep, feed) {
  const imgSrc = ep.custom_image_url || ep.episode_image_url || feed?.custom_image_url || feed?.image_url || "";
  const isDownloaded = ep.status === "downloaded";
  const isActive = ep.status === "downloading" || ep.status === "queued";

  const progressHTML = isActive
    ? `<div class="progress-bar"><div class="progress-fill" style="width:${ep.status === "downloading" ? ep.download_progress : 0}%"></div></div>`
    : "";

  let listenHTML = "";
  if (ep.played) {
    listenHTML = `<div class="ep-listen-bar-wrap ep-complete">
      <div class="ep-listen-bar"><div class="ep-listen-fill" style="width:100%"></div></div>
      <span class="ep-listen-label ep-listen-complete">100% listened</span>
    </div>`;
  } else if (ep.play_position_seconds > 0) {
    const durSecs = _parseDurSecs(ep.duration);
    const pct = durSecs > 0 ? Math.min(100, Math.round(ep.play_position_seconds / durSecs * 100)) : 0;
    const label = pct > 0 ? `${pct}% listened` : "Started";
    const fillW = pct > 0 ? pct : 5;
    listenHTML = `<div class="ep-listen-bar-wrap">
      <div class="ep-listen-bar"><div class="ep-listen-fill" style="width:${fillW}%"></div></div>
      <span class="ep-listen-label">${label}</span>
    </div>`;
  } else if (isDownloaded) {
    listenHTML = `<div class="ep-listen-bar-wrap">
      <div class="ep-listen-bar"><div class="ep-listen-fill" style="width:0%"></div></div>
      <span class="ep-listen-label">0% listened</span>
    </div>`;
  }

  const seqBadge = ep.seq_number != null
    ? `<span class="badge badge-default" title="${ep.seq_number_locked ? "Manually set" : "Auto-numbered"}" style="font-variant-numeric:tabular-nums">
        #${ep.seq_number}${ep.seq_number_locked ? " ✎" : ""}
       </span>`
    : "";

  if (ep.hidden) {
    return `<div class="episode-item" id="ep-${ep.id}" data-status="${ep.status}" data-hidden="1" style="opacity:0.45">
      <input type="checkbox" class="bulk-check ep-checkbox" data-ep-id="${ep.id}" onclick="event.stopPropagation();_bulkToggle(${ep.id})" />
      <div class="episode-art">
        ${imgSrc
          ? `<img src="${imgSrc}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="episode-art-placeholder" style="display:none">${_PODCAST_SVG}</div>`
          : `<div class="episode-art-placeholder">${_PODCAST_SVG}</div>`}
      </div>
      <div class="episode-info">
        <div class="episode-title" style="text-decoration:line-through">${ep.title || "Untitled"}</div>
        <div class="episode-meta">
          <span>${fmt(ep.published_at, ep.date_is_approximate)}</span>
          ${ep.duration ? `<span><span class="meta-label">Runtime</span> ${ep.duration}</span>` : ""}
          <span class="badge badge-default">Hidden</span>
        </div>
      </div>
      <div class="episode-actions">
        <button class="btn btn-ghost btn-sm" title="Unhide episode"
                onclick="event.stopPropagation();unhideEpisode(${ep.id})">Unhide</button>
      </div>
    </div>`;
  }

  // Art area: clickable to upload image only when downloaded
  const artContent = imgSrc
    ? `<img src="${imgSrc}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="episode-art-placeholder" style="display:none">${_PODCAST_SVG}</div>`
    : `<div class="episode-art-placeholder">${_PODCAST_SVG}</div>`;
  const artArea = isDownloaded
    ? `<div class="episode-art" title="Upload cover art" style="cursor:pointer" onclick="event.stopPropagation();uploadEpisodeImageClick(${ep.id})">${artContent}</div>`
    : `<div class="episode-art">${artContent}</div>`;

  // Build action buttons - delete/download depends on status
  let statusActionBtn = "";
  if ((ep.status === "pending" || ep.status === "failed") && ep.enclosure_url) {
    statusActionBtn = `<button class="btn btn-ghost btn-sm btn-icon" title="Download"
                               onclick="event.stopPropagation();queueEpisode(${ep.id})">
      ${svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>')}
    </button>`;
  } else if (isDownloaded && !ep.file_missing) {
    statusActionBtn = `
    <button class="btn btn-ghost btn-sm btn-icon" title="Delete file"
            onclick="event.stopPropagation();deleteEpisodeFile(${ep.id})">
      ${svg('<path d="M3 6h18"/><path d="M8 4h8"/><path d="M5 6l1.5 15h11L19 6"/><path d="M10 10v8"/><path d="M14 10v8"/>')}
    </button>`;
  } else if (isDownloaded && ep.file_missing) {
    statusActionBtn = `<button class="btn btn-ghost btn-sm btn-icon" title="Delete record"
                               onclick="event.stopPropagation();deleteEpisodeFile(${ep.id})">
      ${svg('<path d="M3 6h18"/><path d="M8 4h8"/><path d="M5 6l1.5 15h11L19 6"/><path d="M10 10v8"/><path d="M14 10v8"/>')}
    </button>`;
  } else if (ep.status === "queued" || ep.status === "downloading") {
    statusActionBtn = `<button class="btn btn-ghost btn-sm btn-icon" title="Cancel download"
                               onclick="event.stopPropagation();cancelEpisode(${ep.id})">
      ${svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}
    </button>`;
  }

  // Per-file buttons only available when downloaded
  const playBtn = (isDownloaded && !ep.file_missing) ? epPlayBtn(ep) : "";

  const _close = `this.closest('.ep-more-wrap').removeAttribute('data-open');`;
  const moreDropdown = `
  <div class="ep-more-wrap" onclick="event.stopPropagation()">
    <button class="btn btn-ghost btn-sm btn-icon ep-more-btn" title="More options"
            onclick="const w=this.closest('.ep-more-wrap');w.toggleAttribute('data-open');if(w.hasAttribute('data-open')){const d=w.querySelector('.ep-more-dropdown');if(d)positionDropdown(d);}document.querySelectorAll('.ep-more-wrap[data-open]').forEach(el=>el!==w&&el.removeAttribute('data-open'))">
      ${svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>')}
    </button>
    <div class="ep-more-dropdown">
      ${isDownloaded && !ep.file_missing ? `
      <a onclick="${_close}" href="/api/episodes/${ep.id}/file" download>
        ${svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>', 'width="14" height="14"')}
        Save to device
      </a>
      <button onclick="${_close}showSetNumberModal(${ep.id}, ${ep.seq_number ?? "null"}, ${ep.seq_number_locked})">
        ${svg('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>', 'width="14" height="14"')}
        Set episode number
      </button>
      <button onclick="${_close}showEpisodeTagsModal(${ep.id}, ${JSON.stringify(ep.custom_id3_tags || null)})">
        ${svg('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>', 'width="14" height="14"')}
        Edit ID3 tags
      </button>` : ""}
      <button onclick="${_close}hideEpisode(${ep.id})">
        ${svg('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>', 'width="14" height="14"')}
        Hide episode
      </button>
    </div>
  </div>`;

  const actionBtns = playBtn + statusActionBtn + `
  <button class="btn btn-ghost btn-sm btn-icon" title="${ep.played ? "Mark as unplayed" : "Mark as played"}"
          onclick="event.stopPropagation();toggleEpPlayed(${ep.id})">
    ${ep.played
      ? svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/>')
      : svg('<polyline points="20 6 9 17 4 12"/>', 'stroke-width="3.5"')}
  </button>` + moreDropdown;

  const notesPanel = ep.description
    ? `<div class="ep-notes-panel"><div class="ep-notes-inner">${_sanitizeNotes(ep.description)}</div></div>`
    : "";

  return `<div class="episode-item${ep.description ? " has-notes" : ""}" id="ep-${ep.id}" data-status="${ep.status}" data-title="${(ep.title || "").toLowerCase().replace(/"/g, "&quot;")}"${ep.played ? ' data-played="1"' : ""}${ep.description ? ` onclick="_toggleEpNotes(${ep.id})"` : ""}>
    <input type="checkbox" class="bulk-check ep-checkbox" data-ep-id="${ep.id}" onclick="event.stopPropagation();_bulkToggle(${ep.id})" />
    ${artArea}
    <div class="episode-info">
      <div class="episode-title">
        ${ep.played ? '<span class="ep-played-dot" title="Played"></span>' : ""}${ep.title || "Untitled"}
      </div>
      <div class="episode-meta">
        ${seqBadge}
        <span>${fmt(ep.published_at, ep.date_is_approximate)}</span>
        ${ep.duration ? `<span><span class="meta-label">Runtime</span> ${ep.duration}</span>` : ""}
        ${ep.file_size ? `<span><span class="meta-label">Size</span> ${fmtBytes(ep.file_size)}</span>` : ""}
        ${statusBadge(ep.status)}
        ${ep.file_missing ? `<span class="badge badge-error" title="File was deleted from disk">File missing</span>` : ""}
        ${!ep.enclosure_url && !isDownloaded ? `<span class="badge badge-default" title="No download URL available for this episode">No URL</span>` : ""}
        ${ep.error_message ? `<span style="color:var(--error)" title="${ep.error_message}">⚠ ${ep.error_message.slice(0,60)}</span>` : ""}
      </div>
      ${progressHTML}
      ${listenHTML}
    </div>
    <div class="episode-actions">${actionBtns}</div>
    ${notesPanel}
  </div>`;
}

window.hideEpisode = async function (id) {
  try {
    const ep = await API.hideEpisode(id);
    updateEpisodeRow(ep);
    _syncHiddenBadge(+1);
    _syncDownloadButtons(ep, +1);
    Toast.info("Episode hidden");
    updateStatus();
  } catch (e) { Toast.error(e.message); }
};

window.unhideEpisode = async function (id) {
  try {
    const ep = await API.unhideEpisode(id);
    updateEpisodeRow(ep);
    _syncHiddenBadge(-1);
    _syncDownloadButtons(ep, -1);
    Toast.info("Episode unhidden");
    updateStatus();
  } catch (e) { Toast.error(e.message); }
};

// Hidden file input for image uploads (shared across all episode rows)
let _epImageUploadId = null;
const _epImageInput = (() => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.style.display = "none";
  inp.addEventListener("change", async () => {
    const file = inp.files[0];
    if (!file || _epImageUploadId == null) return;
    const epId = _epImageUploadId;
    _epImageUploadId = null;
    inp.value = "";
    try {
      const ep = await API.uploadEpisodeImage(epId, file);
      updateEpisodeRow(ep);
      Toast.success("Cover art updated");
    } catch (e) { Toast.error(e.message); }
  });
  document.body.appendChild(inp);
  return inp;
})();

window.uploadEpisodeImageClick = function (epId) {
  _epImageUploadId = epId;
  _epImageInput.click();
};

window.showEpisodeTagsModal = function (epId, currentTags) {
  const feedState = window._epState;
  const feed = feedState?.feed || {};
  // Get the ID3 tag definitions from the page context; fall back to common set
  const tagDefs = window._id3TagDefs || [
    { tag: "TIT2", label: "Title" },
    { tag: "TPE1", label: "Artist" },
    { tag: "TALB", label: "Album" },
    { tag: "TDRC", label: "Year/Date" },
    { tag: "TRCK", label: "Track Number" },
    { tag: "TCON", label: "Genre" },
    { tag: "COMM", label: "Comment" },
  ];
  const current = currentTags || {};
  const rows = tagDefs.map((t) => `
    <tr>
      <td style="padding:6px 8px;white-space:nowrap;color:var(--text-2);font-size:12px">
        <strong style="color:var(--text)">${t.tag}</strong><br>${t.label}
      </td>
      <td style="padding:6px 8px">
        <input class="form-control form-control-sm" name="tag_${t.tag}"
               value="${(current[t.tag] || "").replace(/"/g, "&quot;")}"
               placeholder="Leave blank to skip" style="font-size:12.5px" />
      </td>
    </tr>`).join("");

  Modal.open(
    "Edit Episode ID3 Tags",
    `<div class="form-hint" style="margin-bottom:12px">
      Custom tag values for this episode only. These will be written to the audio file
      when you click <strong>Apply File Updates</strong>.
    </div>
    <div style="overflow-x:auto">
      <table class="id3-table" style="width:100%">
        <thead><tr><th>Tag</th><th>Value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      ${Object.keys(current).length > 0 ? `<button class="btn btn-ghost" id="btn-clear-ep-tags">Clear All</button>` : ""}
      <button class="btn btn-primary" id="btn-save-ep-tags">Save</button>
    </div>`,
    (body) => {
      async function doSave(tags) {
        try {
          const ep = await API.setEpisodeTags(epId, tags);
          Modal.close();
          updateEpisodeRow(ep);
          Toast.success(tags ? "Tags saved — click Apply File Updates to write to file" : "Tags cleared");
          // If this save introduces a pending rename need, inject the "Apply File Updates"
          // button without reloading the page — _wireFileUpdatesBtn is idempotent and will
          // no-op if the button is already present.
          if (tags) _wireFileUpdatesBtn(feedState?.id || feed.id);
        } catch (e) { Toast.error(e.message); }
      }

      body.querySelector("#btn-save-ep-tags").addEventListener("click", () => {
        const tags = {};
        let hasAny = false;
        for (const inp of body.querySelectorAll("input[name^='tag_']")) {
          const tagName = inp.name.slice(4); // strip "tag_"
          if (inp.value.trim()) {
            tags[tagName] = inp.value.trim();
            hasAny = true;
          }
        }
        doSave(hasAny ? tags : null);
      });
      body.querySelector("#btn-clear-ep-tags")?.addEventListener("click", () => doSave(null));
    }
  );
};

window.showSetEpisodeImageModal = function (epId, current) {
  Modal.open(
    "Set Episode Cover Art",
    `<div class="form-group">
      <label class="form-label">Image URL</label>
      <div style="display:flex;gap:10px;align-items:flex-start">
        <img id="ep-art-modal-preview" src="${current}"
             style="width:64px;height:64px;border-radius:8px;object-fit:cover;flex-shrink:0;${current ? "" : "display:none"}"
             onerror="this.style.display='none'" />
        <div style="flex:1">
          <input class="form-control" id="ep-art-input" type="url"
                 value="${current}" placeholder="https://… (leave blank to clear)"
                 autofocus
                 oninput="const p=document.getElementById('ep-art-modal-preview');p.src=this.value;p.style.display=this.value?'':'none'" />
          <div class="form-hint">Overrides the RSS artwork for this episode only.</div>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      ${current ? `<button class="btn btn-ghost" id="btn-clear-ep-art">Clear Override</button>` : ""}
      <button class="btn btn-primary" id="btn-save-ep-art">Save</button>
    </div>`,
    (body) => {
      const input = body.querySelector("#ep-art-input");

      async function doSave(url) {
        try {
          const ep = await API.setEpisodeImage(epId, url || null);
          Modal.close();
          updateEpisodeRow(ep);
          Toast.success(url ? "Episode art updated" : "Episode art cleared");
        } catch (e) { Toast.error(e.message); }
      }

      body.querySelector("#btn-save-ep-art").addEventListener("click", () => doSave(input.value.trim()));
      body.querySelector("#btn-clear-ep-art")?.addEventListener("click", () => doSave(null));
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(input.value.trim()); });
    }
  );
};

window.showSetNumberModal = function (epId, current, locked) {
  Modal.open(
    "Set Episode Number",
    `<div class="form-group">
      <label class="form-label">Episode Number</label>
      <input class="form-control" id="ep-num-input" type="number" min="1"
             value="${current ?? ""}" placeholder="Auto" style="max-width:150px" autofocus />
      <div class="form-hint">Setting a number anchors this episode and renumbers all later episodes from it (e.g. set to 901 → next episode becomes 902, 903, …). Leave blank to clear the override and revert to auto-numbering.</div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      ${locked ? `<button class="btn btn-ghost" id="btn-clear-num">Clear Override</button>` : ""}
      <button class="btn btn-primary" id="btn-save-num">Save</button>
    </div>`,
    (body) => {
      const input = body.querySelector("#ep-num-input");

      async function doSave(num) {
        try {
          const ep = await API.setEpisodeNumber(epId, num);
          Modal.close();
          updateEpisodeRow(ep);
          Toast.success(num == null ? "Number cleared — auto-assigned" : `Episode number set to #${ep.seq_number}`);
        } catch (e) { Toast.error(e.message); }
      }

      body.querySelector("#btn-save-num").addEventListener("click", () => {
        const val = input.value.trim();
        doSave(val ? parseInt(val, 10) : null);
      });
      body.querySelector("#btn-clear-num")?.addEventListener("click", () => doSave(null));
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") body.querySelector("#btn-save-num").click(); });
    }
  );
};

window.queueEpisode = async function (id) {
  try {
    const ep = await API.downloadEpisode(id);
    updateEpisodeRow(ep);
    _monitoredIds.add(id);
    updateStatus();
    Toast.info("Episode queued for download");
    // Decrement cached available counts so the button reflects this episode
    // leaving the downloadable pool, then start the poll for progress tracking.
    const feed = window._epState?.feed;
    if (feed && ep.enclosure_url) {
      feed.available_count = Math.max(0, (feed.available_count || 0) - 1);
      if (!ep.played && !(ep.play_position_seconds > 0)) {
        feed.unplayed_available_count = Math.max(0, (feed.unplayed_available_count || 0) - 1);
      }
      window._feedDetailDL?.refresh();
    }
    window._feedDetailDL?.startPoll();
  } catch (e) { Toast.error(e.message); }
};

window.cancelEpisode = async function (id) {
  try {
    const ep = await API.cancelEpisode(id);
    updateEpisodeRow(ep);
    Toast.info("Download cancelled");
    // Increment cached counts to put this episode back in the downloadable pool.
    const feed = window._epState?.feed;
    if (feed && ep.enclosure_url) {
      feed.available_count = (feed.available_count || 0) + 1;
      if (!ep.played && !(ep.play_position_seconds > 0)) {
        feed.unplayed_available_count = (feed.unplayed_available_count || 0) + 1;
      }
    }
    // Poll will detect count=0 and call restore (which re-fetches for authoritative
    // counts). If no poll is running, restore immediately.
    if (window._feedDLPollTimer) {
      window._feedDetailDL?.refresh();
    } else {
      window._feedDetailDL?.restore();
    }
  } catch (e) { Toast.error(e.message); }
};

window.deleteEpisodeFile = async function (id) {
  if (!confirm("Delete the downloaded file? The episode record will remain.")) return;
  try {
    const ep = await API.deleteEpisodeFile(id);
    updateEpisodeRow(ep);
    Toast.success("File deleted");
    // Episode is now pending — add it back to the downloadable pool.
    const feed = window._epState?.feed;
    if (feed && ep.enclosure_url) {
      feed.available_count = (feed.available_count || 0) + 1;
      if (!ep.played && !(ep.play_position_seconds > 0)) {
        feed.unplayed_available_count = (feed.unplayed_available_count || 0) + 1;
      }
      window._feedDetailDL?.refresh();
    }
  } catch (e) { Toast.error(e.message); }
};

function showRenumberModal(feedId) {
  Modal.open(
    "Renumber All Episodes",
    `<p style="color:var(--text-2);font-size:14px;margin:0 0 14px">
      This will clear all manual episode number overrides and recalculate every episode's
      number from oldest to newest, using embedded episode numbers from the feed or files
      where available to preserve gaps.
    </p>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--text-2);font-size:13px;margin-bottom:8px">
      <input type="checkbox" id="chk-renumber-filenames" checked style="width:15px;height:15px;cursor:pointer" />
      Rename files to reflect updated numbers
    </label>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--text-2);font-size:13px;margin-bottom:14px">
      <input type="checkbox" id="chk-renumber-id3" checked style="width:15px;height:15px;cursor:pointer" />
      Update ID3 tags in files to reflect updated numbers
    </label>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      <button class="btn btn-primary" id="btn-confirm-renumber">Renumber</button>
    </div>`,
    (body) => {
      body.querySelector("#btn-confirm-renumber").addEventListener("click", async () => {
        const btn = body.querySelector("#btn-confirm-renumber");
        const renameFiles = body.querySelector("#chk-renumber-filenames").checked;
        const updateId3   = body.querySelector("#chk-renumber-id3").checked;
        btn.disabled = true;
        btn.textContent = "Renumbering…";
        try {
          await API.renumberFeed(feedId);
          // If files/tags need updating, trigger the apply-file-updates job
          if (renameFiles || updateId3) {
            // Flag outdated files/tags then apply in one pass
            await API.applyFileUpdates(feedId);
          }
          Modal.close();
          Toast.success("Episodes renumbered" + (renameFiles || updateId3 ? " — file updates queued" : ""));
          await _refreshEpisodeList();
        } catch (e) {
          Toast.error(e.message);
          btn.disabled = false;
          btn.textContent = "Renumber";
        }
      });
    }
  );
}

function showUploadFeedXmlModal(feedId, feed) {
  // ── Phase 1: file picker ──────────────────────────────────────────────────
  Modal.open(
    "Upload Feed XML",
    `<div class="form-hint" style="margin-bottom:16px">
      Upload an RSS or XML file to fill in episodes that are missing from the live feed — for example, an older snapshot you have saved locally.
      Only episode records are added or updated; the feed's own title, artwork, and settings are not changed.
    </div>
    <div class="form-group">
      <label class="form-label">RSS / XML file</label>
      <input type="file" id="xml-file-input" accept=".xml,.rss,application/rss+xml,application/xml,text/xml"
             style="font-size:13px;color:var(--text-1)" />
    </div>
    <div id="xml-upload-result" style="font-size:13px;margin-top:8px;display:none"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      <button class="btn btn-primary" id="btn-start-xml-upload">Upload</button>
    </div>`,
    (body) => {
      const btn    = body.querySelector("#btn-start-xml-upload");
      const fileIn = body.querySelector("#xml-file-input");
      const result = body.querySelector("#xml-upload-result");

      btn.addEventListener("click", async () => {
        const file = fileIn.files[0];
        if (!file) { fileIn.focus(); return; }
        btn.disabled = true;
        btn.textContent = "Scanning…";
        result.style.display = "none";
        try {
          const preview = await API.previewFeedXml(feedId, file);
          if (preview.collisions.length === 0) {
            // No conflicts — commit immediately
            _xmlDoCommit(feedId, preview.temp_id, {}, result, btn);
          } else {
            // Walk the user through each collision
            _xmlShowCollisionModal(feedId, preview, result, btn);
          }
        } catch (e) {
          result.style.display = "block";
          result.style.color = "var(--error)";
          result.textContent = e.message;
          btn.disabled = false;
          btn.textContent = "Upload";
        }
      });
    }
  );
}

// ── Collision walkthrough ─────────────────────────────────────────────────────

function _xmlShowCollisionModal(feedId, preview, _resultEl, _uploadBtn) {
  const { temp_id, collisions } = preview;
  const resolutions = {};
  let idx = 0;

  function pick(key, resolution) {
    resolutions[key] = resolution;
    idx++;
    if (idx >= collisions.length) {
      _xmlDoCommitInModal(feedId, temp_id, resolutions);
    } else {
      render();
    }
  }

  function pickWithFlash(cardEl, key, resolution) {
    cardEl.classList.add("xml-rev-card--chosen");
    setTimeout(() => pick(key, resolution), 180);
  }

  function render() {
    const c       = collisions[idx];
    const total   = collisions.length;
    const ex      = c.existing;
    const inc     = c.incoming;

    const exDT  = ex.published_at  ? fmtDateTime(ex.published_at)  : null;
    const incDT = inc.published_at ? fmtDateTime(inc.published_at) : null;
    const dateDiffers = exDT !== incDT;
    const urlDiffers  = (ex.enclosure_url  || "") !== (inc.enclosure_url  || "");
    const durDiffers  = (ex.duration       || "") !== (inc.duration       || "");

    const exDescRaw  = _xmlStripHtml(ex.description  || "");
    const incDescRaw = _xmlStripHtml(inc.description || "");
    const descDiffers = (exDescRaw || incDescRaw) && exDescRaw !== incDescRaw;

    // Build field rows for one card side.  Only shows fields that differ
    // (plus status, which is relevant regardless).
    function cardFields(ep, isExisting) {
      const dateVal = isExisting ? exDT : incDT;
      let html = "";

      if (isExisting && ep.status) {
        html += `<div class="xml-rev-field">
          <span class="xml-rev-label">Status</span>
          <span>${statusBadge(ep.status)}</span>
        </div>`;
      }

      html += `<div class="xml-rev-field${dateDiffers ? " xml-rev-differs" : ""}">
        <span class="xml-rev-label">Date</span>
        <span class="xml-rev-value">${escHTML(dateVal || "—")}</span>
      </div>`;

      if (urlDiffers) {
        html += `<div class="xml-rev-field xml-rev-differs">
          <span class="xml-rev-label">Audio URL</span>
          <span class="xml-rev-value xml-rev-mono">${escHTML(_xmlShortUrl(ep.enclosure_url || "—"))}</span>
        </div>`;
      }

      if (durDiffers && (ep.duration || (isExisting ? inc.duration : ex.duration))) {
        html += `<div class="xml-rev-field xml-rev-differs">
          <span class="xml-rev-label">Duration</span>
          <span class="xml-rev-value">${escHTML(ep.duration || "—")}</span>
        </div>`;
      }

      return html;
    }

    // Description diff section
    let descSection = "";
    if (descDiffers) {
      const diff    = _xmlWordDiff(_xmlLimitWords(exDescRaw, 120), _xmlLimitWords(incDescRaw, 120));
      const exRend  = _xmlRenderDiff(diff, "a");
      const incRend = _xmlRenderDiff(diff, "b");
      descSection = `
        <div class="xml-rev-desc-section">
          <div class="xml-rev-desc-hdr">Description differences</div>
          <div class="xml-rev-desc-cols">
            <div class="xml-rev-desc-panel">
              <div class="xml-rev-desc-side-hdr">In app</div>
              <div class="xml-rev-desc-text">${exRend}</div>
            </div>
            <div class="xml-rev-desc-panel">
              <div class="xml-rev-desc-side-hdr">In file</div>
              <div class="xml-rev-desc-text">${incRend}</div>
            </div>
          </div>
        </div>`;
    }

    // Progress pips
    const pips = collisions.map((_, i) => {
      const cls = i < idx ? "xml-rev-pip xml-rev-pip--done"
                : i === idx ? "xml-rev-pip xml-rev-pip--active"
                : "xml-rev-pip";
      return `<span class="${cls}"></span>`;
    }).join("");

    document.getElementById("modal-title").textContent = `Review Import Conflict`;
    document.getElementById("modal-body").innerHTML = `
      <div class="xml-rev-progress">
        <span class="xml-rev-progress-text">${idx + 1} of ${total}</span>
        <div class="xml-rev-pips">${pips}</div>
      </div>
      <p class="xml-rev-ep-title">${escHTML(inc.title || ex.title || "Untitled Episode")}</p>
      <p class="xml-rev-subhead">Click the version you want to keep.</p>
      <div class="xml-rev-cards">
        <div class="xml-rev-card" id="xml-card-ex" tabindex="0" role="button">
          <div class="xml-rev-card-hdr">Already in app</div>
          <div class="xml-rev-fields">${cardFields(ex, true)}</div>
          <div class="xml-rev-card-footer">Keep this version</div>
        </div>
        <div class="xml-rev-card" id="xml-card-inc" tabindex="0" role="button">
          <div class="xml-rev-card-hdr">In imported file</div>
          <div class="xml-rev-fields">${cardFields(inc, false)}</div>
          <div class="xml-rev-card-footer">Keep this version</div>
        </div>
      </div>
      ${descSection}
      <div class="xml-rev-both-row">
        <button class="btn btn-ghost btn-sm" id="xml-keep-both-btn">Keep Both — imported copy tagged [import-dupe]</button>
      </div>
      <div class="xml-rev-bulk-row">
        <button class="btn btn-ghost btn-sm" id="xml-omit-all-btn">Omit All Remaining</button>
        <button class="btn btn-ghost btn-sm" id="xml-keep-all-btn">Keep All Remaining</button>
      </div>`;

    const exCard  = document.getElementById("xml-card-ex");
    const incCard = document.getElementById("xml-card-inc");
    exCard.addEventListener("click",   () => pickWithFlash(exCard,  c.key, "keep_existing"));
    incCard.addEventListener("click",  () => pickWithFlash(incCard, c.key, "use_imported"));
    exCard.addEventListener("keydown",  (e) => { if (e.key === "Enter" || e.key === " ") exCard.click(); });
    incCard.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") incCard.click(); });

    document.getElementById("xml-keep-both-btn").onclick = () => pick(c.key, "keep_both");
    document.getElementById("xml-omit-all-btn").onclick  = () => {
      for (let i = idx; i < collisions.length; i++) resolutions[collisions[i].key] = "keep_existing";
      _xmlDoCommitInModal(feedId, temp_id, resolutions);
    };
    document.getElementById("xml-keep-all-btn").onclick  = () => {
      for (let i = idx; i < collisions.length; i++) resolutions[collisions[i].key] = "keep_both";
      _xmlDoCommitInModal(feedId, temp_id, resolutions);
    };
  }

  document.getElementById("modal").classList.add("modal-wide");
  render();
}

// ── XML diff helpers ──────────────────────────────────────────────────────────

function _xmlStripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || "").replace(/\s+/g, " ").trim();
}

function _xmlLimitWords(text, max) {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= max ? text : words.slice(0, max).join(" ") + "…";
}

function _xmlShortUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? "…" + u.pathname.slice(-32) : u.pathname;
    return u.hostname + path;
  } catch {
    return url.length > 55 ? url.slice(0, 32) + "…" + url.slice(-15) : url;
  }
}

function _xmlWordDiff(textA, textB) {
  const wa = textA.split(/\s+/).filter(Boolean);
  const wb = textB.split(/\s+/).filter(Boolean);
  const m = wa.length, n = wb.length;
  // Full DP table for traceback; cap at 200 words each for performance
  const MA = Math.min(m, 200), NA = Math.min(n, 200);
  const dp = Array.from({length: MA + 1}, () => new Uint16Array(NA + 1));
  for (let i = MA - 1; i >= 0; i--) {
    for (let j = NA - 1; j >= 0; j--) {
      dp[i][j] = wa[i] === wb[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
    }
  }
  const ra = [], rb = [];
  let i = 0, j = 0;
  while (i < MA || j < NA) {
    if (i < MA && j < NA && wa[i] === wb[j]) {
      ra.push({t: wa[i], s: "="}); rb.push({t: wb[j], s: "="}); i++; j++;
    } else if (j < NA && (i >= MA || dp[i][j+1] >= dp[i+1][j])) {
      rb.push({t: wb[j], s: "+"}); j++;
    } else {
      ra.push({t: wa[i], s: "-"}); i++;
    }
  }
  return {a: ra, b: rb};
}

function _xmlRenderDiff(diff, side) {
  return diff[side].map(tok => {
    if (tok.s === "=") return escHTML(tok.t);
    const cls = tok.s === "-" ? "xml-diff-del" : "xml-diff-add";
    return `<mark class="${cls}">${escHTML(tok.t)}</mark>`;
  }).join(" ");
}

async function _xmlDoCommitInModal(feedId, tempId, resolutions) {
  document.getElementById("modal-title").textContent = "Importing…";
  document.getElementById("modal-body").innerHTML = `<p style="color:var(--text-2);font-size:13px">Applying your choices…</p>`;
  try {
    const r = await API.commitFeedXml(feedId, tempId, resolutions);
    _xmlHandleResult(feedId, r);
  } catch (e) {
    document.getElementById("modal-body").innerHTML = `<p style="color:var(--error);font-size:13px">${escHTML(e.message)}</p>`;
  }
}

async function _xmlDoCommit(feedId, tempId, resolutions, resultEl, uploadBtn) {
  try {
    const r = await API.commitFeedXml(feedId, tempId, resolutions);
    _xmlHandleResult(feedId, r);
  } catch (e) {
    resultEl.style.display = "block";
    resultEl.style.color = "var(--error)";
    resultEl.textContent = e.message;
    uploadBtn.disabled = false;
    uploadBtn.textContent = "Upload";
  }
}

async function _xmlHandleResult(feedId, r) {
  const skippedNote = r.skipped > 0 ? ` · ${r.skipped} duplicate${r.skipped !== 1 ? "s" : ""} excluded` : "";
  Toast.show(`${r.added} episode${r.added !== 1 ? "s" : ""} added${skippedNote}`, "success", 6000);

  if (r.files_to_rename > 0) {
    document.getElementById("modal-title").textContent = "Files Need Renaming";
    document.getElementById("modal-body").innerHTML = `
      <p style="margin-bottom:12px;color:var(--text-1);font-weight:500">
        ${r.files_to_rename} downloaded file${r.files_to_rename !== 1 ? "s have" : " has"} updated episode ordering.
      </p>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="btn-xml-rename2">Rename Files</button>
        <button class="btn btn-ghost btn-sm" id="btn-xml-keep2">Keep as is</button>
      </div>`;
    document.getElementById("btn-xml-rename2").addEventListener("click", async () => {
      try { await API.applyFileUpdates(feedId); Toast.success("Files renamed successfully"); } catch (e) { Toast.error(e.message); }
      Modal.close(); await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]);
    });
    document.getElementById("btn-xml-keep2").addEventListener("click", async () => {
      Modal.close(); await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]);
    });
  } else {
    Modal.close();
    await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]);
  }
}

function showImportFilesModal(feedId, feed) {
  const defaultDir = feed?.podcast_folder || "";

  function _srcTag(source) {
    if (!source) return "";
    const labels = { sidecar: "XML", id3: "ID3", filename: "file", folder: "folder" };
    return `<span class="import-source-tag src-${source}">${labels[source] || source}</span>`;
  }

  function _confBadge(confidence) {
    if (confidence == null) return "";
    const pct = Math.round(confidence * 100);
    const cls = pct >= 70 ? "badge-success" : pct >= 40 ? "badge-warning" : "badge-error";
    return `<span class="badge ${cls}" title="Match confidence">${pct}%</span>`;
  }

  // ── Step 1: folder picker ──────────────────────────────────────
  function showStep1(errorMsg) {
    Modal.open(
      "Import Files",
      `<p style="font-size:13px;color:var(--text-2);margin:0 0 12px;line-height:1.5">
        Select the folder containing your audio files. All subfolders will be scanned.
      </p>
      <div class="form-group">
        <div style="display:flex;gap:8px">
          <input class="form-control" id="import-dir-input" type="text"
                 value="${defaultDir}" placeholder="/path/to/audio/files"
                 style="font-family:monospace;flex:1" autofocus />
          <button class="btn btn-ghost" type="button" id="btn-dir-go">Go \u2192</button>
        </div>
        <div class="form-hint">Type a path and press <strong>Go \u2192</strong>, or click folders below to navigate.</div>
      </div>
      <div id="import-dir-browser" class="import-dir-browser"></div>
      <div id="import-step1-error" style="color:var(--error);font-size:13px;margin-top:8px;${errorMsg ? "" : "display:none"}">${errorMsg || ""}</div>
      <div class="modal-actions" style="margin-top:12px">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" id="btn-scan-dir">Scan This Folder</button>
      </div>`,
      (body) => {
        const dirInput = body.querySelector("#import-dir-input");
        const errEl    = body.querySelector("#import-step1-error");
        const scanBtn  = body.querySelector("#btn-scan-dir");
        const goBtn    = body.querySelector("#btn-dir-go");

        // Load the directory browser
        if (defaultDir) {
          DirBrowser.load("import-dir-browser", "import-dir-input", defaultDir);
        } else {
          DirBrowser.load("import-dir-browser", "import-dir-input", "/");
        }

        goBtn.addEventListener("click", () => {
          DirBrowser.load("import-dir-browser", "import-dir-input", dirInput.value.trim() || "/");
        });
        dirInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            DirBrowser.load("import-dir-browser", "import-dir-input", dirInput.value.trim() || "/");
          }
        });

        async function doScan() {
          const dir = dirInput.value.trim();
          if (!dir) { dirInput.focus(); return; }
          scanBtn.disabled = true;
          scanBtn.textContent = "Scanning\u2026";
          errEl.style.display = "none";
          try {
            const preview = await API.previewImport(feedId, dir);
            showStep2Summary(dir, preview);
          } catch (e) {
            errEl.textContent = e.message;
            errEl.style.display = "block";
            scanBtn.disabled = false;
            scanBtn.textContent = "Scan This Folder";
          }
        }
        scanBtn.addEventListener("click", doScan);
      }
    );
  }

  // ── Step 2: analysis summary ───────────────────────────────────
  function showStep2Summary(dir, preview) {
    const files       = preview.files || [];
    const analysis    = preview.folder_analysis || {};
    const actionFiles = files.filter(f => !f.already_registered);
    const nMatched    = actionFiles.filter(f => f.match).length;
    const nNew        = actionFiles.filter(f => !f.match).length;
    const nRegistered = files.filter(f => f.already_registered).length;

    // Confidence analysis
    const matchConfs = actionFiles.filter(f => f.match).map(f => f.match.confidence);
    const minConf = matchConfs.length ? Math.min(...matchConfs) : 0;
    const allHighConf = matchConfs.length > 0 && minConf >= 0.70 && nNew === 0;
    const hasLowConf = matchConfs.some(c => c < 0.40);

    // Folder type banner
    let bannerHtml = "";
    const ft = analysis.type;
    if (ft === "castcharm") {
      bannerHtml = `<div class="import-analysis-banner banner-castcharm">
        CastCharm folder detected \u2014 XML sidecars found, matching will be very accurate.</div>`;
    } else if (ft === "year_organized") {
      bannerHtml = `<div class="import-analysis-banner banner-year">
        Year-organized folder detected \u2014 dates extracted from folder names.</div>`;
    } else if (ft === "season_organized") {
      bannerHtml = `<div class="import-analysis-banner banner-season">
        Season-organized folder detected \u2014 season numbers extracted from folder names.</div>`;
    }

    // Confidence text
    let confText = "";
    if (allHighConf) {
      confText = `<p style="font-size:13px;color:var(--success);margin:0 0 4px;line-height:1.5">All matches are high confidence. You can import directly or review details first.</p>`;
    } else if (hasLowConf) {
      confText = `<p style="font-size:13px;color:var(--warning);margin:0 0 4px;line-height:1.5">Some matches have low confidence \u2014 review recommended before importing.</p>`;
    } else if (nMatched > 0) {
      confText = `<p style="font-size:13px;color:var(--text-2);margin:0 0 4px;line-height:1.5">Review the matched files to confirm they look correct.</p>`;
    }

    // If everything is new or nothing to do, skip summary and go straight to review
    if (nMatched === 0 && nNew > 0) {
      showStep3Review(dir, preview);
      return;
    }

    const subfolderNote = analysis.subfolder_count > 0
      ? ` across ${analysis.subfolder_count} subfolder${analysis.subfolder_count !== 1 ? "s" : ""}`
      : "";

    // Nothing to import?
    if (actionFiles.length === 0 && nRegistered > 0) {
      Modal.open(
        "Import Files \u2014 Nothing to Do",
        `<p style="font-size:13px;color:var(--text-2);line-height:1.5;margin-bottom:16px">
          All ${nRegistered} file${nRegistered !== 1 ? "s" : ""} in this folder are already imported.
        </p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="btn-import-back">\u2190 Back</button>
          <button class="btn btn-primary" onclick="Modal.close()">Done</button>
        </div>`,
        (body) => {
          body.querySelector("#btn-import-back").addEventListener("click", () => showStep1());
        }
      );
      return;
    }

    if (files.length === 0) {
      Modal.open(
        "Import Files \u2014 No Files Found",
        `<p style="text-align:center;color:var(--text-2);padding:24px 0">No audio files found in that directory.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="btn-import-back">\u2190 Back</button>
        </div>`,
        (body) => {
          body.querySelector("#btn-import-back").addEventListener("click", () => showStep1());
        }
      );
      return;
    }

    Modal.open(
      "Import Files \u2014 Analysis",
      `<div style="font-size:13px;color:var(--text-3);margin-bottom:10px;font-family:monospace;word-break:break-all">${escHTML(dir)}</div>
      <p style="font-size:13px;color:var(--text-2);margin:0 0 12px;line-height:1.5">
        Found <strong>${preview.total_files}</strong> audio file${preview.total_files !== 1 ? "s" : ""}${subfolderNote}.
      </p>
      ${bannerHtml}
      <div class="import-stat-cards">
        ${nMatched > 0 ? `<div class="import-stat-card">
          <div class="stat-num" style="color:var(--warning)">${nMatched}</div>
          <div class="stat-label">matched</div>
        </div>` : ""}
        ${nNew > 0 ? `<div class="import-stat-card">
          <div class="stat-num" style="color:var(--primary)">${nNew}</div>
          <div class="stat-label">new</div>
        </div>` : ""}
        ${nRegistered > 0 ? `<div class="import-stat-card">
          <div class="stat-num" style="color:var(--success)">${nRegistered}</div>
          <div class="stat-label">already imported</div>
        </div>` : ""}
      </div>
      ${confText}
      <div class="modal-actions" style="margin-top:16px">
        <button class="btn btn-ghost" id="btn-import-back">\u2190 Back</button>
        <button class="btn btn-ghost" id="btn-review-details">Review Details</button>
        ${allHighConf ? `<button class="btn btn-primary" id="btn-import-all">Import All \u2192</button>` : `<button class="btn btn-primary" id="btn-review-details-primary">Review & Import</button>`}
      </div>`,
      (body) => {
        body.querySelector("#btn-import-back").addEventListener("click", () => showStep1());
        body.querySelector("#btn-review-details")?.addEventListener("click", () => showStep3Review(dir, preview));

        const primaryReview = body.querySelector("#btn-review-details-primary");
        if (primaryReview) primaryReview.addEventListener("click", () => showStep3Review(dir, preview));

        const importAllBtn = body.querySelector("#btn-import-all");
        if (importAllBtn) {
          importAllBtn.addEventListener("click", async () => {
            importAllBtn.disabled = true;
            importAllBtn.textContent = "Importing\u2026";
            try {
              const items = actionFiles.map(f => ({
                path: f.path,
                skip: false,
                episode_id: f.match?.episode_id || null,
              }));
              await API.commitImport(feedId, items);
              Modal.close();
              Toast.success("Import started \u2014 check the banner above the episode list for progress.");
              _pollImportBanner(feedId);
            } catch (e) {
              Toast.error(e.message);
              importAllBtn.disabled = false;
              importAllBtn.textContent = "Import All \u2192";
            }
          });
        }
      }
    );
  }

  // ── Step 3: review table ───────────────────────────────────────
  async function showStep3Review(dir, preview) {
    let allEpisodes = [];
    try {
      const eps = await API.getFeedEpisodes(feedId, 5000, 0, "asc");
      allEpisodes = eps.items || eps || [];
    } catch (_) {}

    const files       = preview.files || [];
    const actionFiles = files.filter(f => !f.already_registered);
    const regFiles    = files.filter(f => f.already_registered);
    const nRegistered = regFiles.length;

    // Categorize for filter tabs
    const needsReview = actionFiles.filter(f => f.match && f.match.confidence < 0.70);
    const highConf    = actionFiles.filter(f => f.match && f.match.confidence >= 0.70);
    const newEps      = actionFiles.filter(f => !f.match);

    // Sort: low confidence first, then new, then high confidence
    const sortedFiles = [...needsReview, ...newEps, ...highConf];

    const thTd = "position:sticky;top:0;padding:7px 10px;font-weight:600;background:var(--bg-3);box-shadow:0 1px 0 var(--border);z-index:1";

    function buildRow(f, i) {
      const matchId   = f.match?.episode_id ?? "";
      const conf      = f.match?.confidence ?? null;
      const isMatched = !!f.match;
      const src       = f.metadata_sources || {};
      const statusDot = isMatched
        ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--warning);flex-shrink:0" title="Matched to existing episode"></span>`
        : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--primary);flex-shrink:0" title="New episode"></span>`;
      const infoParts = [];
      if (f.date) infoParts.push(f.date + (f.date_is_approximate ? " ~" : "") + _srcTag(src.date));
      if (f.episode_number != null) infoParts.push(`ep. ${f.episode_number}` + _srcTag(src.episode_number));
      if (f.season_number != null) infoParts.push(`S${f.season_number}` + _srcTag(src.season_number));
      if (f.duration) infoParts.push(f.duration);
      const infoLine = infoParts.join(" \u00B7 ");
      const titleSrc = _srcTag(src.title);

      return `<tr id="import-row-${i}" data-path="${f.path.replace(/"/g, "&quot;")}"
        data-conf="${conf ?? -1}" data-has-match="${isMatched ? 1 : 0}">
        <td style="padding:7px 10px;font-size:12px;max-width:220px">
          <div style="display:flex;align-items:flex-start;gap:7px">
            ${statusDot}
            <div style="min-width:0">
              <div style="word-break:break-all;line-height:1.3">${f.filename}</div>
              ${f.title && f.title !== f.filename.replace(/\.[^.]+$/, "")
                ? `<div style="color:var(--text-3);font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${f.title.replace(/"/g, "&quot;")}">${f.title}${titleSrc}</div>`
                : ""}
              ${infoLine ? `<div style="color:var(--text-3);font-size:11px;margin-top:1px">${infoLine}</div>` : ""}
            </div>
          </div>
        </td>
        <td style="padding:7px 10px">
          <select class="form-control import-ep-select" style="font-size:12px;padding:3px 6px;width:100%" data-row="${i}">
            <option value="">\u2014 Create new episode \u2014</option>
            ${allEpisodes.map(ep => {
              const label = ep.title ? `#${ep.seq_number || "?"} \u2014 ${ep.title.substring(0, 55)}` : `Episode ${ep.id}`;
              return `<option value="${ep.id}" ${ep.id == matchId ? "selected" : ""}>${label}</option>`;
            }).join("")}
          </select>
          ${isMatched ? `<div class="import-conf-cell" style="margin-top:4px">${_confBadge(conf)}</div>` : ""}
        </td>
        <td style="padding:7px 10px;text-align:center;white-space:nowrap">
          <label style="cursor:pointer;display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--text-2)">
            <input type="checkbox" class="import-skip-chk" data-row="${i}" style="width:14px;height:14px" />
            Skip
          </label>
        </td>
      </tr>`;
    }

    const rowsHtml = sortedFiles.map((f, i) => buildRow(f, i)).join("");

    // Already-imported collapsible section
    const regSection = nRegistered > 0 ? `
      <details style="margin-top:10px">
        <summary style="font-size:12px;color:var(--text-3);cursor:pointer;user-select:none;padding:4px 0">
          ${nRegistered} file${nRegistered !== 1 ? "s" : ""} already imported (no action needed)
        </summary>
        <div style="margin-top:6px;border:1px solid var(--border);border-radius:6px;overflow:hidden">
          ${regFiles.map(f => `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-3)">
              <span style="color:var(--success)">\u2713</span>
              <span style="word-break:break-all">${f.filename}</span>
              ${f.match?.episode_title ? `<span style="margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;flex-shrink:0" title="${f.match.episode_title.replace(/"/g, "&quot;")}">\u2192 ${f.match.episode_title}</span>` : ""}
            </div>`).join("")}
        </div>
      </details>` : "";

    const importCount = actionFiles.length;
    const importBtnLabel = importCount === 0
      ? "Nothing to import"
      : `Import ${importCount} file${importCount !== 1 ? "s" : ""}`;

    // Filter tabs
    const tabDefs = [
      { id: "all", label: `All (${actionFiles.length})`, filter: () => true },
      needsReview.length > 0 ? { id: "review", label: `Needs Review (${needsReview.length})`, filter: (tr) => tr.dataset.hasMatch === "1" && parseFloat(tr.dataset.conf) < 0.70 } : null,
      highConf.length > 0 ? { id: "high", label: `High Confidence (${highConf.length})`, filter: (tr) => tr.dataset.hasMatch === "1" && parseFloat(tr.dataset.conf) >= 0.70 } : null,
      newEps.length > 0 ? { id: "new", label: `New (${newEps.length})`, filter: (tr) => tr.dataset.hasMatch === "0" } : null,
    ].filter(Boolean);

    const defaultTab = needsReview.length > 0 ? "review" : "all";
    const tabsHtml = tabDefs.map(t =>
      `<span class="import-filter-tab${t.id === defaultTab ? " active" : ""}" data-tab="${t.id}">${t.label}</span>`
    ).join("");

    // Bulk action buttons
    const bulkHtml = `<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
      ${newEps.length > 0 ? `<button class="btn btn-ghost" id="btn-skip-unmatched" style="font-size:11px;padding:4px 10px">Skip all unmatched</button>` : ""}
      ${needsReview.length > 0 ? `<button class="btn btn-ghost" id="btn-skip-low-conf" style="font-size:11px;padding:4px 10px">Skip low confidence</button>` : ""}
    </div>`;

    const tableHtml = actionFiles.length === 0 ? "" :
      `<div style="overflow-x:auto;max-height:min(52vh,500px);overflow-y:auto;border:1px solid var(--border);border-radius:6px;margin-top:6px">
        <table style="width:100%;border-collapse:separate;border-spacing:0;font-size:13px">
          <thead>
            <tr>
              <th style="${thTd};text-align:left">File</th>
              <th style="${thTd};text-align:left">Link to episode</th>
              <th style="${thTd};text-align:center;white-space:nowrap">Skip?</th>
            </tr>
          </thead>
          <tbody id="import-tbody">${rowsHtml}</tbody>
        </table>
      </div>`;

    Modal.open(
      `Review & Import \u2014 ${files.length} file${files.length !== 1 ? "s" : ""} found`,
      `<div class="import-filter-tabs">${tabsHtml}</div>
      ${bulkHtml}
      ${tableHtml}
      ${regSection}
      <div id="import-step3-error" style="color:var(--error);font-size:13px;display:none;margin-top:10px"></div>
      <div class="modal-actions" style="margin-top:12px">
        <button class="btn btn-ghost" id="btn-import-back">\u2190 Back</button>
        <button class="btn btn-primary" id="btn-commit-import" ${importCount === 0 ? "disabled" : ""}>
          ${importBtnLabel}
        </button>
      </div>`,
      (body) => {
        document.getElementById("modal").classList.add("modal-wide");
        body.querySelector("#btn-import-back").addEventListener("click", () => showStep2Summary(dir, preview));

        // Filter tabs
        const filterMap = {};
        tabDefs.forEach(t => { filterMap[t.id] = t.filter; });
        body.querySelectorAll(".import-filter-tab").forEach(tab => {
          tab.addEventListener("click", () => {
            body.querySelectorAll(".import-filter-tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            const filterFn = filterMap[tab.dataset.tab];
            body.querySelectorAll("#import-tbody tr").forEach(tr => {
              tr.style.display = filterFn(tr) ? "" : "none";
            });
          });
        });

        // Apply default tab filter
        if (defaultTab !== "all") {
          const filterFn = filterMap[defaultTab];
          body.querySelectorAll("#import-tbody tr").forEach(tr => {
            tr.style.display = filterFn(tr) ? "" : "none";
          });
        }

        // Sync episode option availability across all dropdowns
        function syncEpisodeOptions() {
          const selects = [...body.querySelectorAll(".import-ep-select")];
          const claimed = new Set(selects.map(s => s.value).filter(v => v !== ""));
          selects.forEach(sel => {
            for (const opt of sel.options) {
              if (opt.value === "") continue;
              opt.disabled = claimed.has(opt.value) && opt.value !== sel.value;
            }
          });
        }

        body.querySelectorAll(".import-ep-select").forEach(sel => {
          sel.addEventListener("change", () => {
            const row = document.getElementById(`import-row-${sel.dataset.row}`);
            const cell = row?.querySelector(".import-conf-cell");
            if (cell) cell.innerHTML = "";
            syncEpisodeOptions();
          });
        });
        syncEpisodeOptions();

        const commitBtn = body.querySelector("#btn-commit-import");
        const errEl     = body.querySelector("#import-step3-error");

        function updateImportBtn() {
          const n = body.querySelectorAll("#import-tbody .import-skip-chk:not(:checked)").length;
          commitBtn.disabled = n === 0;
          commitBtn.textContent = n === 0 ? "Nothing to import" : `Import ${n} file${n !== 1 ? "s" : ""}`;
        }

        body.querySelectorAll(".import-skip-chk").forEach(chk => {
          chk.addEventListener("change", updateImportBtn);
        });

        // Bulk skip buttons
        body.querySelector("#btn-skip-unmatched")?.addEventListener("click", () => {
          body.querySelectorAll("#import-tbody tr").forEach(tr => {
            if (tr.dataset.hasMatch === "0") {
              const chk = tr.querySelector(".import-skip-chk");
              if (chk) chk.checked = true;
            }
          });
          updateImportBtn();
        });
        body.querySelector("#btn-skip-low-conf")?.addEventListener("click", () => {
          body.querySelectorAll("#import-tbody tr").forEach(tr => {
            if (tr.dataset.hasMatch === "1" && parseFloat(tr.dataset.conf) < 0.40) {
              const chk = tr.querySelector(".import-skip-chk");
              if (chk) chk.checked = true;
            }
          });
          updateImportBtn();
        });

        commitBtn.addEventListener("click", async () => {
          const items = [];
          body.querySelectorAll("#import-tbody tr").forEach(row => {
            if (row.querySelector(".import-skip-chk")?.checked) return;
            const epIdVal = row.querySelector(".import-ep-select")?.value || "";
            items.push({
              path:       row.dataset.path,
              skip:       false,
              episode_id: epIdVal ? parseInt(epIdVal, 10) : null,
            });
          });

          commitBtn.disabled = true;
          commitBtn.textContent = "Importing\u2026";
          errEl.style.display = "none";
          try {
            await API.commitImport(feedId, items);
            Modal.close();
            Toast.success("Import started \u2014 check the banner above the episode list for progress.");
            _pollImportBanner(feedId);
          } catch (e) {
            errEl.textContent = e.message;
            errEl.style.display = "block";
            updateImportBtn();
          }
        });
      }
    );
  }

  showStep1();
}

function updateEpisodeRow(ep) {
  const row = document.getElementById(`ep-${ep.id}`);
  if (!row) return;
  const feedState = window._epState?.feed || {};
  // When an episode is newly hidden, fade to the dimmed opacity before replacing
  // the row — avoids the jarring instant-disappearance effect.
  if (ep.hidden && row.dataset.hidden !== "1") {
    row.style.transition = "opacity 0.25s ease";
    row.style.opacity = "0.45";
    setTimeout(() => { row.outerHTML = episodeRow(ep, feedState); Player.syncPlayBtns(); }, 260);
  } else {
    row.outerHTML = episodeRow(ep, feedState);
    Player.syncPlayBtns();
  }
}

window.unlinkSupplementaryFeed = async function (primaryId, subId) {
  if (!confirm("Unlink this supplementary feed? It will remain as an independent feed but its episodes will no longer share a folder.")) return;
  try {
    await API.removeSupplementary(primaryId, subId);
    Toast.success("Supplementary feed unlinked");
    const row = document.getElementById(`sf-${subId}`);
    if (row) row.remove();
    const listEl = document.getElementById("supplementary-feed-list");
    if (listEl && !listEl.querySelector(".episode-item")) {
      listEl.innerHTML = `<div style="color:var(--text-3);font-size:13px;margin-bottom:12px">No supplementary feeds linked yet.</div>`;
    }
    const badge = document.querySelector("#supplementary-panel .panel-header .badge");
    if (badge) {
      const remaining = document.querySelectorAll("#supplementary-feed-list .episode-item").length;
      badge.textContent = remaining;
      if (!remaining) badge.remove();
    }
  } catch (e) { Toast.error(e.message); }
};

function showDeleteFeedModal(feed) {
  Modal.open(
    "Delete Feed",
    `<p style="color:var(--text-2);margin-bottom:16px">
      Are you sure you want to delete <strong>${feed.title || feed.url}</strong>?
      All episode records will be removed from the database.
    </p>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--text-2)">
      <input type="checkbox" id="chk-delete-files" style="width:16px;height:16px;cursor:pointer;flex-shrink:0" />
      Also delete all downloaded files, cover art, and the podcast folder from disk
    </label>
    ${feed.downloaded_count > 0 ? `<div style="color:var(--error);font-size:12px;margin:6px 0 20px 24px">${feed.downloaded_count} audio file${feed.downloaded_count !== 1 ? "s" : ""} will be removed</div>` : `<div style="margin-bottom:20px"></div>`}
    <div id="delete-error"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      <button class="btn btn-danger" id="btn-confirm-delete">Delete Feed</button>
    </div>`,
    (body) => {
      body.querySelector("#btn-confirm-delete").addEventListener("click", async () => {
        const deleteFiles = body.querySelector("#chk-delete-files").checked;
        try {
          await API.request("DELETE", `/api/feeds/${feed.id}?delete_files=${deleteFiles}`);
          Modal.close();
          Toast.success(deleteFiles ? "Feed and files deleted" : "Feed deleted");
          Router.navigate("/feeds");
        } catch (e) {
          const errDiv = body.querySelector("#delete-error");
          errDiv.innerHTML = `
            <div style="color:var(--error);margin-bottom:10px;font-size:13px">⚠ ${e.message}</div>
            <p style="color:var(--text-2);font-size:13px;margin-bottom:12px">
              Force delete will remove the feed directly from the database,
              bypassing normal checks. This cannot be undone.
            </p>
            <button class="btn btn-danger btn-sm" id="btn-force-delete">Force Delete</button>`;
          body.querySelector("#btn-force-delete").addEventListener("click", async () => {
            try {
              await API.request("DELETE", `/api/feeds/${feed.id}?delete_files=${deleteFiles}&force=true`);
              Modal.close();
              Toast.success("Feed force-deleted");
              Router.navigate("/feeds");
            } catch (e2) { Toast.error(`Force delete failed: ${e2.message}`); }
          });
        }
      });
    }
  );
}
