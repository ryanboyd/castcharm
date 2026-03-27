"use strict";

// ============================================================
// Login overlay
// ============================================================

function showLoginOverlay() {
  let overlay = document.getElementById("login-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "login-overlay";
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <div class="login-card">
      <div class="login-logo">
        <img src="/static/icon-64.png" alt="" style="width:48px;height:48px;border-radius:12px" />
        <div>
          <div style="font-size:22px;font-weight:700;color:var(--text)">CastCharm</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:1px">Podcast Manager</div>
        </div>
      </div>

      <form id="login-form" autocomplete="on">
        <div class="form-group">
          <label class="form-label">Username</label>
          <input class="form-control" id="login-username" name="username"
                 type="text" autocomplete="username" autofocus required />
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <input class="form-control" id="login-password" name="password"
                 type="password" autocomplete="current-password" required />
        </div>
        <div id="login-error" style="display:none;color:var(--error);font-size:13px;margin-bottom:12px"></div>
        <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center" id="login-btn">
          Sign In
        </button>
      </form>
    </div>`;

  overlay.style.display = "flex";

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("login-btn");
    const errEl = document.getElementById("login-error");
    const username = document.getElementById("login-username").value;
    const password = document.getElementById("login-password").value;

    btn.disabled = true;
    btn.textContent = "Signing in…";
    errEl.style.display = "none";

    try {
      await API.login(username, password);
      overlay.style.display = "none";
      // Re-boot the app now that we're authenticated
      _bootApp();
    } catch (err) {
      let msg = err.message;
      if (typeof err.remaining === "number") {
        msg += err.remaining === 1
          ? " 1 attempt remaining."
          : ` ${err.remaining} attempts remaining.`;
      }
      errEl.textContent = msg;
      errEl.style.display = "block";
      btn.disabled = false;
      btn.textContent = "Sign In";
      document.getElementById("login-password").value = "";
    }
  });
}

function hideLoginOverlay() {
  const overlay = document.getElementById("login-overlay");
  if (overlay) overlay.style.display = "none";
}
