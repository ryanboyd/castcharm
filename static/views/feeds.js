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
    ${f.last_error ? `<span class="badge badge-error" title="${escHTML(f.last_error)}">Sync error</span>` : ""}`;
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

function _setCardPip(card, dl, sy) {
  let pip = card.querySelector(".feed-card-activity");
  if (!dl && !sy) { pip?.remove(); return; }
  if (!pip) {
    pip = document.createElement("div");
    pip.className = "feed-card-activity";
    pip.addEventListener("click", (e) => {
      e.stopPropagation();
      window._pendingDLTab = "inprogress";
      Router.navigate("/downloads");
    });
    card.querySelector(".feed-card-meta")?.insertAdjacentElement("afterend", pip) ?? card.appendChild(pip);
  }
  const dlHTML = dl ? `<div class="feed-card-pip pip-downloading" title="Downloading">${svg('<path d="M12 3v13"/><polyline points="8 12 12 16 16 12"/><path d="M20 21H4"/>', 'width="12" height="12"')}</div>` : "";
  const syHTML = sy ? `<div class="feed-card-pip pip-syncing" title="Syncing">${svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>', 'width="12" height="12"')}</div>` : "";
  const next = dlHTML + syHTML;
  if (pip.innerHTML !== next) pip.innerHTML = next;
}

let _prevSyncIds = new Set();

async function _refreshFeedCard(feedId) {
  const grid = document.getElementById("feeds-grid");
  if (!grid) return;
  try {
    const f = await API.getFeed(feedId);
    const card = grid.querySelector(`.feed-card[data-id="${feedId}"]`);
    if (!card) return;
    const meta = card.querySelector(".feed-card-meta");
    if (meta) meta.innerHTML = _feedCardMeta(f);
  } catch (_) {}
}

function _updateFeedActivityPips(s) {
  const grid = document.getElementById("feeds-grid");
  if (!grid) return;
  const dlIds   = new Set(s.downloading_feed_ids || []);
  const syncIds = new Set(s.syncing_feed_ids || []);

  // Refresh any card that just finished syncing
  for (const id of _prevSyncIds) {
    if (!syncIds.has(id)) _refreshFeedCard(id);
  }
  _prevSyncIds = syncIds;

  for (const card of grid.querySelectorAll(".feed-card[data-id]")) {
    const id = Number(card.dataset.id);
    _setCardPip(card, dlIds.has(id), syncIds.has(id));
  }
}

