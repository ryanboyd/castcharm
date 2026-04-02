import logging
import mimetypes
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest

from app.database import init_db, SessionLocal
from app.models import Episode, Feed
from app.scheduler import start_scheduler, stop_scheduler, is_running
from app.schemas import StatusOut

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger(__name__)

# Attach the in-memory ring-buffer handler so logs are readable via /api/logs
from app.log_buffer import BufferHandler as _BufHandler  # noqa: E402
_buf_handler = _BufHandler()
_buf_handler.setLevel(logging.INFO)
logging.getLogger().addHandler(_buf_handler)

_static_dir = (Path(__file__).parent.parent / "static").resolve()
_index_html: str = ""


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _index_html
    init_db()
    _ensure_default_settings()
    _cleanup_interrupted_downloads()
    start_scheduler()
    # Pre-process index.html: inject ?v=<version> into all /static/ asset URLs so
    # that a container update (e.g. via Watchtower) busts the browser cache.
    raw = (_static_dir / "index.html").read_text()
    _index_html = re.sub(r'(src|href)="(/static/[^"]+)"', rf'\1="\2?v={APP_VERSION}"', raw)
    yield
    stop_scheduler()


def _ensure_default_settings():
    """Create default GlobalSettings row if it doesn't exist."""
    from app.models import GlobalSettings
    from app.routers.settings import DEFAULT_ID3_MAPPING

    db = SessionLocal()
    try:
        if not db.query(GlobalSettings).first():
            db.add(GlobalSettings(default_id3_mapping=DEFAULT_ID3_MAPPING))
            db.commit()
    finally:
        db.close()


def _cleanup_interrupted_downloads():
    """Move any 'downloading' episodes to 'failed' and delete leftover .part files.

    Handles the case where the server was killed during an active download.
    """
    import logging
    import os
    from app.models import Episode, GlobalSettings

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        stuck = db.query(Episode).filter(Episode.status == "downloading").all()
        if stuck:
            for ep in stuck:
                ep.status = "failed"
                ep.error_message = "Interrupted by server restart"
                ep.download_progress = 0
            db.commit()
            log.info("Marked %d interrupted download(s) as failed", len(stuck))

        # Episodes left in "queued" have no background tasks after a restart — reset
        # them to "pending" so the next download-all picks them up correctly.
        orphaned = db.query(Episode).filter(Episode.status == "queued").all()
        if orphaned:
            for ep in orphaned:
                ep.status = "pending"
                ep.download_progress = 0
            db.commit()
            log.info("Reset %d orphaned queued episode(s) to pending", len(orphaned))

        # Remove any orphaned .part files from the downloads directory
        gs = db.query(GlobalSettings).first()
        base_dir = (gs.download_path if gs else None) or "/downloads"
        if os.path.isdir(base_dir):
            removed = 0
            for root, _dirs, files in os.walk(base_dir):
                for fname in files:
                    if fname.endswith(".part"):
                        try:
                            os.remove(os.path.join(root, fname))
                            removed += 1
                        except OSError:
                            pass
            if removed:
                log.info("Removed %d orphaned .part file(s) from %s", removed, base_dir)
    finally:
        db.close()


import os as _os
APP_VERSION = _os.environ.get("APP_VERSION", "dev")

app = FastAPI(
    title="CastCharm",
    description="Self-hosted podcast manager",
    version=APP_VERSION,
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
)

app.add_middleware(GZipMiddleware, minimum_size=1000)


# ── Security headers middleware ────────────────────────────────────────────────
# CSP notes:
#   script-src  — 'unsafe-inline' removed; all event handlers use data-action
#                 delegation rather than inline onclick/onerror attributes.
#   style-src   — 'unsafe-inline' needed; JS sets element.style.* throughout.
#   img-src     — podcast cover art can come from any HTTPS host in the RSS feed;
#                 blob: is needed for the local file-upload cover-art preview.
#   media-src   — audio streaming goes through the local server only.
#   connect-src — all XHR/fetch calls go to self (the local API).
#   object-src  — block Flash and other legacy plugin content entirely.
#   base-uri    — prevent a <base> tag injection from hijacking relative URLs.
#   frame-ancestors — supersedes X-Frame-Options for modern browsers; kept both
#                     for compatibility with older reverse-proxy stacks.
_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' https: data: blob:; "
    "media-src 'self' blob:; "
    "connect-src 'self'; "
    "font-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'self'"
)

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        response = await call_next(request)
        response.headers.setdefault("Content-Security-Policy", _CSP)
        # Keep X-Frame-Options for reverse proxies / older browsers that don't
        # honour the frame-ancestors CSP directive yet.
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        # Versioned static assets can be cached indefinitely; index.html sets no-cache itself
        if request.url.path.startswith("/static/"):
            response.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
        return response


app.add_middleware(SecurityHeadersMiddleware)


