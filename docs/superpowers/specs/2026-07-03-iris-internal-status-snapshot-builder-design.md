# Iris Internal Status Snapshot Builder Design

## Problem

`GET /internal/status` now exposes several operator-facing summary fields. Keeping all summary derivation inside the route handler makes the handler harder to scan and increases the chance that future component additions update one summary field but miss another.

## Decision

Keep the route responsible for collecting live component status, and move aggregate snapshot derivation into a local helper:

- route handler builds the component map;
- helper computes top-level `ok`, `generatedAt`, summary counts, summary lists, and returns the original components.

This is an internal refactor only. The API response shape remains unchanged.

## Quality Bar

- Existing `GET /internal/status` tests must pass unchanged.
- TypeScript must understand component summary derivation without unsafe casts.
- No behavior changes to component status helpers or individual status endpoints.