async function viewFeeds() {
  _prevSyncIds = new Set();
  // Refresh feed cards automatically when background activity finishes.
  window._onSyncIdle    = _refreshFeedsGrid;
  window._onDownloadIdle = _refreshFeedsGrid;
  // Update per-card activity pips and patch counts on every poll tick.
  window._onStatusPoll  = (s) => {
    _updateFeedActivityPips(s);
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
            Sync All Feeds
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
            <div class="empty-state-desc">Add a podcast to get started.</div>
            <button class="btn btn-primary" id="btn-add-feed-empty">Add Your First Podcast</button>
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

  document.getElementById("opml-file-input")?.addEventListener("change", async (e) => {
    if (window._opmlImporting) return;
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    // Show waiting state immediately — capture DOM refs synchronously before the await
    Modal.open("Importing OPML", `
      <div class="opml-prog-status" id="opml-prog-status">Importing feeds…</div>
      <div class="opml-prog-log" id="opml-prog-log"></div>
      <div class="modal-actions" id="opml-prog-actions" style="display:none">
        <button class="btn btn-primary" onclick="Modal.close()">Done</button>
      </div>
    `);
    const log      = document.getElementById("opml-prog-log");
    const statusEl = document.getElementById("opml-prog-status");
    const actions  = document.getElementById("opml-prog-actions");
    window._opmlImporting = true;

    let r;
    try {
      r = await API.importOpml(file);
    } catch (err) {
      window._opmlImporting = false;
      Modal.close();
      Toast.error(err.message);
      return;
    }

    // Render per-feed result list
    if (log && r.results?.length) {
      for (const item of r.results) {
        const row = document.createElement("div");
        const [icon, cls, note] =
          item.status === "added"   ? ["✓", "opml-entry-ok",   ""]
        : item.status === "skipped" ? ["–", "opml-entry-skip", "already in library"]
        :                             ["✗", "opml-entry-fail",  item.error || "failed"];
        row.className = `opml-entry ${cls}`;
        row.innerHTML = `<span class="opml-entry-icon">${icon}</span>`
          + `<span class="opml-entry-label">${escHTML(item.title)}</span>`
          + (note ? `<span class="opml-entry-note">${escHTML(note)}</span>` : "");
        log.appendChild(row);
      }
    }

    const parts = [];
    if (r.added)   parts.push(`${r.added} added`);
    if (r.skipped) parts.push(`${r.skipped} already in library`);
    if (r.failed)  parts.push(`${r.failed} failed`);
    if (statusEl) statusEl.textContent = parts.length ? `Done — ${parts.join(", ")}` : "Nothing to import";
    if (actions)  actions.style.display = "";

    window._opmlImporting = false;

    if (r.added > 0) await _refreshFeedsGrid();
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
        const card = document.querySelector(`#feeds-grid .feed-card[data-id="${id}"]`);
        if (card) {
          _setCardPip(card, false, true);
          card.querySelector(".badge-error")?.remove();
        }
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

          // Immediately mark feed as deleting and overlay its card
          window._deletingFeedIds = window._deletingFeedIds || new Set();
          window._deletingFeedIds.add(id);
          const card = document.querySelector(`.feed-card[data-id="${id}"]`);
          if (card) {
            card.style.pointerEvents = "none";
            card.insertAdjacentHTML("beforeend", `
              <div class="feed-card-deleting" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);border-radius:inherit;z-index:10">
                <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" width="36" height="36" style="opacity:0.85">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                  <path d="M10 11v6"/><path d="M14 11v6"/>
                  <path d="M9 6V4h6v2"/>
                </svg>
              </div>
            `);
          }

          try {
            await API.deleteFeed(id, deleteFiles);
            Toast.success("Feed deleted");
            window._deletingFeedIds?.delete(id);
            await _refreshFeedsGrid();
          } catch (err) {
            // Restore card on failure
            window._deletingFeedIds?.delete(id);
            document.querySelector(`.feed-card[data-id="${id}"] .feed-card-deleting`)?.remove();
            const c = document.querySelector(`.feed-card[data-id="${id}"]`);
            if (c) c.style.pointerEvents = "";
            Toast.error(err.message);
          }
        });
      });
    }
  });

  wireSyncAllBtn("#btn-sync-all");

  document.getElementById("btn-sync-all")?.addEventListener("click", () => {
    const grid = document.getElementById("feeds-grid");
    if (!grid) return;
    const activeIds = new Set((_feedsData || []).filter(f => f.active).map(f => f.id));
    for (const card of grid.querySelectorAll(".feed-card[data-id]")) {
      if (activeIds.has(Number(card.dataset.id))) _setCardPip(card, false, true);
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
  const IC = {
    rss:    '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
    xml:    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="10 13 8 15 10 17"/><polyline points="14 13 16 15 14 17"/>',
    manual: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    back:   '<polyline points="15 18 9 12 15 6"/>',
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


  function goTo(step, data = {}) {
    const B = document.getElementById("modal-body");

    // ── Step 1: choose type ──────────────────────────────────────────────
    if (step === "type") {
      document.getElementById("modal-title").textContent = "Add a Podcast";
      B.innerHTML = `
        <p style="color:var(--text-2);font-size:13px;margin:0 0 14px">How would you like to add this podcast?</p>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px">
          ${_card("pick-rss", IC.rss, "RSS or Atom feed URL",
            "Subscribe with a feed link. CastCharm syncs new episodes automatically — the most common way to add a podcast.")}
          ${_card("pick-xml", IC.xml, "Upload a local RSS/XML file",
            "Have a saved feed file from a defunct podcast or private archive? Upload it to restore all episodes.")}
          ${_card("pick-manual", IC.manual, "No feed — manual podcast",
            "Create a podcast entry without a feed. Import episodes from files later via the feed page.")}
        </div>
        <div class="modal-actions" style="padding-top:0;border:none">
          <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        </div>`;
      B.querySelector("#pick-rss").addEventListener("click",    () => goTo("rss"));
      B.querySelector("#pick-xml").addEventListener("click",    () => goTo("xml"));
      B.querySelector("#pick-manual").addEventListener("click", () => goTo("manual"));
    }

    // ── Step 2a: RSS URL ─────────────────────────────────────────────────
    else if (step === "rss") {
      document.getElementById("modal-title").textContent = "Add by Feed URL";
      B.innerHTML = `
        <div class="form-group">
          <label class="form-label">RSS or Atom feed URL</label>
          <input class="form-control" id="rss-url" type="url" placeholder="https://feeds.example.com/podcast.xml" autocomplete="off" />
          <div class="form-hint" style="margin-top:5px">Paste the podcast's feed URL. Apple Podcasts links are resolved automatically.</div>
        </div>
        <label class="wiz-rename-label" style="margin-bottom:14px">
          <input type="checkbox" id="rss-chk-dl-all" />
          Download all available episodes
          <span style="font-weight:400;color:var(--text-3);font-size:12px;display:block;padding-left:23px;margin-top:2px">
            Queue every existing episode once the feed syncs. You can also do this later from the feed page.
          </span>
        </label>
        <div id="rss-err" style="color:var(--error);font-size:13px;display:none;margin-bottom:8px"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="btn-wiz-back">Back</button>
          <button class="btn btn-primary" id="btn-add-rss">Add Podcast</button>
        </div>`;

      const urlIn   = B.querySelector("#rss-url");
      const chkDlAll = B.querySelector("#rss-chk-dl-all");
      const errEl   = B.querySelector("#rss-err");
      B.querySelector("#btn-wiz-back").addEventListener("click", () => goTo("type"));

      async function submit() {
        const url = urlIn.value.trim();
        if (!url) { urlIn.focus(); return; }
        if (!/^https?:\/\//i.test(url)) {
          errEl.textContent = "URL must start with http:// or https://";
          errEl.style.display = "block";
          urlIn.focus();
          return;
        }
        const btn = B.querySelector("#btn-add-rss");
        btn.disabled = true; btn.textContent = "Adding…"; errEl.style.display = "none";
        let feed;
        try { feed = await API.addFeed(url, chkDlAll.checked); }
        catch (e) {
          if (e.conflict_title != null) {
            goTo("rss-rename", { url, downloadAll: chkDlAll.checked, conflictTitle: e.conflict_title });
            return;
          }
          errEl.textContent = e.message; errEl.style.display = "block";
          btn.disabled = false; btn.textContent = "Add Podcast"; return;
        }
        Modal.close();
        Toast.success(chkDlAll.checked
          ? "Podcast added — syncing and queuing all episodes…"
          : "Podcast added — syncing episodes…");
        await _refreshFeedsGrid();
      }

      B.querySelector("#btn-add-rss").addEventListener("click", submit);
      urlIn.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      urlIn.focus();
    }

    // ── Step 3a: RSS folder-name conflict rename ─────────────────────────
    else if (step === "rss-rename") {
      const { url, downloadAll, conflictTitle } = data;
      document.getElementById("modal-title").textContent = "Name Already In Use";
      B.innerHTML = `
        <p style="color:var(--text-2);font-size:13px;margin:0 0 14px;line-height:1.5">
          A podcast named <strong>${conflictTitle}</strong> already exists.
          Enter an alternative name for the new podcast's folder:
        </p>
        <div class="form-group">
          <input class="form-control" id="rss-rename-input" type="text" value="${conflictTitle}" autocomplete="off" />
          <div class="form-hint" style="margin-top:5px">This name is used as the folder name only — the podcast title from the feed is kept as-is.</div>
        </div>
        <div id="rss-rename-err" style="color:var(--error);font-size:13px;display:none;margin-bottom:8px"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="btn-wiz-back">Back</button>
          <button class="btn btn-primary" id="btn-rss-rename-confirm">Add Podcast</button>
        </div>`;
      const nameIn = B.querySelector("#rss-rename-input");
      const errEl2 = B.querySelector("#rss-rename-err");
      B.querySelector("#btn-wiz-back").addEventListener("click", () => goTo("rss"));
      nameIn.select();

      async function submitRename() {
        const altName = nameIn.value.trim();
        if (!altName) { nameIn.focus(); return; }
        const btn = B.querySelector("#btn-rss-rename-confirm");
        btn.disabled = true; btn.textContent = "Adding…"; errEl2.style.display = "none";
        let feed;
        try { feed = await API.addFeed(url, downloadAll, altName); }
        catch (e) {
          if (e.conflict_title != null) {
            errEl2.textContent = `"${e.conflict_title}" is also already in use — try a different name.`;
          } else {
            errEl2.textContent = e.message;
          }
          errEl2.style.display = "block";
          btn.disabled = false; btn.textContent = "Add Podcast"; return;
        }
        Modal.close();
        Toast.success(downloadAll
          ? "Podcast added — syncing and queuing all episodes…"
          : "Podcast added — syncing episodes…");
        await _refreshFeedsGrid();
      }

      B.querySelector("#btn-rss-rename-confirm").addEventListener("click", submitRename);
      nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") submitRename(); });
    }

    // ── Step 2b: Upload local RSS/XML file ───────────────────────────────
    else if (step === "xml") {
      document.getElementById("modal-title").textContent = "Add from Local RSS/XML File";
      B.innerHTML = `
        <p style="color:var(--text-2);font-size:13px;margin:0 0 14px;line-height:1.5">
          Upload a saved RSS/XML file to create a new podcast entry and restore all episodes from it.
          You can then import matching audio files from the feed page.
        </p>
        <div class="form-group">
          <label class="form-label">RSS/XML file</label>
          <input class="form-control" id="xml-file-input" type="file" accept=".xml,.rss,application/rss+xml,application/xml,text/xml" />
        </div>
        <div id="xml-err" style="color:var(--error);font-size:13px;display:none;margin-bottom:8px"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="btn-wiz-back">Back</button>
          <button class="btn btn-primary" id="btn-add-xml">Create Podcast</button>
        </div>`;

      const fileIn = B.querySelector("#xml-file-input");
      const errEl  = B.querySelector("#xml-err");
      B.querySelector("#btn-wiz-back").addEventListener("click", () => goTo("type"));

      B.querySelector("#btn-add-xml").addEventListener("click", async () => {
        const file = fileIn.files?.[0];
        if (!file) { fileIn.focus(); return; }
        const btn = B.querySelector("#btn-add-xml");
        btn.disabled = true; btn.textContent = "Importing…"; errEl.style.display = "none";
        let feed;
        try { feed = await API.createFeedFromXml(file); }
        catch (e) {
          if (e.conflict_title != null) {
            goTo("xml-rename", { file, conflictTitle: e.conflict_title });
            return;
          }
          errEl.textContent = e.message; errEl.style.display = "block";
          btn.disabled = false; btn.textContent = "Create Podcast"; return;
        }
        Modal.close();
        Toast.success(`"${feed.title}" created — ${feed.episode_count} episode${feed.episode_count !== 1 ? "s" : ""} imported from file.`);
        await _refreshFeedsGrid();
      });
    }

    // ── Step 3b: XML title conflict rename ───────────────────────────────
    else if (step === "xml-rename") {
      const { file, conflictTitle } = data;
      document.getElementById("modal-title").textContent = "Name Already In Use";
      B.innerHTML = `
        <p style="color:var(--text-2);font-size:13px;margin:0 0 14px;line-height:1.5">
          A podcast named <strong>${conflictTitle}</strong> already exists.
          Enter an alternative title for the new podcast:
        </p>
        <div class="form-group">
          <input class="form-control" id="xml-rename-input" type="text" value="${conflictTitle}" autocomplete="off" />
        </div>
        <div id="xml-rename-err" style="color:var(--error);font-size:13px;display:none;margin-bottom:8px"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="btn-wiz-back">Back</button>
          <button class="btn btn-primary" id="btn-xml-rename-confirm">Create Podcast</button>
        </div>`;
      const nameIn = B.querySelector("#xml-rename-input");
      const errEl2 = B.querySelector("#xml-rename-err");
      B.querySelector("#btn-wiz-back").addEventListener("click", () => goTo("xml"));
      nameIn.select();

      async function submitXmlRename() {
        const altTitle = nameIn.value.trim();
        if (!altTitle) { nameIn.focus(); return; }
        const btn = B.querySelector("#btn-xml-rename-confirm");
        btn.disabled = true; btn.textContent = "Importing…"; errEl2.style.display = "none";
        let feed;
        try { feed = await API.createFeedFromXml(file, altTitle); }
        catch (e) {
          if (e.conflict_title != null) {
            errEl2.textContent = `"${e.conflict_title}" is also already in use — try a different name.`;
          } else {
            errEl2.textContent = e.message;
          }
          errEl2.style.display = "block";
          btn.disabled = false; btn.textContent = "Create Podcast"; return;
        }
        Modal.close();
        Toast.success(`"${feed.title}" created — ${feed.episode_count} episode${feed.episode_count !== 1 ? "s" : ""} imported from file.`);
        await _refreshFeedsGrid();
      }

      B.querySelector("#btn-xml-rename-confirm").addEventListener("click", submitXmlRename);
      nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") submitXmlRename(); });
    }

    // ── Step 2c: Manual (no feed) ────────────────────────────────────────
    else if (step === "manual") {
      document.getElementById("modal-title").textContent = "Manual Podcast";
      B.innerHTML = `
        <div class="form-group">
          <label class="form-label">Podcast title</label>
          <input class="form-control" id="manual-title" type="text" placeholder="My Podcast" autocomplete="off" />
          <div class="form-hint" style="margin-top:5px">
            Creates a podcast entry with no RSS feed. Use <strong>Import Files</strong> on the feed page to add episodes from audio files.
          </div>
        </div>
        <div id="manual-err" style="color:var(--error);font-size:13px;display:none;margin-bottom:8px"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="btn-wiz-back">Back</button>
          <button class="btn btn-primary" id="btn-add-manual">Create Podcast</button>
        </div>`;

      const titleIn = B.querySelector("#manual-title");
      const errEl   = B.querySelector("#manual-err");
      B.querySelector("#btn-wiz-back").addEventListener("click", () => goTo("type"));

      async function submit() {
        const title = titleIn.value.trim();
        if (!title) { titleIn.focus(); return; }
        const btn = B.querySelector("#btn-add-manual");
        btn.disabled = true; btn.textContent = "Creating…"; errEl.style.display = "none";
        try { await API.addManualFeed(title); }
        catch (e) {
          errEl.textContent = e.conflict_title != null
            ? `A podcast named "${e.conflict_title}" already exists — choose a different title.`
            : e.message;
          errEl.style.display = "block";
          btn.disabled = false; btn.textContent = "Create Podcast"; return;
        }
        Modal.close();
        Toast.success("Podcast created. Open it to import audio files.");
        await _refreshFeedsGrid();
      }

      B.querySelector("#btn-add-manual").addEventListener("click", submit);
      titleIn.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      titleIn.focus();
    }
  }

  Modal.open("Add a Podcast", "", () => goTo("type"));
}
