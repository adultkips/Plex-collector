from __future__ import annotations

from datetime import datetime, UTC
from pathlib import Path
from typing import Any
from xml.etree.ElementTree import ParseError

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import requests
from requests import ConnectionError as RequestsConnectionError, RequestException

from .config import APP_NAME, APP_VERSION, PLEX_CLIENT_ID, STATIC_DIR, TMDB_API_KEY
from .db import clear_settings, get_conn, get_setting, init_db, set_setting
from .plex_client import (
    candidate_server_uris,
    check_pin,
    choose_preferred_server,
    fetch_movie_library_snapshot,
    get_account_profile,
    get_resources,
    pick_server_uri,
    start_pin,
)
from .tmdb_client import TMDbNotConfiguredError, get_person_movie_credits, search_person
from .tmdb_client import get_tmdb_api_key
from .utils import normalize_title

app = FastAPI(title=APP_NAME, version=APP_VERSION)


class TMDbKeyPayload(BaseModel):
    api_key: str


class ServerSelectPayload(BaseModel):
    client_identifier: str


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
        'scan_logs': get_setting('scan_logs', []),
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
            return Response(content=response.content, media_type=content_type)
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
    with get_conn() as conn:
        actor = conn.execute(
            'SELECT actor_id, name, tmdb_person_id FROM actors WHERE actor_id = ?',
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

        # Fallback only when title+year did not match:
        # try Plex original title to handle localized Plex titles.
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


app.mount('/assets', StaticFiles(directory=STATIC_DIR), name='assets')


@app.get('/')
def root() -> FileResponse:
    return FileResponse(Path(STATIC_DIR) / 'index.html')


@app.get('/{full_path:path}')
def spa_fallback(full_path: str) -> FileResponse:
    if full_path.startswith('api/'):
        raise HTTPException(status_code=404, detail='Not Found')
    return FileResponse(Path(STATIC_DIR) / 'index.html')
