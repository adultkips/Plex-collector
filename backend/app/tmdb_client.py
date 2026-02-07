from __future__ import annotations

from typing import Any

import requests

from .config import TMDB_API_KEY, TMDB_IMAGE_BASE
from .db import get_setting

TMDB_BASE = 'https://api.themoviedb.org/3'


class TMDbNotConfiguredError(RuntimeError):
    pass


def get_tmdb_api_key() -> str:
    override = get_setting('tmdb_api_key', '')
    if isinstance(override, str) and override.strip():
        return override.strip()
    return TMDB_API_KEY


def _tmdb_get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    api_key = get_tmdb_api_key()
    if not api_key:
        raise TMDbNotConfiguredError('TMDB_API_KEY is missing in .env')

    query = {'api_key': api_key}
    if params:
        query.update(params)

    response = requests.get(f'{TMDB_BASE}{path}', params=query, timeout=25)
    response.raise_for_status()
    return response.json()


def search_person(name: str) -> dict[str, Any] | None:
    payload = _tmdb_get('/search/person', {'query': name, 'include_adult': 'false'})
    results = payload.get('results', [])
    if not results:
        return None

    acting_first = sorted(
        results,
        key=lambda p: (1 if p.get('known_for_department') == 'Acting' else 0, p.get('popularity', 0)),
        reverse=True,
    )
    person = acting_first[0]
    profile_path = person.get('profile_path')
    return {
        'id': person.get('id'),
        'name': person.get('name'),
        'image_url': f'{TMDB_IMAGE_BASE}{profile_path}' if profile_path else None,
    }


def get_person_movie_credits(person_id: int) -> list[dict[str, Any]]:
    payload = _tmdb_get(f'/person/{person_id}/movie_credits')
    cast = payload.get('cast', [])
    movies: list[dict[str, Any]] = []
    for movie in cast:
        title = movie.get('title')
        if not title:
            continue
        release = movie.get('release_date') or ''
        year = int(release[:4]) if len(release) >= 4 and release[:4].isdigit() else None
        poster_path = movie.get('poster_path')
        movies.append(
            {
                'tmdb_id': movie.get('id'),
                'title': title,
                'year': year,
                'poster_url': f'{TMDB_IMAGE_BASE}{poster_path}' if poster_path else None,
            }
        )

    movies.sort(key=lambda m: ((m['year'] or 0), m['title']), reverse=True)
    return movies
