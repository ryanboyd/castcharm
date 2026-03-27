"""RSS feed parsing using feedparser."""
import email.utils
import hashlib
import json
import logging
import re
import urllib.request
from datetime import datetime
from typing import Any, Optional

log = logging.getLogger(__name__)

import feedparser

from app.models import Episode, Feed
from sqlalchemy.orm import Session


def _parse_date(val) -> Optional[datetime]:
    if val is None:
        return None
    # feedparser returns time_struct tuples
    if hasattr(val, "tm_year"):
        try:
            return datetime(*val[:6])
        except Exception:
            return None
    if isinstance(val, str):
        try:
            return datetime(*email.utils.parsedate(val)[:6])
        except Exception:
            return None
    return None


def _first(*values):
    for v in values:
        if v:
            return v
    return None


def _feed_image_url(feed) -> Optional[str]:
    """Extract image URL from a parsed feedparser feed object.

    Handles all common cases:
    - Standard RSS <image><url> (feedparser may normalise to href or keep as url)
    - Atom <logo> / feed.image.href
    - iTunes <itunes:image href="..."/> (dict with href key, or bare string)
    """
    img = getattr(feed, "image", None)
    if img:
        url = getattr(img, "href", None)
        if not url and hasattr(img, "get"):
            url = img.get("href") or img.get("url")
        if not url:
            url = getattr(img, "url", None)
        if url:
            return url

    itunes_img = getattr(feed, "itunes_image", None)
    if itunes_img:
        if isinstance(itunes_img, str):
            return itunes_img
        url = getattr(itunes_img, "href", None)
        if not url and hasattr(itunes_img, "get"):
            url = itunes_img.get("href")
        if url:
            return url

    return None


