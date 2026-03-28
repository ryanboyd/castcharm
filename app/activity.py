"""Lightweight in-process counters for currently-running background operations.

These are reset on restart; they exist only to inform the status API.
"""
import threading

_lock = threading.Lock()
_active_syncs: set[int] = set()
_pending_syncs: set[int] = set()  # queued but not yet started


def mark_sync_queued(feed_id: int) -> None:
    with _lock:
        _pending_syncs.add(feed_id)


def mark_syncing(feed_id: int) -> None:
    with _lock:
        _pending_syncs.discard(feed_id)
        _active_syncs.add(feed_id)


def mark_sync_done(feed_id: int) -> None:
    with _lock:
        _active_syncs.discard(feed_id)
        _pending_syncs.discard(feed_id)


def get_syncing_count() -> int:
    with _lock:
        return len(_active_syncs) + len(_pending_syncs)


def get_syncing_feed_ids() -> list[int]:
    with _lock:
        return list(_active_syncs | _pending_syncs)
