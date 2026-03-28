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
      resumeAt: 0,
    });
  } catch (e) { Toast.error(e.message); }
};

window.toggleEpPlayed = async function (epId) {
  try {
    const ep = await API.togglePlayed(epId);
    if (!ep.played) { await API.updateProgress(epId, 0); ep.play_position_seconds = 0; }
    if (typeof updateEpisodeRow === "function") updateEpisodeRow(ep);
    Toast.info(ep.played ? "Marked as played" : "Marked as unplayed");
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
    ${updated.last_error ? `<span class="feed-stat-sep">·</span><span class="feed-stat" style="color:var(--error)">feed error</span>` : ""}
  `;
  const lastChecked = document.querySelector(".feed-last-checked");
  if (lastChecked) {
    lastChecked.textContent = updated.last_checked
      ? `Last checked ${new Date(updated.last_checked + "Z").toLocaleString(undefined, {year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"})}`
      : "Never checked";
  }
  return updated;
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
function _syncDownloadButtons(ep, delta) {
  const state = window._epState;
  if (!state?.feed) return;
  if (ep.status !== "pending" && ep.status !== "failed") return;

  if (!ep.played) {
    state.feed.unplayed_available_count = Math.max(0, (state.feed.unplayed_available_count || 0) - delta);
  }
  state.feed.available_count = Math.max(0, (state.feed.available_count || 0) - delta);

  const n     = state.feed.unplayed_available_count;
  const total = state.feed.available_count;
  const relabel = (id, val) => {
    const btn = document.getElementById(id);
    if (btn) btn.innerHTML = btn.innerHTML.replace(/\(\d+\)/, `(${val})`);
  };
  relabel("btn-dl-unplayed-feed",    n);
  relabel("btn-dl-unplayed-feed-dd", n);
  relabel("btn-dl-all-feed",         total);
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
  // Cancel any in-flight sync poll from a previous view
  if (window._syncPollTimer) {
    clearInterval(window._syncPollTimer);
    window._syncPollTimer = null;
  }

  const id = Number(feedId);
  const [feed, id3Tags, rssSources, settings, supplementary] = await Promise.all([
    API.getFeed(id),
    API.getID3Tags(),
    API.getFeedRSSSources(id),
    API.getSettings(),
    API.getSupplementary(id),
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
              ? `Last checked ${new Date(feed.last_checked + "Z").toLocaleString(undefined, {year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"})}`
              : "Never checked"}
          </div>
          <div class="feed-header-stats">
            <span class="feed-stat">${feed.episode_count} episode${feed.episode_count !== 1 ? "s" : ""}</span>
            <span class="feed-stat-sep">·</span>
            <span class="feed-stat">${feed.downloaded_count} downloaded</span>
            ${feed.available_count > 0 ? `<span class="feed-stat-sep">·</span><span class="feed-stat">${feed.available_count} not downloaded</span>` : ""}
            ${feed.unplayed_count > 0 ? `<span class="feed-stat-sep">·</span><span class="feed-stat">${feed.unplayed_count} unplayed</span>` : ""}
            ${feed.last_error ? `<span class="feed-stat-sep">·</span><span class="feed-stat" style="color:var(--error)">feed error</span>` : ""}
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
              <label class="form-label">Keep Latest Episodes</label>
              <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;color:var(--text-2)">
                <input type="checkbox" id="chk-feed-keep-latest" style="width:16px;height:16px;cursor:pointer"
                       ${feed.keep_latest ? "checked" : ""}
                       onchange="document.getElementById('feed-keep-latest-cfg').style.display=this.checked?'':'none'" />
                Enable auto-cleanup for this feed
              </label>
              <div id="feed-keep-latest-cfg" style="${feed.keep_latest ? "" : "display:none"}">
                <input class="form-control" name="keep_latest" type="number"
                       min="1" value="${feed.keep_latest ?? 10}" data-numeric="1"
                       style="max-width:120px;margin-bottom:6px" />
                <div class="form-hint" style="color:var(--warning)">
                  ⚠ Only the N most recently downloaded episodes are kept. Older files are deleted after each sync.
                  <span id="cleanup-preview-info" style="color:var(--text-3)"></span>
                </div>
                ${toggle("Keep all unplayed episodes", "keep_unplayed",
                  feed.keep_unplayed !== null ? feed.keep_unplayed : settings.keep_unplayed ?? true,
                  "Unplayed episodes are protected from cleanup — only played episodes count toward the limit.")}
              </div>
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
            ${feed.downloaded_count > 0 ? `<button class="btn btn-ghost btn-sm" id="btn-mark-all-played">Mark all played</button>` : ""}
            ${feed.available_count > 0 ? (() => {
              const dlIcon = svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>');
              const caretToggle = `const w=this.closest('.ep-more-wrap');w.toggleAttribute('data-open');document.querySelectorAll('.ep-more-wrap[data-open]').forEach(el=>el!==w&&el.removeAttribute('data-open'))`;
              const caret = svg('<polyline points="6 9 12 15 18 9"/>');
              if (feed.unplayed_available_count > 0) {
                return `<div class="ep-more-wrap" onclick="event.stopPropagation()">
                  <button class="btn btn-primary btn-sm btn-split-main" id="btn-dl-unplayed-feed">
                    ${dlIcon} Download Unplayed (${feed.unplayed_available_count})
                  </button>
                  <button class="btn btn-primary btn-sm btn-split-caret" onclick="${caretToggle}">${caret}</button>
                  <div class="ep-more-dropdown" style="right:0;left:auto;min-width:190px">
                    <button id="btn-dl-unplayed-feed-dd">Download Unplayed (${feed.unplayed_available_count})</button>
                    <button id="btn-dl-all-feed">Download All (${feed.available_count})</button>
                  </div>
                </div>`;
              } else {
                return `<button class="btn btn-primary btn-sm" id="btn-dl-all-feed">
                  ${dlIcon} Download All (${feed.available_count})
                </button>`;
              }
            })() : ""}
            <svg class="panel-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </div>
        </div>
        <div class="panel-body" style="padding:0">
          <div style="border-bottom:1px solid var(--border);padding-top:10px">
            <div style="display:flex;align-items:center;gap:8px;padding:0 12px 8px">
              <input class="form-control" id="ep-filter" placeholder="Filter by title…"
                     style="flex:1;max-width:260px;height:30px;font-size:13px"
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
      document.querySelectorAll("#episode-list .episode-item").forEach((row) => {
        if (row.dataset.played === "1") return;
        row.dataset.played = "1";
        const titleEl = row.querySelector(".episode-title");
        if (titleEl && !titleEl.querySelector(".ep-played-dot")) {
          titleEl.insertAdjacentHTML("afterbegin", '<span class="ep-played-dot" title="Played"></span>');
        }
        const markBtn = [...row.querySelectorAll(".btn-icon")].find((b) => b.title === "Mark as played");
        if (markBtn) {
          markBtn.title = "Mark as unplayed";
          markBtn.innerHTML = svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/>');
        }
      });
      await _refreshFeedStats();
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

  const _doDownloadUnplayed = async () => {
    try {
      const r = await API.downloadUnplayedFeed(id);
      Toast.info(`Queued ${r.queued} unplayed episode${r.queued !== 1 ? "s" : ""} for download`);
      updateStatus();
      await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]);
    } catch (e) { Toast.error(e.message); }
  };
  const _doDownloadAll = async () => {
    try {
      const r = await API.downloadAllFeed(id);
      Toast.info(`Queued ${r.queued} episode${r.queued !== 1 ? "s" : ""} for download`);
      updateStatus();
      await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]);
    } catch (e) { Toast.error(e.message); }
  };

  document.getElementById("btn-dl-unplayed-feed")?.addEventListener("click", _doDownloadUnplayed);
  document.getElementById("btn-dl-unplayed-feed-dd")?.addEventListener("click", (e) => {
    e.currentTarget.closest(".ep-more-wrap")?.removeAttribute("data-open");
    _doDownloadUnplayed();
  });
  document.getElementById("btn-dl-all-feed")?.addEventListener("click", (e) => {
    e.currentTarget.closest(".ep-more-wrap")?.removeAttribute("data-open");
    _doDownloadAll();
  });

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

  // Show cleanup preview when keep_latest input changes
  const klInput = document.querySelector('[name="keep_latest"]');
  if (klInput) {
    const showPreview = async () => {
      const val = klInput.value.trim();
      const info = document.getElementById("cleanup-preview-info");
      if (!info) return;
      if (!val) { info.textContent = ""; return; }
      try {
        const p = await API.cleanupPreview(id);
        info.textContent = p.would_delete > 0
          ? ` — Enabling this now would delete ${p.would_delete} existing file${p.would_delete !== 1 ? "s" : ""}.`
          : "";
      } catch (_) {}
    };
    klInput.addEventListener("blur", showPreview);
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
    payload.keep_latest = document.getElementById("chk-feed-keep-latest")?.checked && raw.keep_latest
      ? Number(raw.keep_latest) : null;
    payload.keep_unplayed = raw.keep_unplayed ?? true;

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
  }

  // Per-file buttons only available when downloaded
  const isCurrentlyPlaying = Player.currentId() === ep.id && Player.isPlaying();
  const playBtn = (isDownloaded && !ep.file_missing) ? `
  <button class="btn btn-ghost btn-sm btn-icon ep-play-btn" data-ep-id="${ep.id}"
          title="${isCurrentlyPlaying ? "Pause" : "Play"}"
          onclick="event.stopPropagation();playEpisode(${ep.id})">
    ${isCurrentlyPlaying ? svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>') : svg('<polygon points="5 3 19 12 5 21 5 3"/>')}
  </button>` : "";

  const _close = `this.closest('.ep-more-wrap').removeAttribute('data-open');`;
  const moreDropdown = `
  <div class="ep-more-wrap" onclick="event.stopPropagation()">
    <button class="btn btn-ghost btn-sm btn-icon ep-more-btn" title="More options"
            onclick="const w=this.closest('.ep-more-wrap');w.toggleAttribute('data-open');document.querySelectorAll('.ep-more-wrap[data-open]').forEach(el=>el!==w&&el.removeAttribute('data-open'))">
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
  } catch (e) { Toast.error(e.message); }
};

window.unhideEpisode = async function (id) {
  try {
    const ep = await API.unhideEpisode(id);
    updateEpisodeRow(ep);
    _syncHiddenBadge(-1);
    _syncDownloadButtons(ep, -1);
    Toast.info("Episode unhidden");
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
    updateStatus(); // kick sidebar to fast polling immediately
    Toast.info("Episode queued for download");
  } catch (e) { Toast.error(e.message); }
};

window.deleteEpisodeFile = async function (id) {
  if (!confirm("Delete the downloaded file? The episode record will remain.")) return;
  try {
    const ep = await API.deleteEpisodeFile(id);
    updateEpisodeRow(ep);
    Toast.success("File deleted");
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
      const btn     = body.querySelector("#btn-start-xml-upload");
      const fileIn  = body.querySelector("#xml-file-input");
      const result  = body.querySelector("#xml-upload-result");

      btn.addEventListener("click", async () => {
        const file = fileIn.files[0];
        if (!file) { fileIn.focus(); return; }
        btn.disabled = true;
        btn.textContent = "Uploading…";
        result.style.display = "none";
        try {
          const r = await API.uploadFeedXml(feedId, file);
          btn.textContent = "Done";
          const skippedNote = r.skipped > 0 ? ` · ${r.skipped} duplicate${r.skipped !== 1 ? "s" : ""} excluded` : "";
          Toast.show(`${r.added} episode${r.added !== 1 ? "s" : ""} added${skippedNote}`, "success", 6000);

          if (r.files_to_rename > 0) {
            // Show inline rename prompt instead of auto-closing
            result.style.display = "block";
            result.style.color = "var(--text-2)";
            result.innerHTML = `
              <div style="margin-bottom:10px;color:var(--text-1);font-weight:500">
                ${r.files_to_rename} downloaded file${r.files_to_rename !== 1 ? "s have" : " has"} updated episode ordering.
              </div>
              <div style="display:flex;gap:8px">
                <button class="btn btn-primary btn-sm" id="btn-xml-rename">Rename Files</button>
                <button class="btn btn-ghost btn-sm" id="btn-xml-keep">Keep as is</button>
              </div>`;
            result.querySelector("#btn-xml-rename").addEventListener("click", async () => {
              try {
                await API.applyFileUpdates(feedId);
                Toast.success("Files renamed successfully");
              } catch (e) {
                Toast.error(e.message);
              }
              Modal.close();
              await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]);
            });
            result.querySelector("#btn-xml-keep").addEventListener("click", async () => {
              Modal.close();
              await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]);
            });
          } else {
            result.style.display = "block";
            result.style.color = "var(--success)";
            result.textContent = `Done — ${r.added} episode${r.added !== 1 ? "s" : ""} added.`;
            setTimeout(async () => { Modal.close(); await Promise.all([_refreshEpisodeList(), _refreshFeedStats()]); }, 1500);
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

function showImportFilesModal(feedId, feed) {
  const defaultDir = feed?.podcast_folder || "";

  // ── Step 1: directory input ───────────────────────────────────
  function showStep1(errorMsg) {
    Modal.open(
      "Import from Path",
      `<div class="form-group">
        <label class="form-label">Directory path</label>
        <input class="form-control" id="import-dir-input" type="text"
               value="${defaultDir}" placeholder="/path/to/audio/files" autofocus />
        <div class="form-hint">Enter the folder containing your audio files. Subdirectories will be scanned recursively.</div>
      </div>
      <div id="import-step1-error" style="color:var(--error);font-size:13px;${errorMsg ? "" : "display:none"}margin-bottom:8px">${errorMsg || ""}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" id="btn-scan-dir">Scan Files</button>
      </div>`,
      (body) => {
        const dirInput = body.querySelector("#import-dir-input");
        const errEl    = body.querySelector("#import-step1-error");
        const scanBtn  = body.querySelector("#btn-scan-dir");

        async function doScan() {
          const dir = dirInput.value.trim();
          if (!dir) { dirInput.focus(); return; }
          scanBtn.disabled = true;
          scanBtn.textContent = "Scanning…";
          errEl.style.display = "none";
          try {
            const preview = await API.previewImport(feedId, dir);
            showStep2(dir, preview);
          } catch (e) {
            errEl.textContent = e.message;
            errEl.style.display = "block";
            scanBtn.disabled = false;
            scanBtn.textContent = "Scan Files";
          }
        }

        scanBtn.addEventListener("click", doScan);
        dirInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doScan(); });
      }
    );
  }

  // ── Step 2: staging table ─────────────────────────────────────
  async function showStep2(dir, preview) {
    // Load all feed episodes for the match dropdowns
    let allEpisodes = [];
    try {
      const eps = await API.getFeedEpisodes(feedId, 5000, 0, "asc");
      allEpisodes = eps.items || eps || [];
    } catch (_) {}

    const files        = preview.files || [];
    const actionFiles  = files.filter(f => !f.already_registered);  // need attention
    const regFiles     = files.filter(f => f.already_registered);   // already done
    const nMatched     = actionFiles.filter(f => f.match).length;
    const nNew         = actionFiles.filter(f => !f.match).length;
    const nRegistered  = regFiles.length;

    // Build episode options HTML once, reused per row
    const epOptionsHtml = allEpisodes.map(ep => {
      const label = ep.title ? `#${ep.seq_number || "?"} — ${ep.title.substring(0, 60)}` : `Episode ${ep.id}`;
      return `<option value="${ep.id}">${label}</option>`;
    }).join("");

    // Per-row confidence badge
    function confBadge(confidence) {
      if (confidence == null) return "";
      const pct = Math.round(confidence * 100);
      const cls = pct >= 70 ? "badge-success" : pct >= 40 ? "badge-warning" : "badge-error";
      return `<span class="badge ${cls}" title="Match confidence">${pct}%</span>`;
    }

    // Build rows only for files that need action
    const thTd = "position:sticky;top:0;padding:7px 10px;font-weight:600;background:var(--bg-3);box-shadow:0 1px 0 var(--border);z-index:1";
    const rowsHtml = actionFiles.map((f, i) => {
      const matchId   = f.match?.episode_id ?? "";
      const conf      = f.match?.confidence ?? null;
      const isMatched = !!f.match;
      const statusDot = isMatched
        ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--warning);flex-shrink:0" title="Matched to an existing episode"></span>`
        : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--primary);flex-shrink:0" title="No match found — will create a new episode"></span>`;
      const infoLine = [f.date, f.episode_number ? `ep. ${f.episode_number}` : null, f.duration]
        .filter(Boolean).join(" · ");
      return `<tr id="import-row-${i}" data-path="${f.path.replace(/"/g, "&quot;")}">
        <td style="padding:7px 10px;font-size:12px;max-width:220px">
          <div style="display:flex;align-items:flex-start;gap:7px">
            ${statusDot}
            <div style="min-width:0">
              <div style="word-break:break-all;line-height:1.3">${f.filename}</div>
              ${f.title && f.title !== f.filename.replace(/\.[^.]+$/, "")
                ? `<div style="color:var(--text-3);font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${f.title.replace(/"/g, "&quot;")}">${f.title}</div>`
                : ""}
              ${infoLine ? `<div style="color:var(--text-3);font-size:11px;margin-top:1px">${infoLine}</div>` : ""}
            </div>
          </div>
        </td>
        <td style="padding:7px 10px">
          <select class="form-control import-ep-select" style="font-size:12px;padding:3px 6px;width:100%" data-row="${i}">
            <option value="">— Create new episode —</option>
            ${allEpisodes.map(ep => {
              const label = ep.title ? `#${ep.seq_number || "?"} — ${ep.title.substring(0, 55)}` : `Episode ${ep.id}`;
              return `<option value="${ep.id}" ${ep.id == matchId ? "selected" : ""}>${label}</option>`;
            }).join("")}
          </select>
          ${isMatched ? `<div class="import-conf-cell" style="margin-top:4px">${confBadge(conf)}</div>` : ""}
        </td>
        <td style="padding:7px 10px;text-align:center;white-space:nowrap">
          <label style="cursor:pointer;display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--text-2)">
            <input type="checkbox" class="import-skip-chk" data-row="${i}" style="width:14px;height:14px" />
            Skip
          </label>
        </td>
      </tr>`;
    }).join("");

    // Summary stats row
    const statPills = [
      nMatched   > 0 ? `<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;background:rgba(var(--warning-rgb,200,150,50),0.15);color:var(--warning);font-size:12px;font-weight:600"><span style="width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block"></span>${nMatched} matched</span>` : "",
      nNew       > 0 ? `<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;background:rgba(var(--primary-rgb,80,130,220),0.15);color:var(--primary);font-size:12px;font-weight:600"><span style="width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block"></span>${nNew} new</span>` : "",
      nRegistered > 0 ? `<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;background:rgba(var(--success-rgb,60,180,100),0.15);color:var(--success);font-size:12px;font-weight:600"><span style="width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block"></span>${nRegistered} already imported</span>` : "",
    ].filter(Boolean).join(" ");

    // Guidance text based on state
    let guidance = "";
    if (actionFiles.length === 0 && nRegistered > 0) {
      guidance = `All ${nRegistered} file${nRegistered !== 1 ? "s" : ""} in this folder are already imported. Nothing to do.`;
    } else if (nMatched > 0 && nNew === 0) {
      guidance = "All files were matched to existing episodes. Review the matches below — adjust any that look wrong — then click Import.";
    } else if (nMatched === 0 && nNew > 0) {
      guidance = "No files could be matched to existing episodes. They will each be added as a new episode. Use the dropdown to link a file to an existing episode if needed.";
    } else if (nMatched > 0 && nNew > 0) {
      guidance = `${nMatched} file${nMatched !== 1 ? "s" : ""} matched to existing episodes; ${nNew} could not be matched and will become new episodes. Review below and adjust as needed.`;
    }

    // Already-imported collapsible section
    const regSection = nRegistered > 0 ? `
      <details style="margin-top:10px">
        <summary style="font-size:12px;color:var(--text-3);cursor:pointer;user-select:none;padding:4px 0">
          ${nRegistered} file${nRegistered !== 1 ? "s" : ""} already imported (no action needed)
        </summary>
        <div style="margin-top:6px;border:1px solid var(--border);border-radius:6px;overflow:hidden">
          ${regFiles.map(f => `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-3)">
              <span style="color:var(--success)">✓</span>
              <span style="word-break:break-all">${f.filename}</span>
              ${f.match?.episode_title ? `<span style="margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;flex-shrink:0" title="${f.match.episode_title.replace(/"/g, "&quot;")}">→ ${f.match.episode_title}</span>` : ""}
            </div>`).join("")}
        </div>
      </details>` : "";

    const importCount = actionFiles.length;
    const importBtnLabel = importCount === 0
      ? "Nothing to import"
      : `Import ${importCount} file${importCount !== 1 ? "s" : ""}`;

    const tableHtml = actionFiles.length === 0 ? "" :
      `<div style="overflow-x:auto;max-height:min(52vh,500px);overflow-y:auto;border:1px solid var(--border);border-radius:6px;margin-top:10px">
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

    const noFilesMsg = files.length === 0
      ? `<p style="text-align:center;color:var(--text-2);padding:24px 0">No audio files found in that directory.</p>`
      : "";

    Modal.open(
      `Review & Import — ${files.length} file${files.length !== 1 ? "s" : ""} found`,
      `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${statPills}</div>
      ${guidance ? `<p style="font-size:13px;color:var(--text-2);margin:0 0 4px;line-height:1.5">${guidance}</p>` : ""}
      ${noFilesMsg}
      ${tableHtml}
      ${regSection}
      <div id="import-step2-error" style="color:var(--error);font-size:13px;display:none;margin-top:10px"></div>
      <div class="modal-actions" style="margin-top:12px">
        <button class="btn btn-ghost" id="btn-import-back">Back</button>
        <button class="btn btn-primary" id="btn-commit-import" ${importCount === 0 ? "disabled" : ""}>
          ${importBtnLabel}
        </button>
      </div>`,
      (body) => {
        document.getElementById("modal").classList.add("modal-wide");
        body.querySelector("#btn-import-back").addEventListener("click", () => showStep1());

        // Sync episode option availability across all dropdowns so no episode
        // can be linked to more than one file at a time.
        function syncEpisodeOptions() {
          const selects = [...body.querySelectorAll(".import-ep-select")];
          // Collect episode IDs that are currently claimed by some dropdown
          const claimed = new Set(
            selects.map(s => s.value).filter(v => v !== "")
          );
          selects.forEach(sel => {
            for (const opt of sel.options) {
              if (opt.value === "") continue;
              // Disable if claimed by a *different* select
              opt.disabled = claimed.has(opt.value) && opt.value !== sel.value;
            }
          });
        }

        // When match dropdown is changed manually, remove confidence badge and
        // re-sync which episode options are available across all dropdowns.
        body.querySelectorAll(".import-ep-select").forEach(sel => {
          sel.addEventListener("change", () => {
            const row = document.getElementById(`import-row-${sel.dataset.row}`);
            const cell = row?.querySelector(".import-conf-cell");
            if (cell) cell.innerHTML = "";
            syncEpisodeOptions();
          });
        });

        // Run once on open so pre-matched rows already block their episodes
        syncEpisodeOptions();

        const commitBtn = body.querySelector("#btn-commit-import");
        const errEl     = body.querySelector("#import-step2-error");

        function updateImportBtn() {
          const n = body.querySelectorAll("#import-tbody .import-skip-chk:not(:checked)").length;
          commitBtn.disabled = n === 0;
          commitBtn.textContent = n === 0 ? "Nothing to import" : `Import ${n} file${n !== 1 ? "s" : ""}`;
        }

        body.querySelectorAll(".import-skip-chk").forEach(chk => {
          chk.addEventListener("change", updateImportBtn);
        });

        commitBtn.addEventListener("click", async () => {
          const items = [];
          body.querySelectorAll("#import-tbody tr").forEach(row => {
            if (row.querySelector(".import-skip-chk")?.checked) return; // skip excluded
            const epIdVal = row.querySelector(".import-ep-select")?.value || "";
            items.push({
              path:       row.dataset.path,
              skip:       false,
              episode_id: epIdVal ? parseInt(epIdVal, 10) : null,
            });
          });

          commitBtn.disabled = true;
          commitBtn.textContent = "Importing…";
          errEl.style.display = "none";
          try {
            await API.commitImport(feedId, items);
            Modal.close();
            Toast.success("Import started — check the banner above the episode list for progress.");
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
