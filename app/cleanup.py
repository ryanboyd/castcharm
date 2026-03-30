"""keep_latest auto-cleanup: delete oldest downloaded files exceeding the per-feed or global limit."""
import logging
import os
from sqlalchemy.orm import Session

from app.models import Feed, Episode, GlobalSettings
from app.utils import get_group_feed_ids

log = logging.getLogger(__name__)


def _resolve_settings(feed: Feed, db: Session) -> tuple[int | None, str]:
    """Return (effective_limit, mode) for a feed.

    Unplayed episodes are always protected in 'recent' mode (keep_unplayed=True is hardcoded).
    Returns (None, 'recent') when cleanup is disabled or excluded for this feed.
    """
    # Per-feed exclude: skip entirely
    if feed.autoclean_exclude:
        return None, "recent"

    gs = db.query(GlobalSettings).first()

    if gs and gs.autoclean_enabled:
        # Global autoclean governs all non-excluded feeds
        mode = gs.autoclean_mode or "unplayed"
        limit = gs.keep_latest if mode == "recent" else None
        return limit, mode
    else:
        # Per-feed standalone cleanup (only active when global autoclean is off)
        if not feed.autoclean_enabled:
            return None, "recent"
        mode = feed.autoclean_mode or "unplayed"
        limit = feed.keep_latest if mode == "recent" else None
        return limit, mode


def _candidates(all_ids: list[int], db: Session) -> list[Episode]:
    """All downloaded non-hidden episodes ordered newest-first."""
    return (
        db.query(Episode)
        .filter(
            Episode.feed_id.in_(all_ids),
            Episode.status == "downloaded",
            Episode.file_path.isnot(None),
            Episode.hidden.is_(False),
        )
        .order_by(Episode.download_date.desc().nullslast())
        .all()
    )


def _to_delete_list(all_eps: list, limit: int | None, mode: str) -> list:
    """Compute which episodes should be deleted given the cleanup settings."""
    if mode == "unplayed":
        # Keep all unplayed and partially-played episodes; delete only fully played ones.
        return [ep for ep in all_eps if ep.played]
    else:
        # "recent" mode: keep N most recent downloads; unplayed are always protected.
        if not limit or limit <= 0:
            return []
        played_eps = [ep for ep in all_eps if ep.played]
        return played_eps[limit:] if len(played_eps) > limit else []


def _delete_files(to_delete: list, db: Session, feed_id: int, limit: int | None = None) -> list[int]:
    """Delete files and reset episode state for a list of episodes."""
    deleted_ids = []
    for ep in to_delete:
        file_existed = bool(ep.file_path and os.path.exists(ep.file_path))
        if file_existed:
            try:
                os.remove(ep.file_path)
            except OSError as e:
                log.warning("cleanup: could not delete %s: %s", ep.file_path, e)
                continue  # skip DB reset — file still exists on disk
            base = os.path.splitext(ep.file_path)[0]
            for ext in (".xml", ".jpg", ".png", ".webp"):
                sidecar = (ep.file_path + ext) if ext == ".xml" else (base + ext)
                try:
                    if os.path.exists(sidecar):
                        os.remove(sidecar)
                except OSError as e:
                    log.warning("cleanup: could not delete sidecar %s: %s", sidecar, e)
        # Reset DB state whether file was deleted or was already missing
        ep.status = "pending"
        ep.file_path = None
        ep.file_size = None
        ep.download_date = None
        ep.download_progress = 0
        deleted_ids.append(ep.id)

    if deleted_ids:
        db.commit()
        limit_str = f" (limit={limit})" if limit is not None else ""
        log.info(
            "cleanup for feed %d: removed %d episode(s)%s",
            feed_id, len(deleted_ids), limit_str,
        )
    return deleted_ids


def run_keep_latest_cleanup(feed_id: int, db: Session) -> list[int]:
    """Delete downloaded files for episodes beyond the keep_latest limit.

    Mode "recent": keeps N most recent downloads (optionally protecting unplayed).
    Mode "unplayed": keeps N most recent unplayed; deletes all played episodes.

    Returns a list of episode IDs whose files were deleted.
    feed_id must be a primary feed ID.
    """
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        return []

    limit, mode = _resolve_settings(feed, db)
    if mode != "unplayed" and (not limit or limit <= 0):
        return []

    all_ids = get_group_feed_ids(db, feed_id)
    all_eps = _candidates(all_ids, db)
    to_delete = _to_delete_list(all_eps, limit, mode)
    return _delete_files(to_delete, db, feed_id, limit)


def preview_keep_latest_cleanup(feed_id: int, db: Session) -> dict:
    """Return how many files would be deleted without actually deleting anything."""
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        return {"mode": "recent", "would_delete": 0, "episode_ids": []}

    limit, mode = _resolve_settings(feed, db)
    if mode != "unplayed" and (not limit or limit <= 0):
        return {"limit": None, "mode": mode, "would_delete": 0, "episode_ids": []}

    all_ids = get_group_feed_ids(db, feed_id)
    all_eps = _candidates(all_ids, db)
    to_delete = _to_delete_list(all_eps, limit, mode)

    return {
        "limit": limit,
        "mode": mode,
        "would_delete": len(to_delete),
        "episode_ids": [ep.id for ep in to_delete],
    }


def run_autoclean_all_feeds(db: Session) -> int:
    """Run cleanup for every active primary feed. Returns total files deleted."""
    gs = db.query(GlobalSettings).first()
    if not gs or not gs.autoclean_enabled:
        return 0
    mode = gs.autoclean_mode or "unplayed"
    if mode != "unplayed" and not gs.keep_latest:
        return 0

    feeds = db.query(Feed).filter(
        Feed.primary_feed_id.is_(None), Feed.active.is_(True)
    ).all()

    total = 0
    affected = 0
    for feed in feeds:
        try:
            deleted = run_keep_latest_cleanup(feed.id, db)
            if deleted:
                total += len(deleted)
                affected += 1
        except Exception as e:
            log.warning("Autoclean failed for feed %d: %s", feed.id, e)

    log.info("Auto-cleanup complete: %d file(s) removed across %d of %d feed(s)",
             total, affected, len(feeds))
    return total
