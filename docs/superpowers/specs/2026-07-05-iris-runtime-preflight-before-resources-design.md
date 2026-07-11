# Iris Runtime Preflight Before Resources Design

## Context

`buildApp()` can clean up runtimes that have already been returned when a later runtime start fails.
That does not help when a runtime factory throws before returning its runtime object. In that case,
any Postgres pool or Redis connection opened inside the partially constructed factory is invisible
to `buildApp()` and can stay half-open after a failed boot.

Two concrete paths can throw after resources are opened:

- event worker mention-reply configuration reads partial Feishu OpenAPI credentials after creating
  Postgres and Redis resources;
- document sync reindex enqueue configuration validates embedding dimensions after creating
  Postgres and Redis resources.

## Decision

Runtime factories must preflight config that can synchronously throw before creating pools, Redis
clients, repositories, queues, or worker loops.

For this pass:

- Event worker preflights optional mention-answer setup before resource creation.
- Document sync preflights optional embedding reindex enqueue setup before resource creation.
- Reindex worker behavior is unchanged because embedding config is already validated before
  resource creation.

## Invariants

- Disabled or incomplete optional features still return degraded/unavailable status instead of
  failing runtime creation when they are meant to be optional.
- Partial configuration remains a startup error, but no runtime resource should be opened before
  that error is thrown.
- Existing successful composition behavior and status payloads remain unchanged.

## Out Of Scope

- Async cleanup for dependency factories that themselves open resources and then throw internally.
- Changing `buildApp()` startup ordering.
- Changing runtime status schemas.
