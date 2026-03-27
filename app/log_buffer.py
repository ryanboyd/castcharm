"""In-memory circular log buffer, exposed via GET /api/logs."""
import logging
import threading
from collections import deque
from datetime import datetime
from typing import Optional

_buffer: deque = deque(maxlen=1000)
_lock = threading.Lock()

_LEVEL_ORDER = {"DEBUG": 0, "INFO": 1, "WARNING": 2, "ERROR": 3, "CRITICAL": 4}

_msg_formatter = logging.Formatter("%(message)s")


class BufferHandler(logging.Handler):
    """Appends log records to the in-memory ring buffer."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            # Format just the message + any exception/traceback text
            msg = _msg_formatter.format(record)
            entry = {
                "ts": datetime.utcfromtimestamp(record.created).strftime("%Y-%m-%dT%H:%M:%S"),
                "level": record.levelname,
                "logger": record.name,
                "message": msg,
            }
            with _lock:
                _buffer.append(entry)
        except Exception:
            self.handleError(record)


def get_logs(limit: int = 200, min_level: Optional[str] = None) -> list[dict]:
    """Return the most recent *limit* entries, optionally filtered to *min_level* and above."""
    with _lock:
        entries = list(_buffer)
    if min_level:
        threshold = _LEVEL_ORDER.get(min_level.upper(), 0)
        entries = [e for e in entries if _LEVEL_ORDER.get(e["level"], 0) >= threshold]
    return list(reversed(entries[-limit:]))


def set_maxlen(n: int) -> None:
    """Resize the buffer, preserving existing entries up to the new maximum."""
    global _buffer
    with _lock:
        _buffer = deque(_buffer, maxlen=max(50, int(n)))
