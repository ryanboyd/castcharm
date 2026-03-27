"""Read/write castcharm.json in each podcast folder.

This file persists feed URL and settings alongside the audio files so that
a fresh container can rediscover and restore all podcasts automatically.
"""
import json
import logging
import os
from typing import Optional

log = logging.getLogger(__name__)

METADATA_FILENAME = "castcharm.json"

# Settings keys written to / read from the JSON file
_SETTINGS_KEYS = (
    "organize_by_year",
    "filename_date_prefix",
    "filename_episode_number",
    "save_xml",
    "check_interval",
    "auto_download_new",
)


def write_folder_metadata(feed, folder: str) -> None:
    """Write a castcharm.json into *folder* reflecting the feed's current settings."""
    try:
        os.makedirs(folder, exist_ok=True)
        url = getattr(feed, "url", "") or ""
        meta = {
            "feed_url": None if url.startswith("manual:") else url,
            "title":    getattr(feed, "title", "") or "",
        }
        for key in _SETTINGS_KEYS:
            val = getattr(feed, key, None)
            if val is not None:
                meta[key] = val
        path = os.path.join(folder, METADATA_FILENAME)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)
    except Exception as exc:
        log.warning("Could not write folder metadata to %s: %s", folder, exc)


def read_folder_metadata(folder: str) -> Optional[dict]:
    """Return the parsed castcharm.json from *folder*, or None if absent/invalid."""
    path = os.path.join(folder, METADATA_FILENAME)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        log.warning("Could not read folder metadata from %s: %s", path, exc)
        return None
