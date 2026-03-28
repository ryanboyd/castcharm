"Backend stats endpoints."
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Feed, Episode

router = APIRouter(prefix="/api/stats", tags=["stats"])


# ---------------------------------------------------------------------------
# Duration parsing
# ---------------------------------------------------------------------------

def _parse_seconds(duration: Optional[str]) -> int:
    """Parse itunes:duration to integer seconds.

    Handles all common forms emitted by podcast feeds:
      - plain integer:        "3600"
      - plain float:          "3600.0"
      - HH:MM:SS:            "1:00:00"
      - HH:MM:SS.fraction:   "1:00:00.5"
      - MM:SS:               "60:00"
    """
    if not duration:
        return 0
    s = duration.strip()
    # Plain number (int or float)
    if re.fullmatch(r"[\d.]+", s):
        try:
            return int(float(s))
        except ValueError:
            return 0
    # Colon-separated (strip any trailing decimal on the seconds component)
    parts = s.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(float(parts[2]))
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(float(parts[1]))
    except (ValueError, IndexError):
        pass
    return 0


def _simplify_mime(mime: Optional[str]) -> str:
    if not mime:
        return "Unknown"
    m = mime.lower()
    if "mpeg" in m:
        return "MP3"
    if "m4a" in m or ("mp4" in m and "audio" in m):
        return "AAC/M4A"
    if "aac" in m:
        return "AAC"
    if "ogg" in m or "vorbis" in m:
        return "OGG"
    if "opus" in m:
        return "Opus"
    if "flac" in m:
        return "FLAC"
    if "wav" in m:
        return "WAV"
    return mime.split("/")[-1].upper() if "/" in mime else mime.upper()


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class YearBucket(BaseModel):
    year: str
    total: int
    downloaded: int


class DowBucket(BaseModel):
    dow: int   # 0 = Sunday … 6 = Saturday (SQLite strftime %w convention)
    total: int


class FormatBucket(BaseModel):
    label: str
    count: int
    bytes: int


class FeedStatRow(BaseModel):
    feed_id: int
    title: str
    image_url: Optional[str] = None
    episode_count: int
    downloaded_count: int
    unplayed_count: int = 0
    partially_played_count: int = 0
    played_not_downloaded_count: int = 0
    storage_bytes: int
    runtime_seconds: int
    listen_seconds: int = 0


class FeedDurationsOut(BaseModel):
    feed_id: int
    title: str
    durations: list[int]  # seconds, downloaded episodes only


class GlobalStatsOut(BaseModel):
    episodes_by_year: list[YearBucket]
    episodes_by_dow: list[DowBucket]
    format_breakdown: list[FormatBucket]
    total_runtime_seconds: int
    total_listen_seconds: int = 0
    total_unplayed_count: int = 0
    total_partially_played_count: int = 0
    total_played_not_downloaded_count: int = 0
    by_feed: list[FeedStatRow]
    feed_durations: list[FeedDurationsOut] = []


class FeedStatsOut(BaseModel):
    episodes_by_year: list[YearBucket]
    episodes_by_dow: list[DowBucket]
    format_breakdown: list[FormatBucket]
    runtime_seconds: int
    storage_bytes: int
    episode_count: int
    downloaded_count: int
    unplayed_count: int = 0
    partially_played_count: int = 0
    played_not_downloaded_count: int = 0
    listen_seconds: int = 0
    episode_durations: list[int] = []  # seconds, one per non-hidden episode with known duration


# ---------------------------------------------------------------------------
# Shared query helpers
# ---------------------------------------------------------------------------

def _year_buckets(feed_ids: Optional[list[int]], db: Session) -> list[YearBucket]:
    def _run(extra=None):
        q = (
            db.query(
                func.strftime("%Y", Episode.published_at).label("yr"),
                func.count(Episode.id).label("cnt"),
            )
            .filter(
                Episode.published_at.isnot(None),
                Episode.hidden.is_(False),
                Episode.date_is_approximate.is_(False),
            )
        )
        if feed_ids is not None:
            q = q.filter(Episode.feed_id.in_(feed_ids))
        if extra is not None:
            q = q.filter(extra)
        return dict(q.group_by("yr").all())

    total = _run()
    dl = _run(Episode.status == "downloaded")
    years = sorted(set(total) | set(dl))
    return [YearBucket(year=y, total=total.get(y, 0), downloaded=dl.get(y, 0)) for y in years]


