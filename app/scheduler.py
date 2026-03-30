"""APScheduler-based background scheduler for feed refreshes and maintenance jobs."""
import logging
import os
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.cron import CronTrigger

log = logging.getLogger(__name__)

_scheduler = BackgroundScheduler(timezone="UTC")


def start_scheduler():
    if not _scheduler.running:
        _scheduler.start()
        log.info("Scheduler started")
        _schedule_all_feeds()
        schedule_xml_regen()
        schedule_opml_export()
        schedule_daily_sync()  # may remove per-feed jobs if daily mode is active
        schedule_autoclean()


def stop_scheduler():
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
        log.info("Scheduler stopped")


def is_running() -> bool:
    return _scheduler.running


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_time(hhmm: str) -> tuple[int, int]:
    """Parse 'HH:MM' string to (hour, minute)."""
    parts = str(hhmm).split(":")
    return int(parts[0]), int(parts[1])


def _read_settings():
    """Read GlobalSettings row (helper for scheduler jobs)."""
    from app.database import SessionLocal
    from app.models import GlobalSettings
    db = SessionLocal()
    try:
        return db.query(GlobalSettings).first()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Feed sync jobs
# ---------------------------------------------------------------------------

def _job_id(feed_id: int) -> str:
    return f"feed_{feed_id}"


def _refresh_feed_job(feed_id: int):
    """Called by APScheduler — must not block."""
    from app.database import SessionLocal
    from app.models import Feed, Episode, GlobalSettings
    from app.rss_parser import sync_feed_episodes

    db = SessionLocal()
    try:
        feed = db.query(Feed).filter(Feed.id == feed_id, Feed.active == True).first()
        if not feed:
            return

        was_complete = feed.initial_sync_complete
        primary_id = feed.primary_feed_id or feed.id
        try:
            new_ids, _skipped = sync_feed_episodes(feed, db)
            feed.last_error = None

            from app.routers.episodes import recalc_seq_numbers
            recalc_seq_numbers(primary_id, db)

            # Auto-download newly discovered episodes (skip on initial sync)
            if was_complete and new_ids:
                auto_dl = feed.auto_download_new
                if auto_dl is None:
                    gs = db.query(GlobalSettings).first()
                    auto_dl = gs.auto_download_new if gs else True

                if auto_dl:
                    from app.downloader import enqueue_download
                    now = datetime.utcnow()
                    for ep_id in new_ids:
                        ep = db.query(Episode).filter(Episode.id == ep_id).first()
                        if ep and ep.status == "pending":
                            ep.status = "queued"
                            ep.queued_at = now
                    db.commit()
                    for ep_id in new_ids:
                        enqueue_download(ep_id)

        except Exception as e:
            log.warning("Feed %d refresh failed: %s", feed_id, e)
            feed.last_error = str(e)

        feed.initial_sync_complete = True
        feed.last_checked = datetime.utcnow()
        db.commit()
        # Auto-write complete-feed.xml into the podcast folder
        try:
            from app.rss_generator import write_feed_xml
            from app.downloader import get_podcast_folder
            primary_feed = db.query(Feed).filter(Feed.id == primary_id).first()
            if primary_feed:
                folder = get_podcast_folder(primary_feed, db)
                write_feed_xml(primary_id, db, folder)
        except Exception:
            pass  # complete-feed.xml generation is best-effort
    finally:
        db.close()


def _get_interval_minutes(feed_id: int) -> int:
    """Resolve effective check interval for a feed (feed override or global)."""
    from app.database import SessionLocal
    from app.models import Feed, GlobalSettings

    db = SessionLocal()
    try:
        feed = db.query(Feed).filter(Feed.id == feed_id).first()
        if not feed:
            return 60
        if feed.check_interval is not None:
            return max(1, feed.check_interval)
        gs = db.query(GlobalSettings).first()
        if gs and gs.check_interval:
            return max(1, gs.check_interval)
        return 60
    finally:
        db.close()


def schedule_feed(feed_id: int):
    """Add or replace the APScheduler job for a feed."""
    gs = _read_settings()
    if gs and gs.scheduled_sync_enabled:
        return  # daily sync mode replaces per-feed interval jobs

    interval_minutes = _get_interval_minutes(feed_id)
    job_id = _job_id(feed_id)

    if _scheduler.get_job(job_id):
        _scheduler.remove_job(job_id)

    _scheduler.add_job(
        _refresh_feed_job,
        trigger=IntervalTrigger(minutes=interval_minutes),
        id=job_id,
        args=[feed_id],
        replace_existing=True,
        misfire_grace_time=300,
    )


def reschedule_feed(feed_id: int):
    """Re-read the interval and reschedule."""
    schedule_feed(feed_id)


def remove_feed_job(feed_id: int):
    job_id = _job_id(feed_id)
    if _scheduler.get_job(job_id):
        _scheduler.remove_job(job_id)


