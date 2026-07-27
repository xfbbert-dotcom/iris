# Iris Proactive Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let current Feishu group members rate proactive Iris reminders as helpful or irrelevant, suppress repeated irrelevant reminders, and show bounded aggregate effectiveness in the Admin Console.

**Architecture:** Extend the existing proactive delivery card and authenticated card-action queue with a third typed interaction. A focused worker performs runtime, delivery-binding, and live membership checks before an atomic Postgres feedback write; irrelevant feedback updates a bounded suppression projection checked during candidate persistence, approval, claim, and final pre-send authorization. Proactive delivery requires the feedback-card runtime for every delivery group. The existing group-scoped proactive Admin Console reads aggregate metrics only.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Redis, Feishu card schema 2.0, Vitest, browser-native HTML/CSS/JavaScript.

## Global Constraints

- Keep production fail closed; do not start Caddy or enable global/group/proactive runtime flags.
- Do not call Gemini or any other model.
- Preserve the existing fast callback acknowledgement and Redis retry/DLQ path.
- Store no message text, evidence text, raw actor identity, prompt, or answer in feedback tables or APIs.
- Accept feedback only from a current member of the exact delivery group.
- `IRIS_PROACTIVE_IRRELEVANT_SUPPRESSION_DAYS` defaults to `30` and accepts integers from `1` through `365`.
- One actor contributes at most one result per delivery; the first valid result wins.
- An irrelevant result suppresses the same `(groupId, kind, entityId)` only until the bounded expiry.
- A suppression committed after queue claim must atomically cancel the delivery before external send.
- Proactive delivery must fail closed unless knowledge-card feedback is enabled for every delivery group.
- Admin responses are group-scoped, bounded, and contain aggregates only.

---

### Task 1: Persist Feedback And Suppression

**Files:**
- Create: `apps/core/migrations/0040_proactive_signal_feedback.sql`
- Modify: `apps/core/src/proactive-signals/proactive-signal-repository.ts`
- Modify: `apps/core/tests/proactive-signal-repository.test.ts`
- Modify: `apps/core/tests/agent-execution-ledger.test.ts`

**Interfaces:**
- Produces:

```ts
export type ProactiveSignalFeedback = "helpful" | "irrelevant";

export type ProactiveSignalFeedbackResult =
  | { status: "applied" }
  | { status: "already_applied" }
  | { status: "stale_binding" };

export type ProactiveSignalFeedbackSummary = {
  groupId: string;
  totalCount: number;
  helpfulCount: number;
  irrelevantCount: number;
  helpfulRate: number | null;
  activeSuppressionCount: number;
  lastFeedbackAt?: Date;
};
```

- Extends `ProactiveSignalRecordResult` with `suppressedCount`.
- Extends `ProactiveSignalRepository` with:

```ts
recordFeedback(input: {
  idempotencyKey: string;
  deliveryId: string;
  candidateIdempotencyKey: string;
  groupId: string;
  messageId?: string;
  entityVersion: number;
  actorFingerprint: string;
  feedback: ProactiveSignalFeedback;
  suppressUntil: Date;
  at: Date;
}): Promise<ProactiveSignalFeedbackResult>;

getFeedbackSummary(input: {
  groupId: string;
  at: Date;
}): Promise<ProactiveSignalFeedbackSummary>;
```

- [ ] **Step 1: Write migration contract tests**

Assert migration `0040_proactive_signal_feedback.sql` creates:

```sql
CREATE TABLE proactive_signal_feedback_events
CREATE TABLE proactive_signal_suppressions
UNIQUE (delivery_id, actor_fingerprint)
CHECK (feedback IN ('helpful', 'irrelevant'))
```

Also assert append-only update/delete and truncate triggers exist for the event table.

- [ ] **Step 2: Run the migration test and verify RED**

Run:

```powershell
npm --workspace apps/core test -- proactive-signal-repository.test.ts
```

Expected: failure because migration `0040` is absent.

- [ ] **Step 3: Add migration `0040`**

Create immutable `proactive_signal_feedback_events` linked to sent proactive deliveries and a
mutable `proactive_signal_suppressions` projection keyed by group, kind, and entity ID. Add
group/time indexes used by summary and suppression queries.

