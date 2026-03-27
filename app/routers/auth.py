"""Authentication and first-run setup endpoints."""
import logging
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app.auth import (
    COOKIE_NAME,
    SESSION_LIFETIME,
    SECURE_COOKIES,
    check_rate_limit,
    clear_failures,
    create_session,
    delete_session,
    hash_password,
    record_failure,
    remaining_attempts,
    validate_session,
    verify_password,
    is_auth_required,
)
from app.database import get_db

log = logging.getLogger(__name__)

router = APIRouter(tags=["auth"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class AuthStatusOut(BaseModel):
    setup_complete: bool
    auth_enabled: bool
    logged_in: bool


class LoginRequest(BaseModel):
    username: str
    password: str


class CredentialsUpdate(BaseModel):
    current_password: str
    new_username: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def password_length(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v

    @field_validator("new_username")
    @classmethod
    def username_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Username must not be empty")
        return v


class SetupCompleteRequest(BaseModel):
    # Auth
    enable_auth: bool = False
    username: Optional[str] = None
    password: Optional[str] = None
    # Settings applied during wizard
    theme: Optional[str] = None
    download_path: Optional[str] = None
    filename_date_prefix: Optional[bool] = None
    filename_episode_number: Optional[bool] = None
    organize_by_year: Optional[bool] = None
    save_xml: Optional[bool] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/auth/status", response_model=AuthStatusOut)
def auth_status(
    db: Session = Depends(get_db),
    cc_session: Optional[str] = Cookie(default=None),
):
    from app.models import GlobalSettings
    gs = db.query(GlobalSettings).first()
    setup_complete = bool(gs and gs.setup_complete)
    auth_enabled = bool(gs and gs.auth_enabled and gs.auth_password_hash)
    if not auth_enabled:
        logged_in = True  # no auth configured = always accessible
    elif cc_session:
        logged_in = validate_session(cc_session, db)
    else:
        logged_in = False
    return AuthStatusOut(
        setup_complete=setup_complete,
        auth_enabled=auth_enabled,
        logged_in=logged_in,
    )


@router.post("/api/auth/login")
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    ip = request.client.host if request.client else "unknown"

    if not check_rate_limit(ip):
        raise HTTPException(status_code=429, detail="Too many login attempts. Please wait a few minutes.")

    from app.models import GlobalSettings
    gs = db.query(GlobalSettings).first()
    if not gs or not gs.auth_enabled or not gs.auth_password_hash:
        raise HTTPException(status_code=400, detail="Authentication is not configured")

    username_ok = (body.username == gs.auth_username)
    # Always run bcrypt regardless of username match so response time is constant
    # (prevents a timing oracle that would reveal whether a username exists).
    password_ok = verify_password(body.password, gs.auth_password_hash)

    if not username_ok or not password_ok:
        record_failure(ip)
        log.warning("Failed login attempt for username '%s' from %s", body.username, ip)
        left = remaining_attempts(ip)
        body_content: dict = {"detail": "Username and password do not match."}
        if left <= 3:
            body_content["remaining"] = left
        return JSONResponse(status_code=401, content=body_content)

    clear_failures(ip)
    token = create_session(db)
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True,
        samesite="strict",
        secure=SECURE_COOKIES,
        path="/",
    )
    log.info("Login successful for user '%s' from %s", body.username, ip)
    return {"ok": True}


@router.post("/api/auth/logout")
def logout(
    response: Response,
    db: Session = Depends(get_db),
    cc_session: Optional[str] = Cookie(default=None),
):
    if cc_session:
        delete_session(cc_session, db)
    response.delete_cookie(key=COOKIE_NAME, path="/")
    log.info("User logged out")
    return {"ok": True}


@router.put("/api/auth/credentials")
def update_credentials(
    body: CredentialsUpdate,
    db: Session = Depends(get_db),
    cc_session: Optional[str] = Cookie(default=None),
):
    """Update username and password. Requires current password to confirm identity."""
    from app.models import GlobalSettings
    gs = db.query(GlobalSettings).first()
    if not gs:
        raise HTTPException(status_code=404, detail="Settings not found")

    # Must be authenticated to change credentials
    if is_auth_required(db):
        if not cc_session or not validate_session(cc_session, db):
            raise HTTPException(status_code=401, detail="Authentication required")
        if not verify_password(body.current_password, gs.auth_password_hash):
            raise HTTPException(status_code=401, detail="Current password is incorrect")

    gs.auth_username = body.new_username
    gs.auth_password_hash = hash_password(body.new_password)
    gs.auth_enabled = True
    db.commit()
    log.info("Credentials updated for user '%s'", body.new_username)
    return {"ok": True}


@router.post("/api/auth/disable")
def disable_auth(
    response: Response,
    db: Session = Depends(get_db),
    cc_session: Optional[str] = Cookie(default=None),
):
    """Disable login requirement entirely. Requires current login to confirm."""
    from app.models import GlobalSettings, AuthSession
    gs = db.query(GlobalSettings).first()
    if not gs:
        raise HTTPException(status_code=404, detail="Settings not found")

    if is_auth_required(db):
        if not cc_session or not validate_session(cc_session, db):
            raise HTTPException(status_code=401, detail="Authentication required")

    gs.auth_enabled = False
    gs.auth_username = None
    gs.auth_password_hash = None
    db.query(AuthSession).delete()
    db.commit()
    response.delete_cookie(key=COOKIE_NAME, path="/")
    log.info("Authentication disabled")
    return {"ok": True}


@router.post("/api/setup/complete")
def complete_setup(
    body: SetupCompleteRequest,
    response: Response,
    db: Session = Depends(get_db),
):
    """Mark setup as complete, apply wizard settings, and trigger the startup scan."""
    from app.models import GlobalSettings
    gs = db.query(GlobalSettings).first()
    if not gs:
        raise HTTPException(status_code=404, detail="Settings not found")

    if body.enable_auth:
        if not body.username or not body.password:
            raise HTTPException(status_code=400, detail="Username and password are required")
        if len(body.password) < 8:
            raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
        gs.auth_enabled = True
        gs.auth_username = body.username.strip()
        gs.auth_password_hash = hash_password(body.password)
    else:
        gs.auth_enabled = False

    if body.theme is not None:
        gs.theme = body.theme
    if body.download_path is not None:
        gs.download_path = body.download_path
    if body.filename_date_prefix is not None:
        gs.filename_date_prefix = body.filename_date_prefix
    if body.filename_episode_number is not None:
        gs.filename_episode_number = body.filename_episode_number
    if body.organize_by_year is not None:
        gs.organize_by_year = body.organize_by_year
    if body.save_xml is not None:
        gs.save_xml = body.save_xml

    gs.setup_complete = True
    db.commit()
    log.info("Setup completed. Auth: %s", "enabled" if gs.auth_enabled else "disabled")

    # Create a session cookie if auth was just configured
    if gs.auth_enabled:
        token = create_session(db)
        response.set_cookie(
            key=COOKIE_NAME,
            value=token,
            max_age=int(SESSION_LIFETIME.total_seconds()),
            httponly=True,
            samesite="strict",
            path="/",
        )

    # Now that setup is complete, kick off the startup scan
    from app.startup_scan import run_in_background as _startup_scan
    _startup_scan()

    return {"ok": True}
