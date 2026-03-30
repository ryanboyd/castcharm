import logging
import os
import tempfile
import uuid as _uuid
from datetime import datetime
from typing import Optional

log = logging.getLogger(__name__)
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, UploadFile, File, Form
from app.downloader import enqueue_download
from sqlalchemy import func, text, bindparam
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Feed, Episode, GlobalSettings
from app.utils import get_group_feed_ids
from app.schemas import (
    FeedCreate, FeedUpdate, FeedOut, EpisodeOut, RSSSourceInfo,
    ImportFilesRequest, ImportPreviewRequest, ImportStageRequest,
    ManualFeedCreate,
)
from app.rss_parser import fetch_feed_metadata, sync_feed_episodes, resolve_feed_url, preview_xml_collisions
from pydantic import BaseModel as _BaseModel

_FIELD_LABELS = {
    "episode.title": "Episode Title",
    "episode.author": "Episode Author",
    "episode.description": "Episode Description",
    "episode.published": "Episode Publication Date",
    "episode.episode_number": "Episode Number",
    "episode.season_number": "Season Number",
    "episode.duration": "Episode Duration",
    "episode.image": "Episode Cover Art",
    "feed.title": "Podcast Title",
    "feed.author": "Podcast Author",
    "feed.category": "Podcast Category",
    "feed.image": "Podcast Cover Art",
}

router = APIRouter(prefix="/api/feeds", tags=["feeds"])

# Temporary XML files staged for collision-reviewed import: temp_id → file path
_pending_xml_imports: dict[str, str] = {}


class _CommitXmlBody(_BaseModel):
    temp_id: str
    resolutions: dict = {}


def _bulk_episode_counts(feed_ids: list[int], db: Session) -> dict[int, dict]:
    """Single aggregation query returning all episode counts for a set of feed IDs.

    Replaces the 9 individual COUNT queries that _feed_out previously issued per
    feed. Groups by feed_id so the caller can aggregate across primary + subs.
    """
    if not feed_ids:
        return {}
    stmt = text("""
        SELECT
            feed_id,
            COUNT(CASE WHEN hidden = 0                                                        THEN 1 END) AS episode_count,
            COUNT(CASE WHEN status = 'downloaded'           AND hidden = 0                    THEN 1 END) AS downloaded_count,
            COUNT(CASE WHEN status IN ('pending','failed')  AND hidden = 0 AND enclosure_url IS NOT NULL                    THEN 1 END) AS available_count,
            COUNT(CASE WHEN status IN ('pending','failed')  AND hidden = 0 AND enclosure_url IS NOT NULL AND played = 0
                            AND (play_position_seconds IS NULL OR play_position_seconds = 0)  THEN 1 END) AS unplayed_available_count,
            COUNT(CASE WHEN status = 'skipped'                                                THEN 1 END) AS skipped_count,
            COUNT(CASE WHEN hidden = 1                                                        THEN 1 END) AS hidden_count,
            COUNT(CASE WHEN status = 'downloaded'           AND hidden = 0 AND played = 0     THEN 1 END) AS unplayed_count,
            COUNT(CASE WHEN filename_outdated = 1 OR id3_tags_outdated = 1                    THEN 1 END) AS needs_rename_count,
            MAX  (CASE WHEN status = 'downloaded' THEN download_date END)                               AS last_download_at
        FROM episodes
        WHERE feed_id IN :ids
        GROUP BY feed_id
    """).bindparams(bindparam("ids", expanding=True))
    rows = db.execute(stmt, {"ids": feed_ids}).fetchall()
    return {
        row.feed_id: {
            "episode_count":            row.episode_count            or 0,
            "downloaded_count":         row.downloaded_count         or 0,
            "available_count":          row.available_count          or 0,
            "unplayed_available_count": row.unplayed_available_count or 0,
            "skipped_count":            row.skipped_count            or 0,
            "hidden_count":             row.hidden_count             or 0,
            "unplayed_count":           row.unplayed_count           or 0,
            "needs_rename":             (row.needs_rename_count or 0) > 0,
            "last_download_at":         row.last_download_at,
        }
        for row in rows
    }


def _merge_counts(primary_id: int, sub_ids: list[int], raw: dict[int, dict]) -> dict:
    """Aggregate per-feed-id counts across a primary feed and its supplementary feeds."""
    all_ids  = [primary_id] + sub_ids
    empty    = {"episode_count": 0, "downloaded_count": 0, "available_count": 0,
                "unplayed_available_count": 0, "skipped_count": 0, "hidden_count": 0,
                "unplayed_count": 0, "needs_rename": False, "last_download_at": None}
    rows     = [raw.get(i, empty) for i in all_ids]
    primary  = raw.get(primary_id, empty)

    dates    = [r["last_download_at"] for r in rows if r["last_download_at"]]
    return {
        "episode_count":            sum(r["episode_count"]            for r in rows),
        "downloaded_count":         sum(r["downloaded_count"]         for r in rows),
        "available_count":          sum(r["available_count"]          for r in rows),
        "unplayed_available_count": sum(r["unplayed_available_count"] for r in rows),
        "skipped_count":            primary["skipped_count"],   # primary feed only (by design)
        "hidden_count":             sum(r["hidden_count"]             for r in rows),
        "unplayed_count":           sum(r["unplayed_count"]           for r in rows),
        "needs_rename":             any(r["needs_rename"]             for r in rows),
        "last_download_at":         max(dates) if dates else None,
    }


def _feed_out(feed: Feed, db: Session, counts: dict | None = None) -> FeedOut:
    if counts is None:
        # Single-feed path: run individual queries (add_feed, get_feed, etc.)
        from sqlalchemy import or_
        sub_ids = [
            row[0]
            for row in db.query(Feed.id).filter(Feed.primary_feed_id == feed.id).all()
        ]
        raw = _bulk_episode_counts([feed.id] + sub_ids, db)
        counts = _merge_counts(feed.id, sub_ids, raw)

    data = FeedOut.model_validate(feed)
    data.episode_count            = counts["episode_count"]
    data.downloaded_count         = counts["downloaded_count"]
    data.available_count          = counts["available_count"]
    data.unplayed_available_count = counts["unplayed_available_count"]
    data.skipped_count            = counts["skipped_count"]
    data.hidden_count             = counts["hidden_count"]
    data.unplayed_count           = counts["unplayed_count"]
    data.needs_rename             = counts["needs_rename"]
    data.last_download_at         = counts["last_download_at"]

    # Prefer local cover.jpg over remote URL when no custom_image_url is set
    has_custom_cover = bool(feed.custom_image_url)
    try:
        from app.downloader import get_podcast_folder
        folder = get_podcast_folder(feed, db)
        data.podcast_folder = folder
        if not feed.custom_image_url and os.path.exists(os.path.join(folder, "cover.jpg")):
            data.image_url = f"/api/feeds/{feed.id}/cover.jpg"
            has_custom_cover = True
    except Exception:
        pass
    data.has_custom_cover = has_custom_cover

    return data


