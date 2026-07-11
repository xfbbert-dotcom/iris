# Iris Raw Event Parser ID Budget Design

## Goal

Prevent oversized or polluted Redis raw-event payload identifiers from re-entering Iris worker
processing.

## Architecture

The Redis raw event parser now validates identifier-like fields before returning a `RawEvent`:

- `idempotencyKey` must be non-blank and no longer than the generated
  `raw-event:feishu:` prefix plus a `512` character Feishu event ID.
- `eventType` must be non-blank and no longer than `512` characters.

Invalid queued payloads continue to be rejected as `Invalid raw event payload`, which lets
`dequeueBatch` move them to the raw event DLQ and continue processing subsequent valid events.

## Invariants

- Valid raw events still round-trip through JSON unchanged.
- Missing attempts still default to `0` for legacy payloads.
- The gateway and parser now share the same `512` character event identifier budget.
- Parser rejection happens before event worker normalization or downstream processing.
- Existing DLQ diagnostics continue to use the same error category.

## Out Of Scope

- Changing Redis queue key names or Lua scripts.
- Changing raw event idempotency key format.
- Changing Feishu gateway acknowledgement behavior.
- Adding schema migrations.