- [ ] **Step 4: Write failing repository tests**

Add SQL-contract and Postgres-backed cases proving:

```ts
await repository.recordFeedback({
  idempotencyKey: "feishu-card:cli:event-1",
  deliveryId: "delivery-1",
  candidateIdempotencyKey: "quiet_open_thread:thread-1:2",
  groupId: "oc_pilot",
  messageId: "om_card",
  entityVersion: 2,
  actorFingerprint: "a".repeat(64),
  feedback: "irrelevant",
  suppressUntil: new Date("2026-08-26T00:00:00.000Z"),
  at: new Date("2026-07-27T00:00:00.000Z"),
});
```

Prove:

- exact first write returns `applied`;
- replay and second callback from the same actor/delivery return `already_applied`;
- wrong group, delivery, candidate, message, version, or unsent delivery returns `stale_binding`;
- irrelevant inserts/extends one suppression only after an event wins;
- helpful creates no suppression;
- summary counts are group-scoped and do not return actor fingerprints;
- candidate recording excludes active suppressions and increments `suppressedCount`;
- expired suppressions no longer filter candidates.

- [ ] **Step 5: Run repository tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- proactive-signal-repository.test.ts
```

Expected: missing methods/types and suppression assertions fail.

- [ ] **Step 6: Implement repository behavior**

Use one transaction for feedback insertion and optional suppression upsert. Validate all bounded
identifiers, 64-character lowercase hexadecimal actor fingerprints, dates, versions, and feedback
values. Recheck the exact sent delivery/candidate binding inside the write transaction.

Filter active suppressions in candidate insertion with a database predicate at the insertion
statement, not an in-memory cache. Return:

```ts
{
  recordedCount,
  existingCount,
  suppressedCount,
  recordedKeys,
}
```

where the three counts sum to the normalized input length.

- [ ] **Step 7: Run focused repository tests and verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- proactive-signal-repository.test.ts agent-execution-ledger.test.ts
```

Expected: all selected tests pass; Postgres tests may skip only when the test database URL is absent.

- [ ] **Step 8: Commit**

```powershell
git add apps/core/migrations/0040_proactive_signal_feedback.sql apps/core/src/proactive-signals/proactive-signal-repository.ts apps/core/tests/proactive-signal-repository.test.ts apps/core/tests/agent-execution-ledger.test.ts
git commit -m "feat(core): persist proactive reminder feedback"
```

---

### Task 2: Add Typed Feishu Feedback Callbacks

**Files:**
- Modify: `apps/core/src/knowledge-cards/knowledge-card.ts`
- Modify: `apps/core/src/feishu/feishu-card-action.ts`
- Modify: `apps/core/src/feishu/feishu-card-action-gateway.ts`
- Modify: `apps/core/src/proactive-signals/proactive-signal-card-renderer.ts`
- Modify: `apps/core/tests/approval-interaction-queue.test.ts`
- Modify: `apps/core/tests/redis-approval-interaction-queue.test.ts`
- Modify: `apps/core/tests/feishu-card-action.test.ts`
- Modify: `apps/core/tests/feishu-card-action-gateway.test.ts`
- Modify: `apps/core/tests/proactive-signal-card-renderer.test.ts`

**Interfaces:**
- Produces:

```ts
export const PROACTIVE_SIGNAL_FEEDBACK_ACTIONS = ["helpful", "irrelevant"] as const;

export type ProactiveSignalFeedbackInteractionJob = ApprovalInteractionJobCommon & {
  kind: "proactive_signal_feedback";
  deliveryId: string;
  candidateIdempotencyKey: string;
  entityVersion: number;
  action: "helpful" | "irrelevant";
};
```

- Callback values contain only strings:

```ts
{
  kind: "proactive_signal_feedback",
  action: "helpful",
  deliveryId,
  candidateIdempotencyKey,
  entityVersion: String(entityVersion),
}
```

- [ ] **Step 1: Write failing job-normalization and queue tests**

Prove the third interaction kind round-trips through in-memory and Redis queues, rejects unknown
fields/actions/noncanonical versions, and preserves existing knowledge/action jobs unchanged.

