# Iris Queue Attempts Safe Integers Design

## Context

Queues persist retry attempts in JSON payloads and accept a `maxAttempts` constructor option for retry/DLQ policy. Redis payloads can come from previous Iris versions, manual queue repair, or corrupted external state. If unsafe integer attempt counts are accepted, retry and dead-letter decisions can run on values JavaScript cannot represent exactly.

## Decision

Queue retry counters must reject unsafe integers:

- Missing `attempts` remains backward-compatible and defaults to `0`.
- Non-number, fractional, negative, and unsafe integer attempts are invalid payloads.
- Invalid queued payloads continue through the existing DLQ diagnostic path.
- Queue constructors reject unsafe integer `maxAttempts` values before workers start.

## Scope

This covers raw event, document sync, and document reindex queue retry counters across Redis-backed queues and v1 in-memory queues. It does not change queue item serialization, retry limits, or DLQ replay semantics.

## Quality Bar

Each Redis queue parser must have a test proving an unsafe integer `attempts` value is rejected. Each in-memory and Redis queue constructor must have a test proving unsafe integer `maxAttempts` values are rejected.
