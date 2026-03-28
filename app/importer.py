"""Import existing audio files into a podcast feed."""
import hashlib
import logging
import os
import re
import shutil
import unicodedata
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Optional

from app.models import Episode, Feed
from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

AUDIO_EXTENSIONS = {".mp3", ".m4a", ".aac", ".ogg", ".flac", ".wav", ".mp4", ".opus", ".wma"}

# In-memory job status: feed_id -> dict
_import_jobs: dict[int, dict] = {}


def get_import_status(feed_id: int) -> Optional[dict]:
    return _import_jobs.get(feed_id)


def get_active_import_count() -> int:
    """Return the number of import jobs currently running."""
    return sum(1 for j in _import_jobs.values() if j.get("status") == "running")


# ---------------------------------------------------------------------------
# Metadata readers
# ---------------------------------------------------------------------------

def _read_xml_sidecar(audio_path: str) -> dict:
    """Read our own .xml sidecar adjacent to the audio file."""
    xml_path = audio_path + ".xml"
    if not os.path.exists(xml_path):
        return {}
    try:
        root = ET.parse(xml_path).getroot()

        def _t(tag):
            el = root.find(tag)
            return el.text.strip() if el is not None and el.text else None

        return {k: v for k, v in {
            "guid":           _t("guid"),
            "title":          _t("title"),
            "enclosure_url":  _t("enclosureUrl"),
            "enclosure_type": _t("enclosureType"),
            "published":      _t("published"),
            "duration":       _t("duration"),
            "episode_number": _t("episodeNumber"),
            "season_number":  _t("seasonNumber"),
            "author":         _t("author"),
            "image_url":      _t("imageUrl"),
            "description":    _t("description"),
            "link":           _t("link"),
        }.items() if v is not None}
    except Exception as e:
        log.debug("XML sidecar parse error %s: %s", xml_path, e)
        return {}


def _read_id3_tags(audio_path: str) -> dict:
    """Read mutagen easy tags from any audio file."""
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(audio_path, easy=True)
        if audio is None:
            return {}
        tags = audio.tags or {}

        def _first(key):
            v = tags.get(key)
            return str(v[0]).strip() if v else None

        result = {
            "title":       _first("title"),
            "artist":      _first("artist"),
            "album":       _first("album"),
            "tracknumber": _first("tracknumber"),
            "date":        _first("date"),
            "comment":     _first("comment"),
        }
        if hasattr(audio, "info") and hasattr(audio.info, "length"):
            t = int(audio.info.length)
            h, rem = divmod(t, 3600)
            m, s = divmod(rem, 60)
            result["duration"] = f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"

        return {k: v for k, v in result.items() if v is not None}
    except Exception as e:
        log.debug("Tag read error %s: %s", audio_path, e)
        return {}


# ---------------------------------------------------------------------------
# Filename parsing
# ---------------------------------------------------------------------------

_FN_PATTERNS = [
    # YYYY-MM-DD - ### - Title
    re.compile(r"^(\d{4}-\d{2}-\d{2})\s*[-–—]\s*(\d+)\s*[-–—]\s*(.+)$"),
    # YYYY-MM-DD - Title
    re.compile(r"^(\d{4}-\d{2}-\d{2})\s*[-–—]\s*(.+)$"),
    # ### - Title  (1-4 leading digits)
    re.compile(r"^(\d{1,4})\s*[-–—]\s*(.+)$"),
    # "Episode N - Title" / "Ep N - Title"
    re.compile(r"^(?:episode|ep\.?)\s*(\d+)\s*[-–—]\s*(.+)$", re.IGNORECASE),
    # fallback: whole stem is the title
    re.compile(r"^(.+)$"),
]


def _parse_date(s: str) -> Optional[datetime]:
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(s[:len(fmt)], fmt)
        except (ValueError, TypeError):
            pass
    m = re.match(r"^(\d{4})$", s.strip())
    if m:
        return datetime(int(m.group(1)), 1, 1)
    return None


def _is_year_only(s: str) -> bool:
    """Return True if the date string is just a 4-digit year (approximate date)."""
    return bool(re.match(r"^\d{4}$", str(s).strip()))


