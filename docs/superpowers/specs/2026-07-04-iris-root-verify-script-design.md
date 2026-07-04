# Iris Root Verify Script Design

## Goal

Provide one root-level command for the local verification suite. Developers and agents should not
have to keep a manually copied list of verification commands in sync as the repository grows.

## Architecture

Add a root npm script:

```json
"verify": "git diff --check && npm run typecheck && npm test && npm run test:python && docker compose config"
```

The script is intentionally a thin command orchestrator. It reuses the existing TypeScript,
Python, and Docker Compose commands without introducing another task runner.

## Invariants

- `npm run verify` runs from the repository root.
- The script checks diff whitespace before running code verification.
- The script uses `npm run test:python` instead of invoking pytest directly.
- Existing individual commands remain available for focused iteration.

## Out Of Scope

- Replacing GitHub Actions.
- Starting Docker services.
- Running database integration tests that require `DATABASE_URL`.
