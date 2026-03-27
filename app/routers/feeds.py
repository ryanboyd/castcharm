import logging
import os
from datetime import datetime

log = logging.getLogger(__name__)
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, UploadFile, File
from app.downloader import enqueue_download
from sqlalchemy import func, text, bindparam
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Feed, Episode, GlobalSettings
from app.schemas import FeedCreate, FeedUpdate, FeedOut, EpisodeOut, RSSSourceInfo, ImportFilesRequest, ManualFeedCreate
from app.rss_parser import fetch_feed_metadata, sync_feed_episodes, resolve_feed_url

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
            COUNT(CASE WHEN status IN ('pending','failed')  AND hidden = 0                    THEN 1 END) AS available_count,
            COUNT(CASE WHEN status IN ('pending','failed')  AND hidden = 0 AND played = 0
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

    db.commit()
    db.refresh(feed)

    log.info("Feed added: %s (%s)", feed.title or feed.url, feed.url)
    # Sync episodes in background
    background_tasks.add_task(_bg_sync, feed.id)

    return _feed_out(feed, db)


@router.post("/manual")
def add_manual_feed(body: ManualFeedCreate, db: Session = Depends(get_db)):
    """Create a feed entry without an RSS URL (e.g. for defunct/offline podcasts)."""
    import uuid
    title = body.title.strip()
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
    sub_ids = [s.id for s in sub_feeds]
    all_ids = [feed_id] + sub_ids

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
    feed_ids = [
        row[0]
        for row in db.query(Feed.id).filter(Feed.active.is_(True), Feed.primary_feed_id.is_(None)).all()
    ]
    log.info("Sync all triggered: %d active feeds", len(feed_ids))
    for fid in feed_ids:
        background_tasks.add_task(_bg_sync, fid)


@router.post("/{feed_id}/refresh", response_model=FeedOut)
def refresh_feed(feed_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    log.info("Manual sync triggered: %s (id=%d)", feed.title or feed.url, feed_id)
    background_tasks.add_task(_bg_sync, feed_id)
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
    sub_ids = [
        row[0]
        for row in db.query(Feed.id).filter(Feed.primary_feed_id == feed_id).all()
    ]
    all_feed_ids = [feed_id] + sub_ids

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

    sub_ids = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == feed_id).all()]
    all_ids = [feed_id] + sub_ids

    episodes = (
        db.query(Episode)
        .filter(
            Episode.feed_id.in_(all_ids),
            Episode.status.in_(["pending", "failed"]),
            Episode.hidden.is_(False),
        )
        .order_by(Episode.published_at.desc().nullslast(), Episode.id.desc())
        .all()
    )
    for ep in episodes:
        ep.status = "queued"
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

    sub_ids = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == feed_id).all()]
    all_ids = [feed_id] + sub_ids

    episodes = (
        db.query(Episode)
        .filter(
            Episode.feed_id.in_(all_ids),
            Episode.status.in_(["pending", "failed"]),
            Episode.hidden.is_(False),
            Episode.played.is_(False),
            (Episode.play_position_seconds == None) | (Episode.play_position_seconds == 0),
        )
        .order_by(Episode.published_at.desc().nullslast(), Episode.id.desc())
        .all()
    )
    for ep in episodes:
        ep.status = "queued"
        ep.error_message = None
    db.commit()

    log.info("Download unplayed queued for: %s (id=%d) — %d episodes", feed.title or feed.url, feed_id, len(episodes))
    for ep in episodes:
        enqueue_download(ep.id)

    return {"queued": len(episodes)}