- [ ] **Step 2: Run queue tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- approval-interaction-queue.test.ts redis-approval-interaction-queue.test.ts
```

Expected: `proactive_signal_feedback` is rejected as an unknown kind.

- [ ] **Step 3: Extend the normalized interaction union**

Add the new action constant, job type, allowed fields, action validation, and identity conversion.
Feedback actions never accept `intentId` or free-form `reason`.

- [ ] **Step 4: Write failing parser/gateway tests**

Use a signed schema-2 callback with an empty form value and assert:

```ts
expect(parsed).toMatchObject({
  kind: "proactive_signal_feedback",
  deliveryId: "delivery-1",
  candidateIdempotencyKey: "quiet_open_thread:thread-1:2",
  entityVersion: 2,
  action: "helpful",
});
```

Prove malformed bindings return `400`, authenticated valid feedback is queued, duplicate event IDs
return HTTP 200, and callback diagnostics recognize the new kind/action without including values.

- [ ] **Step 5: Run parser/gateway tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- feishu-card-action.test.ts feishu-card-action-gateway.test.ts
```

Expected: parser and diagnostic recognition assertions fail.

- [ ] **Step 6: Implement parser and gateway normalization**

Permit proactive feedback with absent or empty `form_value`, while keeping non-empty reasons
mandatory for existing request-revision/reject actions. Keep the same one-second bounded queue
submission and HTTP 200 acknowledgement behavior.

- [ ] **Step 7: Write failing card-renderer tests**

Assert the proactive card contains:

```ts
text: { tag: "plain_text", content: "有帮助" }
text: { tag: "plain_text", content: "不相关" }
```

and exact typed callback values bound to the delivery/candidate/version. Assert no actor identity,
evidence message ID, or message body appears in card JSON and byte/component limits still pass.

- [ ] **Step 8: Implement the two feedback buttons**

Render one compact form after the reminder body. Both buttons use `form_action_type: "submit"` and
callback behavior; `有帮助` is primary and `不相关` is default.

- [ ] **Step 9: Run the complete callback/card slice**

Run:

```powershell
npm --workspace apps/core test -- approval-interaction-queue.test.ts redis-approval-interaction-queue.test.ts feishu-card-action.test.ts feishu-card-action-gateway.test.ts proactive-signal-card-renderer.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 10: Commit**

```powershell
git add apps/core/src/knowledge-cards/knowledge-card.ts apps/core/src/feishu/feishu-card-action.ts apps/core/src/feishu/feishu-card-action-gateway.ts apps/core/src/proactive-signals/proactive-signal-card-renderer.ts apps/core/tests/approval-interaction-queue.test.ts apps/core/tests/redis-approval-interaction-queue.test.ts apps/core/tests/feishu-card-action.test.ts apps/core/tests/feishu-card-action-gateway.test.ts apps/core/tests/proactive-signal-card-renderer.test.ts
git commit -m "feat(core): accept proactive card feedback"
```

---

### Task 3: Process Feedback With Live Membership And Runtime Gates

**Files:**
- Create: `apps/core/src/proactive-signals/proactive-signal-feedback-worker.ts`
- Create: `apps/core/tests/proactive-signal-feedback-worker.test.ts`
- Modify: `apps/core/src/knowledge-cards/approval-interaction-worker.ts`
- Modify: `apps/core/src/runtime/knowledge-card-runtime.ts`
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/approval-interaction-worker.test.ts`
- Modify: `apps/core/tests/knowledge-card-runtime.test.ts`
- Modify: `apps/core/tests/env.test.ts`
- Modify: `apps/core/tests/server-startup.test.ts`

**Interfaces:**
- Produces:

```ts
export type ProactiveSignalFeedbackWorkerResult = {
  status: "applied" | "already_applied" | "denied" | "retryable";
  code:
    | "feedback_applied"
    | "duplicate_feedback"
    | "runtime_disabled"
    | "bot_actor"
    | "not_current_member"
    | "stale_delivery"
    | "membership_unavailable"
    | "repository_unavailable"
    | "internal_error";
};
```

- `KnowledgeCardRuntime` receives the optional proactive repository before startup and delegates
  the third interaction kind to this worker.

- [ ] **Step 1: Write failing focused worker tests**

Cover:

- enabled exact delivery + current member records helpful feedback;
- irrelevant computes `suppressUntil` from the configured day count;
- bot actor, non-member, stale binding, and disabled runtime are stable denials;
- membership/repository exceptions are retryable;
- the runtime gate is checked before membership I/O and immediately before mutation;
- actor fingerprint is deterministic SHA-256 of `appId + ":" + actorOpenId`;
- no raw actor identity is passed to `recordFeedback`.

- [ ] **Step 2: Run focused worker tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- proactive-signal-feedback-worker.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the focused worker**

Create `createProactiveSignalFeedbackWorker()` with injected repository, membership checker,
runtime gate, bot ID, suppression days, and clock. Normalize all identifiers before I/O and map
repository `stale_binding` to `stale_delivery`.

- [ ] **Step 4: Run focused worker tests and verify GREEN**

Run the same command and expect all tests to pass.

- [ ] **Step 5: Write failing delegation and runtime tests**

Assert the generic interaction worker:

- delegates only `proactive_signal_feedback`;
- acknowledges applied, duplicate, and stable-denied feedback;
- routes retryable results through existing bounded retry/DLQ handling;
- never calls knowledge draft presentation lookups or sensitive intent storage for feedback.

Assert environment parsing:

```ts
expect(readProactiveFeedbackConfig({})).toEqual({ suppressionDays: 30 });
expect(readProactiveFeedbackConfig({
  IRIS_PROACTIVE_IRRELEVANT_SUPPRESSION_DAYS: "45",
})).toEqual({ suppressionDays: 45 });
```

Values `0`, `366`, decimals, and nonnumeric strings must throw.

- [ ] **Step 6: Run delegation/runtime tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- approval-interaction-worker.test.ts knowledge-card-runtime.test.ts env.test.ts server-startup.test.ts
```

Expected: worker dependency, config reader, and composition assertions fail.

- [ ] **Step 7: Wire the worker**

Route feedback before sensitive-intent resolution. Extend `createKnowledgeCardRuntime()` input with
the optional proactive repository, construct the focused worker using the runtime-owned membership
checker, and pass it to `createApprovalInteractionWorker`.

In `app.ts`, pass:

```ts
dependencies.proactiveSignalRepository ?? proactiveSignalRuntime?.repository
```

to knowledge-card runtime creation. Do not change runtime start order or callback routes.

- [ ] **Step 8: Run the complete worker/runtime slice**

Run:

```powershell
npm --workspace apps/core test -- proactive-signal-feedback-worker.test.ts approval-interaction-worker.test.ts knowledge-card-runtime.test.ts env.test.ts server-startup.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 9: Commit**

```powershell
git add apps/core/src/proactive-signals/proactive-signal-feedback-worker.ts apps/core/src/knowledge-cards/approval-interaction-worker.ts apps/core/src/runtime/knowledge-card-runtime.ts apps/core/src/config/env.ts apps/core/src/app.ts apps/core/tests/proactive-signal-feedback-worker.test.ts apps/core/tests/approval-interaction-worker.test.ts apps/core/tests/knowledge-card-runtime.test.ts apps/core/tests/env.test.ts apps/core/tests/server-startup.test.ts
git commit -m "feat(core): govern proactive reminder feedback"
```

---

### Task 4: Expose Aggregate Effectiveness In Admin Console

**Files:**
- Modify: `apps/core/src/proactive-signals/proactive-signal-api.ts`
- Modify: `apps/core/src/admin-console/admin-console-assets.ts`
- Modify: `apps/core/tests/proactive-signal-api.test.ts`
- Modify: `apps/core/tests/admin-console-assets.test.ts`

**Interfaces:**
- Produces:

```http
GET /internal/proactive-signals/groups/:groupId/feedback-summary
```

```json
{
  "ok": true,
  "groupId": "oc_pilot",
  "totalCount": 12,
  "helpfulCount": 9,
  "irrelevantCount": 3,
  "helpfulRate": 0.75,
  "activeSuppressionCount": 2,
  "lastFeedbackAt": "2026-07-27T00:00:00.000Z"
}
```

- [ ] **Step 1: Write failing API tests**

Assert bearer-protected registration uses the existing internal hook, validates a bounded group ID,
calls the repository with the injected clock, serializes the optional timestamp, and returns stable
`503`/`500` errors without leaking repository messages.

