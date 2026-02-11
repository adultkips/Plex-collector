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
  - Sorting by `Name` or `Amount` with ASC/DESC direction.
  - Direct actor download badge support via configurable prefix links.
- Actor movie detail:
  - TMDb filmography matching against Plex library.
  - Filters for `!` (Missing) and `✓` (In Plex).
  - Clickable TMDb movie cards and Plex/deep-link badges.
  - `Create Collection` action to build/update Plex collections from in-library matches.
- Shows experience:
  - Show grid with A-Z/All filtering, live search, and sorting (`Name`, `Amount`, `Date`).
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
- Plex account with access to a Plex server
- TMDb API key

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
- Data is cached locally in `backend/data/plex_collector.db`.
- Use `Scan Actors` on the Profile page after login.
- This app prefers local Plex connections when available.
- `Install.bat` auto-creates or recreates `.venv` if it belongs to another machine/user.

## Security
- See `SECURITY.md` for vulnerability reporting.
- Dependency vulnerability checks run in GitHub Actions (`.github/workflows/security.yml`).
- Static code scanning runs via CodeQL (`.github/workflows/codeql.yml`).

## Contributing
- See `CONTRIBUTING.md`.