def _check_title_conflict(title: str, db: Session, exclude_id: int | None = None) -> Feed | None:
    """Return an existing primary feed whose sanitized folder name matches *title*, or None."""
    from app.downloader import _sanitize_filename
    target = _sanitize_filename(title).lower()
    if not target:
        return None
    feeds = db.query(Feed).filter(Feed.primary_feed_id.is_(None))
    if exclude_id is not None:
        feeds = feeds.filter(Feed.id != exclude_id)
    for f in feeds:
        existing = _sanitize_filename(f.podcast_group or f.title or "").lower()
        if existing and existing == target:
            return f
    return None


@router.get("", response_model=list[FeedOut])
def list_feeds(db: Session = Depends(get_db)):
    feeds = db.query(Feed).filter(Feed.primary_feed_id.is_(None)).order_by(Feed.title).all()
    if not feeds:
        return []

    primary_ids = [f.id for f in feeds]

    # Query 2: all supplementary feeds for every primary in one shot
    sub_rows = db.query(Feed.id, Feed.primary_feed_id).filter(
        Feed.primary_feed_id.in_(primary_ids)
    ).all()
    subs_by_primary: dict[int, list[int]] = {pid: [] for pid in primary_ids}
    for sub_id, pid in sub_rows:
        subs_by_primary[pid].append(sub_id)

    all_feed_ids = primary_ids + [sid for subs in subs_by_primary.values() for sid in subs]

    # Query 3: all episode counts for all feeds in one aggregation query
    raw_counts = _bulk_episode_counts(all_feed_ids, db)

    return [
        _feed_out(f, db, counts=_merge_counts(f.id, subs_by_primary.get(f.id, []), raw_counts))
        for f in feeds
    ]


@router.post("", response_model=FeedOut, status_code=201)
def add_feed(body: FeedCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    resolved_url = resolve_feed_url(body.url)

    existing = db.query(Feed).filter(Feed.url == resolved_url).first()
    if existing:
        raise HTTPException(status_code=409, detail="Feed with this URL already exists")

    feed = Feed(url=resolved_url, download_all_on_first_sync=body.download_all)
    db.add(feed)
    db.flush()  # get id before commit

    # Fetch metadata synchronously so we can return a useful response
    try:
        metadata = fetch_feed_metadata(resolved_url)
        feed.title = metadata.get("title")
        feed.description = metadata.get("description")
        feed.image_url = metadata.get("image_url")
        feed.website_url = metadata.get("website_url")
        feed.author = metadata.get("author")
        feed.language = metadata.get("language")
        feed.category = metadata.get("category")
    except Exception as e:
        feed.last_error = str(e)

    # Check for folder-name conflict.  title_override sets podcast_group so the
    # folder uses the user-supplied name rather than the RSS-supplied title.
    folder_name = body.title_override.strip() if body.title_override else feed.title
    if folder_name:
        conflict = _check_title_conflict(folder_name, db, exclude_id=feed.id)
        if conflict:
            db.rollback()
            raise HTTPException(
                status_code=409,
                detail={"message": "A podcast with this name already exists.", "conflict_title": folder_name},
            )
    if body.title_override:
        feed.podcast_group = body.title_override.strip()

    db.commit()
    db.refresh(feed)

    log.info("Feed added: %s (%s)", feed.title or feed.url, feed.url)
    from app.scheduler import schedule_feed
    schedule_feed(feed.id)
    # Sync episodes in background
    background_tasks.add_task(_bg_sync, feed.id)

    return _feed_out(feed, db)


@router.post("/manual")
def add_manual_feed(body: ManualFeedCreate, db: Session = Depends(get_db)):
    """Create a feed entry without an RSS URL (e.g. for defunct/offline podcasts)."""
    import uuid
    title = body.title.strip()
    conflict = _check_title_conflict(title, db)
    if conflict:
        raise HTTPException(
            status_code=409,
            detail={"message": "A podcast with this name already exists.", "conflict_title": title},
        )
    synthetic_url = f"manual:{uuid.uuid4().hex[:16]}"
    feed = Feed(url=synthetic_url, title=title, active=False,
                initial_sync_complete=True)
    db.add(feed)
    db.commit()
    db.refresh(feed)
    log.info("Manual feed created: %s", title)
    return _feed_out(feed, db)


@router.get("/opml")
def export_opml_early(db: Session = Depends(get_db)):
    """Export all primary feeds as an OPML file."""
    from fastapi.responses import Response
    from datetime import date
    feeds = db.query(Feed).filter(Feed.primary_feed_id.is_(None), Feed.active.is_(True)).order_by(Feed.title).all()
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<opml version="2.0">',
        '  <head>',
        f'    <title>CastCharm Export {date.today()}</title>',
        '  </head>',
        '  <body>',
    ]
    for f in feeds:
        title = (f.title or f.url).replace('"', "&quot;")
        url = f.url.replace('"', "&quot;")
        lines.append(f'    <outline type="rss" text="{title}" title="{title}" xmlUrl="{url}"/>')
    lines += ['  </body>', '</opml>']
    return Response(
        content="\n".join(lines),
        media_type="text/x-opml; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="castcharm-{date.today()}.opml"'},
    )


@router.get("/{feed_id}", response_model=FeedOut)
def get_feed(feed_id: int, db: Session = Depends(get_db)):
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    return _feed_out(feed, db)


