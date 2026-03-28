"use strict";

// ============================================================
// Downloads view
// ============================================================

// _setTabBadge is the single writer for the tab header badges (in-progress, failed).
// Centralising this avoids the repeated textContent + className + marginLeft triple
// and ensures consistent show/hide behaviour across all callers.  Exposed as a
// global so updateStatus() in router.js can keep the badges live on any tab.
function _setTabBadge(id, n, cls = "badge-warning") {
  const badge = document.getElementById(id);
  if (!badge) return;
  if (n > 0) {
    badge.textContent = n;
    badge.className = `badge ${cls}`;
    badge.style.marginLeft = "4px";
  } else {
    badge.textContent = "";
    badge.className = "";
    badge.style.marginLeft = "";
  }
}
window._setTabBadge = _setTabBadge;

let _dlPollInterval = null;
let _dlPollHadItems = false; // true once we've seen a non-zero queue during this session
let _downloadedPollInterval = null;

function _stopDLPoll() {
  if (_dlPollInterval) {
    clearInterval(_dlPollInterval);
    _dlPollInterval = null;
  }
  if (_downloadedPollInterval) {
    clearInterval(_downloadedPollInterval);
    _downloadedPollInterval = null;
  }
  _dlPollHadItems = false;
  window._dlActiveTab = null;
}

// Returns an ISO timestamp string if the user has previously cleared the downloaded list,
// or null if no clear has been performed.  Used to filter episodes for the Downloaded tab
// so that "Clear List" persists across page reloads.
function _dlClearedSince() {
  const t = localStorage.getItem("dl_cleared_at");
  return t ? new Date(+t).toISOString() : null;
}

function _dlFetchParams(extra = {}) {
  const cs = _dlClearedSince();
  return { status: "downloaded", limit: 100, sort: "download_date", ...(cs ? { download_since: cs } : {}), ...extra };
}

// _doDownloadedPollTick runs every 3 s while the Downloaded tab is active.
// On each tick we fetch the current downloaded list and compare it against what
// the DOM is showing.  New episodes (not yet in the list) are prepended to the
// top; rows beyond the fetch limit are trimmed from the bottom.  We only touch
// the DOM when something actually changed so steady-state is a no-op.
async function _doDownloadedPollTick() {
  if (window._dlActiveTab !== "downloaded") { _stopDLPoll(); return; }
  const list = document.getElementById("dl-episode-list");
  if (!list) { _stopDLPoll(); return; }

  try {
    const episodes = await API.getEpisodes(_dlFetchParams());

    // Guard again after async — the user may have switched tabs while the
    // request was in flight.
    if (window._dlActiveTab !== "downloaded") return;

    if (window._dlData) window._dlData.downloaded = episodes;

    // Determine which episode IDs are already rendered in the DOM.
    const domIds = new Set(
      [...list.querySelectorAll(".episode-item")]
        .map(r => Number(r.id.replace("dl-ep-", "")))
    );

    const newEps = episodes.filter(e => !domIds.has(e.id));
    if (newEps.length === 0) return; // nothing to do

    // When the list was previously empty (just an empty-state placeholder),
    // do a full re-render so the "Clear List" toolbar is included.  No row
    // animation needed — the whole tab fades in via _fadeInTabContent.
    if (domIds.size === 0) {
      const tc = document.getElementById("dl-tab-content");
      if (tc) {
        tc.innerHTML = _renderDownloadedTab(episodes);
        _fadeInTabContent(tc);
      }
      return;
    }

    // Incremental update: prepend new rows and trim excess from the bottom.
    // Animate each new row in — reverse of animateRemove (height expand + fade)
    // so the entry feels consistent with how items depart from In Progress.
    list.insertAdjacentHTML("afterbegin", newEps.map(renderDLRow).join(""));
    for (const ep of newEps) {
      const row = document.getElementById(`dl-ep-${ep.id}`);
      if (row) animateEnter(row);
    }

    // Trim rows beyond the fetch limit from the bottom so the list doesn't
    // grow unboundedly as more episodes complete.
    const allRows = [...list.querySelectorAll(".episode-item")];
    for (let i = 100; i < allRows.length; i++) allRows[i].remove();

    // Keep the "N shown" label in the toolbar in sync.
    const countEl = list.closest(".card")?.querySelector("span[data-shown]");
    if (countEl) countEl.textContent = `${Math.min(episodes.length, 100)} shown`;
  } catch (_) {}
}

function _startDownloadedPoll() {
  _doDownloadedPollTick();
  _downloadedPollInterval = setInterval(_doDownloadedPollTick, 3000);
}

