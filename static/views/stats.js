"use strict";

// ============================================================
// Stats view  —  module-level state
// ============================================================

let _statsGlobalData  = null;
let _statsFocusFeedId = null;
let _feedSortKey      = "storage_bytes";
let _feedSortAsc      = false;
let _yearBuckets      = null;
const _YEAR_WINDOW    = 15;

function _art(image_url) {
  const icon = `<svg viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="2" style="width:13px;height:13px">
    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
  </svg>`;
  // Always render a placeholder div; overlay the image on top when available.
  // If the image fails to load, onerror removes only the <img>, revealing the placeholder.
  return `<div style="position:relative;width:28px;height:28px;flex-shrink:0">
    <div style="position:absolute;inset:0;border-radius:5px;background:var(--bg-3);
                display:flex;align-items:center;justify-content:center">${icon}</div>
    ${image_url
      ? `<img src="${image_url}" onerror="this.remove()"
              style="position:absolute;inset:0;width:100%;height:100%;
                     object-fit:cover;border-radius:5px" />`
      : ""}
  </div>`;
}


// ============================================================
// Entry point
// ============================================================

async function viewStats() {
  _statsFocusFeedId = null;
  const content = document.getElementById("content");
  content.innerHTML = `<div class="loading-spinner"><div class="spinner"></div></div>`;

  _statsGlobalData = await API.getStats();

  content.innerHTML = `
    <div class="page" style="max-width:1100px">
      <div class="page-header" style="margin-bottom:16px">
        <div>
          <div class="page-title">Statistics</div>
          <div class="page-subtitle" id="stats-scope-label">Library-wide analytics</div>
        </div>
      </div>

      <div id="stats-overview"></div>

      <div class="card" style="margin-top:16px">
        <div class="card-body">
          <div class="section-title" style="margin-bottom:12px">By Podcast</div>
          ${_statsGlobalData.by_feed.length === 0
            ? `<div class="empty-state"><div class="empty-state-title">No data yet</div></div>`
            : _feedTable(_statsGlobalData.by_feed)}
        </div>
      </div>
    </div>`;

  _renderOverview(_statsGlobalData, null);
  _wireSortHeaders();
}


// ============================================================
// Overview section  (re-rendered on focus change)
// ============================================================

// ── Stats section builders ────────────────────────────────────────────────────

function _deriveStats(data, feedTitle) {
  const isGlobal = feedTitle === null;
  const eps         = isGlobal ? data.by_feed.reduce((s, f) => s + f.episode_count, 0)           : data.episode_count;
  const dl          = isGlobal ? data.by_feed.reduce((s, f) => s + f.downloaded_count, 0)        : data.downloaded_count;
  const bytes       = isGlobal ? data.by_feed.reduce((s, f) => s + f.storage_bytes, 0)           : data.storage_bytes;
  const secs        = isGlobal ? data.total_runtime_seconds                                       : data.runtime_seconds;
  const listenSecs  = isGlobal ? (data.total_listen_seconds              || 0) : (data.listen_seconds              || 0);
  const unplayed    = isGlobal ? (data.total_unplayed_count              || 0) : (data.unplayed_count              || 0);
  const partial     = isGlobal ? (data.total_partially_played_count      || 0) : (data.partially_played_count      || 0);
  const playedNotDl = isGlobal ? (data.total_played_not_downloaded_count || 0) : (data.played_not_downloaded_count || 0);
  const nFeeds      = isGlobal ? data.by_feed.length : null;
  return { isGlobal, eps, dl, bytes, secs, listenSecs, unplayed, partial, playedNotDl, nFeeds };
}

function _buildKpiHtml(s) {
  const { isGlobal, eps, dl, bytes, secs, listenSecs, unplayed, partial, nFeeds } = s;
  return `
    <div class="stat-card">
      <div class="stat-label">${isGlobal ? "Total Episodes" : "Episodes"}</div>
      <div class="stat-value">${eps.toLocaleString()}</div>
      <div class="stat-sub">${dl.toLocaleString()} downloaded</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Storage</div>
      <div class="stat-value">${fmtBytes(bytes)}</div>
      <div class="stat-sub">${dl > 0 ? fmtBytes(Math.round(bytes / dl)) + " avg (episode files only)" : "(episode files only)"}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Runtime</div>
      <div class="stat-value">${fmtRuntime(secs)}</div>
      <div class="stat-sub">${dl > 0 ? fmtRuntime(Math.round(secs / dl)) + " avg (downloads only)" : "(downloads only)"}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">${isGlobal ? "Podcasts" : "Downloaded"}</div>
      <div class="stat-value">${isGlobal ? nFeeds : (eps > 0 ? Math.round(dl / eps * 100) + "%" : "—")}</div>
      <div class="stat-sub">${isGlobal ? (eps > 0 ? Math.round(dl / eps * 100) + "% downloaded" : "0% downloaded") : `of ${eps} episodes`}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Listen Time</div>
      <div class="stat-value">${listenSecs > 0 ? fmtRuntime(listenSecs) : "—"}</div>
      <div class="stat-sub">${listenSecs > 0 ? "cumulative (persists after deletion)" : "no playback data"}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Backlog</div>
      <div class="stat-value">${unplayed.toLocaleString()}</div>
      <div class="stat-sub">${dl > 0
        ? Math.round((unplayed - partial) / dl * 100) + "% not started<br>" + Math.round(partial / dl * 100) + "% in progress"
        : "no downloads yet"}</div>
    </div>`;
}

function _buildChartsInner(data) {
  return `
    <div class="card">
      <div class="card-body">
        <div class="section-title" style="margin-bottom:12px">Episodes by Year</div>
        ${_yearChart(data.episodes_by_year)}
        <div style="display:flex;gap:16px;margin-top:8px;font-size:11px;color:var(--text-3)">
          <span style="display:flex;align-items:center;gap:5px">
            <span style="width:10px;height:10px;border-radius:2px;background:var(--primary);opacity:0.25;display:inline-block"></span> Total
          </span>
          <span style="display:flex;align-items:center;gap:5px">
            <span style="width:10px;height:10px;border-radius:2px;background:var(--primary);display:inline-block"></span> Downloaded
          </span>
        </div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card">
        <div class="card-body">
          <div class="section-title" style="margin-bottom:12px">Release Day of Week</div>
          ${_dowChart(data.episodes_by_dow)}
        </div>
      </div>
      <div class="card">
        <div class="card-body">
          <div class="section-title" style="margin-bottom:12px">Format Breakdown</div>
          ${_formatBars(data.format_breakdown)}
        </div>
      </div>
    </div>`;
}

function _buildStatusCardInner(s) {
  const { dl, eps, unplayed, partial, playedNotDl } = s;
  const playedDl       = dl - unplayed;
  const notStarted     = unplayed - partial;
  const notPlayedNotDl = Math.max(0, eps - dl - playedNotDl);
  return `<div class="card-body">
    <div class="section-title" style="margin-bottom:14px">Episode Status</div>
    ${_donutChart([
      { label: "Downloaded, played",           value: playedDl       },
      { label: "Downloaded, partially played", value: partial        },
      { label: "Downloaded, unplayed",         value: notStarted     },
      { label: "Not downloaded, played",       value: playedNotDl    },
      { label: "Not downloaded, unplayed",     value: notPlayedNotDl },
    ], (v) => v.toLocaleString())}
  </div>`;
}

function _buildDiskUseCardInner(data) {
  return `<div class="card-body">
    <div class="section-title" style="margin-bottom:14px">Disk Use by Podcast</div>
    ${_donutChart(data.by_feed.map(f => ({ label: f.title, value: f.storage_bytes })), fmtBytes)}
  </div>`;
}

function _buildDownloadedCardInner(data) {
  return `<div class="card-body">
    <div class="section-title" style="margin-bottom:14px">Downloaded by Podcast</div>
    ${_donutChart(data.by_feed.map(f => ({ label: f.title, value: f.downloaded_count })), (v) => v.toLocaleString())}
  </div>`;
}

function _buildDurationCardInner(data) {
  return `<div class="card-body">
    <div class="section-title" style="margin-bottom:14px">Episode Length <span style="font-size:11px;font-weight:400;color:var(--text-3)">(downloaded)</span></div>
    ${_durationAreaChart(data.episode_durations || [])}
  </div>`;
}

function _buildOverlayInner(data) {
  return `<div class="card">
    <div class="card-body">
      <div class="section-title" style="margin-bottom:14px">Episode Length Distribution by Podcast</div>
      ${_durationOverlayChart(data.feed_durations)}
    </div>
  </div>`;
}

// ── Animation helpers ─────────────────────────────────────────────────────────

// Flip all .card/.stat-card elements out, then call cb() after they're gone.
function _flipCardsOut(cb) {
  const cards = [...document.querySelectorAll("#stats-overview .card, #stats-overview .stat-card")];
  if (!cards.length) { cb(); return; }
  cards.forEach(el => {
    el.style.transition = "transform 0.2s ease, opacity 0.2s ease";
    el.style.transform = "perspective(700px) rotateY(90deg)";
    el.style.opacity = "0";
  });
  setTimeout(cb, 210);
}

// Flip all .card/.stat-card elements in (call after innerHTML is set).
function _flipCardsIn() {
  const cards = [...document.querySelectorAll("#stats-overview .card, #stats-overview .stat-card")];
  cards.forEach((el, i) => {
    const delay = i * 18;
    el.style.transition = "none";
    el.style.transform = "perspective(700px) rotateY(-90deg)";
    el.style.opacity = "0";
    void el.offsetHeight;
    el.style.transition = `transform 0.26s ease ${delay}ms, opacity 0.22s ease ${delay}ms`;
    el.style.transform = "";
    el.style.opacity = "";
    setTimeout(() => { el.style.transition = ""; }, 300 + delay);
  });
}

// Show a centered spinner in place of the overview panels.
function _showOverviewSpinner() {
  document.getElementById("stats-overview").innerHTML =
    `<div style="display:flex;justify-content:center;padding:80px 0">
      <div class="spinner"></div>
    </div>`;
}

// ── Entry point ───────────────────────────────────────────────────────────────

function _renderOverview(data, feedTitle) {
  _flipCardsOut(() => {
    _renderOverviewInner(data, feedTitle);
    _flipCardsIn();
  });
}

function _renderOverviewInner(data, feedTitle) {
  const s = _deriveStats(data, feedTitle);
  const { isGlobal } = s;
  const showDiskDl  = isGlobal && data.by_feed.length > 1;
  const showOverlay = isGlobal && (data.feed_durations || []).filter(f => f.durations.length >= 1).length >= 2;

  document.getElementById("stats-scope-label").textContent =
    isGlobal ? "Library-wide analytics" : `Showing stats for: ${feedTitle}`;

  document.getElementById("stats-overview").innerHTML = `
    <div id="sc-kpi" class="stats-grid" style="margin-bottom:16px">${_buildKpiHtml(s)}</div>

    <div id="sc-charts" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-bottom:16px">
      ${_buildChartsInner(data)}
    </div>

    <div id="sc-donuts" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-bottom:0">
      <div class="card" id="sc-status">${_buildStatusCardInner(s)}</div>
      ${showDiskDl ? `
        <div class="card" id="sc-diskuse">${_buildDiskUseCardInner(data)}</div>
        <div class="card" id="sc-downloaded">${_buildDownloadedCardInner(data)}</div>
      ` : `
        <div class="card" id="sc-duration">${_buildDurationCardInner(data)}</div>
      `}
    </div>

    ${showOverlay ? `
    <div id="sc-overlay" style="margin-bottom:16px;margin-top:16px">
      ${_buildOverlayInner(data)}
    </div>` : ""}`;
}


// ============================================================
// Focus toggle — called from table buttons
// ============================================================

window.toggleFeedFocus = async function (feedId) {
  const contentEl = document.getElementById("content");
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const flipOut = () => new Promise(r => _flipCardsOut(r));

  // Clicking the active feed → revert to global (data already cached, no fetch needed)
  if (_statsFocusFeedId === feedId) {
    _statsFocusFeedId = null;
    _updateFocusButtons(null);
    contentEl.scrollTo({ top: 0, behavior: "smooth" });
    await delay(220);
    _renderOverview(_statsGlobalData, null);
    return;
  }

  const feedRow = _statsGlobalData.by_feed.find((f) => f.feed_id === feedId);
  const title = feedRow ? feedRow.title : "";

  _statsFocusFeedId = feedId;
  _updateFocusButtons(feedId);

  // Start the fetch immediately so it runs in parallel with the animations
  const fetchPromise = API.getFeedStats(feedId);

  // 1. Scroll to top
  contentEl.scrollTo({ top: 0, behavior: "smooth" });

  // 2. Let the scroll travel, then flip cards out
  await delay(220);
  await flipOut();

  // 3. Show spinner — fetch is in flight while we waited for animations
  _showOverviewSpinner();
  document.getElementById("stats-scope-label").textContent = title;

  try {
    const d = await fetchPromise;
    // 4. Animate new cards in
    _renderOverview(d, title);
  } catch (e) {
    Toast.error(e.message);
    _statsFocusFeedId = null;
    _updateFocusButtons(null);
    _renderOverview(_statsGlobalData, null);
  }
};

function _updateFocusButtons(activeFeedId) {
  document.querySelectorAll(".stats-focus-btn").forEach((btn) => {
    const id = Number(btn.dataset.feedId);
    if (activeFeedId === null) {
      btn.textContent = "Show podcast stats";
      btn.classList.remove("active");
    } else if (id === activeFeedId) {
      btn.textContent = "← Global";
      btn.classList.add("active");
    } else {
      btn.textContent = "Show podcast stats";
      btn.classList.remove("active");
    }
  });
}


// ============================================================
// Chart helpers
// ============================================================

function fmtRuntime(secs) {
  if (!secs) return "0m";
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function _yearChartSvg(visible) {
  const W = 600, H = 180;
  const PAD_L = 38, PAD_R = 8, PAD_TOP = 10, PAD_BOT = 26;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_TOP - PAD_BOT;
  const n      = visible.length;
  const maxVal = Math.max(...visible.map((b) => b.total), 1);
  const slotW  = chartW / n;
  const barW   = Math.max(4, Math.floor(slotW * 0.75));
  const scaleY = (v) => (v / maxVal) * chartH;

  let axes = "";
  for (const pct of [0, 0.5, 1]) {
    const val = Math.round(maxVal * pct);
    const y   = PAD_TOP + chartH - scaleY(val);
    axes += `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`;
    axes += `<text x="${(PAD_L - 4).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-3)">${val}</text>`;
  }

  let bars = "";
  visible.forEach((b, i) => {
    const cx     = PAD_L + i * slotW + slotW / 2;
    const x      = cx - barW / 2;
    const totalH = scaleY(b.total);
    const dlH    = scaleY(b.downloaded);
    bars += `<rect x="${x.toFixed(1)}" y="${(PAD_TOP + chartH - totalH).toFixed(1)}" width="${barW}" height="${totalH.toFixed(1)}" rx="2" fill="var(--primary)" opacity="0.25"/>`;
    if (dlH > 0) {
      bars += `<rect x="${x.toFixed(1)}" y="${(PAD_TOP + chartH - dlH).toFixed(1)}" width="${barW}" height="${dlH.toFixed(1)}" rx="2" fill="var(--primary)"/>`;
    }
    bars += `<text x="${cx.toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--text-3)">${b.year}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block;overflow:visible">${axes}${bars}</svg>`;
}

