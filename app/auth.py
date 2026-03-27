"""Authentication utilities for CastCharm.

Uses bcrypt (via passlib) for password hashing and server-side session tokens
stored in the database. Sessions are identified by an httpOnly cookie named
COOKIE_NAME. All sensitive comparisons go through passlib so timing is
constant and salting is automatic.
"""
import logging
import os
import secrets
from datetime import datetime, timedelta
from typing import Optional

from passlib.context import CryptContext
from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

# bcrypt: slow by design (~100 ms per verify), auto-salted, immune to
# length-extension attacks. Industry standard for password storage.
_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

COOKIE_NAME = "cc_session"
SESSION_LIFETIME = timedelta(days=30)
# Set CASTCHARM_SECURE_COOKIES=1 in production when serving over HTTPS.
# Defaults to False so HTTP-only home-network deployments work out of the box.
SECURE_COOKIES = os.getenv("CASTCHARM_SECURE_COOKIES", "0").strip() in ("1", "true", "yes")

# ── Rate limiting ──────────────────────────────────────────────────────────────
# Simple in-memory counter per remote IP. Resets on restart — acceptable for a
# single-user self-hosted app. Goal: slow automated brute-force, not lockout.
_FAILURE_WINDOW = timedelta(minutes=5)
_MAX_FAILURES = 10
_failure_log: dict[str, list[datetime]] = {}


def check_rate_limit(ip: str) -> bool:
    """Return False (and prune stale entries) if this IP is over the limit."""
    now = datetime.utcnow()
    cutoff = now - _FAILURE_WINDOW
    times = [t for t in _failure_log.get(ip, []) if t > cutoff]
    _failure_log[ip] = times
    if len(times) >= _MAX_FAILURES:
        log.warning("Login rate limit exceeded for IP %s (%d failures in last %dm)", ip, len(times), int(_FAILURE_WINDOW.total_seconds() / 60))
        return False
    return True


def record_failure(ip: str) -> None:
    _failure_log.setdefault(ip, []).append(datetime.utcnow())


def remaining_attempts(ip: str) -> int:
    """Return how many attempts remain for this IP in the current window."""
    now = datetime.utcnow()
    cutoff = now - _FAILURE_WINDOW
    times = [t for t in _failure_log.get(ip, []) if t > cutoff]
    return max(0, _MAX_FAILURES - len(times))


def clear_failures(ip: str) -> None:
    _failure_log.pop(ip, None)


# ── Password helpers ───────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return _pwd_ctx.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_ctx.verify(plain, hashed)


# ── Session helpers ────────────────────────────────────────────────────────────

def create_session(db: Session) -> str:
    """Create a new auth session and return the opaque token."""
    from app.models import AuthSession
    token = secrets.token_urlsafe(32)
    expires = datetime.utcnow() + SESSION_LIFETIME
    db.add(AuthSession(token=token, expires_at=expires))
    db.commit()
    return token


def validate_session(token: str, db: Session) -> bool:
    """Return True if the token is valid and not expired. Extends expiry on use."""
    from app.models import AuthSession
    session = db.query(AuthSession).filter(AuthSession.token == token).first()
    if not session:
        return False
    if session.expires_at < datetime.utcnow():
        db.delete(session)
        db.commit()
        log.info("Expired session cleaned up")
        return False
    # Rolling expiry: extend on each use so active users stay logged in
    session.expires_at = datetime.utcnow() + SESSION_LIFETIME
    session.last_used_at = datetime.utcnow()
    db.commit()
    return True


def delete_session(token: str, db: Session) -> None:
    from app.models import AuthSession
    session = db.query(AuthSession).filter(AuthSession.token == token).first()
    if session:
        db.delete(session)
        db.commit()


def cleanup_expired_sessions(db: Session) -> None:
    from app.models import AuthSession
    db.query(AuthSession).filter(AuthSession.expires_at < datetime.utcnow()).delete()
    db.commit()


# ── Auth state helpers ─────────────────────────────────────────────────────────

def is_auth_required(db: Session) -> bool:
    """True when the user has set up a login and it is currently enabled."""
    from app.models import GlobalSettings
    gs = db.query(GlobalSettings).first()
    return bool(gs and gs.auth_enabled and gs.auth_password_hash)
