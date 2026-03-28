"""APScheduler-based background scheduler for feed refreshes."""
import logging
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

log = logging.getLogger(__name__)

_scheduler = BackgroundScheduler(timezone="UTC")


def start_scheduler():
    if not _scheduler.running:
        _scheduler.start()
        log.info("Scheduler started")
        _schedule_all_feeds()


def stop_scheduler():
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
        log.info("Scheduler stopped")


def is_running() -> bool:
    return _scheduler.running


# ---------------------------------------------------------------------------
# Feed job management
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

            # Recalculate sequential episode numbers after every sync so that
            # any auto-downloaded files get the correct number in their filename
            from app.routers.episodes import recalc_seq_numbers
            recalc_seq_numbers(primary_id, db)

            # Auto-download newly discovered episodes, but never on the first sync
            # (which imports all historical episodes at once)
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

    db = SessionLocal()
    try:
        feeds = db.query(Feed).filter(Feed.active == True).all()
        for feed in feeds:
            schedule_feed(feed.id)
        log.info("Scheduled %d feed(s)", len(feeds))
    finally:
        db.close()


def get_next_run(feed_id: int) -> datetime | None:
    job = _scheduler.get_job(_job_id(feed_id))
    if job and job.next_run_time:
        return job.next_run_time
    return None


def get_next_run_any() -> datetime | None:
    """Return the earliest upcoming run time across all scheduled feed jobs."""
    times = [j.next_run_time for j in _scheduler.get_jobs() if j.next_run_time]
    return min(times) if times else None
