from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed

import json
import logging
import time
from datetime import datetime, UTC, timedelta
from pathlib import Path
from typing import Any
from xml.etree.ElementTree import ParseError

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel
import requests
from requests import ConnectionError as RequestsConnectionError, RequestException

from .config import APP_NAME, APP_VERSION, HOST, PLEX_CLIENT_ID, STATIC_DIR, TMDB_API_KEY
from .db import clear_settings, get_conn, get_setting, init_db, set_setting
from .plex_client import (
    append_collection_to_movies,
    candidate_server_uris,
    check_pin,
    choose_preferred_server,
    fetch_movie_library_snapshot,
    fetch_show_library_snapshot,
    get_account_profile,
    get_resources,
    pick_server_uri,
    resolve_show_tmdb_ids,
    resolve_movie_section_ids,
    start_pin,
)
from .tmdb_client import (
    TMDbNotConfiguredError,
    get_person_movie_credits,
    get_tv_season_episodes,
    get_tv_show_seasons,
    search_person,
    search_tv_show,
)
from .tmdb_client import get_tmdb_api_key
from .utils import normalize_title

app = FastAPI(title=APP_NAME, version=APP_VERSION)
logger = logging.getLogger(__name__)
PLEX_IMAGE_BEST_URI_BY_SERVER: dict[str, str] = {}
PLEX_IMAGE_URI_FAIL_UNTIL: dict[str, float] = {}
trusted_hosts = {'127.0.0.1', 'localhost', '::1'}
if HOST and HOST not in {'0.0.0.0', '::'}:
    trusted_hosts.add(HOST)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=sorted(trusted_hosts))


@app.middleware('http')
async def add_security_headers(request, call_next):
    response = await call_next(request)
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Referrer-Policy', 'no-referrer')
    response.headers.setdefault(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=()',
    )
    return response


class TMDbKeyPayload(BaseModel):
    api_key: str


class ServerSelectPayload(BaseModel):
    client_identifier: str


class DownloadPrefixPayload(BaseModel):
    actor_start: str
    actor_mode: str
    actor_end: str
    movie_start: str
    movie_mode: str
    movie_end: str
    show_start: str
    show_mode: str
    show_end: str
    season_start: str
    season_mode: str
    season_end: str
    episode_start: str
    episode_mode: str
    episode_end: str


class CreateCollectionPayload(BaseModel):
    actor_id: str
    collection_name: str | None = None


class ShowMissingScanPayload(BaseModel):
    show_ids: list[str]


class ActorMissingScanPayload(BaseModel):
    actor_ids: list[str]


class ScanCastPayload(BaseModel):
    role: str = 'all'


class IgnoreEpisodePayload(BaseModel):
    ignored: bool


class IgnoreMoviePayload(BaseModel):
    ignored: bool


DEFAULT_DOWNLOAD_PREFIX = {
    'actor_start': '',
    'actor_mode': 'encoded_space',
    'actor_end': '',
    'movie_start': '',
    'movie_mode': 'encoded_space',
    'movie_end': '',
    'show_start': '',
    'show_mode': 'encoded_space',
    'show_end': '',
    'season_start': '',
    'season_mode': 'encoded_space',
    'season_end': '',
    'episode_start': '',
    'episode_mode': 'encoded_space',
    'episode_end': '',
}
VALID_DOWNLOAD_MODES = {'encoded_space', 'hyphen', 'plus'}


def _parse_iso_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, '%Y-%m-%d').replace(tzinfo=UTC)
    except ValueError:
        return None


def _classify_missing_air_date(
    air_date: str | None,
    *,
    now_dt: datetime,
    new_window_days: int = 90,
) -> str:
    parsed = _parse_iso_date(air_date)
    if parsed is None:
        return 'unknown'
    if parsed > now_dt:
        return 'upcoming'
    if parsed >= (now_dt - timedelta(days=new_window_days)):
        return 'new'
    return 'missing'


def _status_priority(status: str) -> int:
    if status == 'new':
        return 3
    if status == 'upcoming':
        return 2
    if status == 'missing':
        return 1
    return 0


