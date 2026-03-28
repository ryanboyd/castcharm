"""Shared utility helpers used across multiple modules."""
import re

from sqlalchemy.orm import Session

from app.models import Feed


def sanitize_filename(name: str) -> str:
    """Remove characters that are unsafe in filenames."""
    name = name.strip()
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name)
    name = re.sub(r"\s+", " ", name)
    return name[:200]


def get_group_feed_ids(db: Session, feed_id: int) -> list[int]:
    """Return [feed_id] + all supplementary feed IDs for a podcast group."""
    sub_ids = [r[0] for r in db.query(Feed.id).filter(Feed.primary_feed_id == feed_id).all()]
    return [feed_id] + sub_ids
