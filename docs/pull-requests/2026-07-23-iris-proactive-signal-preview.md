# Iris Phase 6A Proactive Signal Preview, Governance, And Delivery Gate

## Scope

This change starts the proactive behavior layer without enabling unsolicited Feishu speech.

- Adds a bounded proactive signal planner for:
  - quiet open discussion threads;
  - overdue open action items.
- Adds authenticated internal preview route:
  - `POST /internal/proactive-signals/groups/:groupId/preview`
- Adds authenticated internal scan route:
  - `POST /internal/proactive-signals/groups/:groupId/scan`
- Adds authenticated internal governance routes:
  - `GET /internal/proactive-signals/groups/:groupId/candidates`
  - `POST /internal/proactive-signals/groups/:groupId/candidates/:idempotencyKey/dismiss`
  - `POST /internal/proactive-signals/groups/:groupId/candidates/:idempotencyKey/approve-delivery`
- Adds `0037_proactive_signal_candidates.sql` for durable pending candidate facts, evidence IDs, and append-only candidate events.
- Adds `0038_proactive_signal_delivery_outbox.sql` for approved Feishu group-card delivery rows, leasing, sent message IDs, and append-only delivery events.
- Adds a bounded proactive Feishu card renderer that does not include raw evidence text or card JSON in persisted facts.
- Adds a proactive delivery dispatcher and polling runtime:
  - disabled unless `IRIS_PROACTIVE_SIGNAL_DELIVERY_ENABLED=true`;
  - scoped by `IRIS_PROACTIVE_SIGNAL_DELIVERY_GROUP_IDS`;
  - rechecks `runtimeController.canProactivelySpeak(groupId)` before external attempt and again immediately before send;
  - records retryable, permanent, and outcome-unknown failures without exposing upstream details.
- Reuses the current-group conversation-state inspection store.
- Requires `runtimeController.canProactivelySpeak(groupId)` before scanning, so global disable, group disable, or proactive pause all fail closed.
- Returns idempotency keys tied to entity type, entity ID, and entity version.
- Adds a minimal `/admin` browser console for the 20-30 person internal rollout:
  - reads `/internal/status`, `/internal/readiness`, and `/internal/runtime-control/status` after the operator supplies the existing internal bearer token;
  - operates global, group, and capability runtime-control switches through existing APIs;
  - lists document sources with latest snapshot health and lets operators toggle answering / knowledge-draft policy or enqueue a manual sync through existing document-sync APIs;
  - registers user-submitted Feishu document links through the existing document-sync API, then refreshes source status without rendering document body content;
  - lets employees explicitly @Iris in Feishu with a user-document submission command and link, registering a `user_submitted_document` and enqueueing sync without invoking the model answer path;
  - lists knowledge-draft status counts and queue summaries, with safe request-revision / reject transitions through existing governance APIs;
  - lists publication/action proposal work across pending, approved, executing, failed, and reconciliation states, with safe request-revision / reject transitions through existing action-proposal APIs and no direct approval path;
  - scans one explicit group for proactive candidates, lists pending candidates, and routes dismiss / approve-delivery through existing proactive-signal APIs;
  - shows aggregate audit summaries from existing audit APIs without rendering raw message bodies;
  - keeps the page shell free of secrets and internal data.
- Extends the pilot Caddy allowlist only for exact static console routes:
  - `GET /admin`
  - `GET /admin/console.css`
  - `GET /admin/console.js`
  - public `/internal/*` remains `404`.

This still does not create formal tasks, write knowledge-base content, call external tools, or enable `proactiveSpeech` in production. Real Feishu group delivery remains default-off and requires both the new delivery env gate and runtime/group proactive permission.

## Verification

- RED observed:
  - planner import missing;
  - API route returned `404` before implementation.
- GREEN:
  - `npm --workspace apps/core test -- proactive-signal-planner.test.ts proactive-signal-api.test.ts`
  - `npm --workspace apps/core test -- proactive-signal-repository.test.ts`
  - `npm --workspace apps/core test -- proactive-signal-planner.test.ts proactive-signal-api.test.ts proactive-signal-repository.test.ts conversation-state-api.test.ts migration-runner.test.ts`
  - `npm --workspace apps/core test -- proactive-signal-planner.test.ts proactive-signal-api.test.ts proactive-signal-repository.test.ts proactive-signal-card-renderer.test.ts proactive-signal-dispatcher.test.ts proactive-signal-dispatcher-loop.test.ts proactive-signal-runtime.test.ts env.test.ts server-startup.test.ts migration-runner.test.ts`
  - `npm --workspace apps/core run typecheck`
  - `npm --workspace apps/core run build`
  - `npm --workspace apps/core test -- admin-console-api.test.ts admin-console-assets.test.ts answer-draft-api.test.ts runtime-control-api.test.ts`
  - `npm --workspace apps/core test -- admin-console-api.test.ts admin-console-assets.test.ts`
  - `npm --workspace apps/core test -- admin-console-assets.test.ts admin-console-api.test.ts knowledge-draft-api.test.ts`
  - `npm --workspace apps/core test -- admin-console-assets.test.ts admin-console-api.test.ts proactive-signal-api.test.ts`
  - `npm --workspace apps/core test -- admin-console-assets.test.ts admin-console-api.test.ts answer-draft-api.test.ts`
  - `node --test scripts/pilot-compose.test.mjs`
  - `git diff --check`

## Next Gate

The next product gate should validate the governed proactive delivery path in a real pilot group:

1. Keep global Iris disabled and the proactive delivery env disabled on production until deployment checks are complete.
2. Apply migrations and deploy the candidate build.
3. Enable proactive delivery for one pilot group only.
4. Create one overdue-action or quiet-thread candidate, approve delivery internally, and verify exactly one bounded Feishu card.
5. Return to default-off if any queue, DLQ, permission, or runtime-control gate is not clean.
