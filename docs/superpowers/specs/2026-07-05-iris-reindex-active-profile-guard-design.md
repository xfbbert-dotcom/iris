# Iris Reindex Active Profile Guard Design

## Context

Iris v1 has one active embedding profile per reindex worker runtime. Manual reindex planning and
document-synced enqueueing normally create jobs for that active profile.

## Problem

Redis queues and DLQs can outlive embedding model or dimension changes. A stale queued job may carry
an old `embeddingProfileId` even though the current runtime indexer writes fragments for the new
active profile. Processing that job would let the worker report results under the stale profile while
mutating active-profile fragments.

## Decision

The runtime passes `activeEmbeddingProfileId` into the reindex worker. Before reading snapshots,
checking existing fragments, embedding chunks, or replacing fragments, the worker compares each job's
profile with the active profile. Mismatches are acknowledged as processed with a `profile_not_active`
skip result.

## Invariants

- Stale profile jobs do not read snapshots.
- Stale profile jobs do not call the embedding provider.
- Stale profile jobs do not replace fragments.
- Stale profile jobs are not retried or dead-lettered.
- Manual reindex API ingress still rejects non-active profiles before enqueue.

## Out Of Scope

- Multi-profile reindex workers.
- Profile-scoped Redis queue namespaces.
- Migrating or replaying old-profile DLQ entries into a new profile.