@router.post("/{feed_id}/renumber")
def renumber_feed(feed_id: int, db: Session = Depends(get_db)):
    """Clear all manual seq_number locks and recalculate episode numbers from scratch."""
    from app.routers.episodes import recalc_seq_numbers
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    primary_id = feed.primary_feed_id or feed.id
    sub_ids = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == primary_id).all()]
    all_ids = [primary_id] + sub_ids
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
    sub_ids = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == feed_id).all()]
    all_ids = [feed_id] + sub_ids
    episodes = (
        db.query(Episode)
        .filter(Episode.feed_id.in_(all_ids), Episode.status == "downloaded", Episode.played.is_(False))
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

    sub_ids = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == feed_id).all()]
    all_ids = [feed_id] + sub_ids

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
        sub_ids = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == primary_feed.id).all()]
        total_eps = (
            db.query(func.count(Episode.id))
            .filter(Episode.feed_id.in_([primary_feed.id] + sub_ids), Episode.hidden.is_(False))
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


@router.post("/{feed_id}/rescan")
def rescan_feed(feed_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Re-scan the feed's own podcast folder for newly added audio files."""
    from app.importer import import_directory, get_import_status, _import_jobs

    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    existing = get_import_status(feed_id)
    if existing and existing.get("status") == "running":
        raise HTTPException(status_code=409, detail="Import already running for this feed")

    from app.downloader import get_podcast_folder
    folder = get_podcast_folder(feed, db)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=400, detail="Podcast folder not found")

    _import_jobs[feed_id] = {"status": "running", "total": 0, "processed": 0,
                              "matched": 0, "created": 0, "renamed": 0, "errors": 0,
                              "message": "Scanning…"}

    log.info("Folder rescan started for: %s (id=%d) — %s", feed.title or feed.url, feed_id, folder)

    from app.database import SessionLocal

    def _run():
        bg_db = SessionLocal()
        try:
            import_directory(feed_id, folder, rename_files=False, db=bg_db)
        finally:
            bg_db.close()

    background_tasks.add_task(_run)
    return {"status": "started", "folder": folder}


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

        # On the initial sync, import any audio files already present in the folder.
        # This handles the case where the user already has files downloaded before
        # adding the feed.  We use the full importer (not just scan_existing_files)
        # so that files without a matching RSS episode still get registered.
        # rename_files=False: files are already in the expected location.
        if was_initial:
            try:
                from app.downloader import get_podcast_folder
                primary_id = feed.primary_feed_id or feed.id
                primary = db.query(Feed).filter(Feed.id == primary_id).first()
                if primary:
                    folder = get_podcast_folder(primary, db)
                    if os.path.isdir(folder):
                        from app.importer import import_directory, AUDIO_EXTENSIONS
                        has_audio = any(
                            os.path.splitext(f)[1].lower() in AUDIO_EXTENSIONS
                            for _r, _d, files in os.walk(folder)
                            for f in files
                        )
                        if has_audio:
                            import_directory(primary_id, folder, rename_files=False, db=db)
            except Exception as e:
                log.warning("Auto-import on initial sync failed: %s", e)

        # If user requested "download all" on first sync, queue every episode now
        if was_initial and feed.download_all_on_first_sync:
            try:
                primary_id_dl = feed.primary_feed_id or feed.id
                sub_ids_dl = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == primary_id_dl).all()]
                all_ids_dl = [primary_id_dl] + sub_ids_dl
                eps_to_queue = (
                    db.query(Episode)
                    .filter(
                        Episode.feed_id.in_(all_ids_dl),
                        Episode.status.in_(["pending", "failed"]),
                        Episode.hidden.is_(False),
                    )
                    .all()
                )
                for ep in eps_to_queue:
                    ep.status = "queued"
                    ep.error_message = None
                db.commit()
                for ep in eps_to_queue:
                    from app.downloader import download_episode
                    import threading
                    threading.Thread(target=download_episode, args=(ep.id,), daemon=True).start()
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
        # Auto-cleanup: delete oldest files beyond keep_latest limit
        try:
            from app.cleanup import run_keep_latest_cleanup
            run_keep_latest_cleanup(primary_id, db)
        except Exception:
            pass  # cleanup is best-effort
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
        added, skipped = sync_feed_episodes(feed, db, parse_url=tmp_path)
        db.commit()
        count = len(added) if added else 0

        # Recalculate seq numbers and check if any downloaded files need renaming
        from app.routers.episodes import recalc_seq_numbers
        primary_id = feed.parent_feed_id or feed.id
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


@router.get("/{feed_id}/cleanup-preview")
def cleanup_preview(feed_id: int, db: Session = Depends(get_db)):
    """Return how many files would be deleted by keep_latest cleanup without deleting them."""
    from app.cleanup import preview_keep_latest_cleanup
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    return preview_keep_latest_cleanup(feed_id, db)


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
