# Iris Internal Component Status Design

## Problem

The consolidated status response has top-level health and detailed component booleans, but a future admin UI still has to derive the display state for each component row. That duplicates backend semantics in the frontend and makes disabled, degraded, and stopped states easier to mix up.

## Decision

Add `status` to every component object returned by `GET /internal/status`.

Supported component statuses in schema version 1:

- `healthy`: component is enabled, ok, and either running or has no runtime state;
- `disabled`: component has `enabled: false`;
- `degraded`: component has `ok: false`;
- `stopped`: component is enabled and ok, but exposes `running: false`.

Priority order is:

1. `disabled`
2. `degraded`
3. `stopped`
4. `healthy`

## Quality Bar

- Component `status` must be derived in the snapshot builder so the route handler stays thin.
- Existing component fields remain present and unchanged.
- Tests cover healthy, disabled, degraded, and stopped component statuses.
