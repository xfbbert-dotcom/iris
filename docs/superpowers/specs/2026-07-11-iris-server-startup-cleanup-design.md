# Iris Server Startup Cleanup Design

## Context

The executable Core entry point currently composes and starts the answer-draft, event, document-sync,
and reindex runtimes before it validates `PORT`. It also awaits `app.listen()` without closing the
composed app when the listener cannot bind.

Two ordinary startup failures can therefore leave Postgres pools, Redis clients, or worker timers
alive even though the HTTP server never started:

- an invalid `PORT` value throws after `buildApp()` has started runtime resources;
- a bind failure such as `EADDRINUSE` rejects after the runtimes have started.

`buildApp()` already registers an `onClose` hook that attempts every runtime close operation. The
missing guarantee is at the executable startup boundary.

## Decision

Introduce one exported `startServer()` boundary for the executable entry point.

1. Read and validate the internal API token, Feishu listener prerequisites, and port before calling
   `buildApp()`.
2. Build the app only after those synchronous preflight checks pass.
3. If `app.listen()` rejects, call `app.close()` before propagating the startup failure.
4. If listener startup and cleanup both fail, throw an `AggregateError` containing both errors so
   neither the primary failure nor the leaked-resource signal is lost.
5. Return the listening Fastify app on success so callers and tests retain the normal explicit
   shutdown contract.

The runtime composition, listener host security rule, and normal shutdown order remain unchanged.

## Verification

- Invalid `PORT` input rejects before any runtime factory is invoked.
- A real occupied-port bind failure closes every composed runtime.
- A simultaneous bind and cleanup failure exposes both errors.
- Successful startup returns a listening app that closes normally.
- Focused tests and the full repository verification command pass.

## Out Of Scope

- Retrying listener binds.
- Changing worker startup order.
- Replacing Fastify lifecycle hooks.
- Persisting runtime-control state.