def _parse_filename(stem: str) -> dict:
    for pat in _FN_PATTERNS:
        m = pat.match(stem.strip())
        if not m:
            continue
        groups = m.groups()
        if len(groups) == 3:
            # date, number, title
            result = {"title": groups[2].strip()}
            dt = _parse_date(groups[0])
            if dt:
                result["date"] = dt
            if groups[1].isdigit():
                result["episode_number"] = int(groups[1])
            return result
        if len(groups) == 2:
            g0, g1 = groups[0], groups[1]
            if re.match(r"^\d{4}-\d{2}-\d{2}$", g0):
                result = {"title": g1.strip()}
                dt = _parse_date(g0)
                if dt:
                    result["date"] = dt
                return result
            if g0.isdigit():
                return {"episode_number": int(g0), "title": g1.strip()}
            return {"title": g0.strip()}
        if len(groups) == 1:
            return {"title": groups[0].strip()}
    return {"title": stem.strip()}


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def _normalize(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9 ]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def _similarity(a: str, b: str) -> float:
    a_tok = set(_normalize(a).split())
    b_tok = set(_normalize(b).split())
    if not a_tok or not b_tok:
        return 0.0
    return len(a_tok & b_tok) / max(len(a_tok), len(b_tok))


def _parse_tracknumber(raw: str) -> Optional[int]:
    m = re.match(r"(\d+)", raw)
    return int(m.group(1)) if m else None


def _match_to_episode(sidecar: dict, tags: dict, fn_info: dict,
                      candidates: list) -> Optional[Episode]:
    # 1. Guid (from our own sidecar — definitive)
    if sidecar.get("guid"):
        for ep in candidates:
            if ep.guid == sidecar["guid"]:
                return ep

    # 2. Enclosure URL (also definitive)
    if sidecar.get("enclosure_url"):
        for ep in candidates:
            if ep.enclosure_url == sidecar["enclosure_url"]:
                return ep

    # Gather best title and episode number candidates
    title = (sidecar.get("title") or tags.get("title") or fn_info.get("title") or "").strip()

    ep_num = None
    if sidecar.get("episode_number"):
        try:
            ep_num = int(sidecar["episode_number"])
        except (ValueError, TypeError):
            pass
    if ep_num is None and tags.get("tracknumber"):
        ep_num = _parse_tracknumber(tags["tracknumber"])
    if ep_num is None:
        ep_num = fn_info.get("episode_number")

    # 3. Episode number + title similarity (lenient)
    if ep_num is not None and title:
        for ep in candidates:
            if ep.episode_number == ep_num and ep.title:
                if _similarity(title, ep.title) >= 0.4:
                    return ep

    # 4. Title similarity (higher threshold)
    if title:
        best_ep, best_score = None, 0.0
        for ep in candidates:
            if ep.title:
                s = _similarity(title, ep.title)
                if s > best_score:
                    best_score, best_ep = s, ep
        if best_score >= 0.70:
            return best_ep

    return None


# ---------------------------------------------------------------------------
# Path building for renamed files
# ---------------------------------------------------------------------------

def _build_target_path(ep: Episode, feed: Feed, src_path: str, db: Session,
                       overrides: Optional[dict] = None) -> str:
    from app.downloader import (
        _build_file_path, _get_effective_settings, _effective, _sanitize_filename,
    )
    from sqlalchemy import func as _func

    overrides = overrides or {}
    gs = _get_effective_settings(feed, db)
    base_dir     = _effective(feed.download_path, gs.download_path, "/downloads")
    date_prefix  = overrides["date_prefix"]     if "date_prefix"     in overrides else _effective(feed.filename_date_prefix,    gs.filename_date_prefix,    True)
    ep_num_pfx   = overrides["ep_num_prefix"]   if "ep_num_prefix"   in overrides else _effective(feed.filename_episode_number, gs.filename_episode_number, True)
    by_year      = overrides["organize_by_year"] if "organize_by_year" in overrides else _effective(feed.organize_by_year,        gs.organize_by_year,        True)

    if feed.primary_feed_id:
        primary = db.query(Feed).filter(Feed.id == feed.primary_feed_id).first()
        folder_raw = (primary.podcast_group or primary.title) if primary else (feed.podcast_group or feed.title or "Unknown Podcast")
    else:
        folder_raw = feed.podcast_group or feed.title or "Unknown Podcast"
    folder_name = _sanitize_filename(folder_raw)

    primary_id = feed.primary_feed_id or feed.id
    sub_ids = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == primary_id).all()]
    total_eps = (
        db.query(_func.count(Episode.id))
        .filter(Episode.feed_id.in_([primary_id] + sub_ids), Episode.hidden.is_(False))
        .scalar() or 0
    )

    return _build_file_path(
        ep, folder_name, base_dir, date_prefix, ep_num_pfx, by_year,
        None, src_path, total_episodes=total_eps,
    )


