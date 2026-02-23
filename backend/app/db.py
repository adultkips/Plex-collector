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
                role TEXT NOT NULL DEFAULT 'actor',
                appearances INTEGER NOT NULL,
                tmdb_person_id INTEGER,
                image_url TEXT,
                movies_in_plex_count INTEGER,
                missing_movie_count INTEGER,
                missing_new_count INTEGER,
                missing_upcoming_count INTEGER,
                first_release_date TEXT,
                next_upcoming_release_date TEXT,
                missing_scan_at TEXT,
                plex_web_url TEXT,
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
                missing_new_count INTEGER,
                missing_old_count INTEGER,
                missing_upcoming_count INTEGER,
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
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS ignored_episodes (
                show_id TEXT NOT NULL,
                season_number INTEGER NOT NULL,
                episode_number INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (show_id, season_number, episode_number)
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS ignored_movies (
                actor_id TEXT NOT NULL,
                tmdb_movie_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (actor_id, tmdb_movie_id)
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS actor_missing_movies (
                actor_id TEXT NOT NULL,
                tmdb_movie_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                release_date TEXT NOT NULL,
                poster_url TEXT,
                status TEXT NOT NULL,
                ignored INTEGER NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (actor_id, tmdb_movie_id)
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS show_missing_episodes (
                show_id TEXT NOT NULL,
                season_number INTEGER NOT NULL,
                episode_number INTEGER NOT NULL,
                title TEXT NOT NULL,
                air_date TEXT NOT NULL,
                status TEXT NOT NULL,
                ignored INTEGER NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (show_id, season_number, episode_number)
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS tracked_cast (
                actor_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS tracked_movies (
                tmdb_movie_id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS tracked_shows (
                show_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS tracked_seasons (
                show_id TEXT NOT NULL,
                season_number INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (show_id, season_number)
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS tracked_episodes (
                show_id TEXT NOT NULL,
                season_number INTEGER NOT NULL,
                episode_number INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (show_id, season_number, episode_number)
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS untracked_episodes (
                show_id TEXT NOT NULL,
                season_number INTEGER NOT NULL,
                episode_number INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (show_id, season_number, episode_number)
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS tmdb_movie_credits_cache (
                tmdb_movie_id INTEGER PRIMARY KEY,
                director TEXT,
                writer TEXT,
                top_cast_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            '''
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info('plex_movies')").fetchall()}
        actor_columns = {row[1] for row in conn.execute("PRAGMA table_info('actors')").fetchall()}
        if 'movies_in_plex_count' not in actor_columns:
            conn.execute('ALTER TABLE actors ADD COLUMN movies_in_plex_count INTEGER')
        if 'role' not in actor_columns:
            conn.execute("ALTER TABLE actors ADD COLUMN role TEXT NOT NULL DEFAULT 'actor'")
        if 'missing_movie_count' not in actor_columns:
            conn.execute('ALTER TABLE actors ADD COLUMN missing_movie_count INTEGER')
        if 'missing_new_count' not in actor_columns:
            conn.execute('ALTER TABLE actors ADD COLUMN missing_new_count INTEGER')
        if 'missing_upcoming_count' not in actor_columns:
            conn.execute('ALTER TABLE actors ADD COLUMN missing_upcoming_count INTEGER')
        if 'first_release_date' not in actor_columns:
            conn.execute('ALTER TABLE actors ADD COLUMN first_release_date TEXT')
        if 'next_upcoming_release_date' not in actor_columns:
            conn.execute('ALTER TABLE actors ADD COLUMN next_upcoming_release_date TEXT')
        if 'missing_scan_at' not in actor_columns:
            conn.execute('ALTER TABLE actors ADD COLUMN missing_scan_at TEXT')
        if 'plex_web_url' not in actor_columns:
            conn.execute('ALTER TABLE actors ADD COLUMN plex_web_url TEXT')
        conn.execute("UPDATE actors SET role = 'actor' WHERE role IS NULL OR TRIM(role) = ''")
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
        if 'missing_new_count' not in show_columns:
            conn.execute('ALTER TABLE plex_shows ADD COLUMN missing_new_count INTEGER')
        if 'missing_old_count' not in show_columns:
            conn.execute('ALTER TABLE plex_shows ADD COLUMN missing_old_count INTEGER')
        if 'missing_upcoming_count' not in show_columns:
            conn.execute('ALTER TABLE plex_shows ADD COLUMN missing_upcoming_count INTEGER')
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
        ignored_columns = {row[1] for row in conn.execute("PRAGMA table_info('ignored_episodes')").fetchall()}
        if not ignored_columns:
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS ignored_episodes (
                    show_id TEXT NOT NULL,
                    season_number INTEGER NOT NULL,
                    episode_number INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (show_id, season_number, episode_number)
                )
                '''
            )
        ignored_movie_columns = {row[1] for row in conn.execute("PRAGMA table_info('ignored_movies')").fetchall()}
        if not ignored_movie_columns:
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS ignored_movies (
                    actor_id TEXT NOT NULL,
                    tmdb_movie_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (actor_id, tmdb_movie_id)
                )
                '''
            )
        actor_missing_movie_columns = {row[1] for row in conn.execute("PRAGMA table_info('actor_missing_movies')").fetchall()}
        if not actor_missing_movie_columns:
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS actor_missing_movies (
                    actor_id TEXT NOT NULL,
                    tmdb_movie_id INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    release_date TEXT NOT NULL,
                    poster_url TEXT,
                    status TEXT NOT NULL,
                    ignored INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (actor_id, tmdb_movie_id)
                )
                '''
            )
        if 'poster_url' not in actor_missing_movie_columns:
            conn.execute('ALTER TABLE actor_missing_movies ADD COLUMN poster_url TEXT')
        show_missing_episode_columns = {row[1] for row in conn.execute("PRAGMA table_info('show_missing_episodes')").fetchall()}
        if not show_missing_episode_columns:
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS show_missing_episodes (
                    show_id TEXT NOT NULL,
                    season_number INTEGER NOT NULL,
                    episode_number INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    air_date TEXT NOT NULL,
                    status TEXT NOT NULL,
                    ignored INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (show_id, season_number, episode_number)
                )
                '''
            )
        tracked_cast_columns = {row[1] for row in conn.execute("PRAGMA table_info('tracked_cast')").fetchall()}
        if not tracked_cast_columns:
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS tracked_cast (
                    actor_id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                '''
            )
        tracked_movie_columns = {row[1] for row in conn.execute("PRAGMA table_info('tracked_movies')").fetchall()}
        if not tracked_movie_columns:
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS tracked_movies (
                    tmdb_movie_id INTEGER PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                '''
            )
        tracked_show_columns = {row[1] for row in conn.execute("PRAGMA table_info('tracked_shows')").fetchall()}
        if not tracked_show_columns:
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS tracked_shows (
                    show_id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                '''
            )
        tracked_season_columns = {row[1] for row in conn.execute("PRAGMA table_info('tracked_seasons')").fetchall()}
        if not tracked_season_columns:
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS tracked_seasons (
                    show_id TEXT NOT NULL,
                    season_number INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (show_id, season_number)
                )
                '''
            )
        tracked_episode_columns = {row[1] for row in conn.execute("PRAGMA table_info('tracked_episodes')").fetchall()}
        if not tracked_episode_columns:
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS tracked_episodes (
                    show_id TEXT NOT NULL,
                    season_number INTEGER NOT NULL,
                    episode_number INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (show_id, season_number, episode_number)
                )
                '''
            )
        untracked_episode_columns = {row[1] for row in conn.execute("PRAGMA table_info('untracked_episodes')").fetchall()}
        if not untracked_episode_columns:
            conn.execute(
                '''
                CREATE TABLE IF NOT EXISTS untracked_episodes (
                    show_id TEXT NOT NULL,
                    season_number INTEGER NOT NULL,
                    episode_number INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (show_id, season_number, episode_number)
                )
                '''
            )
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
