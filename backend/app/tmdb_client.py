from __future__ import annotations

from typing import Any

import requests

from .config import TMDB_API_KEY, TMDB_IMAGE_BASE
from .db import get_setting
from .utils import normalize_title

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


def _select_best_trailer(videos_payload: dict[str, Any]) -> str | None:
    results = videos_payload.get('results', [])
    if not isinstance(results, list) or not results:
        return None

    def score(item: dict[str, Any]) -> tuple[int, int, int]:
        site = str(item.get('site') or '').lower()
        video_type = str(item.get('type') or '').lower()
        official = bool(item.get('official'))
        return (
            1 if site == 'youtube' else 0,
            1 if video_type == 'trailer' else 0,
            1 if official else 0,
        )

    sorted_items = sorted(results, key=score, reverse=True)
    for item in sorted_items:
        site = str(item.get('site') or '').lower()
        key = str(item.get('key') or '').strip()
        if site == 'youtube' and key:
            return f'https://www.youtube.com/watch?v={key}'

    return None


def search_person(name: str, preferred_department: str = 'Acting') -> dict[str, Any] | None:
    payload = _tmdb_get('/search/person', {'query': name, 'include_adult': 'false'})
    results = payload.get('results', [])
    if not results:
        return None

    acting_first = sorted(
        results,
        key=lambda p: (1 if p.get('known_for_department') == preferred_department else 0, p.get('popularity', 0)),
        reverse=True,
    )
    person = acting_first[0]
    profile_path = person.get('profile_path')
    return {
        'id': person.get('id'),
        'name': person.get('name'),
        'image_url': f'{TMDB_IMAGE_BASE}{profile_path}' if profile_path else None,
    }


def get_person_movie_credits(person_id: int, department: str = 'actor') -> list[dict[str, Any]]:
    payload = _tmdb_get(f'/person/{person_id}/movie_credits')
    role = (department or 'actor').strip().lower()
    if role == 'director':
        crew = payload.get('crew', [])
        cast = [movie for movie in crew if str(movie.get('job') or '').lower() == 'director']
    elif role == 'writer':
        crew = payload.get('crew', [])
        cast = [
            movie for movie in crew
            if str(movie.get('department') or '').lower() == 'writing'
            or str(movie.get('job') or '').lower() in {'writer', 'screenplay', 'story'}
        ]
    else:
        cast = payload.get('cast', [])
    movies_by_key: dict[str, dict[str, Any]] = {}
    for movie in cast:
        title = movie.get('title')
        if not title:
            continue
        release = movie.get('release_date') or ''
        year = int(release[:4]) if len(release) >= 4 and release[:4].isdigit() else None
        poster_path = movie.get('poster_path')
        item = {
            'tmdb_id': movie.get('id'),
            'title': title,
            'original_title': movie.get('original_title') or None,
            'year': year,
            'release_date': release if release else None,
            'poster_url': f'{TMDB_IMAGE_BASE}{poster_path}' if poster_path else None,
        }
        tmdb_id = item.get('tmdb_id')
        if tmdb_id is not None:
            key = f"id:{int(tmdb_id)}"
        else:
            key = f"title:{normalize_title(title)}|year:{year or 0}"

        existing = movies_by_key.get(key)
        if not existing:
            movies_by_key[key] = item
            continue

        # Merge duplicates from TMDb crew/cast credits (e.g. writer + screenplay).
        if not existing.get('original_title') and item.get('original_title'):
            existing['original_title'] = item['original_title']
        if not existing.get('release_date') and item.get('release_date'):
            existing['release_date'] = item['release_date']
        if not existing.get('poster_url') and item.get('poster_url'):
            existing['poster_url'] = item['poster_url']
        if not existing.get('year') and item.get('year'):
            existing['year'] = item['year']
        if not existing.get('tmdb_id') and item.get('tmdb_id') is not None:
            existing['tmdb_id'] = item['tmdb_id']
        if (not existing.get('title')) and item.get('title'):
            existing['title'] = item['title']

    movies = list(movies_by_key.values())
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

    query_norm = normalize_title(name)

    def rank(show: dict[str, Any]) -> tuple[int, int, int, int, float]:
        first_air = show.get('first_air_date') or ''
        show_year = int(first_air[:4]) if len(first_air) >= 4 and first_air[:4].isdigit() else None
        show_name_norm = normalize_title(str(show.get('name') or ''))
        show_original_name_norm = normalize_title(str(show.get('original_name') or ''))
        candidate_norms = [show_name_norm, show_original_name_norm]

        exact_match = 1 if query_norm and query_norm in candidate_norms else 0
        prefix_match = 1 if query_norm and any(c.startswith(query_norm) for c in candidate_norms if c) else 0
        contains_match = 1 if query_norm and any(query_norm in c for c in candidate_norms if c) else 0
        year_match = 1 if (year is not None and show_year == year) else 0
        return (exact_match, prefix_match, contains_match, year_match, float(show.get('popularity', 0)))

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
                'air_date': season.get('air_date') or None,
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
                'air_date': air_date if air_date else None,
                'year': year,
                'poster_url': f'{TMDB_IMAGE_BASE}{still_path}' if still_path else None,
            }
        )
    items.sort(key=lambda e: e['episode_number'])
    return items


def get_movie_trailer_url(movie_id: int) -> str | None:
    payload = _tmdb_get(f'/movie/{movie_id}/videos')
    return _select_best_trailer(payload)


def get_tv_show_trailer_url(tv_id: int) -> str | None:
    payload = _tmdb_get(f'/tv/{tv_id}/videos')
    return _select_best_trailer(payload)


def get_movie_credits_summary(movie_id: int) -> dict[str, Any]:
    payload = _tmdb_get(f'/movie/{movie_id}/credits')
    cast_items = payload.get('cast', [])
    crew_items = payload.get('crew', [])

    director: str | None = None
    writer: str | None = None
    for crew in crew_items:
        job = str(crew.get('job') or '').strip().lower()
        department = str(crew.get('department') or '').strip().lower()
        name = str(crew.get('name') or '').strip()
        if not name:
            continue
        if director is None and job == 'director':
            director = name
        if writer is None and (job in {'writer', 'screenplay', 'story'} or department == 'writing'):
            writer = name
        if director and writer:
            break

    top_cast: list[str] = []
    for cast in cast_items:
        name = str(cast.get('name') or '').strip()
        if not name or name in top_cast:
            continue
        top_cast.append(name)
        if len(top_cast) >= 3:
            break

    return {
        'director': director,
        'writer': writer,
        'top_cast': top_cast,
    }
