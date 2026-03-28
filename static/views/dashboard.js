"use strict";

window._markCLPlayed = async function(epId) {
  try {
    await API.togglePlayed(epId);
    if (Player.currentId() === epId) Player.togglePause();
    const item = document.getElementById(`cl-ep-${epId}`);
    const card = item?.closest(".card");
    animateRemove(item, () => {
      // If no more Continue Listening items remain, also animate the card out
      if (!document.querySelector("[id^=cl-ep-]") && card) animateRemove(card);
    });
  } catch (e) { Toast.error(e.message); }
};

// 32×32 activity thumbnail with SVG fallback matching the feed card placeholder
function _thumb(url) {
  const placeholder = `<div style="width:32px;height:32px;border-radius:6px;background:var(--bg-3);display:flex;align-items:center;justify-content:center;flex-shrink:0">${_PODCAST_SVG}</div>`;
  if (!url) return placeholder;
  const hidden = `<div style="width:32px;height:32px;border-radius:6px;background:var(--bg-3);display:none;align-items:center;justify-content:center;flex-shrink:0">${_PODCAST_SVG}</div>`;
  return `<img src="${url}" style="width:32px;height:32px;border-radius:6px;object-fit:cover;flex-shrink:0"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />${hidden}`;
}

function _miniPie(pct) {
  const r = 10, cx = 12, cy = 12, stroke = 3;
  const circ = 2 * Math.PI * r;
  const fill = Math.max(0, Math.min(1, pct / 100)) * circ;
  return `<svg width="24" height="24" viewBox="0 0 24 24" style="display:block">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg-3)" stroke-width="${stroke}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--primary)" stroke-width="${stroke}"
            stroke-dasharray="${fill.toFixed(2)} ${circ.toFixed(2)}"
            stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>
  </svg>`;
}