async function viewDownloads() {
  _stopDLPoll();

  const [feeds, queued, downloading, downloaded, failed, status] = await Promise.all([
    API.getFeeds(),
    API.getEpisodes({ status: "queued", limit: 100 }),
    API.getEpisodes({ status: "downloading", limit: 20 }),
    API.getEpisodes(_dlFetchParams()),
    API.getEpisodes({ status: "failed", limit: 100 }),
    API.getStatus(),
  ]);

  const inProgress = [...downloading, ...queued];
  // Use the status API's count for the true total — fetched episode arrays are capped by limit
  const inProgressTotal = (status?.active_downloads ?? 0) + (status?.download_queue_size ?? 0);
  const available = feeds.filter((f) => f.available_count > 0)
    .sort((a, b) => b.available_count - a.available_count);
  const totalAvailable = available.reduce((s, f) => s + f.available_count, 0);
  const totalUnplayedAvailable = available.reduce((s, f) => s + (f.unplayed_available_count || 0), 0);

  window._dlData = { inProgress, downloaded, failed, available, status };

  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-title">Downloads</div>
          <div class="page-subtitle" id="dl-subtitle">${totalAvailable} available · ${inProgressTotal} in progress</div>
        </div>
        <div></div>
      </div>

      <div class="tabs" id="dl-tabs">
        <button class="tab-btn active" data-tab="available" onclick="switchDLTab('available', this)">
          Available${totalAvailable > 0 ? ` <span class="badge badge-primary" style="margin-left:4px">${totalAvailable}</span>` : ""}
        </button>
        <button class="tab-btn" data-tab="inprogress" onclick="switchDLTab('inprogress', this)">
          In Progress${inProgressTotal > 0 ? ` <span class="badge badge-warning" style="margin-left:4px" id="badge-inprogress">${inProgressTotal}</span>` : '<span id="badge-inprogress"></span>'}
        </button>
        <button class="tab-btn" data-tab="downloaded" onclick="switchDLTab('downloaded', this)">
          Downloaded
        </button>
        <button class="tab-btn" data-tab="failed" onclick="switchDLTab('failed', this)">
          Failed${failed.length > 0 ? ` <span class="badge badge-error" style="margin-left:4px" id="badge-failed">${failed.length}</span>` : '<span id="badge-failed"></span>'}
        </button>
      </div>

      <div id="dl-tab-content">
        ${renderAvailableFeeds(available)}
      </div>
    </div>`;

  window._doGlobalUnplayed = async () => {
    try {
      const r = await API.downloadUnplayed();
      Toast.info(`Queued ${r.queued} unplayed episode${r.queued !== 1 ? "s" : ""} for download`);
      updateStatus();
      await _refreshAvailableTab();
    } catch (e) { Toast.error(e.message); }
  };
  window._doGlobalAll = async () => {
    try {
      const r = await API.downloadAll();
      Toast.info(`Queued ${r.queued} episode${r.queued !== 1 ? "s" : ""} for download`);
      updateStatus();
      await _refreshAvailableTab();
    } catch (e) { Toast.error(e.message); }
  };

  // Honor pending tab selection from dashboard navigation
  const pendingTab = window._pendingDLTab;
  if (pendingTab) {
    window._pendingDLTab = null;
    const tabBtn = document.querySelector(`.tab-btn[data-tab="${pendingTab}"]`);
    if (tabBtn) switchDLTab(pendingTab, tabBtn);
  }
}

function renderAvailableFeeds(feeds) {
  const totalAvail = feeds.reduce((s, f) => s + f.available_count, 0);
  const totalUnplayed = feeds.reduce((s, f) => s + (f.unplayed_available_count || 0), 0);

  const dlIcon = svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>');
  const caret = svg('<polyline points="6 9 12 15 18 9"/>');
  const caretToggle = `const w=this.closest('.ep-more-wrap');w.toggleAttribute('data-open');document.querySelectorAll('.ep-more-wrap[data-open]').forEach(el=>el!==w&&el.removeAttribute('data-open'))`;

  let globalBtns = "";
  if (totalAvail > 0) {
    if (totalUnplayed > 0) {
      globalBtns = `<div class="ep-more-wrap" onclick="event.stopPropagation()">
        <button class="btn btn-primary btn-split-main" onclick="_doGlobalUnplayed()">
          ${dlIcon} Download All Unplayed (${totalUnplayed})
        </button>
        <button class="btn btn-primary btn-split-caret" onclick="${caretToggle}">${caret}</button>
        <div class="ep-more-dropdown" style="right:0;left:auto;min-width:220px">
          <button onclick="this.closest('.ep-more-wrap').removeAttribute('data-open');_doGlobalUnplayed()">Download All Unplayed (${totalUnplayed})</button>
          <button onclick="this.closest('.ep-more-wrap').removeAttribute('data-open');_doGlobalAll()">Download All (${totalAvail})</button>
        </div>
      </div>`;
    } else {
      globalBtns = `<button class="btn btn-primary" onclick="_doGlobalAll()">
        ${dlIcon} Download All (${totalAvail})
      </button>`;
    }
  }

  if (feeds.length === 0) {
    return `<div class="empty-state" style="padding:60px 20px">
      <div class="empty-state-icon">${svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', 'style="width:40px;height:40px;display:block;margin:0 auto;color:var(--text-3)"')}</div>
      <div class="empty-state-title">All caught up</div>
      <div class="empty-state-desc">No episodes waiting to be downloaded.</div>
    </div>`;
  }

  const actionBar = globalBtns ? `<div style="display:flex;justify-content:flex-end;padding:10px 14px;border-bottom:1px solid var(--border)">${globalBtns}</div>` : "";

  return `<div class="card">${actionBar}<div class="episode-list">${feeds.map((f) => `
    <div class="episode-item">
      <div class="episode-art" style="cursor:pointer" onclick="Router.navigate('/feeds/${f.id}')">
        ${f.image_url
          ? `<img src="${f.image_url}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="episode-art-placeholder" style="display:none">${_PODCAST_SVG}</div>`
          : `<div class="episode-art-placeholder">${_PODCAST_SVG}</div>`}
      </div>
      <div class="episode-info" style="cursor:pointer" onclick="Router.navigate('/feeds/${f.id}')">
        <div class="episode-title">${f.title || f.url}</div>
        <div class="episode-meta">
          ${f.downloaded_count > 0 ? `<span>${f.downloaded_count} downloaded</span>` : ""}
          <span>${f.available_count} not downloaded</span>
        </div>
      </div>
      <div class="episode-actions">
        ${(() => {
          const dlIcon = svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>');
          const caret = svg('<polyline points="6 9 12 15 18 9"/>');
          const caretToggle = `const w=this.closest('.ep-more-wrap');w.toggleAttribute('data-open');document.querySelectorAll('.ep-more-wrap[data-open]').forEach(el=>el!==w&&el.removeAttribute('data-open'))`;
          const unplayed = f.unplayed_available_count || 0;
          if (unplayed > 0) {
            return `<div class="ep-more-wrap" onclick="event.stopPropagation()">
              <button class="btn btn-primary btn-sm btn-split-main" onclick="downloadFeedFromDL(${f.id},'unplayed',this)">
                ${dlIcon} Unplayed (${unplayed})
              </button>
              <button class="btn btn-primary btn-sm btn-split-caret" onclick="${caretToggle}">${caret}</button>
              <div class="ep-more-dropdown" style="right:0;left:auto;min-width:180px">
                <button onclick="this.closest('.ep-more-wrap').removeAttribute('data-open');downloadFeedFromDL(${f.id},'unplayed',this)">Download Unplayed (${unplayed})</button>
                <button onclick="this.closest('.ep-more-wrap').removeAttribute('data-open');downloadFeedFromDL(${f.id},'all',this)">Download All (${f.available_count})</button>
              </div>
            </div>`;
          } else {
            return `<button class="btn btn-primary btn-sm" onclick="downloadFeedFromDL(${f.id},'all',this)">
              ${dlIcon} Download All (${f.available_count})
            </button>`;
          }
        })()}
      </div>
    </div>`).join("")}</div></div>`;
}

function _showMoreFooter(tabId, currentCount, offset) {
  // Show "Show More" if we got a full page (might be more)
  if (currentCount < 100) return "";
  return `<div id="dl-show-more-bar" style="padding:12px 14px;text-align:center;border-top:1px solid var(--border)">
    <button class="btn btn-ghost btn-sm" onclick="_dlLoadMore('${tabId}', ${offset + currentCount})">
      Show More
    </button>
  </div>`;
}

function _renderInProgressTab(episodes, trueTotal) {
  const count = trueTotal ?? episodes.length;
  const bar = count > 0
    ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border)">
         <span id="dl-inprogress-count" style="font-size:13px;color:var(--text-2)">${count} in progress</span>
         <button class="btn btn-ghost btn-sm" style="color:var(--error)" id="btn-cancel-all-tab">
           ${svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}
           Cancel All
         </button>
       </div>` : "";
  return `<div class="card">${bar}<div class="episode-list" id="dl-episode-list">${renderDLList(episodes)}</div>${_showMoreFooter("inprogress", episodes.length, 0)}</div>`;
}

function _renderDownloadedTab(episodes, offset = 0) {
  const bar = episodes.length > 0
    ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border)">
         <span data-shown style="font-size:13px;color:var(--text-2)">${offset + episodes.length} shown</span>
         <button class="btn btn-ghost btn-sm" onclick="_clearDLList()">
           ${svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>')}
           Clear List
         </button>
       </div>` : "";
  return `<div class="card">${bar}<div class="episode-list" id="dl-episode-list">${renderDLList(episodes)}</div>${_showMoreFooter("downloaded", episodes.length, offset)}</div>`;
}

function _renderFailedTab(episodes, offset = 0) {
  const bar = episodes.length > 0
    ? `<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border)">
         <button class="btn btn-primary btn-sm" id="btn-retry-all-tab">
           ${svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/>')}
           Retry All (${episodes.length})
         </button>
         <button class="btn btn-ghost btn-sm" id="btn-dismiss-all-tab">
           ${svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>')}
           Remove All
         </button>
       </div>` : "";
  return `<div class="card">${bar}<div class="episode-list" id="dl-episode-list">${renderDLList(episodes)}</div>${_showMoreFooter("failed", episodes.length, offset)}</div>`;
}

window._dlLoadMore = async function(tabId, offset) {
  const showMoreBar = document.getElementById("dl-show-more-bar");
  if (showMoreBar) showMoreBar.innerHTML = `<div class="spinner" style="margin:0 auto"></div>`;

  let status = tabId === "inprogress" ? ["queued", "downloading"] : tabId;
  try {
    let episodes;
    if (tabId === "inprogress") {
      const [queued, downloading] = await Promise.all([
        API.getEpisodes({ status: "queued", limit: 100, offset }),
        API.getEpisodes({ status: "downloading", limit: 20, offset: 0 }),
      ]);
      episodes = [...downloading, ...queued];
    } else if (tabId === "downloaded") {
      episodes = await API.getEpisodes(_dlFetchParams({ offset }));
    } else {
      episodes = await API.getEpisodes({ status: "failed", limit: 100, offset });
    }

    const list = document.getElementById("dl-episode-list");
    if (!list) return;

    // Replace show-more bar with new rows + potentially new show-more bar
    showMoreBar?.remove();
    list.insertAdjacentHTML("beforeend", episodes.map(renderDLRow).join(""));
    if (episodes.length >= 100) {
      list.closest(".card").insertAdjacentHTML("beforeend", `<div id="dl-show-more-bar" style="padding:12px 14px;text-align:center;border-top:1px solid var(--border)">
        <button class="btn btn-ghost btn-sm" onclick="_dlLoadMore('${tabId}', ${offset + episodes.length})">
          Show More
        </button>
      </div>`);
    }

    // Update shown count label
    const countEl = document.querySelector("#dl-tab-content [data-shown]");
    if (countEl && tabId === "downloaded") {
      const total = list.querySelectorAll(".episode-item").length;
      countEl.textContent = `${total} shown`;
    }
  } catch (e) { Toast.error(e.message); }
};

// _refreshDownloadedTab re-fetches downloaded episodes and re-renders the tab in place.
// Used both by the "Refresh" link in the cleared empty state and after individual deletes.
async function _refreshDownloadedTab() {
  const tc = document.getElementById("dl-tab-content");
  if (!tc) return;
  _fadeOutTabContent();
  await new Promise((r) => setTimeout(r, 190));
  try {
    const episodes = await API.getEpisodes(_dlFetchParams());
    if (window._dlData) window._dlData.downloaded = episodes;
    tc.innerHTML = _renderDownloadedTab(episodes);
    _fadeInTabContent(tc);
  } catch (_) {}
}

window._clearDLList = function() {
  localStorage.setItem("dl_cleared_at", Date.now().toString());
  if (window._dlData) window._dlData.downloaded = [];
  const list = document.getElementById("dl-episode-list");
  if (!list) return;

  const _applyEmpty = () => {
    list.style.transition = "";
    list.style.opacity = "";
    list.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">${svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', 'style="width:40px;height:40px;display:block;margin:0 auto;color:var(--text-3)"')}</div>
      <div class="empty-state-title">List cleared</div>
      <div class="empty-state-desc">New downloads will appear here automatically</div>
    </div>`;
    document.getElementById("dl-show-more-bar")?.remove();
    const bar = document.querySelector("#dl-tab-content .card > div:first-child");
    if (bar && bar.style.borderBottom) bar.style.display = "none";
  };

  if (!list.querySelector(".episode-item")) {
    _applyEmpty();
    return;
  }
  // Fade the whole list out, then swap in the empty state
  list.style.transition = "opacity 0.2s ease";
  list.style.opacity = "0";
  setTimeout(_applyEmpty, 220);
};

function _fadeOutTabContent() {
  const tc = document.getElementById("dl-tab-content");
  if (tc) { tc.style.transition = "opacity 0.18s ease"; tc.style.opacity = "0"; }
}


// _checkTabListEmpty shows the proper empty state when the last episode row has been
// removed from the current tab's list — prevents leaving a header bar with no rows below it.
function _checkTabListEmpty() {
  const list = document.getElementById("dl-episode-list");
  if (list && !list.querySelector(".episode-item")) {
    list.innerHTML = renderDLList([]);
  }
}

function _fadeInTabContent(el) {
  el.style.opacity = "0";
  void el.offsetHeight; // flush so the transition fires
  el.style.transition = "opacity 0.15s ease";
  el.style.opacity = "1";
  setTimeout(() => { el.style.transition = ""; }, 180);
}

// Re-fetch feeds and patch the Available tab + subtitle in place.
// Only re-renders tab content if the user is currently on the Available tab.
async function _refreshAvailableTab() {
  try {
    const [feeds, status] = await Promise.all([API.getFeeds(), API.getStatus()]);
    const available = feeds.filter((f) => f.available_count > 0)
      .sort((a, b) => b.available_count - a.available_count);
    const totalAvailable = available.reduce((s, f) => s + f.available_count, 0);

    if (window._dlData) {
      window._dlData.available = available;
      window._dlData.status = status;
    }

    // Patch subtitle
    const sub = document.getElementById("dl-subtitle");
    if (sub) {
      const inProg = (status?.active_downloads ?? 0) + (status?.download_queue_size ?? 0);
      sub.textContent = `${totalAvailable} available · ${inProg} in progress`;
    }

    // Patch Available tab button badge
    const availBtn = document.querySelector('.tab-btn[data-tab="available"]');
    if (availBtn) {
      availBtn.innerHTML = totalAvailable > 0
        ? `Available <span class="badge badge-primary" style="margin-left:4px">${totalAvailable}</span>`
        : "Available";
    }

    // Re-render tab content only if user is on the Available tab
    if (!window._dlActiveTab || window._dlActiveTab === "available") {
      const tc = document.getElementById("dl-tab-content");
      if (!tc) return;
      tc.style.transition = "opacity 0.15s ease";
      tc.style.opacity = "0";
      await new Promise((r) => setTimeout(r, 160));
      tc.innerHTML = renderAvailableFeeds(available);
      void tc.offsetHeight;
      tc.style.transition = "opacity 0.2s ease";
      tc.style.opacity = "1";
      setTimeout(() => { tc.style.transition = ""; tc.style.opacity = ""; }, 220);
    }
  } catch (_) {}
}

window.switchDLTab = function (tabId, btn) {
  _stopDLPoll();
  for (const b of document.querySelectorAll(".tab-btn")) b.classList.remove("active");
  btn.classList.add("active");
  window._dlActiveTab = tabId;
  const { inProgress, downloaded, failed } = window._dlData;
  const tabContent = document.getElementById("dl-tab-content");

  if (tabId === "available") {
    tabContent.innerHTML = renderAvailableFeeds(window._dlData.available);
  } else if (tabId === "inprogress") {
    const s = window._dlData.status;
    tabContent.innerHTML = _renderInProgressTab(inProgress, (s?.active_downloads ?? 0) + (s?.download_queue_size ?? 0));
    _wireInProgressActions();
    _startDLPoll();
  } else if (tabId === "downloaded") {
    tabContent.innerHTML = _renderDownloadedTab(downloaded);
    _startDownloadedPoll();
  } else if (tabId === "failed") {
    tabContent.innerHTML = _renderFailedTab(failed);
    _wireFailedActions();
  }

  _fadeInTabContent(tabContent);
};

function _wireInProgressActions() {
  document.getElementById("btn-cancel-all-tab")?.addEventListener("click", async () => {
    try {
      const r = await API.cancelAll();
      Toast.info(`Cancelled ${r.cancelled} download${r.cancelled !== 1 ? "s" : ""}`);
      _stopDLPoll();

      // Animate all rows out, then show empty state
      const list = document.getElementById("dl-episode-list");
      if (list) {
        const rows = [...list.querySelectorAll(".episode-item")];
        for (const row of rows) animateRemove(row);
        if (rows.length > 0) {
          setTimeout(() => {
            if (!list.querySelector(".episode-item")) {
              list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', 'style="width:40px;height:40px;display:block;margin:0 auto;color:var(--text-3)"')}</div><div class="empty-state-title">Queue empty</div></div>`;
            }
          }, 360);
        }
      }

      // Clear badges and subtitle
      _setTabBadge("badge-inprogress", 0);
      _setNavBadge(0);
      const sub = document.getElementById("dl-subtitle");
      if (sub) {
        const totalAvail = (window._dlData?.available || []).reduce((s, f) => s + f.available_count, 0);
        sub.textContent = `${totalAvail} available · 0 in progress`;
      }
      if (window._dlData) {
        if (window._dlData.status) { window._dlData.status.active_downloads = 0; window._dlData.status.download_queue_size = 0; }
        window._dlData.inProgress = [];
      }
    } catch (e) { Toast.error(e.message); }
  });
}