window._yearChartSlide = function(val) {
  const wrap = document.getElementById("year-chart-svg-wrap");
  if (!wrap || !_yearBuckets) return;
  const start = Number(val);
  const visible = _yearBuckets.slice(start, start + _YEAR_WINDOW);
  wrap.innerHTML = _yearChartSvg(visible);
  // Update year-range label
  const lbl = document.getElementById("year-chart-range-lbl");
  if (lbl) lbl.textContent = `${visible[0].year} – ${visible[visible.length - 1].year}`;
};

function _yearChart(buckets) {
  if (!buckets || buckets.length === 0) {
    return `<div style="color:var(--text-3);font-size:13px;padding:20px 0">No episode data</div>`;
  }

  _yearBuckets = buckets;
  const needSlider = buckets.length > _YEAR_WINDOW;
  const startIdx   = needSlider ? buckets.length - _YEAR_WINDOW : 0;
  const visible    = buckets.slice(startIdx, startIdx + _YEAR_WINDOW);

  const sliderHtml = needSlider ? `
    <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
      <span style="font-size:10px;color:var(--text-3);flex-shrink:0">${buckets[0].year}</span>
      <input type="range" min="0" max="${buckets.length - _YEAR_WINDOW}" value="${startIdx}" step="1"
             style="flex:1;accent-color:var(--primary)"
             oninput="_yearChartSlide(this.value)">
      <span style="font-size:10px;color:var(--text-3);flex-shrink:0">${buckets[buckets.length - 1].year}</span>
      <span id="year-chart-range-lbl" style="font-size:10px;color:var(--text-3);flex-shrink:0;min-width:70px;text-align:right">${visible[0].year} – ${visible[visible.length - 1].year}</span>
    </div>` : "";

  return `<div id="year-chart-svg-wrap">${_yearChartSvg(visible)}</div>${sliderHtml}`;
}