@router.put("/{feed_id}", response_model=FeedOut)
def update_feed(feed_id: int, body: FeedUpdate, db: Session = Depends(get_db)):
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    updates = body.model_dump(exclude_unset=True)
    if "url" in updates and updates["url"]:
        updates["url"] = resolve_feed_url(updates["url"])
    for field, value in updates.items():
        setattr(feed, field, value)

    feed.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(feed)
    log.info("Feed updated: %s (id=%d) — fields: %s", feed.title or feed.url, feed_id, ", ".join(updates.keys()))

    # Reschedule if interval changed
    if body.check_interval is not None:
        from app.scheduler import reschedule_feed
        reschedule_feed(feed_id)

    # Recalculate seq numbers if start offset changed
    if body.episode_number_start is not None:
        from app.routers.episodes import recalc_seq_numbers
        primary_id = feed.primary_feed_id or feed.id
        recalc_seq_numbers(primary_id, db)
        db.commit()

    # Persist updated settings to castcharm.json so a container restart can restore them
    try:
        from app.downloader import get_podcast_folder
        from app.folder_meta import write_folder_metadata
        folder = get_podcast_folder(feed, db)
        write_folder_metadata(feed, folder)
    except Exception:
        pass

    return _feed_out(feed, db)


@router.delete("/{feed_id}", status_code=204)
def delete_feed(feed_id: int, delete_files: bool = False, force: bool = False, db: Session = Depends(get_db)):
    import os
    import shutil
    from sqlalchemy import text

    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    feed_label = feed.title or feed.url
    sub_feeds = db.query(Feed).filter(Feed.primary_feed_id == feed_id).all()
    all_ids = get_group_feed_ids(db, feed_id)

    # Resolve podcast folder before we touch the DB (needs the feed record)
    podcast_folder = None
    if delete_files:
        try:
            from app.downloader import get_podcast_folder
            podcast_folder = get_podcast_folder(feed, db)
        except Exception:
            pass

    if delete_files:
        for ep in db.query(Episode).filter(Episode.feed_id.in_(all_ids), Episode.file_path.isnot(None)).all():
            stem = os.path.splitext(ep.file_path)[0] if ep.file_path else None
            paths_to_remove = [ep.file_path]
            if stem:
                paths_to_remove += [stem + ext for ext in (".xml", ".jpg", ".png", ".webp")]
            for path in paths_to_remove:
                if path and os.path.exists(path):
                    try:
                        os.remove(path)
                    except OSError:
                        pass

        # Remove the entire podcast folder (user explicitly chose "delete all files")
        if podcast_folder and os.path.isdir(podcast_folder):
            shutil.rmtree(podcast_folder, ignore_errors=True)

    if force:
        try:
            db.rollback()
            for fid in all_ids:
                db.execute(text("DELETE FROM episodes WHERE feed_id = :id"), {"id": fid})
            # Null FK before deleting feed rows to avoid constraint violations
            db.execute(text("UPDATE feeds SET primary_feed_id = NULL WHERE primary_feed_id = :id"), {"id": feed_id})
            for fid in all_ids:
                db.execute(text("DELETE FROM feeds WHERE id = :id"), {"id": fid})
            db.commit()
        except Exception as exc:
            db.rollback()
            log.error("Force delete failed for feed %d: %s", feed_id, exc)
            raise HTTPException(status_code=500, detail="Delete failed")
    else:
        try:
            # Null FK first so sub feeds don't block deletion of the primary
            for sub in sub_feeds:
                sub.primary_feed_id = None
            db.flush()
            for sub in sub_feeds:
                db.delete(sub)
            db.delete(feed)
            db.commit()
        except Exception as exc:
            db.rollback()
            log.error("Delete failed for feed %d: %s", feed_id, exc)
            raise HTTPException(status_code=500, detail="Delete failed")

    log.info("Feed deleted: %s (id=%d, delete_files=%s)", feed_label, feed_id, delete_files)
    from app.scheduler import remove_feed_job
    for fid in all_ids:
        remove_feed_job(fid)


