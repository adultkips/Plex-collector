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
                library_section_id TEXT,
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
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS plex_shows (
                show_id TEXT PRIMARY KEY,
                plex_rating_key TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                year INTEGER,
                tmdb_show_id INTEGER,
                normalized_title TEXT NOT NULL,
                image_url TEXT,
                plex_web_url TEXT,
                has_missing_episodes INTEGER,
                missing_episode_count INTEGER,
                missing_scan_at TEXT,
                missing_upcoming_air_dates TEXT,
                updated_at TEXT NOT NULL
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS plex_show_episodes (
                plex_rating_key TEXT PRIMARY KEY,
                show_id TEXT NOT NULL,
                season_number INTEGER NOT NULL,
                episode_number INTEGER NOT NULL,
                title TEXT NOT NULL,
                normalized_title TEXT NOT NULL,
                tmdb_episode_id INTEGER,
                season_plex_web_url TEXT,
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
        if 'library_section_id' not in columns:
            conn.execute('ALTER TABLE plex_movies ADD COLUMN library_section_id TEXT')
        show_columns = {row[1] for row in conn.execute("PRAGMA table_info('plex_shows')").fetchall()}
        if 'tmdb_show_id' not in show_columns:
            conn.execute('ALTER TABLE plex_shows ADD COLUMN tmdb_show_id INTEGER')
        if 'normalized_title' not in show_columns:
            conn.execute('ALTER TABLE plex_shows ADD COLUMN normalized_title TEXT')
        if 'image_url' not in show_columns:
            conn.execute('ALTER TABLE plex_shows ADD COLUMN image_url TEXT')
        if 'plex_web_url' not in show_columns:
            conn.execute('ALTER TABLE plex_shows ADD COLUMN plex_web_url TEXT')
        if 'has_missing_episodes' not in show_columns:
            conn.execute('ALTER TABLE plex_shows ADD COLUMN has_missing_episodes INTEGER')
        if 'missing_episode_count' not in show_columns:
            conn.execute('ALTER TABLE plex_shows ADD COLUMN missing_episode_count INTEGER')
        if 'missing_scan_at' not in show_columns:
            conn.execute('ALTER TABLE plex_shows ADD COLUMN missing_scan_at TEXT')
        if 'missing_upcoming_air_dates' not in show_columns:
            conn.execute('ALTER TABLE plex_shows ADD COLUMN missing_upcoming_air_dates TEXT')
        episode_columns = {row[1] for row in conn.execute("PRAGMA table_info('plex_show_episodes')").fetchall()}
        if 'tmdb_episode_id' not in episode_columns:
            conn.execute('ALTER TABLE plex_show_episodes ADD COLUMN tmdb_episode_id INTEGER')
        if 'season_plex_web_url' not in episode_columns:
            conn.execute('ALTER TABLE plex_show_episodes ADD COLUMN season_plex_web_url TEXT')
        if 'plex_web_url' not in episode_columns:
            conn.execute('ALTER TABLE plex_show_episodes ADD COLUMN plex_web_url TEXT')
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