function _dowChart(buckets) {
  if (!buckets || buckets.every((b) => b.total === 0)) {
    return `<div style="color:var(--text-3);font-size:13px">No episode data</div>`;
  }
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const maxVal = Math.max(...buckets.map((b) => b.total), 1);
  return buckets.map((b) => {
    const pct = (b.total / maxVal) * 100;
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="width:28px;font-size:11px;font-weight:600;color:var(--text-2);flex-shrink:0;text-align:right">${DAYS[b.dow]}</span>
        <div style="flex:1;height:18px;border-radius:3px;background:var(--bg-3);overflow:hidden;position:relative">
          <div style="height:100%;width:${pct.toFixed(1)}%;background:var(--chart-2, #10b981);border-radius:3px;transition:width 0.3s"></div>
        </div>
        <span style="width:36px;font-size:11px;color:var(--text-3);text-align:right;flex-shrink:0">${b.total.toLocaleString()}</span>
      </div>`;
  }).join("");
}

function _formatBars(buckets) {
  if (!buckets || buckets.length === 0) {
    return `<div style="color:var(--text-3);font-size:13px">No downloaded episodes</div>`;
  }
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  return buckets.map((b) => {
    const pct = Math.round((b.count / maxCount) * 100);
    return `
      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;margin-bottom:3px">
          <span style="color:var(--text);font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${b.label}</span>
          <span style="color:var(--text-3);flex-shrink:0">${b.count.toLocaleString()} eps · ${fmtBytes(b.bytes)}</span>
        </div>
        <div style="height:6px;border-radius:3px;background:var(--bg-3);overflow:hidden">
          <div style="height:100%;width:${pct}%;background:var(--primary);border-radius:3px"></div>
        </div>
      </div>`;
  }).join("");
}


// ============================================================
// Episode duration overlay chart (global — one curve per podcast)
// ============================================================

function _durationOverlayChart(feedDurations) {
  const feeds = (feedDurations || [])
    .filter(f => f.durations.length >= 1)
    .sort((a, b) => b.durations.length - a.durations.length)
    .slice(0, 12);

  if (feeds.length < 2) {
    return `<div style="color:var(--text-3);font-size:13px">Not enough data</div>`;
  }

  // All durations in minutes, for global stats
  const allMins = feeds
    .flatMap(f => f.durations.map(s => s / 60))
    .sort((a, b) => a - b);

  const n = allMins.length;
  const mean = allMins.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 === 0
    ? (allMins[n / 2 - 1] + allMins[n / 2]) / 2
    : allMins[Math.floor(n / 2)];
  const variance = allMins.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);

  const modeCounts = {};
  for (const m of allMins) {
    const k = Math.round(m / 5) * 5;
    modeCounts[k] = (modeCounts[k] || 0) + 1;
  }
  const modeVal = +Object.entries(modeCounts).sort((a, b) => b[1] - a[1])[0][0];
  const minVal = allMins[0];
  const maxVal = allMins[n - 1];

  // Keep the original shared x-range behavior
  const chartMax = allMins[Math.floor(n * 0.98)] * 1.05;

  const binSize = Math.max(1, Math.ceil((chartMax / 40) / 5) * 5);
  const numBins = Math.ceil(chartMax / binSize) + 1;
  const kernel = [0.1, 0.2, 0.4, 0.2, 0.1];

  const feedData = feeds.map((f, i) => {
    const bins = new Array(numBins).fill(0);

    for (const s of f.durations) {
      const idx = Math.min(Math.floor((s / 60) / binSize), numBins - 1);
      if (idx >= 0) bins[idx]++;
    }

    const smoothed = bins.map((_, j) => {
      let v = 0, w = 0;
      for (let k = -2; k <= 2; k++) {
        const jj = j + k, wk = kernel[k + 2];
        v += (jj >= 0 && jj < bins.length ? bins[jj] : 0) * wk;
        w += wk;
      }
      return v / w;
    });

    const peak = Math.max(...smoothed, 1);

    return {
      title: f.title,
      normalized: smoothed.map(v => v / peak),
      color: _DONUT_COLORS[i % _DONUT_COLORS.length]
    };
  });

  const W = 540, H = 130;
  const ml = 4, mr = 4, mt = 14, mb = 20;
  const pw = W - ml - mr, ph = H - mt - mb;
  const baseline = mt + ph;

  const xPos = m => ml + (m / (numBins * binSize)) * pw;
  const yPos = v => mt + ph - v * ph;

  const meanX = xPos(mean);
  const hasSD = stddev > 0.5;
  const sdLowX = xPos(Math.max(0, mean - stddev));
  const sdHighX = xPos(Math.min(mean + stddev, chartMax));

  const paths = feedData.map(({ normalized, color }) => {
    const pts = normalized.map((v, i) => [xPos((i + 0.5) * binSize), yPos(v)]);
    let line = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      line += ` L ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`;
    }
    const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${baseline} L ${pts[0][0].toFixed(1)} ${baseline} Z`;
    return `<path d="${area}" style="fill:${color};opacity:0.08"/>
            <path d="${line}" style="fill:none;stroke:${color};stroke-width:1.5;stroke-linejoin:round;opacity:0.75"/>`;
  }).join("");

  const fmt = v => {
    const rounded = Math.round(v);
    const h = Math.floor(rounded / 60);
    const m = rounded % 60;
    return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${rounded}m`;
  };

  const labelCandidates = [
    { x: sdLowX,  t: fmt(Math.max(0, mean - stddev)), anchor: "start" },
    { x: meanX,   t: fmt(mean), anchor: "middle", bold: true },
    { x: sdHighX, t: fmt(Math.min(mean + stddev, chartMax)), anchor: "end" }
  ];

  const xLabels = labelCandidates.filter((c, i, arr) =>
    arr.every((o, j) => j === i || Math.abs(o.x - c.x) > 28)
  );

  const xTicks = xLabels.map(({ x, t, anchor, bold }) =>
    `<text x="${x.toFixed(1)}" y="${H - 4}"
           style="fill:${bold ? 'var(--text-2)' : 'var(--text-3)'};font-size:8px;text-anchor:${anchor}${bold ? ';font-weight:600' : ''}">${t}</text>`
  ).join("");

  const legend = feedData.map(({ title, color }) =>
    `<div style="display:flex;align-items:center;gap:5px;font-size:11px;min-width:0">
      <span style="width:16px;height:3px;background:${color};border-radius:2px;flex-shrink:0;display:inline-block"></span>
      <span style="color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</span>
    </div>`
  ).join("");

  const stats = [
    ["Mean", fmt(mean)],
    ["Median", fmt(median)],
    ["Mode", fmt(modeVal)],
    ["Range", `${fmt(minVal)}–${fmt(maxVal)}`]
  ].map(([lbl, val]) => `
    <div style="text-align:center">
      <div style="font-size:10px;color:var(--text-3);margin-bottom:2px">${lbl}</div>
      <div style="font-size:12px;color:var(--text-2);font-weight:500">${val}</div>
    </div>
  `).join("");

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
      ${hasSD ? `
        <rect x="${sdLowX.toFixed(1)}" y="${mt}" width="${(sdHighX - sdLowX).toFixed(1)}" height="${ph}"
              style="fill:var(--primary);opacity:0.08"/>
        <line x1="${sdLowX.toFixed(1)}" y1="${mt}" x2="${sdLowX.toFixed(1)}" y2="${baseline}"
              style="stroke:var(--primary);stroke-width:1;stroke-dasharray:3,2;opacity:0.45"/>
        <line x1="${sdHighX.toFixed(1)}" y1="${mt}" x2="${sdHighX.toFixed(1)}" y2="${baseline}"
              style="stroke:var(--primary);stroke-width:1;stroke-dasharray:3,2;opacity:0.45"/>
        <text x="${sdLowX.toFixed(1)}" y="${mt - 2}" style="fill:var(--text-3);font-size:7px;text-anchor:middle">−1σ</text>
        <text x="${sdHighX.toFixed(1)}" y="${mt - 2}" style="fill:var(--text-3);font-size:7px;text-anchor:middle">+1σ</text>
      ` : ""}
      ${paths}
      <line x1="${meanX.toFixed(1)}" y1="${mt}" x2="${meanX.toFixed(1)}" y2="${baseline}"
            style="stroke:var(--primary);stroke-width:1.5;opacity:0.65"/>
      <line x1="${ml}" y1="${baseline}" x2="${W - mr}" y2="${baseline}" style="stroke:var(--border);stroke-width:1"/>
      ${xTicks}
    </svg>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:5px 16px;margin-top:10px">
      ${legend}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;margin-top:10px">
      ${stats}
    </div>`;
}


// ============================================================
// Episode duration area chart (per-feed only)
// ============================================================

function _durationAreaChart(durationsSeconds) {
  if (!durationsSeconds || durationsSeconds.length < 2) {
    return `<div style="color:var(--text-3);font-size:13px">No duration data</div>`;
  }

  const mins = durationsSeconds.map(s => s / 60);
  const n = mins.length;

  // Stats
  const mean = mins.reduce((a, b) => a + b, 0) / n;
  const sorted = [...mins].sort((a, b) => a - b);
  const median = n % 2 === 0 ? (sorted[n/2-1] + sorted[n/2]) / 2 : sorted[Math.floor(n/2)];
  const variance = mins.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const modeCounts = {};
  for (const m of mins) { const k = Math.round(m / 5) * 5; modeCounts[k] = (modeCounts[k] || 0) + 1; }
  const modeVal = +Object.entries(modeCounts).sort((a, b) => b[1] - a[1])[0][0];
  const minVal = sorted[0], maxVal = sorted[n - 1];

  // Chart range: clip at 99th percentile
  const chartMax = sorted[Math.min(Math.floor(n * 0.99), n - 1)] * 1.05;

  // Bins: aim for ~40, rounded to 5-minute boundaries
  const binSize = Math.max(1, Math.ceil((chartMax / 40) / 5) * 5);
  const numBins = Math.ceil(chartMax / binSize) + 1;
  const bins = new Array(numBins).fill(0);
  for (const m of mins) {
    const i = Math.min(Math.floor(m / binSize), numBins - 1);
    if (i >= 0) bins[i]++;
  }

  // 5-point weighted smoothing
  const kernel = [0.1, 0.2, 0.4, 0.2, 0.1];
  const smoothed = bins.map((_, i) => {
    let v = 0, w = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k, wk = kernel[k + 2];
      v += (j >= 0 && j < bins.length ? bins[j] : 0) * wk;
      w += wk;
    }
    return v / w;
  });
  const maxY = Math.max(...smoothed, 1);

  // SVG layout
  const W = 300, H = 108;
  const ml = 4, mr = 4, mt = 14, mb = 20;
  const pw = W - ml - mr, ph = H - mt - mb;
  const baseline = mt + ph;
  const xPos = m => ml + (m / (numBins * binSize)) * pw;
  const yPos = v => mt + ph - (v / maxY) * ph;

  // Area path
  const pts = smoothed.map((v, i) => [xPos((i + 0.5) * binSize), yPos(v)]);
  let linePath = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) linePath += ` L ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`;
  const areaPath = `${linePath} L ${pts[pts.length-1][0].toFixed(1)} ${baseline} L ${pts[0][0].toFixed(1)} ${baseline} Z`;

  // Positions
  const meanX  = xPos(mean);
  const hasSD  = stddev > 0.5;
  const sdLowX = xPos(Math.max(0, mean - stddev));
  const sdHighX= xPos(Math.min(mean + stddev, chartMax));

  const fmt = v => {
    const h = Math.floor(v / 60), m = Math.round(v % 60);
    return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${Math.round(v)}m`;
  };

  // X-axis labels: min, mean, max — suppress if too close
  const labelCandidates = [
    { x: xPos(minVal),                      t: fmt(minVal),  anchor: "start"  },
    { x: meanX,                             t: fmt(mean),    anchor: "middle", bold: true },
    { x: xPos(Math.min(maxVal, chartMax)),  t: fmt(maxVal),  anchor: "end"    },
  ];
  const xLabels = labelCandidates.filter((c, i, arr) =>
    arr.every((o, j) => j === i || Math.abs(o.x - c.x) > 28)
  );

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
      ${hasSD ? `
        <rect x="${sdLowX.toFixed(1)}" y="${mt}" width="${(sdHighX-sdLowX).toFixed(1)}" height="${ph}"
              style="fill:var(--primary);opacity:0.08"/>
        <line x1="${sdLowX.toFixed(1)}" y1="${mt}" x2="${sdLowX.toFixed(1)}" y2="${baseline}"
              style="stroke:var(--primary);stroke-width:1;stroke-dasharray:3,2;opacity:0.45"/>
        <line x1="${sdHighX.toFixed(1)}" y1="${mt}" x2="${sdHighX.toFixed(1)}" y2="${baseline}"
              style="stroke:var(--primary);stroke-width:1;stroke-dasharray:3,2;opacity:0.45"/>
        <text x="${sdLowX.toFixed(1)}" y="${mt - 2}" style="fill:var(--text-3);font-size:7px;text-anchor:middle">−1σ</text>
        <text x="${sdHighX.toFixed(1)}" y="${mt - 2}" style="fill:var(--text-3);font-size:7px;text-anchor:middle">+1σ</text>
      ` : ""}
      <path d="${areaPath}" style="fill:var(--primary);opacity:0.22"/>
      <path d="${linePath}" style="fill:none;stroke:var(--primary);stroke-width:1.5;stroke-linejoin:round"/>
      <line x1="${meanX.toFixed(1)}" y1="${mt}" x2="${meanX.toFixed(1)}" y2="${baseline}"
            style="stroke:var(--primary);stroke-width:1.5;opacity:0.65"/>
      <line x1="${ml}" y1="${baseline}" x2="${W - mr}" y2="${baseline}" style="stroke:var(--border);stroke-width:1"/>
      ${xLabels.map(({x, t, anchor, bold}) =>
        `<text x="${x.toFixed(1)}" y="${H - 4}"
               style="fill:${bold ? 'var(--text-2)' : 'var(--text-3)'};font-size:8px;text-anchor:${anchor}${bold ? ';font-weight:600' : ''}">${t}</text>`
      ).join("")}
    </svg>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;margin-top:10px">
      ${[["Mean", fmt(mean)], ["Median", fmt(median)], ["Mode", fmt(modeVal)], ["Range", `${fmt(minVal)}–${fmt(maxVal)}`]]
        .map(([lbl, val]) => `
          <div style="text-align:center">
            <div style="font-size:10px;color:var(--text-3);margin-bottom:2px">${lbl}</div>
            <div style="font-size:12px;color:var(--text-2);font-weight:500">${val}</div>
          </div>`).join("")}
    </div>`;
}


