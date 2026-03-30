"""Lightweight in-process counters for currently-running background operations.

These are reset on restart; they exist only to inform the status API.
"""
import threading

_lock = threading.Lock()
_active_syncs: set[int] = set()
_pending_syncs: set[int] = set()  # queued but not yet started
_xml_regenerating: bool = False
_opml_generating: bool = False
_autoclean_running: bool = False


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


def mark_xml_regen_start() -> None:
    global _xml_regenerating
    with _lock:
        _xml_regenerating = True


def mark_xml_regen_done() -> None:
    global _xml_regenerating
    with _lock:
        _xml_regenerating = False


def mark_opml_start() -> None:
    global _opml_generating
    with _lock:
        _opml_generating = True


def mark_opml_done() -> None:
    global _opml_generating
    with _lock:
        _opml_generating = False


def is_xml_regenerating() -> bool:
    with _lock:
        return _xml_regenerating


def is_opml_generating() -> bool:
    with _lock:
        return _opml_generating


def mark_autoclean_start() -> None:
    global _autoclean_running
    with _lock:
        _autoclean_running = True


def mark_autoclean_done() -> None:
    global _autoclean_running
    with _lock:
        _autoclean_running = False


def is_autoclean_running() -> bool:
    with _lock:
        return _autoclean_running