# ---------------------------------------------------------------------------
# Date interpolation
# ---------------------------------------------------------------------------

def _interpolate_missing_dates(feed_id: int, db: Session) -> int:
    """Assign interpolated approximate dates to episodes that lack a real date.

    Episodes are ordered by episode_number (natural sequence) then id (insertion
    order).  Any contiguous run of episodes without a known date that is bounded
    on both sides by episodes with known dates gets equally-spaced dates assigned
    between the two anchors.  Runs at the very start or end of the sequence
    (no anchor on one side) are left untouched.

    Returns the number of episodes updated.
    """
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        return 0

    primary_id = feed.primary_feed_id or feed.id
    sub_ids = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == primary_id).all()]
    all_ids = [primary_id] + sub_ids

    episodes = (
        db.query(Episode)
        .filter(Episode.feed_id.in_(all_ids), Episode.hidden.is_(False))
        .order_by(Episode.episode_number.asc().nullslast(), Episode.id.asc())
        .all()
    )

    def _has_real_date(ep: Episode) -> bool:
        return ep.published_at is not None and not ep.date_is_approximate

    updated = 0
    n = len(episodes)
    i = 0

    while i < n:
        if _has_real_date(episodes[i]):
            i += 1
            continue

        # Start of a run of episodes without a known date
        run_start = i
        while i < n and not _has_real_date(episodes[i]):
            i += 1
        run_end = i  # exclusive — episodes[run_end] is the right anchor (if it exists)

        left_idx = run_start - 1
        right_idx = run_end

        # Both sides need a known-date anchor
        if left_idx < 0 or right_idx >= n:
            continue
        if not _has_real_date(episodes[left_idx]) or not _has_real_date(episodes[right_idx]):
            continue

        d_left = episodes[left_idx].published_at
        d_right = episodes[right_idx].published_at

        if d_right <= d_left:
            # Dates are inverted — can't interpolate meaningfully
            continue

        span = d_right - d_left
        count = run_end - run_start

        for j, ep in enumerate(episodes[run_start:run_end]):
            frac = (j + 1) / (count + 1)
            ep.published_at = d_left + span * frac
            ep.date_is_approximate = True
            updated += 1

    if updated:
        db.commit()

    return updated


# ---------------------------------------------------------------------------
# Scored matching (used by preview and staged import)
# ---------------------------------------------------------------------------

def _dur_seconds(s: Optional[str]) -> Optional[int]:
    """Parse a duration string (H:MM:SS or M:SS) to total seconds."""
    if not s:
        return None
    try:
        parts = str(s).split(":")
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
    except (ValueError, TypeError):
        pass
    return None


