from __future__ import annotations

from datetime import datetime, UTC
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
VALID_DOWNLOAD_MODES = {'encoded_space', 'hyphen'}


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
        conn.execute('DELETE FROM actors')
        conn.execute('DELETE FROM plex_movies')

        conn.executemany(
            '''
            INSERT INTO actors(actor_id, name, appearances, tmdb_person_id, image_url, updated_at)
            VALUES(:actor_id, :name, :appearances, :tmdb_person_id, :image_url, :updated_at)
            ''',
            actors,
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
) -> dict[str, Any]:
    with get_conn() as conn:
        actor = conn.execute(
            'SELECT actor_id, name, tmdb_person_id, image_url FROM actors WHERE actor_id = ?',
            (actor_id,),
        ).fetchone()
        if not actor:
            raise HTTPException(status_code=404, detail='Actor not found')

        actor_data = dict(actor)
        if not actor_data['tmdb_person_id']:
            person = search_person(actor_data['name'])
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

    plex_by_key = {(r['normalized_title'], r['year']): dict(r) for r in plex_rows}
    plex_by_tmdb_id = {r['tmdb_id']: dict(r) for r in plex_rows if r['tmdb_id'] is not None}
    plex_title_buckets: dict[str, list[dict[str, Any]]] = {}
    plex_original_title_buckets: dict[str, list[dict[str, Any]]] = {}
    for row in plex_rows:
        plex_title_buckets.setdefault(row['normalized_title'], []).append(dict(row))
        if row['normalized_original_title']:
            plex_original_title_buckets.setdefault(row['normalized_original_title'], []).append(dict(row))

    try:
        credits = get_person_movie_credits(actor_data['tmdb_person_id'])
    except TMDbNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    results = []
    for movie in credits:
        normalized = normalize_title(movie['title'])
        matched = plex_by_tmdb_id.get(movie['tmdb_id']) if movie.get('tmdb_id') is not None else None
        if not matched:
            matched = plex_by_key.get((normalized, movie['year']))
        if not matched:
            candidates = plex_title_buckets.get(normalized, [])
            if candidates and movie['year'] is not None:
                close = [c for c in candidates if c['year'] and abs(c['year'] - movie['year']) <= 1]
                if close:
                    matched = close[0]
            elif candidates:
                matched = candidates[0]

        if not matched:
            original_candidates = plex_original_title_buckets.get(normalized, [])
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
        include_item = True
        if missing_only and item['in_plex']:
            include_item = False
        if in_plex_only and not item['in_plex']:
            include_item = False
        if include_item:
            results.append(item)

    return {
        'actor': actor_data,
        'items': results,
        'missing_only': missing_only,
        'in_plex_only': in_plex_only,
    }


