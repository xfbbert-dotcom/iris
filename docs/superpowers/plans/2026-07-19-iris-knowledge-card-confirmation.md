# Iris Knowledge Card Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 5B-1 as a complete, fail-closed Feishu knowledge-draft card loop: durable presentation, full-content card delivery, three-second callback acknowledgement, live actor authorization, idempotent confirmation/revision/rejection, and observable async recovery.

**Architecture:** Add a knowledge-card module beside the existing Phase 5A knowledge-governance module. Postgres owns presentation, interaction, confirmation, and send-outbox facts; Redis carries only verified callback jobs; a dedicated runtime composes the Feishu adapters and two worker loops. Card callbacks never approve synchronously, and the worker re-reads the exact draft revision, checks current runtime and group membership, then commits one atomic Postgres transition.

**Tech Stack:** TypeScript 5.5, Node.js 24, Fastify 5, Zod 4, PostgreSQL 16, Redis 7, Vitest 2, Feishu OpenAPI JSON 2.0 cards.

## Global Constraints

- Implement only Phase 5B-1. Do not create ActionProposal, approval-requirement, publication, OAuth review-page, or Feishu knowledge-base write code.
- Base all work on Phase 5A commit `20f8dc2462583959c8e1115cbd7d275e6ad46327` plus the approved design commit `1963d3b`.
- Use migration `0031_knowledge_draft_presentations.sql`; do not renumber or edit migration `0030`.
- Default `IRIS_KNOWLEDGE_CARD_ENABLED=false`; an empty `IRIS_KNOWLEDGE_CARD_GROUP_IDS` means no group is enabled.
- A card body may be confirmed only when the complete draft body is at most 8,000 Unicode code points, serialized card JSON is at most 24 KiB, and the card has at most 100 components.
- “需要修改” and “拒绝草稿” require a normalized reason of 1-2,000 characters; rejection requires the card confirmation field.
- Verify Feishu signature/token and a five-minute timestamp window before enqueue. A queue failure returns HTTP 200 with an explicit “操作未提交” toast and writes no business fact.
- Bound callback queue enqueue to 1,000 ms so a stalled Redis connection cannot consume Feishu's three-second response window.
- Use `header.event_id` as callback idempotency identity. Never trust callback title, content, risk, reviewer, group, actor role, or destination.
- The interaction worker must repeat global/group/capability gates, exact presentation/revision/version checks, current evidence validation, and live group membership checks.
- Postgres facts decide validity. Card update failure cannot roll back a committed draft transition.
- No full draft body, evidence body, access token, callback raw body, or external raw error may enter Redis, ordinary logs, status responses, or DLQ records.
- Public `/internal/*` remains blocked by Caddy. The only new public path is `/feishu/card-actions`.
- Every quality gate has an exit condition. Security, duplicate-action, data-loss, state-machine, and core-crash failures block Phase 5B-1; cosmetic variants and bulk administration go to the backlog.

---

## File Structure

Create focused units under `apps/core/src/knowledge-cards/`:

- `knowledge-card.ts`: bounded card actions, presentation types, normalization, idempotency keys.
- `knowledge-card-renderer.ts`: deterministic Feishu JSON 2.0 card construction and size checks.
- `knowledge-card-repository.ts`: storage interface and public error/result types.
- `postgres-knowledge-card-repository.ts`: atomic Postgres presentation, outbox, and interaction transitions.
- `approval-interaction-queue.ts`: minimal queue/DLQ contract and safe job schema.
- `redis-approval-interaction-queue.ts`: durable Redis implementation.
- `approval-interaction-worker.ts`: authorization and transition orchestration.
- `approval-interaction-worker-loop.ts`: polling lifecycle and bounded status snapshot.
- `knowledge-card-dispatcher.ts`: Postgres send-outbox claim and Feishu card delivery.
- `knowledge-card-dispatcher-loop.ts`: send polling lifecycle.
- `knowledge-card-api.ts`: authenticated presentation/status/DLQ routes.

Create Feishu-specific adapters under `apps/core/src/feishu/`:

- `feishu-card-action.ts`: strict callback-envelope parser.
- `feishu-card-action-gateway.ts`: ack-first verified enqueue boundary.
- `feishu-interactive-card-client.ts`: send/update interactive cards.
- `feishu-group-membership-checker.ts`: paginated live Open ID membership check.

Create `apps/core/src/runtime/knowledge-card-runtime.ts` to own its Postgres pool, Redis connection, workers, Feishu adapters, status, and close order. Keep `apps/core/src/app.ts` as composition only.

---

### Task 1: Freeze Domain And Migration Contracts