def _match_to_episode_scored(
    sidecar: dict, tags: dict, fn_info: dict,
    candidates: list,
    file_dur_s: Optional[int] = None,
) -> list:
    """Return (episode, confidence, method) triples sorted by confidence desc.

    Confidence factors (max 1.0):
      title similarity  × 0.60
      episode number    × 0.25
      duration ≤5% diff × 0.15  (partial credit down to ≤15% diff)
    GUID / enclosure URL hits return confidence 1.0 and skip scoring.
    """
    title = (sidecar.get("title") or tags.get("title") or fn_info.get("title") or "").strip()

    ep_num = None
    if sidecar.get("episode_number"):
        try:
            ep_num = int(sidecar["episode_number"])
        except (ValueError, TypeError):
            pass
    if ep_num is None and tags.get("tracknumber"):
        ep_num = _parse_tracknumber(tags["tracknumber"])
    if ep_num is None:
        ep_num = fn_info.get("episode_number")

    results = []
    for ep in candidates:
        # Definitive matches via our own sidecar metadata
        if sidecar.get("guid") and ep.guid == sidecar["guid"]:
            results.append((ep, 1.0, "guid"))
            continue
        if sidecar.get("enclosure_url") and ep.enclosure_url == sidecar["enclosure_url"]:
            results.append((ep, 1.0, "url"))
            continue

        score = 0.0

        # Title similarity (weight 0.60)
        if title and ep.title:
            score += _similarity(title, ep.title) * 0.60

        # Episode number match (weight 0.25)
        if ep_num is not None and ep.episode_number == ep_num:
            score += 0.25

        # Duration proximity (weight 0.15)
        ep_dur_s = _dur_seconds(ep.duration)
        if file_dur_s and ep_dur_s and ep_dur_s > 0:
            ratio = min(file_dur_s, ep_dur_s) / max(file_dur_s, ep_dur_s)
            if ratio >= 0.95:
                score += 0.15
            elif ratio >= 0.85:
                score += 0.08

        if score < 0.15:
            continue  # not worth returning

        if ep_num is not None and ep.episode_number == ep_num and title and ep.title and _similarity(title, ep.title) >= 0.35:
            method = "ep_num_title"
        elif title and ep.title and _similarity(title, ep.title) >= 0.35:
            method = "title"
        elif ep_num is not None and ep.episode_number == ep_num:
            method = "ep_num"
        else:
            method = "fuzzy"

        results.append((ep, min(score, 0.99), method))

    results.sort(key=lambda x: x[1], reverse=True)
    return results


# ---------------------------------------------------------------------------
# Preview (dry-run — no DB writes)
# ---------------------------------------------------------------------------

