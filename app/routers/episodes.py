import logging
import os
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from app.downloader import enqueue_download
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models import Episode, Feed
from app.utils import get_group_feed_ids
from app.schemas import EpisodeOut

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/episodes", tags=["episodes"])


def recalc_seq_numbers(primary_feed_id: int, db: Session) -> None:
    """Reassign sequential episode numbers across all non-hidden episodes in a podcast group.

    Oldest episode = episode_number_start, then +1 for each successive episode.
    Locked episodes keep their manually-set seq_number and are skipped.
    Any episode whose seq_number changes while it has a downloaded file is
    flagged with filename_outdated = True.
    """
    primary = db.query(Feed).filter(Feed.id == primary_feed_id).first()
    start = (primary.episode_number_start or 1) if primary else 1

    all_feed_ids = get_group_feed_ids(db, primary_feed_id)

    # Fetch all non-hidden episodes ordered oldest-first
    visible = (
        db.query(Episode)
        .filter(Episode.feed_id.in_(all_feed_ids), Episode.hidden.is_(False))
        .order_by(Episode.published_at.asc().nullslast(), Episode.id.asc())
        .all()
    )

    # Only use episode_number for gap preservation when it forms a globally
    # monotonically non-decreasing sequence.  If numbers reset (e.g. a podcast
    # restarts at ep 1 for a new season), treat episode_number as unreliable for
    # seq purposes and fall back to purely positional numbering.
    ep_nums_in_order = [ep.episode_number for ep in visible if ep.episode_number is not None]
    use_ep_num_for_gaps = bool(ep_nums_in_order) and ep_nums_in_order == sorted(ep_nums_in_order)

    counter = start
    for ep in visible:
        if ep.seq_number_locked:
            # Manual override: do not touch seq_number, but advance counter past it
            counter = max(counter, (ep.seq_number or 0) + 1)
            continue
        if use_ep_num_for_gaps and ep.episode_number is not None:
            # Honour the episode's own number and preserve any gap before it.
            new_num = max(counter, ep.episode_number)
        else:
            new_num = counter
        counter = new_num + 1
        if ep.seq_number != new_num:
            ep.seq_number = new_num
            if ep.file_path and os.path.exists(ep.file_path):
                ep.filename_outdated = True

    # Clear seq_number for hidden (non-locked) episodes
    hidden = (
        db.query(Episode)
        .filter(
            Episode.feed_id.in_(all_feed_ids),
            Episode.hidden.is_(True),
            Episode.seq_number_locked.is_(False),
        )
        .all()
    )
    for ep in hidden:
        ep.seq_number = None

    db.flush()


def _ep_out(ep: Episode) -> EpisodeOut:
    out = EpisodeOut.model_validate(ep)
    if ep.feed:
        out.feed_title = ep.feed.title
        out.feed_image_url = ep.feed.image_url
    # Prefer local art sidecar over remote URL when no custom_image_url is set
    if not ep.custom_image_url and ep.file_path:
        art_path = os.path.splitext(ep.file_path)[0] + ".jpg"
        if os.path.exists(art_path):
            out.episode_image_url = f"/api/episodes/{ep.id}/cover.jpg"
    # Flag downloaded episodes whose file has gone missing from disk
    if ep.status == "downloaded" and ep.file_path and not os.path.exists(ep.file_path):
        out.file_missing = True
    return out