- [ ] **Step 2: Run API tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- proactive-signal-api.test.ts
```

Expected: route returns `404`.

- [ ] **Step 3: Implement the summary endpoint**

Add the exact group-scoped GET route next to candidate listing. Return aggregates only.

- [ ] **Step 4: Write failing Admin Console asset tests**

Assert HTML contains a `proactive-feedback-summary` region and script requests
`/feedback-summary`, renders all six aggregate fields, uses the same explicit group ID input, and
contains no actor/message/evidence rendering keys.

- [ ] **Step 5: Run asset tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- admin-console-assets.test.ts
```

Expected: feedback-effect elements and script are absent.

- [ ] **Step 6: Implement the aggregate panel**

Add a compact unframed summary beneath the proactive controls. Refresh it after group refresh,
scan, dismiss, and approve actions. Render `--` for no feedback rate/time and a percentage with one
decimal place otherwise.

- [ ] **Step 7: Run the Admin/API slice**

Run:

```powershell
npm --workspace apps/core test -- proactive-signal-api.test.ts admin-console-assets.test.ts admin-console-api.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit**

```powershell
git add apps/core/src/proactive-signals/proactive-signal-api.ts apps/core/src/admin-console/admin-console-assets.ts apps/core/tests/proactive-signal-api.test.ts apps/core/tests/admin-console-assets.test.ts
git commit -m "feat(core): show proactive feedback effectiveness"
```

---

### Task 5: Document, Verify, And Publish

**Files:**
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Modify: `docs/operations/internal-rollout-runbook.md`
- Create: `docs/pull-requests/2026-07-27-iris-proactive-feedback-loop.md`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: operator configuration, acceptance evidence, pushed branch, and a GitHub pull request.

- [ ] **Step 1: Document the bounded configuration and rollout state**

Add:

```dotenv
IRIS_PROACTIVE_IRRELEVANT_SUPPRESSION_DAYS=30
```

Document migration `0040`, feedback metrics, privacy boundary, and the fact that production remains
disabled pending one real Feishu feedback-card gray pass.

- [ ] **Step 2: Run focused tests**

Run:

```powershell
npm --workspace apps/core test -- proactive-signal-repository.test.ts proactive-signal-card-renderer.test.ts feishu-card-action.test.ts feishu-card-action-gateway.test.ts proactive-signal-feedback-worker.test.ts approval-interaction-worker.test.ts proactive-signal-api.test.ts admin-console-assets.test.ts knowledge-card-runtime.test.ts server-startup.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 3: Run full verification**

Run:

```powershell
npm --workspace apps/core test
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
node --test scripts/pilot-compose.test.mjs
git diff --check
```

Expected: zero failures and no diff-check output.

- [ ] **Step 4: Verify production fail-closed state read-only**

Use the existing approved VPS inspection path and record:

- global and desired global disabled;
- proactive speech disabled;
- Caddy stopped;
- Core/Postgres/Redis/AI Worker healthy;
- all event/document/reindex/memory pending and DLQ counts clean.

Do not probe Gemini, start Caddy, replay queues, deploy, or change runtime flags in this task.

- [ ] **Step 5: Commit documentation**

```powershell
git add .env.example docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md docs/operations/internal-rollout-runbook.md docs/pull-requests/2026-07-27-iris-proactive-feedback-loop.md docs/superpowers/plans/2026-07-27-iris-proactive-feedback-loop.md
git commit -m "docs: document proactive feedback operations"
```

- [ ] **Step 6: Push and create the pull request**

```powershell
git push -u origin codex/iris-proactive-feedback
gh pr create --repo xfbbert-dotcom/iris --base codex/iris-oauth-review-page --head codex/iris-proactive-feedback --title "feat: close proactive reminder feedback loop" --body-file docs/pull-requests/2026-07-27-iris-proactive-feedback-loop.md
```

The PR base remains the current PR #13 branch until that dependency merges. Do not merge either PR.

- [ ] **Step 7: Verify GitHub checks**

Run:

```powershell
gh pr checks --repo xfbbert-dotcom/iris --watch
```

Expected: Core and AI Worker checks pass.
