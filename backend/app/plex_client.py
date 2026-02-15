from __future__ import annotations

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, UTC
from typing import Any
from urllib.parse import parse_qs, quote, urlparse, urlunparse
import xml.etree.ElementTree as ET

import requests
from requests import ConnectionError as RequestsConnectionError

from .config import (
    PLEX_CLIENT_ID,
    PLEX_DEVICE,
    PLEX_PLATFORM,
    PLEX_PRODUCT,
    PLEX_VERSION,
)
from .utils import cast_id_from_name, normalize_title

PLEX_BASE = 'https://plex.tv'


def _extract_external_ids(node: ET.Element) -> tuple[int | None, str | None]:
    tmdb_id: int | None = None
    imdb_id: str | None = None

    def consume_guid(raw: str | None) -> None:
        nonlocal tmdb_id, imdb_id
        if not raw:
            return
        guid = str(raw).strip().lower()
        if not guid:
            return

        if guid.startswith('tmdb://'):
            value = guid.removeprefix('tmdb://').strip()
            if value.isdigit():
                tmdb_id = int(value)
            return
        if 'tmdb://' in guid:
            value = guid.split('tmdb://', 1)[1].split('?', 1)[0].strip()
            if value.isdigit():
                tmdb_id = int(value)
            return

        if guid.startswith('imdb://'):
            imdb_value = guid.removeprefix('imdb://').strip()
            if imdb_value:
                imdb_id = imdb_value
            return
        if 'imdb://' in guid:
            imdb_value = guid.split('imdb://', 1)[1].split('?', 1)[0].strip()
            if imdb_value:
                imdb_id = imdb_value
            return

    consume_guid(node.attrib.get('guid'))
    for guid_node in node.findall('Guid'):
        consume_guid(guid_node.attrib.get('id'))
    return tmdb_id, imdb_id


def proxied_thumb_url(thumb_path: str | None) -> str | None:
    if not thumb_path:
        return None
    return f"/api/plex/image?thumb={quote(thumb_path, safe='')}"


def _normalize_actor_thumb(thumb: str | None) -> str | None:
    if not thumb:
        return None
    if thumb.startswith('http://') or thumb.startswith('https://'):
        return thumb
    return proxied_thumb_url(thumb)


def _build_cast_plex_web_url(
    server_client_identifier: str | None,
    section_key: str | None,
    cast_role: str,
    role_node: ET.Element,
) -> str | None:
    if not server_client_identifier:
        return None
    tag_key = str(role_node.attrib.get('tagKey') or '').strip()
    if tag_key:
        people_path = tag_key if tag_key.startswith('/library/people/') else f'/library/people/{tag_key}'
        return (
            'https://app.plex.tv/desktop#!/provider/tv.plex.provider.discover/details'
            f'?key={quote(people_path, safe="")}'
        )

    if not section_key:
        return None
    if cast_role == 'director':
        role_param = 'director'
    elif cast_role == 'writer':
        role_param = 'writer'
    else:
        role_param = 'actor'
    person_id = str(role_node.attrib.get('id') or '').strip()
    if not person_id.isdigit():
        legacy_tag_key = str(role_node.attrib.get('tagKey') or '').strip()
        if legacy_tag_key:
            parsed = urlparse(legacy_tag_key)
            query = parse_qs(parsed.query)
            person_values = query.get(role_param) or []
            if person_values:
                candidate = str(person_values[0]).strip()
                if candidate.isdigit():
                    person_id = candidate
    if not person_id.isdigit():
        return None
    return (
        'https://app.plex.tv/desktop#!/server/'
        f'{server_client_identifier}/library/sections/{section_key}/all?type=1&{role_param}={person_id}'
    )


def _plex_headers(token: str | None = None) -> dict[str, str]:
    headers = {
        'Accept': 'application/json',
        'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
        'X-Plex-Product': PLEX_PRODUCT,
        'X-Plex-Version': PLEX_VERSION,
        'X-Plex-Platform': PLEX_PLATFORM,
        'X-Plex-Device': PLEX_DEVICE,
    }
    if token:
        headers['X-Plex-Token'] = token
    return headers


