# Iris Phase 6A Proactive Signal Preview And Candidate Facts

## Scope

This change starts the proactive behavior layer without enabling unsolicited Feishu speech.

- Adds a bounded proactive signal planner for:
  - quiet open discussion threads;
  - overdue open action items.
- Adds authenticated internal preview route:
  - `POST /internal/proactive-signals/groups/:groupId/preview`
- Adds authenticated internal scan route:
  - `POST /internal/proactive-signals/groups/:groupId/scan`
- Adds `0037_proactive_signal_candidates.sql` for durable pending candidate facts, evidence IDs, and append-only candidate events.
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
  - `npm --workspace apps/core test -- proactive-signal-repository.test.ts`
  - `npm --workspace apps/core test -- proactive-signal-planner.test.ts proactive-signal-api.test.ts proactive-signal-repository.test.ts conversation-state-api.test.ts migration-runner.test.ts`
  - `npm --workspace apps/core run typecheck`
  - `npm --workspace apps/core run build`

## Next Gate

The next product gate should turn pending candidates into a governed proactive outbox:

1. Add bounded listing and dismissal for pending proactive candidates.
2. Keep Feishu sending default-off and rate-limited.
3. Add a manual operator route to approve a candidate for a Feishu card or message.
4. Only after real pilot approval, connect a Feishu group card or message surface.
