"""Generate a clean RSS/XML feed from all non-hidden episodes in a podcast group."""
import os
import xml.etree.ElementTree as ET
import xml.dom.minidom
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Feed, Episode
from app.utils import sanitize_filename, get_group_feed_ids

_sanitize_filename = sanitize_filename  # alias for modules that import from here


def _rfc2822(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return format_datetime(dt)


def _effective_feed_image(feed: Feed) -> Optional[str]:
    return feed.custom_image_url or feed.image_url


def _effective_episode_image(ep: Episode, feed: Feed) -> Optional[str]:
    return ep.custom_image_url or ep.episode_image_url or _effective_feed_image(feed)


def build_clean_feed_xml(primary_feed_id: int, db: Session) -> str:
    """Build a clean RSS/XML string for the podcast group. Does not write to disk."""
    primary = db.query(Feed).filter(Feed.id == primary_feed_id).first()
    if primary is None:
        raise ValueError(f"Feed {primary_feed_id} not found")

    all_feed_ids = get_group_feed_ids(db, primary_feed_id)

    # Build a feed map so we can look up each episode's source feed for image fallback
    feed_map = {primary_feed_id: primary}
    for fid in all_feed_ids[1:]:
        sf = db.query(Feed).filter(Feed.id == fid).first()
        if sf:
            feed_map[fid] = sf

    episodes = (
        db.query(Episode)
        .filter(
            Episode.feed_id.in_(all_feed_ids),
            Episode.hidden.is_(False),
            Episode.status != "skipped",
        )
        .order_by(Episode.published_at.desc().nullslast(), Episode.id.desc())
        .all()
    )

    ET.register_namespace("itunes", "http://www.itunes.com/dtds/podcast-1.0.dtd")
    ET.register_namespace("content", "http://purl.org/rss/1.0/modules/content/")

    rss = ET.Element("rss", {
        "version": "2.0",
        "xmlns:itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
        "xmlns:content": "http://purl.org/rss/1.0/modules/content/",
    })
    channel = ET.SubElement(rss, "channel")

    def _sub(parent, tag, text):
        if text is not None:
            el = ET.SubElement(parent, tag)
            el.text = str(text)
            return el
        return None

    _sub(channel, "title", primary.title or "Untitled Podcast")
    _sub(channel, "link", primary.website_url or "")
    _sub(channel, "description", primary.description or "")
    if primary.language:
        _sub(channel, "language", primary.language)
    if primary.author:
        _sub(channel, "itunes:author", primary.author)

    feed_img = _effective_feed_image(primary)
    if feed_img:
        img_el = ET.SubElement(channel, "image")
        _sub(img_el, "url", feed_img)
        _sub(img_el, "title", primary.title or "")
        _sub(img_el, "link", primary.website_url or "")
        itunes_img = ET.SubElement(channel, "itunes:image")
        itunes_img.set("href", feed_img)

    if primary.category:
        cat_el = ET.SubElement(channel, "itunes:category")
        cat_el.set("text", primary.category)

    _sub(channel, "generator", "CastCharm clean feed export")
    _sub(channel, "lastBuildDate", _rfc2822(datetime.utcnow()))

    for ep in episodes:
        src_feed = feed_map.get(ep.feed_id, primary)
        item = ET.SubElement(channel, "item")
        _sub(item, "title", ep.title or "Untitled")
        _sub(item, "guid", ep.guid)
        if ep.link:
            _sub(item, "link", ep.link)
        if ep.published_at:
            _sub(item, "pubDate", _rfc2822(ep.published_at))
        if ep.description:
            desc_el = ET.SubElement(item, "description")
            desc_el.text = ep.description
        if ep.enclosure_url:
            enc = ET.SubElement(item, "enclosure")
            enc.set("url", ep.enclosure_url)
            enc.set("type", ep.enclosure_type or "audio/mpeg")
            enc.set("length", str(ep.enclosure_length or 0))
        if ep.duration:
            _sub(item, "itunes:duration", ep.duration)
        if ep.episode_number is not None:
            _sub(item, "itunes:episode", str(ep.episode_number))
        if ep.season_number is not None:
            _sub(item, "itunes:season", str(ep.season_number))
        if ep.author:
            _sub(item, "itunes:author", ep.author)
        ep_img = _effective_episode_image(ep, src_feed)
        if ep_img:
            ep_img_el = ET.SubElement(item, "itunes:image")
            ep_img_el.set("href", ep_img)

    rough = ET.tostring(rss, encoding="unicode")
    pretty = xml.dom.minidom.parseString(rough).toprettyxml(indent="  ")
    lines = pretty.split("\n")
    if lines[0].startswith("<?xml"):
        lines = lines[1:]
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + "\n".join(lines)


def write_feed_xml(primary_feed_id: int, db: Session, folder: str) -> str:
    """Write/overwrite complete-feed.xml inside the podcast's download folder.

    The file is a complete RSS archive built from every episode CastCharm has
    ever seen for this podcast, including episodes that may have fallen off the
    live RSS feed and episodes merged in from supplementary feeds. It is not
    the original RSS — it is a clean, unified export generated by CastCharm.

    Returns the path written.
    """
    xml_content = build_clean_feed_xml(primary_feed_id, db)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "complete-feed.xml")
    with open(path, "w", encoding="utf-8") as f:
        f.write(xml_content)
    return path