def _get_ignored_episode_keys(
    conn,
    show_id: str,
    season_number: int | None = None,
) -> set[tuple[int, int]]:
    if season_number is None:
        rows = conn.execute(
            '''
            SELECT season_number, episode_number
            FROM ignored_episodes
            WHERE show_id = ?
            ''',
            (show_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            '''
            SELECT season_number, episode_number
            FROM ignored_episodes
            WHERE show_id = ? AND season_number = ?
            ''',
            (show_id, season_number),
        ).fetchall()
    keys: set[tuple[int, int]] = set()
    for row in rows:
        try:
            keys.add((int(row['season_number']), int(row['episode_number'])))
        except (TypeError, ValueError):
            continue
    return keys


def _cleanup_ignored_episode_keys(
    conn,
    show_id: str,
    keep_keys: set[tuple[int, int]],
) -> None:
    existing = _get_ignored_episode_keys(conn, show_id)
    remove_keys = existing - keep_keys
    if not remove_keys:
        return
    conn.executemany(
        '''
        DELETE FROM ignored_episodes
        WHERE show_id = ? AND season_number = ? AND episode_number = ?
        ''',
        [(show_id, season_no, ep_no) for season_no, ep_no in remove_keys],
    )


def _set_episode_ignored_state(
    conn,
    show_id: str,
    season_number: int,
    episode_number: int,
    ignored: bool,
) -> None:
    now_iso = datetime.now(UTC).isoformat()
    if ignored:
        conn.execute(
            '''
            INSERT INTO ignored_episodes (show_id, season_number, episode_number, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(show_id, season_number, episode_number)
            DO UPDATE SET updated_at = excluded.updated_at
            ''',
            (show_id, season_number, episode_number, now_iso, now_iso),
        )
        return
    conn.execute(
        '''
        DELETE FROM ignored_episodes
        WHERE show_id = ? AND season_number = ? AND episode_number = ?
        ''',
        (show_id, season_number, episode_number),
    )


def _get_ignored_movie_ids(conn, actor_id: str) -> set[int]:
    rows = conn.execute(
        '''
        SELECT tmdb_movie_id
        FROM ignored_movies
        WHERE actor_id = ?
        ''',
        (actor_id,),
    ).fetchall()
    values: set[int] = set()
    for row in rows:
        try:
            values.add(int(row['tmdb_movie_id']))
        except (TypeError, ValueError):
            continue
    return values


def _cleanup_ignored_movie_ids(conn, actor_id: str, keep_ids: set[int]) -> None:
    existing = _get_ignored_movie_ids(conn, actor_id)
    remove_ids = existing - keep_ids
    if not remove_ids:
        return
    conn.executemany(
        '''
        DELETE FROM ignored_movies
        WHERE actor_id = ? AND tmdb_movie_id = ?
        ''',
        [(actor_id, tmdb_id) for tmdb_id in remove_ids],
    )


def _set_movie_ignored_state(conn, actor_id: str, tmdb_movie_id: int, ignored: bool) -> None:
    now_iso = datetime.now(UTC).isoformat()
    if ignored:
        conn.execute(
            '''
            INSERT INTO ignored_movies (actor_id, tmdb_movie_id, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(actor_id, tmdb_movie_id)
            DO UPDATE SET updated_at = excluded.updated_at
            ''',
            (actor_id, tmdb_movie_id, now_iso, now_iso),
        )
        return
    conn.execute(
        '''
        DELETE FROM ignored_movies
        WHERE actor_id = ? AND tmdb_movie_id = ?
        ''',
        (actor_id, tmdb_movie_id),
    )


def get_download_prefix_settings() -> dict[str, str]:
    raw = get_setting('download_prefix', {})
    if not isinstance(raw, dict):
        return dict(DEFAULT_DOWNLOAD_PREFIX)
    merged = dict(DEFAULT_DOWNLOAD_PREFIX)
    for key in merged:
        value = raw.get(key)
        if isinstance(value, str):
            merged[key] = value
    if merged['actor_mode'] not in VALID_DOWNLOAD_MODES:
        merged['actor_mode'] = DEFAULT_DOWNLOAD_PREFIX['actor_mode']
    if merged['movie_mode'] not in VALID_DOWNLOAD_MODES:
        merged['movie_mode'] = DEFAULT_DOWNLOAD_PREFIX['movie_mode']
    if merged['show_mode'] not in VALID_DOWNLOAD_MODES:
        merged['show_mode'] = DEFAULT_DOWNLOAD_PREFIX['show_mode']
    if merged['season_mode'] not in VALID_DOWNLOAD_MODES:
        merged['season_mode'] = DEFAULT_DOWNLOAD_PREFIX['season_mode']
    if merged['episode_mode'] not in VALID_DOWNLOAD_MODES:
        merged['episode_mode'] = DEFAULT_DOWNLOAD_PREFIX['episode_mode']
    return merged


def upsert_actor_and_movies(actors: list[dict[str, Any]], movies: list[dict[str, Any]]) -> None:
    with get_conn() as conn:
        existing_actor_rows = conn.execute(
            '''
            SELECT
                actor_id,
                role,
                tmdb_person_id,
                image_url,
                movies_in_plex_count,
                missing_movie_count,
                missing_new_count,
                missing_upcoming_count,
                first_release_date,
                next_upcoming_release_date,
                missing_scan_at
            FROM actors
            '''
        ).fetchall()
        existing_by_actor_id = {str(row['actor_id']): dict(row) for row in existing_actor_rows}
        prepared_actors: list[dict[str, Any]] = []
        for actor in actors:
            prepared = dict(actor)
            prepared['role'] = str(prepared.get('role') or 'actor').strip().lower() or 'actor'
            previous = existing_by_actor_id.get(str(prepared.get('actor_id')))
            if previous:
                if not prepared.get('tmdb_person_id') and previous.get('tmdb_person_id'):
                    prepared['tmdb_person_id'] = previous.get('tmdb_person_id')
                if not prepared.get('image_url') and previous.get('image_url'):
                    prepared['image_url'] = previous.get('image_url')
                prepared['movies_in_plex_count'] = previous.get('movies_in_plex_count')
                prepared['missing_movie_count'] = previous.get('missing_movie_count')
                prepared['missing_new_count'] = previous.get('missing_new_count')
                prepared['missing_upcoming_count'] = previous.get('missing_upcoming_count')
                prepared['first_release_date'] = previous.get('first_release_date')
                prepared['next_upcoming_release_date'] = previous.get('next_upcoming_release_date')
                prepared['missing_scan_at'] = previous.get('missing_scan_at')
            else:
                prepared['movies_in_plex_count'] = None
                prepared['missing_movie_count'] = None
                prepared['missing_new_count'] = None
                prepared['missing_upcoming_count'] = None
                prepared['first_release_date'] = None
                prepared['next_upcoming_release_date'] = None
                prepared['missing_scan_at'] = None
            prepared_actors.append(prepared)

        conn.execute('DELETE FROM actors')
        conn.execute('DELETE FROM plex_movies')

        conn.executemany(
            '''
            INSERT INTO actors(
                actor_id,
                name,
                role,
                appearances,
                tmdb_person_id,
                image_url,
                movies_in_plex_count,
                missing_movie_count,
                missing_new_count,
                missing_upcoming_count,
                first_release_date,
                next_upcoming_release_date,
                missing_scan_at,
                updated_at
            )
            VALUES(
                :actor_id,
                :name,
                :role,
                :appearances,
                :tmdb_person_id,
                :image_url,
                :movies_in_plex_count,
                :missing_movie_count,
                :missing_new_count,
                :missing_upcoming_count,
                :first_release_date,
                :next_upcoming_release_date,
                :missing_scan_at,
                :updated_at
            )
            ''',
            prepared_actors,
        )
        conn.executemany(
            '''
            INSERT INTO plex_movies(
                plex_rating_key,
                library_section_id,
                title,
                original_title,
                year,
                tmdb_id,
                imdb_id,
                normalized_title,
                normalized_original_title,
                plex_web_url,
                updated_at
            )
            VALUES(
                :plex_rating_key,
                :library_section_id,
                :title,
                :original_title,
                :year,
                :tmdb_id,
                :imdb_id,
                :normalized_title,
                :normalized_original_title,
                :plex_web_url,
                :updated_at
            )
            ''',
            movies,
        )
        conn.commit()


def _build_actor_movies_payload(
    actor_id: str,
    missing_only: bool,
    in_plex_only: bool,
    new_only: bool = False,
    upcoming_only: bool = False,
) -> dict[str, Any]:
    now_dt = datetime.now(UTC)
    with get_conn() as conn:
        actor = conn.execute(
            'SELECT actor_id, name, role, tmdb_person_id, image_url FROM actors WHERE actor_id = ?',
            (actor_id,),
        ).fetchone()
        if not actor:
            raise HTTPException(status_code=404, detail='Actor not found')

        actor_data = dict(actor)
        if not actor_data['tmdb_person_id']:
            preferred_department = (
                'Directing' if actor_data.get('role') == 'director'
                else ('Writing' if actor_data.get('role') == 'writer' else 'Acting')
            )
            person = search_person(actor_data['name'], preferred_department)
            if not person:
                return {'actor': actor_data, 'items': []}
            actor_data['tmdb_person_id'] = person['id']
            conn.execute(
                'UPDATE actors SET tmdb_person_id = ?, image_url = COALESCE(image_url, ?), updated_at = ? WHERE actor_id = ?',
                (person['id'], person['image_url'], datetime.now(UTC).isoformat(), actor_id),
            )
            conn.commit()

        plex_rows = conn.execute(
            '''
            SELECT
                plex_rating_key,
                library_section_id,
                title,
                original_title,
                year,
                tmdb_id,
                imdb_id,
                normalized_title,
                normalized_original_title,
                plex_web_url
            FROM plex_movies
            '''
        ).fetchall()
        ignored_movie_ids = _get_ignored_movie_ids(conn, actor_id)

    plex_by_key = {(r['normalized_title'], r['year']): dict(r) for r in plex_rows}
    plex_by_original_key = {
        (r['normalized_original_title'], r['year']): dict(r)
        for r in plex_rows
        if r['normalized_original_title']
    }
    plex_by_tmdb_id = {r['tmdb_id']: dict(r) for r in plex_rows if r['tmdb_id'] is not None}
    plex_title_buckets: dict[str, list[dict[str, Any]]] = {}
    plex_original_title_buckets: dict[str, list[dict[str, Any]]] = {}
    for row in plex_rows:
        plex_title_buckets.setdefault(row['normalized_title'], []).append(dict(row))
        if row['normalized_original_title']:
            plex_original_title_buckets.setdefault(row['normalized_original_title'], []).append(dict(row))

    try:
        credits = get_person_movie_credits(actor_data['tmdb_person_id'], actor_data.get('role') or 'actor')
    except TMDbNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    results = []
    for movie in credits:
        release_date = str(movie.get('release_date') or '').strip() or None
        has_valid_release_date = bool(release_date and _parse_iso_date(release_date))
        normalized = normalize_title(movie['title'])
        normalized_original = normalize_title(movie.get('original_title')) if movie.get('original_title') else None
        # Avoid matching movies without a valid release date ("No date"),
        # since title-only fallbacks can create false positives.
        matched = None
        if has_valid_release_date:
            matched = plex_by_tmdb_id.get(movie['tmdb_id']) if movie.get('tmdb_id') is not None else None

            # Primary title+year match first.
            if not matched:
                matched = plex_by_key.get((normalized, movie['year']))

            if not matched:
                # Fallback: if title+year failed, try original_title+year.
                if normalized_original and normalized_original != normalized:
                    matched = plex_by_key.get((normalized_original, movie['year']))
                    if not matched:
                        matched = plex_by_original_key.get((normalized_original, movie['year']))

            if not matched:
                candidates = plex_title_buckets.get(normalized, [])
                if candidates and movie['year'] is not None:
                    close = [c for c in candidates if c['year'] and abs(c['year'] - movie['year']) <= 1]
                    if close:
                        matched = close[0]
                elif candidates:
                    matched = candidates[0]

            if not matched:
                original_candidates = plex_original_title_buckets.get(normalized_original or normalized, [])
                if original_candidates and movie['year'] is not None:
                    close_original = [
                        c for c in original_candidates if c['year'] and abs(c['year'] - movie['year']) <= 1
                    ]
                    if close_original:
                        matched = close_original[0]
                elif original_candidates:
                    matched = original_candidates[0]

        item = {
            **movie,
            'in_plex': bool(matched),
            'plex_rating_key': matched['plex_rating_key'] if matched else None,
            'library_section_id': matched['library_section_id'] if matched else None,
            'plex_web_url': matched['plex_web_url'] if matched else None,
        }
        status = 'in_plex'
        if not item['in_plex']:
            status = _classify_missing_air_date(str(item.get('release_date') or '').strip() or None, now_dt=now_dt)
            if status == 'missing' and item.get('tmdb_id') is not None and int(item['tmdb_id']) in ignored_movie_ids:
                status = 'ignored'
        item['status'] = status
        item['ignored'] = status == 'ignored'
        include_item = True
        if missing_only and status not in {'missing', 'new'}:
            include_item = False
        if in_plex_only and not item['in_plex']:
            include_item = False
        if new_only and status != 'new':
            include_item = False
        if upcoming_only and status != 'upcoming':
            include_item = False
        if include_item:
            results.append(item)

    return {
        'actor': actor_data,
        'items': results,
        'missing_only': missing_only,
        'in_plex_only': in_plex_only,
        'new_only': new_only,
        'upcoming_only': upcoming_only,
    }


def upsert_shows_and_episodes(shows: list[dict[str, Any]], episodes: list[dict[str, Any]]) -> None:
    with get_conn() as conn:
        existing_rows = conn.execute(
            '''
            SELECT
                show_id,
                tmdb_show_id,
                has_missing_episodes,
                missing_episode_count,
                missing_new_count,
                missing_old_count,
                missing_upcoming_count,
                missing_scan_at,
                missing_upcoming_air_dates
            FROM plex_shows
            '''
        ).fetchall()
        existing_by_id = {str(row['show_id']): dict(row) for row in existing_rows}

        prepared_shows: list[dict[str, Any]] = []
        for show in shows:
            prepared = dict(show)
            previous = existing_by_id.get(str(prepared.get('show_id')))
            if previous:
                if not prepared.get('tmdb_show_id') and previous.get('tmdb_show_id'):
                    prepared['tmdb_show_id'] = previous.get('tmdb_show_id')
                prepared['has_missing_episodes'] = previous.get('has_missing_episodes')
                prepared['missing_episode_count'] = previous.get('missing_episode_count')
                prepared['missing_new_count'] = previous.get('missing_new_count')
                prepared['missing_old_count'] = previous.get('missing_old_count')
                prepared['missing_upcoming_count'] = previous.get('missing_upcoming_count')
                prepared['missing_scan_at'] = previous.get('missing_scan_at')
                prepared['missing_upcoming_air_dates'] = previous.get('missing_upcoming_air_dates')
            else:
                prepared['has_missing_episodes'] = None
                prepared['missing_episode_count'] = None
                prepared['missing_new_count'] = None
                prepared['missing_old_count'] = None
                prepared['missing_upcoming_count'] = None
                prepared['missing_scan_at'] = None
                prepared['missing_upcoming_air_dates'] = None
            prepared_shows.append(prepared)

        conn.execute('DELETE FROM plex_shows')
        conn.execute('DELETE FROM plex_show_episodes')
        conn.executemany(
            '''
            INSERT INTO plex_shows(
                show_id,
                plex_rating_key,
                title,
                year,
                tmdb_show_id,
                normalized_title,
                image_url,
                plex_web_url,
                has_missing_episodes,
                missing_episode_count,
                missing_new_count,
                missing_old_count,
                missing_upcoming_count,
                missing_scan_at,
                missing_upcoming_air_dates,
                updated_at
            )
            VALUES(
                :show_id,
                :plex_rating_key,
                :title,
                :year,
                :tmdb_show_id,
                :normalized_title,
                :image_url,
                :plex_web_url,
                :has_missing_episodes,
                :missing_episode_count,
                :missing_new_count,
                :missing_old_count,
                :missing_upcoming_count,
                :missing_scan_at,
                :missing_upcoming_air_dates,
                :updated_at
            )
            ''',
            prepared_shows,
        )
        conn.executemany(
            '''
            INSERT INTO plex_show_episodes(
                plex_rating_key,
                show_id,
                season_number,
                episode_number,
                title,
                normalized_title,
                tmdb_episode_id,
                season_plex_web_url,
                plex_web_url,
                updated_at
            )
            VALUES(
                :plex_rating_key,
                :show_id,
                :season_number,
                :episode_number,
                :title,
                :normalized_title,
                :tmdb_episode_id,
                :season_plex_web_url,
                :plex_web_url,
                :updated_at
            )
            ''',
            episodes,
        )
        conn.commit()


def get_session_payload() -> dict[str, Any]:
    profile = get_setting('profile')
    server = get_setting('server')
    token = get_setting('auth_token')

    return {
        'authenticated': bool(token),
        'profile': profile,
        'server': server,
        'onboarding_complete': bool(token and profile and server),
    }


def ensure_auth() -> tuple[str, dict[str, Any]]:
    auth_token = get_setting('auth_token')
    server = get_setting('server')
    if not auth_token or not server:
        raise HTTPException(status_code=401, detail='Not authenticated with Plex')
    return auth_token, server


def _resolve_single_show_tmdb_from_plex(show_id: str) -> int | None:
    """Best-effort TMDb id lookup from Plex GUID for one show."""
    try:
        _, server = ensure_auth()
    except HTTPException:
        return None
    except Exception:
        return None

    uris_to_try = candidate_server_uris(server)
    for uri in uris_to_try:
        try:
            resolved = resolve_show_tmdb_ids(uri, server['token'], [show_id])
            tmdb_id = resolved.get(show_id)
            if tmdb_id is not None:
                server['uri'] = uri
                set_setting('server', server)
                return int(tmdb_id)
        except Exception:
            continue
    return None


@app.on_event('startup')
def startup() -> None:
    init_db()


@app.get('/api/health')
def health() -> dict[str, str]:
    return {'status': 'ok'}


@app.get('/api/session')
def session() -> dict[str, Any]:
    return get_session_payload()


@app.post('/api/auth/plex/start')
def auth_plex_start() -> dict[str, Any]:
    pin = start_pin()
    set_setting('pending_pin', pin)
    return pin


@app.get('/api/auth/plex/check')
def auth_plex_check(pin_id: int = Query(...)) -> dict[str, Any]:
    payload = check_pin(pin_id)
    if not payload['authenticated']:
        return {'authenticated': False}

    auth_token = payload['auth_token']
    resources = get_resources(auth_token)
    server = choose_preferred_server(resources)
    if not server:
        raise HTTPException(status_code=404, detail='No Plex server resources found')

    server_uri = pick_server_uri(server)
    if not server_uri:
        raise HTTPException(status_code=404, detail='No valid server connection URI found')

    profile = get_account_profile(auth_token)
    server_payload = {
        'name': server['name'],
        'client_identifier': server['client_identifier'],
        'uri': server_uri,
        'token': server['access_token'],
        'connections': server.get('connections', []),
    }

    set_setting('auth_token', auth_token)
    set_setting('profile', profile)
    set_setting('server', server_payload)
    set_setting('onboarded_at', datetime.now(UTC).isoformat())

    return {
        'authenticated': True,
        'profile': profile,
        'server': {k: v for k, v in server_payload.items() if k != 'token'},
    }


@app.post('/api/auth/logout')
def auth_logout() -> dict[str, bool]:
    clear_settings(['auth_token', 'profile', 'server', 'pending_pin', 'onboarded_at'])
    return {'ok': True}


@app.post('/api/reset')
def reset_app_state() -> dict[str, bool]:
    with get_conn() as conn:
        conn.execute('DELETE FROM actors')
        conn.execute('DELETE FROM plex_movies')
        conn.execute('DELETE FROM plex_shows')
        conn.execute('DELETE FROM plex_show_episodes')
        conn.execute('DELETE FROM actor_missing_movies')
        conn.execute('DELETE FROM show_missing_episodes')
        conn.execute('DELETE FROM ignored_movies')
        conn.execute('DELETE FROM ignored_episodes')
        conn.execute('DELETE FROM settings')
        conn.commit()
    return {'ok': True}


@app.post('/api/scan/reset')
def reset_scan_state() -> dict[str, Any]:
    with get_conn() as conn:
        conn.execute('DELETE FROM actors')
        conn.execute('DELETE FROM plex_movies')
        conn.execute('DELETE FROM plex_shows')
        conn.execute('DELETE FROM plex_show_episodes')
        conn.execute('DELETE FROM actor_missing_movies')
        conn.execute('DELETE FROM show_missing_episodes')
        conn.execute('DELETE FROM ignored_movies')
        conn.execute('DELETE FROM ignored_episodes')
        conn.commit()
    clear_settings(['scan_logs', 'show_scan_logs', 'last_scan_at', 'last_show_scan_at'])
    return {'ok': True, 'scan_logs': [], 'show_scan_logs': []}


@app.get('/api/profile')
def profile() -> dict[str, Any]:
    auth_token, current_server = ensure_auth()
    try:
        profile_payload = get_account_profile(auth_token)
        set_setting('profile', profile_payload)
    except Exception:
        profile_payload = get_setting('profile')

    available_servers: list[dict[str, Any]] = []
    try:
        resources = get_resources(auth_token)
        for resource in resources:
            uri = pick_server_uri(resource)
            if not uri:
                continue
            available_servers.append(
                {
                    'name': resource.get('name'),
                    'client_identifier': resource.get('client_identifier'),
                    'uri': uri,
                }
            )
    except Exception:
        available_servers = []

    local_tmdb_key = get_setting('tmdb_api_key', '')
    active_tmdb_key = get_tmdb_api_key()
    return {
        'profile': profile_payload,
        'server': {k: v for k, v in (get_setting('server') or {}).items() if k != 'token'},
        'current_server_client_identifier': current_server.get('client_identifier'),
        'available_servers': available_servers,
        'tmdb_configured': bool(active_tmdb_key),
        'tmdb_source': 'local' if local_tmdb_key else ('env' if TMDB_API_KEY else 'none'),
        'tmdb_has_local_override': bool(local_tmdb_key),
        'tmdb_api_key': active_tmdb_key if active_tmdb_key else '',
        'download_prefix': get_download_prefix_settings(),
        'scan_logs': get_setting('scan_logs', []),
        'show_scan_logs': get_setting('show_scan_logs', []),
    }


@app.post('/api/tmdb/key')
def set_tmdb_key(payload: TMDbKeyPayload) -> dict[str, Any]:
    key = payload.api_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail='TMDb API key cannot be empty')
    set_setting('tmdb_api_key', key)
    return {'ok': True, 'tmdb_configured': True, 'tmdb_source': 'local'}