// ============================================================
// Donut chart
// ============================================================

const _DONUT_COLORS = [
  "var(--chart-1)","var(--chart-2)","var(--chart-3)","var(--chart-4)",
  "var(--chart-5)","var(--chart-6)","var(--chart-7)","var(--chart-8)",
];

function _donutChart(items, fmtVal) {
  // items: [{label, value}]  fmtVal: (number) => string
  const sorted = [...items].filter(x => x.value > 0).sort((a, b) => b.value - a.value);
  const TOP = 12;
  let slices = sorted.slice(0, TOP);
  if (sorted.length > TOP) {
    const rest = sorted.slice(TOP).reduce((s, x) => s + x.value, 0);
    if (rest > 0) slices.push({ label: "Other", value: rest });
  }
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total === 0) return `<div style="color:var(--text-3);font-size:13px">No data</div>`;

  const CX = 72, CY = 72, R = 64, ri = 38;
  let paths = "";
  let angle = -Math.PI / 2;

  slices.forEach((s, i) => {
    const frac = s.value / total;
    const sweep = frac * 2 * Math.PI;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const color = _DONUT_COLORS[i % _DONUT_COLORS.length];

    if (frac >= 0.9999) {
      // Full circle: draw as two half-arcs
      const opp = angle + Math.PI;
      const fmt = (n) => n.toFixed(2);
      paths += `<path style="fill:${color}" d="
        M ${fmt(CX + R * Math.cos(angle))} ${fmt(CY + R * Math.sin(angle))}
        A ${R} ${R} 0 1 1 ${fmt(CX + R * Math.cos(opp))} ${fmt(CY + R * Math.sin(opp))}
        A ${R} ${R} 0 1 1 ${fmt(CX + R * Math.cos(angle))} ${fmt(CY + R * Math.sin(angle))}
        L ${fmt(CX + ri * Math.cos(angle))} ${fmt(CY + ri * Math.sin(angle))}
        A ${ri} ${ri} 0 1 0 ${fmt(CX + ri * Math.cos(opp))} ${fmt(CY + ri * Math.sin(opp))}
        A ${ri} ${ri} 0 1 0 ${fmt(CX + ri * Math.cos(angle))} ${fmt(CY + ri * Math.sin(angle))}
        Z"/>`;
    } else {
      const f = (n) => n.toFixed(2);
      const x1 = CX + R  * Math.cos(angle), y1 = CY + R  * Math.sin(angle);
      const x2 = CX + R  * Math.cos(end),   y2 = CY + R  * Math.sin(end);
      const x3 = CX + ri * Math.cos(end),   y3 = CY + ri * Math.sin(end);
      const x4 = CX + ri * Math.cos(angle), y4 = CY + ri * Math.sin(angle);
      paths += `<path style="fill:${color}" d="M ${f(x1)} ${f(y1)} A ${R} ${R} 0 ${large} 1 ${f(x2)} ${f(y2)} L ${f(x3)} ${f(y3)} A ${ri} ${ri} 0 ${large} 0 ${f(x4)} ${f(y4)} Z"/>`;
    }
    // Small gap between slices
    angle = end + 0.015;
  });

  const legend = slices.map((s, i) => {
    const pct = Math.round(s.value / total * 100);
    return `<div style="display:flex;align-items:baseline;gap:6px;font-size:11px;min-width:0;margin-bottom:5px">
      <span style="width:9px;height:9px;border-radius:2px;background:${_DONUT_COLORS[i % _DONUT_COLORS.length]};flex-shrink:0;margin-top:1px"></span>
      <span style="color:var(--text-2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.label}</span>
      <span style="color:var(--text-3);flex-shrink:0;font-variant-numeric:tabular-nums">${pct}%</span>
      <span style="color:var(--text-3);flex-shrink:0;font-variant-numeric:tabular-nums;min-width:48px;text-align:right">${fmtVal(s.value)}</span>
    </div>`;
  }).join("");

  return `<div style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px">
    <svg viewBox="0 0 ${CX*2} ${CY*2}" style="width:100%;max-width:${CX*2}px;height:auto;display:block;flex-shrink:0">${paths}</svg>
    <div style="flex:1;min-width:140px;align-self:center">${legend}</div>
  </div>`;
}


