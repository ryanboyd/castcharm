from datetime import datetime
from typing import Any, Optional
from pydantic import BaseModel, HttpUrl, field_validator


# ---------------------------------------------------------------------------
# Global settings
# ---------------------------------------------------------------------------

class GlobalSettingsBase(BaseModel):
    download_path: str = "/downloads"
    check_interval: int = 60
    filename_date_prefix: bool = True
    filename_episode_number: bool = True
    organize_by_year: bool = True
    save_xml: bool = True
    max_concurrent_downloads: int = 2
    auto_download_new: bool = True
    default_id3_mapping: dict[str, str] = {}
    log_max_entries: int = 1000
    episode_page_size: Optional[int] = 10000
    keep_latest: Optional[int] = None
    keep_unplayed: bool = True
    auto_played_threshold: int = 95
    theme: str = "midnight"
    show_suggested_listening: bool = True


class GlobalSettingsUpdate(BaseModel):
    download_path: Optional[str] = None
    check_interval: Optional[int] = None
    filename_date_prefix: Optional[bool] = None
    filename_episode_number: Optional[bool] = None
    organize_by_year: Optional[bool] = None
    save_xml: Optional[bool] = None
    max_concurrent_downloads: Optional[int] = None
    auto_download_new: Optional[bool] = None
    default_id3_mapping: Optional[dict[str, str]] = None
    log_max_entries: Optional[int] = None
    episode_page_size: Optional[int] = None
    keep_latest: Optional[int] = None
    keep_unplayed: Optional[bool] = None
    auto_played_threshold: Optional[int] = None
    theme: Optional[str] = None
    show_suggested_listening: Optional[bool] = None


class GlobalSettingsOut(GlobalSettingsBase):
    id: int

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Feeds
# ---------------------------------------------------------------------------

class FeedCreate(BaseModel):
    url: str
    download_all: bool = False
    title_override: Optional[str] = None

    @field_validator("url")
    @classmethod
    def url_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("URL must not be empty")
        return v


class ManualFeedCreate(BaseModel):
    title: str

    @field_validator("title")
    @classmethod
    def title_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Title must not be empty")
        return v


class FeedUpdate(BaseModel):
    url: Optional[str] = None
    active: Optional[bool] = None
    download_path: Optional[str] = None
    check_interval: Optional[int] = None
    filename_date_prefix: Optional[bool] = None
    filename_episode_number: Optional[bool] = None
    organize_by_year: Optional[bool] = None
    save_xml: Optional[bool] = None
    id3_enabled: Optional[bool] = None
    id3_field_mapping: Optional[dict[str, str]] = None
    podcast_group: Optional[str] = None
    auto_download_new: Optional[bool] = None
    episode_number_start: Optional[int] = None
    custom_image_url: Optional[str] = None
    keep_latest: Optional[int] = None
    keep_unplayed: Optional[bool] = None


class FeedOut(BaseModel):
    id: int
    title: Optional[str]
    url: str
    description: Optional[str]
    image_url: Optional[str]
    website_url: Optional[str]
    author: Optional[str]
    language: Optional[str]
    category: Optional[str]
    download_path: Optional[str]
    check_interval: Optional[int]
    filename_date_prefix: Optional[bool]
    filename_episode_number: Optional[bool]
    organize_by_year: Optional[bool]
    save_xml: Optional[bool]
    id3_enabled: bool
    id3_field_mapping: dict[str, str]
    active: bool
    last_checked: Optional[datetime]
    last_error: Optional[str]
    created_at: datetime
    updated_at: datetime
    podcast_group: Optional[str]
    primary_feed_id: Optional[int]
    auto_download_new: Optional[bool]
    episode_number_start: int = 1
    custom_image_url: Optional[str] = None
    # Computed
    episode_count: int = 0
    downloaded_count: int = 0
    available_count: int = 0           # pending + failed (not yet downloaded)
    unplayed_available_count: int = 0  # pending + failed + not played + not partially played
    skipped_count: int = 0             # duplicates suppressed at sync time
    hidden_count: int = 0              # user-hidden episodes
    unplayed_count: int = 0            # downloaded + not played
    needs_rename: bool = False  # downloaded episodes with outdated filenames
    initial_sync_complete: bool = False
    has_custom_cover: bool = False  # True when a local cover.jpg or custom_image_url is set
    last_download_at: Optional[datetime] = None  # most recent episode download_date across this feed
    keep_latest: Optional[int] = None
    podcast_folder: Optional[str] = None  # effective on-disk folder for this podcast
    keep_unplayed: bool = True

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Episodes
# ---------------------------------------------------------------------------

class EpisodeOut(BaseModel):
    id: int
    feed_id: int
    title: Optional[str]
    guid: str
    enclosure_url: Optional[str]
    enclosure_type: Optional[str]
    enclosure_length: Optional[int]
    published_at: Optional[datetime]
    description: Optional[str]
    duration: Optional[str]
    episode_number: Optional[int]
    season_number: Optional[int]
    episode_image_url: Optional[str]
    author: Optional[str]
    link: Optional[str]
    status: str
    file_path: Optional[str]
    file_size: Optional[int]
    download_progress: int
    download_date: Optional[datetime]
    error_message: Optional[str]
    hidden: bool = False
    seq_number: Optional[int] = None
    seq_number_locked: bool = False
    filename_outdated: bool = False
    custom_id3_tags: Optional[dict] = None
    id3_tags_outdated: bool = False
    custom_image_url: Optional[str] = None
    file_missing: bool = False
    played: bool = False
    play_position_seconds: int = 0
    last_played_at: Optional[datetime] = None
    date_is_approximate: bool = False
    created_at: datetime
    # Feed info for list views
    feed_title: Optional[str] = None
    feed_image_url: Optional[str] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# System status
# ---------------------------------------------------------------------------

class StatusOut(BaseModel):
    scheduler_running: bool
    download_queue_size: int
    active_downloads: int
    podcasts_total: int
    feeds_total: int
    episodes_total: int
    episodes_downloaded: int
    episodes_failed: int = 0
    storage_bytes: int
    version: str = "1.0.0"
    syncing_count: int = 0
    next_sync_at: Optional[datetime] = None
    importing_count: int = 0   # active file-import jobs
    scanning: bool = False     # startup folder scan in progress


# ---------------------------------------------------------------------------
# ID3 field mapping helpers (returned by the API for UI dropdowns)
# ---------------------------------------------------------------------------

class ID3TagInfo(BaseModel):
    tag: str
    label: str


class RSSSourceInfo(BaseModel):
    field: str
    label: str


# ---------------------------------------------------------------------------
# File import
# ---------------------------------------------------------------------------

class ImportFilesRequest(BaseModel):
    directory: str
    rename_files: bool = True
    organize_by_year: Optional[bool] = None
    date_prefix: Optional[bool] = None
    ep_num_prefix: Optional[bool] = None
    save_as_defaults: bool = False


# ---------------------------------------------------------------------------
# Staged import (preview + commit)
# ---------------------------------------------------------------------------

class ImportPreviewRequest(BaseModel):
    directory: str


class ImportStageItem(BaseModel):
    path: str
    episode_id: Optional[int] = None  # None → create new episode
    skip: bool = False
    title: Optional[str] = None        # override detected title
    date: Optional[str] = None         # override date (YYYY-MM-DD)
    episode_number: Optional[int] = None


class ImportStageRequest(BaseModel):
    items: list[ImportStageItem]