// ============================================================
// Dashboard view
// ============================================================
async function viewDashboard() {
  window._onSyncIdle = viewDashboard;

  const [status, feeds, recentDL, continueEps, suggestions] = await Promise.all([
    API.getStatus(),
    API.getFeeds(),
    API.getEpisodes({ status: "downloaded", limit: 5 }),
    API.continueListening(5),
    API.getSuggestions(),
  ]);

  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-title">Dashboard</div>
          <div class="page-subtitle">Your podcast overview</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" id="btn-sync-all-dash">
            ${svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>')}
            Sync All Feeds
          </button>
          <button class="btn btn-primary" onclick="showAddFeedModal()">
            ${svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>')}
            Add Podcast
          </button>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card" style="cursor:pointer" onclick="Router.navigate('/feeds')">
          <div class="stat-label">Podcasts</div>
          <div class="stat-value">${status.podcasts_total}</div>
          <div class="stat-sub">${status.feeds_total} total feeds</div>
        </div>
        <div class="stat-card" style="cursor:pointer" onclick="Router.navigate('/downloads')">
          <div class="stat-label">Downloaded</div>
          <div class="stat-value">${status.episodes_downloaded}</div>
          <div class="stat-sub">${status.episodes_total - status.episodes_downloaded} available${status.episodes_failed > 0 ? ` · <span style="color:var(--error)">${status.episodes_failed} failed</span>` : ""}</div>
        </div>
        <div class="stat-card" style="cursor:pointer" onclick="window._pendingDLTab='inprogress';Router.navigate('/downloads')">
          <div class="stat-label">Queue</div>
          <div class="stat-value">${status.download_queue_size + status.active_downloads}</div>
          <div class="stat-sub">${status.active_downloads} active</div>
        </div>
        <div class="stat-card" style="cursor:pointer" onclick="Router.navigate('/stats')">
          <div class="stat-label">Storage</div>
          <div class="stat-value">${fmtBytes(status.storage_bytes)}</div>
          <div class="stat-sub">used by downloads</div>
        </div>
      </div>

      ${continueEps.length > 0 ? `
      <div class="card" style="margin-bottom:12px">
        <div class="card-body">
          <div class="section-title">Continue Listening</div>
          ${continueEps.map((ep) => {
            const isPlaying = Player.currentId() === ep.id && Player.isPlaying();
            const minsIn = ep.play_position_seconds ? Math.floor(ep.play_position_seconds / 60) + "m in" : "";
            return `
            <div class="activity-item" id="cl-ep-${ep.id}">
              <div class="activity-icon" style="cursor:pointer" onclick="window._pendingEpScroll=${ep.id};Router.navigate('/feeds/${ep.feed_id}')">
                ${_thumb(ep.custom_image_url || ep.episode_image_url || ep.feed_image_url)}
              </div>
              <div class="activity-info" style="flex:1;min-width:0">
                <div class="activity-title truncate" style="cursor:pointer"
                     onclick="window._pendingEpScroll=${ep.id};Router.navigate('/feeds/${ep.feed_id}')">${ep.title || "Untitled"}</div>
                <div class="activity-sub">
                  <span class="cl-feed-link" style="cursor:pointer;text-decoration:underline;text-decoration-color:transparent"
                        onmouseover="this.style.textDecorationColor=''"
                        onmouseout="this.style.textDecorationColor='transparent'"
                        onclick="Router.navigate('/feeds/${ep.feed_id}')">${ep.feed_title || ""}</span>${minsIn ? ` · ${minsIn}` : ""}
                </div>
              </div>
              <button class="btn btn-ghost btn-sm btn-icon ep-play-btn" data-ep-id="${ep.id}"
                      title="${isPlaying ? "Pause" : "Play"}" onclick="playEpisode(${ep.id})">
                ${isPlaying ? svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>') : svg('<polygon points="5 3 19 12 5 21 5 3"/>')}
              </button>
              <button class="btn btn-ghost btn-sm btn-icon" title="Mark as played"
                      onclick="_markCLPlayed(${ep.id})">
                ${svg('<polyline points="20 6 9 17 4 12"/>')}
              </button>
            </div>`;
          }).join("")}
        </div>
      </div>` : ""}

      ${(() => {
        const allSuggestions = [
          ...(suggestions.short      || []),
          ...(suggestions.medium     || []),
          ...(suggestions.long       || []),
          ...(suggestions.extra_long || []),
        ].slice(0, 6);
        if (!allSuggestions.length) return "";
        return `
        <div class="card" style="margin-bottom:12px">
          <div class="card-body">
            <div class="section-title" style="margin-bottom:12px">Suggested Listening</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 24px">
              ${allSuggestions.map(ep => `
                <div class="activity-item" style="cursor:pointer"
                     onclick="window._pendingEpScroll=${ep.id};Router.navigate('/feeds/${ep.feed_id}')">
                  <div class="activity-icon" style="flex-shrink:0">
                    ${_thumb(ep.custom_image_url || ep.episode_image_url || ep.feed_image_url)}
                  </div>
                  <div class="activity-info" style="flex:1;min-width:0">
                    <div class="activity-title truncate">${ep.title || "Untitled"}</div>
                    <div class="activity-sub" style="display:flex;align-items:center;gap:6px">
                      <span style="cursor:pointer;text-decoration:underline;text-decoration-color:transparent"
                            onmouseover="this.style.textDecorationColor=''"
                            onmouseout="this.style.textDecorationColor='transparent'"
                            onclick="event.stopPropagation();Router.navigate('/feeds/${ep.feed_id}')">${ep.feed_title || ""}</span>
                      ${ep.duration ? `<span>· ${ep.duration}</span>` : ""}
                    </div>
                  </div>
                  <button class="btn btn-ghost btn-sm btn-icon" title="Play"
                          onclick="event.stopPropagation();playEpisode(${ep.id})">
                    ${svg('<polygon points="5 3 19 12 5 21 5 3"/>')}
                  </button>
                </div>`).join("")}
            </div>
          </div>
        </div>`;
      })()}

      <div class="dash-grid">
        <div class="card">
          <div class="card-body">
            <div class="section-title">Recently Updated</div>
            ${(() => {
              const withDL = feeds
                .filter((f) => f.last_download_at)
                .sort((a, b) => new Date(b.last_download_at) - new Date(a.last_download_at))
                .slice(0, 5);
              if (withDL.length === 0) {
                return `<div class="empty-state" style="padding:24px 16px">
                  <div class="empty-state-title" style="font-size:13px">No downloads yet</div>
                </div>`;
              }
              return withDL.map((f) => `
                <div class="activity-item">
                  <div class="activity-icon">
                    ${_thumb(f.custom_image_url || f.image_url)}
                  </div>
                  <div class="activity-info">
                    <div class="activity-title truncate"
                         style="cursor:pointer;color:var(--text)"
                         onclick="Router.navigate('/feeds/${f.id}')">
                      ${f.title || f.url}
                    </div>
                    <div class="activity-sub">
                      ${f.downloaded_count} downloaded · last ${timeAgo(f.last_download_at)}
                    </div>
                  </div>
                </div>`).join("");
            })()}
          </div>
        </div>

        <div class="card">
          <div class="card-body">
            <div class="section-title">Recently Released Episodes</div>
            ${recentDL.length === 0
              ? `<div class="empty-state" style="padding:24px 16px">
                  <div class="empty-state-title" style="font-size:13px">No downloads yet</div>
                </div>`
              : recentDL.map((ep) => `
                <div class="activity-item" style="cursor:pointer"
                     onclick="window._pendingEpScroll=${ep.id};Router.navigate('/feeds/${ep.feed_id}')">
                  <div class="activity-icon">
                    ${_thumb(ep.custom_image_url || ep.episode_image_url || ep.feed_image_url)}
                  </div>
                  <div class="activity-info">
                    <div class="activity-title truncate">${ep.title || "Untitled"}</div>
                    <div class="activity-sub">
                      <span style="cursor:pointer;text-decoration:underline;text-decoration-color:transparent"
                            onmouseover="this.style.textDecorationColor=''"
                            onmouseout="this.style.textDecorationColor='transparent'"
                            onclick="event.stopPropagation();Router.navigate('/feeds/${ep.feed_id}')">${ep.feed_title || ""}</span> · ${timeAgo(ep.download_date)}${ep.file_size ? ` · ${fmtBytes(ep.file_size)}` : ""}
                    </div>
                  </div>
                </div>`).join("")}
          </div>
        </div>

        <div class="card">
          <div class="card-body">
            <div class="section-title">Feed Errors</div>
            ${(() => {
              const errFeeds = feeds.filter((f) => f.last_error).slice(0, 6);
              if (errFeeds.length === 0) {
                return `<div style="display:flex;align-items:center;gap:8px;padding:12px 0;color:var(--success);font-size:13px">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  All feeds healthy
                </div>`;
              }
              return errFeeds.map((f) => `
                <div class="activity-item" style="cursor:pointer" onclick="Router.navigate('/feeds/${f.id}')">
                  <div class="activity-icon" style="color:var(--error)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:22px;height:22px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  </div>
                  <div class="activity-info">
                    <div class="activity-title truncate" style="color:var(--text)">${f.title || f.url}</div>
                    <div class="activity-sub" style="color:var(--error)">${(f.last_error || "").slice(0, 80)}</div>
                  </div>
                </div>`).join("");
            })()}
          </div>
        </div>

        <div class="card">
          <div class="card-body">
            <div class="section-title">Top Backlog</div>
            ${(() => {
              const backlog = feeds
                .filter((f) => f.unplayed_count > 0)
                .sort((a, b) => b.unplayed_count - a.unplayed_count)
                .slice(0, 6);
              if (backlog.length === 0) {
                return `<div style="padding:12px 0;color:var(--text-3);font-size:13px">All caught up</div>`;
              }
              return backlog.map((f) => `
                <div class="activity-item" style="cursor:pointer" onclick="Router.navigate('/feeds/${f.id}')">
                  <div class="activity-icon">
                    ${_thumb(f.custom_image_url || f.image_url)}
                  </div>
                  <div class="activity-info">
                    <div class="activity-title truncate" style="color:var(--text)">${f.title || f.url}</div>
                    <div class="activity-sub">${f.unplayed_count} of ${f.downloaded_count} unplayed</div>
                  </div>
                  <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;gap:2px">
                    ${_miniPie(Math.round(f.unplayed_count / f.downloaded_count * 100))}
                    <span style="font-size:11px;font-weight:600;color:var(--primary)">${Math.round(f.unplayed_count / f.downloaded_count * 100)}% backlogged</span>
                  </div>
                </div>`).join("");
            })()}
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById("btn-sync-all-dash")?.addEventListener("click", async (e) => {
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
      btn.innerHTML = `${svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>')} Sync All Feeds`;
    }
  });
}