// ============================================================
// Feed table
// ============================================================

function _sortedFeeds(feeds) {
  return [...feeds].sort((a, b) => {
    const av = a[_feedSortKey], bv = b[_feedSortKey];
    const cmp = typeof av === "string" ? av.localeCompare(bv) : (av - bv);
    return _feedSortAsc ? cmp : -cmp;
  });
}

function _feedRow(f) {
  const isFocused = _statsFocusFeedId === f.feed_id;
  return `
    <tr id="stats-row-${f.feed_id}" ${isFocused ? 'style="background:var(--primary-light)"' : ""}>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          ${_art(f.image_url)}
          <a href="#/feeds/${f.feed_id}" style="color:var(--text);font-weight:500;font-size:13px">${f.title}</a>
        </div>
      </td>
      <td style="text-align:right;color:var(--text-2);font-size:13px">
        ${f.downloaded_count.toLocaleString()}
        <span style="color:var(--text-3);font-size:11px"> / ${f.episode_count.toLocaleString()}</span>
      </td>
      <td style="text-align:right;font-size:13px">
        ${f.episode_count > 0
          ? `<div style="display:inline-flex;align-items:center;gap:6px">
              <div style="width:50px;height:5px;border-radius:3px;background:var(--bg-3);overflow:hidden">
                <div style="height:100%;width:${Math.round(f.downloaded_count / f.episode_count * 100)}%;background:var(--primary);border-radius:3px"></div>
              </div>
              <span style="color:var(--text-2)">${Math.round(f.downloaded_count / f.episode_count * 100)}%</span>
            </div>`
          : `<span style="color:var(--text-3)">—</span>`}
      </td>
      <td style="text-align:right;color:var(--text-2);font-size:13px">${f.storage_bytes > 0 ? fmtBytes(f.storage_bytes) : "—"}</td>
      <td style="text-align:right;color:var(--text-2);font-size:13px">${f.runtime_seconds > 0 ? fmtRuntime(f.runtime_seconds) : "—"}</td>
      <td style="text-align:right;color:var(--text-2);font-size:13px">${f.listen_seconds > 0 ? fmtRuntime(f.listen_seconds) : "—"}</td>
      <td style="text-align:right;font-size:13px">
        ${f.unplayed_count > 0 && f.downloaded_count > 0
          ? `<span style="color:var(--primary);font-weight:600">${Math.round(f.unplayed_count / f.downloaded_count * 100)}%</span>`
          : `<span style="color:var(--text-3)">—</span>`}
      </td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-ghost btn-sm stats-focus-btn ${isFocused ? "active" : ""}"
                data-feed-id="${f.feed_id}"
                onclick="toggleFeedFocus(${f.feed_id})">
          ${isFocused ? "← Global" : "Show podcast stats"}
        </button>
      </td>
    </tr>`;
}

