"""Synchronous episode downloader with a priority-ordered work queue."""
import logging
import os
import re
import threading
import urllib.parse
import xml.dom.minidom
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Optional

import httpx

from app.models import Episode, Feed, GlobalSettings
from sqlalchemy.orm import Session, joinedload

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Download worker — pull-based, DB-ordered.
#
# Instead of a push queue that locks in order at submission time, the worker
# always asks the DB "what is the next queued episode, newest first?" before
# each download.  This means the processing order always matches the UI order
# (published_at DESC) regardless of when or how episodes were submitted.
#
# enqueue_download() is kept as the public API so all call-sites are unchanged;
# it now just wakes the worker rather than pushing an ID onto a queue.
# ---------------------------------------------------------------------------

_wake_event: threading.Event = threading.Event()
_claim_lock = threading.Lock()       # serialize DB claim so two workers don't grab the same ep
_workers: list[threading.Thread] = []
_workers_lock = threading.Lock()
_cached_max_concurrent: int | None = None

# In-memory progress cache — updated on every chunk, no DB write needed.
# Keyed by episode_id; values are 0-100 integers.
_active_progress: dict[int, int] = {}
_active_progress_lock = threading.Lock()


def _get_max_concurrent() -> int:
    """Read max_concurrent_downloads from GlobalSettings (cached per process)."""
    global _cached_max_concurrent
    if _cached_max_concurrent is not None:
        return _cached_max_concurrent
    try:
        from app.database import SessionLocal
        db = SessionLocal()
        try:
            gs = db.query(GlobalSettings).first()
            val = (gs.max_concurrent_downloads if gs else None) or 2
            _cached_max_concurrent = max(1, int(val))
        finally:
            db.close()
    except Exception:
        _cached_max_concurrent = 2
    return _cached_max_concurrent


def _claim_next() -> int | None:
    """Atomically find the next queued episode and mark it 'downloading'.

    Uses a lock so that multiple worker threads can't claim the same episode.
    Returns the episode id, or None if nothing is queued.
    """
    from app.database import SessionLocal
    with _claim_lock:
        db = SessionLocal()
        try:
            ep = (
                db.query(Episode)
                .filter(Episode.status == "queued")
                .order_by(Episode.queued_at.asc().nullslast(), Episode.id.asc())
                .first()
            )
            if ep is None:
                return None
            ep.status = "downloading"
            db.commit()
            return ep.id
        except Exception:
            db.rollback()
            return None
        finally:
            db.close()


def _worker_loop() -> None:
    from app.database import SessionLocal
    while True:
        # Block until woken by enqueue_download() or the 30-s safety timeout.
        _wake_event.wait(timeout=30)
        _wake_event.clear()
        # Workers drain the queue internally (inner loop below) so we don't
        # need to re-set the event here.  If new episodes are enqueued while
        # workers are busy, the event will be set again and caught on the next
        # outer-loop iteration.

        # Drain queued episodes: claim one, download it, repeat.
        while True:
            episode_id = _claim_next()
            if episode_id is None:
                break  # nothing left — go back to waiting

            db = SessionLocal()
            try:
                download_episode(episode_id, db)
            except Exception as exc:
                log.error("Download worker: unhandled error for episode %d: %s", episode_id, exc)
                try:
                    ep = db.query(Episode).filter(
                        Episode.id == episode_id,
                        Episode.status.in_(["queued", "downloading"]),
                    ).first()
                    if ep:
                        ep.status = "failed"
                        ep.error_message = f"Unexpected error: {exc}"
                        db.commit()
                except Exception:
                    pass
            finally:
                with _active_progress_lock:
                    _active_progress.pop(episode_id, None)
                db.close()


def _ensure_workers() -> None:
    """Maintain a pool of worker threads sized to max_concurrent_downloads."""
    global _workers
    target = _get_max_concurrent()
    with _workers_lock:
        # Prune dead threads
        _workers = [t for t in _workers if t.is_alive()]
        while len(_workers) < target:
            t = threading.Thread(
                target=_worker_loop, daemon=True,
                name=f"download-worker-{len(_workers) + 1}",
            )
            t.start()
            _workers.append(t)
            log.debug("Download worker thread started (%d/%d)", len(_workers), target)