function _wireFailedActions() {
  document.getElementById("btn-retry-all-tab")?.addEventListener("click", async () => {
    try {
      const r = await API.retryAllFailed();
      Toast.info(`Queued ${r.queued} episode${r.queued !== 1 ? "s" : ""} for retry`);
      _clearTabRows("All queued for retry");
      if (window._dlData) window._dlData.failed = [];
      _setTabBadge("badge-failed", 0, "badge-error");
    } catch (e) { Toast.error(e.message); }
  });
  document.getElementById("btn-dismiss-all-tab")?.addEventListener("click", async () => {
    try {
      const r = await API.dismissAllFailed();
      Toast.info(`Removed ${r.dismissed} failed episode${r.dismissed !== 1 ? "s" : ""}`);
      _clearTabRows("Nothing here yet");
      if (window._dlData) window._dlData.failed = [];
      _setTabBadge("badge-failed", 0, "badge-error");
    } catch (e) { Toast.error(e.message); }
  });
}

// Fade the whole card out, swap to empty-state, fade back in.
// Avoids the shrink-then-pop caused by animating individual rows out
// and then injecting a full-height empty state.
function _clearTabRows(emptyTitle) {
  const list = document.getElementById("dl-episode-list");
  if (!list) return;
  const card = list.closest(".card") || list;
  const emptyHtml = `<div class="empty-state"><div class="empty-state-icon">${svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', 'style="width:40px;height:40px;display:block;margin:0 auto;color:var(--text-3)"')}</div><div class="empty-state-title">${emptyTitle}</div></div>`;
  card.style.transition = "opacity 0.18s ease";
  card.style.opacity = "0";
  setTimeout(() => {
    list.innerHTML = emptyHtml;
    // Hide the action bar (buttons row above the episode list)
    const bar = card.querySelector(":scope > div:first-child");
    if (bar && bar !== list) bar.style.display = "none";
    document.getElementById("dl-show-more-bar")?.remove();
    card.style.transition = "opacity 0.15s ease";
    card.style.opacity = "1";
    setTimeout(() => { card.style.transition = ""; }, 170);
  }, 200);
}