@router.post("/refresh-all", status_code=204)
def refresh_all_feeds(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Kick off a background sync for every active feed."""
    from app.activity import mark_sync_queued
    feed_ids = [
        row[0]
        for row in db.query(Feed.id).filter(Feed.active.is_(True), Feed.primary_feed_id.is_(None)).all()
    ]
    log.info("Sync all triggered: %d active feeds", len(feed_ids))
    for fid in feed_ids:
        mark_sync_queued(fid)
        background_tasks.add_task(_bg_sync, fid)


@router.post("/{feed_id}/refresh", response_model=FeedOut)
def refresh_feed(feed_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    log.info("Manual sync triggered: %s (id=%d)", feed.title or feed.url, feed_id)
    from app.activity import mark_sync_queued
    mark_sync_queued(feed_id)
    background_tasks.add_task(_bg_sync, feed_id)
    return _feed_out(feed, db)


@router.post("/{feed_id}/clear-error")
def clear_feed_error(feed_id: int, db: Session = Depends(get_db)):
    """Dismiss the last sync error for a feed without triggering a sync."""
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    feed.last_error = None
    db.commit()
    return _feed_out(feed, db)


@router.get("/{feed_id}/episodes", response_model=list[EpisodeOut])
def get_feed_episodes(
    feed_id: int,
    include_hidden: bool = False,
    limit: int = 200,
    offset: int = 0,
    order: str = "desc",
    db: Session = Depends(get_db),
):
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    # Include episodes from supplementary feeds linked to this one
    all_feed_ids = get_group_feed_ids(db, feed_id)
    sub_ids = all_feed_ids[1:]

    # Build a lookup so we can annotate each episode with its source feed info
    feed_map = {feed_id: feed}
    if sub_ids:
        for sf in db.query(Feed).filter(Feed.id.in_(sub_ids)).all():
            feed_map[sf.id] = sf

    q = (
        db.query(Episode)
        .filter(Episode.feed_id.in_(all_feed_ids), Episode.status != "skipped")
    )
    if not include_hidden:
        q = q.filter(Episode.hidden.is_(False))

    if order == "asc":
        q = q.order_by(Episode.published_at.asc().nullsfirst(), Episode.id.asc())
    else:
        q = q.order_by(Episode.published_at.desc().nullslast(), Episode.id.desc())
    episodes = q.offset(offset).limit(limit).all()
    result = []
    for ep in episodes:
        out = EpisodeOut.model_validate(ep)
        src = feed_map.get(ep.feed_id, feed)
        out.feed_title = src.title
        out.feed_image_url = src.image_url
        if ep.status == "downloaded" and ep.file_path and not os.path.exists(ep.file_path):
            out.file_missing = True
        result.append(out)
    return result


@router.get("/{feed_id}/rss-sources", response_model=list[RSSSourceInfo])
def get_feed_rss_sources(feed_id: int, db: Session = Depends(get_db)):
    from app.id3_tagger import build_episode_data, build_feed_data

    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    episode = (
        db.query(Episode)
        .filter(Episode.feed_id == feed_id)
        .order_by(Episode.published_at.desc().nullslast())
        .first()
    )

    feed_data = build_feed_data(feed)
    episode_data = build_episode_data(episode) if episode else {}

    result = []
    for field, human in _FIELD_LABELS.items():
        prefix, key = field.split(".", 1)
        val = feed_data.get(key) if prefix == "feed" else episode_data.get(key)
        if not val:
            continue
        snippet = str(val)[:50] + ("…" if len(str(val)) > 50 else "")
        result.append(RSSSourceInfo(field=field, label=f"{human}: {snippet}"))

    return result


@router.post("/{feed_id}/download-all")
def download_all_feed(feed_id: int, db: Session = Depends(get_db)):
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    all_ids = get_group_feed_ids(db, feed_id)

    episodes = (
        db.query(Episode)
        .filter(
            Episode.feed_id.in_(all_ids),
            Episode.status.in_(["pending", "failed"]),
            Episode.hidden.is_(False),
            Episode.enclosure_url.isnot(None),
        )
        .order_by(Episode.published_at.desc().nullslast(), Episode.id.desc())
        .all()
    )
    now = datetime.utcnow()
    for ep in episodes:
        ep.status = "queued"
        ep.queued_at = now
        ep.error_message = None
    db.commit()

    log.info("Download all queued for: %s (id=%d) — %d episodes", feed.title or feed.url, feed_id, len(episodes))
    for ep in episodes:
        enqueue_download(ep.id)

    return {"queued": len(episodes)}


@router.post("/{feed_id}/download-unplayed")
def download_unplayed_feed(feed_id: int, db: Session = Depends(get_db)):
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    all_ids = get_group_feed_ids(db, feed_id)

    episodes = (
        db.query(Episode)
        .filter(
            Episode.feed_id.in_(all_ids),
            Episode.status.in_(["pending", "failed"]),
            Episode.hidden.is_(False),
            Episode.played.is_(False),
            Episode.enclosure_url.isnot(None),
            (Episode.play_position_seconds == None) | (Episode.play_position_seconds == 0),
        )
        .order_by(Episode.published_at.desc().nullslast(), Episode.id.desc())
        .all()
    )
    now = datetime.utcnow()
    for ep in episodes:
        ep.status = "queued"
        ep.queued_at = now
        ep.error_message = None
    db.commit()

    log.info("Download unplayed queued for: %s (id=%d) — %d episodes", feed.title or feed.url, feed_id, len(episodes))
    for ep in episodes:
        enqueue_download(ep.id)

    return {"queued": len(episodes)}


@router.get("/{feed_id}/queue-count")
def feed_queue_count(feed_id: int, db: Session = Depends(get_db)):
    """Return count of queued+downloading episodes for the podcast group (primary + supplementary feeds)."""
    all_ids = get_group_feed_ids(db, feed_id)
    count = db.query(func.count(Episode.id)).filter(
        Episode.feed_id.in_(all_ids),
        Episode.status.in_(["queued", "downloading"]),
    ).scalar() or 0
    return {"count": int(count)}


@router.post("/{feed_id}/cancel-queued")
def cancel_feed_queued(feed_id: int, db: Session = Depends(get_db)):
    """Cancel all queued and downloading episodes for this podcast group, returning them to pending."""
    from app.downloader import request_cancel
    all_ids = get_group_feed_ids(db, feed_id)
    episodes = db.query(Episode).filter(
        Episode.feed_id.in_(all_ids),
        Episode.status.in_(["queued", "downloading"]),
    ).all()
    for ep in episodes:
        request_cancel(ep.id)
        ep.status = "pending"
        ep.error_message = None
        ep.download_progress = 0
    db.commit()
    return {"cancelled": len(episodes)}


@router.post("/{feed_id}/renumber")
def renumber_feed(feed_id: int, db: Session = Depends(get_db)):
    """Clear all manual seq_number locks and recalculate episode numbers from scratch."""
    from app.routers.episodes import recalc_seq_numbers
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    primary_id = feed.primary_feed_id or feed.id
    all_ids = get_group_feed_ids(db, primary_id)
    db.query(Episode).filter(
        Episode.feed_id.in_(all_ids),
        Episode.seq_number_locked.is_(True),
    ).update({"seq_number_locked": False}, synchronize_session=False)
    db.flush()
    recalc_seq_numbers(primary_id, db)
    db.commit()
    log.info("Episodes renumbered for feed id=%d", feed_id)
    return {"status": "ok"}


@router.post("/{feed_id}/mark-all-played")
def mark_all_played(feed_id: int, db: Session = Depends(get_db)):
    from datetime import datetime
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    all_ids = get_group_feed_ids(db, feed_id)
    episodes = (
        db.query(Episode)
        .filter(Episode.feed_id.in_(all_ids), Episode.played.is_(False))
        .all()
    )
    now = datetime.utcnow()
    for ep in episodes:
        ep.played = True
        ep.last_played_at = now
    db.commit()
    log.info("Marked all played for: %s (id=%d) — %d episodes", feed.title or feed.url, feed_id, len(episodes))
    return {"updated": len(episodes)}


@router.post("/{feed_id}/update-filenames")
@router.post("/{feed_id}/apply-file-updates")
def apply_file_updates(feed_id: int, db: Session = Depends(get_db)):
    """Rename files with outdated filenames and write pending custom ID3 tags."""
    from sqlalchemy import or_
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    all_ids = get_group_feed_ids(db, feed_id)

    pending = (
        db.query(Episode)
        .filter(
            Episode.feed_id.in_(all_ids),
            Episode.file_path.isnot(None),
            or_(Episode.filename_outdated.is_(True), Episode.id3_tags_outdated.is_(True)),
        )
        .all()
    )

    gs = db.query(GlobalSettings).first()
    renamed = 0
    tagged = 0
    errors = []

    for ep in pending:
        if not ep.file_path or not os.path.exists(ep.file_path):
            ep.filename_outdated = False
            ep.id3_tags_outdated = False
            continue

        # Rename file if needed
        if ep.filename_outdated:
            try:
                new_path = _compute_new_filepath(ep, feed, gs, db)
                if new_path and new_path != ep.file_path:
                    os.makedirs(os.path.dirname(new_path), exist_ok=True)
                    os.rename(ep.file_path, new_path)
                    # Rename XML and art sidecars if present
                    old_stem = os.path.splitext(ep.file_path)[0]
                    new_stem = os.path.splitext(new_path)[0]
                    for sidecar_ext in (".xml", ".jpg", ".png", ".webp"):
                        old_side = old_stem + sidecar_ext
                        new_side = new_stem + sidecar_ext
                        if os.path.exists(old_side):
                            os.rename(old_side, new_side)
                    ep.file_path = new_path
                    renamed += 1
            except Exception as exc:
                errors.append(f"Rename episode {ep.id}: {exc}")
            ep.filename_outdated = False

        # Write custom ID3 tags if needed
        if ep.id3_tags_outdated and ep.custom_id3_tags:
            file_to_tag = ep.file_path  # may have been updated by rename above
            if file_to_tag and os.path.exists(file_to_tag):
                try:
                    from app.id3_tagger import write_id3_tags_direct
                    write_id3_tags_direct(file_to_tag, ep.custom_id3_tags)
                    tagged += 1
                except Exception as exc:
                    errors.append(f"ID3 tag episode {ep.id}: {exc}")
            ep.id3_tags_outdated = False

    db.commit()
    log.info("File updates applied for feed id=%d: %d renamed, %d tagged%s", feed_id, renamed, tagged, f", {len(errors)} error(s)" if errors else "")
    return {"renamed": renamed, "tagged": tagged, "errors": errors}


def _compute_new_filepath(ep: Episode, primary_feed: Feed, gs: GlobalSettings, db: Session) -> str | None:
    """Compute what the filepath *should* be given current settings and seq_number."""
    import math
    from app.downloader import _sanitize_filename, _effective

    ep_feed = db.query(Feed).filter(Feed.id == ep.feed_id).first() or primary_feed
    base_dir = _effective(ep_feed.download_path, gs.download_path if gs else None, "/downloads")
    date_prefix = _effective(ep_feed.filename_date_prefix, gs.filename_date_prefix if gs else None, True)
    ep_num_prefix = _effective(ep_feed.filename_episode_number, gs.filename_episode_number if gs else None, True)
    organize_by_year = _effective(ep_feed.organize_by_year, gs.organize_by_year if gs else None, True)

    folder_name = _sanitize_filename(
        primary_feed.podcast_group or primary_feed.title or "Unknown Podcast"
    )
    episode_title = _sanitize_filename(ep.title or "Untitled Episode")

    parts = []
    if date_prefix and ep.published_at:
        parts.append(ep.published_at.strftime("%Y-%m-%d"))
    if ep_num_prefix and ep.seq_number is not None:
        grp_ids = get_group_feed_ids(db, primary_feed.id)
        total_eps = (
            db.query(func.count(Episode.id))
            .filter(Episode.feed_id.in_(grp_ids), Episode.hidden.is_(False))
            .scalar() or 1
        )
        pad = max(3, math.ceil(math.log10(total_eps + 1)))
        parts.append(str(ep.seq_number).zfill(pad))
    parts.append(episode_title)

    _, ext = os.path.splitext(ep.file_path)
    if not ext:
        ext = ".mp3"
    filename = " - ".join(parts) + ext

    dir_parts = [base_dir, folder_name]
    if organize_by_year and ep.published_at:
        dir_parts.append(str(ep.published_at.year))
    return os.path.join(*dir_parts, filename)


@router.post("/{feed_id}/import-files")
def import_files(
    feed_id: int,
    body: ImportFilesRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    from app.importer import import_directory, get_import_status, _import_jobs

    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    existing = get_import_status(feed_id)
    if existing and existing.get("status") == "running":
        raise HTTPException(status_code=409, detail="Import already running for this feed")

    directory = body.directory.strip()
    if not os.path.isdir(directory):
        raise HTTPException(status_code=400, detail="Directory not found")

    # Save settings as feed defaults before the background task reads them
    if body.save_as_defaults:
        if body.organize_by_year is not None:
            feed.organize_by_year = body.organize_by_year
        if body.date_prefix is not None:
            feed.filename_date_prefix = body.date_prefix
        if body.ep_num_prefix is not None:
            feed.filename_episode_number = body.ep_num_prefix
        db.commit()

    overrides = {}
    if body.organize_by_year is not None:
        overrides["organize_by_year"] = body.organize_by_year
    if body.date_prefix is not None:
        overrides["date_prefix"] = body.date_prefix
    if body.ep_num_prefix is not None:
        overrides["ep_num_prefix"] = body.ep_num_prefix

    _import_jobs[feed_id] = {"status": "running", "total": 0, "processed": 0,
                              "matched": 0, "created": 0, "renamed": 0, "errors": 0,
                              "message": "Starting…"}

    log.info("File import started for: %s (id=%d) from %s", feed.title or feed.url, feed_id, directory)

    from app.database import SessionLocal

    def _run():
        bg_db = SessionLocal()
        try:
            import_directory(feed_id, directory, body.rename_files, bg_db,
                             overrides=overrides or None)
        finally:
            bg_db.close()

    background_tasks.add_task(_run)
    return {"status": "started"}


@router.get("/{feed_id}/import-status")
def import_status(feed_id: int, db: Session = Depends(get_db)):
    from app.importer import get_import_status
    status = get_import_status(feed_id)
    if status is None:
        raise HTTPException(status_code=404, detail="No import job found for this feed")
    return status


@router.post("/{feed_id}/import-preview")
def import_preview(feed_id: int, body: ImportPreviewRequest, db: Session = Depends(get_db)):
    """Scan a directory and return per-file match results without writing anything to DB."""
    from app.importer import preview_import_directory

    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    directory = body.directory.strip()
    if not os.path.isdir(directory):
        raise HTTPException(status_code=400, detail="Directory not found on server")

    return preview_import_directory(feed_id, directory, db)


@router.post("/{feed_id}/import-stage")
def import_stage(
    feed_id: int,
    body: ImportStageRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Execute a staged import with explicit per-file episode assignments."""
    from app.importer import get_import_status, _import_jobs

    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    existing = get_import_status(feed_id)
    if existing and existing.get("status") == "running":
        raise HTTPException(status_code=409, detail="Import already running for this feed")

    items = [item.model_dump() for item in body.items]
    to_process_count = sum(1 for i in items if not i.get("skip", False))
    _import_jobs[feed_id] = {
        "status": "running", "total": to_process_count, "processed": 0,
        "matched": 0, "created": 0, "renamed": 0, "errors": 0, "message": "Starting…",
    }

    log.info("Staged import started for: %s (id=%d) — %d file(s)", feed.title or feed.url, feed_id, to_process_count)

    from app.database import SessionLocal

    def _run():
        bg_db = SessionLocal()
        try:
            from app.importer import import_staged
            import_staged(feed_id, items, bg_db)
        finally:
            bg_db.close()

    background_tasks.add_task(_run)
    return {"status": "started"}



@router.get("/{feed_id}/cover.jpg")
def get_feed_cover(feed_id: int, db: Session = Depends(get_db)):
    """Serve the local cover.jpg for a podcast folder."""
    from fastapi.responses import FileResponse
    from app.downloader import get_podcast_folder
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    try:
        folder = get_podcast_folder(feed, db)
        cover = os.path.join(folder, "cover.jpg")
        if os.path.exists(cover):
            return FileResponse(cover, media_type="image/jpeg")
    except Exception:
        pass
    raise HTTPException(status_code=404, detail="No local cover art found")


@router.post("/{feed_id}/upload-cover", response_model=FeedOut)
async def upload_feed_cover(
    feed_id: int,
    image: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload a local image file to use as the podcast cover art."""
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    try:
        from app.downloader import get_podcast_folder
        folder = get_podcast_folder(feed, db)
        os.makedirs(folder, exist_ok=True)
        cover_path = os.path.join(folder, "cover.jpg")
        contents = await image.read(10 * 1024 * 1024 + 1)
        if len(contents) > 10 * 1024 * 1024:
            log.warning("Cover upload rejected: file too large (%d bytes) for feed %d", len(contents), feed_id)
            raise HTTPException(status_code=413, detail="Image too large (max 10 MB)")
        import io
        from PIL import Image as _Img
        try:
            with _Img.open(io.BytesIO(contents)) as img:
                img.verify()
        except Exception:
            log.warning("Cover upload rejected: not a valid image for feed %d", feed_id)
            raise HTTPException(status_code=400, detail="File is not a valid image")
        with open(cover_path, "wb") as f:
            f.write(contents)
    except HTTPException:
        raise
    except Exception as exc:
        log.error("Failed to save cover for feed %d: %s", feed_id, exc)
        raise HTTPException(status_code=500, detail="Failed to save cover")
    feed.custom_image_url = None
    db.commit()
    db.refresh(feed)
    log.info("Cover art uploaded for: %s (id=%d)", feed.title or feed.url, feed_id)
    return _feed_out(feed, db)


@router.delete("/{feed_id}/cover", response_model=FeedOut)
def delete_feed_cover(feed_id: int, db: Session = Depends(get_db)):
    """Remove the custom cover art (local file and/or custom URL)."""
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    try:
        from app.downloader import get_podcast_folder
        folder = get_podcast_folder(feed, db)
        cover_path = os.path.join(folder, "cover.jpg")
        if os.path.exists(cover_path):
            os.remove(cover_path)
    except Exception:
        pass
    feed.custom_image_url = None
    db.commit()
    db.refresh(feed)
    log.info("Cover art removed for: %s (id=%d)", feed.title or feed.url, feed_id)
    return _feed_out(feed, db)


@router.get("/{feed_id}/clean-rss")
def download_clean_rss(feed_id: int, db: Session = Depends(get_db)):
    """Return a clean RSS/XML file as a browser download."""
    from fastapi.responses import Response
    from datetime import date
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    try:
        from app.rss_generator import build_clean_feed_xml, _sanitize_filename
        xml_content = build_clean_feed_xml(feed_id, db)
        today = date.today().strftime("%Y-%m-%d")
        safe_title = _sanitize_filename(feed.title or f"feed_{feed_id}")
        filename = f"{today} - {safe_title}.xml"
        return Response(
            content=xml_content,
            media_type="application/rss+xml; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


def _bg_sync(feed_id: int):
    from app.database import SessionLocal
    from app.routers.episodes import recalc_seq_numbers
    from app.activity import mark_syncing, mark_sync_done
    mark_syncing(feed_id)
    db = SessionLocal()
    try:
        feed = db.query(Feed).filter(Feed.id == feed_id).first()
        if not feed:
            return
        was_initial = not feed.initial_sync_complete
        log.info("Syncing: %s (id=%d)", feed.title or feed.url, feed_id)
        try:
            sync_feed_episodes(feed, db)
            feed.last_error = None
        except Exception as e:
            feed.last_error = str(e)
            log.error("Sync failed for %s (id=%d): %s", feed.title or feed.url, feed_id, e)

        # If user requested "download all" on first sync, queue every episode now
        if was_initial and feed.download_all_on_first_sync:
            try:
                primary_id_dl = feed.primary_feed_id or feed.id
                all_ids_dl = get_group_feed_ids(db, primary_id_dl)
                eps_to_queue = (
                    db.query(Episode)
                    .filter(
                        Episode.feed_id.in_(all_ids_dl),
                        Episode.status.in_(["pending", "failed"]),
                        Episode.hidden.is_(False),
                    )
                    .all()
                )
                now = datetime.utcnow()
                for ep in eps_to_queue:
                    ep.status = "queued"
                    ep.queued_at = now
                    ep.error_message = None
                db.commit()
                from app.downloader import enqueue_download
                for ep in eps_to_queue:
                    enqueue_download(ep.id)
            except Exception as e:
                log.warning("download_all_on_first_sync failed: %s", e)

        # Recalculate sequential episode numbers after every sync
        primary_id = feed.primary_feed_id or feed.id
        recalc_seq_numbers(primary_id, db)
        # Mark initial sync done so the scheduler knows future episodes are "new"
        feed.initial_sync_complete = True
        feed.last_checked = datetime.utcnow()
        db.commit()
        # Auto-write complete-feed.xml and castcharm.json into the podcast folder
        try:
            from app.rss_generator import write_feed_xml
            from app.downloader import get_podcast_folder
            from app.folder_meta import write_folder_metadata
            primary = db.query(Feed).filter(Feed.id == primary_id).first()
            if primary:
                folder = get_podcast_folder(primary, db)
                write_feed_xml(primary_id, db, folder)
                write_folder_metadata(primary, folder)
        except Exception:
            pass  # best-effort
        log.info("Sync complete: %s (id=%d)", feed.title or feed.url, feed_id)
    finally:
        mark_sync_done(feed_id)
        db.close()


# ---------------------------------------------------------------------------
# Supplementary feeds
# ---------------------------------------------------------------------------

@router.get("/{feed_id}/supplementary", response_model=list[FeedOut])
def list_supplementary(feed_id: int, db: Session = Depends(get_db)):
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    subs = db.query(Feed).filter(Feed.primary_feed_id == feed_id).all()
    return [_feed_out(f, db) for f in subs]


@router.post("/{feed_id}/supplementary", response_model=FeedOut, status_code=201)
def add_supplementary(feed_id: int, body: FeedCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    primary = db.query(Feed).filter(Feed.id == feed_id).first()
    if not primary:
        raise HTTPException(status_code=404, detail="Feed not found")

    # Normalise local file paths to file:// URIs so feedparser can handle them
    url = body.url
    if url.startswith("/") or (len(url) > 2 and url[1] == ":" and url[2] in ("/", "\\")):
        url = "file://" + url
    else:
        url = resolve_feed_url(url)
    body = type(body)(url=url)

    if body.url == primary.url:
        raise HTTPException(status_code=400, detail="Cannot link a feed to itself")

    # Reuse existing feed record if URL already tracked, otherwise create new
    sub = db.query(Feed).filter(Feed.url == body.url).first()
    if sub:
        if sub.primary_feed_id and sub.primary_feed_id != feed_id:
            raise HTTPException(status_code=409, detail="Feed is already supplementary to another feed")
        sub.primary_feed_id = feed_id
        db.commit()
        db.refresh(sub)
        return _feed_out(sub, db)

    sub = Feed(url=body.url, primary_feed_id=feed_id)
    db.add(sub)
    db.flush()

    try:
        metadata = fetch_feed_metadata(body.url)
        sub.title = metadata.get("title")
        sub.description = metadata.get("description")
        sub.image_url = metadata.get("image_url")
        sub.website_url = metadata.get("website_url")
        sub.author = metadata.get("author")
        sub.language = metadata.get("language")
        sub.category = metadata.get("category")
    except Exception as e:
        sub.last_error = str(e)

    db.commit()
    db.refresh(sub)
    log.info("Supplementary feed linked to %s (id=%d): %s", primary.title or primary.url, feed_id, body.url)
    from app.scheduler import schedule_feed
    schedule_feed(sub.id)
    background_tasks.add_task(_bg_sync, sub.id)
    return _feed_out(sub, db)


@router.post("/{feed_id}/import-feed-xml")
async def import_feed_xml(
    feed_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload an RSS/XML archive file to backfill missing episodes for an existing feed.

    Only episode records are added/updated — no metadata overwrites happen to the feed itself.
    """
    import tempfile
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    content = await file.read()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".xml", delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        added, skipped = sync_feed_episodes(feed, db, parse_url=tmp_path, xml_import=True)
        db.commit()
        count = len(added) if added else 0

        # Recalculate seq numbers and check if any downloaded files need renaming
        from app.routers.episodes import recalc_seq_numbers
        primary_id = feed.primary_feed_id or feed.id
        recalc_seq_numbers(primary_id, db)
        db.commit()

        files_to_rename = db.query(Episode).filter(
            Episode.feed_id == primary_id,
            Episode.filename_outdated == True,
            Episode.file_path != None,
        ).count()

        log.info("Feed XML uploaded for %s (id=%d): %d episode(s) added, %d duplicate(s) excluded, %d file(s) need renaming", feed.title or feed.url, feed_id, count, skipped, files_to_rename)
        return {"added": count, "skipped": skipped, "files_to_rename": files_to_rename}
    except Exception as exc:
        db.rollback()
        log.warning("Failed to parse feed XML for feed %d: %s", feed_id, exc)
        raise HTTPException(status_code=400, detail="Failed to parse feed XML")
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


@router.post("/{feed_id}/preview-feed-xml")
async def preview_feed_xml(
    feed_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Parse an XML file and return collision info without committing anything.

    The file is saved to a temp path and a temp_id is returned so the client
    can follow up with commit-feed-xml once the user resolves each collision.
    """
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    tmp = tempfile.NamedTemporaryFile(suffix=".xml", delete=False)
    try:
        tmp.write(content)
        tmp.close()
        result = preview_xml_collisions(feed, db, tmp.name)
    except Exception as exc:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass
        log.warning("Failed to preview feed XML for feed %d: %s", feed_id, exc)
        raise HTTPException(status_code=400, detail=f"Failed to parse feed XML: {exc}")

    temp_id = str(_uuid.uuid4())
    _pending_xml_imports[temp_id] = tmp.name
    return {"temp_id": temp_id, **result}


@router.post("/{feed_id}/commit-feed-xml")
async def commit_feed_xml(
    feed_id: int,
    body: _CommitXmlBody,
    db: Session = Depends(get_db),
):
    """Apply a collision-reviewed XML import.

    resolutions maps each collision key (incoming GUID) to one of:
      "keep_existing" — skip the incoming episode
      "use_imported"  — update the existing episode in-place with the imported data
      "keep_both"     — add both; tag the newer one with [dupe]
    """
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    tmp_path = _pending_xml_imports.pop(body.temp_id, None)
    if not tmp_path or not os.path.exists(tmp_path):
        raise HTTPException(status_code=400, detail="Import session expired or not found")

    try:
        added, skipped = sync_feed_episodes(
            feed, db, parse_url=tmp_path, xml_import=True, resolutions=body.resolutions
        )
        db.commit()
        count = len(added) if added else 0

        from app.routers.episodes import recalc_seq_numbers
        primary_id = feed.primary_feed_id or feed.id
        recalc_seq_numbers(primary_id, db)
        db.commit()

        files_to_rename = db.query(Episode).filter(
            Episode.feed_id == primary_id,
            Episode.filename_outdated == True,
            Episode.file_path != None,
        ).count()

        log.info(
            "Feed XML committed for %s (id=%d): %d added, %d skipped, %d file(s) need renaming",
            feed.title or feed.url, feed_id, count, skipped, files_to_rename,
        )
        return {"added": count, "skipped": skipped, "files_to_rename": files_to_rename}
    except Exception as exc:
        db.rollback()
        log.warning("Failed to commit feed XML for feed %d: %s", feed_id, exc)
        raise HTTPException(status_code=400, detail="Failed to import feed XML")
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


@router.get("/{feed_id}/cleanup-preview")
def cleanup_preview(feed_id: int, db: Session = Depends(get_db)):
    """Return how many files would be deleted by cleanup without deleting them."""
    from app.cleanup import preview_keep_latest_cleanup
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    return preview_keep_latest_cleanup(feed_id, db)


@router.post("/{feed_id}/autoclean/run")
def run_feed_autoclean(feed_id: int, db: Session = Depends(get_db)):
    """Immediately run auto-cleanup for a specific feed."""
    from app.cleanup import run_keep_latest_cleanup
    from app.activity import mark_autoclean_start, mark_autoclean_done
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    mark_autoclean_start()
    try:
        deleted = run_keep_latest_cleanup(feed_id, db)
    finally:
        mark_autoclean_done()
    return {"deleted": len(deleted)}


@router.post("/from-xml", response_model=FeedOut, status_code=201)
async def create_feed_from_xml(
    file: UploadFile = File(...),
    title_override: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    """Create a new podcast feed by uploading a local RSS/XML file.

    Parses feed-level metadata and all episodes from the file.  A synthetic
    ``local:<uuid>`` URL is assigned so the feed never tries to sync from a
    network address.
    """
    import tempfile
    import uuid as _uuid
    import feedparser

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".xml", delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        # Parse feed-level metadata
        parsed = feedparser.parse(tmp_path)
        if parsed.get("bozo") and not parsed.entries:
            exc = parsed.get("bozo_exception")
            raise HTTPException(status_code=400, detail=f"Invalid RSS/XML file: {exc}")

        fi = parsed.feed
        feed_title = (title_override.strip() if title_override else None) or getattr(fi, "title", None) or "Imported Podcast"
        description = getattr(fi, "description", None) or getattr(fi, "subtitle", None)
        author = (getattr(fi, "author", None) or getattr(fi, "itunes_author", None) or "").strip() or None
        website_url = getattr(fi, "link", None)
        language = getattr(fi, "language", None)

        # Image URL (handles RSS <image>, Atom <logo>, iTunes <itunes:image>)
        image_url = None
        img = getattr(fi, "image", None)
        if img:
            image_url = getattr(img, "href", None) or getattr(img, "url", None)
        if not image_url:
            itunes_img = getattr(fi, "itunes_image", None)
            if itunes_img:
                image_url = (getattr(itunes_img, "href", None)
                             or (itunes_img if isinstance(itunes_img, str) else None))

        # Check for folder-name conflict before committing anything
        conflict = _check_title_conflict(feed_title, db)
        if conflict:
            raise HTTPException(
                status_code=409,
                detail={"message": "A podcast with this name already exists.", "conflict_title": feed_title},
            )

        # Unique local URL — retry on collision (astronomically unlikely)
        local_url = f"local:{_uuid.uuid4().hex[:16]}"
        while db.query(Feed).filter(Feed.url == local_url).first():
            local_url = f"local:{_uuid.uuid4().hex[:16]}"

        feed = Feed(
            url=local_url,
            title=feed_title,
            description=description,
            image_url=image_url,
            website_url=website_url,
            author=author,
            language=language,
        )
        db.add(feed)
        db.flush()

        # Parse and insert all episodes from the XML
        added, skipped = sync_feed_episodes(feed, db, parse_url=tmp_path)
        feed.initial_sync_complete = True
        db.commit()

        from app.routers.episodes import recalc_seq_numbers
        recalc_seq_numbers(feed.id, db)
        db.commit()
        db.refresh(feed)

        log.info(
            "Feed created from XML: '%s' (id=%d) — %d episode(s) added, %d skipped",
            feed.title, feed.id, len(added or []), skipped,
        )
        return _feed_out(feed, db)

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        log.error("create_feed_from_xml failed: %s", e)
        raise HTTPException(status_code=400, detail=f"Failed to parse RSS/XML: {e}")
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


@router.post("/opml", status_code=200)
async def import_opml(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Import feeds from an OPML file. Returns counts of added/skipped/failed feeds."""
    import xml.etree.ElementTree as ET
    content = await file.read()
    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        log.warning("Invalid OPML/XML upload: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid OPML/XML file")

    outlines = root.findall(".//{*}outline") + root.findall(".//outline")
    added = skipped = failed = 0
    for outline in outlines:
        xml_url = outline.get("xmlUrl") or outline.get("xmlurl")
        if not xml_url:
            continue
        xml_url = xml_url.strip()
        if not xml_url:
            continue
        existing = db.query(Feed).filter(Feed.url == xml_url).first()
        if existing:
            skipped += 1
            continue
        try:
            resolved = resolve_feed_url(xml_url)
            # Check again with resolved URL
            if db.query(Feed).filter(Feed.url == resolved).first():
                skipped += 1
                continue
            feed = Feed(url=resolved)
            db.add(feed)
            db.flush()
            try:
                metadata = fetch_feed_metadata(resolved)
                feed.title = metadata.get("title")
                feed.description = metadata.get("description")
                feed.image_url = metadata.get("image_url")
                feed.website_url = metadata.get("website_url")
                feed.author = metadata.get("author")
                feed.language = metadata.get("language")
                feed.category = metadata.get("category")
            except Exception as e:
                feed.last_error = str(e)
            db.commit()
            db.refresh(feed)
            from app.scheduler import schedule_feed
            from app.activity import mark_sync_queued
            schedule_feed(feed.id)
            mark_sync_queued(feed.id)
            background_tasks.add_task(_bg_sync, feed.id)
            added += 1
        except Exception:
            db.rollback()
            failed += 1
    log.info("OPML import complete: %d added, %d skipped, %d failed", added, skipped, failed)
    return {"added": added, "skipped": skipped, "failed": failed}


@router.delete("/{feed_id}/supplementary/{sub_id}", status_code=204)
def remove_supplementary(feed_id: int, sub_id: int, db: Session = Depends(get_db)):
    sub = db.query(Feed).filter(Feed.id == sub_id, Feed.primary_feed_id == feed_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Supplementary feed not found")
    sub.primary_feed_id = None  # unlink; keep the feed and its episodes
    db.commit()
    log.info("Supplementary feed unlinked: id=%d from primary id=%d", sub_id, feed_id)