def _schedule_all_feeds():
    """Called at startup to schedule all active feeds."""
    from app.database import SessionLocal
    from app.models import Feed

    gs = _read_settings()
    if gs and gs.scheduled_sync_enabled:
        return  # daily sync mode — don't create per-feed interval jobs

    db = SessionLocal()
    try:
        feeds = db.query(Feed).filter(Feed.active == True).all()
        for feed in feeds:
            schedule_feed(feed.id)
        log.info("Scheduled %d feed(s)", len(feeds))
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Scheduled daily sync
# ---------------------------------------------------------------------------

def _daily_sync_all():
    """Run _refresh_feed_job for every active feed (daily-sync mode)."""
    from app.database import SessionLocal
    from app.models import Feed

    db = SessionLocal()
    try:
        feed_ids = [f.id for f in db.query(Feed).filter(Feed.active == True).all()]
    finally:
        db.close()

    log.info("Daily scheduled sync starting for %d feed(s)", len(feed_ids))
    for fid in feed_ids:
        try:
            _refresh_feed_job(fid)
        except Exception as e:
            log.warning("Daily sync failed for feed %d: %s", fid, e)


def schedule_daily_sync():
    """Create/update the daily sync cron job. When enabled, removes per-feed interval jobs."""
    if _scheduler.get_job("scheduled_daily_sync"):
        _scheduler.remove_job("scheduled_daily_sync")

    gs = _read_settings()
    if not gs:
        return

    if gs.scheduled_sync_enabled:
        # Remove all per-feed interval jobs
        for job in _scheduler.get_jobs():
            if job.id.startswith("feed_"):
                _scheduler.remove_job(job.id)
        hour, minute = _parse_time(gs.scheduled_sync_time or "03:00")
        tz = gs.timezone or "UTC"
        _scheduler.add_job(
            _daily_sync_all,
            CronTrigger(hour=hour, minute=minute, timezone=tz),
            id="scheduled_daily_sync",
            replace_existing=True,
            misfire_grace_time=3600,
        )
        log.info("Daily sync scheduled at %02d:%02d (%s)", hour, minute, tz)
    else:
        # Re-enable per-feed interval jobs
        _schedule_all_feeds()


# ---------------------------------------------------------------------------
# Scheduled XML regeneration
# ---------------------------------------------------------------------------

def _regenerate_all_xml():
    """Rebuild complete-feed.xml for every primary feed."""
    from app.database import SessionLocal
    from app.models import Feed
    from app.rss_generator import write_feed_xml
    from app.downloader import get_podcast_folder
    from app.activity import mark_xml_regen_start, mark_xml_regen_done

    mark_xml_regen_start()
    db = SessionLocal()
    try:
        feeds = db.query(Feed).filter(
            Feed.primary_feed_id.is_(None), Feed.active.is_(True)
        ).all()
        count = 0
        for feed in feeds:
            try:
                folder = get_podcast_folder(feed, db)
                write_feed_xml(feed.id, db, folder)
                count += 1
            except Exception as e:
                log.warning("Scheduled XML regen failed for feed %d: %s", feed.id, e)
        log.info("Scheduled XML regeneration complete (%d/%d feeds)", count, len(feeds))
    finally:
        db.close()
        mark_xml_regen_done()


def schedule_xml_regen():
    """Create/update the daily XML regen cron job."""
    if _scheduler.get_job("scheduled_xml"):
        _scheduler.remove_job("scheduled_xml")

    gs = _read_settings()
    if not gs or not gs.scheduled_xml_enabled:
        return

    hour, minute = _parse_time(gs.scheduled_xml_time or "00:00")
    tz = gs.timezone or "UTC"
    _scheduler.add_job(
        _regenerate_all_xml,
        CronTrigger(hour=hour, minute=minute, timezone=tz),
        id="scheduled_xml",
        replace_existing=True,
        misfire_grace_time=3600,
    )
    log.info("Scheduled XML regen at %02d:%02d (%s)", hour, minute, tz)


# ---------------------------------------------------------------------------
# Scheduled OPML export
# ---------------------------------------------------------------------------

def _export_opml_to_disk():
    """Write castcharm-export.opml to the root download folder."""
    from app.database import SessionLocal
    from app.models import Feed, GlobalSettings
    from app.activity import mark_opml_start, mark_opml_done

    mark_opml_start()
    db = SessionLocal()
    try:
        gs = db.query(GlobalSettings).first()
        download_path = (gs.download_path if gs else None) or "/downloads"

        feeds = db.query(Feed).filter(
            Feed.primary_feed_id.is_(None), Feed.active.is_(True)
        ).order_by(Feed.title).all()

        lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<opml version="2.0">',
            '  <head>',
            '    <title>CastCharm Export</title>',
            '  </head>',
            '  <body>',
        ]
        for f in feeds:
            title = (f.title or f.url).replace('"', "&quot;")
            url = f.url.replace('"', "&quot;")
            lines.append(
                f'    <outline type="rss" text="{title}" title="{title}" xmlUrl="{url}"/>'
            )
        lines += ['  </body>', '</opml>']

        os.makedirs(download_path, exist_ok=True)
        opml_path = os.path.join(download_path, "castcharm-export.opml")
        with open(opml_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines))
        log.info("Scheduled OPML export written to %s (%d feeds)", opml_path, len(feeds))
    finally:
        db.close()
        mark_opml_done()