@router.get("/{episode_id}/file")
def serve_episode_file(episode_id: int, db: Session = Depends(get_db)):
    """Stream the downloaded audio file as a browser attachment download."""
    from fastapi.responses import FileResponse
    ep = db.query(Episode).filter(Episode.id == episode_id).first()
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    if not ep.file_path or not os.path.exists(ep.file_path):
        raise HTTPException(status_code=404, detail="File not found on disk")
    filename = os.path.basename(ep.file_path)
    return FileResponse(
        path=ep.file_path,
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{episode_id}/stream")
def stream_episode(episode_id: int, db: Session = Depends(get_db)):
    """Stream the audio file inline (supports HTTP range requests for seeking)."""
    from fastapi.responses import FileResponse
    ep = db.query(Episode).filter(Episode.id == episode_id).first()
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    if not ep.file_path or not os.path.exists(ep.file_path):
        raise HTTPException(status_code=404, detail="File not found on disk")
    mime = ep.enclosure_type or "audio/mpeg"
    return FileResponse(
        path=ep.file_path,
        media_type=mime,
        headers={"Content-Disposition": "inline"},
    )


@router.get("/{episode_id}/cover.jpg")
def get_episode_cover(episode_id: int, db: Session = Depends(get_db)):
    """Serve the local art sidecar for an episode."""
    from fastapi.responses import FileResponse
    ep = db.query(Episode).filter(Episode.id == episode_id).first()
    if not ep or not ep.file_path:
        raise HTTPException(status_code=404, detail="No local art found")
    art_path = os.path.splitext(ep.file_path)[0] + ".jpg"
    if os.path.exists(art_path):
        return FileResponse(art_path, media_type="image/jpeg")
    raise HTTPException(status_code=404, detail="No local art found")


@router.get("", response_model=list[EpisodeOut])
def list_episodes(
    status: str | None = None,
    feed_id: int | None = None,
    include_hidden: bool = False,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
    download_since: Optional[datetime] = None,
    sort: str | None = None,
    db: Session = Depends(get_db),
):
    q = db.query(Episode).options(joinedload(Episode.feed))
    if status:
        q = q.filter(Episode.status == status)
    if feed_id:
        q = q.filter(Episode.feed_id == feed_id)
    if not include_hidden:
        q = q.filter(Episode.hidden.is_(False))
    if search:
        pat = f"%{search}%"
        q = q.filter(or_(Episode.title.ilike(pat), Episode.description.ilike(pat)))
    if download_since is not None:
        q = q.filter(Episode.download_date >= download_since)
    if sort == "download_date":
        episodes = q.order_by(Episode.download_date.desc().nullslast(), Episode.id.desc()).offset(offset).limit(limit).all()
    elif status in ("queued", "downloading"):
        episodes = q.order_by(Episode.queued_at.asc().nullslast(), Episode.id.asc()).offset(offset).limit(limit).all()
    else:
        episodes = q.order_by(Episode.published_at.desc()).offset(offset).limit(limit).all()
    return [_ep_out(ep) for ep in episodes]


@router.post("/cancel-queued")
def cancel_queued(db: Session = Depends(get_db)):
    episodes = db.query(Episode).filter(Episode.status == "queued").all()
    for ep in episodes:
        ep.status = "pending"
    db.commit()
    log.info("Cancelled %d queued download(s)", len(episodes))
    return {"cancelled": len(episodes)}


@router.post("/cancel-all")
def cancel_all(db: Session = Depends(get_db)):
    """Cancel all queued and actively downloading episodes."""
    from app.downloader import request_cancel
    downloading = db.query(Episode).filter(Episode.status == "downloading").all()
    for ep in downloading:
        request_cancel(ep.id)
        ep.status = "pending"
    queued = db.query(Episode).filter(Episode.status == "queued").all()
    for ep in queued:
        request_cancel(ep.id)  # stop any already-spawned background task from starting
        ep.status = "pending"
    db.commit()
    total = len(downloading) + len(queued)
    log.info("Cancelled all: %d downloading, %d queued", len(downloading), len(queued))
    return {"cancelled": total}


@router.post("/download-all")
def queue_all_downloads(db: Session = Depends(get_db)):
    episodes = (
        db.query(Episode)
        .filter(
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

    log.info("Download all: queued %d episodes", len(episodes))
    for ep in episodes:
        enqueue_download(ep.id)

    return {"queued": len(episodes)}


@router.post("/download-unplayed")
def queue_unplayed_downloads(db: Session = Depends(get_db)):
    episodes = (
        db.query(Episode)
        .filter(
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

    log.info("Download unplayed: queued %d episodes", len(episodes))
    for ep in episodes:
        enqueue_download(ep.id)

    return {"queued": len(episodes)}


@router.get("/active-progress")
def get_active_progress():
    """Return in-memory download progress for all active downloads.

    Returns a dict of {episode_id_str: progress_int} so it can be serialised
    as JSON (JSON keys must be strings).  Values are 0-100 integers.
    """
    from app.downloader import get_active_progress as _get_progress
    return {str(k): v for k, v in _get_progress().items()}


class SuggestionsOut(BaseModel):
    short: list[EpisodeOut] = []       # <= 15 min
    medium: list[EpisodeOut] = []      # 15–30 min
    long: list[EpisodeOut] = []        # 30–60 min
    extra_long: list[EpisodeOut] = []  # > 60 min


@router.get("/suggestions", response_model=SuggestionsOut)
def get_suggestions(db: Session = Depends(get_db)):
    """Return up to 3 diverse downloaded, unplayed episodes per duration category."""
    import random
    from app.routers.stats import _parse_seconds
    from app.models import GlobalSettings

    gs = db.query(GlobalSettings).first()
    if gs and not getattr(gs, "show_suggested_listening", True):
        return SuggestionsOut()

    episodes = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(
            Episode.status == "downloaded",
            Episode.played.is_(False),
            Episode.hidden.is_(False),
            Episode.duration.isnot(None),
        )
        .all()
    )

    short, medium, long, extra_long = [], [], [], []
    for ep in episodes:
        secs = _parse_seconds(ep.duration)
        if secs < 60:
            continue
        mins = secs / 60
        if mins <= 15:
            short.append(ep)
        elif mins <= 30:
            medium.append(ep)
        elif mins <= 60:
            long.append(ep)
        else:
            extra_long.append(ep)

    def _pick_diverse(pool: list, n: int = 3) -> list[EpisodeOut]:
        if not pool:
            return []
        random.shuffle(pool)
        picked, seen_feeds = [], set()
        for ep in pool:
            if ep.feed_id not in seen_feeds and len(picked) < n:
                picked.append(ep)
                seen_feeds.add(ep.feed_id)
        for ep in pool:
            if ep not in picked and len(picked) < n:
                picked.append(ep)
        return [_ep_out(ep) for ep in picked]

    return SuggestionsOut(
        short=_pick_diverse(short),
        medium=_pick_diverse(medium),
        long=_pick_diverse(long),
        extra_long=_pick_diverse(extra_long),
    )


@router.get("/continue-listening", response_model=list[EpisodeOut])
def continue_listening(limit: int = 10, db: Session = Depends(get_db)):
    """Return episodes that have been started but not finished, newest activity first."""
    episodes = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(
            Episode.status == "downloaded",
            Episode.played.is_(False),
            Episode.play_position_seconds > 0,
            Episode.hidden.is_(False),
        )
        .order_by(Episode.last_played_at.desc())
        .limit(limit)
        .all()
    )
    return [_ep_out(ep) for ep in episodes]


@router.get("/{episode_id}", response_model=EpisodeOut)
def get_episode(episode_id: int, db: Session = Depends(get_db)):
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    return _ep_out(ep)


@router.post("/{episode_id}/download", response_model=EpisodeOut)
def queue_download(episode_id: int, db: Session = Depends(get_db)):
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    if ep.status == "downloaded":
        raise HTTPException(status_code=409, detail="Episode already downloaded")
    if ep.status in ("queued", "downloading"):
        raise HTTPException(status_code=409, detail="Episode is already queued or downloading")

    ep.status = "queued"
    ep.queued_at = datetime.utcnow()
    ep.error_message = None
    db.commit()
    db.refresh(ep)

    log.info("Download queued: '%s' (ep %d, feed: %s)", ep.title or "Untitled", episode_id, ep.feed.title if ep.feed else "?")
    enqueue_download(episode_id)
    return _ep_out(ep)


@router.post("/{episode_id}/retry", response_model=EpisodeOut)
def retry_download(episode_id: int, db: Session = Depends(get_db)):
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    if ep.status not in ("failed", "pending", "skipped"):
        raise HTTPException(status_code=409, detail="Episode cannot be retried in its current state")

    ep.status = "queued"
    ep.queued_at = datetime.utcnow()
    ep.error_message = None
    ep.download_progress = 0
    db.commit()
    db.refresh(ep)

    log.info("Download retry queued: '%s' (ep %d)", ep.title or "Untitled", episode_id)
    enqueue_download(episode_id)
    return _ep_out(ep)


@router.post("/{episode_id}/cancel", response_model=EpisodeOut)
def cancel_episode(episode_id: int, db: Session = Depends(get_db)):
    """Cancel a queued or actively downloading episode, returning it to pending."""
    from app.downloader import request_cancel
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    if ep.status not in ("queued", "downloading"):
        raise HTTPException(status_code=409, detail="Episode is not queued or downloading")
    request_cancel(episode_id)  # safe for both queued and downloading
    ep.status = "pending"
    ep.error_message = None
    ep.download_progress = 0
    db.commit()
    db.refresh(ep)
    log.info("Download cancelled: '%s' (ep %d)", ep.title or "Untitled", episode_id)
    return _ep_out(ep)


@router.delete("/{episode_id}/file", response_model=EpisodeOut)
def delete_file(episode_id: int, db: Session = Depends(get_db)):
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    if ep.file_path and os.path.exists(ep.file_path):
        os.remove(ep.file_path)
        base = os.path.splitext(ep.file_path)[0]
        for ext in (".xml", ".jpg", ".png", ".webp"):
            sidecar = (ep.file_path + ext) if ext == ".xml" else (base + ext)
            if os.path.exists(sidecar):
                os.remove(sidecar)

    ep.status = "pending"
    ep.file_path = None
    ep.file_size = None
    ep.download_date = None
    ep.download_progress = 0
    db.commit()
    db.refresh(ep)
    log.info("File deleted for episode: '%s' (ep %d)", ep.title or "Untitled", episode_id)
    return _ep_out(ep)


class SetNumberBody(BaseModel):
    seq_number: int | None = None  # None = clear manual override


class SetImageBody(BaseModel):
    url: str | None = None  # None = clear custom image


@router.post("/{episode_id}/set-number", response_model=EpisodeOut)
def set_episode_number(episode_id: int, body: SetNumberBody, db: Session = Depends(get_db)):
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")

    if body.seq_number is None:
        # Clear the lock; let recalc assign automatically
        ep.seq_number_locked = False
    else:
        ep.seq_number = body.seq_number
        ep.seq_number_locked = True
        if ep.file_path and os.path.exists(ep.file_path):
            ep.filename_outdated = True

    db.flush()
    primary_id = ep.feed.primary_feed_id or ep.feed_id
    recalc_seq_numbers(primary_id, db)
    db.commit()
    db.refresh(ep)
    log.info("Episode number set: '%s' (ep %d) → %s", ep.title or "Untitled", episode_id, body.seq_number)
    return _ep_out(ep)


@router.post("/{episode_id}/set-image", response_model=EpisodeOut)
def set_episode_image(episode_id: int, body: SetImageBody, db: Session = Depends(get_db)):
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    ep.custom_image_url = body.url or None
    db.commit()
    db.refresh(ep)
    return _ep_out(ep)


@router.post("/{episode_id}/upload-image", response_model=EpisodeOut)
async def upload_episode_image(
    episode_id: int,
    image: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload an image file to use as episode cover art."""
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    if not ep.file_path:
        raise HTTPException(status_code=400, detail="Episode has no downloaded file")

    art_path = os.path.splitext(ep.file_path)[0] + ".jpg"
    try:
        contents = await image.read(10 * 1024 * 1024 + 1)  # read up to 10 MB + 1 byte
        if len(contents) > 10 * 1024 * 1024:
            log.warning("Episode cover upload rejected: file too large (%d bytes) for ep %d", len(contents), episode_id)
            raise HTTPException(status_code=413, detail="Image too large (max 10 MB)")
        # Validate that the upload is actually an image
        import io
        from PIL import Image as _Img
        try:
            with _Img.open(io.BytesIO(contents)) as img:
                img.verify()
        except Exception:
            log.warning("Episode cover upload rejected: not a valid image for ep %d", episode_id)
            raise HTTPException(status_code=400, detail="File is not a valid image")
        os.makedirs(os.path.dirname(art_path), exist_ok=True)
        with open(art_path, "wb") as f:
            f.write(contents)
    except HTTPException:
        raise
    except Exception as exc:
        log.error("Failed to save episode cover for ep %d: %s", episode_id, exc)
        raise HTTPException(status_code=500, detail="Failed to save image")

    # Clear any URL-based override so the local sidecar takes effect
    ep.custom_image_url = None
    db.commit()
    db.refresh(ep)
    log.info("Episode cover art uploaded: '%s' (ep %d)", ep.title or "Untitled", episode_id)
    return _ep_out(ep)


class SetID3TagsBody(BaseModel):
    tags: dict[str, str] | None = None  # None = clear all overrides


@router.post("/{episode_id}/set-id3-tags", response_model=EpisodeOut)
def set_episode_id3_tags(episode_id: int, body: SetID3TagsBody, db: Session = Depends(get_db)):
    """Store per-episode custom ID3 tag values. Marks id3_tags_outdated=True so
    'Apply File Updates' will write them to the actual audio file."""
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    if not ep.file_path:
        raise HTTPException(status_code=400, detail="Episode has no downloaded file")

    ep.custom_id3_tags = body.tags or None
    ep.id3_tags_outdated = bool(body.tags)
    db.commit()
    db.refresh(ep)
    log.info("Custom ID3 tags %s for ep %d", "set" if body.tags else "cleared", episode_id)
    return _ep_out(ep)


@router.post("/{episode_id}/hide", response_model=EpisodeOut)
def hide_episode(episode_id: int, db: Session = Depends(get_db)):
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    ep.hidden = True
    db.flush()
    primary_id = ep.feed.primary_feed_id or ep.feed_id
    recalc_seq_numbers(primary_id, db)
    db.commit()
    db.refresh(ep)
    log.info("Episode hidden: '%s' (ep %d)", ep.title or "Untitled", episode_id)
    return _ep_out(ep)


@router.post("/{episode_id}/unhide", response_model=EpisodeOut)
def unhide_episode(episode_id: int, db: Session = Depends(get_db)):
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    ep.hidden = False
    db.flush()
    primary_id = ep.feed.primary_feed_id or ep.feed_id
    recalc_seq_numbers(primary_id, db)
    db.commit()
    db.refresh(ep)
    log.info("Episode unhidden: '%s' (ep %d)", ep.title or "Untitled", episode_id)
    return _ep_out(ep)


@router.post("/{episode_id}/played", response_model=EpisodeOut)
def toggle_played(episode_id: int, db: Session = Depends(get_db)):
    """Toggle the played state of an episode."""
    from datetime import datetime
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    ep.played = not ep.played
    if ep.played:
        ep.last_played_at = datetime.utcnow()
    db.commit()
    db.refresh(ep)
    log.info("Episode marked %s: '%s' (ep %d)", "played" if ep.played else "unplayed", ep.title or "Untitled", episode_id)
    return _ep_out(ep)


class ProgressBody(BaseModel):
    position_seconds: int


@router.post("/{episode_id}/progress", response_model=EpisodeOut)
def update_progress(episode_id: int, body: ProgressBody, db: Session = Depends(get_db)):
    """Update playback position (called periodically by the audio player)."""
    from datetime import datetime
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    ep.play_position_seconds = max(0, body.position_seconds)
    ep.last_played_at = datetime.utcnow()
    db.commit()
    db.refresh(ep)
    return _ep_out(ep)


@router.post("/{episode_id}/dismiss", response_model=EpisodeOut)
def dismiss_failed(episode_id: int, db: Session = Depends(get_db)):
    """Clear a failed episode back to pending (removes it from the failed list)."""
    ep = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not ep:
        raise HTTPException(status_code=404, detail="Episode not found")
    if ep.status != "failed":
        raise HTTPException(status_code=409, detail="Episode is not failed")
    ep.status = "pending"
    ep.error_message = None
    ep.download_progress = 0
    db.commit()
    db.refresh(ep)
    log.info("Failed episode dismissed: '%s' (ep %d)", ep.title or "Untitled", episode_id)
    return _ep_out(ep)


@router.post("/dismiss-all-failed")
def dismiss_all_failed(db: Session = Depends(get_db)):
    """Clear all failed episodes back to pending."""
    episodes = db.query(Episode).filter(Episode.status == "failed", Episode.hidden.is_(False)).all()
    for ep in episodes:
        ep.status = "pending"
        ep.error_message = None
        ep.download_progress = 0
    db.commit()
    log.info("Dismissed %d failed episode(s) back to pending", len(episodes))
    return {"dismissed": len(episodes)}


@router.post("/retry-all-failed")
def retry_all_failed(db: Session = Depends(get_db)):
    """Re-queue all failed episodes for download."""
    episodes = (
        db.query(Episode)
        .filter(Episode.status == "failed", Episode.hidden.is_(False))
        .all()
    )
    now = datetime.utcnow()
    for ep in episodes:
        ep.status = "queued"
        ep.queued_at = now
        ep.error_message = None
        ep.download_progress = 0
    db.commit()
    log.info("Retry all failed: queued %d episodes", len(episodes))
    for ep in episodes:
        enqueue_download(ep.id)
    return {"queued": len(episodes)}


class BulkBody(BaseModel):
    episode_ids: list[int]
    action: str  # download | delete_file | hide | unhide | mark_played | mark_unplayed


@router.post("/bulk")
def bulk_action(body: BulkBody, db: Session = Depends(get_db)):
    """Apply an action to multiple episodes at once."""
    from datetime import datetime
    episodes = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id.in_(body.episode_ids))
        .all()
    )
    if not episodes:
        return {"affected": 0}

    affected = 0
    action = body.action

    if action == "download":
        now = datetime.utcnow()
        for ep in episodes:
            if ep.status not in ("downloaded", "queued", "downloading"):
                ep.status = "queued"
                ep.queued_at = now
                ep.error_message = None
                affected += 1
        db.commit()
        for ep in episodes:
            if ep.status == "queued":
                enqueue_download(ep.id)

    elif action == "delete_file":
        for ep in episodes:
            if ep.file_path and os.path.exists(ep.file_path):
                os.remove(ep.file_path)
                base = os.path.splitext(ep.file_path)[0]
                for ext in (".xml", ".jpg", ".png", ".webp"):
                    sidecar = (ep.file_path + ext) if ext == ".xml" else (base + ext)
                    if os.path.exists(sidecar):
                        os.remove(sidecar)
            ep.status = "pending"
            ep.file_path = None
            ep.file_size = None
            ep.download_date = None
            ep.download_progress = 0
            affected += 1
        db.commit()

    elif action == "hide":
        primary_ids: set[int] = set()
        for ep in episodes:
            ep.hidden = True
            primary_ids.add(ep.feed.primary_feed_id or ep.feed_id)
            affected += 1
        db.flush()
        for pid in primary_ids:
            recalc_seq_numbers(pid, db)
        db.commit()

    elif action == "unhide":
        primary_ids = set()
        for ep in episodes:
            ep.hidden = False
            primary_ids.add(ep.feed.primary_feed_id or ep.feed_id)
            affected += 1
        db.flush()
        for pid in primary_ids:
            recalc_seq_numbers(pid, db)
        db.commit()

    elif action == "mark_played":
        for ep in episodes:
            ep.played = True
            ep.last_played_at = datetime.utcnow()
            affected += 1
        db.commit()

    elif action == "mark_unplayed":
        for ep in episodes:
            ep.played = False
            ep.play_position_seconds = 0
            affected += 1
        db.commit()

    else:
        raise HTTPException(status_code=400, detail="Unknown action")

    log.info("Bulk %s applied to %d episode(s)", action, affected)
    return {"affected": affected}
