import json
import sqlite3
from contextlib import contextmanager
from typing import Any

from .config import DB_PATH


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS actors (
                actor_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                appearances INTEGER NOT NULL,
                tmdb_person_id INTEGER,
                image_url TEXT,
                updated_at TEXT NOT NULL
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS plex_movies (
                plex_rating_key TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                original_title TEXT,
                year INTEGER,
                tmdb_id INTEGER,
                imdb_id TEXT,
                normalized_title TEXT NOT NULL,
                normalized_original_title TEXT,
                plex_web_url TEXT,
                updated_at TEXT NOT NULL
            )
            '''
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info('plex_movies')").fetchall()}
        if 'original_title' not in columns:
            conn.execute('ALTER TABLE plex_movies ADD COLUMN original_title TEXT')
        if 'normalized_original_title' not in columns:
            conn.execute('ALTER TABLE plex_movies ADD COLUMN normalized_original_title TEXT')
        if 'tmdb_id' not in columns:
            conn.execute('ALTER TABLE plex_movies ADD COLUMN tmdb_id INTEGER')
        if 'imdb_id' not in columns:
            conn.execute('ALTER TABLE plex_movies ADD COLUMN imdb_id TEXT')
        conn.commit()


@contextmanager
def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def set_setting(key: str, value: Any) -> None:
    payload = json.dumps(value)
    with get_conn() as conn:
        conn.execute(
            'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            (key, payload),
        )
        conn.commit()


def get_setting(key: str, default: Any = None) -> Any:
    with get_conn() as conn:
        row = conn.execute('SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
        if not row:
            return default
        return json.loads(row['value'])


def clear_settings(keys: list[str]) -> None:
    with get_conn() as conn:
        conn.executemany('DELETE FROM settings WHERE key = ?', [(k,) for k in keys])
        conn.commit()
