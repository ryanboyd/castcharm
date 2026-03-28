"use strict";

// ============================================================
// Feeds list view
// ============================================================
let _feedsData = [];
let _feedsSort = localStorage.getItem("feeds_sort") || "az";

const _FEED_SORTS = [
  { value: "az",       label: "A–Z"             },
  { value: "za",       label: "Z–A"             },
  { value: "episodes", label: "Most episodes"   },
  { value: "unplayed", label: "Most unplayed"   },
  { value: "backlog",  label: "Backlog %"        },
  { value: "synced",   label: "Recently synced" },
  { value: "added",    label: "Date added"      },
];

function _sortFeeds(feeds) {
  const s = [...feeds];
  switch (_feedsSort) {
    case "az":       s.sort((a, b) => (a.title || "").localeCompare(b.title || ""));  break;
    case "za":       s.sort((a, b) => (b.title || "").localeCompare(a.title || ""));  break;
    case "episodes": s.sort((a, b) => b.episode_count - a.episode_count);             break;
    case "unplayed": s.sort((a, b) => b.unplayed_count - a.unplayed_count);           break;
    case "backlog": {
      const bp = f => f.downloaded_count > 0 ? f.unplayed_count / f.downloaded_count : 0;
      s.sort((a, b) => bp(b) - bp(a));
      break;
    }
    case "synced": s.sort((a, b) => (b.last_checked || "").localeCompare(a.last_checked || "")); break;
    case "added":  s.sort((a, b) => (b.created_at  || "").localeCompare(a.created_at  || "")); break;
  }
  return s;
}

function _flipReorderGrid(sortedFeeds) {
  const grid = document.getElementById("feeds-grid");
  if (!grid) return;

  const cards = [...grid.querySelectorAll(".feed-card")];
  if (cards.length < 2) return;

  // 1. Snapshot current positions
  const oldRects = new Map();
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    oldRects.set(c.dataset.id, { top: r.top, left: r.left });
  }

  // 2. Re-order DOM (append each in new order — moves to end of grid)
  for (const feed of sortedFeeds) {
    const card = grid.querySelector(`.feed-card[data-id="${feed.id}"]`);
    if (card) grid.appendChild(card);
  }

  // 3. Apply inverse transforms so cards appear to stay in old positions
  for (const card of cards) {
    const old = oldRects.get(card.dataset.id);
    if (!old || card.style.display === "none") continue;
    const nr = card.getBoundingClientRect();
    const dx = old.left - nr.left;
    const dy = old.top  - nr.top;
    if (dx !== 0 || dy !== 0) {
      card.style.transition = "none";
      card.style.transform  = `translate(${dx}px, ${dy}px)`;
    }
  }

  // 4. Force reflow then let them slide to their new positions
  grid.offsetHeight;
  for (const card of cards) {
    if (card.style.transform) {
      card.style.transition = "transform 0.32s cubic-bezier(0.25, 0.8, 0.25, 1)";
      card.style.transform  = "";
    }
  }
  setTimeout(() => {
    for (const card of grid.querySelectorAll(".feed-card")) {
      card.style.transition = "";
    }
  }, 350);
}

async function _refreshFeedsGrid() {
  const feeds = await API.getFeeds();
  _feedsData = feeds;
  const grid = document.getElementById("feeds-grid");
  if (!grid) {
    // No grid means we're either on the empty state or have navigated away.
    // Only re-render if we're still on the feeds route — a stale in-flight call
    // must not overwrite another page's content.
    if ((window.location.hash || "#/") === "#/feeds") await viewFeeds();
    return;
  }
  grid.innerHTML = _sortFeeds(feeds).map(feedCard).join("");
  const sub = document.querySelector(".page-subtitle");
  if (sub) sub.textContent = `${feeds.length} podcast${feeds.length !== 1 ? "s" : ""}`;
}

function _feedCardMeta(f) {
  return `
    <span class="badge badge-default">${f.episode_count} eps</span>
    <span class="badge badge-success">${f.downloaded_count} downloaded</span>
    <span class="badge ${f.unplayed_count > 0 ? "badge-primary" : "badge-default"}">${f.unplayed_count} unplayed</span>
    ${!f.active ? `<span class="badge badge-default">Paused</span>` : ""}
    ${f.last_error ? `<span class="badge badge-error" title="${f.last_error}">Error</span>` : ""}`;
}

