# Iris Startup Runtime Cleanup Design

## Context

`buildApp` composes several runtimes before the Fastify app is returned. The normal close path
already attempts to close every runtime when one close operation fails. During startup, however, a
later runtime can throw from `start()` after earlier runtimes have already started. In that half-open
state the Fastify `onClose` hook is not useful to the caller because `buildApp` never returns an app.

For the first 20-30 person rollout this is still worth hardening: failed boot attempts should not
leave timers, Redis clients, database pools, or worker loops running in the background.

## Decision

`buildApp` must attempt best-effort cleanup of all runtimes that were already created when runtime
startup fails. The original startup error remains the synchronous failure seen by the caller, while
cleanup errors are contained so they do not replace the root cause.

## Invariants

- Successful startup behavior is unchanged.
- Fastify `onClose` still closes every runtime and reports the first close error.
- Startup cleanup is best-effort because runtime `close()` methods are asynchronous while `buildApp`
  remains synchronous.
- Cleanup includes the runtime whose `start()` failed, not only previously started runtimes.
- Cleanup errors must not mask the original `start()` error.

## Out Of Scope

- Making `buildApp` asynchronous.
- Changing worker runtime start semantics.
- Adding persisted lifecycle state.
