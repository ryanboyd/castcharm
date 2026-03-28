"use strict";

// ============================================================
// Logs view
// ============================================================
let _logsMinLevel = "WARNING";
let _logsPaused   = false;
let _logsRawMode  = false;
let _logsLastEntries = [];  // cached for download without extra fetch

async function viewLogs() {
  if (window._logsInterval) {
    clearInterval(window._logsInterval);
    window._logsInterval = null;
  }
  _logsPaused = false;

  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-title">Logs</div>
          <div class="page-subtitle">Application activity — most recent entries first</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-ghost btn-sm" id="btn-log-pause">Pause</button>
          <button class="btn btn-ghost btn-sm" id="btn-log-clear">Clear</button>
          <button class="btn btn-ghost btn-sm" id="btn-log-download" title="Download as .txt">↓ Download</button>
        </div>
      </div>

      <div class="log-toolbar">
        ${["INFO","WARNING","ERROR"].map((l) =>
          `<button class="log-level-btn ${l === _logsMinLevel ? "active" : ""}"
                   data-level="${l}" id="log-lvl-${l}">${l}</button>`
        ).join("")}
        <span style="flex:1"></span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text-2);user-select:none">
          <input type="checkbox" id="chk-raw-logs" ${_logsRawMode ? "checked" : ""}
                 style="width:14px;height:14px;cursor:pointer" />
          Raw
        </label>
        <span class="form-hint" style="margin:0;align-self:center" id="log-count"></span>
      </div>

      <div id="log-container" class="log-container">
        <div id="log-entries"></div>
      </div>
    </div>`;

  for (const level of ["INFO","WARNING","ERROR"]) {
    document.getElementById(`log-lvl-${level}`).addEventListener("click", () => {
      _logsMinLevel = level;
      document.querySelectorAll(".log-level-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.level === level);
      });
      _fetchAndRender(true);
    });
  }

  document.getElementById("btn-log-pause").addEventListener("click", () => {
    _logsPaused = !_logsPaused;
    document.getElementById("btn-log-pause").textContent = _logsPaused ? "Resume" : "Pause";
  });

  document.getElementById("btn-log-clear").addEventListener("click", () => {
    _logsLastEntries = [];
    const el = document.getElementById("log-entries");
    if (el) el.innerHTML = "";
    document.getElementById("log-count").textContent = "";
  });

  document.getElementById("btn-log-download").addEventListener("click", _downloadLogs);

  document.getElementById("chk-raw-logs").addEventListener("change", (e) => {
    _logsRawMode = e.target.checked;
    _renderEntries(_logsLastEntries);
  });

  await _fetchAndRender(true);

  window._logsInterval = setInterval(() => {
    if (!_logsPaused) _fetchAndRender();
  }, 4000);
}

async function _fetchAndRender(scrollBottom = false) {
  try {
    const level = _logsMinLevel;
    const entries = await API.getLogs(1000, level);
    _logsLastEntries = entries;
    _renderEntries(entries);
    const countEl = document.getElementById("log-count");
    if (countEl) countEl.textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
    if (scrollBottom) {
      const box = document.getElementById("log-container");
      if (box) box.scrollTop = 0;
    }
  } catch (_) {}
}

function _renderEntries(entries) {
  const container = document.getElementById("log-entries");
  if (!container) return;

  if (_logsRawMode) {
    // Render as a plain-text <pre>. textContent never interprets content as
    // HTML so this is safe regardless of what characters appear in log messages.
    const pre = document.createElement("pre");
    pre.className = "log-raw";
    pre.textContent = entries.map(_logLine).join("\n");
    container.replaceChildren(pre);
  } else {
    container.innerHTML = entries.map(_logRow).join("");
  }
}

// Plain-text line format: "2024-01-15 10:30:45 [WARNING] feeds: message text"
function _logLine(e) {
  const shortLogger = e.logger.replace(/^app\.routers\./, "").replace(/^app\./, "");
  return `${e.ts.replace("T", " ")} [${e.level.padEnd(7)}] ${shortLogger}: ${e.message}`;
}

function _logRow(e) {
  const cls = { DEBUG: "log-debug", INFO: "log-info", WARNING: "log-warn", ERROR: "log-error", CRITICAL: "log-error" }[e.level] || "";
  const shortLogger = e.logger.replace(/^app\.routers\./, "").replace(/^app\./, "");
  return `<div class="log-entry ${cls}">
    <span class="log-ts">${e.ts.replace("T", " ")}</span>
    <span class="log-level-tag">${e.level}</span>
    <span class="log-logger" title="${escHTML(e.logger)}">${escHTML(shortLogger)}</span>
    <span class="log-msg">${escHTML(e.message)}</span>
  </div>`;
}

function _downloadLogs() {
  const entries = _logsLastEntries;
  if (!entries.length) { Toast.info("No log entries to download"); return; }
  const text = entries.map(_logLine).join("\n") + "\n";
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `castcharm-logs-${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

