"use strict";

// ============================================================
// Global search overlay  (Cmd/Ctrl+K or sidebar icon)
// ============================================================

let _searchTimer = null;

function showSearch() {
  let overlay = document.getElementById("search-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "search-overlay";
    overlay.innerHTML = `
      <div id="search-box">
        <div id="search-input-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               width="18" height="18" style="flex-shrink:0;color:var(--text-3)">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input id="search-input" type="text" placeholder="Search episodes…"
                 autocomplete="off" spellcheck="false" />
          <kbd id="search-esc-hint">Esc</kbd>
        </div>
        <div id="search-results"></div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) hideSearch();
    });
    document.getElementById("search-input").addEventListener("input", _onSearchInput);
    document.getElementById("search-input").addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideSearch();
      if (e.key === "ArrowDown") { e.preventDefault(); _moveFocus(1); }
      if (e.key === "ArrowUp")   { e.preventDefault(); _moveFocus(-1); }
      if (e.key === "Enter") {
        const active = document.querySelector(".search-result.search-focused");
        if (active) active.click();
      }
    });
  }

  overlay.style.display = "flex";
  const inp = document.getElementById("search-input");
  inp.value = "";
  document.getElementById("search-results").innerHTML = "";
  requestAnimationFrame(() => inp.focus());
}

function hideSearch() {
  const overlay = document.getElementById("search-overlay");
  if (overlay) overlay.style.display = "none";
  clearTimeout(_searchTimer);
}

function _onSearchInput() {
  clearTimeout(_searchTimer);
  const q = document.getElementById("search-input").value.trim();
  if (!q) {
    document.getElementById("search-results").innerHTML = "";
    return;
  }
  _searchTimer = setTimeout(() => _doSearch(q), 280);
}

async function _doSearch(q) {
  const container = document.getElementById("search-results");
  if (!container) return;
  container.innerHTML = `<div class="search-empty">Searching…</div>`;
  try {
    const eps = await API.getEpisodes({ search: q, limit: 40 });
    if (!eps.length) {
      container.innerHTML = `<div class="search-empty">No results for <strong>${escHTML(q)}</strong></div>`;
      return;
    }
    container.innerHTML = eps.map((ep) => {
      const feedTitle = ep.feed_title || "";
      const date      = ep.published_at ? fmt(ep.published_at) : "";
      return `<div class="search-result" tabindex="-1"
                   data-action="search-navigate" data-ep-id="${ep.id}" data-feed-id="${ep.feed_id}">
        <div class="search-result-title">${escHTML(ep.title || "Untitled")}</div>
        <div class="search-result-meta">
          <span class="search-result-feed">${escHTML(feedTitle)}</span>
          ${date ? `<span class="search-result-date">${date}</span>` : ""}
          ${statusBadge(ep.status)}
        </div>
      </div>`;
    }).join("");
  } catch (_) {
    container.innerHTML = `<div class="search-empty">Search failed — try again</div>`;
  }
}

function _moveFocus(dir) {
  const items = [...document.querySelectorAll(".search-result")];
  if (!items.length) return;
  const cur = document.querySelector(".search-result.search-focused");
  let idx = items.indexOf(cur) + dir;
  if (idx < 0) idx = items.length - 1;
  if (idx >= items.length) idx = 0;
  items.forEach((el) => el.classList.remove("search-focused"));
  items[idx].classList.add("search-focused");
  items[idx].scrollIntoView({ block: "nearest" });
}

