# Iris Phase 6A Proactive Signal Preview

## Scope

This change starts the proactive behavior layer without enabling unsolicited Feishu speech.

- Adds a bounded proactive signal planner for:
  - quiet open discussion threads;
  - overdue open action items.
- Adds authenticated internal preview route:
  - `POST /internal/proactive-signals/groups/:groupId/preview`
- Reuses the current-group conversation-state inspection store.
- Requires `runtimeController.canProactivelySpeak(groupId)` before scanning, so global disable, group disable, or proactive pause all fail closed.
- Returns idempotency keys tied to entity type, entity ID, and entity version.

This does not send Feishu messages, create formal tasks, write knowledge-base content, call external tools, or enable `proactiveSpeech` in production. It is the first product slice before a governed proactive outbox/card flow.

## Verification

- RED observed:
  - planner import missing;
  - API route returned `404` before implementation.
- GREEN:
  - `npm --workspace apps/core test -- proactive-signal-planner.test.ts proactive-signal-api.test.ts`
  - `npm --workspace apps/core run typecheck`
  - `npm --workspace apps/core run build`

## Next Gate

The next product gate should turn previewed candidates into a governed proactive outbox:

1. Persist candidate facts with append-only audit events.
2. Deduplicate by the existing version-bound idempotency key.
3. Keep Feishu sending default-off and rate-limited.
4. Add a manual operator route to mark a candidate dismissed or approved-for-card.
5. Only after real pilot approval, connect a Feishu group card or message surface.