**Files:**
- Create: `apps/core/src/knowledge-cards/knowledge-card.ts`
- Create: `apps/core/src/knowledge-cards/knowledge-card-repository.ts`
- Create: `apps/core/migrations/0031_knowledge_draft_presentations.sql`
- Create: `apps/core/tests/knowledge-card.test.ts`
- Create: `apps/core/tests/postgres-knowledge-card-repository.test.ts`
- Modify: `apps/core/src/knowledge-governance/knowledge-draft.ts`
- Modify: `apps/core/src/knowledge-governance/knowledge-draft-state-machine.ts`
- Modify: `apps/core/tests/knowledge-draft-state-machine.test.ts`

**Interfaces:**
- Produces: `KnowledgeCardAction`, `KnowledgeDraftPresentation`, `ApprovalInteractionJob`, `KnowledgeCardRepository`.
- Produces: `group_confirmed` as an allowed `KnowledgeDraftEventType` and transition `pending_confirmation -> pending_review`.
- Consumes: existing `KnowledgeDraft`, `KnowledgeDraftEvidenceState`, and 512/2,000 character limits.

- [ ] **Step 1: Write failing domain and migration tests**

```ts
it("normalizes a confirmation job without carrying draft content", () => {
  expect(normalizeApprovalInteractionJob({
    idempotencyKey: "feishu-card:cli_a:event-1",
    eventId: "event-1",
    appId: "cli_a",
    actorOpenId: "ou_actor",
    chatId: "oc_group",
    presentationId: "presentation-1",
    draftId: "draft-1",
    revisionNumber: 2,
    draftVersion: 3,
    action: "confirm",
    receivedAt: new Date("2026-07-19T00:00:00.000Z"),
    attempts: 0,
  })).toMatchObject({ action: "confirm", draftId: "draft-1" });
});

it("allows group confirmation to enter pending review", () => {
  expect(validateKnowledgeDraftTransition({
    from: "pending_confirmation",
    to: "pending_review",
    eventType: "group_confirmed",
    sourceGroupId: "oc_group",
  })).toEqual({ ok: true });
});
```

The migration contract test must assert tables `knowledge_draft_presentations`, `knowledge_draft_presentation_events`, `knowledge_draft_group_confirmations`, and `knowledge_draft_presentation_outbox`; append-only triggers; a partial unique active-presentation index; unique callback event IDs; and `group_confirmed` in `knowledge_draft_events_event_type_check`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
npm --workspace apps/core test -- knowledge-card.test.ts knowledge-draft-state-machine.test.ts postgres-knowledge-card-repository.test.ts
```

Expected: FAIL because the new module, migration, and event type do not exist.

- [ ] **Step 3: Add domain constants and exact public types**

```ts
export const KNOWLEDGE_CARD_ACTIONS = ["confirm", "request_revision", "reject"] as const;
export const KNOWLEDGE_CARD_PRESENTATION_STATES = [
  "pending_send", "active", "superseded", "closed", "send_failed",
] as const;
export const KNOWLEDGE_CARD_REASON_MAX_CHARS = 2_000;
export const KNOWLEDGE_CARD_BODY_MAX_CODE_POINTS = 8_000;
export const KNOWLEDGE_CARD_JSON_MAX_BYTES = 24 * 1024;
export const KNOWLEDGE_CARD_MAX_COMPONENTS = 100;

export type ApprovalInteractionJob = {
  idempotencyKey: string;
  eventId: string;
  appId: string;
  actorOpenId: string;
  chatId: string;
  messageId?: string;
  presentationId: string;
  draftId: string;
  revisionNumber: number;
  draftVersion: number;
  action: "confirm" | "request_revision" | "reject";
  reason?: string;
  rejectionConfirmed?: true;
  receivedAt: Date;
  attempts: number;
};
```

`normalizeApprovalInteractionJob` must trim IDs, enforce safe positive integers, require reasons for revision/rejection, require `rejectionConfirmed === true` for rejection, reject unknown fields at the parser boundary, and return fresh `Date` objects.

- [ ] **Step 4: Add migration 0031**

Create presentation headers, append-only events, exact group confirmations, and a Postgres send outbox. Use checks equivalent to:

```sql
CREATE UNIQUE INDEX knowledge_draft_presentations_one_active_idx
  ON knowledge_draft_presentations (draft_id, revision_number, chat_id)
  WHERE state = 'active';

