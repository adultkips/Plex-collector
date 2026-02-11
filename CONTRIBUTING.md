# Contributing

Thanks for contributing to Plex Collector.

## Local Setup

1. Run `Install.bat` for first-time setup (creates `.venv` and installs dependencies).
2. Run `start_server.bat` for normal daily startup.
3. Open `http://127.0.0.1:8787`.

## Branches

- Use short, scoped branches such as:
  - `feat/shows-filter`
  - `fix/scan-timeout`
  - `docs/readme-badges`

## Pull Requests

- Open PRs against `main`.
- Keep changes focused and small when possible.
- Confirm CI checks are green (`pip-audit`, `CodeQL`).
- Include a short test note in the PR description.
- For UI/UX changes, update `README.md` and screenshots when relevant.
- Run a quick smoke test before PR:
  - Profile page loads and settings can be saved.
  - Actors and Shows pages render and navigation works.
  - Main scan actions complete without errors.

## Releases

- Use semantic version tags (for example `v0.1.6`).
- Create a GitHub Release with concise notes (focus on user-facing changes and performance impact).

## Security

- Do not commit `.env`, tokens, or local database files.
- Follow `SECURITY.md` for vulnerability reporting.
