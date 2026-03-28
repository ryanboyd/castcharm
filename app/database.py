from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from app.config import settings


engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},
)

# Enable WAL mode and foreign keys for SQLite
@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from app import models  # noqa: F401
    Base.metadata.create_all(bind=engine)
    _migrate_db()


def _migrate_db():
    """Add columns introduced after initial schema without dropping existing data."""
    migrations = [
        ("global_settings", "auto_download_new",       "BOOLEAN DEFAULT 1"),
        ("global_settings", "filename_episode_number", "BOOLEAN DEFAULT 1"),
        ("feeds", "podcast_group",                     "VARCHAR"),
        ("feeds", "primary_feed_id",                   "INTEGER REFERENCES feeds(id)"),
        ("feeds", "auto_download_new",                 "BOOLEAN"),
        ("feeds", "initial_sync_complete",             "BOOLEAN DEFAULT 0"),
        ("feeds", "filename_episode_number",           "BOOLEAN"),
        ("feeds", "episode_number_start",              "INTEGER DEFAULT 1"),
        ("feeds", "custom_image_url",                  "VARCHAR"),
        ("episodes", "custom_image_url",               "VARCHAR"),
        ("episodes", "hidden",                         "BOOLEAN DEFAULT 0"),
        ("episodes", "seq_number",                     "INTEGER"),
        ("episodes", "seq_number_locked",              "BOOLEAN DEFAULT 0"),
        ("episodes", "filename_outdated",              "BOOLEAN DEFAULT 0"),
        ("episodes", "custom_id3_tags",               "JSON"),
        ("episodes", "id3_tags_outdated",             "BOOLEAN DEFAULT 0"),
        ("global_settings", "log_max_entries",         "INTEGER DEFAULT 500"),
        ("global_settings", "episode_page_size",         "INTEGER DEFAULT 10000"),
        ("global_settings", "keep_latest",              "INTEGER"),
        ("global_settings", "keep_unplayed",            "BOOLEAN DEFAULT 1"),
        ("feeds",           "keep_latest",              "INTEGER"),
        ("feeds",           "keep_unplayed",            "BOOLEAN DEFAULT 1"),
        ("global_settings", "auto_played_threshold",     "INTEGER DEFAULT 95"),
        ("episodes",        "played",                   "BOOLEAN DEFAULT 0"),
        ("episodes",        "play_position_seconds",    "INTEGER DEFAULT 0"),
        ("episodes",        "last_played_at",           "DATETIME"),
        ("feeds",           "download_all_on_first_sync", "BOOLEAN DEFAULT 0"),
        ("episodes",        "date_is_approximate",        "BOOLEAN DEFAULT 0"),
        ("global_settings", "theme",                      "VARCHAR DEFAULT 'midnight'"),
        ("global_settings", "show_suggested_listening",   "BOOLEAN DEFAULT 1"),
        # Existing installs are already set up — default 1 so wizard doesn't appear for them.
        # Fresh installs get setup_complete=False from the model default (column created by
        # create_all before this migration runs, so ALTER TABLE is a no-op on fresh DBs).
        ("global_settings", "setup_complete",              "BOOLEAN DEFAULT 1"),
        ("global_settings", "auth_enabled",                "BOOLEAN DEFAULT 0"),
        ("global_settings", "auth_username",               "VARCHAR"),
        ("global_settings", "auth_password_hash",          "VARCHAR"),
        ("episodes",        "queued_at",                   "DATETIME"),
    ]
    with engine.connect() as conn:
        for table, column, col_def in migrations:
            existing = {
                row[1]
                for row in conn.execute(text(f"PRAGMA table_info({table})"))
            }
            if column not in existing:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_def}"))
                conn.commit()

        # Indexes introduced after initial schema — IF NOT EXISTS makes these idempotent.
        indexes = [
            "CREATE INDEX IF NOT EXISTS ix_episodes_status         ON episodes (status)",
            "CREATE INDEX IF NOT EXISTS ix_episodes_hidden         ON episodes (hidden)",
            "CREATE INDEX IF NOT EXISTS ix_episodes_played         ON episodes (played)",
            "CREATE INDEX IF NOT EXISTS ix_feeds_primary_feed_id   ON feeds    (primary_feed_id)",
        ]
        for stmt in indexes:
            conn.execute(text(stmt))
        conn.commit()
