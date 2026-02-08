# Security Policy

## Supported Versions

Plex Collector is currently maintained as a single rolling `main` branch.

| Version | Supported |
| --- | --- |
| latest (`main`) | yes |
| older commits/releases | no |

## Reporting a Vulnerability

If you find a security issue, please do **not** open a public issue with exploit details.

1. Open a private security advisory in GitHub (`Security` -> `Advisories`), or
2. Contact the maintainer directly and include:
   - A short description of the issue
   - Steps to reproduce
   - Impact assessment
   - Suggested fix (if any)

You can expect an initial response within 7 days.

## Scope Notes

- This project is intended for localhost usage.
- Sensitive values such as Plex tokens and TMDb keys are stored locally and should never be committed to Git.
- Keep `.env` private and rotate keys immediately if leaked.
