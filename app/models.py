from datetime import datetime
from typing import Optional
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime,
    ForeignKey, JSON, Text, BigInteger,
)
from sqlalchemy.orm import relationship
from app.database import Base


class GlobalSettings(Base):
    __tablename__ = "global_settings"

    id = Column(Integer, primary_key=True, index=True)
    download_path = Column(String, default="/downloads")
    check_interval = Column(Integer, default=60)       # minutes
    filename_date_prefix = Column(Boolean, default=True)
    filename_episode_number = Column(Boolean, default=True)
    organize_by_year = Column(Boolean, default=True)
    save_xml = Column(Boolean, default=True)
    max_concurrent_downloads = Column(Integer, default=2)
    auto_download_new = Column(Boolean, default=True)
    # Default ID3 mapping used when a feed enables ID3 but has no custom mapping
    default_id3_mapping = Column(JSON, default=dict)
    # How many log entries to keep in the in-memory ring buffer
    log_max_entries = Column(Integer, default=1000)
    # Max episodes shown per feed page before "Load more"
    episode_page_size = Column(Integer, default=10000)
    # Auto-cleanup: keep only the N most recent downloaded episodes globally (None = disabled)
    keep_latest = Column(Integer, nullable=True)
    # When True, unplayed episodes are exempt from keep_latest cleanup
    keep_unplayed = Column(Boolean, default=True, nullable=True)
    # Mark episode as played when this % of duration has been listened to (0 = disabled, default 90)
    auto_played_threshold = Column(Integer, default=95)
    # UI color theme
    theme = Column(String, default="midnight")
    # Dashboard panels
    show_suggested_listening = Column(Boolean, default=True)
    # First-run setup wizard
    setup_complete = Column(Boolean, default=False)
    # Authentication
    auth_enabled = Column(Boolean, default=False)
    auth_username = Column(String, nullable=True)
    auth_password_hash = Column(String, nullable=True)


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id = Column(Integer, primary_key=True, index=True)
    token = Column(String, nullable=False, unique=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    last_used_at = Column(DateTime, nullable=True)


class Feed(Base):
    __tablename__ = "feeds"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=True)
    url = Column(String, unique=True, nullable=False)
    description = Column(Text, nullable=True)
    image_url = Column(String, nullable=True)
    website_url = Column(String, nullable=True)
    author = Column(String, nullable=True)
    language = Column(String, nullable=True)
    category = Column(String, nullable=True)

    # Per-feed overrides (None = inherit global)
    download_path = Column(String, nullable=True)
    check_interval = Column(Integer, nullable=True)
    filename_date_prefix = Column(Boolean, nullable=True)
    filename_episode_number = Column(Boolean, nullable=True)
    organize_by_year = Column(Boolean, nullable=True)
    save_xml = Column(Boolean, nullable=True)

    # ID3 tagging
    id3_enabled = Column(Boolean, default=False)
    # Maps ID3 tag name -> RSS source field name
    id3_field_mapping = Column(JSON, default=dict)

    # Podcast grouping: feeds with the same group share a download folder
    podcast_group = Column(String, nullable=True)

    # Supplementary feed: if set, this feed's episodes go into the primary feed's folder
    primary_feed_id = Column(Integer, ForeignKey("feeds.id"), nullable=True, index=True)

    # Auto-download: None = inherit from GlobalSettings
    auto_download_new = Column(Boolean, nullable=True)

    # Episode numbering: sequence starts at this value (default 1)
    episode_number_start = Column(Integer, default=1, nullable=False)

    # False until the first background sync completes; used to suppress
    # auto-download on the initial batch of historical episodes
    initial_sync_complete = Column(Boolean, default=False)

    # When True, queue all episodes for download after the initial sync
    download_all_on_first_sync = Column(Boolean, default=False)

    # User-supplied cover art (overrides image_url from RSS)
    custom_image_url = Column(String, nullable=True)

    # Auto-cleanup: keep only the N most recent downloaded episodes (None = disabled)
    keep_latest = Column(Integer, nullable=True)
    # When True, unplayed episodes are exempt from keep_latest cleanup
    keep_unplayed = Column(Boolean, default=True, nullable=True)

    # Status
    active = Column(Boolean, default=True)
    last_checked = Column(DateTime, nullable=True)
    last_error = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    episodes = relationship(
        "Episode", back_populates="feed", cascade="all, delete-orphan",
        order_by="Episode.published_at.desc()",
    )


class Episode(Base):
    __tablename__ = "episodes"

    id = Column(Integer, primary_key=True, index=True)
    feed_id = Column(Integer, ForeignKey("feeds.id", ondelete="CASCADE"), nullable=False)

    # RSS fields
    title = Column(String, nullable=True)
    guid = Column(String, nullable=False)
    enclosure_url = Column(String, nullable=True)
    enclosure_type = Column(String, nullable=True)   # e.g. audio/mpeg
    enclosure_length = Column(BigInteger, nullable=True)
    published_at = Column(DateTime, nullable=True)
    date_is_approximate = Column(Boolean, default=False, nullable=False)
    description = Column(Text, nullable=True)
    duration = Column(String, nullable=True)
    episode_number = Column(Integer, nullable=True)
    season_number = Column(Integer, nullable=True)
    episode_image_url = Column(String, nullable=True)
    author = Column(String, nullable=True)
    link = Column(String, nullable=True)

    # Download state
    # pending | queued | downloading | downloaded | failed | skipped
    status = Column(String, default="pending", nullable=False, index=True)
    file_path = Column(String, nullable=True)
    file_size = Column(BigInteger, nullable=True)
    download_progress = Column(Integer, default=0)  # 0-100
    download_date = Column(DateTime, nullable=True)
    queued_at = Column(DateTime, nullable=True)
    error_message = Column(Text, nullable=True)

    # User-supplied cover art (overrides episode_image_url from RSS)
    custom_image_url = Column(String, nullable=True)

    # Episode management
    hidden = Column(Boolean, default=False, index=True)  # user-suppressed duplicate
    seq_number = Column(Integer, nullable=True)      # sequential number across podcast group
    seq_number_locked = Column(Boolean, default=False)  # if True, seq_number is a manual override
    filename_outdated = Column(Boolean, default=False)  # seq_number changed; file needs renaming
    custom_id3_tags = Column(JSON, nullable=True)   # per-episode tag overrides {TAG: value}
    id3_tags_outdated = Column(Boolean, default=False)  # custom tags set but not yet written to file

    # Playback tracking
    played = Column(Boolean, default=False, index=True)
    play_position_seconds = Column(Integer, default=0)
    last_played_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    feed = relationship("Feed", back_populates="episodes")
