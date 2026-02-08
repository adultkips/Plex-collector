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


def search_tv_show(name: str, year: int | None = None) -> dict[str, Any] | None:
    params: dict[str, Any] = {'query': name, 'include_adult': 'false'}
    if year:
        params['first_air_date_year'] = year
    payload = _tmdb_get('/search/tv', params)
    results = payload.get('results', [])
    if not results:
        return None

    def rank(show: dict[str, Any]) -> tuple[int, float]:
        first_air = show.get('first_air_date') or ''
        show_year = int(first_air[:4]) if len(first_air) >= 4 and first_air[:4].isdigit() else None
        year_match = 1 if (year is not None and show_year == year) else 0
        return (year_match, float(show.get('popularity', 0)))

    tv_show = sorted(results, key=rank, reverse=True)[0]
    poster_path = tv_show.get('poster_path')
    return {
        'id': tv_show.get('id'),
        'name': tv_show.get('name'),
        'poster_url': f'{TMDB_IMAGE_BASE}{poster_path}' if poster_path else None,
    }


def get_tv_show_seasons(tv_id: int) -> list[dict[str, Any]]:
    payload = _tmdb_get(f'/tv/{tv_id}')
    seasons = payload.get('seasons', [])
    items: list[dict[str, Any]] = []
    for season in seasons:
        season_number = season.get('season_number')
        if season_number is None:
            continue
        poster_path = season.get('poster_path')
        items.append(
            {
                'season_number': int(season_number),
                'name': season.get('name') or f'Season {season_number}',
                'episode_count': int(season.get('episode_count') or 0),
                'poster_url': f'{TMDB_IMAGE_BASE}{poster_path}' if poster_path else None,
            }
        )
    items.sort(key=lambda s: s['season_number'])
    return items


def get_tv_season_episodes(tv_id: int, season_number: int) -> list[dict[str, Any]]:
    payload = _tmdb_get(f'/tv/{tv_id}/season/{season_number}')
    episodes = payload.get('episodes', [])
    items: list[dict[str, Any]] = []
    for episode in episodes:
        ep_no = episode.get('episode_number')
        if ep_no is None:
            continue
        air_date = episode.get('air_date') or ''
        year = int(air_date[:4]) if len(air_date) >= 4 and air_date[:4].isdigit() else None
        still_path = episode.get('still_path')
        items.append(
            {
                'tmdb_id': episode.get('id'),
                'episode_number': int(ep_no),
                'title': episode.get('name') or f'Episode {ep_no}',
                'year': year,
                'poster_url': f'{TMDB_IMAGE_BASE}{still_path}' if still_path else None,
            }
        )
    items.sort(key=lambda e: e['episode_number'])
    return items
