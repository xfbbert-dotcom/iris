# Iris Redis Raw Event Body Validation Design

## Problem

`parseRawEvent` accepts Redis raw event payloads even when `rawBody` is missing or
not an object. The Feishu gateway enqueues parsed JSON bodies, and the downstream
message processor requires an object-shaped `rawBody`. Accepting missing bodies at
the Redis queue boundary can produce silent no-op processing or delayed retries.

## Decision

Treat Redis raw event payloads with missing or non-object `rawBody` as invalid queue
payloads. `dequeueBatch` already dead-letters invalid payloads and continues, so
these malformed entries should be surfaced in the raw event DLQ.

## Non-Goals

- Do not change Feishu gateway callback behavior.
- Do not change raw event retry/DLQ behavior for valid events that fail processing.
- Do not validate full Feishu message schema in the Redis queue.

## Quality Bar

- `parseRawEvent` rejects missing `rawBody`.
- `parseRawEvent` rejects non-object `rawBody`.
- `dequeueBatch` dead-letters such malformed payloads and continues to later valid events.
