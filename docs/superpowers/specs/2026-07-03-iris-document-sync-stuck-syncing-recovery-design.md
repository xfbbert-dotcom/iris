# Iris Document Sync Stuck-Syncing Recovery Design

## Context

Document sync marks a source `syncing` before fetching and snapshot persistence. If a later persistence step fails, the source can remain `syncing`. Manual sync and planner flows then skip it as already syncing, leaving the document stuck until an operator manually repairs state.

This is especially painful during the 20-30 person internal rollout: a transient database write failure can make one document look permanently unavailable to Iris.

## Decision

After a source has entered `syncing`, unexpected persistence or enqueue failures must attempt to restore the source to `pending` before rethrowing the original error.

Covered paths:

- succeeded snapshot write failure;
- mark-synced failure;
- failed snapshot write failure;
- mark-failed failure;
- synced snapshot reindex enqueue failure.

The recovery attempt must not mask the original failure.

## Scope

This does not convert persistence failures into successful sync results. The worker still sees an error and applies queue retry policy. The change only prevents the source state from getting stuck in `syncing`.

## Quality Bar

- Sources are marked back to `pending` when post-fetch persistence fails.
- The original error is preserved for worker retry and diagnostics.
- Existing successful sync, rejected source, and handled fetch-failure behavior remains unchanged.
