# Iris Runtime Close Isolation Design

## Goal

Make app shutdown attempt to close every composed runtime even when one runtime close operation
fails. Internal deployments should not leak worker loops, Redis clients, Postgres pools, or model
runtime resources because an earlier close hook rejected.

## Architecture

The Fastify `onClose` hook remains the single app lifecycle boundary. Instead of sequentially
awaiting each runtime close and stopping at the first rejection, the hook must:

- attempt document sync runtime close
- attempt event worker runtime close
- attempt reindex worker runtime close
- attempt answer draft runtime close
- rethrow the first close error after all close attempts have completed

This preserves failure visibility while making cleanup best-effort across independent resources.

## Invariants

- Disabled or absent runtimes are skipped.
- All available runtime `close()` functions are attempted exactly once.
- If any close fails, `app.close()` still rejects.
- Later close operations must run even when an earlier close fails.

## Out Of Scope

- Retrying close failures.
- Changing runtime close internals.
- Adding shutdown metrics.