def start_pin() -> dict[str, Any]:
    response = requests.post(
        f'{PLEX_BASE}/api/v2/pins',
        headers=_plex_headers(),
        params={'strong': 'true'},
        timeout=20,
    )
    response.raise_for_status()
    payload = response.json()

    code = payload['code']
    pin_id = payload['id']
    login_url = (
        'https://app.plex.tv/auth#?'
        f'clientID={quote(PLEX_CLIENT_ID)}&code={quote(code)}&context%5Bdevice%5D%5Bproduct%5D={quote(PLEX_PRODUCT)}'
    )
    return {'pin_id': pin_id, 'code': code, 'login_url': login_url}


def check_pin(pin_id: int) -> dict[str, Any]:
    response = requests.get(
        f'{PLEX_BASE}/api/v2/pins/{pin_id}',
        headers=_plex_headers(),
        timeout=20,
    )
    response.raise_for_status()
    payload = response.json()
    return {
        'authenticated': bool(payload.get('authToken')),
        'auth_token': payload.get('authToken'),
    }


def get_account_profile(auth_token: str) -> dict[str, Any]:
    response = requests.get(
        f'{PLEX_BASE}/users/account.json',
        headers=_plex_headers(auth_token),
        timeout=20,
    )
    response.raise_for_status()
    user = response.json()['user']
    return {
        'id': user.get('id'),
        'username': user.get('username') or user.get('title'),
        'email': user.get('email'),
        'title': user.get('title'),
        'thumb': user.get('thumb'),
    }


def get_resources(auth_token: str) -> list[dict[str, Any]]:
    response = requests.get(
        f'{PLEX_BASE}/api/resources',
        headers=_plex_headers(auth_token),
        params={'includeHttps': 1},
        timeout=30,
    )
    response.raise_for_status()

    root = ET.fromstring(response.text)
    resources: list[dict[str, Any]] = []
    for device in root.findall('Device'):
        provides = device.attrib.get('provides', '')
        if 'server' not in provides:
            continue

        token = device.attrib.get('accessToken') or auth_token
        connections = []
        for conn in device.findall('Connection'):
            connections.append(
                {
                    'uri': conn.attrib.get('uri'),
                    'address': conn.attrib.get('address'),
                    'port': conn.attrib.get('port'),
                    'protocol': conn.attrib.get('protocol'),
                    'local': conn.attrib.get('local') == '1',
                    'relay': conn.attrib.get('relay') == '1',
                }
            )

        resources.append(
            {
                'name': device.attrib.get('name'),
                'client_identifier': device.attrib.get('clientIdentifier'),
                'owned': device.attrib.get('owned') == '1',
                'access_token': token,
                'connections': connections,
            }
        )
    return resources


def choose_preferred_server(resources: list[dict[str, Any]]) -> dict[str, Any] | None:
    def rank(server: dict[str, Any]) -> tuple[int, int]:
        local_count = sum(1 for c in server['connections'] if c['local'] and not c['relay'])
        return (1 if server['owned'] else 0, local_count)

    ranked = sorted(resources, key=rank, reverse=True)
    return ranked[0] if ranked else None


def pick_server_uri(server: dict[str, Any]) -> str | None:
    def with_ip_fallback(conn: dict[str, Any]) -> str | None:
        uri = conn.get('uri')
        if not uri:
            return None
        parsed = urlparse(uri)
        host = parsed.hostname or ''
        if host.endswith('.plex.direct') and conn.get('address') and conn.get('port'):
            # Prefer direct LAN IP if plex.direct host cannot be resolved locally.
            return f"http://{conn['address']}:{conn['port']}"
        return uri

    for conn in server['connections']:
        if conn['local'] and not conn['relay']:
            candidate = with_ip_fallback(conn)
            if candidate:
                return candidate
    for conn in server['connections']:
        if not conn['relay']:
            candidate = with_ip_fallback(conn)
            if candidate:
                return candidate
    if not server['connections']:
        return None
    return with_ip_fallback(server['connections'][0])