CREATE TABLE knowledge_draft_group_confirmations (
  draft_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  presentation_id TEXT NOT NULL REFERENCES knowledge_draft_presentations(id),
  actor_open_id TEXT NOT NULL CHECK (char_length(actor_open_id) BETWEEN 1 AND 512),
  callback_event_id TEXT NOT NULL UNIQUE CHECK (char_length(callback_event_id) BETWEEN 1 AND 512),
  membership_checked_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (draft_id, revision_number),
  FOREIGN KEY (draft_id, revision_number)
    REFERENCES knowledge_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT
);
```

Drop and recreate the generated `knowledge_draft_events_event_type_check` constraint so it adds `group_confirmed` without weakening prior values. Apply the existing append-only guard to presentation events and confirmations.

- [ ] **Step 5: Run migration and domain tests**

Expected: domain/state-machine tests pass; repository tests still fail only for missing implementation.

- [ ] **Step 6: Commit the contract**

```powershell
git add apps/core/migrations/0031_knowledge_draft_presentations.sql apps/core/src/knowledge-cards apps/core/src/knowledge-governance/knowledge-draft.ts apps/core/src/knowledge-governance/knowledge-draft-state-machine.ts apps/core/tests/knowledge-card.test.ts apps/core/tests/knowledge-draft-state-machine.test.ts apps/core/tests/postgres-knowledge-card-repository.test.ts
git commit -m "feat(core): define knowledge card facts"
```

---

### Task 2: Implement Atomic Presentation And Interaction Persistence

**Files:**
- Create: `apps/core/src/knowledge-cards/postgres-knowledge-card-repository.ts`
- Modify: `apps/core/src/knowledge-cards/knowledge-card-repository.ts`
- Modify: `apps/core/tests/postgres-knowledge-card-repository.test.ts`
- Modify: `apps/core/src/knowledge-governance/postgres-knowledge-draft-evidence.ts`

**Interfaces:**
- Consumes: `validateCurrentKnowledgeDraftEvidence` exported from the existing evidence module.
- Produces: `createPresentation`, `claimPresentationSend`, `completePresentationSend`, `failPresentationSend`, `applyInteraction`, `listPresentations`, and `getStatusCounts`.
- Produces result: `{ outcome: "applied" | "already_applied"; presentation; draft }` for interactions.

- [ ] **Step 1: Add failing repository tests for creation and outbox**

Test exact invariants:

```ts
const created = await repository.createPresentation({
  id: "presentation-1",
  draftId,
  expectedDraftVersion: 1,
  expectedRevisionNumber: 1,
  chatId: sourceGroupId,
  contentHash: "a".repeat(64),
  operationKey: "presentation:create:1",
  at,
});
expect(created.presentation.state).toBe("pending_send");
expect(await repository.getStatusCounts()).toMatchObject({ pendingSend: 1 });
```

Also test invalidated evidence, wrong group, wrong version, terminal/wrong status, duplicate operation replay, conflicting operation payload, and superseding a prior pending/active presentation.

- [ ] **Step 2: Run tests and verify failure**

Expected: FAIL with missing `createPostgresKnowledgeCardRepository`.

- [ ] **Step 3: Implement transactional presentation creation**

Use one transaction to advisory-lock the operation key, lock the draft, verify exact revision/version/status/group/current evidence, insert the presentation/event/outbox, and mark older same-draft presentations `superseded`. Never store card JSON or draft content in the outbox.

```ts
export interface KnowledgeCardRepository {
  createPresentation(input: CreateKnowledgeCardPresentationInput): Promise<KnowledgeCardMutationResult>;
  claimPresentationSend(input: { workerId: string; leaseUntil: Date; at: Date }): Promise<KnowledgeCardSendClaim | undefined>;
  completePresentationSend(input: { presentationId: string; workerId: string; messageId: string; at: Date }): Promise<void>;
  failPresentationSend(input: { presentationId: string; workerId: string; classification: "retryable" | "permanent" | "outcome_unknown"; errorCode: string; retryAt?: Date; at: Date }): Promise<void>;
  applyInteraction(input: ApplyKnowledgeCardInteractionInput): Promise<KnowledgeCardInteractionResult>;
  getPresentation(id: string): Promise<KnowledgeDraftPresentation | undefined>;
  listPresentations(input: { draftId: string; limit: number }): Promise<KnowledgeDraftPresentation[]>;
  getStatusCounts(): Promise<KnowledgeCardStatusCounts>;
}
```

- [ ] **Step 4: Add failing tests for atomic actions**

Cover:

- confirm inserts one `knowledge_draft_group_confirmations`, transitions draft to `pending_review`, increments version, closes presentation, inserts `group_confirmed` and `confirmed` events;
- revision request/rejection use required reason, existing state rules, and close the presentation;
- new draft revision makes the old presentation stale;
- callback replay returns `already_applied`;
- same callback event with different action conflicts;
- concurrent confirm/reject yields exactly one applied transition;
- membership timestamp older than 30 seconds is rejected;
- current evidence is checked inside the transaction.

- [ ] **Step 5: Implement `applyInteraction`**

Lock callback operation, presentation, and draft in that order. Require `active`, exact chat/draft/revision/version, `pending_confirmation`, and current evidence. For confirmation use:

```sql
INSERT INTO knowledge_draft_group_confirmations (...)
VALUES (...);
UPDATE knowledge_drafts
SET status = 'pending_review', version = version + 1, updated_at = $at
WHERE id = $draftId AND version = $expectedVersion;
```

For request-revision/reject, apply the existing transition semantics in the same transaction. Insert the presentation event and a card-update outbox item before commit.

- [ ] **Step 6: Run real Postgres tests twice**

Run the repository test with the existing test database harness twice to prove repeat-run isolation. Expected: all presentation and Phase 5A repository tests pass both times.

- [ ] **Step 7: Commit persistence**

```powershell
git add apps/core/src/knowledge-cards apps/core/src/knowledge-governance/postgres-knowledge-draft-evidence.ts apps/core/tests/postgres-knowledge-card-repository.test.ts
git commit -m "feat(core): persist knowledge card interactions"
```

---

### Task 3: Render Complete, Version-Bound Feishu Cards

**Files:**
- Create: `apps/core/src/knowledge-cards/knowledge-card-renderer.ts`
- Create: `apps/core/tests/knowledge-card-renderer.test.ts`

**Interfaces:**
- Consumes: a current `KnowledgeDraft`, `KnowledgeDraftPresentation`, and safe target display name.
- Produces: `{ status: "rendered"; card: Record<string, unknown>; json: string; contentHash: string; componentCount: number } | { status: "review_required"; reason: "body_too_large" | "card_too_large" | "too_many_components" }`.

- [ ] **Step 1: Write failing renderer tests**

Verify exact full body, title/risk/revision labels, action values, reason input, rejection confirmation, deterministic hash/JSON, escaping, Unicode code-point counting, 8,001-code-point refusal, 24-KiB refusal, and no evidence body.

```ts
expect(rendered.card).toMatchObject({ schema: "2.0" });
expect(rendered.json).toContain("完整草稿正文");
expect(rendered.json).toContain('"presentationId":"presentation-1"');
expect(rendered.json).not.toContain("secret evidence text");
```

- [ ] **Step 2: Run renderer tests and verify failure**

Expected: FAIL because `renderKnowledgeDraftCard` is missing.

- [ ] **Step 3: Implement deterministic renderer**

Build JSON 2.0 with a blue header, full Markdown body, bounded metadata, one review-reason input, one rejection confirmation checkbox, and three buttons. The callback value contains only:

```ts
{
  action,
  presentationId,
  draftId,
  revisionNumber,
  draftVersion,
}
```

Count code points with `[...content].length`, components while building, and final bytes with `Buffer.byteLength(json, "utf8")`. Return `review_required`; never truncate.

- [ ] **Step 4: Run renderer tests and typecheck**

Expected: PASS and no TypeScript errors.

- [ ] **Step 5: Commit renderer**

```powershell
git add apps/core/src/knowledge-cards/knowledge-card-renderer.ts apps/core/tests/knowledge-card-renderer.test.ts
git commit -m "feat(core): render governed knowledge cards"
```

---

### Task 4: Add Bounded Feishu Card And Membership Adapters

**Files:**
- Create: `apps/core/src/feishu/feishu-interactive-card-client.ts`
- Create: `apps/core/src/feishu/feishu-group-membership-checker.ts`
- Create: `apps/core/tests/feishu-interactive-card-client.test.ts`
- Create: `apps/core/tests/feishu-group-membership-checker.test.ts`

**Interfaces:**
- Produces: `sendCard({ chatId, cardJson, uuid }): Promise<{ messageId: string }>`.
- Produces: `updateCard({ messageId, cardJson }): Promise<void>`.
- Produces: `isCurrentMember({ chatId, openId }): Promise<boolean>`.
- Consumes: existing `FeishuTenantAccessTokenProvider`, bounded JSON response reader, timeout/error helpers.

- [ ] **Step 1: Write failing HTTP contract tests**

Assert exact URL/query/body for:

```text
POST /open-apis/im/v1/messages?receive_id_type=chat_id
PATCH /open-apis/im/v1/messages/:message_id
GET /open-apis/im/v1/chats/:chat_id/members?member_id_type=open_id&page_size=100
```

Cover token reuse, pagination, found-on-first-page early return, absent member, nonzero Feishu code, 401/403, 429, 5xx, timeout, malformed/oversized JSON, repeated page token, 20-page maximum, blank IDs, and response ID bounds.

- [ ] **Step 2: Run adapter tests and verify failure**

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the card client**

Send body:

```ts
{
  receive_id: chatId,
  msg_type: "interactive",
  content: cardJson,
  uuid,
}
```

Classify errors as `request_not_sent`, `remote_rejected`, `retryable_remote_failure`, or `outcome_unknown`; expose only the classification and bounded code to callers.

- [ ] **Step 4: Implement paginated membership checking**

Compare only exact normalized Open IDs. Reject duplicate page tokens and more than 20 pages as `membership_unavailable`, never as membership success.

- [ ] **Step 5: Run adapter tests**

Expected: PASS with no unhandled timers or token/body leakage in thrown messages.

- [ ] **Step 6: Commit adapters**

```powershell
git add apps/core/src/feishu/feishu-interactive-card-client.ts apps/core/src/feishu/feishu-group-membership-checker.ts apps/core/tests/feishu-interactive-card-client.test.ts apps/core/tests/feishu-group-membership-checker.test.ts
git commit -m "feat(core): add Feishu knowledge card adapters"
```

---

### Task 5: Build The Three-Second Card Callback Boundary

**Files:**
- Create: `apps/core/src/feishu/feishu-card-action.ts`
- Create: `apps/core/src/feishu/feishu-card-action-gateway.ts`
- Create: `apps/core/tests/feishu-card-action.test.ts`
- Create: `apps/core/tests/feishu-card-action-gateway.test.ts`
- Modify: `apps/core/src/feishu/feishu-auth.ts`
- Modify: `apps/core/tests/feishu-auth.test.ts`

**Interfaces:**
- Consumes: `ApprovalInteractionQueue.enqueue`.
- Produces: `parseFeishuCardAction(body): ParsedFeishuCardAction | undefined`.
- Produces: `handleCallback(request): Promise<{ statusCode: 200 | 401 | 400; body: unknown }>`.

- [ ] **Step 1: Write failing auth/parser tests**

Use a real schema 2.0 fixture and assert:

- exact `card.action.trigger` only;
- nonblank `header.event_id`, `header.app_id`, actor `open_id`, `context.open_chat_id`;
- exact allowed action and bounded identifiers;
- form reason and rejection confirmation parsing;
- missing/extra/wrong-type values fail;
- valid signature inside five minutes passes;
- old/future timestamp, missing raw body, token mismatch, signature mismatch fail.

- [ ] **Step 2: Run tests and verify failure**

Expected: parser module missing and timestamp-window assertions fail.

- [ ] **Step 3: Add timestamp validation to Feishu auth**

Extend verifier creation without breaking existing event tests:

```ts
createFeishuRequestVerifier(config, {
  now: () => new Date(),
  maxTimestampSkewSeconds: 300,
});
```

Require integer epoch seconds and compare absolute skew before signature acceptance.

- [ ] **Step 4: Implement strict callback parser and gateway**

The gateway verifies before parsing, creates `feishu-card:{appId}:{eventId}`, and attempts one queue enqueue with a 1,000 ms timeout. Successful response:

```ts
{ toast: { type: "info", content: "已收到，正在核验" } }
```

Enqueue failure response remains HTTP 200:

```ts
{ toast: { type: "error", content: "操作未提交，请稍后重试" } }
```

It must not query Postgres, Feishu membership, or draft content.

- [ ] **Step 5: Verify the callback completes before slow dependencies**

Use a deferred queue promise and fake timers to prove the gateway returns the failure toast after the 1,000 ms enqueue timeout instead of hanging. A fast enqueue must return immediately. The gateway must not receive repository, membership, or draft-content dependencies, so those operations are structurally impossible at this boundary.

- [ ] **Step 6: Commit callback boundary**

```powershell
git add apps/core/src/feishu apps/core/tests/feishu-auth.test.ts apps/core/tests/feishu-card-action.test.ts apps/core/tests/feishu-card-action-gateway.test.ts
git commit -m "feat(core): accept Feishu card actions safely"
```

---

### Task 6: Implement The Reliable Approval Interaction Queue

**Files:**
- Create: `apps/core/src/knowledge-cards/approval-interaction-queue.ts`
- Create: `apps/core/src/knowledge-cards/redis-approval-interaction-queue.ts`
- Create: `apps/core/tests/approval-interaction-queue.test.ts`
- Create: `apps/core/tests/redis-approval-interaction-queue.test.ts`

**Interfaces:**
- Produces: enqueue/claim/ack/fail, pending/processing/delayed/DLQ counts, list/replay/delete DLQ.
- Consumes: normalized `ApprovalInteractionJob` containing no draft body.

- [ ] **Step 1: Write failing queue contract tests**

Reuse the behavioral shape of the existing memory-extraction queue but limit it to this job. Test enqueue dedupe, FIFO ordering by `receivedAt`, atomic claim, lease recovery, exponential delayed retry, max-attempt DLQ, exact counts, malformed payload quarantine, replay, duplicate replay, delete, Redis failure preservation, and bounded error text.

- [ ] **Step 2: Run queue tests and verify failure**

Expected: FAIL with missing queue factories.

- [ ] **Step 3: Implement Redis keys and atomic scripts**

Use prefix `iris:approval:interactions` with authoritative ready/delayed/processing/member/DLQ indexes. Serialize dates as ISO strings and parse through `normalizeApprovalInteractionJob`. Default max attempts is 5; delays are 1s, 5s, 30s, and 120s, capped at 10 minutes.

```ts
export interface ApprovalInteractionQueue {
  enqueue(job: ApprovalInteractionJob): Promise<"enqueued" | "duplicate">;
  claimBatch(input: { limit: number; workerId: string; now: Date; leaseUntil: Date }): Promise<ApprovalInteractionJob[]>;
  acknowledge(input: { job: ApprovalInteractionJob; workerId: string }): Promise<void>;
  handleFailure(input: { job: ApprovalInteractionJob; workerId: string; errorCode: string; at: Date }): Promise<{ action: "delayed" | "dead_lettered" }>;
  getCounts(): Promise<{ pending: number; processing: number; delayed: number; deadLetter: number }>;
  listDeadLetters(input: { limit: number }): Promise<ApprovalInteractionDeadLetter[]>;
  replayDeadLetter(id: string): Promise<"replayed" | "not_found">;
  deleteDeadLetter(id: string): Promise<"deleted" | "not_found">;
}
```

- [ ] **Step 4: Run queue tests twice**

Expected: all pass twice with no leaked state between prefixes.

- [ ] **Step 5: Commit queue**

```powershell
git add apps/core/src/knowledge-cards/approval-interaction-queue.ts apps/core/src/knowledge-cards/redis-approval-interaction-queue.ts apps/core/tests/approval-interaction-queue.test.ts apps/core/tests/redis-approval-interaction-queue.test.ts
git commit -m "feat(core): queue knowledge card interactions"
```

---

### Task 7: Process Authorized Actions And Dispatch Cards

**Files:**
- Create: `apps/core/src/knowledge-cards/approval-interaction-worker.ts`
- Create: `apps/core/src/knowledge-cards/approval-interaction-worker-loop.ts`
- Create: `apps/core/src/knowledge-cards/knowledge-card-dispatcher.ts`
- Create: `apps/core/src/knowledge-cards/knowledge-card-dispatcher-loop.ts`
- Create: `apps/core/tests/approval-interaction-worker.test.ts`
- Create: `apps/core/tests/approval-interaction-worker-loop.test.ts`
- Create: `apps/core/tests/knowledge-card-dispatcher.test.ts`
- Create: `apps/core/tests/knowledge-card-dispatcher-loop.test.ts`

**Interfaces:**
- Consumes: repository, queue, renderer, Feishu card client, membership checker, and `canUseKnowledgeCards(groupId)` runtime gate.
- Produces: bounded batch results and worker snapshots for status APIs.

- [ ] **Step 1: Write failing interaction worker tests**

Assert order and fail-closed behavior:

1. runtime/group gate;
2. exact presentation fetch;
3. actor differs from configured bot Open ID;
4. live membership check;
5. atomic repository action;
6. best-effort/result-outbox card update;
7. queue acknowledge.

Test disabled runtime, nonmember, bot actor, unavailable membership API, stale card, invalidated evidence, duplicate callback, revision/rejection reason, committed transition plus update failure, retry/DLQ classification, and no content in results.

- [ ] **Step 2: Implement worker and loop**

Use a 30-second membership evidence maximum in the repository call. Stable business denials acknowledge the queue and update the card with a bounded denial; transient Feishu/Redis/Postgres failures call queue failure handling. A committed idempotent transition is never re-applied.

- [ ] **Step 3: Write failing presentation dispatcher tests**

Cover current presentation send, runtime disabled before call, evidence invalidation, renderer `review_required`, stable UUID, success message ID, explicit retryable failure, permanent failure, outcome unknown with no retry, and lease recovery.

- [ ] **Step 4: Implement dispatcher and loop**

The dispatcher claims one Postgres outbox row, re-reads exact current draft/presentation, renders full content, and calls `sendCard`. On success it atomically activates the presentation. On `outcome_unknown`, mark `send_failed` plus outbox `outcome_unknown`; do not resend automatically.

- [ ] **Step 5: Run all worker/dispatcher tests**

Expected: PASS with queue/outbox counts reaching zero on success.

- [ ] **Step 6: Commit orchestration**

```powershell
git add apps/core/src/knowledge-cards apps/core/tests/approval-interaction-worker.test.ts apps/core/tests/approval-interaction-worker-loop.test.ts apps/core/tests/knowledge-card-dispatcher.test.ts apps/core/tests/knowledge-card-dispatcher-loop.test.ts
git commit -m "feat(core): process knowledge card confirmations"
```

---

### Task 8: Wire Runtime, Routes, Status, And Default-Off Deployment

**Files:**
- Create: `apps/core/src/runtime/knowledge-card-runtime.ts`
- Create: `apps/core/src/knowledge-cards/knowledge-card-api.ts`
- Create: `apps/core/tests/knowledge-card-runtime.test.ts`
- Create: `apps/core/tests/knowledge-card-api.test.ts`
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/tests/env.test.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/server-startup.test.ts`
- Modify: `apps/core/tests/runtime-startup-promise.test.ts`
- Modify: `apps/core/tests/runtime-close.test.ts`
- Modify: `apps/core/src/admin/internal-status-snapshot.ts`
- Modify: `apps/core/src/admin/internal-rollout-readiness.ts`
- Modify: `apps/core/tests/internal-status-snapshot.test.ts`
- Modify: `apps/core/tests/internal-rollout-readiness.test.ts`
- Modify: `deploy/pilot/docker-compose.yml`
- Modify: `deploy/pilot/ci.env`
- Modify: `scripts/pilot-compose.test.mjs`

