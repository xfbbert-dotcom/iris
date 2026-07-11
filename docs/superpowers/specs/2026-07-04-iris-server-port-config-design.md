# Iris Server Port Config Design

## Context

The app entrypoint reads `PORT` directly with `Number(process.env.PORT ?? 3000)`. This bypasses the
environment parsing rules used by the rest of Iris and can pass ambiguous or invalid values to
Fastify at process startup.

For the internal rollout, startup configuration should fail clearly when the operator provides an
invalid port.

## Decision

Add a shared `readServerPort()` config reader in `apps/core/src/config/env.ts`.

Rules:

- default to `3000` when `PORT` is unset or blank;
- trim valid decimal digit strings;
- reject non-decimal forms such as `1e3` and `0xBB8`;
- reject `0`, negatives, unsafe integers, and values above `65535`;
- use `readServerPort()` in the executable app entrypoint.

## Scope

This only affects the Node HTTP listen port. It does not change Docker Compose port mappings,
Fastify route behavior, or test app injection.

## Acceptance Criteria

- `readServerPort({})` returns `3000`.
- `readServerPort({ PORT: " 62761 " })` returns `62761`.
- `PORT=0`, `PORT=65536`, and `PORT=1e3` throw explicit errors.
- The app entrypoint no longer calls `Number(process.env.PORT ?? 3000)` directly.