@app.delete('/api/tmdb/key')
def clear_tmdb_key() -> dict[str, Any]:
    clear_settings(['tmdb_api_key'])
    return {'ok': True, 'tmdb_configured': bool(TMDB_API_KEY), 'tmdb_source': 'env' if TMDB_API_KEY else 'none'}


@app.post('/api/server/select')
def select_server(payload: ServerSelectPayload) -> dict[str, Any]:
    auth_token, current_server = ensure_auth()
    resources = get_resources(auth_token)
    selected = next(
        (r for r in resources if r.get('client_identifier') == payload.client_identifier),
        None,
    )
    if not selected:
        raise HTTPException(status_code=404, detail='Selected server was not found')

    server_uri = pick_server_uri(selected)
    if not server_uri:
        raise HTTPException(status_code=404, detail='No valid connection URI found for selected server')

    server_payload = {
        'name': selected.get('name'),
        'client_identifier': selected.get('client_identifier'),
        'uri': server_uri,
        'token': selected.get('access_token') or current_server.get('token'),
        'connections': selected.get('connections', []),
    }
    set_setting('server', server_payload)
    return {'ok': True, 'server': {k: v for k, v in server_payload.items() if k != 'token'}}


@app.post('/api/download-prefix')
def set_download_prefix(payload: DownloadPrefixPayload) -> dict[str, Any]:
    actor_mode = payload.actor_mode.strip()
    movie_mode = payload.movie_mode.strip()
    show_mode = payload.show_mode.strip()
    season_mode = payload.season_mode.strip()
    episode_mode = payload.episode_mode.strip()
    if actor_mode not in VALID_DOWNLOAD_MODES:
        raise HTTPException(status_code=400, detail='Invalid actor keyword format')
    if movie_mode not in VALID_DOWNLOAD_MODES:
        raise HTTPException(status_code=400, detail='Invalid movie keyword format')
    if show_mode not in VALID_DOWNLOAD_MODES:
        raise HTTPException(status_code=400, detail='Invalid show keyword format')
    if season_mode not in VALID_DOWNLOAD_MODES:
        raise HTTPException(status_code=400, detail='Invalid season keyword format')
    if episode_mode not in VALID_DOWNLOAD_MODES:
        raise HTTPException(status_code=400, detail='Invalid episode keyword format')

    settings = {
        'actor_start': payload.actor_start.strip(),
        'actor_mode': actor_mode,
        'actor_end': payload.actor_end.strip(),
        'movie_start': payload.movie_start.strip(),
        'movie_mode': movie_mode,
        'movie_end': payload.movie_end.strip(),
        'show_start': payload.show_start.strip(),
        'show_mode': show_mode,
        'show_end': payload.show_end.strip(),
        'season_start': payload.season_start.strip(),
        'season_mode': season_mode,
        'season_end': payload.season_end.strip(),
        'episode_start': payload.episode_start.strip(),
        'episode_mode': episode_mode,
        'episode_end': payload.episode_end.strip(),
    }
    set_setting('download_prefix', settings)
    return {'ok': True, 'download_prefix': settings}