def schedule_opml_export():
    """Create/update the daily OPML export cron job."""
    if _scheduler.get_job("scheduled_opml"):
        _scheduler.remove_job("scheduled_opml")

    gs = _read_settings()
    if not gs or not gs.scheduled_opml_enabled:
        return

    hour, minute = _parse_time(gs.scheduled_opml_time or "00:00")
    tz = gs.timezone or "UTC"
    _scheduler.add_job(
        _export_opml_to_disk,
        CronTrigger(hour=hour, minute=minute, timezone=tz),
        id="scheduled_opml",
        replace_existing=True,
        misfire_grace_time=3600,
    )
    log.info("Scheduled OPML export at %02d:%02d (%s)", hour, minute, tz)


# ---------------------------------------------------------------------------
# Scheduled auto-cleanup
# ---------------------------------------------------------------------------

def _run_scheduled_autoclean():
    """Run keep_latest cleanup across all active feeds on schedule."""
    from app.database import SessionLocal
    from app.cleanup import run_autoclean_all_feeds
    from app.activity import mark_autoclean_start, mark_autoclean_done

    mark_autoclean_start()
    db = SessionLocal()
    try:
        run_autoclean_all_feeds(db)
    finally:
        db.close()
        mark_autoclean_done()


def schedule_autoclean():
    """Create/update the daily auto-cleanup cron job."""
    if _scheduler.get_job("scheduled_autoclean"):
        _scheduler.remove_job("scheduled_autoclean")

    gs = _read_settings()
    if not gs or not gs.autoclean_enabled:
        return  # autoclean disabled
    mode = gs.autoclean_mode or "unplayed"
    if mode != "unplayed" and not gs.keep_latest:
        return  # "recent" mode requires a keep_latest count

    hour, minute = _parse_time(gs.autoclean_time or "02:00")
    tz = gs.timezone or "UTC"
    _scheduler.add_job(
        _run_scheduled_autoclean,
        CronTrigger(hour=hour, minute=minute, timezone=tz),
        id="scheduled_autoclean",
        replace_existing=True,
        misfire_grace_time=3600,
    )
    log.info("Auto-cleanup scheduled at %02d:%02d (%s)", hour, minute, tz)


# ---------------------------------------------------------------------------
# Status helpers
# ---------------------------------------------------------------------------

def get_next_run(feed_id: int) -> datetime | None:
    job = _scheduler.get_job(_job_id(feed_id))
    if job and job.next_run_time:
        return job.next_run_time
    return None


def get_next_run_any() -> datetime | None:
    """Return the earliest upcoming sync run time, excluding maintenance-only jobs."""
    maintenance_ids = {"scheduled_xml", "scheduled_opml", "scheduled_autoclean"}
    times = [
        j.next_run_time for j in _scheduler.get_jobs()
        if j.next_run_time and j.id not in maintenance_ids
    ]
    return min(times) if times else None


def get_download_window_status() -> tuple[bool, datetime | None]:
    """Return (paused, next_open_at).

    paused=True means the window is enabled and we're currently outside it.
    next_open_at is the next datetime when the window opens (in UTC), or None.
    """
    try:
        from zoneinfo import ZoneInfo
        gs = _read_settings()
        if not gs or not gs.download_window_enabled:
            return False, None

        tz = ZoneInfo(gs.timezone or "UTC")
        now = datetime.now(tz)
        current = now.hour * 60 + now.minute

        sh, sm = (int(x) for x in (gs.download_window_start or "21:00").split(":"))
        eh, em = (int(x) for x in (gs.download_window_end or "06:00").split(":"))
        start = sh * 60 + sm
        end = eh * 60 + em

        if start == end:
            return False, None

        in_window = (current >= start or current < end) if start > end else (start <= current < end)
        if in_window:
            return False, None

        # Compute next opening time
        from datetime import timedelta
        next_open = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
        if next_open <= now:
            next_open += timedelta(days=1)
        return True, next_open.astimezone(ZoneInfo("UTC"))
    except Exception:
        return False, None


def get_syncing_count() -> int:
    """Return number of currently running feed sync jobs (from activity tracker)."""
    from app.activity import get_syncing_count as _get
    return _get()