def resolve_feed_url(url: str) -> str:
    """If *url* is an Apple Podcasts / iTunes page URL, resolve it to the actual
    RSS feed URL via the iTunes lookup API.  Returns *url* unchanged for any
    other URL, or if resolution fails for any reason.
    """
    if not re.search(r"(podcasts\.apple\.com|itunes\.apple\.com)", url, re.I):
        return url

    m = re.search(r"/id(\d+)", url)
    if not m:
        return url

    podcast_id = m.group(1)
    lookup = f"https://itunes.apple.com/lookup?id={podcast_id}&entity=podcast"
    try:
        req = urllib.request.Request(lookup, headers={"User-Agent": "CastCharm/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        results = data.get("results", [])
        feed_url = results[0].get("feedUrl") if results else None
        if feed_url:
            return feed_url
    except Exception:
        pass

    return url


def fetch_feed_metadata(url: str) -> dict[str, Any]:
    """Fetch and parse a feed URL, returning top-level metadata only."""
    parsed = feedparser.parse(url)
    if parsed.get("bozo") and not parsed.get("entries"):
        exc = parsed.get("bozo_exception")
        raise ValueError(f"Failed to parse feed: {exc}")

    feed = parsed.feed
    image_url = _feed_image_url(feed)

    category = None
    tags = getattr(feed, "tags", []) or []
    if tags:
        category = tags[0].get("term") or tags[0].get("label")
    if not category:
        cats = getattr(feed, "itunes_category", None)
        if cats:
            if isinstance(cats, list):
                category = cats[0].get("text") if cats else None
            elif isinstance(cats, dict):
                category = cats.get("text")

    return {
        "title": getattr(feed, "title", None),
        "description": _first(
            getattr(feed, "subtitle", None),
            getattr(feed, "description", None),
            getattr(feed, "summary", None),
        ),
        "image_url": image_url,
        "website_url": getattr(feed, "link", None),
        "author": _first(
            getattr(feed, "author", None),
            getattr(feed, "itunes_author", None),
            getattr(feed, "publisher", None),
        ),
        "language": getattr(feed, "language", None),
        "category": category,
    }


def _entry_image(entry) -> Optional[str]:
    """Extract image URL from a feed entry (itunes:image or media:thumbnail)."""
    img = getattr(entry, "itunes_image", None)
    if img:
        if hasattr(img, "href"):
            return img.href
        if isinstance(img, dict):
            return img.get("href")
    media = getattr(entry, "media_thumbnail", None)
    if media and isinstance(media, list) and media:
        return media[0].get("url")
    for link in getattr(entry, "links", []):
        if link.get("rel") == "enclosure" and link.get("type", "").startswith("image/"):
            return link.get("href")
    return None


def _entry_enclosure(entry) -> tuple[Optional[str], Optional[str], Optional[int]]:
    """Return (url, mime_type, length) for the audio enclosure."""
    for enc in getattr(entry, "enclosures", []):
        mime = enc.get("type", "")
        if mime.startswith("audio/") or mime.startswith("video/"):
            try:
                length = int(enc.get("length") or 0) or None
            except (ValueError, TypeError):
                length = None
            return enc.get("href") or enc.get("url"), mime, length
    # Fallback: any link tagged as enclosure
    for link in getattr(entry, "links", []):
        if link.get("rel") == "enclosure":
            mime = link.get("type", "")
            try:
                length = int(link.get("length") or 0) or None
            except (ValueError, TypeError):
                length = None
            return link.get("href"), mime, length
    return None, None, None


def _parse_episode_number(entry) -> Optional[int]:
    val = getattr(entry, "itunes_episode", None)
    if val is None:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def _parse_season_number(entry) -> Optional[int]:
    val = getattr(entry, "itunes_season", None)
    if val is None:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def sync_feed_episodes(feed: Feed, db: Session, parse_url: Optional[str] = None) -> list[int]:
    """Fetch feed, upsert episodes into DB.

    parse_url: if given, parse this URL/path instead of feed.url (e.g. a local
    complete-feed.xml). Feed metadata fields are not updated when parse_url is used.
    Returns IDs of newly added episodes whose status is 'pending'.
    """
    source = parse_url or feed.url
    parsed = feedparser.parse(source)
    if parsed.get("bozo") and not parsed.get("entries"):
        exc = parsed.get("bozo_exception")
        raise ValueError(f"Failed to parse feed: {exc}")

    raw = parsed.feed

    # Update feed metadata from live RSS only — skip when reading a local archive
    # file so we never overwrite current data with potentially stale cached values.
    if not parse_url:
        image_url = _feed_image_url(raw)
        feed.title = feed.title or getattr(raw, "title", None)
        feed.description = feed.description or _first(
            getattr(raw, "subtitle", None),
            getattr(raw, "description", None),
        )
        feed.image_url = feed.image_url or image_url
        feed.website_url = feed.website_url or getattr(raw, "link", None)
        feed.author = feed.author or _first(
            getattr(raw, "author", None),
            getattr(raw, "itunes_author", None),
        )
        feed.language = feed.language or getattr(raw, "language", None)
    else:
        # Still populate completely empty feeds (e.g. first-time restore with no live sync yet)
        raw_image = _feed_image_url(raw)
        if not feed.title:
            feed.title = getattr(raw, "title", None)
        if not feed.description:
            feed.description = _first(getattr(raw, "subtitle", None), getattr(raw, "description", None))
        if not feed.image_url:
            feed.image_url = raw_image
        if not feed.author:
            feed.author = _first(getattr(raw, "author", None), getattr(raw, "itunes_author", None))
        if not feed.language:
            feed.language = getattr(raw, "language", None)

    # Maps guid → current enclosure_url for every episode already in this feed.
    # Storing the URL alongside the guid lets us detect when a podcast re-publishes
    # an episode with the same GUID but a different audio file (an "edit"), without
    # any additional DB queries.
    existing_guid_url: dict[str, Optional[str]] = {
        row[0]: row[1]
        for row in db.query(Episode.guid, Episode.enclosure_url)
                      .filter(Episode.feed_id == feed.id).all()
    }

    # Determine sibling feed IDs within the same podcast group for cross-feed dedup
    group_primary_id = feed.primary_feed_id or feed.id
    sibling_ids = [
        row[0]
        for row in db.query(Feed.id).filter(
            Feed.id != feed.id,
            (Feed.id == group_primary_id) | (Feed.primary_feed_id == group_primary_id),
        ).all()
    ]

    # Build enclosure URL map and title+date map from sibling feeds in the same group
    existing_url_map: dict[str, Episode] = {}
    existing_title_date_map: dict[tuple, Episode] = {}
    if sibling_ids:
        for ep in db.query(Episode).filter(
            Episode.feed_id.in_(sibling_ids),
        ).all():
            if ep.enclosure_url:
                existing_url_map[ep.enclosure_url] = ep
            if ep.title and ep.published_at:
                key = (ep.title.strip().lower(), ep.published_at.date())
                existing_title_date_map.setdefault(key, ep)

    # Build same-feed URL + title/date maps so that imported episodes with synthetic
    # guids can be recognised and their guid promoted to the real RSS guid rather
    # than creating a duplicate record.
    same_feed_url_map: dict[str, "Episode"] = {}
    same_feed_title_date_map: dict[tuple, "Episode"] = {}
    for ep in db.query(Episode).filter(Episode.feed_id == feed.id).all():
        if ep.enclosure_url:
            same_feed_url_map[ep.enclosure_url] = ep
        if ep.title and ep.published_at:
            key = (ep.title.strip().lower(), ep.published_at.date())
            same_feed_title_date_map.setdefault(key, ep)

    new_pending_episodes: list[Episode] = []
    skipped_count = 0

    for entry in parsed.entries:
        guid = getattr(entry, "id", None) or getattr(entry, "guid", None)
        enc_url, enc_type, enc_len = _entry_enclosure(entry)
        if not guid:
            guid = enc_url or getattr(entry, "title", None)
        if not guid:
            continue

        is_edit = False
        if guid in existing_guid_url:
            existing_url = existing_guid_url[guid]
            if enc_url and existing_url and enc_url != existing_url:
                # Same GUID, different audio file — the podcast re-uploaded an edited
                # version.  Create a new entry with a stable synthetic GUID derived
                # from the new URL so re-syncing doesn't duplicate it again.
                url_hash = hashlib.sha256(enc_url.encode()).hexdigest()[:8]
                synthetic_guid = f"{guid}--edit-{url_hash}"
                if synthetic_guid in existing_guid_url:
                    skipped_count += 1
                    continue  # already imported this edited version
                guid = synthetic_guid
                is_edit = True
            else:
                skipped_count += 1
                continue

        pub = _parse_date(getattr(entry, "published_parsed", None))
        title = getattr(entry, "title", None)
        if is_edit:
            title = f"{title} [edited]" if title else "[edited]"

        if is_edit:
            # Edited episodes bypass same-feed and cross-feed dedup — they are a
            # genuinely new audio file even though the metadata looks identical.
            status = "pending"
            file_path = file_size = download_date = None
        else:
            # Same-feed dedup: if an imported episode with a synthetic guid matches
            # this RSS entry by enclosure URL or title+date, promote it to the real
            # guid instead of creating a duplicate.
            same_match = same_feed_url_map.get(enc_url) if enc_url else None
            if same_match is None and title and pub:
                same_match = same_feed_title_date_map.get((title.strip().lower(), pub.date()))
            if same_match is not None and same_match.guid != guid:
                old_guid = same_match.guid
                same_match.guid = guid
                existing_guid_url[guid] = same_match.enclosure_url
                existing_guid_url.pop(old_guid, None)
                if not same_match.enclosure_url and enc_url:
                    same_match.enclosure_url = enc_url
                    same_feed_url_map[enc_url] = same_match
                skipped_count += 1
                continue

            # Cross-feed dedup: URL match takes priority, then title+date match
            duplicate = existing_url_map.get(enc_url) if enc_url else None
            if duplicate is None and title and pub:
                duplicate = existing_title_date_map.get((title.strip().lower(), pub.date()))

            if duplicate is not None:
                if duplicate.status == "downloaded" and duplicate.file_path:
                    status = "downloaded"
                    file_path = duplicate.file_path
                    file_size = duplicate.file_size
                    download_date = duplicate.download_date
                else:
                    status = "skipped"
                    file_path = file_size = download_date = None
            else:
                status = "pending"
                file_path = file_size = download_date = None

        episode = Episode(
            feed_id=feed.id,
            guid=guid,
            title=title,
            enclosure_url=enc_url,
            enclosure_type=enc_type,
            enclosure_length=enc_len,
            published_at=pub,
            description=_first(
                getattr(entry, "summary", None),
                getattr(entry, "content", [{}])[0].get("value") if getattr(entry, "content", None) else None,
            ),
            duration=getattr(entry, "itunes_duration", None),
            episode_number=_parse_episode_number(entry),
            season_number=_parse_season_number(entry),
            episode_image_url=_entry_image(entry),
            author=_first(
                getattr(entry, "author", None),
                getattr(entry, "itunes_author", None),
            ),
            link=getattr(entry, "link", None),
            status=status,
            file_path=file_path,
            file_size=file_size,
            download_date=download_date,
        )
        db.add(episode)
        existing_guid_url[guid] = enc_url
        if status == "pending":
            new_pending_episodes.append(episode)

    db.flush()
    new_ids = [ep.id for ep in new_pending_episodes]
    if new_ids:
        log.info(
            "Feed sync: %d new episode(s) found for '%s' (id=%d)",
            len(new_ids), feed.title or feed.url, feed.id,
        )
    return new_ids, skipped_count
