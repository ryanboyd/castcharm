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
  if (e.target === document.getElementById("modal-overlay")) Modal.close();
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
    ? `<img src="${url}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
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
