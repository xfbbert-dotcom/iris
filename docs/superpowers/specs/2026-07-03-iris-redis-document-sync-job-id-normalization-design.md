# Iris Redis Document Sync Job ID Normalization Design

## Problem

`parseDocumentSyncJob` reads queued Redis payloads without trimming string fields.
If a historical, manual, or external payload includes whitespace around `idempotencyKey`
or `documentSourceId`, Iris can deserialize a job that looks valid but later fails source
lookup or dedupe expectations.

## Decision

Trim string values while parsing Redis document sync jobs.

This keeps the queue parser defensive without changing enqueue behavior or document sync
semantics. It also applies to dead letter parsing because dead letters reuse
`parseDocumentSyncJob`.

## Non-Goals

- Do not change the document sync DLQ schema.
- Do not accept blank ids; trimmed blank values remain invalid.
- Do not alter retry, replay, or delete behavior.

## Quality Bar

- Redis payloads with whitespace-padded `idempotencyKey` and `documentSourceId` parse to
  normalized jobs.
- Existing manual source sync, retry, DLQ, replay, and delete tests remain unchanged.