def upsert_shows_and_episodes(shows: list[dict[str, Any]], episodes: list[dict[str, Any]]) -> None:
    with get_conn() as conn:
        existing_rows = conn.execute(
            '''
            SELECT show_id, tmdb_show_id, has_missing_episodes, missing_scan_at
            FROM plex_shows
            '''
        ).fetchall()
        existing_by_id = {str(row['show_id']): dict(row) for row in existing_rows}

        prepared_shows: list[dict[str, Any]] = []
        for show in shows:
            prepared = dict(show)
            previous = existing_by_id.get(str(prepared.get('show_id')))
            if previous:
                previous_tmdb = previous.get('tmdb_show_id')
                current_tmdb = prepared.get('tmdb_show_id')
                same_tmdb_match = previous_tmdb == current_tmdb
                if same_tmdb_match:
                    prepared['has_missing_episodes'] = previous.get('has_missing_episodes')
                    prepared['missing_scan_at'] = previous.get('missing_scan_at')
                else:
                    # TMDb match changed for this show; previous missing-state may be stale.
                    prepared['has_missing_episodes'] = None
                    prepared['missing_scan_at'] = None
            else:
                prepared['has_missing_episodes'] = None
                prepared['missing_scan_at'] = None
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
                missing_scan_at,
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
                :missing_scan_at,
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
        conn.execute('DELETE FROM settings')
        conn.commit()
    return {'ok': True}


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
def scan_actors() -> dict[str, Any]:
    auth_token, server = ensure_auth()

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

    now_iso = datetime.now(UTC).isoformat()
    results: list[dict[str, Any]] = []
    updates: list[tuple[int, str, str, str]] = []
    missing_total = 0
    failed_total = 0
    scanned_total = 0

    for show_id in unique_show_ids:
        show = shows_by_id.get(show_id)
        if not show:
            failed_total += 1
            results.append(
                {
                    'show_id': show_id,
                    'has_missing_episodes': None,
                    'missing_episode_count': None,
                    'missing_scan_at': None,
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
                    failed_total += 1
                    results.append(
                        {
                            'show_id': show_id,
                            'has_missing_episodes': None,
                            'missing_episode_count': None,
                            'missing_scan_at': None,
                            'error': 'TMDb match not found',
                        }
                    )
                    continue
                tmdb_show_id = int(found['id'])
                with get_conn() as conn:
                    conn.execute(
                        'UPDATE plex_shows SET tmdb_show_id = ?, updated_at = ? WHERE show_id = ?',
                        (tmdb_show_id, now_iso, show_id),
                    )
                    conn.commit()

            with get_conn() as conn:
                plex_episode_rows = conn.execute(
                    '''
                    SELECT season_number, episode_number
                    FROM plex_show_episodes
                    WHERE show_id = ?
                    ''',
                    (show_id,),
                ).fetchall()
            plex_episode_set = {
                (int(row['season_number']), int(row['episode_number']))
                for row in plex_episode_rows
                if row['season_number'] is not None
                and row['episode_number'] is not None
                and int(row['season_number']) > 0
                and int(row['episode_number']) > 0
            }

            tmdb_episode_set: set[tuple[int, int]] = set()
            seasons = get_tv_show_seasons(int(tmdb_show_id))
            for season in seasons:
                season_number = int(season.get('season_number') or 0)
                if season_number <= 0:
                    continue
                episodes = get_tv_season_episodes(int(tmdb_show_id), season_number)
                for episode in episodes:
                    episode_number = int(episode.get('episode_number') or 0)
                    if episode_number <= 0:
                        continue
                    tmdb_episode_set.add((season_number, episode_number))

            missing_episode_count = len(tmdb_episode_set - plex_episode_set)
            has_missing = 1 if missing_episode_count > 0 else 0
            if has_missing:
                missing_total += 1
            updates.append((has_missing, now_iso, now_iso, show_id))
            results.append(
                {
                    'show_id': show_id,
                    'has_missing_episodes': bool(has_missing),
                    'missing_episode_count': missing_episode_count,
                    'missing_scan_at': now_iso,
                    'error': None,
                }
            )
        except TMDbNotConfiguredError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            failed_total += 1
            results.append(
                {
                    'show_id': show_id,
                    'has_missing_episodes': None,
                    'missing_episode_count': None,
                    'missing_scan_at': None,
                    'error': str(exc),
                }
            )

    if updates:
        with get_conn() as conn:
            conn.executemany(
                '''
                UPDATE plex_shows
                SET has_missing_episodes = ?, missing_scan_at = ?, updated_at = ?
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


@app.get('/api/plex/image')
def plex_image(thumb: str = Query(...)) -> Response:
    _, server = ensure_auth()
    thumb_path = thumb if thumb.startswith('/') else f'/{thumb}'
    uris_to_try = candidate_server_uris(server)
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
                timeout=(6, 30),
            )
            response.raise_for_status()
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
            continue

    raise HTTPException(status_code=404, detail='Plex image could not be loaded') from last_error


@app.get('/api/actors')
def actors() -> dict[str, Any]:
    with get_conn() as conn:
        rows = conn.execute(
            '''
            SELECT actor_id, name, appearances, tmdb_person_id, image_url, updated_at
            FROM actors
            ORDER BY appearances DESC, name ASC
            '''
        ).fetchall()

    return {
        'items': [dict(r) for r in rows],
        'last_scan_at': get_setting('last_scan_at'),
    }


@app.get('/api/actors/{actor_id}/movies')
def actor_movies(
    actor_id: str,
    missing_only: bool = Query(False),
    in_plex_only: bool = Query(False),
) -> dict[str, Any]:
    return _build_actor_movies_payload(actor_id, missing_only, in_plex_only)


@app.post('/api/collections/create-from-actor')
def create_collection_from_actor(payload: CreateCollectionPayload) -> dict[str, Any]:
    _, server = ensure_auth()
    actor_payload = _build_actor_movies_payload(payload.actor_id, False, True)
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
                s.missing_scan_at,
                s.updated_at,
                COUNT(e.plex_rating_key) AS episodes_in_plex
            FROM plex_shows s
            LEFT JOIN plex_show_episodes e ON e.show_id = s.show_id
            GROUP BY s.show_id, s.title, s.year, s.image_url, s.plex_web_url, s.has_missing_episodes, s.missing_scan_at, s.updated_at
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
) -> dict[str, Any]:
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
                return {'show': show_data, 'items': []}
            show_data['tmdb_show_id'] = found['id']
            conn.execute(
                'UPDATE plex_shows SET tmdb_show_id = ?, image_url = COALESCE(image_url, ?), updated_at = ? WHERE show_id = ?',
                (found['id'], found['poster_url'], datetime.now(UTC).isoformat(), show_id),
            )
            conn.commit()

        plex_rows = conn.execute(
            '''
            SELECT season_number, episode_number
            FROM plex_show_episodes
            WHERE show_id = ?
            ''',
            (show_id,),
        ).fetchall()

    plex_by_season: dict[int, set[int]] = {}
    for row in plex_rows:
        plex_by_season.setdefault(int(row['season_number']), set()).add(int(row['episode_number']))

    try:
        seasons = get_tv_show_seasons(int(show_data['tmdb_show_id']))
    except TMDbNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    items: list[dict[str, Any]] = []
    for season in seasons:
        season_no = int(season['season_number'])
        plex_eps = plex_by_season.get(season_no, set())
        total_eps = int(season.get('episode_count') or 0)
        in_plex_complete = total_eps > 0 and len(plex_eps) >= total_eps
        item = {
            **season,
            'in_plex': in_plex_complete,
            'episodes_in_plex': len(plex_eps),
        }
        include = True
        if missing_only and item['in_plex']:
            include = False
        if in_plex_only and not item['in_plex']:
            include = False
        if include:
            items.append(item)

    return {
        'show': show_data,
        'items': items,
        'missing_only': missing_only,
        'in_plex_only': in_plex_only,
    }


@app.get('/api/shows/{show_id}/seasons/{season_number}/episodes')
def show_season_episodes(
    show_id: str,
    season_number: int,
    missing_only: bool = Query(False),
    in_plex_only: bool = Query(False),
) -> dict[str, Any]:
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
                return {'show': show_data, 'season_number': season_number, 'items': []}
            show_data['tmdb_show_id'] = found['id']
            conn.execute(
                'UPDATE plex_shows SET tmdb_show_id = ?, image_url = COALESCE(image_url, ?), updated_at = ? WHERE show_id = ?',
                (found['id'], found['poster_url'], datetime.now(UTC).isoformat(), show_id),
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
        include = True
        if missing_only and item['in_plex']:
            include = False
        if in_plex_only and not item['in_plex']:
            include = False
        if include:
            items.append(item)

    return {
        'show': show_data,
        'season_number': season_number,
        'items': items,
        'missing_only': missing_only,
        'in_plex_only': in_plex_only,
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