**Interfaces:**
- Produces: `KnowledgeCardRuntime` with `gateway`, `repository`, `deadLetters`, `start`, `getStatus`, and idempotent `close`.
- Produces internal routes for presentation creation/listing, queue status, and DLQ operations.

- [ ] **Step 1: Write failing env/runtime tests**

Required config shape:

```ts
type KnowledgeCardRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      databaseUrl: string;
      redisUrl: string;
      enabledGroupIds: string[];
      intervalMs: number;
      batchLimit: number;
      botOpenId: string;
    };
```

Test default off, exact `true`, nonempty allowlist requirement, duplicate/blank/oversized group IDs, required DB/Redis/Feishu/bot config, timer/batch bounds, partial configuration startup failure, start/close ordering, and failed-startup cleanup.

- [ ] **Step 2: Implement config and runtime composition**

Read `IRIS_KNOWLEDGE_CARD_ENABLED`, `IRIS_KNOWLEDGE_CARD_GROUP_IDS`, `IRIS_KNOWLEDGE_CARD_WORKER_INTERVAL_MS` (default 1000), and `IRIS_KNOWLEDGE_CARD_WORKER_BATCH_LIMIT` (default 10, maximum 100). Create one PG pool and one Redis client owned by the runtime; share the existing tenant-token provider between card and membership adapters.