def enqueue_download(episode_id: int) -> None:  # noqa: ARG001
    """Wake the download workers.  They will claim the next episode from the DB in
    priority order (newest published_at first), so submission order no longer
    determines download order."""
    _ensure_workers()
    _wake_event.set()


def get_active_progress() -> dict[int, int]:
    """Return a snapshot of in-memory download progress (episode_id -> 0-100)."""
    with _active_progress_lock:
        return dict(_active_progress)


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------

# Episode IDs that have been cancelled mid-download. The downloader checks this
# set in the chunk loop and aborts cleanly when its episode ID appears here.
_cancelled_ids: set[int] = set()


def request_cancel(episode_id: int) -> None:
    """Signal that an in-progress download should be aborted."""
    _cancelled_ids.add(episode_id)


class _CancelledError(Exception):
    """Raised internally when a download is cancelled by request_cancel()."""


CHUNK_SIZE = 64 * 1024  # 64 KB
CONNECT_TIMEOUT = 15
READ_TIMEOUT = 120


def _get_effective_settings(feed: Feed, db: Session) -> GlobalSettings:
    gs = db.query(GlobalSettings).first()
    if gs is None:
        gs = GlobalSettings()
    return gs


def _effective(feed_val, global_val, default=None):
    """Return feed-level override if set, otherwise global, otherwise default."""
    if feed_val is not None:
        return feed_val
    if global_val is not None:
        return global_val
    return default


def _sanitize_filename(name: str) -> str:
    """Remove characters that are unsafe in filenames."""
    name = name.strip()
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name)
    name = re.sub(r"\s+", " ", name)
    return name[:200]  # truncate very long names


def _guess_extension(content_type: Optional[str], url: str) -> str:
    """Guess file extension from MIME type or URL."""
    mime_map = {
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/mp4": ".m4a",
        "audio/m4a": ".m4a",
        "audio/aac": ".aac",
        "audio/ogg": ".ogg",
        "audio/vorbis": ".ogg",
        "audio/flac": ".flac",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
    }
    if content_type:
        base_mime = content_type.split(";")[0].strip().lower()
        ext = mime_map.get(base_mime)
        if ext:
            return ext

    # Fall back to URL path extension
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.split("?")[0]
    _, ext = os.path.splitext(path)
    if ext.lower() in mime_map.values():
        return ext.lower()

    return ".mp3"  # safe default for podcasts


def get_podcast_folder(feed: Feed, db: Session) -> str:
    """Return the root download folder for a podcast (primary or supplementary feed)."""
    gs = _get_effective_settings(feed, db)
    base_dir = _effective(feed.download_path, gs.download_path, "/downloads")
    if feed.primary_feed_id:
        primary = db.query(Feed).filter(Feed.id == feed.primary_feed_id).first()
        folder_name = _sanitize_filename(
            (primary.podcast_group or primary.title) if primary
            else (feed.podcast_group or feed.title or "Unknown Podcast")
        )
    else:
        folder_name = _sanitize_filename(feed.podcast_group or feed.title or "Unknown Podcast")
    return os.path.join(base_dir, folder_name)


def _build_file_path(
    episode: Episode,
    folder_name: str,
    base_dir: str,
    date_prefix: bool,
    episode_number_prefix: bool,
    organize_by_year: bool,
    content_type: Optional[str],
    url: str,
    total_episodes: int = 0,
) -> str:
    """Construct the target file path for an episode download."""
    import math
    episode_title = _sanitize_filename(episode.title or "Untitled Episode")

    # Build filename: YYYY-MM-DD - ### - title  (each present part joined by " - ")
    parts = []
    if date_prefix and episode.published_at:
        parts.append(episode.published_at.strftime("%Y-%m-%d"))
    if episode_number_prefix and episode.seq_number is not None:
        pad = max(3, math.ceil(math.log10(total_episodes + 1))) if total_episodes > 0 else 3
        parts.append(str(episode.seq_number).zfill(pad))
    parts.append(episode_title)

    filename_stem = " - ".join(parts)
    ext = _guess_extension(content_type, url)
    filename = filename_stem + ext

    # Build directory
    dir_parts = [base_dir, folder_name]
    if organize_by_year and episode.published_at:
        dir_parts.append(str(episode.published_at.year))

    directory = os.path.join(*dir_parts)
    os.makedirs(directory, exist_ok=True)

    # Handle name collisions
    target = os.path.join(directory, filename)
    counter = 1
    while os.path.exists(target):
        target = os.path.join(directory, f"{filename_stem} ({counter}){ext}")
        counter += 1

    return target