def _dow_buckets(feed_ids: Optional[list[int]], db: Session) -> list[DowBucket]:
    """Return episode counts grouped by day-of-week (0=Sun … 6=Sat).

    Episodes with an approximate date (imported files where only the year was known)
    are excluded because their day-of-week is meaningless.
    """
    q = (
        db.query(
            func.strftime("%w", Episode.published_at).label("dow"),
            func.count(Episode.id).label("cnt"),
        )
        .filter(
            Episode.published_at.isnot(None),
            Episode.hidden.is_(False),
            Episode.date_is_approximate.is_(False),
        )
    )
    if feed_ids is not None:
        q = q.filter(Episode.feed_id.in_(feed_ids))
    rows = dict(q.group_by("dow").all())
    return [DowBucket(dow=i, total=rows.get(str(i), 0)) for i in range(7)]


_MPEG_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]


def _estimate_kbps(file_size: Optional[int], duration: Optional[str]) -> Optional[int]:
    """Estimate bitrate in kbps from file size and duration string."""
    if not file_size or not duration:
        return None
    dur_secs = _parse_seconds(duration)
    if dur_secs <= 0:
        return None
    raw = (file_size * 8) / dur_secs / 1000
    return min(_MPEG_BITRATES, key=lambda x: abs(x - raw))


def _format_breakdown(feed_ids: Optional[list[int]], db: Session) -> list[FormatBucket]:
    q = (
        db.query(Episode.enclosure_type, Episode.file_size, Episode.duration)
        .filter(Episode.status == "downloaded")
    )
    if feed_ids is not None:
        q = q.filter(Episode.feed_id.in_(feed_ids))
    seen: dict[str, FormatBucket] = {}
    for enc_type, file_size, duration in q.all():
        fmt = _simplify_mime(enc_type)
        kbps = _estimate_kbps(file_size, duration)
        label = f"{fmt} · {kbps} kbps" if kbps else fmt
        if label in seen:
            seen[label].count += 1
            seen[label].bytes += int(file_size or 0)
        else:
            seen[label] = FormatBucket(label=label, count=1, bytes=int(file_size or 0))
    return sorted(seen.values(), key=lambda x: x.count, reverse=True)


def _total_runtime(feed_ids: Optional[list[int]], db: Session) -> int:
    # Duration is measured from the audio file at download time, so only
    # downloaded episodes have reliable values.
    q = db.query(Episode.duration).filter(
        Episode.status == "downloaded",
        Episode.duration.isnot(None),
        Episode.hidden.is_(False),
    )
    if feed_ids is not None:
        q = q.filter(Episode.feed_id.in_(feed_ids))
    return sum(_parse_seconds(row[0]) for row in q.all())


def _unplayed_by_feed(feed_ids: list[int], db: Session) -> dict[int, int]:
    """Return count of downloaded+unplayed+non-hidden episodes keyed by feed_id."""
    rows = (
        db.query(Episode.feed_id, func.count(Episode.id).label("cnt"))
        .filter(
            Episode.feed_id.in_(feed_ids),
            Episode.status == "downloaded",
            Episode.played.is_(False),
            Episode.hidden.is_(False),
        )
        .group_by(Episode.feed_id)
        .all()
    )
    return {r.feed_id: r.cnt for r in rows}


def _played_not_downloaded_by_feed(feed_ids: list[int], db: Session) -> dict[int, int]:
    """Return count of played+not-downloaded+non-hidden episodes keyed by feed_id.

    These are episodes the user has marked as played but whose audio file is not
    present (e.g. manually marked, or downloaded-then-deleted after listening).
    """
    rows = (
        db.query(Episode.feed_id, func.count(Episode.id).label("cnt"))
        .filter(
            Episode.feed_id.in_(feed_ids),
            Episode.status != "downloaded",
            Episode.played.is_(True),
            Episode.hidden.is_(False),
        )
        .group_by(Episode.feed_id)
        .all()
    )
    return {r.feed_id: r.cnt for r in rows}


def _partially_played_by_feed(feed_ids: list[int], db: Session) -> dict[int, int]:
    """Return count of downloaded+not-fully-played+started+non-hidden episodes.

    'Partially played' means the user has begun listening (play_position_seconds > 0)
    but has not yet marked the episode as played.
    """
    rows = (
        db.query(Episode.feed_id, func.count(Episode.id).label("cnt"))
        .filter(
            Episode.feed_id.in_(feed_ids),
            Episode.status == "downloaded",
            Episode.played.is_(False),
            Episode.play_position_seconds > 0,
            Episode.hidden.is_(False),
        )
        .group_by(Episode.feed_id)
        .all()
    )
    return {r.feed_id: r.cnt for r in rows}


