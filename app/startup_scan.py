"""Scan the downloads directory for podcast folders not yet tracked by CastCharm.

Called once at startup (in a background thread) so a freshly deployed container
can rediscover all existing podcast folders automatically.
"""
import logging
import os
import threading
import uuid

from app.database import SessionLocal
from app.folder_meta import read_folder_metadata
from app.importer import AUDIO_EXTENSIONS

log = logging.getLogger(__name__)

_scan_running = False


def is_scanning() -> bool:
    return _scan_running


COMPLETE_FEED_FILENAME = "complete-feed.xml"


def _has_audio(folder: str) -> bool:
    for root, _dirs, files in os.walk(folder):
        if any(os.path.splitext(f)[1].lower() in AUDIO_EXTENSIONS for f in files):
            return True
    return False


def _has_content(folder: str) -> bool:
    """True if the folder has audio files OR a complete-feed.xml to restore from."""
    return _has_audio(folder) or os.path.isfile(os.path.join(folder, COMPLETE_FEED_FILENAME))


def scan_orphan_folders(db) -> int:
    """Create feed entries for downloads subfolders that have no matching feed.

    Returns the number of new feeds created.
    """
    from app.models import Feed, GlobalSettings
    from app.downloader import get_podcast_folder

    gs = db.query(GlobalSettings).first()
    base_dir = (gs.download_path if gs else None) or "/downloads"

    if not os.path.isdir(base_dir):
        log.info("Startup scan: base dir %s not found, skipping", base_dir)
        return 0

    # Collect all known podcast folders
    known_folders: set[str] = set()
    for feed in db.query(Feed).filter(Feed.primary_feed_id.is_(None)).all():
        try:
            known_folders.add(os.path.normpath(get_podcast_folder(feed, db)))
        except Exception:
            pass

    created = 0

    for entry in sorted(os.scandir(base_dir), key=lambda e: e.name):
        if not entry.is_dir():
            continue
        folder = os.path.normpath(entry.path)
        if folder in known_folders:
            continue
        if not _has_content(folder):
            continue

        meta = read_folder_metadata(folder)
        feed_url = meta.get("feed_url") if meta else None
        title = (meta.get("title") if meta else None) or entry.name

        # Skip if a feed with this URL already exists under a different folder name
        if feed_url and db.query(Feed).filter(Feed.url == feed_url).first():
            continue

        from app.models import Feed as FeedModel
        if feed_url:
            new_feed = FeedModel(
                url=feed_url, title=title, active=True,
                initial_sync_complete=False,
            )
        else:
            new_feed = FeedModel(
                url=f"manual:{uuid.uuid4().hex[:16]}",
                title=title, active=False,
                initial_sync_complete=True,
            )

        # Restore per-feed settings from metadata
        if meta:
            for attr in ("organize_by_year", "filename_date_prefix",
                         "filename_episode_number", "save_xml",
                         "check_interval", "auto_download_new"):
                val = meta.get(attr)
                if val is not None:
                    setattr(new_feed, attr, val)

        db.add(new_feed)
        db.commit()
        db.refresh(new_feed)
        created += 1
        log.info("Startup scan: discovered folder '%s' → feed %d", entry.name, new_feed.id)

        local_xml = os.path.join(folder, COMPLETE_FEED_FILENAME)
        local_xml = local_xml if os.path.isfile(local_xml) else None

        if feed_url:
            # RSS feed: sync from live RSS first (episodes land in DB), then
            # backfill any historical episodes from the local archive, then import
            # audio files. _bg_sync handles the file import on initial sync.
            _queue_sync_then_import(new_feed.id, local_xml)
        else:
            # Manual feed: no live RSS. Backfill from complete-feed.xml if present,
            # then import audio files to match against those episodes.
            _queue_local_xml_then_import(new_feed.id, local_xml, folder)

    if created:
        log.info("Startup scan: created %d new feed(s) from existing folders", created)
    return created


def _queue_sync_then_import(feed_id: int, local_xml: str | None = None) -> None:
    """Sync an RSS feed, optionally backfill from a local archive, then import files.

    _bg_sync handles the initial file import after the live sync. If local_xml is
    provided, we also parse it to recover any historical episodes that are no longer
    in the live RSS (e.g. feeds that only publish their last 100 episodes).
    """
    def _run():
        try:
            from app.routers.feeds import _bg_sync
            _bg_sync(feed_id)
        except Exception as exc:
            log.error("Startup sync failed for feed %d: %s", feed_id, exc)

        if local_xml:
            _backfill_from_local_xml(feed_id, local_xml)

    threading.Thread(target=_run, daemon=True, name=f"startup-sync-{feed_id}").start()


def _queue_local_xml_then_import(feed_id: int, local_xml: str | None, folder: str) -> None:
    """For manual feeds: parse complete-feed.xml to populate episodes, then import files."""
    def _run():
        if local_xml:
            _backfill_from_local_xml(feed_id, local_xml)
        # Import audio files — now they can match against episodes from the XML
        idb = SessionLocal()
        try:
            from app.importer import import_directory
            import_directory(feed_id, folder, rename_files=False, db=idb)
        except Exception as exc:
            log.error("Startup import failed for folder %s: %s", folder, exc)
        finally:
            idb.close()

    threading.Thread(target=_run, daemon=True, name=f"startup-import-{feed_id}").start()


def _backfill_from_local_xml(feed_id: int, xml_path: str) -> None:
    """Parse a local complete-feed.xml and upsert any missing episodes into the DB."""
    db = SessionLocal()
    try:
        from app.models import Feed
        from app.rss_parser import sync_feed_episodes
        feed = db.query(Feed).filter(Feed.id == feed_id).first()
        if not feed:
            return
        added, _ = sync_feed_episodes(feed, db, parse_url=xml_path)
        db.commit()
        if added:
            log.info("Backfilled %d episode(s) from %s for feed %d", len(added), xml_path, feed_id)
    except Exception as exc:
        log.error("Backfill from %s failed for feed %d: %s", xml_path, feed_id, exc)
    finally:
        db.close()


def _queue_import(feed_id: int, folder: str) -> None:
    """Run import_directory for *folder* in a daemon thread (manual feeds only)."""
    def _run():
        idb = SessionLocal()
        try:
            from app.importer import import_directory
            import_directory(feed_id, folder, rename_files=False, db=idb)
        except Exception as exc:
            log.error("Startup import failed for folder %s: %s", folder, exc)
        finally:
            idb.close()

    threading.Thread(target=_run, daemon=True, name=f"startup-import-{feed_id}").start()


def run_in_background() -> None:
    """Launch the full scan in a daemon thread. Called from app startup."""
    global _scan_running

    def _run():
        global _scan_running
        _scan_running = True
        db = SessionLocal()
        try:
            scan_orphan_folders(db)
        except Exception as exc:
            log.error("Startup scan failed: %s", exc)
        finally:
            _scan_running = False
            db.close()

    threading.Thread(target=_run, daemon=True, name="startup-scan").start()