@app.post('/api/scan/actors')
def scan_actors(payload: ScanCastPayload | None = None) -> dict[str, Any]:
    auth_token, server = ensure_auth()
    role_raw = (payload.role if payload else 'all').strip().lower()
    if role_raw not in {'all', 'actor', 'director', 'writer'}:
        raise HTTPException(status_code=400, detail='Invalid cast scan role')
    roles_to_scan = {'actor', 'director', 'writer'} if role_raw == 'all' else {role_raw}

    # Refresh connection list from Plex resources when possible.
    try:
        resources = get_resources(auth_token)
        matching = next(
            (r for r in resources if r.get('client_identifier') == server.get('client_identifier')),
            None,
        )
        if matching:
            server['connections'] = matching.get('connections', [])
            server['token'] = matching.get('access_token', server['token'])
            set_setting('server', server)
    except Exception:
        pass

    uris_to_try = candidate_server_uris(server)
    if not uris_to_try:
        raise HTTPException(
            status_code=502,
            detail='No valid Plex connection URIs were found.',
        )

    last_error: Exception | None = None
    actors: list[dict[str, Any]] | None = None
    movies: list[dict[str, Any]] | None = None
    for uri in uris_to_try:
        try:
            actors, movies = fetch_movie_library_snapshot(
                uri,
                server['token'],
                server.get('client_identifier'),
                roles_to_scan=roles_to_scan,
            )
            server['uri'] = uri
            set_setting('server', server)
            break
        except (RequestsConnectionError, RequestException, ParseError) as exc:
            last_error = exc
            continue

    if actors is None or movies is None:
        raise HTTPException(
            status_code=502,
            detail='Could not connect to Plex server via known endpoints.',
        ) from last_error

    enriched_actors = [
        {
            **actor,
            'tmdb_person_id': None,
        }
        for actor in actors
    ]

    upsert_actor_and_movies(enriched_actors, movies)
    scanned_at = datetime.now(UTC).isoformat()
    set_setting('last_scan_at', scanned_at)
    scan_logs = get_setting('scan_logs', [])
    scan_logs.insert(
        0,
        {
            'scanned_at': scanned_at,
            'actors': len(enriched_actors),
            'movies': len(movies),
            'server_name': server.get('name'),
        },
    )
    set_setting('scan_logs', scan_logs[:100])

    return {
        'ok': True,
        'actors': len(enriched_actors),
        'movies': len(movies),
        'last_scan_at': scanned_at,
        'scan_logs': scan_logs[:100],
    }


@app.post('/api/scan/shows')
def scan_shows() -> dict[str, Any]:
    auth_token, server = ensure_auth()

    try:
        resources = get_resources(auth_token)
        matching = next(
            (r for r in resources if r.get('client_identifier') == server.get('client_identifier')),
            None,
        )
        if matching:
            server['connections'] = matching.get('connections', [])
            server['token'] = matching.get('access_token', server['token'])
            set_setting('server', server)
    except Exception:
        pass

    uris_to_try = candidate_server_uris(server)
    if not uris_to_try:
        raise HTTPException(
            status_code=502,
            detail='No valid Plex connection URIs were found.',
        )

    last_error: Exception | None = None
    shows: list[dict[str, Any]] | None = None
    episodes: list[dict[str, Any]] | None = None
    for uri in uris_to_try:
        try:
            shows, episodes = fetch_show_library_snapshot(
                uri,
                server['token'],
                server.get('client_identifier'),
            )
            server['uri'] = uri
            set_setting('server', server)
            break
        except (RequestsConnectionError, RequestException, ParseError) as exc:
            last_error = exc
            continue

    if shows is None or episodes is None:
        raise HTTPException(
            status_code=502,
            detail='Could not connect to Plex server via known endpoints.',
        ) from last_error

    upsert_shows_and_episodes(shows, episodes)
    scanned_at = datetime.now(UTC).isoformat()
    set_setting('last_show_scan_at', scanned_at)
    show_scan_logs = get_setting('show_scan_logs', [])
    show_scan_logs.insert(
        0,
        {
            'scanned_at': scanned_at,
            'shows': len(shows),
            'episodes': len(episodes),
            'server_name': server.get('name'),
        },
    )
    set_setting('show_scan_logs', show_scan_logs[:100])

    return {
        'ok': True,
        'shows': len(shows),
        'episodes': len(episodes),
        'last_scan_at': scanned_at,
        'show_scan_logs': show_scan_logs[:100],
    }