- [ ] **Step 3: Write failing app and API tests**

Cover:

- `/feishu/card-actions` verification and ack/failure toast;
- `POST /internal/knowledge-drafts/:id/presentations` with only `expectedVersion` and `operationKey`; the server reads the current revision and labels any suggested location as unapproved;
- overlong draft returns `409 review_surface_required` and creates no presentation;
- runtime/group disabled returns `403 iris_runtime_disabled`;
- presentation list and status;
- DLQ list/replay/delete authentication and bounds;
- absent runtime returns 503 internally and safe failure toast publicly;
- `/internal/status` includes all four queue counts without body content;
- close waits for both loops before Redis/PG close.

- [ ] **Step 4: Register routes without expanding app business logic**

`app.ts` should only construct the runtime, register `knowledge-card-api.ts`, register the callback route, expose status, and close resources. Parsing and mutation remain in their modules.

- [ ] **Step 5: Add readiness and deployment defaults**

When disabled, readiness reports a safe disabled state. When enabled, it fails if worker loops are stopped, required config is absent, or Redis/Postgres status cannot be read. Add compose variables with safe defaults:

```yaml
IRIS_KNOWLEDGE_CARD_ENABLED: ${IRIS_KNOWLEDGE_CARD_ENABLED:-false}
IRIS_KNOWLEDGE_CARD_GROUP_IDS: ${IRIS_KNOWLEDGE_CARD_GROUP_IDS:-}
```

