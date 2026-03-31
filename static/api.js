"use strict";

// ============================================================
// API client
// All methods return Promises that resolve to parsed JSON,
// except for streamEpisode() and exportOpml() which return
// plain URL strings for use in <audio src> and <a href> respectively.
// ============================================================

// We consolidate multipart form uploads into a shared helper so that
// the fetch + error-extraction boilerplate isn't repeated for each endpoint.
async function _upload(url, fieldName, file, extraFields) {
  const fd = new FormData();
  fd.append(fieldName, file);
  if (extraFields) {
    for (const [k, v] of Object.entries(extraFields)) fd.append(k, v);
  }
  const res = await fetch(url, { method: "POST", body: fd });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let detail = null;
    try { const j = await res.json(); detail = j.detail; } catch (_) {}
    msg = typeof detail === "string" ? detail : (detail?.message || msg);
    const err = new Error(msg);
    if (detail && typeof detail === "object") Object.assign(err, detail);
    throw err;
  }
  return res.json();
}

const API = {
  async request(method, path, body) {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (!res.ok) {
      if (res.status === 401 && typeof window._onAuthRequired === "function") {
        window._onAuthRequired();
      }
      let msg = `HTTP ${res.status}`;
      let detail = null;
      try { const j = await res.json(); detail = j.detail; } catch (_) {}
      msg = typeof detail === "string" ? detail : (detail?.message || msg);
      const err = new Error(msg);
      err.status = res.status;
      if (detail && typeof detail === "object") Object.assign(err, detail);
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  },
  get:    (p)    => API.request("GET",    p),
  post:   (p, b) => API.request("POST",   p, b),
  put:    (p, b) => API.request("PUT",    p, b),
  delete: (p)    => API.request("DELETE", p),

  // ── Settings ────────────────────────────────────────────────
  getSettings:      () =>  API.get("/api/settings"),
  putSettings:      (b) => API.put("/api/settings", b),
  runAutocleanNow:  ()  => API.post("/api/settings/autoclean/run", {}),
  getID3Tags:       () =>  API.get("/api/settings/id3-tags"),
  getRSSSources:    () =>  API.get("/api/settings/rss-sources"),
  getServerTimezone: () => API.get("/api/settings/server-timezone"),
  getTimezones:     () =>  API.get("/api/settings/timezones"),
  getLogs: (limit = 500, level = null) => {
    const p = new URLSearchParams({ limit });
    if (level) p.set("level", level);
    return API.get(`/api/settings/logs?${p}`);
  },

  // ── Feeds ────────────────────────────────────────────────────
  getFeeds:     () =>         API.get("/api/feeds"),
  addFeed:         (url, downloadAll = false, titleOverride = null) => API.post("/api/feeds", { url, download_all: downloadAll, title_override: titleOverride || undefined }),
  addManualFeed:   (title) =>   API.post("/api/feeds/manual", { title }),
  createFeedFromXml: (file, titleOverride) => _upload("/api/feeds/from-xml", "file", file, titleOverride ? { title_override: titleOverride } : null),
  getFeed:      (id) =>       API.get(`/api/feeds/${id}`),
  updateFeed:   (id, b) =>    API.put(`/api/feeds/${id}`, b),
  deleteFeed:   (id, deleteFiles = false) => API.delete(`/api/feeds/${id}?delete_files=${deleteFiles}`),
  syncFeed:       (id) =>     API.post(`/api/feeds/${id}/refresh`),
  clearFeedError: (id) =>     API.post(`/api/feeds/${id}/clear-error`, {}),
  syncAllFeeds: () =>         API.post("/api/feeds/refresh-all"),
  markAllPlayed: (id) =>      API.post(`/api/feeds/${id}/mark-all-played`),
  renumberFeed: (id) =>       API.post(`/api/feeds/${id}/renumber`),
  applyFileUpdates: (id) =>   API.post(`/api/feeds/${id}/apply-file-updates`),
  cleanupPreview:    (id) => API.get(`/api/feeds/${id}/cleanup-preview`),
  runFeedAutoclean:  (id) => API.post(`/api/feeds/${id}/autoclean/run`, {}),
  getImportStatus: (id) =>    API.get(`/api/feeds/${id}/import-status`),
  previewImport: (id, directory) => API.post(`/api/feeds/${id}/import-preview`, { directory }),
  commitImport:  (id, items) =>     API.post(`/api/feeds/${id}/import-stage`, { items }),
  downloadAllFeed:      (id) => API.post(`/api/feeds/${id}/download-all`),
  downloadUnplayedFeed: (id) => API.post(`/api/feeds/${id}/download-unplayed`),
  cancelFeedQueued:     (id) => API.post(`/api/feeds/${id}/cancel-queued`),
  getFeedEpisodes: (id, limit, offset, order = "desc") =>
    API.get(`/api/feeds/${id}/episodes?limit=${limit}&offset=${offset}&order=${order}`),
  getFeedEpisodesWithHidden: (id, limit, offset, order = "desc") =>
    API.get(`/api/feeds/${id}/episodes?include_hidden=true&limit=${limit}&offset=${offset}&order=${order}`),
  getFeedRSSSources: (id) =>  API.get(`/api/feeds/${id}/rss-sources`),
  getSupplementary:  (id) =>  API.get(`/api/feeds/${id}/supplementary`),
  addSupplementary:  (id, url) => API.post(`/api/feeds/${id}/supplementary`, { url }),
  removeSupplementary: (feedId, subId) => API.delete(`/api/feeds/${feedId}/supplementary/${subId}`),

  // Cover art — upload uses multipart; removal uses DELETE
  uploadFeedCover: (id, file) => _upload(`/api/feeds/${id}/upload-cover`, "image", file),
  removeFeedCover: (id) =>       API.delete(`/api/feeds/${id}/cover`),

  // ── Episodes ─────────────────────────────────────────────────
  getEpisodes: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return API.get(`/api/episodes${qs ? "?" + qs : ""}`);
  },
  getEpisode:       (id) =>       API.get(`/api/episodes/${id}`),
  downloadEpisode:  (id) =>       API.post(`/api/episodes/${id}/download`),
  retryEpisode:     (id) =>       API.post(`/api/episodes/${id}/retry`),
  cancelEpisode:    (id) =>       API.post(`/api/episodes/${id}/cancel`),
  dismissFailed:    (id) =>       API.post(`/api/episodes/${id}/dismiss`),
  deleteEpisodeFile: (id) =>      API.delete(`/api/episodes/${id}/file`),
  hideEpisode:      (id) =>       API.post(`/api/episodes/${id}/hide`),
  unhideEpisode:    (id) =>       API.post(`/api/episodes/${id}/unhide`),
  setEpisodeNumber: (id, num) =>  API.post(`/api/episodes/${id}/set-number`, { seq_number: num }),
  setEpisodeImage:  (id, url) =>  API.post(`/api/episodes/${id}/set-image`, { url }),
  setEpisodeTags:   (id, tags) => API.post(`/api/episodes/${id}/set-id3-tags`, { tags }),
  uploadEpisodeImage: (id, file) => _upload(`/api/episodes/${id}/upload-image`, "image", file),

  // Bulk operations across all episodes
  downloadAll:      () => API.post("/api/episodes/download-all"),
  downloadUnplayed: () => API.post("/api/episodes/download-unplayed"),
  cancelQueued:     () => API.post("/api/episodes/cancel-queued"),
  cancelAll:        () => API.post("/api/episodes/cancel-all"),
  dismissAllFailed: () => API.post("/api/episodes/dismiss-all-failed"),
  retryAllFailed:   () => API.post("/api/episodes/retry-all-failed"),
  bulkAction: (episode_ids, action) => API.post("/api/episodes/bulk", { episode_ids, action }),

  // ── Playback ─────────────────────────────────────────────────
  // streamEpisode returns a URL string, not a promise — use directly in <audio src>
  streamEpisode: (id) => `/api/episodes/${id}/stream`,
  togglePlayed:     (id) => API.post(`/api/episodes/${id}/played`),
  updateProgress:   (id, position_seconds) => API.post(`/api/episodes/${id}/progress`, { position_seconds }),
  continueListening: (limit = 10) => API.get(`/api/episodes/continue-listening?limit=${limit}`),
  getSuggestions: () => API.get("/api/episodes/suggestions"),
  getActiveProgress: () => API.get("/api/episodes/active-progress"),

  // ── Auth ─────────────────────────────────────────────────────
  getAuthStatus: () => API.get("/api/auth/status"),
  login: async (username, password) => {
    // Bypass the generic API wrapper so a 401 (wrong credentials) does not
    // trigger window._onAuthRequired and blow away the login form.
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(j.detail || `HTTP ${res.status}`);
      if (j.remaining != null) err.remaining = j.remaining;
      throw err;
    }
    return j;
  },
  logout: () => API.post("/api/auth/logout"),
  updateCredentials: (current_password, new_username, new_password) =>
    API.put("/api/auth/credentials", { current_password, new_username, new_password }),
  disableAuth: () => API.post("/api/auth/disable"),
  completeSetup: (body) => API.post("/api/setup/complete", body),
  browseDirs: (path) => API.get(`/api/system/browse-dirs?path=${encodeURIComponent(path)}`),

  // ── Status ───────────────────────────────────────────────────
  getStatus: () => API.get("/api/status"),

  // ── Stats ────────────────────────────────────────────────────
  getStats:     () =>     API.get("/api/stats"),
  getFeedStats: (id) =>   API.get(`/api/stats/feeds/${id}`),

  // ── OPML ─────────────────────────────────────────────────────
  // exportOpml returns a URL string, not a promise — use directly in <a href>
  exportOpml: () => "/api/feeds/opml",
  importOpml: (file) => _upload("/api/feeds/opml", "file", file),

  // ── Feed XML import ──────────────────────────────────────────
  uploadFeedXml:   (id, file) => _upload(`/api/feeds/${id}/import-feed-xml`, "file", file),
  previewFeedXml:  (id, file) => _upload(`/api/feeds/${id}/preview-feed-xml`, "file", file),
  commitFeedXml:   (id, tempId, resolutions) => API.post(`/api/feeds/${id}/commit-feed-xml`, { temp_id: tempId, resolutions }),
};
