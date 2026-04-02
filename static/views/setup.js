"use strict";

// ============================================================
// First-run setup wizard  (full-page, not an overlay card)
// ============================================================

const _setupState = {
  step: 1,
  totalSteps: 5,
  enableAuth: false,
  username: "",
  password: "",
  confirmPassword: "",
  theme: "midnight",
  timezone: "UTC",
  downloadPath: "/downloads",
  filenameDatePrefix: true,
  filenameEpisodeNumber: true,
  organizeByYear: true,
  saveXml: true,
};

function showSetupWizard() {
  let el = document.getElementById("setup-overlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "setup-overlay";
    document.body.appendChild(el);
  }
  el.style.display = "block";
  _renderSetupStep();
}

function hideSetupOverlay() {
  const el = document.getElementById("setup-overlay");
  if (el) el.style.display = "none";
}

// ── Step renderer ──────────────────────────────────────────────────────────

function _renderSetupStep() {
  const el = document.getElementById("setup-overlay");
  if (!el) return;

  const s = _setupState;
  const isLast  = s.step === s.totalSteps;
  const isFirst = s.step === 1;

  // Step dots
  const dots = Array.from({ length: s.totalSteps }, (_, i) => {
    const n   = i + 1;
    const cls = n < s.step ? "wiz-dot-done" : n === s.step ? "wiz-dot-active" : "wiz-dot";
    const inner = n < s.step ? "✓" : String(n);
    return `<div class="${cls}">${inner}</div>${n < s.totalSteps ? '<div class="wiz-line"></div>' : ""}`;
  }).join("");

  el.innerHTML = `
    <div class="wiz-page">
      <div class="wiz-header">
        <img src="/static/icon-64.png" alt="" class="wiz-logo-img" />
        <div>
          <div class="wiz-logo-name">CastCharm</div>
          <div class="wiz-logo-sub">Setup — step ${s.step} of ${s.totalSteps}</div>
        </div>
      </div>

      <div class="wiz-dots">${dots}</div>

      <div id="wiz-body">${_stepBody(s.step)}</div>

      <div class="wiz-footer">
        ${isFirst
          ? `<button class="btn btn-ghost" id="wiz-skip">Skip</button>`
          : `<button class="btn btn-ghost" id="wiz-back">← Back</button>`}
        <button class="btn btn-primary" id="wiz-next" ${isFirst ? "disabled" : ""}>
          ${isLast ? "Finish setup" : "Next →"}
        </button>
      </div>
      <div id="wiz-error" class="wiz-error" style="display:none"></div>
    </div>`;

  document.getElementById("wiz-next").addEventListener("click", _wizardNext);
  document.getElementById("wiz-back")?.addEventListener("click", _wizardBack);

  if (s.step === 1) _initLoginStep();
  if (s.step === 3) _initTimezoneStep();
  if (s.step === 4) _loadDirBrowser(s.downloadPath);
}

function _stepBody(step) {
  switch (step) {
    case 1: return _stepLogin();
    case 2: return _stepTheme();
    case 3: return _stepTimezone();
    case 4: return _stepStorage();
    case 5: return _stepFileOptions();
    default: return "";
  }
}

// ── Step 1: Login ──────────────────────────────────────────────────────────

function _stepLogin() {
  return `
    <h2 class="wiz-title">Secure your instance</h2>
    <p class="wiz-desc">
      Set up a username and password to protect your library. If you're
      behind a reverse proxy with built-in auth (Authelia, Authentik, etc.)
      you can skip this step.
    </p>
    <div class="form-group">
      <label class="form-label">Username</label>
      <input class="form-control" id="wiz-username" type="text"
             autocomplete="username"
             value="${escHTML(_setupState.username)}" />
    </div>
    <div class="form-group">
      <label class="form-label">Password</label>
      <input class="form-control" id="wiz-password" type="password"
             autocomplete="new-password" placeholder="Minimum 8 characters" />
    </div>
    <div class="form-group">
      <label class="form-label">Confirm password</label>
      <input class="form-control" id="wiz-confirm" type="password"
             autocomplete="new-password" />
    </div>`;
}

// ── Step 2: Theme ──────────────────────────────────────────────────────────

function _stepTheme() {
  const buttons = Object.entries(THEMES).map(([id, t]) => {
    const active = _setupState.theme === id;
    return `<button type="button" data-theme-btn="${id}"
      data-action="wiz-select-theme" data-theme="${id}"
      class="theme-pick-btn"
      style="background:${t.bg2};border-color:${active ? t.primary : "transparent"}">
      <div style="width:24px;height:24px;border-radius:50%;background:${t.primary};margin-bottom:5px"></div>
      <span style="font-size:11px;color:${t.labelColor};font-weight:500">${t.label}</span>
    </button>`;
  }).join("");

  return `
    <h2 class="wiz-title">Choose a theme</h2>
    <p class="wiz-desc">Pick a color theme. You can change this any time in Settings.</p>
    <div class="theme-pick-grid">${buttons}</div>`;
}