def _host_ip_from_plex_direct(host: str) -> str | None:
    if not host.endswith('.plex.direct'):
        return None
    prefix = host.split('.', 1)[0]
    if not prefix:
        return None
    ip_candidate = prefix.replace('-', '.')
    parts = ip_candidate.split('.')
    if len(parts) != 4:
        return None
    if not all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
        return None
    return ip_candidate


def _fallback_uri_from_plex_direct(uri: str) -> str | None:
    parsed = urlparse(uri)
    if not parsed.hostname:
        return None
    ip = _host_ip_from_plex_direct(parsed.hostname)
    if not ip:
        return None
    port = parsed.port or 32400
    return urlunparse(('http', f'{ip}:{port}', parsed.path, '', parsed.query, ''))


def candidate_server_uris(server: dict[str, Any]) -> list[str]:
    candidates: list[str] = []

    def add(value: str | None) -> None:
        if value and value not in candidates:
            candidates.append(value)

    ordered_connections = sorted(
        server.get('connections', []),
        key=lambda c: (1 if c.get('local') else 0, 0 if c.get('relay') else 1),
        reverse=True,
    )

    for conn in ordered_connections:
        uri = conn.get('uri')
        add(uri)

        address = conn.get('address')
        port = conn.get('port') or '32400'
        protocol = conn.get('protocol') or 'https'
        if address:
            add(f'{protocol}://{address}:{port}')
            add(f'http://{address}:{port}')
            add(f'https://{address}:{port}')

        add(_fallback_uri_from_plex_direct(uri) if uri else None)

    add(pick_server_uri(server))
    return candidates


def _server_get(uri: str, token: str, path: str, params: dict[str, Any] | None = None) -> ET.Element:
    target = f"{uri}{path}"
    headers = _plex_headers(token)
    headers['Accept'] = 'application/xml'
    try:
        response = requests.get(
            target,
            headers=headers,
            params=params,
            timeout=(6, 90),
        )
        response.raise_for_status()
        body = response.text.lstrip()
        if not body.startswith('<'):
            raise RequestsConnectionError(f'Unexpected non-XML response from Plex endpoint: {target}')
        return ET.fromstring(response.text)
    except RequestsConnectionError:
        fallback_base = _fallback_uri_from_plex_direct(uri)
        if not fallback_base:
            raise

        fallback_target = f"{fallback_base}{path}"
        response = requests.get(
            fallback_target,
            headers=headers,
            params=params,
            timeout=(6, 90),
        )
        response.raise_for_status()
        body = response.text.lstrip()
        if not body.startswith('<'):
            raise RequestsConnectionError(f'Unexpected non-XML response from Plex endpoint: {fallback_target}')
        return ET.fromstring(response.text)


def _server_put(uri: str, token: str, path: str, params: dict[str, Any] | None = None) -> None:
    target = f"{uri}{path}"
    headers = _plex_headers(token)
    headers['Accept'] = 'application/xml'
    try:
        response = requests.put(
            target,
            headers=headers,
            params=params,
            timeout=(6, 90),
        )
        response.raise_for_status()
    except RequestsConnectionError:
        fallback_base = _fallback_uri_from_plex_direct(uri)
        if not fallback_base:
            raise
        fallback_target = f"{fallback_base}{path}"
        response = requests.put(
            fallback_target,
            headers=headers,
            params=params,
            timeout=(6, 90),
        )
        response.raise_for_status()


def _server_post(uri: str, token: str, path: str, params: dict[str, Any] | None = None) -> None:
    target = f"{uri}{path}"
    headers = _plex_headers(token)
    headers['Accept'] = 'application/xml'
    try:
        response = requests.post(
            target,
            headers=headers,
            params=params,
            timeout=(6, 90),
        )
        response.raise_for_status()
    except RequestsConnectionError:
        fallback_base = _fallback_uri_from_plex_direct(uri)
        if not fallback_base:
            raise
        fallback_target = f"{fallback_base}{path}"
        response = requests.post(
            fallback_target,
            headers=headers,
            params=params,
            timeout=(6, 90),
        )
        response.raise_for_status()