async function _doPollTick() {
  if (window._dlActiveTab !== "inprogress") { _stopDLPoll(); return; }
  if (!document.getElementById("dl-episode-list")) { _stopDLPoll(); return; }

  try {
    const [queued, downloading, failed, status, activeProgress] = await Promise.all([
      API.getEpisodes({ status: "queued", limit: 100 }),
      API.getEpisodes({ status: "downloading", limit: 20 }),
      API.getEpisodes({ status: "failed", limit: 100 }),
      API.getStatus(),
      API.getActiveProgress(),
    ]);
    const inProgress = [...downloading, ...queued];
    // Use status API for the true total — fetched episode arrays are capped by limit
    const trueTotal = (status?.active_downloads ?? 0) + (status?.download_queue_size ?? 0);

    // Update all three badges from the same status fetch so they're always in sync.
    // Writing the nav badge directly here (not via updateStatus) avoids a timing
    // mismatch where the sidebar and the tab count come from separate fetches.
    _setTabBadge("badge-inprogress", trueTotal);
    _setTabBadge("badge-failed", failed.length, "badge-error");
    _setNavBadge(trueTotal);

    // Update subtitle — use true total, not fetched array length
    const sub = document.getElementById("dl-subtitle");
    if (sub) sub.textContent = `${trueTotal} in progress`;

    // Store updated data for tab switches
    window._dlData.inProgress = inProgress;
    window._dlData.failed = failed;
    window._dlData.status = status;

    if (trueTotal > 0) {
      _dlPollHadItems = true;
    } else if (_dlPollHadItems) {
      // Queue just drained — stop polling and refresh Available tab data in the
      // background so counts are correct when the user switches to that tab.
      // Also pre-fetch the downloaded list so the Downloaded tab is immediately
      // up-to-date when the user switches to it.
      _stopDLPoll();
      _refreshAvailableTab();
      API.getEpisodes(_dlFetchParams())
        .then((eps) => { if (window._dlData) window._dlData.downloaded = eps; })
        .catch(() => {});
      return;
    } else {
      // Tab opened while queue was already empty — just stop polling, don't redirect
      _stopDLPoll();
      return;
    }

    // Guard: the API calls above are async — the user may have switched tabs while
    // they were in flight.  Bail before touching the DOM to avoid writing
    // in-progress rows into a different tab's episode list.
    if (window._dlActiveTab !== "inprogress") return;

    // Patch progress bars and statuses in place
    const list = document.getElementById("dl-episode-list");
    if (!list) return;

    // Track which IDs are still in-progress
    const activeIds = new Set(inProgress.map((e) => e.id));

    // Remove rows for episodes that finished (no longer in in-progress).
    // For rows that were actively downloading, complete the progress bar to 100%
    // first so the user sees it fill before the row disappears.
    for (const row of [...list.querySelectorAll(".episode-item")]) {
      const id = Number(row.id.replace("dl-ep-", ""));
      if (!activeIds.has(id)) {
        if (row.dataset.status === "downloading") {
          const fill = row.querySelector(".progress-fill");
          if (fill) {
            fill.style.transition = "width 0.3s ease-out";
            fill.style.width = "100%";
          }
          row.style.pointerEvents = "none";
          setTimeout(() => animateRemove(row), 330);
        } else {
          animateRemove(row);
        }
      }
    }

    // Update existing rows; insert new ones at the end (re-sort corrects order below).
    //
    // When a row transitions from "queued" to "downloading" we REPLACE it entirely
    // rather than patching in place.  The queued CSS rule sets `width: 100% !important`
    // with a pulse animation; if we just change data-status and then set a small width,
    // the `transition: 2s linear` rule kicks in and plays a 2-second reverse animation
    // (100% → current%).  A fresh element has no animation history so the fill starts
    // at the correct position and only animates forward on subsequent updates.
    // If the list only contains an empty-state placeholder (no real rows yet),
    // clear it so incoming rows aren't mixed in with the "Nothing here" message.
    if (!list.querySelector(".episode-item") && list.querySelector(".empty-state")) {
      list.innerHTML = "";
      // Also ensure the Cancel All bar exists — it won't if the tab was rendered
      // with stale/empty data.  Re-render the whole tab header block in that case.
      if (!document.getElementById("btn-cancel-all-tab")) {
        const card = list.closest(".card");
        if (card) {
          card.insertAdjacentHTML("afterbegin",
            `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border)">
               <span id="dl-inprogress-count" style="font-size:13px;color:var(--text-2)">${trueTotal} in progress</span>
               <button class="btn btn-ghost btn-sm" style="color:var(--error)" id="btn-cancel-all-tab">
                 ${svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}
                 Cancel All
               </button>
             </div>`
          );
          _wireInProgressActions();
        }
      }
    }

    for (const ep of inProgress) {
      const row = document.getElementById(`dl-ep-${ep.id}`);
      if (row) {
        const prevStatus = row.dataset.status;
        if (prevStatus !== ep.status) {
          // Status changed — re-render from scratch to avoid animation artifacts.
          row.outerHTML = renderDLRow(ep);
        } else if (ep.status === "downloading") {
          // Status unchanged and actively downloading — update just the fill width.
          // Prefer the in-memory value (updated every chunk) over the DB value
          // (committed every 5%) so all concurrent downloads animate correctly.
          const fill = row.querySelector(".progress-fill");
          if (fill) {
            const pct = activeProgress[String(ep.id)] ?? ep.download_progress;
            fill.style.width = `${pct}%`;
          }
        }
        // "queued → queued": CSS animation owns the fill; badge text doesn't change. No-op.
      } else {
        // Override DB progress with in-memory value so a newly-appearing row
        // starts at the real current position rather than the last 5% commit.
        const liveEp = activeProgress[String(ep.id)] != null
          ? { ...ep, download_progress: activeProgress[String(ep.id)] }
          : ep;
        list.insertAdjacentHTML("beforeend", renderDLRow(liveEp));
        const newRow = document.getElementById(`dl-ep-${ep.id}`);
        if (newRow) newRow.classList.add("entering");
      }
    }

    // Re-sort DOM rows only when the order has actually changed.
    // Exclude rows that are completing/animating away (not in activeIds) so that
    // a finishing row doesn't get stranded at the top while the others are
    // appended below it.
    const currentOrder = [...list.querySelectorAll(".episode-item")]
      .filter((r) => activeIds.has(Number(r.id.replace("dl-ep-", ""))))
      .map((r) => Number(r.id.replace("dl-ep-", "")));
    const desiredOrder = inProgress.map((e) => e.id);
    const orderChanged = currentOrder.length !== desiredOrder.length ||
      desiredOrder.some((id, i) => id !== currentOrder[i]);
    if (orderChanged) {
      for (const ep of inProgress) {
        const row = document.getElementById(`dl-ep-${ep.id}`);
        if (row) list.appendChild(row);
      }
    }

    // Update "N in progress" label
    const countLabel = document.getElementById("dl-inprogress-count");
    if (countLabel) countLabel.textContent = `${trueTotal} in progress`;

  } catch (_) { /* ignore poll errors */ }
}