@app.post('/api/actors/missing-scan')
def scan_actors_for_missing(payload: ActorMissingScanPayload) -> dict[str, Any]:
    actor_ids = [str(item).strip() for item in payload.actor_ids if str(item).strip()]
    if not actor_ids:
        raise HTTPException(status_code=400, detail='No actors selected for missing scan')

    unique_actor_ids = list(dict.fromkeys(actor_ids))
    scanned_total = 0
    failed_total = 0
    missing_total = 0
    now_iso = datetime.now(UTC).isoformat()
    updates: list[tuple[Any, ...]] = []
    results: list[dict[str, Any]] = []
    actor_missing_rows_by_actor: dict[str, list[tuple[Any, ...]]] = {}
    actor_keep_tmdb_ids_by_actor: dict[str, set[int]] = {}

    for actor_id in unique_actor_ids:
        scanned_total += 1
        try:
            actor_payload = _build_actor_movies_payload(actor_id, False, False, False, False)
            items = actor_payload.get('items', [])
            movies_in_plex_count = 0
            missing_new_count = 0
            missing_old_count = 0
            missing_upcoming_count = 0
            missing_old_tmdb_ids: set[int] = set()
            actor_missing_rows: list[tuple[Any, ...]] = []
            release_dates: list[str] = []
            upcoming_dates: list[str] = []

            for item in items:
                if item.get('in_plex'):
                    movies_in_plex_count += 1
                status = item.get('status')
                release_date = str(item.get('release_date') or '').strip() or None
                if release_date:
                    release_dates.append(release_date)
                if status == 'new':
                    missing_new_count += 1
                elif status == 'missing':
                    missing_old_count += 1
                    if item.get('tmdb_id') is not None:
                        try:
                            missing_old_tmdb_ids.add(int(item['tmdb_id']))
                        except (TypeError, ValueError):
                            pass
                elif status == 'ignored':
                    if item.get('tmdb_id') is not None:
                        try:
                            missing_old_tmdb_ids.add(int(item['tmdb_id']))
                        except (TypeError, ValueError):
                            pass
                elif status == 'upcoming':
                    missing_upcoming_count += 1
                    if release_date:
                        upcoming_dates.append(release_date)
                if (
                    not item.get('in_plex')
                    and release_date
                    and item.get('tmdb_id') is not None
                    and status in {'missing', 'new', 'upcoming', 'ignored'}
                ):
                    try:
                        tmdb_movie_id = int(item['tmdb_id'])
                    except (TypeError, ValueError):
                        tmdb_movie_id = 0
                    if tmdb_movie_id > 0:
                        actor_missing_rows.append(
                            (
                                actor_id,
                                tmdb_movie_id,
                                str(item.get('title') or 'Untitled'),
                                release_date,
                                str(item.get('poster_url') or '').strip() or None,
                                status,
                                1 if status == 'ignored' else 0,
                                now_iso,
                            )
                        )

            # Defensive dedupe: TMDb credits can occasionally contain repeated
            # movie ids for a person, while actor_missing_movies enforces
            # UNIQUE(actor_id, tmdb_movie_id).
            if actor_missing_rows:
                deduped_rows: dict[int, tuple[Any, ...]] = {}
                for row in actor_missing_rows:
                    movie_id = int(row[1])
                    if movie_id not in deduped_rows:
                        deduped_rows[movie_id] = row
                        continue
                    existing = deduped_rows[movie_id]
                    # Prefer ignored over non-ignored if both exist.
                    existing_ignored = int(existing[6]) == 1
                    incoming_ignored = int(row[6]) == 1
                    if incoming_ignored and not existing_ignored:
                        deduped_rows[movie_id] = row
                actor_missing_rows = list(deduped_rows.values())

            actor_keep_tmdb_ids_by_actor[actor_id] = missing_old_tmdb_ids
            actor_missing_rows_by_actor[actor_id] = actor_missing_rows

            missing_movie_count = missing_new_count + missing_old_count
            first_release_date = min(release_dates) if release_dates else None
            next_upcoming_release_date = min(upcoming_dates) if upcoming_dates else None
            has_missing_movies = (missing_movie_count + missing_upcoming_count) > 0
            if has_missing_movies:
                missing_total += 1

            updates.append(
                (
                    movies_in_plex_count,
                    missing_movie_count,
                    missing_new_count,
                    missing_upcoming_count,
                    first_release_date,
                    next_upcoming_release_date,
                    now_iso,
                    now_iso,
                    actor_id,
                )
            )
            results.append(
                {
                    'actor_id': actor_id,
                    'movies_in_plex_count': movies_in_plex_count,
                    'missing_movie_count': missing_movie_count,
                    'missing_new_count': missing_new_count,
                    'missing_upcoming_count': missing_upcoming_count,
                    'first_release_date': first_release_date,
                    'next_upcoming_release_date': next_upcoming_release_date,
                    'missing_scan_at': now_iso,
                    'has_missing_movies': has_missing_movies,
                    'error': None,
                }
            )
        except TMDbNotConfiguredError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception:  # noqa: BLE001
            logger.exception('Missing-movie scan failed for actor_id=%s', actor_id)
            failed_total += 1
            results.append(
                {
                    'actor_id': actor_id,
                    'movies_in_plex_count': None,
                    'missing_movie_count': None,
                    'missing_new_count': None,
                    'missing_upcoming_count': None,
                    'first_release_date': None,
                    'next_upcoming_release_date': None,
                    'missing_scan_at': None,
                    'has_missing_movies': None,
                    'error': 'Unable to scan this actor right now.',
                }
            )

    if updates:
        with get_conn() as conn:
            for actor_id, keep_ids in actor_keep_tmdb_ids_by_actor.items():
                _cleanup_ignored_movie_ids(conn, actor_id, keep_ids)
            for actor_id, rows in actor_missing_rows_by_actor.items():
                conn.execute('DELETE FROM actor_missing_movies WHERE actor_id = ?', (actor_id,))
                if rows:
                    conn.executemany(
                        '''
                        INSERT INTO actor_missing_movies (
                            actor_id,
                            tmdb_movie_id,
                            title,
                            release_date,
                            poster_url,
                            status,
                            ignored,
                            updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ''',
                        rows,
                    )
            conn.executemany(
                '''
                UPDATE actors
                SET
                    movies_in_plex_count = ?,
                    missing_movie_count = ?,
                    missing_new_count = ?,
                    missing_upcoming_count = ?,
                    first_release_date = ?,
                    next_upcoming_release_date = ?,
                    missing_scan_at = ?,
                    updated_at = ?
                WHERE actor_id = ?
                ''',
                updates,
            )
            conn.commit()

    return {
        'ok': True,
        'scanned': scanned_total,
        'failed': failed_total,
        'missing_actors': missing_total,
        'items': results,
    }


@app.post('/api/shows/missing-scan')
def scan_shows_for_missing(payload: ShowMissingScanPayload) -> dict[str, Any]:
    show_ids = [str(sid).strip() for sid in payload.show_ids if str(sid).strip()]
    if not show_ids:
        raise HTTPException(status_code=400, detail='No shows selected for missing scan')
    unique_show_ids = list(dict.fromkeys(show_ids))

    with get_conn() as conn:
        placeholders = ','.join('?' for _ in unique_show_ids)
        show_rows = conn.execute(
            f'''
            SELECT show_id, title, year, tmdb_show_id
            FROM plex_shows
            WHERE show_id IN ({placeholders})
            ''',
            unique_show_ids,
        ).fetchall()
        shows_by_id = {str(row['show_id']): dict(row) for row in show_rows}
        episode_rows = conn.execute(
            f'''
            SELECT show_id, season_number, episode_number
            FROM plex_show_episodes
            WHERE show_id IN ({placeholders})
            ''',
            unique_show_ids,
        ).fetchall()

    now_iso = datetime.now(UTC).isoformat()
    results: list[dict[str, Any]] = []
    updates: list[tuple[int, int, int, int, int, str, str | None, str, str]] = []
    tmdb_id_updates: list[tuple[int, str, str]] = []
    missing_total = 0
    failed_total = 0
    scanned_total = 0
    show_missing_rows_by_show: dict[str, list[tuple[Any, ...]]] = {}
    show_keep_keys_by_show: dict[str, set[tuple[int, int]]] = {}
    ignored_episode_keys_by_show: dict[str, set[tuple[int, int]]] = {}

    with get_conn() as conn:
        for sid in unique_show_ids:
            ignored_episode_keys_by_show[sid] = _get_ignored_episode_keys(conn, sid)

    plex_episode_set_by_show: dict[str, set[tuple[int, int]]] = {sid: set() for sid in unique_show_ids}
    for row in episode_rows:
        show_id_key = str(row['show_id'])
        season_no = int(row['season_number'] or 0)
        episode_no = int(row['episode_number'] or 0)
        if season_no <= 0 or episode_no <= 0:
            continue
        if show_id_key not in plex_episode_set_by_show:
            plex_episode_set_by_show[show_id_key] = set()
        plex_episode_set_by_show[show_id_key].add((season_no, episode_no))

    for show_id in unique_show_ids:
        show = shows_by_id.get(show_id)
        if not show:
            failed_total += 1
            results.append(
                {
                    'show_id': show_id,
                    'has_missing_episodes': None,
                    'missing_episode_count': None,
                    'missing_new_count': None,
                    'missing_old_count': None,
                    'missing_upcoming_count': None,
                    'missing_scan_at': None,
                    'missing_upcoming_air_dates': [],
                    'error': 'Show not found in local cache',
                }
            )
            continue
        scanned_total += 1
        try:
            tmdb_show_id = show.get('tmdb_show_id')
            if not tmdb_show_id:
                found = search_tv_show(show.get('title') or '', show.get('year'))
                if not found:
                    plex_tmdb_id = _resolve_single_show_tmdb_from_plex(show_id)
                    if plex_tmdb_id is None:
                        failed_total += 1
                        results.append(
                            {
                                'show_id': show_id,
                                'has_missing_episodes': None,
                                'missing_episode_count': None,
                                'missing_new_count': None,
                                'missing_old_count': None,
                                'missing_upcoming_count': None,
                                'missing_scan_at': None,
                                'missing_upcoming_air_dates': [],
                                'error': 'TMDb match not found',
                            }
                        )
                        continue
                    tmdb_show_id = int(plex_tmdb_id)
                else:
                    tmdb_show_id = int(found['id'])
                tmdb_id_updates.append((tmdb_show_id, now_iso, show_id))

            plex_episode_set = plex_episode_set_by_show.get(show_id, set())

            tmdb_episode_set: set[tuple[int, int]] = set()
            tmdb_episode_air_dates: dict[tuple[int, int], str] = {}
            tmdb_episode_titles: dict[tuple[int, int], str] = {}
            seasons = get_tv_show_seasons(int(tmdb_show_id))
            season_numbers = [
                int(season.get('season_number') or 0)
                for season in seasons
                if int(season.get('season_number') or 0) > 0
            ]
            season_episode_pairs: list[tuple[int, list[dict[str, Any]]]] = []
            if season_numbers:
                season_workers = min(4, len(season_numbers))
                with ThreadPoolExecutor(max_workers=season_workers) as pool:
                    futures = {
                        pool.submit(get_tv_season_episodes, int(tmdb_show_id), season_number): season_number
                        for season_number in season_numbers
                    }
                    for future in as_completed(futures):
                        season_episode_pairs.append((futures[future], future.result()))
            for season_number, episodes in season_episode_pairs:
                for episode in episodes:
                    episode_number = int(episode.get('episode_number') or 0)
                    if episode_number <= 0:
                        continue
                    key = (season_number, episode_number)
                    tmdb_episode_set.add(key)
                    tmdb_episode_titles[key] = str(episode.get('title') or '').strip() or f'Episode {episode_number}'
                    air_date = str(episode.get('air_date') or '').strip()
                    if air_date:
                        tmdb_episode_air_dates[key] = air_date

            missing_episode_keys = tmdb_episode_set - plex_episode_set
            ignored_episode_keys = ignored_episode_keys_by_show.get(show_id, set())
            missing_new_count = 0
            missing_old_count = 0
            missing_upcoming_count = 0
            show_missing_rows: list[tuple[Any, ...]] = []
            now_dt = datetime.now(UTC)
            for key in missing_episode_keys:
                season_no, episode_no = key
                air_date = tmdb_episode_air_dates.get(key)
                status = _classify_missing_air_date(air_date, now_dt=now_dt)
                if status == 'missing' and key in ignored_episode_keys:
                    status = 'ignored'
                if status == 'new':
                    missing_new_count += 1
                elif status == 'upcoming':
                    missing_upcoming_count += 1
                elif status == 'missing':
                    missing_old_count += 1
                # Episodes without air_date are ignored for status/counters.
                if air_date and status in {'missing', 'new', 'upcoming'}:
                    show_missing_rows.append(
                        (
                            show_id,
                            season_no,
                            episode_no,
                            tmdb_episode_titles.get(key) or f'Episode {episode_no}',
                            air_date,
                            status,
                            0,
                            now_iso,
                        )
                    )
            # "Missing" counter excludes upcoming episodes by design.
            missing_episode_count = missing_new_count + missing_old_count
            has_missing = 1 if (missing_episode_count + missing_upcoming_count) > 0 else 0
            if has_missing:
                missing_total += 1
            upcoming_air_dates = sorted(
                {
                    tmdb_episode_air_dates[key]
                    for key in missing_episode_keys
                    if key in tmdb_episode_air_dates and key not in ignored_episode_keys
                }
            )
            show_keep_keys_by_show[show_id] = missing_episode_keys
            show_missing_rows_by_show[show_id] = show_missing_rows
            updates.append(
                (
                    has_missing,
                    missing_episode_count,
                    missing_new_count,
                    missing_old_count,
                    missing_upcoming_count,
                    now_iso,
                    json.dumps(upcoming_air_dates),
                    now_iso,
                    show_id,
                )
            )
            results.append(
                {
                    'show_id': show_id,
                    'has_missing_episodes': bool(has_missing),
                    'missing_episode_count': missing_episode_count,
                    'missing_new_count': missing_new_count,
                    'missing_old_count': missing_old_count,
                    'missing_upcoming_count': missing_upcoming_count,
                    'missing_scan_at': now_iso,
                    'missing_upcoming_air_dates': upcoming_air_dates,
                    'error': None,
                }
            )
        except TMDbNotConfiguredError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            logger.exception('Missing-episode scan failed for show_id=%s', show_id)
            failed_total += 1
            results.append(
                {
                    'show_id': show_id,
                    'has_missing_episodes': None,
                    'missing_episode_count': None,
                    'missing_new_count': None,
                    'missing_old_count': None,
                    'missing_upcoming_count': None,
                    'missing_scan_at': None,
                    'missing_upcoming_air_dates': [],
                    'error': 'Unable to scan this show right now.',
                }
            )

    if updates:
        with get_conn() as conn:
            if tmdb_id_updates:
                conn.executemany(
                    'UPDATE plex_shows SET tmdb_show_id = ?, updated_at = ? WHERE show_id = ?',
                    tmdb_id_updates,
                )
            for show_id, keep_keys in show_keep_keys_by_show.items():
                # Auto-clean stale ignore rows in one transaction for whole scan.
                _cleanup_ignored_episode_keys(conn, show_id, keep_keys)
            for show_id, rows in show_missing_rows_by_show.items():
                conn.execute('DELETE FROM show_missing_episodes WHERE show_id = ?', (show_id,))
                if rows:
                    conn.executemany(
                        '''
                        INSERT INTO show_missing_episodes (
                            show_id,
                            season_number,
                            episode_number,
                            title,
                            air_date,
                            status,
                            ignored,
                            updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ''',
                        rows,
                    )
            conn.executemany(
                '''
                UPDATE plex_shows
                SET
                    has_missing_episodes = ?,
                    missing_episode_count = ?,
                    missing_new_count = ?,
                    missing_old_count = ?,
                    missing_upcoming_count = ?,
                    missing_scan_at = ?,
                    missing_upcoming_air_dates = ?,
                    updated_at = ?
                WHERE show_id = ?
                ''',
                updates,
            )
            conn.commit()

    return {
        'ok': True,
        'scanned': scanned_total,
        'failed': failed_total,
        'missing_shows': missing_total,
        'items': results,
    }