# ── Auth middleware ────────────────────────────────────────────────────────────
# Routes that are always accessible regardless of auth state:
_AUTH_EXEMPT_PREFIXES = (
    "/api/auth/",
    "/api/setup/",
)
_AUTH_EXEMPT_EXACT = {"/api/status"}


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        path = request.url.path

        # Non-API routes (SPA shell, static assets) are always served
        if not path.startswith("/api/"):
            return await call_next(request)

        # Auth/setup endpoints are always accessible
        if any(path.startswith(p) for p in _AUTH_EXEMPT_PREFIXES):
            return await call_next(request)
        if path in _AUTH_EXEMPT_EXACT:
            return await call_next(request)

        # Check whether auth is required for this instance
        db = SessionLocal()
        try:
            from app.auth import is_auth_required, validate_session, COOKIE_NAME
            if not is_auth_required(db):
                return await call_next(request)

            token = request.cookies.get(COOKIE_NAME)
            if token and validate_session(token, db):
                return await call_next(request)
        finally:
            db.close()

        return JSONResponse(
            status_code=401,
            content={"detail": "Authentication required"},
        )


app.add_middleware(AuthMiddleware)

# API routers
from app.routers import feeds, episodes, settings as settings_router, stats as stats_router  # noqa: E402
from app.routers.auth import router as auth_router  # noqa: E402
app.include_router(auth_router)
app.include_router(feeds.router)
app.include_router(episodes.router)
app.include_router(settings_router.router)
app.include_router(stats_router.router)


@app.get("/api/status", response_model=StatusOut, tags=["system"])
def get_status():
    db = SessionLocal()
    try:
        podcasts_total = db.query(func.count(Feed.id)).filter(Feed.primary_feed_id.is_(None)).scalar() or 0
        feeds_total = db.query(func.count(Feed.id)).scalar() or 0
        episodes_total = db.query(func.count(Episode.id)).scalar() or 0
        episodes_downloaded = (
            db.query(func.count(Episode.id)).filter(Episode.status == "downloaded").scalar() or 0
        )
        active_downloads = (
            db.query(func.count(Episode.id)).filter(Episode.status == "downloading").scalar() or 0
        )
        download_queue_size = (
            db.query(func.count(Episode.id)).filter(Episode.status == "queued").scalar() or 0
        )

        storage = (
            db.query(func.sum(Episode.file_size))
            .filter(Episode.status == "downloaded", Episode.file_size.isnot(None))
            .scalar() or 0
        )

        episodes_failed = (
            db.query(func.count(Episode.id)).filter(Episode.status == "failed").scalar() or 0
        )

        from app.activity import get_syncing_count, get_syncing_feed_ids, is_xml_regenerating, is_opml_generating, is_autoclean_running
        from app.scheduler import get_next_run_any, get_download_window_status
        from app.importer import get_active_import_count

        # Primary feed IDs with any queued or active downloads (handles supplementary feeds)
        _active_feed_ids = [
            r[0] for r in db.query(Episode.feed_id)
            .filter(Episode.status.in_(["queued", "downloading"]))
            .distinct().all()
        ]
        if _active_feed_ids:
            _feed_rows = db.query(Feed.id, Feed.primary_feed_id).filter(Feed.id.in_(_active_feed_ids)).all()
            downloading_feed_ids = list({f.primary_feed_id or f.id for f in _feed_rows})
        else:
            downloading_feed_ids = []

        return StatusOut(
            scheduler_running=is_running(),
            download_queue_size=download_queue_size,
            active_downloads=active_downloads,
            podcasts_total=podcasts_total,
            feeds_total=feeds_total,
            episodes_total=episodes_total,
            episodes_downloaded=episodes_downloaded,
            episodes_failed=episodes_failed,
            storage_bytes=storage,
            version=APP_VERSION,
            syncing_count=get_syncing_count(),
            next_sync_at=get_next_run_any(),
            importing_count=get_active_import_count(),
            scanning=False,
            downloading_feed_ids=downloading_feed_ids,
            syncing_feed_ids=get_syncing_feed_ids(),
            xml_regenerating=is_xml_regenerating(),
            opml_generating=is_opml_generating(),
            autoclean_running=is_autoclean_running(),
            **dict(zip(("download_window_paused", "download_window_next_open"), get_download_window_status())),
        )
    finally:
        db.close()


@app.get("/api/system/browse-dirs", tags=["system"])
def browse_dirs(path: str = Query(default="/")):
    """List immediate subdirectories of a server-side path (for the setup folder picker)."""
    import os
    path = os.path.normpath(path)
    if not os.path.isdir(path):
        raise HTTPException(status_code=404, detail="Directory not found")
    entries = []
    try:
        for entry in sorted(os.scandir(path), key=lambda e: e.name.lower()):
            if entry.is_dir() and not entry.name.startswith("."):
                entries.append({"name": entry.name, "path": entry.path})
    except PermissionError:
        pass  # return whatever we managed to collect before hitting a denied dir
    parent = str(Path(path).parent) if path != "/" else None
    return {"path": path, "parent": parent, "entries": entries}


# Serve the SPA index for the root path only.
# Cache-Control: no-cache ensures the browser revalidates this on every load,
# so asset URLs (which carry ?v=<version>) are always current after an update.
@app.get("/", include_in_schema=False)
def serve_root():
    return HTMLResponse(content=_index_html, headers={"Cache-Control": "no-cache"})


# Mount static files last, with no catch-all above to shadow it.
# Assets are served with a long max-age — safe because index.html injects
# ?v=<APP_VERSION> into every URL, so a version bump busts the cache.
if _static_dir.is_dir():
    app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")
