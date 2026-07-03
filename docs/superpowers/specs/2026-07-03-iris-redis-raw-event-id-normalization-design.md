# Iris Redis Raw Event ID Normalization Design

## Problem

`parseRawEvent` preserves whitespace around queued Redis string fields. A malformed but
otherwise valid Redis payload can deserialize with whitespace-padded `idempotencyKey` or
`eventType`, causing confusing worker results, metrics, and dedupe diagnostics.

## Decision

Trim string values in the Redis raw event parser's local `readString` helper.

This is a parser-boundary normalization only. It does not change raw event enqueue,
retry, or DLQ behavior.

## Non-Goals

- Do not trim `rawBody`; it is opaque provider data.
- Do not accept blank ids; trimmed blank values remain invalid.
- Do not change provider validation.

## Quality Bar

- Redis payloads with whitespace-padded `idempotencyKey` and `eventType` parse to
  normalized raw events.
- Existing legacy attempts handling and invalid payload DLQ handling remain unchanged.