@app.get('/api/calendar/events')
def calendar_events(
    start: str = Query(...),
    end: str = Query(...),
) -> dict[str, Any]:
    start_dt = _parse_iso_date(start)
    end_dt = _parse_iso_date(end)
    if not start_dt or not end_dt:
        raise HTTPException(status_code=400, detail='Invalid start/end date format. Use YYYY-MM-DD.')
    if end_dt < start_dt:
        raise HTTPException(status_code=400, detail='End date must be on or after start date.')
    if (end_dt - start_dt).days > 120:
        raise HTTPException(status_code=400, detail='Date range is too large. Maximum is 120 days.')

    with get_conn() as conn:
        movie_rows = conn.execute(
            '''
            SELECT
                m.release_date AS event_date,
                MIN(m.title) AS title,
                MIN(m.poster_url) AS poster_url
            FROM actor_missing_movies m
            WHERE
                m.release_date >= ?
                AND m.release_date <= ?
                AND m.ignored = 0
            GROUP BY m.tmdb_movie_id, m.release_date
            ORDER BY m.release_date ASC, title ASC
            ''',
            (start, end),
        ).fetchall()
        show_rows = conn.execute(
            '''
            SELECT
                e.air_date AS event_date,
                s.title AS show_title,
                s.image_url AS poster_url,
                e.season_number,
                e.episode_number,
                e.title AS episode_title
            FROM show_missing_episodes e
            JOIN plex_shows s ON s.show_id = e.show_id
            WHERE
                e.air_date >= ?
                AND e.air_date <= ?
                AND e.ignored = 0
            ORDER BY e.air_date ASC, s.title ASC, e.season_number ASC, e.episode_number ASC
            ''',
            (start, end),
        ).fetchall()

    items: list[dict[str, Any]] = []
    for row in movie_rows:
        items.append(
            {
                'date': str(row['event_date']),
                'type': 'movie',
                'title': str(row['title'] or 'Untitled movie'),
                'poster_url': str(row['poster_url'] or '').strip() or None,
            }
        )
    for row in show_rows:
        season_no = int(row['season_number'])
        episode_no = int(row['episode_number'])
        items.append(
            {
                'date': str(row['event_date']),
                'type': 'show',
                'title': f"{row['show_title']} S{season_no:02d}E{episode_no:02d} - {row['episode_title']}",
                'poster_url': str(row['poster_url'] or '').strip() or None,
            }
        )
    return {
        'start': start,
        'end': end,
        'items': items,
    }


@app.get('/api/plex/image')
def plex_image(thumb: str = Query(...)) -> Response:
    _, server = ensure_auth()
    thumb_path = thumb if thumb.startswith('/') else f'/{thumb}'
    uris_to_try = candidate_server_uris(server)
    server_key = str(server.get('client_identifier') or server.get('name') or 'default')
    now_ts = time.monotonic()
    preferred_uri = PLEX_IMAGE_BEST_URI_BY_SERVER.get(server_key)
    if preferred_uri in uris_to_try:
        uris_to_try = [preferred_uri, *[uri for uri in uris_to_try if uri != preferred_uri]]

    filtered_uris = [uri for uri in uris_to_try if PLEX_IMAGE_URI_FAIL_UNTIL.get(uri, 0) <= now_ts]
    if filtered_uris:
        uris_to_try = filtered_uris

    headers = {
        'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
        'X-Plex-Token': server['token'],
    }

    last_error: Exception | None = None
    for uri in uris_to_try:
        try:
            response = requests.get(
                f'{uri}{thumb_path}',
                headers=headers,
                timeout=(2, 20),
            )
            response.raise_for_status()
            PLEX_IMAGE_BEST_URI_BY_SERVER[server_key] = uri
            PLEX_IMAGE_URI_FAIL_UNTIL.pop(uri, None)
            content_type = response.headers.get('content-type', 'image/jpeg')
            return Response(
                content=response.content,
                media_type=content_type,
                headers={
                    # Let browser cache proxied images between page reloads.
                    # Cache invalidation is handled client-side via imgv query key.
                    'Cache-Control': 'public, max-age=604800, immutable',
                },
            )
        except RequestException as exc:
            last_error = exc
            PLEX_IMAGE_URI_FAIL_UNTIL[uri] = now_ts + 45.0
            continue

    raise HTTPException(status_code=404, detail='Plex image could not be loaded') from last_error


@app.get('/api/cast/roles')
def cast_roles() -> dict[str, Any]:
    with get_conn() as conn:
        rows = conn.execute(
            '''
            SELECT role, COUNT(*) AS total
            FROM actors
            GROUP BY role
            '''
        ).fetchall()
    totals = {'actor': 0, 'director': 0, 'writer': 0}
    for row in rows:
        role = str(row['role'] or 'actor').strip().lower()
        if role in totals:
            totals[role] = int(row['total'] or 0)
    return {'items': totals, 'last_scan_at': get_setting('last_scan_at')}


