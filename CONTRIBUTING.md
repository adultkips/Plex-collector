# Contributing

Thanks for contributing to Plex Collector.

## Local Setup

1. Run `Install.bat`
2. Run `start_server.bat`
3. Open `http://127.0.0.1:8787`

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

## Security

- Do not commit `.env`, tokens, or local database files.
- Follow `SECURITY.md` for vulnerability reporting.