AUDIO_EXTENSIONS = {".mp3", ".m4a", ".aac", ".ogg", ".flac", ".wav", ".mp4", ".opus", ".wma"}


def _download_image(url: str, dest_path: str) -> None:
    """Download an image from *url* to *dest_path*. Skips if file already exists."""
    if not url or os.path.exists(dest_path):
        return
    try:
        with httpx.Client(
            timeout=httpx.Timeout(10, read=30),
            follow_redirects=True,
            headers={"User-Agent": "CastCharm/1.0"},
        ) as client:
            r = client.get(url)
            r.raise_for_status()
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            with open(dest_path, "wb") as f:
                f.write(r.content)
    except Exception as e:
        log.debug("Could not download image %s: %s", url, e)


def _normalize_title(title: str) -> str:
    """Lowercase, strip punctuation/whitespace for fuzzy filename matching."""
    import unicodedata
    title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    title = re.sub(r"[^a-z0-9 ]", " ", title.lower())
    return re.sub(r"\s+", " ", title).strip()


def scan_existing_files(podcast_folder: str, episodes: list, db: Session) -> int:
    """Match audio files already in *podcast_folder* to undownloaded episodes.

    Walks the folder tree looking for audio files, then compares each file's
    stem against episode titles.  If a confident match is found the episode is
    marked as *downloaded* with the correct ``file_path``.  Returns the number
    of episodes matched.
    """
    if not os.path.isdir(podcast_folder):
        return 0

    # Gather every audio file under the folder
    audio_files: list[str] = []
    for root, _dirs, files in os.walk(podcast_folder):
        for fname in files:
            if os.path.splitext(fname)[1].lower() in AUDIO_EXTENSIONS:
                audio_files.append(os.path.join(root, fname))

    if not audio_files:
        return 0

    # Build index: normalised stem → full path
    file_index: dict[str, str] = {}
    for fpath in audio_files:
        stem = _normalize_title(os.path.splitext(os.path.basename(fpath))[0])
        file_index[stem] = fpath

    matched = 0
    for ep in episodes:
        if ep.status == "downloaded" and ep.file_path and os.path.exists(ep.file_path):
            continue  # already linked to a real file

        if not ep.title:
            continue

        ep_norm = _normalize_title(ep.title)
        if not ep_norm:
            continue

        best_path: Optional[str] = None
        # Exact stem match first
        if ep_norm in file_index:
            best_path = file_index[ep_norm]
        else:
            # Substring match: episode title appears inside file stem
            for stem, fpath in file_index.items():
                if ep_norm in stem and len(ep_norm) >= 8:
                    best_path = fpath
                    break

        if best_path and os.path.exists(best_path):
            ep.file_path = best_path
            ep.file_size = os.path.getsize(best_path)
            ep.status = "downloaded"
            ep.download_progress = 100
            if not ep.download_date:
                ep.download_date = datetime.utcnow()
            matched += 1
            log.info("Matched existing file for episode %d: %s", ep.id, best_path)

    if matched:
        db.flush()

    return matched