window._wizardSelectTheme = function(name) {
  if (!THEMES[name]) return;
  _setupState.theme = name;
  applyTheme(name);
  document.querySelectorAll("[data-theme-btn]").forEach((btn) => {
    const id = btn.dataset.themeBtn;
    btn.style.borderColor = id === name ? THEMES[id].primary : "transparent";
  });
};

// ── Step 3: Timezone ───────────────────────────────────────────────────────

function _stepTimezone() {
  return `
    <h2 class="wiz-title">Timezone</h2>
    <p class="wiz-desc">
      Set the timezone for this server. It's used for date prefixes in filenames
      and year-based folder organization.
    </p>
    <div class="form-group">
      <label class="form-label">Timezone</label>
      <div class="tz-combo">
        <input class="form-control" type="text" id="tz-input"
               autocomplete="off" spellcheck="false"
               value="${escHTML(_setupState.timezone)}"
               placeholder="Search timezones…" />
        <div class="tz-dropdown" id="tz-dropdown"></div>
      </div>
      <div class="form-hint" id="tz-hint" style="margin-top:6px"></div>
    </div>`;
}

async function _initTimezoneStep() {
  try {
    const [tzData, serverTz] = await Promise.all([
      API.getTimezones(),
      API.getServerTimezone(),
    ]);
    const allZones = (tzData.timezones || []).sort();
    if (!_setupState._tzChosen) {
      _setupState.timezone = serverTz.timezone || "UTC";
    }
    const hint = document.getElementById("tz-hint");
    if (hint) hint.textContent = `Detected from server: ${serverTz.timezone || "UTC"}`;

    const inputEl    = document.getElementById("tz-input");
    const dropdownEl = document.getElementById("tz-dropdown");
    if (inputEl && dropdownEl) {
      initTzCombo(inputEl, dropdownEl, allZones, _setupState.timezone, (val) => {
        _setupState.timezone = val;
        _setupState._tzChosen = true;
      });
    }
  } catch (_) {
    const hint = document.getElementById("tz-hint");
    if (hint) hint.textContent = "Could not load timezone list — you can update this in Settings.";
  }
}

// ── Step 4: Storage ────────────────────────────────────────────────────────

function _stepStorage() {
  return `
    <h2 class="wiz-title">Downloads folder</h2>
    <p class="wiz-desc">
      Where should CastCharm store your podcast files?
      This is a path <strong>inside the container</strong> — map it to a host
      directory via <code>docker-compose.yml</code> volumes.
    </p>
    <div class="form-group">
      <label class="form-label">Path</label>
      <div style="display:flex;gap:8px">
        <input class="form-control" id="wiz-dl-path" type="text"
               value="${escHTML(_setupState.downloadPath)}"
               style="font-family:monospace;flex:1"
               data-action="setup-dl-path" />
        <button class="btn btn-ghost" type="button"
                data-action="wiz-load-dir">
          Go →
        </button>
      </div>
      <div class="form-hint">Type a path and press <strong>Go →</strong>, or click folders below to navigate.</div>
    </div>
    <div id="wiz-dir-browser" class="wizard-dir-browser"></div>`;
}

window._loadDirBrowser = async function(path) {
  const el = document.getElementById("wiz-dir-browser");
  if (!el) return;
  el.innerHTML = `<div style="padding:8px 12px;color:var(--text-3);font-size:12px">Loading…</div>`;
  try {
    const data = await API.browseDirs(path || "/");
    const rows = [];
    if (data.parent !== null) {
      rows.push(`<div class="dir-entry dir-up" data-action="wiz-select-dir" data-path="${escHTML(data.parent)}">
        <span class="dir-icon">↑</span><span>..</span>
      </div>`);
    }
    for (const entry of data.entries) {
      rows.push(`<div class="dir-entry" data-action="wiz-select-dir" data-path="${escHTML(entry.path)}">
        <span class="dir-icon">📁</span><span>${escHTML(entry.name)}</span>
      </div>`);
    }
    if (!data.entries.length && data.parent === null) {
      rows.push(`<div style="padding:8px 12px;color:var(--text-3);font-size:12px">No subdirectories</div>`);
    }
    el.innerHTML = `<div class="dir-browser-path">${escHTML(data.path)}</div>${rows.join("")}`;
  } catch (err) {
    el.innerHTML = `<div style="padding:8px 12px;color:var(--error);font-size:12px">${escHTML(err.message)}</div>`;
  }
};

// ── Step 4: File options ───────────────────────────────────────────────────

