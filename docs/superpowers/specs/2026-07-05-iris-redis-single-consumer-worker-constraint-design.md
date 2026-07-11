# Iris Redis Single-Consumer Worker Constraint Design

## Context

The v1 Redis queues protect against single-process crashes by moving dequeued payloads from a
pending list into a shared `processing` list and recovering that list before the next poll. This
shape is appropriate for the first internal rollout because Iris is intended to run as a small
single-company deployment.

## Decision

The v1 rollout contract is one active consumer per queue family:

- raw Feishu events;
- document sync jobs;
- document reindex jobs.

Operators must not horizontally scale worker consumers for those queues until the queue adapter has
explicit leases or per-consumer processing ownership.

## Invariants

- Single-consumer recovery remains required so a crashed worker does not silently lose dequeued
  work.
- Worker effects must remain idempotent because retries, crash recovery, and DLQ replay are
  at-least-once paths.
- DLQ and internal status surfaces remain the operator recovery tools for v1.
- The current Redis key names and payload schemas remain unchanged.

## Out Of Scope

- Implementing a leased queue adapter now.
- Changing deployment to multi-replica workers.
- Adding leader election.

## Future Upgrade

Before multi-replica workers, introduce a queue adapter with explicit in-flight ownership,
visibility timeouts or leases, and recovery of only expired leases. That adapter must preserve the
current idempotency, retry, and DLQ guarantees.