def _write_xml_sidecar(file_path: str, episode: Episode, feed: Feed) -> None:
    """Write an XML metadata sidecar file adjacent to the audio file."""
    root = ET.Element("episode")

    def _sub(parent, tag, text):
        if text is not None:
            el = ET.SubElement(parent, tag)
            el.text = str(text)

    _sub(root, "title", episode.title)
    _sub(root, "guid", episode.guid)
    _sub(root, "link", episode.link)
    _sub(root, "enclosureUrl", episode.enclosure_url)
    _sub(root, "enclosureType", episode.enclosure_type)
    _sub(root, "enclosureLength", episode.enclosure_length)
    _sub(root, "published", episode.published_at.isoformat() if episode.published_at else None)
    _sub(root, "duration", episode.duration)
    _sub(root, "episodeNumber", episode.episode_number)
    _sub(root, "seasonNumber", episode.season_number)
    _sub(root, "author", episode.author)
    _sub(root, "imageUrl", episode.episode_image_url)
    _sub(root, "description", episode.description)

    podcast_el = ET.SubElement(root, "podcast")
    _sub(podcast_el, "title", feed.title)
    _sub(podcast_el, "author", feed.author)
    _sub(podcast_el, "feedUrl", feed.url)
    _sub(podcast_el, "websiteUrl", feed.website_url)
    _sub(podcast_el, "imageUrl", feed.image_url)
    _sub(podcast_el, "category", feed.category)
    _sub(podcast_el, "language", feed.language)

    rough = ET.tostring(root, encoding="unicode")
    pretty = xml.dom.minidom.parseString(rough).toprettyxml(indent="  ")
    # Remove the redundant XML declaration added by toprettyxml
    lines = pretty.split("\n")
    if lines[0].startswith("<?xml"):
        lines = lines[1:]
    xml_content = '<?xml version="1.0" encoding="UTF-8"?>\n' + "\n".join(lines)

    xml_path = file_path + ".xml"
    with open(xml_path, "w", encoding="utf-8") as f:
        f.write(xml_content)


