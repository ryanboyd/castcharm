"""Write ID3 tags to downloaded audio files using mutagen."""
import io
import logging
import os
import urllib.request
from datetime import datetime
from typing import Any, Optional

from mutagen.id3 import (
    ID3, ID3NoHeaderError,
    APIC, COMM, TALB, TDRC, TCON, TENC, TIT2, TIT3, TPOS, TPUB, TPE1, TRCK,
)
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggvorbis import OggVorbis
from mutagen.flac import FLAC

log = logging.getLogger(__name__)


def read_audio_duration(file_path: str) -> Optional[str]:
    """Return duration as HH:MM:SS string read from the audio file, or None on failure."""
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(file_path)
        if audio is None or not hasattr(audio, "info") or not hasattr(audio.info, "length"):
            return None
        total = int(audio.info.length)
        h = total // 3600
        m = (total % 3600) // 60
        s = total % 60
        return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"
    except Exception as e:
        log.warning("Could not read duration from %s: %s", file_path, e)
        return None


def _resolve_field(source: str, episode_data: dict, feed_data: dict) -> Optional[str]:
    """Resolve a dotted source field name to a value."""
    if source.startswith("episode."):
        key = source[len("episode."):]
        val = episode_data.get(key)
    elif source.startswith("feed."):
        key = source[len("feed."):]
        val = feed_data.get(key)
    else:
        return None

    if val is None:
        return None
    return str(val)


def _fetch_image_bytes(url: str) -> Optional[bytes]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "CastCharm/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read()
    except Exception as e:
        log.warning("Could not fetch cover art from %s: %s", url, e)
        return None


def _guess_image_mime(url: str) -> str:
    url_lower = url.lower()
    if url_lower.endswith(".png"):
        return "image/png"
    if url_lower.endswith(".webp"):
        return "image/webp"
    return "image/jpeg"


def write_id3_tags(
    file_path: str,
    mapping: dict[str, str],
    episode_data: dict,
    feed_data: dict,
) -> None:
    """
    Write ID3 tags to file_path.

    mapping: { "TIT2": "episode.title", "TALB": "feed.title", ... }
    episode_data / feed_data: plain dicts of values for field resolution.
    """
    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".mp3":
        _write_mp3_tags(file_path, mapping, episode_data, feed_data)
    elif ext in (".m4a", ".m4b", ".mp4", ".aac"):
        _write_mp4_tags(file_path, mapping, episode_data, feed_data)
    elif ext == ".ogg":
        _write_ogg_tags(file_path, mapping, episode_data, feed_data)
    elif ext == ".flac":
        _write_flac_tags(file_path, mapping, episode_data, feed_data)



# ---------------------------------------------------------------------------
# MP3
# ---------------------------------------------------------------------------

def _write_mp3_tags(file_path, mapping, episode_data, feed_data):
    try:
        audio = ID3(file_path)
    except ID3NoHeaderError:
        audio = ID3()

    tag_classes = {
        "TIT2": TIT2, "TPE1": TPE1, "TALB": TALB, "TDRC": TDRC,
        "TRCK": TRCK, "TPOS": TPOS, "TCON": TCON, "TIT3": TIT3,
        "TPUB": TPUB, "TENC": TENC,
    }

    for tag, source in mapping.items():
        # Cover art handled separately
        if tag == "APIC":
            img_url = _resolve_image_url(source, episode_data, feed_data)
            if img_url:
                img_bytes = _fetch_image_bytes(img_url)
                if img_bytes:
                    audio["APIC"] = APIC(
                        encoding=3,
                        mime=_guess_image_mime(img_url),
                        type=3,  # front cover
                        desc="Cover",
                        data=img_bytes,
                    )
            continue

        if tag == "COMM":
            val = _resolve_field(source, episode_data, feed_data)
            if val:
                audio["COMM::eng"] = COMM(encoding=3, lang="eng", desc="", text=val)
            continue

        cls = tag_classes.get(tag)
        if cls is None:
            continue

        val = _resolve_field(source, episode_data, feed_data)
        if val:
            audio[tag] = cls(encoding=3, text=val)

    audio.save(file_path, v2_version=3)


# ---------------------------------------------------------------------------
# MP4 / M4A
# ---------------------------------------------------------------------------

_MP4_TAG_MAP = {
    "TIT2": "\xa9nam",   # title
    "TPE1": "\xa9ART",   # artist
    "TALB": "\xa9alb",   # album
    "TDRC": "\xa9day",   # year
    "TRCK": "trkn",
    "TPOS": "disk",
    "TCON": "\xa9gen",   # genre
    "COMM": "\xa9cmt",   # comment
    "TIT3": "desc",
    "TPUB": "cprt",
}