function _feedTable(feeds) {
  const cols = [
    { key: "title",            label: "Podcast",     style: "text-align:left"  },
    { key: "episode_count",    label: "Episodes",    style: "text-align:right" },
    { key: "downloaded_count", label: "Downloaded",  style: "text-align:right" },
    { key: "storage_bytes",    label: "Storage",     style: "text-align:right" },
    { key: "runtime_seconds",  label: "Runtime (dl)", style: "text-align:right" },
    { key: "listen_seconds",   label: "Listen Time", style: "text-align:right" },
    { key: "unplayed_count",   label: "Backlog %",   style: "text-align:right" },
  ];

  const header = cols.map((c) =>
    `<th class="stats-th" data-sort="${c.key}" style="${c.style};cursor:pointer;user-select:none">
      ${c.label}${_feedSortKey === c.key ? (_feedSortAsc ? " ▲" : " ▼") : ""}
    </th>`
  ).join("") + `<th></th>`;

  const rows = _sortedFeeds(feeds).map(_feedRow).join("");

  return `<div style="overflow-x:auto">
    <table class="stats-table">
      <thead><tr>${header}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function _wireSortHeaders() {
  document.querySelectorAll(".stats-th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (_feedSortKey === key) {
        _feedSortAsc = !_feedSortAsc;
      } else {
        _feedSortKey = key;
        _feedSortAsc = key === "title";
      }
      // Re-render just the tbody
      const tbody = document.querySelector(".stats-table tbody");
      if (tbody) tbody.innerHTML = _sortedFeeds(_statsGlobalData.by_feed).map(_feedRow).join("");
      // Update header arrows
      document.querySelectorAll(".stats-th[data-sort]").forEach((t) => {
        const base = t.textContent.replace(/[▲▼\s]+$/, "").trim();
        t.textContent = base + (t.dataset.sort === _feedSortKey ? (_feedSortAsc ? " ▲" : " ▼") : "");
      });
      _wireSortHeaders();
    });
  });
}