def fetch_movie_library_snapshot(
    server_uri: str,
    server_token: str,
    server_client_identifier: str | None = None,
    roles_to_scan: set[str] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    enabled_roles = set(roles_to_scan or {'actor', 'director', 'writer'})
    enabled_roles = {role for role in enabled_roles if role in {'actor', 'director', 'writer'}}
    if not enabled_roles:
        enabled_roles = {'actor'}
    sections_root = _server_get(server_uri, server_token, '/library/sections')
    movie_sections = [
        s for s in sections_root.findall('Directory') if s.attrib.get('type') == 'movie'
    ]

    cast_counter: Counter[tuple[str, str]] = Counter()
    cast_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    movie_rating_keys: list[str] = []
    seen_movie_rating_keys: set[str] = set()
    movies: list[dict[str, Any]] = []

    for section in movie_sections:
        section_key = section.attrib.get('key')
        if not section_key:
            continue

        all_root = _server_get(
            server_uri,
            server_token,
            f'/library/sections/{section_key}/all',
            params={'type': 1},
        )

        for video in all_root.findall('Video'):
            title = video.attrib.get('title')
            if not title:
                continue
            year_raw = video.attrib.get('year')
            year = int(year_raw) if year_raw and year_raw.isdigit() else None
            original_title = video.attrib.get('originalTitle')
            rating_key = video.attrib.get('ratingKey')
            if not rating_key:
                continue
            if rating_key in seen_movie_rating_keys:
                continue
            seen_movie_rating_keys.add(rating_key)
            movie_rating_keys.append(rating_key)
            tmdb_id, imdb_id = _extract_external_ids(video)

            movies.append(
                {
                    'plex_rating_key': rating_key,
                    'library_section_id': section_key,
                    'title': title,
                    'original_title': original_title,
                    'year': year,
                    'tmdb_id': tmdb_id,
                    'imdb_id': imdb_id,
                    'normalized_title': normalize_title(title),
                    'normalized_original_title': normalize_title(original_title) if original_title else None,
                    'plex_web_url': (
                        f'https://app.plex.tv/desktop#!/server/{server_client_identifier}/details?key=%2Flibrary%2Fmetadata%2F{rating_key}'
                        if server_client_identifier
                        else None
                    ),
                }
            )

            role_nodes = []
            if 'actor' in enabled_roles:
                role_nodes.append(('actor', video.findall('Role')))
            if 'director' in enabled_roles:
                role_nodes.append(('director', video.findall('Director')))
            if 'writer' in enabled_roles:
                role_nodes.append(('writer', video.findall('Writer')))
            for cast_role, nodes in role_nodes:
                for node in nodes:
                    person_name = node.attrib.get('tag')
                    if not person_name:
                        continue
                    key = (cast_role, person_name)
                    if key not in cast_by_key:
                        cast_by_key[key] = {
                            'actor_id': cast_id_from_name(cast_role, person_name),
                            'name': person_name,
                            'role': cast_role,
                            'image_url': _normalize_actor_thumb(node.attrib.get('thumb')),
                            'plex_web_url': _build_cast_plex_web_url(
                                server_client_identifier,
                                section_key,
                                cast_role,
                                node,
                            ),
                        }

    # Count actor appearances from full movie metadata (not section listing),
    # because section listing can return truncated cast information.
    if movie_rating_keys:
        movie_by_rating_key = {str(movie['plex_rating_key']): movie for movie in movies}
        chunk_size = 40
        for idx in range(0, len(movie_rating_keys), chunk_size):
            batch = movie_rating_keys[idx : idx + chunk_size]
            batch_root = _server_get(
                server_uri,
                server_token,
                f"/library/metadata/{','.join(batch)}",
            )
            for video in batch_root.findall('Video'):
                rating_key = str(video.attrib.get('ratingKey') or '')
                if rating_key and rating_key in movie_by_rating_key:
                    tmdb_id, imdb_id = _extract_external_ids(video)
                    movie_ref = movie_by_rating_key[rating_key]
                    if tmdb_id is not None:
                        movie_ref['tmdb_id'] = tmdb_id
                    if imdb_id:
                        movie_ref['imdb_id'] = imdb_id

                seen_in_movie_by_role: dict[str, set[str]] = {role: set() for role in enabled_roles}
                role_nodes = []
                if 'actor' in enabled_roles:
                    role_nodes.append(('actor', video.findall('Role')))
                if 'director' in enabled_roles:
                    role_nodes.append(('director', video.findall('Director')))
                if 'writer' in enabled_roles:
                    role_nodes.append(('writer', video.findall('Writer')))
                for cast_role, nodes in role_nodes:
                    for node in nodes:
                        person_name = node.attrib.get('tag')
                        if not person_name:
                            continue
                        key = (cast_role, person_name)
                        if person_name in seen_in_movie_by_role[cast_role] or key not in cast_by_key:
                            continue
                        seen_in_movie_by_role[cast_role].add(person_name)
                        cast_counter[key] += 1

                        thumb_url = _normalize_actor_thumb(node.attrib.get('thumb'))
                        if thumb_url and not cast_by_key[key].get('image_url'):
                            cast_by_key[key]['image_url'] = thumb_url
                        if not cast_by_key[key].get('plex_web_url'):
                            cast_by_key[key]['plex_web_url'] = _build_cast_plex_web_url(
                                server_client_identifier,
                                movie_ref.get('library_section_id'),
                                cast_role,
                                node,
                            )

    now = datetime.now(UTC).isoformat()
    actors = []
    for cast_key, count in cast_counter.items():
        base = cast_by_key[cast_key]
        actors.append(
            {
                'actor_id': base['actor_id'],
                'name': base['name'],
                'role': base['role'],
                'appearances': count,
                'image_url': base['image_url'],
                'plex_web_url': base.get('plex_web_url'),
                'updated_at': now,
            }
        )

    for movie in movies:
        movie['updated_at'] = now

    actors.sort(key=lambda x: (-x['appearances'], x['name']))
    return actors, movies


def append_collection_to_movies(
    server_uri: str,
    server_token: str,
    section_id: str,
    rating_keys: list[str],
    collection_name: str,
) -> dict[str, Any]:
    collection_name = collection_name.strip()
    if not collection_name:
        return {'updated': 0, 'unchanged': 0}
    unique_rating_keys = [rk for rk in dict.fromkeys(rating_keys) if rk]
    if not unique_rating_keys:
        return {'updated': 0, 'unchanged': 0}

    existing_collections: dict[str, list[str]] = {}
    chunk_size = 40
    for idx in range(0, len(unique_rating_keys), chunk_size):
        batch = unique_rating_keys[idx : idx + chunk_size]
        batch_root = _server_get(
            server_uri,
            server_token,
            f"/library/metadata/{','.join(batch)}",
        )
        for video in batch_root.findall('Video'):
            rating_key = video.attrib.get('ratingKey')
            if not rating_key:
                continue
            names: list[str] = []
            for node in video.findall('Collection'):
                name = node.attrib.get('tag')
                if not name:
                    continue
                if name not in names:
                    names.append(name)
            existing_collections[rating_key] = names

    updated = 0
    unchanged = 0
    for rating_key in unique_rating_keys:
        existing = existing_collections.get(rating_key, [])
        if collection_name in existing:
            unchanged += 1
            continue
        tags = [*existing, collection_name]
        params: dict[str, Any] = {
            'type': 1,
            'id': rating_key,
            'includeExternalMedia': 1,
        }
        for index, tag in enumerate(tags):
            params[f'collection[{index}].tag.tag'] = tag
        _server_put(
            server_uri,
            server_token,
            f'/library/sections/{section_id}/all',
            params=params,
        )
        updated += 1

    return {'updated': updated, 'unchanged': unchanged}


def create_smart_collection_for_person(
    server_uri: str,
    server_token: str,
    server_client_identifier: str,
    section_id: str,
    collection_name: str,
    role: str,
    person_name: str,
) -> dict[str, int]:
    collection_name = collection_name.strip()
    if not collection_name:
        return {'updated': 0, 'unchanged': 0}
    role_key = (role or '').strip().lower()
    if role_key not in {'actor', 'director', 'writer'}:
        return {'updated': 0, 'unchanged': 0}
    person_name = person_name.strip()
    if not person_name:
        return {'updated': 0, 'unchanged': 0}

    # Avoid duplicate smart collections with same title in section.
    existing_root = _server_get(
        server_uri,
        server_token,
        f'/library/sections/{section_id}/all',
        params={'type': 18},
    )
    for directory in existing_root.findall('Directory'):
        title = str(directory.attrib.get('title') or '').strip()
        if title.lower() == collection_name.lower():
            return {'updated': 0, 'unchanged': 1}

    uri = (
        f'server://{server_client_identifier}/com.plexapp.plugins.library/library/sections/{section_id}/all'
        f'?type=1&{role_key}={quote(person_name, safe="")}'
    )
    _server_post(
        server_uri,
        server_token,
        '/library/collections',
        params={
            'type': 1,
            'title': collection_name,
            'smart': 1,
            'sectionId': section_id,
            'uri': uri,
        },
    )
    return {'updated': 1, 'unchanged': 0}


def resolve_movie_section_ids(
    server_uri: str,
    server_token: str,
    rating_keys: list[str],
) -> dict[str, str]:
    unique_rating_keys = [rk for rk in dict.fromkeys(rating_keys) if rk]
    if not unique_rating_keys:
        return {}
    resolved: dict[str, str] = {}
    chunk_size = 40
    for idx in range(0, len(unique_rating_keys), chunk_size):
        batch = unique_rating_keys[idx : idx + chunk_size]
        batch_root = _server_get(
            server_uri,
            server_token,
            f"/library/metadata/{','.join(batch)}",
        )
        for video in batch_root.findall('Video'):
            rating_key = video.attrib.get('ratingKey')
            section_id = video.attrib.get('librarySectionID')
            if rating_key and section_id:
                resolved[str(rating_key)] = str(section_id)
    return resolved


def resolve_show_tmdb_ids(
    server_uri: str,
    server_token: str,
    show_rating_keys: list[str],
) -> dict[str, int]:
    unique_rating_keys = [rk for rk in dict.fromkeys(show_rating_keys) if rk]
    if not unique_rating_keys:
        return {}
    resolved: dict[str, int] = {}
    chunk_size = 40
    for idx in range(0, len(unique_rating_keys), chunk_size):
        batch = unique_rating_keys[idx : idx + chunk_size]
        batch_root = _server_get(
            server_uri,
            server_token,
            f"/library/metadata/{','.join(batch)}",
        )
        for directory in batch_root.findall('Directory'):
            rating_key = directory.attrib.get('ratingKey')
            if not rating_key:
                continue
            tmdb_id, _ = _extract_external_ids(directory)
            if tmdb_id is not None:
                resolved[str(rating_key)] = int(tmdb_id)
        for video in batch_root.findall('Video'):
            rating_key = video.attrib.get('ratingKey')
            if not rating_key:
                continue
            tmdb_id, _ = _extract_external_ids(video)
            if tmdb_id is not None:
                resolved[str(rating_key)] = int(tmdb_id)
    return resolved




def fetch_show_library_snapshot(
    server_uri: str,
    server_token: str,
    server_client_identifier: str | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    sections_root = _server_get(server_uri, server_token, '/library/sections')
    show_sections = [
        s for s in sections_root.findall('Directory') if s.attrib.get('type') == 'show'
    ]

    shows_by_rating_key: dict[str, dict[str, Any]] = {}
    episodes: list[dict[str, Any]] = []

    for section in show_sections:
        section_key = section.attrib.get('key')
        if not section_key:
            continue

        # Fetch show and episode listings concurrently per section to reduce
        # total scan latency without changing scan output.
        with ThreadPoolExecutor(max_workers=2) as pool:
            shows_future = pool.submit(
                _server_get,
                server_uri,
                server_token,
                f'/library/sections/{section_key}/all',
                {'type': 2},
            )
            episodes_future = pool.submit(
                _server_get,
                server_uri,
                server_token,
                f'/library/sections/{section_key}/all',
                {'type': 4},
            )
            shows_root = shows_future.result()
            episodes_root = episodes_future.result()

        for directory in shows_root.findall('Directory'):
            title = directory.attrib.get('title')
            rating_key = directory.attrib.get('ratingKey')
            if not title or not rating_key:
                continue

            year_raw = directory.attrib.get('year')
            year = int(year_raw) if year_raw and year_raw.isdigit() else None
            show_tmdb_id, _ = _extract_external_ids(directory)
            shows_by_rating_key[rating_key] = {
                'show_id': rating_key,
                'plex_rating_key': rating_key,
                'title': title,
                'year': year,
                'tmdb_show_id': show_tmdb_id,
                'normalized_title': normalize_title(title),
                'image_url': proxied_thumb_url(directory.attrib.get('thumb')),
                'plex_web_url': (
                    f'https://app.plex.tv/desktop#!/server/{server_client_identifier}/details?key=%2Flibrary%2Fmetadata%2F{rating_key}'
                    if server_client_identifier
                    else None
                ),
            }

        for video in episodes_root.findall('Video'):
            episode_rating_key = video.attrib.get('ratingKey')
            show_rating_key = video.attrib.get('grandparentRatingKey')
            if not episode_rating_key or not show_rating_key:
                continue

            season_raw = video.attrib.get('parentIndex')
            episode_raw = video.attrib.get('index')
            if not season_raw or not season_raw.isdigit() or not episode_raw or not episode_raw.isdigit():
                continue

            title = video.attrib.get('title') or f'Episode {episode_raw}'
            episode_tmdb_id, _ = _extract_external_ids(video)
            episodes.append(
                {
                    'plex_rating_key': episode_rating_key,
                    'show_id': show_rating_key,
                    'season_number': int(season_raw),
                    'episode_number': int(episode_raw),
                    'title': title,
                    'normalized_title': normalize_title(title),
                    'tmdb_episode_id': episode_tmdb_id,
                    'season_plex_web_url': (
                        f'https://app.plex.tv/desktop#!/server/{server_client_identifier}/details?key=%2Flibrary%2Fmetadata%2F{video.attrib.get("parentRatingKey")}'
                        if server_client_identifier and video.attrib.get('parentRatingKey')
                        else None
                    ),
                    'plex_web_url': (
                        f'https://app.plex.tv/desktop#!/server/{server_client_identifier}/details?key=%2Flibrary%2Fmetadata%2F{episode_rating_key}'
                        if server_client_identifier
                        else None
                    ),
                }
            )

    # Ensure show title data exists for episodes even if /type=2 missed an item.
    for episode in episodes:
        show_id = episode['show_id']
        if show_id in shows_by_rating_key:
            continue
        shows_by_rating_key[show_id] = {
            'show_id': show_id,
            'plex_rating_key': show_id,
            'title': f'Show {show_id}',
            'year': None,
            'tmdb_show_id': None,
            'normalized_title': normalize_title(f'Show {show_id}'),
            'image_url': None,
            'plex_web_url': (
                f'https://app.plex.tv/desktop#!/server/{server_client_identifier}/details?key=%2Flibrary%2Fmetadata%2F{show_id}'
                if server_client_identifier
                else None
            ),
        }

    now = datetime.now(UTC).isoformat()
    shows = []
    for show in shows_by_rating_key.values():
        shows.append({**show, 'updated_at': now})
    for episode in episodes:
        episode['updated_at'] = now

    shows.sort(key=lambda x: x['title'].lower())
    return shows, episodes
