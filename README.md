# Plex Collector

Localhost-only tool for comparing Plex library actors with TMDb movie credits to find missing movies.

## Features
- First-run onboarding with `Login with Plex`
- Profile page with Plex account/server details
- Floating icon-only bottom navigation (`Profile`, `Actors`)
- Actors grid from Plex movie library
- Actor detail page with TMDb movie credits
- Clickable Plex badge for movies already found in Plex
- Toggle for showing only movies missing in Plex

## Requirements
- Python 3.11+
- Plex account with access to a Plex server
- TMDb API key

## Setup
1. Copy `.env.example` to `.env`.
2. Start server:
```bat
start.bat
```
3. Open `http://127.0.0.1:8787`.

## Notes
- Data is cached locally in `backend/data/plex_collector.db`.
- Use `Scan Actors` on the Profile page after login.
- This app prefers local Plex connections when available.
- `start.bat` auto-creates or recreates `.venv` if it belongs to another machine/user.

## Publish To GitHub
1. Initialize repository:
```bash
git init
git add .
git commit -m "Initial commit"
```
2. Create an empty GitHub repository.
3. Add remote and push:
```bash
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```