`deploy/pilot/ci.env` must keep the feature false and the allowlist empty.

- [ ] **Step 6: Run focused runtime/API/deployment tests**

Expected: all new tests pass; existing Feishu event and startup tests remain green.

- [ ] **Step 7: Commit runtime wiring**

```powershell
git add apps/core/src apps/core/tests deploy/pilot/docker-compose.yml deploy/pilot/ci.env scripts/pilot-compose.test.mjs
git commit -m "feat(core): wire knowledge card runtime"
```

---

### Task 9: Document And Verify The Phase 5B-1 Exit Gate

**Files:**
- Create: `docs/runbooks/iris-knowledge-card-confirmation-acceptance.md`
- Create: `docs/pull-requests/2026-07-19-iris-knowledge-card-confirmation.md`
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Modify: `README.md`
- Modify: `scripts/pilot-smoke.mjs`
- Modify: `scripts/pilot-smoke-lib.test.mjs`

**Interfaces:**
- Produces: operator-safe pilot enable/disable, queue-drain, card-confirm/revision/reject, stale-card, and rollback instructions.
- Produces: Phase 5B-1 acceptance evidence without claiming 5B-2/5B-3 completion.

- [ ] **Step 1: Write the runbook and pilot smoke assertions**

The runbook must require:

1. approved commit and same-SHA Core image;
2. Core/Postgres/Redis/AI Worker healthy;
3. all existing and new pending/processing/delayed/DLQ counts zero;
4. global, three known groups, knowledge cards, and card allowlist disabled before rollout;
5. only the pilot group enabled;
6. one full-content confirmation, one required-revision with reason, one rejection with confirmation, one stale-card click, one duplicate callback replay, and one runtime-disabled click;
7. Postgres event/confirmation facts match visible Feishu results;
8. non-pilot group has no card or interaction facts;
9. rollback disables card env and group runtime before rebuilding;
10. no statement that knowledge-base publication exists.