function _startDLPoll() {
  _doPollTick(); // fire immediately — no stale data on tab switch
  _dlPollInterval = setInterval(_doPollTick, 2000);
}

function renderDLRow(ep) {
  const imgSrc = ep.custom_image_url || ep.episode_image_url || ep.feed_image_url || "";
  const progressHTML = (ep.status === "downloading" || ep.status === "queued")
    ? `<div class="progress-bar"><div class="progress-fill" style="width:${ep.status === "downloading" ? ep.download_progress : 0}%"></div></div>`
    : "";

  let actionBtn = "";
  if ((ep.status === "pending" || ep.status === "failed") && ep.enclosure_url) {
    actionBtn = `<button class="btn btn-ghost btn-sm" onclick="queueEpisodeDL(${ep.id})">
      ${svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>')}
      Download
    </button>`;
  } else if (ep.status === "queued" || ep.status === "downloading") {
    actionBtn = `<button class="btn btn-ghost btn-sm btn-icon" title="Cancel download" onclick="cancelEpisodeDL(${ep.id})">
      ${svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}
    </button>`;
  } else if (ep.status === "failed") {
    actionBtn = `<div style="display:flex;gap:4px">
      ${ep.enclosure_url ? `<button class="btn btn-ghost btn-sm" onclick="queueEpisodeDL(${ep.id})" title="Retry">
        ${svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/>')}
      </button>` : ""}
      <button class="btn btn-ghost btn-sm btn-icon" onclick="dismissEpisodeDL(${ep.id})" title="Remove">
        ${svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}
      </button>
    </div>`;
  } else if (ep.status === "downloaded") {
    actionBtn = `<button class="btn btn-danger btn-sm" onclick="deleteEpisodeFileDL(${ep.id})">
      ${svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>')}
      Delete
    </button>`;
  }

  return `<div class="episode-item" id="dl-ep-${ep.id}" data-status="${ep.status}">
    <div class="episode-art">
      ${imgSrc
        ? `<img src="${imgSrc}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="episode-art-placeholder" style="display:none">${_PODCAST_SVG}</div>`
        : `<div class="episode-art-placeholder">${_PODCAST_SVG}</div>`}
    </div>
    <div class="episode-info">
      <div class="episode-title">${ep.title || "Untitled"}</div>
      <div class="episode-meta">
        ${ep.feed_title ? `<span style="color:var(--primary)">${ep.feed_title}</span>` : ""}
        <span>${fmt(ep.published_at, ep.date_is_approximate)}</span>
        ${ep.file_size ? `<span>${fmtBytes(ep.file_size)}</span>` : ""}
        ${statusBadge(ep.status)}
        ${ep.error_message ? `<span style="color:var(--error);cursor:default" title="${ep.error_message.replace(/"/g, "&quot;")}">⚠</span>` : ""}
      </div>
      ${progressHTML}
    </div>
    <div class="episode-actions">${actionBtn}</div>
  </div>`;
}

function renderDLList(episodes) {
  if (episodes.length === 0) {
    return `<div class="empty-state">
      <div class="empty-state-icon">🎙️</div>
      <div class="empty-state-title">Nothing here yet</div>
    </div>`;
  }
  return episodes.map(renderDLRow).join("");
}

window.downloadFeedFromDL = async function (feedId, mode, btn) {
  btn.disabled = true;
  try {
    const r = mode === "unplayed"
      ? await API.downloadUnplayedFeed(feedId)
      : await API.downloadAllFeed(feedId);
    const label = mode === "unplayed" ? "unplayed episode" : "episode";
    Toast.info(`Queued ${r.queued} ${label}${r.queued !== 1 ? "s" : ""} for download`);
    updateStatus();
    // Animate the row away and patch badge/subtitle in-place from cache — no full re-render.
    animateRemove(btn.closest(".episode-item"));
    if (window._dlData?.available) {
      window._dlData.available = window._dlData.available.filter((f) => f.id !== feedId);
      const totalAvail = window._dlData.available.reduce((s, f) => s + f.available_count, 0);
      const sub = document.getElementById("dl-subtitle");
      if (sub) {
        const inProg = (window._dlData.status?.active_downloads ?? 0) + (window._dlData.status?.download_queue_size ?? 0);
        sub.textContent = `${totalAvail} available · ${inProg} in progress`;
      }
      const availBtn = document.querySelector('.tab-btn[data-tab="available"]');
      if (availBtn) {
        availBtn.innerHTML = totalAvail > 0
          ? `Available <span class="badge badge-primary" style="margin-left:4px">${totalAvail}</span>`
          : "Available";
      }
    }
  } catch (e) {
    btn.disabled = false;
    Toast.error(e.message);
  }
};

window.queueEpisodeDL = async function (id) {
  try {
    await API.downloadEpisode(id);
    Toast.info("Queued for download");
    updateStatus();
    animateRemove(document.getElementById(`dl-ep-${id}`), _checkTabListEmpty);
    if (window._dlData) {
      window._dlData.failed    = (window._dlData.failed    || []).filter((e) => e.id !== id);
      window._dlData.downloaded = (window._dlData.downloaded || []).filter((e) => e.id !== id);
    }
    // Re-sync the failed badge from the now-updated _dlData array — this is more reliable
    // than parsing and decrementing the badge's text content.
    if (window._dlActiveTab === "failed") {
      _setTabBadge("badge-failed", (window._dlData?.failed || []).length, "badge-error");
    }
  } catch (e) { Toast.error(e.message); }
};

window.cancelEpisodeDL = async function (id) {
  try {
    await API.cancelEpisode(id);
    animateRemove(document.getElementById(`dl-ep-${id}`));
  } catch (e) { Toast.error(e.message); }
};

window.dismissEpisodeDL = async function (id) {
  try {
    await API.dismissFailed(id);
    if (window._dlData) {
      window._dlData.failed = (window._dlData.failed || []).filter((e) => e.id !== id);
    }
    animateRemove(document.getElementById(`dl-ep-${id}`), () => {
      // Re-sync badge from the already-updated _dlData array once the row has gone,
      // then show the empty state if this was the last item.
      _setTabBadge("badge-failed", (window._dlData?.failed || []).length, "badge-error");
      _checkTabListEmpty();
    });
  } catch (e) { Toast.error(e.message); }
};

window.deleteEpisodeFileDL = async function (id) {
  if (!confirm("Delete the downloaded file?")) return;
  try {
    await API.deleteEpisodeFile(id);
    Toast.success("File deleted");
    if (window._dlData) {
      window._dlData.downloaded = (window._dlData.downloaded || []).filter((e) => e.id !== id);
    }
    animateRemove(document.getElementById(`dl-ep-${id}`), _checkTabListEmpty);
  } catch (e) { Toast.error(e.message); }
};
