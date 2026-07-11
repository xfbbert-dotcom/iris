# Iris Audit Event Summary Design

## Goal

Give Iris operators a small diagnostic view for recent permission guard behavior. The first company rollout is only 20-30 people, so the useful version is not a full observability stack. It is a fast internal summary that shows which documents are repeatedly denied or erroring during answer draft context assembly.

## Scope

This phase adds an in-memory aggregation over the existing audit log. It does not introduce Postgres, Redis, long-term retention, alerting, or UI. The summary is intentionally derived from the bounded in-memory event window already owned by `InMemoryAuditLog`.

## API

`GET /internal/audit/events/summary?limit=20`

The `limit` parameter means "look at the newest N audit events", using the same validation as the raw audit event endpoint. The endpoint returns:

- `documentId`
- `type`
- `eventCount`
- `affectedFragmentCount`
- `firstRecordedAt`
- `latestRecordedAt`

Rows are grouped by `documentId` and audit `type`, then sorted by highest `eventCount`, newest `latestRecordedAt`, and a stable document/type tie-breaker.

## Behavior

`affectedFragmentCount` counts unique fragment IDs within the summary row, not total repeated fragment references. This avoids making repeated retries look like broader document coverage than they really are.

The summary only uses events currently retained in memory. In Phase 2B/4B this means a process restart clears the diagnostic view. When Postgres audit persistence arrives, the same endpoint shape can be backed by durable storage without changing consumers.

## Quality Bar

This endpoint is for internal diagnosis of the core answer-quality guardrail. It must be simple, deterministic, and cheap to compute for the small-company rollout. It must not slow down answer generation or Feishu event ingestion.