def _write_mp4_tags(file_path, mapping, episode_data, feed_data):
    audio = MP4(file_path)
    tags = audio.tags or {}

    for tag, source in mapping.items():
        if tag == "APIC":
            img_url = _resolve_image_url(source, episode_data, feed_data)
            if img_url:
                img_bytes = _fetch_image_bytes(img_url)
                if img_bytes:
                    fmt = MP4Cover.FORMAT_PNG if "png" in img_url.lower() else MP4Cover.FORMAT_JPEG
                    tags["covr"] = [MP4Cover(img_bytes, imageformat=fmt)]
            continue

        mp4_key = _MP4_TAG_MAP.get(tag)
        if not mp4_key:
            continue

        val = _resolve_field(source, episode_data, feed_data)
        if not val:
            continue

        if tag in ("TRCK", "TPOS"):
            try:
                tags[mp4_key] = [(int(val), 0)]
            except ValueError:
                tags[mp4_key] = [(0, 0)]
        else:
            tags[mp4_key] = [val]

    audio.tags = tags
    audio.save()


# ---------------------------------------------------------------------------
# OGG Vorbis
# ---------------------------------------------------------------------------

_OGG_TAG_MAP = {
    "TIT2": "title",
    "TPE1": "artist",
    "TALB": "album",
    "TDRC": "date",
    "TRCK": "tracknumber",
    "TPOS": "discnumber",
    "TCON": "genre",
    "COMM": "comment",
    "TIT3": "subtitle",
    "TPUB": "organization",
}


def _write_ogg_tags(file_path, mapping, episode_data, feed_data):
    audio = OggVorbis(file_path)
    for tag, source in mapping.items():
        if tag == "APIC":
            continue  # skip cover art for OGG (complex)
        ogg_key = _OGG_TAG_MAP.get(tag)
        if not ogg_key:
            continue
        val = _resolve_field(source, episode_data, feed_data)
        if val:
            audio[ogg_key] = [val]
    audio.save()


# ---------------------------------------------------------------------------
# FLAC
# ---------------------------------------------------------------------------

def _write_flac_tags(file_path, mapping, episode_data, feed_data):
    audio = FLAC(file_path)
    for tag, source in mapping.items():
        if tag == "APIC":
            continue
        ogg_key = _OGG_TAG_MAP.get(tag)
        if not ogg_key:
            continue
        val = _resolve_field(source, episode_data, feed_data)
        if val:
            audio[ogg_key] = [val]
    audio.save()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_image_url(source: str, episode_data: dict, feed_data: dict) -> Optional[str]:
    """For image sources, fall back from episode image to feed image."""
    if source == "episode.image":
        return (
            episode_data.get("image")
            or feed_data.get("image")
        )
    return _resolve_field(source, episode_data, feed_data)


def extract_embedded_cover(file_path: str, dest_path: str) -> bool:
    """Extract embedded cover art from an audio file and write it to dest_path.

    Returns True if art was extracted, False otherwise.
    Does nothing (returns False) if dest_path already exists.
    """
    if os.path.exists(dest_path):
        return False
    ext = os.path.splitext(file_path)[1].lower()
    try:
        if ext == ".mp3":
            try:
                tags = ID3(file_path)
            except ID3NoHeaderError:
                return False
            for key in tags.keys():
                if key.startswith("APIC"):
                    apic = tags[key]
                    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                    with open(dest_path, "wb") as f:
                        f.write(apic.data)
                    return True
        elif ext in (".m4a", ".m4b", ".mp4", ".aac"):
            audio = MP4(file_path)
            covers = (audio.tags or {}).get("covr", [])
            if covers:
                os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                with open(dest_path, "wb") as f:
                    f.write(bytes(covers[0]))
                return True
        elif ext == ".flac":
            audio = FLAC(file_path)
            if audio.pictures:
                os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                with open(dest_path, "wb") as f:
                    f.write(audio.pictures[0].data)
                return True
    except Exception as e:
        log.warning("Could not extract embedded cover from %s: %s", file_path, e)
    return False


def write_id3_tags_direct(file_path: str, tags: dict[str, str]) -> None:
    """Write ID3 tags with explicit string values (not source-field references).

    tags: { "TIT2": "My Episode Title", "TALB": "My Podcast", ... }
    Each value is written verbatim to the corresponding tag.
    """
    # Stuff the values into episode_data with a unique namespace key so the
    # standard resolver can find them via "episode.<namespace>_<TAG>" mapping.
    episode_data: dict[str, str] = {}
    mapping: dict[str, str] = {}
    for tag, value in (tags or {}).items():
        safe_key = f"_d_{tag}"
        episode_data[safe_key] = value
        mapping[tag] = f"episode.{safe_key}"

    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".mp3":
        _write_mp3_tags(file_path, mapping, episode_data, {})
    elif ext in (".m4a", ".m4b", ".mp4", ".aac"):
        _write_mp4_tags(file_path, mapping, episode_data, {})
    elif ext == ".ogg":
        _write_ogg_tags(file_path, mapping, episode_data, {})
    elif ext == ".flac":
        _write_flac_tags(file_path, mapping, episode_data, {})


def build_episode_data(episode) -> dict:
    return {
        "title": episode.title,
        "author": episode.author,
        "description": episode.description,
        "published": episode.published_at.strftime("%Y-%m-%d") if episode.published_at else None,
        "episode_number": str(episode.episode_number) if episode.episode_number else None,
        "season_number": str(episode.season_number) if episode.season_number else None,
        "duration": episode.duration,
        "image": episode.episode_image_url,
    }


def build_feed_data(feed) -> dict:
    return {
        "title": feed.title,
        "author": feed.author,
        "category": feed.category,
        "image": feed.image_url,
    }