- [ ] **Step 2: Run focused and full verification**

Run:

```powershell
npm run typecheck
npm run build
npm test
npm run test:python
npm run test:pilot
docker compose config
npm run readiness -- --env-file deploy/pilot/ci.env
npm run pilot:config
git diff --check
```

Expected: every command exits 0. Record exact test totals in the PR description, not in source files that would churn on each test addition.

- [ ] **Step 3: Perform security-focused diff review**

Search and inspect:

```powershell
rg -n "content|rawBody|access_token|appSecret|reason|actorOpenId" apps/core/src/knowledge-cards apps/core/src/feishu
rg -n "IRIS_KNOWLEDGE_CARD" deploy scripts apps/core/src
git diff --check
git status --short
```

Expected: no secret/full-content queue or log path, all new rollout gates default off, and only intended files changed.

- [ ] **Step 4: Commit rollout contract**

```powershell
git add docs/runbooks/iris-knowledge-card-confirmation-acceptance.md docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md README.md scripts/pilot-smoke.mjs scripts/pilot-smoke-lib.test.mjs
git commit -m "docs: add knowledge card rollout contract"
```

- [ ] **Step 5: Push and open a draft PR stacked on PR #10**

Create the PR body with this exact scope declaration:

```markdown
## Scope

Implements Iris Phase 5B-1: governed, version-bound Feishu cards for knowledge-draft group confirmation, revision requests, and rejection.

## Safety boundaries

- All knowledge-card runtime gates default off.
- Callback handling acknowledges first and processes through a durable queue.
- Current runtime, presentation, draft evidence, and group membership are revalidated before mutation.
- This PR does not add ActionProposal, owner/admin approval, OAuth review pages, or Feishu knowledge-base writes.
```

Then run:

```powershell
git push -u origin codex/iris-knowledge-approval-actions
gh pr create --draft --base codex/iris-knowledge-draft-facts --head codex/iris-knowledge-approval-actions --title "feat: add governed knowledge card confirmation" --body-file docs/pull-requests/2026-07-19-iris-knowledge-card-confirmation.md
```

---

## Plan Self-Review Record

- **Spec coverage:** Phase 5B-1 card content, version binding, ack-first callback, queue/DLQ, live membership, atomic confirmation/revision/rejection, card send/update, runtime gates, observability, rollout, and completion evidence each map to a task.
- **Intentional exclusions:** Phase 5B-2 and 5B-3 requirements remain excluded and are explicitly guarded against false completion claims.
- **Type consistency:** `presentationId`, `draftId`, `revisionNumber`, `draftVersion`, `eventId`, `actorOpenId`, and the three action names are identical from card value through callback, queue, worker, and repository.
- **Placeholder scan:** Every task names exact files, interfaces, commands, expected results, and bounded failure behavior; no unresolved implementation marker remains.
- **Exit condition:** After Task 9 automated gates pass and the draft PR is open, implementation stops expanding 5B-1. Real Feishu pilot evidence is the only remaining gate before beginning the 5B-2 plan.