def preview_import_directory(feed_id: int, directory: str, db: Session) -> dict:
    """Scan *directory* and return match results without committing anything to DB.

    Returns a dict with:
      files        — list of per-file preview objects
      total_files  — total audio files found
      matched      — files with a confident episode match
      unmatched    — files that would create a new episode
      registered   — files already linked to an episode (shown as read-only)
    """
    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        return {"error": "Feed not found", "files": [], "total_files": 0, "matched": 0, "unmatched": 0, "registered": 0}

    # Collect audio files
    audio_files: list[str] = []
    for root, _dirs, files in os.walk(directory):
        for fname in sorted(files):
            if os.path.splitext(fname)[1].lower() in AUDIO_EXTENSIONS:
                audio_files.append(os.path.join(root, fname))

    # All feed episodes (including supplementary feeds)
    primary_id = feed.primary_feed_id or feed.id
    sub_ids = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == primary_id).all()]
    all_feed_ids = [primary_id] + sub_ids

    existing = (
        db.query(Episode)
        .filter(Episode.feed_id.in_(all_feed_ids), Episode.hidden.is_(False))
        .all()
    )

    registered_paths = {
        os.path.normpath(ep.file_path): ep
        for ep in existing
        if ep.file_path and os.path.exists(ep.file_path)
    }
    # Episodes without a file on disk are candidates for matching
    candidates = [ep for ep in existing if not (ep.file_path and os.path.exists(ep.file_path))]

    matched_ep_ids: set[int] = set()
    file_previews = []

    for audio_path in audio_files:
        norm_path = os.path.normpath(audio_path)
        stem = os.path.splitext(os.path.basename(audio_path))[0]

        sidecar = _read_xml_sidecar(audio_path)
        tags    = _read_id3_tags(audio_path)
        fn_info = _parse_filename(stem)

        title    = (sidecar.get("title") or tags.get("title") or fn_info.get("title") or stem).strip()
        duration = sidecar.get("duration") or tags.get("duration")

        published_at = None
        if sidecar.get("published"):
            published_at = _parse_date(sidecar["published"])
        if published_at is None and fn_info.get("date"):
            published_at = fn_info["date"]
        if published_at is None and tags.get("date"):
            published_at = _parse_date(tags["date"])

        ep_num = None
        if sidecar.get("episode_number"):
            try:
                ep_num = int(sidecar["episode_number"])
            except (ValueError, TypeError):
                pass
        if ep_num is None and tags.get("tracknumber"):
            ep_num = _parse_tracknumber(tags["tracknumber"])
        if ep_num is None:
            ep_num = fn_info.get("episode_number")

        # Already registered to an episode?
        owning_ep = registered_paths.get(norm_path)
        if owning_ep:
            file_previews.append({
                "path": audio_path,
                "filename": os.path.basename(audio_path),
                "title": title,
                "date": published_at.strftime("%Y-%m-%d") if published_at else None,
                "episode_number": ep_num,
                "duration": duration,
                "already_registered": True,
                "match": {"episode_id": owning_ep.id, "episode_title": owning_ep.title,
                          "confidence": 1.0, "method": "registered"},
                "alternatives": [],
            })
            continue

        # Score against unmatched candidates
        available = [ep for ep in candidates if ep.id not in matched_ep_ids]
        file_dur_s = _dur_seconds(duration)
        scored = _match_to_episode_scored(sidecar, tags, fn_info, available, file_dur_s)

        best_match = None
        alternatives = []

        if scored:
            top_ep, top_conf, top_method = scored[0]
            if top_conf >= 0.35:
                best_match = {
                    "episode_id": top_ep.id,
                    "episode_title": top_ep.title,
                    "confidence": round(top_conf, 2),
                    "method": top_method,
                }
                matched_ep_ids.add(top_ep.id)

            alternatives = [
                {"episode_id": ep.id, "episode_title": ep.title,
                 "confidence": round(conf, 2), "method": method}
                for ep, conf, method in scored[1:4]
                if conf >= 0.20 and ep.id not in matched_ep_ids
            ]

        file_previews.append({
            "path": audio_path,
            "filename": os.path.basename(audio_path),
            "title": title,
            "date": published_at.strftime("%Y-%m-%d") if published_at else None,
            "episode_number": ep_num,
            "duration": duration,
            "already_registered": False,
            "match": best_match,
            "alternatives": alternatives,
        })

    n_registered = sum(1 for f in file_previews if f["already_registered"])
    n_matched    = sum(1 for f in file_previews if not f["already_registered"] and f["match"])
    n_unmatched  = sum(1 for f in file_previews if not f["already_registered"] and not f["match"])

    return {
        "files": file_previews,
        "total_files": len(audio_files),
        "matched": n_matched,
        "unmatched": n_unmatched,
        "registered": n_registered,
    }


# ---------------------------------------------------------------------------
# Staged import (commit phase)
# ---------------------------------------------------------------------------

