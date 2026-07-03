# Iris Redis Attempts Safe Integers Design

## Context

Redis-backed queues persist retry attempts in JSON payloads. These payloads can come from previous Iris versions, manual queue repair, or corrupted external state. If an unsafe integer attempt count is accepted, retry and dead-letter decisions can run on a value JavaScript cannot represent exactly.

## Decision

Redis queue payload parsers must reject unsafe retry attempt integers:

- Missing `attempts` remains backward-compatible and defaults to `0`.
- Non-number, fractional, negative, and unsafe integer attempts are invalid payloads.
- Invalid queued payloads continue through the existing DLQ diagnostic path.

## Scope

This covers Redis raw event, document sync, and document reindex queue payload parsing. It does not change queue item serialization, retry limits, or DLQ replay semantics.

## Quality Bar

Each Redis queue parser must have a test proving an unsafe integer `attempts` value is rejected.