def _episode_durations(feed_ids: list[int], db: Session) -> list[int]:
    """Return parsed duration in seconds for every non-hidden episode with a known duration."""
    rows = (
        db.query(Episode.duration)
        .filter(
            Episode.feed_id.in_(feed_ids),
            Episode.status == "downloaded",
            Episode.duration.isnot(None),
            Episode.hidden.is_(False),
        )
        .all()
    )
    return [s for (d,) in rows if (s := _parse_seconds(d)) >= 60]


def _total_listen_time(feed_ids: Optional[list[int]], db: Session) -> int:
    """Sum of play_position_seconds for all non-hidden episodes."""
    q = db.query(func.coalesce(func.sum(Episode.play_position_seconds), 0)).filter(
        Episode.hidden.is_(False),
        Episode.play_position_seconds > 0,
    )
    if feed_ids is not None:
        q = q.filter(Episode.feed_id.in_(feed_ids))
    return int(q.scalar() or 0)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("", response_model=GlobalStatsOut)
def get_global_stats(db: Session = Depends(get_db)):
    episodes_by_year = _year_buckets(None, db)
    episodes_by_dow  = _dow_buckets(None, db)
    format_bkdn = _format_breakdown(None, db)
    total_runtime = _total_runtime(None, db)
    total_listen = _total_listen_time(None, db)

    # Primary feeds only (supplementary feeds roll up into their primary)
    feeds = db.query(Feed).filter(Feed.primary_feed_id.is_(None)).all()

    # Map each primary feed to all its feed IDs (primary + supplementary)
    sub_map: dict[int, list[int]] = {}
    for f in feeds:
        subs = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == f.id).all()]
        sub_map[f.id] = [f.id] + subs

    all_feed_ids = [fid for ids in sub_map.values() for fid in ids]

    # Aggregate totals per feed_id in one pass
    agg_rows = (
        db.query(
            Episode.feed_id,
            func.count(Episode.id).label("total"),
            func.coalesce(func.sum(Episode.file_size), 0).label("storage"),
        )
        .filter(Episode.feed_id.in_(all_feed_ids), Episode.hidden.is_(False))
        .group_by(Episode.feed_id)
        .all()
    )
    dl_rows = (
        db.query(Episode.feed_id, func.count(Episode.id).label("cnt"))
        .filter(
            Episode.feed_id.in_(all_feed_ids),
            Episode.status == "downloaded",
            Episode.hidden.is_(False),
        )
        .group_by(Episode.feed_id)
        .all()
    )
    storage_rows = (
        db.query(Episode.feed_id, func.coalesce(func.sum(Episode.file_size), 0).label("bytes"))
        .filter(Episode.feed_id.in_(all_feed_ids), Episode.status == "downloaded")
        .group_by(Episode.feed_id)
        .all()
    )
    dur_rows = (
        db.query(Episode.feed_id, Episode.duration)
        .filter(
            Episode.feed_id.in_(all_feed_ids),
            Episode.status == "downloaded",
            Episode.duration.isnot(None),
            Episode.hidden.is_(False),
        )
        .all()
    )
    listen_rows = (
        db.query(
            Episode.feed_id,
            func.coalesce(func.sum(Episode.play_position_seconds), 0).label("secs"),
        )
        .filter(
            Episode.feed_id.in_(all_feed_ids),
            Episode.hidden.is_(False),
            Episode.play_position_seconds > 0,
        )
        .group_by(Episode.feed_id)
        .all()
    )

    total_by = {r.feed_id: r.total for r in agg_rows}
    dl_by = {r.feed_id: r.cnt for r in dl_rows}
    storage_by = {r.feed_id: int(r.bytes or 0) for r in storage_rows}
    runtime_by: dict[int, int] = {}
    dur_list_by: dict[int, list[int]] = {}
    for fid, dur in dur_rows:
        s = _parse_seconds(dur)
        runtime_by[fid] = runtime_by.get(fid, 0) + s
        if s >= 60:
            dur_list_by.setdefault(fid, []).append(s)
    listen_by = {r.feed_id: int(r.secs or 0) for r in listen_rows}
    unplayed_by = _unplayed_by_feed(all_feed_ids, db)
    partial_by = _partially_played_by_feed(all_feed_ids, db)
    played_not_dl_by = _played_not_downloaded_by_feed(all_feed_ids, db)

    by_feed = []
    for f in feeds:
        ids = sub_map[f.id]
        by_feed.append(FeedStatRow(
            feed_id=f.id,
            title=f.title or f.url,
            image_url=f.custom_image_url or f.image_url,
            episode_count=sum(total_by.get(i, 0) for i in ids),
            downloaded_count=sum(dl_by.get(i, 0) for i in ids),
            unplayed_count=sum(unplayed_by.get(i, 0) for i in ids),
            partially_played_count=sum(partial_by.get(i, 0) for i in ids),
            played_not_downloaded_count=sum(played_not_dl_by.get(i, 0) for i in ids),
            storage_bytes=sum(storage_by.get(i, 0) for i in ids),
            runtime_seconds=sum(runtime_by.get(i, 0) for i in ids),
            listen_seconds=sum(listen_by.get(i, 0) for i in ids),
        ))
    by_feed.sort(key=lambda x: x.storage_bytes, reverse=True)

    # Build per-primary-feed duration lists for the overlay chart (at least 1 episode)
    feed_durations = []
    for f in feeds:
        ids = sub_map[f.id]
        durs = [s for i in ids for s in dur_list_by.get(i, [])]
        if len(durs) >= 1:
            feed_durations.append(FeedDurationsOut(
                feed_id=f.id,
                title=f.title or f.url,
                durations=durs,
            ))

    return GlobalStatsOut(
        episodes_by_year=episodes_by_year,
        episodes_by_dow=episodes_by_dow,
        format_breakdown=format_bkdn,
        total_runtime_seconds=total_runtime,
        total_listen_seconds=total_listen,
        total_unplayed_count=sum(unplayed_by.values()),
        total_partially_played_count=sum(partial_by.values()),
        total_played_not_downloaded_count=sum(played_not_dl_by.values()),
        by_feed=by_feed,
        feed_durations=feed_durations,
    )