def import_staged(feed_id: int, items: list, db: Session) -> dict:
    """Execute an import using explicit file→episode mappings from the staging UI.

    Each *item* dict has:
      path           — audio file path
      episode_id     — existing episode to link (None → create new)
      skip           — if True, skip this file entirely
      title          — optional title override (for new episodes or overwrites)
      date           — optional date override "YYYY-MM-DD"
      episode_number — optional episode number override
    """
    to_process = [item for item in items if not item.get("skip", False)]

    _import_jobs[feed_id] = {
        "status": "running", "total": len(to_process), "processed": 0,
        "matched": 0, "created": 0, "renamed": 0, "errors": 0,
        "message": "Starting import…",
    }

    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        _import_jobs[feed_id] = {"status": "error", "message": "Feed not found"}
        return _import_jobs[feed_id]

    primary_id = feed.primary_feed_id or feed.id
    sub_ids = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == primary_id).all()]
    all_feed_ids = [primary_id] + sub_ids

    matched = created = errors = 0

    for item in to_process:
        audio_path = item["path"]
        episode_id = item.get("episode_id")

        try:
            if not os.path.exists(audio_path):
                log.warning("Staged import: file not found: %s", audio_path)
                errors += 1
                _import_jobs[feed_id]["processed"] += 1
                continue

            if episode_id:
                ep = db.query(Episode).filter(
                    Episode.id == episode_id,
                    Episode.feed_id.in_(all_feed_ids),
                ).first()
                if not ep:
                    log.warning("Staged import: episode %d not found for feed %d", episode_id, feed_id)
                    errors += 1
                    _import_jobs[feed_id]["processed"] += 1
                    continue
                # Apply any user overrides to the matched episode
                if item.get("title"):
                    ep.title = item["title"]
                if item.get("date"):
                    ep.published_at = _parse_date(item["date"])
                if item.get("episode_number") is not None:
                    ep.episode_number = item["episode_number"]
                matched += 1
            else:
                # Create a new episode from file metadata + overrides
                stem = os.path.splitext(os.path.basename(audio_path))[0]
                sidecar = _read_xml_sidecar(audio_path)
                tags    = _read_id3_tags(audio_path)
                fn_info = _parse_filename(stem)

                title = (item.get("title") or sidecar.get("title") or
                         tags.get("title") or fn_info.get("title") or stem).strip()
                guid  = sidecar.get("guid") or "import:" + hashlib.sha256(audio_path.encode()).hexdigest()[:24]

                ep_num = item.get("episode_number")
                if ep_num is None and sidecar.get("episode_number"):
                    try:
                        ep_num = int(sidecar["episode_number"])
                    except (ValueError, TypeError):
                        pass
                if ep_num is None and tags.get("tracknumber"):
                    ep_num = _parse_tracknumber(tags["tracknumber"])
                if ep_num is None:
                    ep_num = fn_info.get("episode_number")

                published_at: Optional[datetime] = None
                date_is_approximate = False
                if item.get("date"):
                    published_at = _parse_date(item["date"])
                if published_at is None and sidecar.get("published"):
                    published_at = _parse_date(sidecar["published"])
                    if published_at and _is_year_only(sidecar["published"]):
                        date_is_approximate = True
                if published_at is None and fn_info.get("date"):
                    published_at = fn_info["date"]
                if published_at is None and tags.get("date"):
                    published_at = _parse_date(tags["date"])
                    if published_at and _is_year_only(tags["date"]):
                        date_is_approximate = True

                duration = sidecar.get("duration") or tags.get("duration")

                ep = Episode(
                    feed_id             = feed_id,
                    title               = title,
                    guid                = guid,
                    published_at        = published_at,
                    date_is_approximate = date_is_approximate,
                    duration            = duration,
                    episode_number      = ep_num,
                    enclosure_url       = sidecar.get("enclosure_url"),
                    enclosure_type      = sidecar.get("enclosure_type"),
                    author              = sidecar.get("author") or tags.get("artist"),
                    description         = sidecar.get("description"),
                    link                = sidecar.get("link"),
                    episode_image_url   = sidecar.get("image_url"),
                )
                db.add(ep)
                db.flush()
                created += 1

            # Mark as downloaded
            ep.status            = "downloaded"
            ep.file_path         = audio_path
            ep.download_progress = 100
            if os.path.exists(audio_path):
                ep.file_size = os.path.getsize(audio_path)
            if not ep.download_date:
                try:
                    ep.download_date = datetime.fromtimestamp(os.path.getmtime(audio_path))
                except OSError:
                    ep.download_date = datetime.utcnow()

            db.commit()

        except Exception as e:
            log.error("Staged import error for %s: %s", audio_path, e)
            errors += 1
            try:
                db.rollback()
            except Exception:
                pass

        _import_jobs[feed_id]["processed"] += 1

    # Recalculate sequential episode numbers
    try:
        from app.routers.episodes import recalc_seq_numbers
        recalc_seq_numbers(primary_id, db)
        db.commit()
    except Exception as e:
        log.warning("recalc_seq_numbers failed after staged import: %s", e)

    # Interpolate dates for episodes without real date info
    try:
        interpolated = _interpolate_missing_dates(feed_id, db)
        if interpolated:
            log.info("Interpolated approximate dates for %d episode(s) in feed %d", interpolated, feed_id)
    except Exception as e:
        log.warning("Date interpolation failed for feed %d: %s", feed_id, e)

    summary = {
        "status":    "done",
        "total":     len(to_process),
        "processed": len(to_process),
        "matched":   matched,
        "created":   created,
        "renamed":   0,
        "errors":    errors,
        "message": (
            f"Import complete: {matched} linked to existing episodes, {created} new"
            + (f", {errors} error{'s' if errors != 1 else ''}" if errors else "")
        ),
    }
    _import_jobs[feed_id] = summary
    log.info("Staged import feed %d: %s", feed_id, summary["message"])
    return summary