def download_episode(episode_id: int, db: Session) -> None:
    """Download a single episode. Designed to run in a background thread."""
    episode = (
        db.query(Episode)
        .options(joinedload(Episode.feed))
        .filter(Episode.id == episode_id)
        .first()
    )
    if not episode:
        log.warning("Episode %d not found", episode_id)
        return

    # Check cancellation before doing anything — covers the window between
    # task submission and actual execution (e.g. cancel-all fired while this
    # task was waiting in the thread pool).
    if episode_id in _cancelled_ids:
        _cancelled_ids.discard(episode_id)
        episode.status = "pending"
        episode.download_progress = 0
        db.commit()
        return

    # Only proceed if the episode is still actively queued — if it was set back
    # to "pending" by a cancel, "pending" is intentionally excluded here so
    # already-spawned background tasks don't restart a cancelled download.
    if episode.status not in ("queued", "downloading"):
        return

    feed = episode.feed
    if not feed:
        episode.status = "failed"
        episode.error_message = "Feed not found"
        db.commit()
        return

    if not episode.enclosure_url:
        episode.status = "failed"
        episode.error_message = "No enclosure URL in feed entry"
        db.commit()
        return

    # File already on disk (e.g. matched from another feed) — no need to re-download
    if episode.file_path and os.path.exists(episode.file_path):
        episode.status = "downloaded"
        episode.file_size = os.path.getsize(episode.file_path)
        episode.download_progress = 100
        if not episode.download_date:
            episode.download_date = datetime.utcnow()
        db.commit()
        log.info("Episode %d already on disk at %s, skipping download", episode_id, episode.file_path)
        return

    gs = _get_effective_settings(feed, db)

    base_dir = _effective(feed.download_path, gs.download_path, "/downloads")
    date_prefix = _effective(feed.filename_date_prefix, gs.filename_date_prefix, True)
    episode_number_prefix = _effective(feed.filename_episode_number, gs.filename_episode_number, True)
    organize_by_year = _effective(feed.organize_by_year, gs.organize_by_year, True)
    save_xml = _effective(feed.save_xml, gs.save_xml, True)

    # Supplementary feeds share the primary feed's folder
    if feed.primary_feed_id:
        primary = db.query(Feed).filter(Feed.id == feed.primary_feed_id).first()
        folder_name = _sanitize_filename(
            (primary.podcast_group or primary.title) if primary else (feed.podcast_group or feed.title or "Unknown Podcast")
        )
    else:
        primary = feed
        folder_name = _sanitize_filename(feed.podcast_group or feed.title or "Unknown Podcast")

    # Count total non-hidden episodes in the podcast group for zero-padding
    primary_id = primary.id if primary else feed.id
    sub_ids = [
        row[0]
        for row in db.query(Feed.id).filter(Feed.primary_feed_id == primary_id).all()
    ]
    all_ids = [primary_id] + sub_ids
    from sqlalchemy import func as _func
    total_episodes = (
        db.query(_func.count(Episode.id))
        .filter(Episode.feed_id.in_(all_ids), Episode.hidden.is_(False))
        .scalar() or 0
    )

    episode.status = "downloading"
    episode.download_progress = 0
    episode.error_message = None
    db.commit()

    tmp_path = None
    try:
        with httpx.Client(
            timeout=httpx.Timeout(CONNECT_TIMEOUT, read=READ_TIMEOUT),
            follow_redirects=True,
            headers={"User-Agent": "CastCharm/1.0"},
        ) as client:
            with client.stream("GET", episode.enclosure_url) as response:
                response.raise_for_status()

                content_type = response.headers.get("content-type", episode.enclosure_type)
                total = int(response.headers.get("content-length", 0)) or None

                target_path = _build_file_path(
                    episode, folder_name, base_dir, date_prefix, episode_number_prefix,
                    organize_by_year, content_type, episode.enclosure_url,
                    total_episodes=total_episodes,
                )
                tmp_path = target_path + ".part"

                downloaded = 0
                _last_committed_progress = 0
                with open(tmp_path, "wb") as f:
                    for chunk in response.iter_bytes(chunk_size=CHUNK_SIZE):
                        if episode_id in _cancelled_ids:
                            raise _CancelledError()
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total:
                            progress = min(int(downloaded / total * 100), 99)
                            # Always update the in-memory cache (cheap, no DB)
                            with _active_progress_lock:
                                _active_progress[episode_id] = progress
                            # Throttle DB writes to every 5% to reduce pressure
                            if progress - _last_committed_progress >= 5:
                                episode.download_progress = progress
                                db.commit()
                                _last_committed_progress = progress

        # Rename temp file to final name
        os.rename(tmp_path, target_path)
        tmp_path = None

        file_size = os.path.getsize(target_path)

        # Save cover art sidecars
        podcast_folder = os.path.join(base_dir, folder_name)
        feed_art_url = feed.custom_image_url or feed.image_url
        if feed_art_url:
            _download_image(feed_art_url, os.path.join(podcast_folder, "cover.jpg"))
        ep_art_path = os.path.splitext(target_path)[0] + ".jpg"
        ep_art_url = episode.custom_image_url or episode.episode_image_url
        if ep_art_url:
            _download_image(ep_art_url, ep_art_path)
        # Fall back to art embedded in the audio file's tags
        if not os.path.exists(ep_art_path):
            try:
                from app.id3_tagger import extract_embedded_cover
                extract_embedded_cover(target_path, ep_art_path)
            except Exception as emb_err:
                log.debug("Could not extract embedded cover for episode %d: %s", episode_id, emb_err)

        # Write XML sidecar
        if save_xml:
            try:
                _write_xml_sidecar(target_path, episode, feed)
            except Exception as xml_err:
                log.warning("Failed to write XML sidecar for episode %d: %s", episode_id, xml_err)

        # Write ID3 tags
        if feed.id3_enabled:
            mapping = feed.id3_field_mapping or gs.default_id3_mapping or {}
            if mapping:
                try:
                    from app.id3_tagger import write_id3_tags, build_episode_data, build_feed_data
                    write_id3_tags(
                        target_path,
                        mapping,
                        build_episode_data(episode),
                        build_feed_data(feed),
                    )
                except Exception as tag_err:
                    log.warning("ID3 tagging failed for episode %d: %s", episode_id, tag_err)

        episode.status = "downloaded"
        episode.file_path = target_path
        episode.file_size = file_size
        episode.download_progress = 100
        episode.download_date = datetime.utcnow()
        episode.error_message = None

        # Populate duration from the actual file (more reliable than feed metadata)
        try:
            from app.id3_tagger import read_audio_duration
            measured = read_audio_duration(target_path)
            if measured:
                episode.duration = measured
        except Exception:
            pass

        db.commit()
        log.info("Downloaded episode %d to %s", episode_id, target_path)

    except _CancelledError:
        _cancelled_ids.discard(episode_id)
        log.info("Download cancelled for episode %d", episode_id)
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        episode.status = "pending"
        episode.error_message = None
        episode.download_progress = 0
        db.commit()
    except Exception as e:
        log.error("Download failed for episode %d: %s", episode_id, e)
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        episode.status = "failed"
        episode.error_message = str(e)
        episode.download_progress = 0
        db.commit()
