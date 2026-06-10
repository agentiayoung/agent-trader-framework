# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems (credential handling, an order path that could bypass guards, anything that could move funds).

Instead, use GitHub's **private vulnerability reporting** (the "Report a vulnerability" button under the repository's *Security* tab), or open a minimal private channel with the maintainer. Include reproduction steps and the potential impact. You'll get an acknowledgement as soon as possible.

## Scope

This is paper-trading research software. The most security-relevant areas:

- **Credential handling** — keys live only in `config/.env` (gitignored), read via `process.env`, never logged or committed. A report of any code path that logs, prints, or commits a secret is high priority.
- **The guard pipeline** — any way to place a bracket that bypasses `preflight` (mandatory SL, geometry, exposure, breaker) is a real issue.
- **Live-trading safety** — the default must remain `BYBIT_DEMO=1`. A path that silently reaches mainnet is in scope.

## Out of scope

- The illustrative strategy parameters being unprofitable (they're illustrative — see `DISCLAIMER.md`).
- Issues requiring a pre-compromised host or already-stolen credentials.