# ---------------------------------------------------------------------------
# Main import function
# ---------------------------------------------------------------------------

def import_directory(feed_id: int, directory: str, rename_files: bool,
                     db: Session, overrides: Optional[dict] = None) -> dict:
    _import_jobs[feed_id] = {
        "status": "running", "total": 0, "processed": 0,
        "matched": 0, "created": 0, "renamed": 0, "errors": 0,
        "message": "Scanning…",
    }

    feed = db.query(Feed).filter(Feed.id == feed_id).first()
    if not feed:
        _import_jobs[feed_id] = {"status": "error", "message": "Feed not found"}
        return _import_jobs[feed_id]

    # Gather all audio files under the directory
    audio_files: list[str] = []
    for root, _dirs, files in os.walk(directory):
        for fname in sorted(files):
            if os.path.splitext(fname)[1].lower() in AUDIO_EXTENSIONS:
                audio_files.append(os.path.join(root, fname))

    if not audio_files:
        result = {"status": "done", "total": 0, "processed": 0,
                  "matched": 0, "created": 0, "renamed": 0, "errors": 0,
                  "message": "No audio files found in that directory."}
        _import_jobs[feed_id] = result
        return result

    _import_jobs[feed_id]["total"] = len(audio_files)
    _import_jobs[feed_id]["message"] = f"Processing {len(audio_files)} files…"

    # Load all feed episodes
    existing = db.query(Episode).filter(
        Episode.feed_id == feed_id, Episode.hidden.is_(False)
    ).all()

    # Files already registered to an episode — skip them entirely so we don't
    # create duplicates when running import on a folder that already has downloads.
    registered_paths: set[str] = {
        os.path.normpath(ep.file_path)
        for ep in existing
        if ep.file_path and os.path.exists(ep.file_path)
    }

    # Only unregistered episodes are candidates for new file→episode linking
    candidates = [
        ep for ep in existing
        if not (ep.file_path and os.path.exists(ep.file_path))
    ]

    matched = created = renamed = errors = 0

    for audio_path in audio_files:
        try:
            # Skip files already tracked by an episode — importing can't help them
            # and attempting to do so creates duplicate records and files.
            if os.path.normpath(audio_path) in registered_paths:
                _import_jobs[feed_id]["processed"] += 1
                continue

            stem = os.path.splitext(os.path.basename(audio_path))[0]

            sidecar  = _read_xml_sidecar(audio_path)
            tags     = _read_id3_tags(audio_path)
            fn_info  = _parse_filename(stem)

            # Best metadata from all sources (sidecar wins, then tags, then filename)
            title       = (sidecar.get("title") or tags.get("title") or fn_info.get("title") or stem).strip()
            duration    = sidecar.get("duration") or tags.get("duration")
            author      = sidecar.get("author") or tags.get("artist")

            published_at: Optional[datetime] = None
            date_is_approximate = False
            if sidecar.get("published"):
                published_at = _parse_date(sidecar["published"])
                if published_at and _is_year_only(sidecar["published"]):
                    date_is_approximate = True
            if published_at is None and fn_info.get("date"):
                published_at = fn_info["date"]
            if published_at is None and tags.get("date"):
                published_at = _parse_date(tags["date"])
                if published_at and _is_year_only(tags["date"]):
                    date_is_approximate = True

            ep_num = None
            if sidecar.get("episode_number"):
                try:
                    ep_num = int(sidecar["episode_number"])
                except (ValueError, TypeError):
                    pass
            if ep_num is None and tags.get("tracknumber"):
                ep_num = _parse_tracknumber(tags["tracknumber"])
            if ep_num is None:
                ep_num = fn_info.get("episode_number")

            # --- Match or create ---
            ep = _match_to_episode(sidecar, tags, fn_info, candidates)

            if ep:
                candidates.remove(ep)
                matched += 1
                # Backfill any missing metadata
                if not ep.published_at and published_at:
                    ep.published_at = published_at
                    ep.date_is_approximate = date_is_approximate
                if not ep.duration and duration:
                    ep.duration = duration
                if not ep.episode_number and ep_num:
                    ep.episode_number = ep_num
            else:
                guid = (
                    sidecar.get("guid")
                    or "import:" + hashlib.sha256(audio_path.encode()).hexdigest()[:24]
                )
                ep = Episode(
                    feed_id             = feed_id,
                    title               = title,
                    guid                = guid,
                    published_at        = published_at,
                    date_is_approximate = date_is_approximate,
                    duration            = duration,
                    episode_number      = ep_num,
                    enclosure_url       = sidecar.get("enclosure_url"),
                    enclosure_type      = sidecar.get("enclosure_type"),
                    author              = author,
                    description         = sidecar.get("description"),
                    link                = sidecar.get("link"),
                    episode_image_url   = sidecar.get("image_url"),
                )
                db.add(ep)
                db.flush()  # get ep.id
                created += 1

            # --- Rename if requested ---
            final_path = audio_path
            if rename_files and ep.title:
                try:
                    target = _build_target_path(ep, feed, audio_path, db, overrides=overrides)
                    if target != audio_path and not os.path.exists(target):
                        os.makedirs(os.path.dirname(target), exist_ok=True)
                        shutil.copy2(audio_path, target)
                        # Copy sidecar alongside
                        xml_src = audio_path + ".xml"
                        if os.path.exists(xml_src):
                            try:
                                shutil.copy2(xml_src, target + ".xml")
                            except OSError:
                                pass
                        final_path = target
                        renamed += 1
                except Exception as re_err:
                    log.warning("Rename failed for %s: %s", audio_path, re_err)

            # --- Mark as downloaded ---
            ep.status = "downloaded"
            ep.file_path = final_path
            ep.download_progress = 100
            if os.path.exists(final_path):
                ep.file_size = os.path.getsize(final_path)
            if not ep.download_date:
                try:
                    ep.download_date = datetime.fromtimestamp(os.path.getmtime(final_path))
                except OSError:
                    ep.download_date = datetime.utcnow()

            db.commit()

        except Exception as e:
            log.error("Import error for %s: %s", audio_path, e)
            errors += 1
            try:
                db.rollback()
            except Exception:
                pass

        _import_jobs[feed_id]["processed"] += 1

    summary = {
        "status":    "done",
        "total":     len(audio_files),
        "processed": len(audio_files),
        "matched":   matched,
        "created":   created,
        "renamed":   renamed,
        "errors":    errors,
        "message": (
            f"Import complete: {matched} matched to feed episodes, "
            f"{created} new"
            + (f", {renamed} renamed" if renamed else "")
            + (f", {errors} error{'s' if errors != 1 else ''}" if errors else "")
        ),
    }
    # Assign seq_numbers now that all episodes are in the DB with episode_numbers
    try:
        from app.routers.episodes import recalc_seq_numbers
        primary_id = feed.primary_feed_id or feed.id
        recalc_seq_numbers(primary_id, db)
        db.commit()
    except Exception as e:
        log.warning("recalc_seq_numbers failed after import: %s", e)

    # Interpolate dates for episodes without real date info that fall between
    # two episodes with known dates.
    try:
        interpolated = _interpolate_missing_dates(feed_id, db)
        if interpolated:
            log.info("Interpolated approximate dates for %d episode(s) in feed %d", interpolated, feed_id)
    except Exception as e:
        log.warning("Date interpolation failed for feed %d: %s", feed_id, e)

    _import_jobs[feed_id] = summary
    log.info("Import feed %d: %s", feed_id, summary["message"])
    return summary