function _stepFileOptions() {
  return `
    <h2 class="wiz-title">File options</h2>
    <p class="wiz-desc">
      These defaults apply to all podcasts. You can override them per-feed later in Settings.
    </p>
    <form id="wiz-file-form">
      ${toggle("Date prefix in filename (YYYY-MM-DD)", "filename_date_prefix",
        _setupState.filenameDatePrefix,
        "Prepends the episode publication date to every filename.")}
      ${toggle("Episode number prefix in filename", "filename_episode_number",
        _setupState.filenameEpisodeNumber,
        "Prepends a zero-padded sequential number (e.g. 042 - Title.mp3).")}
      ${toggle("Organize into year subfolders", "organize_by_year",
        _setupState.organizeByYear,
        "Files into subdirectories by year, e.g. Podcast/2024/042 - Title.mp3")}
      ${toggle("Save XML metadata sidecar", "save_xml",
        _setupState.saveXml,
        "Saves a .xml file next to each audio file with full RSS metadata.")}
    </form>`;
}

// ── Login step wiring ──────────────────────────────────────────────────────

function _initLoginStep() {
  document.getElementById("wiz-skip").addEventListener("click", () => {
    _setupState.enableAuth = false;
    _setupState.step++;
    _renderSetupStep();
  });

  const validate = () => {
    const u = (document.getElementById("wiz-username")?.value || "").trim();
    const p =  document.getElementById("wiz-password")?.value || "";
    const c =  document.getElementById("wiz-confirm")?.value  || "";
    document.getElementById("wiz-next").disabled = !(u && p.length >= 8 && p === c);
  };
  document.getElementById("wiz-username").addEventListener("input", validate);
  document.getElementById("wiz-password").addEventListener("input", validate);
  document.getElementById("wiz-confirm").addEventListener("input", validate);

  const onEnter = (e) => {
    if (e.key === "Enter" && !document.getElementById("wiz-next").disabled) _wizardNext();
  };
  document.getElementById("wiz-username").addEventListener("keydown", onEnter);
  document.getElementById("wiz-password").addEventListener("keydown", onEnter);
  document.getElementById("wiz-confirm").addEventListener("keydown", onEnter);
}

// ── Navigation ─────────────────────────────────────────────────────────────

async function _wizardNext() {
  const errEl = document.getElementById("wiz-error");
  errEl.style.display = "none";

  if (_setupState.step === 1) {
    _setupState.enableAuth = true;
    _setupState.username      = (document.getElementById("wiz-username")?.value  || "").trim();
    _setupState.password      =  document.getElementById("wiz-password")?.value  || "";
    _setupState.confirmPassword = document.getElementById("wiz-confirm")?.value  || "";
    if (!_setupState.username) {
      return _wizErr("Please enter a username.");
    }
    if (_setupState.password.length < 8) {
      return _wizErr("Password must be at least 8 characters.");
    }
    if (_setupState.password !== _setupState.confirmPassword) {
      return _wizErr("Passwords do not match.");
    }
  }

  if (_setupState.step === 4) {
    _setupState.downloadPath = (document.getElementById("wiz-dl-path")?.value || "/downloads").trim();
  }

  if (_setupState.step === 5) {
    const form = document.getElementById("wiz-file-form");
    if (form) {
      const raw = collectForm(form);
      _setupState.filenameDatePrefix    = raw.filename_date_prefix    ?? true;
      _setupState.filenameEpisodeNumber = raw.filename_episode_number ?? true;
      _setupState.organizeByYear        = raw.organize_by_year        ?? true;
      _setupState.saveXml               = raw.save_xml                ?? true;
    }

    const btn = document.getElementById("wiz-next");
    btn.disabled    = true;
    btn.textContent = "Finishing…";

    try {
      await API.completeSetup({
        enable_auth:             _setupState.enableAuth,
        username:                _setupState.enableAuth ? _setupState.username  : null,
        password:                _setupState.enableAuth ? _setupState.password  : null,
        theme:                   _setupState.theme,
        timezone:                _setupState.timezone,
        download_path:           _setupState.downloadPath,
        filename_date_prefix:    _setupState.filenameDatePrefix,
        filename_episode_number: _setupState.filenameEpisodeNumber,
        organize_by_year:        _setupState.organizeByYear,
        save_xml:                _setupState.saveXml,
      });
      localStorage.setItem("cc_theme", _setupState.theme);
      applyTheme(_setupState.theme);
      hideSetupOverlay();
      _bootApp();
    } catch (err) {
      btn.disabled    = false;
      btn.textContent = "Finish setup";
      _wizErr(err.message);
    }
    return;
  }

  _setupState.step++;
  _renderSetupStep();
}

function _wizardBack() {
  if (_setupState.step > 1) {
    _setupState.step--;
    _renderSetupStep();
  }
}

function _wizErr(msg) {
  const el = document.getElementById("wiz-error");
  if (!el) return;
  el.textContent = msg;   // textContent: never interpreted as HTML
  el.style.display = "block";
}