// Patch just the badge counts on each card without re-rendering or re-sorting.
async function _patchFeedCounts() {
  const grid = document.getElementById("feeds-grid");
  if (!grid) return;
  try {
    const feeds = await API.getFeeds();
    _feedsData = feeds;
    for (const f of feeds) {
      const meta = grid.querySelector(`.feed-card[data-id="${f.id}"] .feed-card-meta`);
      if (meta) meta.innerHTML = _feedCardMeta(f);
    }
  } catch (_) {}
}

async function viewFeeds() {
  // Refresh feed cards automatically when background activity finishes.
  window._onSyncIdle    = _refreshFeedsGrid;
  window._onDownloadIdle = _refreshFeedsGrid;
  // Patch counts on every poll tick while downloads are in progress.
  window._onStatusPoll  = (s) => {
    if ((s.active_downloads ?? 0) > 0 || (s.download_queue_size ?? 0) > 0) _patchFeedCounts();
  };

  const feeds = await API.getFeeds();
  _feedsData = feeds;
  const content = document.getElementById("content");

  content.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-title">Feeds</div>
          <div class="page-subtitle">${feeds.length} podcast${feeds.length !== 1 ? "s" : ""}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost" id="btn-sync-all">
            ${svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>')}
            Sync All
          </button>
          <button class="btn btn-ghost" id="btn-scan-folders" title="Scan downloads folder for unrecognized podcast folders">
            ${svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>')}
            Scan Downloads
          </button>
          <a class="btn btn-ghost" href="${API.exportOpml()}" download>
            ${svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>')}
            Export OPML
          </a>
          <label class="btn btn-ghost" style="cursor:pointer" title="Import OPML file">
            ${svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>')}
            Import OPML
            <input type="file" accept=".opml,.xml" id="opml-file-input" style="display:none" />
          </label>
          <button class="btn btn-primary" id="btn-add-feed">
            ${svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>')}
            Add Podcast
          </button>
        </div>
      </div>

      <div class="search-bar" style="display:flex;align-items:center;gap:8px">
        <div class="search-input-wrap" style="flex:1">
          ${svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>')}
          <input class="form-control" id="feed-search" placeholder="Search feeds…" oninput="filterFeedCards()" />
        </div>
        <select class="form-control" id="feed-sort" style="flex-shrink:0;width:auto" title="Sort order">
          ${_FEED_SORTS.map(o => `<option value="${o.value}"${_feedsSort === o.value ? " selected" : ""}>${o.label}</option>`).join("")}
        </select>
      </div>

      ${feeds.length === 0
        ? `<div class="empty-state">
            <div class="empty-state-icon">🎙</div>
            <div class="empty-state-title">No feeds yet</div>
            <div class="empty-state-desc">Add a podcast to get started, or scan your downloads folder if you already have files.</div>
            <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
              <button class="btn btn-primary" id="btn-add-feed-empty">Add Your First Podcast</button>
              <button class="btn btn-ghost" id="btn-scan-folders-empty" title="Look for existing podcast folders in your downloads directory">
                ${svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>')} Scan Downloads Folder
              </button>
            </div>
          </div>`
        : `<div class="feeds-grid" id="feeds-grid">
            ${_sortFeeds(feeds).map(feedCard).join("")}
          </div>`}
    </div>`;

  document.getElementById("btn-add-feed")?.addEventListener("click", showAddFeedModal);
  document.getElementById("btn-add-feed-empty")?.addEventListener("click", showAddFeedModal);

  document.getElementById("feed-sort")?.addEventListener("change", (e) => {
    _feedsSort = e.target.value;
    localStorage.setItem("feeds_sort", _feedsSort);
    _flipReorderGrid(_sortFeeds(_feedsData));
  });

  async function doScanFolders(btn) {
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.textContent = "Scanning…";
    try {
      const r = await API.scanFolders();
      if (r.created > 0) {
        Toast.success(`Found ${r.created} new podcast folder${r.created !== 1 ? "s" : ""} — importing files in the background.`);
        await _refreshFeedsGrid();
      } else {
        Toast.success("No new podcast folders found in the downloads directory.");
      }
    } catch (err) {
      Toast.error(err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }
  document.getElementById("btn-scan-folders-empty")?.addEventListener("click", (e) => doScanFolders(e.currentTarget));

  document.getElementById("btn-scan-folders")?.addEventListener("click", (e) => doScanFolders(e.currentTarget));

  document.getElementById("opml-file-input")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      const r = await API.importOpml(file);
      Toast.success(`Imported ${r.added} feed${r.added !== 1 ? "s" : ""}${r.skipped > 0 ? `, ${r.skipped} already present` : ""}${r.failed > 0 ? `, ${r.failed} failed` : ""}`);
      if (r.added > 0) await _refreshFeedsGrid();
    } catch (err) { Toast.error(err.message); }
  });
  // Feed card quick actions (sync / delete) via event delegation
  document.getElementById("feeds-grid")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    e.stopPropagation(); // don't navigate to feed detail
    const id = parseInt(btn.dataset.id, 10);

    if (btn.dataset.action === "sync") {
      btn.disabled = true;
      try {
        await API.syncFeed(id);
        Toast.success("Sync started");
        updateStatus();
      } catch (err) {
        Toast.error(err.message);
      } finally {
        btn.disabled = false;
      }
    }

    if (btn.dataset.action === "delete") {
      const title = btn.dataset.title || "this feed";
      Modal.open("Delete Feed", `
        <p style="margin:0 0 14px">Delete <strong>${title}</strong>?</p>
        <label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;cursor:pointer;margin-bottom:20px">
          <input type="checkbox" id="del-files-chk" style="margin-top:2px" />
          <span>Also delete all downloaded files and folders</span>
        </label>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
          <button class="btn btn-danger" id="btn-confirm-delete">Delete</button>
        </div>
      `, () => {
        document.getElementById("btn-confirm-delete")?.addEventListener("click", async () => {
          const deleteFiles = document.getElementById("del-files-chk")?.checked ?? false;
          Modal.close();
          try {
            await API.deleteFeed(id, deleteFiles);
            Toast.success("Feed deleted");
            await _refreshFeedsGrid();
          } catch (err) {
            Toast.error(err.message);
          }
        });
      });
    }
  });

  document.getElementById("btn-sync-all")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Syncing…";
    try {
      await API.syncAllFeeds();
      updateStatus();
      Toast.success("Sync started for all active feeds");
    } catch (err) {
      Toast.error(err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>')} Sync All`;
    }
  });
}

function feedCard(f) {
  return `<div class="feed-card"
               data-id="${f.id}"
               data-title="${(f.title || "").toLowerCase()}"
               data-author="${(f.author || "").toLowerCase()}"
               onclick="if (!event.target.closest('[data-action]')) Router.navigate('/feeds/${f.id}')">
    <div class="feed-card-art">${artImg(f.custom_image_url || f.image_url, "", "", !f.active)}</div>
    <div class="feed-card-title">${f.title || f.url}</div>
    <div class="feed-card-author">${f.author || "Unknown author"}</div>
    <div class="feed-card-meta">${_feedCardMeta(f)}</div>
    <div class="feed-card-overlay">
      <button class="feed-card-action" data-action="sync" data-id="${f.id}" title="Sync this feed">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
          <polyline points="23 4 23 10 17 10"/>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
      </button>
      <button class="feed-card-action feed-card-action-delete" data-action="delete" data-id="${f.id}" data-title="${(f.title || f.url).replace(/"/g, '&quot;')}" title="Delete this feed">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>
    </div>
  </div>`;
}

window.filterFeedCards = function () {
  const q = document.getElementById("feed-search")?.value.toLowerCase() || "";
  for (const card of document.querySelectorAll(".feed-card")) {
    const match =
      card.dataset.title.includes(q) || card.dataset.author.includes(q);
    card.style.display = match ? "" : "none";
  }
};

function showAddFeedModal() {
  // Persisted across wizard steps
  const S = { url: "", title: "", dir: "", rename: true, byYear: true, datePfx: true, epPfx: true, downloadAll: false };

  const IC = {
    rss:    '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    back:   '<polyline points="15 18 9 12 15 6"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    info:   '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  };

  function _card(id, icon, title, desc) {
    return `<button id="${id}" class="wizard-card">
      <div class="wizard-card-icon">${svg(icon, 'width="20" height="20"')}</div>
      <div>
        <div class="wizard-card-title">${title}</div>
        <div class="wizard-card-desc">${desc}</div>
      </div>
    </button>`;
  }

  function _back() {
    return `<button id="btn-wiz-back" class="wiz-back-btn">${svg(IC.back,'width="13" height="13"')} Back</button>`;
  }

  function _orgOpts(pfx) {
    const chk = (id, label, checked) =>
      `<label class="wiz-check"><input type="checkbox" id="${id}" ${checked?"checked":""} />${label}</label>`;
    return `
      ${chk(`${pfx}-by-year`,  "Organize into year subfolders",      S.byYear)}
      ${chk(`${pfx}-date-pfx`, "Include date prefix in filenames",   S.datePfx)}
      ${chk(`${pfx}-ep-pfx`,   "Include episode number in filenames", S.epPfx)}`;
  }

  function _saveOrg(b, pfx) {
    S.byYear  = b.querySelector(`#${pfx}-by-year`)?.checked  ?? S.byYear;
    S.datePfx = b.querySelector(`#${pfx}-date-pfx`)?.checked ?? S.datePfx;
    S.epPfx   = b.querySelector(`#${pfx}-ep-pfx`)?.checked   ?? S.epPfx;
  }

  function _triggerImport(feedId, dir, rename, delay = 0) {
    setTimeout(async () => {
      try {
        await API.importFiles(feedId, dir, {
          renameFiles: rename, organizeByYear: rename ? S.byYear : null,
          datePrefix: rename ? S.datePfx : null, epNumPrefix: rename ? S.epPfx : null,
          saveAsDefaults: rename,
        });
      } catch (e) { Toast.error("Import error: " + e.message); }
    }, delay);
  }

  function goTo(step) {
    document.getElementById("modal-title").textContent =
      step === "type" ? "Add a Podcast" : step === "rss" ? "Add by Feed URL" : "Offline / No RSS Feed";
    const B = document.getElementById("modal-body");

    // ── Step 1: choose type ──────────────────────────────────────────────
    if (step === "type") {
      B.innerHTML = `
        <p style="color:var(--text-2);font-size:13px;margin:0 0 14px">How would you like to add this podcast?</p>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px">
          ${_card("pick-rss",  IC.rss,    "I have a feed URL",
            "Subscribe to an RSS or Atom feed. CastCharm syncs new episodes automatically — this is the most common option.")}
          ${_card("pick-off",  IC.folder, "I have audio files but no feed",
            "Import files for an archived or defunct podcast. No RSS required — CastCharm reads metadata from your files.")}
        </div>
        <div class="modal-actions" style="padding-top:0;border:none">
          <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        </div>`;
      B.querySelector("#pick-rss").addEventListener("click", () => goTo("rss"));
      B.querySelector("#pick-off").addEventListener("click", () => goTo("offline"));
    }

    // ── Step 2a: RSS URL ─────────────────────────────────────────────────
    else if (step === "rss") {
      B.innerHTML = `
        ${_back()}
        <div class="form-group">
          <label class="form-label">RSS or Atom feed URL</label>
          <input class="form-control" id="rss-url" type="url" value="${S.url}" placeholder="https://feeds.example.com/podcast.xml" autocomplete="off" />
          <div class="form-hint" style="margin-top:5px">Paste the podcast's feed URL. CastCharm fetches episode details and starts syncing immediately.</div>
        </div>
        <details style="margin-bottom:16px" ${S.dir?"open":""}>
          <summary style="cursor:pointer;font-size:13px;color:var(--text-3);user-select:none;padding:4px 0">
            I also have existing audio files to import from a different location
          </summary>
          <div class="wiz-info-box">
            <p style="font-size:12px;color:var(--text-3);margin:0 0 10px;line-height:1.5">
              ${svg(IC.info,'width="13" height="13" style="display:inline;vertical-align:-2px;margin-right:4px;color:var(--primary)"')}
              If files are <em>already in your downloads folder</em>, CastCharm detects them automatically — skip this. Only use it for files stored elsewhere.
            </p>
            <div class="form-group" style="margin-bottom:10px">
              <label class="form-label">External directory</label>
              <input class="form-control" id="rss-ext-dir" type="text" value="${S.dir}" placeholder="/path/to/audio/files" />
            </div>
            <div id="rss-ext-opts" style="display:${S.dir?"":"none"}">
              <label class="wiz-rename-label">
                <input type="checkbox" id="rss-chk-rename" ${S.rename?"checked":""} />
                Copy &amp; organize files into the downloads folder
              </label>
              <div id="rss-org-opts" class="wiz-indent" style="display:${S.rename?"":"none"}">${_orgOpts("rss")}</div>
            </div>
          </div>
        </details>
        <label class="wiz-rename-label" style="margin-bottom:14px">
          <input type="checkbox" id="rss-chk-dl-all" ${S.downloadAll?"checked":""} />
          Download all available episodes
          <span style="font-weight:400;color:var(--text-3);font-size:12px;display:block;padding-left:23px;margin-top:2px">Queue every existing episode once the feed syncs. You can also do this later from the feed page.</span>
        </label>
        <div id="rss-err" style="color:var(--error);font-size:13px;display:none;margin-bottom:8px"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
          <button class="btn btn-primary" id="btn-add-rss">Add Podcast</button>
        </div>`;

      const urlIn   = B.querySelector("#rss-url");
      const dirIn   = B.querySelector("#rss-ext-dir");
      const extOpts = B.querySelector("#rss-ext-opts");
      const chkRen  = B.querySelector("#rss-chk-rename");
      const orgOpts = B.querySelector("#rss-org-opts");
      const chkDlAll = B.querySelector("#rss-chk-dl-all");
      const errEl   = B.querySelector("#rss-err");

      urlIn.addEventListener("input",   (e) => { S.url = e.target.value; });
      dirIn.addEventListener("input",   (e) => { S.dir = e.target.value.trim(); extOpts.style.display = S.dir ? "" : "none"; });
      chkRen?.addEventListener("change", (e) => { S.rename = e.target.checked; orgOpts.style.display = S.rename ? "" : "none"; });
      chkDlAll?.addEventListener("change", (e) => { S.downloadAll = e.target.checked; });
      B.querySelector("#btn-wiz-back").addEventListener("click", () => { S.url = urlIn.value; goTo("type"); });

      B.querySelector("#btn-add-rss").addEventListener("click", async () => {
        const url = urlIn.value.trim();
        if (!url) { urlIn.focus(); return; }
        _saveOrg(B, "rss");
        const downloadAll = chkDlAll?.checked ?? false;
        const btn = B.querySelector("#btn-add-rss");
        btn.disabled = true; btn.textContent = "Adding…"; errEl.style.display = "none";
        let feed;
        try { feed = await API.addFeed(url, downloadAll); }
        catch (e) { errEl.textContent = e.message; errEl.style.display = "block"; btn.disabled = false; btn.textContent = "Add Podcast"; return; }
        const dir = dirIn?.value.trim();
        const rename = chkRen?.checked ?? true;
        Modal.close();
        if (dir) {
          Toast.success("Podcast added — syncing and importing…");
          _triggerImport(feed.id, dir, rename, 2000);
        } else if (downloadAll) {
          Toast.success("Podcast added — syncing and queuing all episodes…");
        } else {
          Toast.success("Podcast added — syncing episodes…");
        }
        await _refreshFeedsGrid();
      });
      urlIn.focus();
    }

    // ── Step 2b: Offline ─────────────────────────────────────────────────
    else if (step === "offline") {
      B.innerHTML = `
        ${_back()}
        <div class="form-group">
          <label class="form-label">Podcast title</label>
          <input class="form-control" id="off-title" type="text" value="${S.title}" placeholder="My Archived Podcast" />
        </div>
        <div class="form-group">
          <label class="form-label">Audio files directory</label>
          <input class="form-control" id="off-dir" type="text" value="${S.dir}" placeholder="/path/to/audio/files" />
          <div id="off-dir-hint" class="wiz-dir-hint"></div>
        </div>
        <div id="off-copy-sec" class="wiz-info-box" style="display:none;margin-bottom:4px">
          <label class="wiz-rename-label">
            <input type="checkbox" id="off-chk-rename" ${S.rename?"checked":""} />
            Copy &amp; organize files into the downloads folder
          </label>
          <div id="off-org-opts" class="wiz-indent" style="display:${S.rename?"":"none"}">${_orgOpts("off")}</div>
        </div>
        <p class="wiz-safe-note">
          ${svg(IC.shield,'width="13" height="13"')}
          Your original files are never moved or deleted.
        </p>
        <div id="off-err" style="color:var(--error);font-size:13px;display:none;margin-bottom:8px"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
          <button class="btn btn-ghost" id="btn-off-skip" title="You can import files later from the feed page">Add without files</button>
          <button class="btn btn-primary" id="btn-add-off">Add &amp; Import</button>
        </div>`;

      const DL = "/downloads";
      const titleIn = B.querySelector("#off-title");
      const dirIn   = B.querySelector("#off-dir");
      const hintEl  = B.querySelector("#off-dir-hint");
      const copySec = B.querySelector("#off-copy-sec");
      const chkRen  = B.querySelector("#off-chk-rename");
      const orgOpts = B.querySelector("#off-org-opts");
      const errEl   = B.querySelector("#off-err");

      function updateHint() {
        const dir = dirIn.value.trim();
        if (!dir) { hintEl.innerHTML = ""; copySec.style.display = "none"; return; }
        copySec.style.display = "";
        const internal = dir === DL || dir.startsWith(DL + "/") || dir.startsWith(DL + "\\");
        if (internal) {
          hintEl.innerHTML = `<span style="color:var(--success)">&#10003; Inside your downloads folder — files are registered in place, no copying needed.</span>`;
          if (!chkRen.dataset.u) { chkRen.checked = false; S.rename = false; orgOpts.style.display = "none"; }
        } else {
          hintEl.innerHTML = `Files will be <strong>copied</strong> into your downloads folder — originals stay untouched.`;
          if (!chkRen.dataset.u) { chkRen.checked = true; S.rename = true; orgOpts.style.display = ""; }
        }
      }

      titleIn.addEventListener("input", (e) => { S.title = e.target.value; });
      dirIn.addEventListener("input",   (e) => { S.dir = e.target.value.trim(); updateHint(); });
      chkRen.addEventListener("change", (e) => { chkRen.dataset.u = "1"; S.rename = e.target.checked; orgOpts.style.display = S.rename ? "" : "none"; });
      B.querySelector("#btn-wiz-back").addEventListener("click", () => { S.title = titleIn.value; S.dir = dirIn.value.trim(); goTo("type"); });

      async function submit(withFiles) {
        const title = titleIn.value.trim();
        if (!title) { titleIn.focus(); return; }
        if (withFiles && !dirIn.value.trim()) { dirIn.focus(); return; }
        _saveOrg(B, "off");
        const addBtn  = B.querySelector("#btn-add-off");
        const skipBtn = B.querySelector("#btn-off-skip");
        addBtn.disabled = true; skipBtn.disabled = true; addBtn.textContent = "Adding…"; errEl.style.display = "none";
        let feed;
        try { feed = await API.addManualFeed(title); }
        catch (e) { errEl.textContent = e.message; errEl.style.display = "block"; addBtn.disabled = false; skipBtn.disabled = false; addBtn.textContent = "Add & Import"; return; }
        const dir = dirIn.value.trim();
        Modal.close();
        if (withFiles && dir) {
          Toast.success("Podcast added — starting import…");
          _triggerImport(feed.id, dir, chkRen.checked, 0);
        } else {
          Toast.success("Podcast added. Use \"Import from Path\u2026\" on the feed page to add files later.");
        }
        await _refreshFeedsGrid();
      }

      B.querySelector("#btn-add-off").addEventListener("click",  () => submit(true));
      B.querySelector("#btn-off-skip").addEventListener("click", () => submit(false));
      updateHint();
      titleIn.focus();
    }
  }

  Modal.open("Add a Podcast", "", () => goTo("type"));
}