@app.get('/api/actors')
def actors(role: str = Query('actor')) -> dict[str, Any]:
    role_value = role.strip().lower() or 'actor'
    if role_value not in {'actor', 'director', 'writer'}:
        raise HTTPException(status_code=400, detail='Invalid cast role')
    with get_conn() as conn:
        rows = conn.execute(
            '''
            SELECT
                actor_id,
                name,
                role,
                appearances,
                tmdb_person_id,
                image_url,
                movies_in_plex_count,
                missing_movie_count,
                missing_new_count,
                missing_upcoming_count,
                first_release_date,
                next_upcoming_release_date,
                missing_scan_at,
                updated_at
            FROM actors
            WHERE role = ?
            ORDER BY appearances DESC, name ASC
            '''
        , (role_value,)).fetchall()

    return {
        'items': [dict(r) for r in rows],
        'role': role_value,
        'last_scan_at': get_setting('last_scan_at'),
    }


@app.get('/api/actors/{actor_id}/movies')
def actor_movies(
    actor_id: str,
    missing_only: bool = Query(False),
    in_plex_only: bool = Query(False),
    new_only: bool = Query(False),
    upcoming_only: bool = Query(False),
) -> dict[str, Any]:
    return _build_actor_movies_payload(actor_id, missing_only, in_plex_only, new_only, upcoming_only)


@app.post('/api/actors/{actor_id}/movies/{tmdb_movie_id}/ignore')
def set_actor_movie_ignore(
    actor_id: str,
    tmdb_movie_id: int,
    payload: IgnoreMoviePayload,
) -> dict[str, Any]:
    if tmdb_movie_id <= 0:
        raise HTTPException(status_code=400, detail='Invalid TMDb movie id')
    with get_conn() as conn:
        actor = conn.execute(
            '''
            SELECT actor_id
            FROM actors
            WHERE actor_id = ?
            ''',
            (actor_id,),
        ).fetchone()
        if not actor:
            raise HTTPException(status_code=404, detail='Actor not found')
        _set_movie_ignored_state(conn, actor_id, tmdb_movie_id, payload.ignored)
        conn.commit()
    return {
        'ok': True,
        'actor_id': actor_id,
        'tmdb_movie_id': tmdb_movie_id,
        'ignored': bool(payload.ignored),
    }


@app.post('/api/collections/create-from-actor')
def create_collection_from_actor(payload: CreateCollectionPayload) -> dict[str, Any]:
    _, server = ensure_auth()
    actor_payload = _build_actor_movies_payload(payload.actor_id, False, True, False, False)
    actor_name = actor_payload['actor']['name']
    collection_name = (payload.collection_name or actor_name).strip()
    if not collection_name:
        raise HTTPException(status_code=400, detail='Collection name cannot be empty')

    in_plex_items = [
        item for item in actor_payload['items']
        if item.get('in_plex') and item.get('plex_rating_key')
    ]
    if not in_plex_items:
        return {
            'ok': True,
            'collection_name': collection_name,
            'requested': 0,
            'updated': 0,
            'unchanged': 0,
            'sections': [],
            'detail': 'No Plex movies found for this actor.',
        }

    in_plex_items_with_section = [item for item in in_plex_items if item.get('library_section_id')]
    unresolved_keys = [
        str(item['plex_rating_key']) for item in in_plex_items if not item.get('library_section_id')
    ]

    keys_by_section: dict[str, list[str]] = {}
    for item in in_plex_items_with_section:
        section_id = str(item['library_section_id'])
        keys_by_section.setdefault(section_id, []).append(str(item['plex_rating_key']))

    uris_to_try = candidate_server_uris(server)
    if unresolved_keys:
        resolved_sections: dict[str, str] = {}
        for uri in uris_to_try:
            try:
                resolved_sections = resolve_movie_section_ids(
                    uri,
                    server['token'],
                    unresolved_keys,
                )
                if resolved_sections and server.get('uri') != uri:
                    server['uri'] = uri
                    set_setting('server', server)
                break
            except (RequestsConnectionError, RequestException, ParseError):
                continue
        for rating_key, section_id in resolved_sections.items():
            keys_by_section.setdefault(str(section_id), []).append(str(rating_key))
        if resolved_sections:
            with get_conn() as conn:
                conn.executemany(
                    'UPDATE plex_movies SET library_section_id = ? WHERE plex_rating_key = ?',
                    [(section_id, rating_key) for rating_key, section_id in resolved_sections.items()],
                )
                conn.commit()

    if not keys_by_section:
        return {
            'ok': True,
            'collection_name': collection_name,
            'requested': len(in_plex_items),
            'updated': 0,
            'unchanged': 0,
            'sections': [],
            'detail': 'Could not resolve Plex library section for selected movies. Run Scan Actors again and retry.',
        }

    sections_result: list[dict[str, Any]] = []
    total_updated = 0
    total_unchanged = 0
    for section_id, keys in keys_by_section.items():
        section_error: Exception | None = None
        applied: dict[str, Any] | None = None
        for uri in uris_to_try:
            try:
                applied = append_collection_to_movies(
                    uri,
                    server['token'],
                    section_id,
                    keys,
                    collection_name,
                )
                if server.get('uri') != uri:
                    server['uri'] = uri
                    set_setting('server', server)
                break
            except (RequestsConnectionError, RequestException, ParseError) as exc:
                section_error = exc
                continue
        if applied is None:
            sections_result.append(
                {
                    'section_id': section_id,
                    'requested': len(set(keys)),
                    'updated': 0,
                    'unchanged': 0,
                    'error': str(section_error) if section_error else 'Unknown Plex error',
                }
            )
            continue
        total_updated += int(applied.get('updated', 0))
        total_unchanged += int(applied.get('unchanged', 0))
        sections_result.append(
            {
                'section_id': section_id,
                'requested': len(set(keys)),
                'updated': int(applied.get('updated', 0)),
                'unchanged': int(applied.get('unchanged', 0)),
                'error': None,
            }
        )

    errors = [section for section in sections_result if section.get('error')]
    status = 'partial' if errors and total_updated > 0 else ('failed' if errors else 'success')
    if status == 'failed':
        raise HTTPException(
            status_code=502,
            detail='Could not update collection on Plex. Check server connection and metadata edit permissions.',
        )
    return {
        'ok': True,
        'status': status,
        'collection_name': collection_name,
        'requested': len(in_plex_items),
        'updated': total_updated,
        'unchanged': total_unchanged,
        'sections': sections_result,
    }


@app.get('/api/shows')
def shows() -> dict[str, Any]:
    with get_conn() as conn:
        rows = conn.execute(
            '''
            SELECT
                s.show_id,
                s.title,
                s.year,
                s.image_url,
                s.plex_web_url,
                s.has_missing_episodes,
                s.missing_episode_count,
                s.missing_new_count,
                s.missing_old_count,
                s.missing_upcoming_count,
                s.missing_scan_at,
                s.missing_upcoming_air_dates,
                s.updated_at,
                COUNT(e.plex_rating_key) AS episodes_in_plex
            FROM plex_shows s
            LEFT JOIN plex_show_episodes e ON e.show_id = s.show_id
            GROUP BY
                s.show_id,
                s.title,
                s.year,
                s.image_url,
                s.plex_web_url,
                s.has_missing_episodes,
                s.missing_episode_count,
                s.missing_new_count,
                s.missing_old_count,
                s.missing_upcoming_count,
                s.missing_scan_at,
                s.missing_upcoming_air_dates,
                s.updated_at
            ORDER BY episodes_in_plex DESC, s.title ASC
            '''
        ).fetchall()
    return {
        'items': [dict(r) for r in rows],
        'last_scan_at': get_setting('last_show_scan_at'),
    }


