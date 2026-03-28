"""keep_latest auto-cleanup: delete oldest downloaded files exceeding the per-feed or global limit."""
import logging
import os
from sqlalchemy.orm import Session

from app.models import Feed, Episode, GlobalSettings
from app.utils import get_group_feed_ids

log = logging.getLogger(__name__)


def _resolve_settings(feed: Feed, db: Session) -> tuple[int | None, bool]:
    """Return (effective_limit, effective_keep_unplayed) for a feed."""
    gs = None

    limit = feed.keep_latest
    if limit is None:
        gs = db.query(GlobalSettings).first()
        limit = gs.keep_latest if gs else None

    # keep_unplayed: per-feed value wins; fall back to global
    keep_unplayed = feed.keep_unplayed
    if keep_unplayed is None:
        if gs is None:
            gs = db.query(GlobalSettings).first()
        keep_unplayed = bool(gs.keep_unplayed) if gs else False

    return limit, bool(keep_unplayed)


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


def run_keep_latest_cleanup(feed_id: int, db: Session) -> list[int]:
    """Delete downloaded files for the oldest episodes beyond the keep_latest limit.

    When keep_unplayed is enabled, unplayed episodes are excluded from the count
    and will never be deleted by this routine.

    Returns a list of episode IDs whose files were deleted.
    feed_id must be a primary feed ID.
    """
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        return []

    limit, keep_unplayed = _resolve_settings(feed, db)
    if not limit or limit <= 0:
        return []

    all_ids = get_group_feed_ids(db, feed_id)

    all_eps = _candidates(all_ids, db)

    if keep_unplayed:
        # Split into played (eligible for cleanup) and unplayed (protected)
        played_eps = [ep for ep in all_eps if ep.played]
        # Only the played episodes count against the limit; oldest played ones get deleted
        to_delete = played_eps[limit:] if len(played_eps) > limit else []
    else:
        to_delete = all_eps[limit:] if len(all_eps) > limit else []

    deleted_ids = []
    for ep in to_delete:
        if ep.file_path and os.path.exists(ep.file_path):
            try:
                os.remove(ep.file_path)
                base = os.path.splitext(ep.file_path)[0]
                for ext in (".xml", ".jpg", ".png", ".webp"):
                    sidecar = (ep.file_path + ext) if ext == ".xml" else (base + ext)
                    if os.path.exists(sidecar):
                        os.remove(sidecar)
            except OSError:
                continue
        ep.status = "pending"
        ep.file_path = None
        ep.file_size = None
        ep.download_date = None
        ep.download_progress = 0
        deleted_ids.append(ep.id)

    if deleted_ids:
        db.commit()
        log.info(
            "keep_latest cleanup for feed %d: deleted %d file(s) (limit=%d)",
            feed_id, len(deleted_ids), limit,
        )

    return deleted_ids


def preview_keep_latest_cleanup(feed_id: int, db: Session) -> dict:
    """Return how many files would be deleted without actually deleting anything."""
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        return {"limit": None, "keep_unplayed": False, "would_delete": 0, "episode_ids": []}

    limit, keep_unplayed = _resolve_settings(feed, db)
    if not limit or limit <= 0:
        return {"limit": None, "keep_unplayed": keep_unplayed, "would_delete": 0, "episode_ids": []}

    all_ids = get_group_feed_ids(db, feed_id)

    all_eps = _candidates(all_ids, db)

    if keep_unplayed:
        played_eps = [ep for ep in all_eps if ep.played]
        to_delete = played_eps[limit:] if len(played_eps) > limit else []
    else:
        to_delete = all_eps[limit:] if len(all_eps) > limit else []

    return {
        "limit": limit,
        "keep_unplayed": keep_unplayed,
        "would_delete": len(to_delete),
        "episode_ids": [ep.id for ep in to_delete],
    }
