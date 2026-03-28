import logging
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

from app.database import get_db
from app.models import GlobalSettings
from app.schemas import (
    GlobalSettingsOut, GlobalSettingsUpdate,
    ID3TagInfo, RSSSourceInfo,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Canonical ID3 tag definitions surfaced to the UI
ID3_TAGS: list[ID3TagInfo] = [
    ID3TagInfo(tag="TIT2", label="Title"),
    ID3TagInfo(tag="TPE1", label="Artist / Author"),
    ID3TagInfo(tag="TALB", label="Album (Podcast Name)"),
    ID3TagInfo(tag="TDRC", label="Recording Date"),
    ID3TagInfo(tag="TRCK", label="Track Number (Episode #)"),
    ID3TagInfo(tag="TPOS", label="Part of Set (Season #)"),
    ID3TagInfo(tag="TCON", label="Genre / Category"),
    ID3TagInfo(tag="COMM", label="Comment / Description"),
    ID3TagInfo(tag="APIC", label="Cover Art"),
    ID3TagInfo(tag="TIT3", label="Subtitle"),
    ID3TagInfo(tag="TPUB", label="Publisher"),
    ID3TagInfo(tag="TENC", label="Encoded By"),
]

# RSS source fields that can be mapped to ID3 tags
RSS_SOURCES: list[RSSSourceInfo] = [
    RSSSourceInfo(field="episode.title", label="Episode Title"),
    RSSSourceInfo(field="episode.author", label="Episode Author"),
    RSSSourceInfo(field="episode.description", label="Episode Description"),
    RSSSourceInfo(field="episode.published", label="Episode Publication Date"),
    RSSSourceInfo(field="episode.episode_number", label="Episode Number"),
    RSSSourceInfo(field="episode.season_number", label="Season Number"),
    RSSSourceInfo(field="episode.duration", label="Episode Duration"),
    RSSSourceInfo(field="feed.title", label="Podcast Title"),
    RSSSourceInfo(field="feed.author", label="Podcast Author"),
    RSSSourceInfo(field="feed.category", label="Podcast Category"),
    RSSSourceInfo(field="feed.image", label="Podcast Cover Art"),
    RSSSourceInfo(field="episode.image", label="Episode Cover Art (falls back to feed)"),
]

DEFAULT_ID3_MAPPING: dict[str, str] = {
    "TIT2": "episode.title",
    "TPE1": "episode.author",
    "TALB": "feed.title",
    "TDRC": "episode.published",
    "TRCK": "episode.episode_number",
    "TPOS": "episode.season_number",
    "TCON": "feed.category",
    "COMM": "episode.description",
    "APIC": "episode.image",
    "TPUB": "feed.author",
}


def _get_or_create_settings(db: Session) -> GlobalSettings:
    settings = db.query(GlobalSettings).first()
    if not settings:
        settings = GlobalSettings(default_id3_mapping=DEFAULT_ID3_MAPPING)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


@router.get("", response_model=GlobalSettingsOut)
def get_settings(db: Session = Depends(get_db)):
    return _get_or_create_settings(db)


@router.put("", response_model=GlobalSettingsOut)
def update_settings(body: GlobalSettingsUpdate, db: Session = Depends(get_db)):
    settings = _get_or_create_settings(db)
    updates = body.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(settings, field, value)
    db.commit()
    db.refresh(settings)
    # Inline imports below avoid circular imports at module load time:
    # log_buffer and downloader both import from app.models / app.database,
    # so importing them at the top of this file would create a cycle.
    if body.log_max_entries is not None:
        from app.log_buffer import set_maxlen
        set_maxlen(body.log_max_entries)
    if "max_concurrent_downloads" in updates:
        from app import downloader as _dl
        _dl._cached_max_concurrent = None  # force re-read on next enqueue
    log.info("Settings updated: %s", ", ".join(updates.keys()))
    return settings


@router.get("/logs")
def get_logs(
    limit: int = Query(default=1000, le=5000),
    level: Optional[str] = Query(default=None),
):
    """Return recent application log entries from the in-memory buffer."""
    from app.log_buffer import get_logs as _get_logs  # inline: circular import avoidance
    return _get_logs(limit=limit, min_level=level)


@router.get("/id3-tags", response_model=list[ID3TagInfo])
def list_id3_tags():
    return ID3_TAGS


@router.get("/rss-sources", response_model=list[RSSSourceInfo])
def list_rss_sources():
    return RSS_SOURCES