@app.get('/api/shows/{show_id}/seasons')
def show_seasons(
    show_id: str,
    missing_only: bool = Query(False),
    in_plex_only: bool = Query(False),
    new_only: bool = Query(False),
    upcoming_only: bool = Query(False),
) -> dict[str, Any]:
    now_dt = datetime.now(UTC)
    with get_conn() as conn:
        show = conn.execute(
            '''
            SELECT show_id, title, year, tmdb_show_id, image_url, plex_web_url
            FROM plex_shows
            WHERE show_id = ?
            ''',
            (show_id,),
        ).fetchone()
        if not show:
            raise HTTPException(status_code=404, detail='Show not found')

        show_data = dict(show)
        if not show_data['tmdb_show_id']:
            found = search_tv_show(show_data['title'], show_data.get('year'))
            if not found:
                plex_tmdb_id = _resolve_single_show_tmdb_from_plex(show_id)
                if plex_tmdb_id is None:
                    return {'show': show_data, 'items': []}
                show_data['tmdb_show_id'] = plex_tmdb_id
            else:
                show_data['tmdb_show_id'] = found['id']
            conn.execute(
                'UPDATE plex_shows SET tmdb_show_id = ?, image_url = COALESCE(image_url, ?), updated_at = ? WHERE show_id = ?',
                (
                    show_data['tmdb_show_id'],
                    (found['poster_url'] if found else None),
                    datetime.now(UTC).isoformat(),
                    show_id,
                ),
            )
            conn.commit()

        plex_rows = conn.execute(
            '''
            SELECT season_number, episode_number, season_plex_web_url
            FROM plex_show_episodes
            WHERE show_id = ?
            ''',
            (show_id,),
        ).fetchall()
        ignored_episode_keys = _get_ignored_episode_keys(conn, show_id)

    plex_by_season: dict[int, set[int]] = {}
    plex_season_urls: dict[int, str] = {}
    for row in plex_rows:
        season_no = int(row['season_number'])
        plex_by_season.setdefault(season_no, set()).add(int(row['episode_number']))
        season_url = row['season_plex_web_url']
        if season_url and season_no not in plex_season_urls:
            plex_season_urls[season_no] = season_url

    try:
        seasons = get_tv_show_seasons(int(show_data['tmdb_show_id']))
    except TMDbNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    items: list[dict[str, Any]] = []
    for season in seasons:
        season_no = int(season['season_number'])
        plex_eps = plex_by_season.get(season_no, set())
        total_eps = int(season.get('episode_count') or 0)
        in_plex_complete = False
        count_overflow = len(plex_eps) > total_eps
        next_upcoming_air_date: str | None = None
        missing_new_count = 0
        missing_old_count = 0
        missing_upcoming_count = 0
        try:
            season_episodes = get_tv_season_episodes(int(show_data['tmdb_show_id']), season_no)
        except TMDbNotConfiguredError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        upcoming_dates: list[str] = []
        for ep in season_episodes:
            ep_no = int(ep.get('episode_number') or 0)
            if ep_no <= 0 or ep_no in plex_eps:
                continue
            air_date = str(ep.get('air_date') or '').strip() or None
            status = _classify_missing_air_date(air_date, now_dt=now_dt)
            if status == 'missing' and (season_no, ep_no) in ignored_episode_keys:
                continue
            if status == 'new':
                missing_new_count += 1
            elif status == 'upcoming':
                missing_upcoming_count += 1
            elif status == 'missing':
                missing_old_count += 1
            # Episodes without air_date are ignored for status/counters.
            if status == 'upcoming' and air_date:
                upcoming_dates.append(air_date)
        if upcoming_dates:
            next_upcoming_air_date = min(upcoming_dates)
        in_plex_complete = (missing_new_count + missing_old_count + missing_upcoming_count) == 0
        status = 'in_plex'
        if missing_new_count > 0:
            status = 'new'
        elif missing_upcoming_count > 0:
            status = 'upcoming'
        elif missing_old_count > 0:
            status = 'missing'
        item = {
            **season,
            'in_plex': in_plex_complete,
            'episodes_in_plex': len(plex_eps),
            'count_overflow': count_overflow,
            'plex_web_url': plex_season_urls.get(season_no) or show_data.get('plex_web_url'),
            'next_upcoming_air_date': next_upcoming_air_date,
            'missing_new_count': missing_new_count,
            'missing_old_count': missing_old_count,
            'missing_upcoming_count': missing_upcoming_count,
            'status': status,
        }
        include = True
        if missing_only and (item['missing_old_count'] + item['missing_new_count']) <= 0:
            include = False
        if in_plex_only and not item['in_plex']:
            include = False
        if new_only and item['missing_new_count'] <= 0:
            include = False
        if upcoming_only and item['missing_upcoming_count'] <= 0:
            include = False
        if include:
            items.append(item)

    return {
        'show': show_data,
        'items': items,
        'missing_only': missing_only,
        'in_plex_only': in_plex_only,
        'new_only': new_only,
        'upcoming_only': upcoming_only,
    }


@app.get('/api/shows/{show_id}/seasons/{season_number}/episodes')
def show_season_episodes(
    show_id: str,
    season_number: int,
    missing_only: bool = Query(False),
    in_plex_only: bool = Query(False),
    new_only: bool = Query(False),
    upcoming_only: bool = Query(False),
) -> dict[str, Any]:
    now_dt = datetime.now(UTC)
    with get_conn() as conn:
        show = conn.execute(
            '''
            SELECT show_id, title, year, tmdb_show_id, image_url
            FROM plex_shows
            WHERE show_id = ?
            ''',
            (show_id,),
        ).fetchone()
        if not show:
            raise HTTPException(status_code=404, detail='Show not found')
        show_data = dict(show)
        if not show_data['tmdb_show_id']:
            found = search_tv_show(show_data['title'], show_data.get('year'))
            if not found:
                plex_tmdb_id = _resolve_single_show_tmdb_from_plex(show_id)
                if plex_tmdb_id is None:
                    return {'show': show_data, 'season_number': season_number, 'items': []}
                show_data['tmdb_show_id'] = plex_tmdb_id
            else:
                show_data['tmdb_show_id'] = found['id']
            conn.execute(
                'UPDATE plex_shows SET tmdb_show_id = ?, image_url = COALESCE(image_url, ?), updated_at = ? WHERE show_id = ?',
                (
                    show_data['tmdb_show_id'],
                    (found['poster_url'] if found else None),
                    datetime.now(UTC).isoformat(),
                    show_id,
                ),
            )
            conn.commit()

        plex_rows = conn.execute(
            '''
            SELECT episode_number, plex_rating_key, plex_web_url, tmdb_episode_id
            FROM plex_show_episodes
            WHERE show_id = ? AND season_number = ?
            ''',
            (show_id, season_number),
        ).fetchall()
        ignored_episode_keys = _get_ignored_episode_keys(conn, show_id, season_number)
        plex_episode_keys = {
            (season_number, int(row['episode_number']))
            for row in plex_rows
            if row['episode_number'] is not None and int(row['episode_number']) > 0
        }
        stale_ignored = ignored_episode_keys & plex_episode_keys
        if stale_ignored:
            conn.executemany(
                '''
                DELETE FROM ignored_episodes
                WHERE show_id = ? AND season_number = ? AND episode_number = ?
                ''',
                [(show_id, season_no, ep_no) for season_no, ep_no in stale_ignored],
            )
            conn.commit()
            ignored_episode_keys -= stale_ignored

    plex_by_ep = {int(r['episode_number']): dict(r) for r in plex_rows}
    plex_by_tmdb = {
        int(r['tmdb_episode_id']): dict(r)
        for r in plex_rows
        if r['tmdb_episode_id'] is not None
    }

    try:
        tmdb_episodes = get_tv_season_episodes(int(show_data['tmdb_show_id']), season_number)
    except TMDbNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    items: list[dict[str, Any]] = []
    for episode in tmdb_episodes:
        matched = None
        if episode.get('tmdb_id') is not None:
            matched = plex_by_tmdb.get(int(episode['tmdb_id']))
        if not matched:
            matched = plex_by_ep.get(int(episode['episode_number']))
        item = {
            **episode,
            'in_plex': bool(matched),
            'plex_rating_key': matched['plex_rating_key'] if matched else None,
            'plex_web_url': matched['plex_web_url'] if matched else None,
        }
        status = 'in_plex'
        if not item['in_plex']:
            status = _classify_missing_air_date(str(item.get('air_date') or '').strip() or None, now_dt=now_dt)
            if status == 'missing' and (season_number, int(episode.get('episode_number') or 0)) in ignored_episode_keys:
                status = 'ignored'
        is_upcoming = status == 'upcoming'
        is_new = status == 'new'
        is_ignored = status == 'ignored'
        include = True
        if missing_only and status not in {'missing', 'new'}:
            include = False
        if in_plex_only and not item['in_plex']:
            include = False
        if new_only and not is_new:
            include = False
        if upcoming_only and not is_upcoming:
            include = False
        item['status'] = status
        item['ignored'] = is_ignored
        if include:
            items.append(item)

    return {
        'show': show_data,
        'season_number': season_number,
        'items': items,
        'missing_only': missing_only,
        'in_plex_only': in_plex_only,
        'new_only': new_only,
        'upcoming_only': upcoming_only,
    }


@app.post('/api/shows/{show_id}/seasons/{season_number}/episodes/{episode_number}/ignore')
def set_show_episode_ignore(
    show_id: str,
    season_number: int,
    episode_number: int,
    payload: IgnoreEpisodePayload,
) -> dict[str, Any]:
    if season_number <= 0 or episode_number <= 0:
        raise HTTPException(status_code=400, detail='Invalid season or episode number')
    with get_conn() as conn:
        show = conn.execute(
            '''
            SELECT show_id
            FROM plex_shows
            WHERE show_id = ?
            ''',
            (show_id,),
        ).fetchone()
        if not show:
            raise HTTPException(status_code=404, detail='Show not found')
        _set_episode_ignored_state(conn, show_id, season_number, episode_number, payload.ignored)
        conn.commit()
    return {
        'ok': True,
        'show_id': show_id,
        'season_number': season_number,
        'episode_number': episode_number,
        'ignored': bool(payload.ignored),
    }


app.mount('/assets', StaticFiles(directory=STATIC_DIR), name='assets')


@app.get('/')
def root() -> FileResponse:
    return FileResponse(Path(STATIC_DIR) / 'index.html')


@app.get('/{full_path:path}')
def spa_fallback(full_path: str) -> FileResponse:
    if full_path.startswith('api/'):
        raise HTTPException(status_code=404, detail='Not Found')
    return FileResponse(Path(STATIC_DIR) / 'index.html')

