# Plex Collector

[![Security](https://github.com/adultkips/Plex-collector/actions/workflows/security.yml/badge.svg)](https://github.com/adultkips/Plex-collector/actions/workflows/security.yml)
[![CodeQL](https://github.com/adultkips/Plex-collector/actions/workflows/codeql.yml/badge.svg)](https://github.com/adultkips/Plex-collector/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Localhost-only Plex companion for scanning movies and shows, matching with TMDb, and surfacing missing content.

## Features
- First-run onboarding flow with `Login with Plex`, Plex server selection, and TMDb API key setup.
- Localhost-only architecture: all scans, matching, and state are handled locally on your machine.
- Profile hub with centralized settings (`Server`, `TMDb key`, `Download Prefix`) plus reset actions.
- Floating icon-only bottom navigation for fast switching between `Profile`, `Actors`, and `Shows`.
- Combined Plex library scanning:
  - `Scan Actors` to index actors and movie links.
  - `Scan Shows` to index shows, seasons, and episodes.
  - Unified scan log with latest runs first.
- Actors experience:
  - Large poster grid sourced from Plex.
  - A-Z/All filtering and live search.
  - Sorting by `Movies` or `Name` with ASC/DESC direction.
  - Direct actor download badge support via configurable prefix links.
- Actor movie detail:
  - TMDb filmography matching against Plex library.
  - Filters for `!` (Missing) and `✓` (In Plex).
  - Clickable TMDb movie cards and Plex/deep-link badges.
  - `Create Collection` action to build/update Plex collections from in-library matches.
- Shows experience:
  - Show grid with A-Z/All filtering, live search, and sorting (`Date`, `Episodes`, `Missing`, `Name`).
  - Global `Scan Episodes` modal with scoped scan (`current filter`) or `Scan All`.
  - Per-show episode scan pill with last-scan date and quick refresh.
  - Visual status badges and borders for `Missing`, `In Plex`, and `NEW`.
  - Filters for `!` (Missing), `✓` (In Plex), and `NEW`.
- Seasons and episodes drill-down:
  - Show -> Season -> Episode navigation with fast cached transitions.
  - Missing/In Plex/New filtering at deeper levels.
  - Release-aware labels (`Released`, `Releasing`, `New episode`) with date formatting.
- Download Prefix system:
  - Configurable start/format/end templates for `Actors`, `Movies`, `Shows`, `Seasons`, and `Episodes`.
  - Multiple keyword formats supported (`%20`, `-`, `+`) with live examples.
  - Prefix reset/save controls at card level.
- Performance optimizations:
  - Cache-first rendering for profile/actors/shows with background refresh.
  - Smart cache invalidation after scans/resets/saves.
  - Progressive image loading queues and request cancellation on route changes.
  - Optimized navigation responsiveness across heavy lists.

## Screenshots
<table>
  <tr>
    <td align="center"><img src="screenshots/profile.png" alt="Profile" width="300"><br><sub>Profile</sub></td>
    <td align="center"><img src="screenshots/actors.png" alt="Actors" width="300"><br><sub>Actors</sub></td>
    <td align="center"><img src="screenshots/movies.png" alt="Movies" width="300"><br><sub>Movies</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="screenshots/shows.png" alt="Shows" width="300"><br><sub>Shows</sub></td>
    <td align="center"><img src="screenshots/seasons.png" alt="Seasons" width="300"><br><sub>Seasons</sub></td>
    <td align="center"><img src="screenshots/episodes.png" alt="Episodes" width="300"><br><sub>Episodes</sub></td>
  </tr>
</table>

## Requirements
- Python 3.11+
- Plex account with access to a Plex server (local network reachable)
- TMDb API key
- Windows environment for the included launcher scripts (`Install.bat`, `start_server.bat`)

## Install
Run first-time setup (creates `.venv` and installs dependencies):
```bat
Install.bat
```
`Install.bat` does not start the server.

## Start Server
Run after installation:
```bat
start_server.bat
```
Open `http://127.0.0.1:8787`.

## Notes
- The app is designed for local use on `127.0.0.1` and stores app state in `backend/data/plex_collector.db`.
- Use the Profile page to run `Scan Actors` and `Scan Shows`, then use `Scan Episodes` from the Shows page when needed.
- UI performance is cache-first: Profile, Actors, and Shows render from local cache and refresh in the background.
- Image cache is invalidated automatically after scans/resets to avoid stale posters.
- `Install.bat` creates or recreates `.venv` if it belongs to another machine/user, and `start_server.bat` is used for normal startup.

## Security
- See `SECURITY.md` for vulnerability reporting.
- Keep API keys and tokens out of git; use local `.env` only (never commit secrets).
- Treat `backend/data/plex_collector.db` as sensitive local data (it can contain account/session related app data).
- Run this app on trusted local networks and avoid exposing the local server publicly.
- Dependency vulnerability checks run in GitHub Actions (`.github/workflows/security.yml`).
- Static code scanning runs via CodeQL (`.github/workflows/codeql.yml`).

## Contributing
- See `CONTRIBUTING.md` for workflow and conventions.
- Open an issue before large feature changes to align scope and UX direction.
- Keep PRs focused and include:
  - what changed
  - why it changed
  - how it was tested
- Update README/screenshots when user-facing behavior changes.