@router.get("/feeds/{feed_id}", response_model=FeedStatsOut)
def get_feed_stats(feed_id: int, db: Session = Depends(get_db)):
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")

    subs = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == feed_id).all()]
    all_ids = [feed_id] + subs

    episodes_by_year = _year_buckets(all_ids, db)
    episodes_by_dow  = _dow_buckets(all_ids, db)
    format_bkdn = _format_breakdown(all_ids, db)
    runtime = _total_runtime(all_ids, db)
    listen = _total_listen_time(all_ids, db)
    ep_durations = _episode_durations(all_ids, db)

    total = (
        db.query(func.count(Episode.id))
        .filter(Episode.feed_id.in_(all_ids), Episode.hidden.is_(False))
        .scalar() or 0
    )
    downloaded = (
        db.query(func.count(Episode.id))
        .filter(Episode.feed_id.in_(all_ids), Episode.status == "downloaded", Episode.hidden.is_(False))
        .scalar() or 0
    )
    storage = (
        db.query(func.coalesce(func.sum(Episode.file_size), 0))
        .filter(Episode.feed_id.in_(all_ids), Episode.status == "downloaded")
        .scalar() or 0
    )

    unplayed = (
        db.query(func.count(Episode.id))
        .filter(
            Episode.feed_id.in_(all_ids),
            Episode.status == "downloaded",
            Episode.played.is_(False),
            Episode.hidden.is_(False),
        )
        .scalar() or 0
    )
    partially_played = (
        db.query(func.count(Episode.id))
        .filter(
            Episode.feed_id.in_(all_ids),
            Episode.status == "downloaded",
            Episode.played.is_(False),
            Episode.play_position_seconds > 0,
            Episode.hidden.is_(False),
        )
        .scalar() or 0
    )
    played_not_downloaded = (
        db.query(func.count(Episode.id))
        .filter(
            Episode.feed_id.in_(all_ids),
            Episode.status != "downloaded",
            Episode.played.is_(True),
            Episode.hidden.is_(False),
        )
        .scalar() or 0
    )

    return FeedStatsOut(
        episodes_by_year=episodes_by_year,
        episodes_by_dow=episodes_by_dow,
        format_breakdown=format_bkdn,
        runtime_seconds=runtime,
        storage_bytes=int(storage),
        episode_count=total,
        downloaded_count=downloaded,
        unplayed_count=int(unplayed),
        partially_played_count=int(partially_played),
        played_not_downloaded_count=int(played_not_downloaded),
        listen_seconds=listen,
        episode_durations=ep_durations,
    )
