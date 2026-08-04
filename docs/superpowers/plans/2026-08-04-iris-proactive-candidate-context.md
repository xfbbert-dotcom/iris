# Iris Proactive Candidate Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show human-readable proactive candidate subjects in the Admin Console and atomically reject approval when the exact target is stale.

**Architecture:** The Postgres repository remains the authority. It projects an exact-version subject/readiness state for list responses and repeats the same target predicates in the delivery approval `INSERT ... SELECT`; the API exposes the typed result and the Admin Console renders it without internal identifiers. Existing dispatcher and final-send authorization remain unchanged as defense in depth.

**Tech Stack:** TypeScript, Fastify, PostgreSQL SQL, Vitest, the existing embedded Admin Console DOM harness.

## Global Constraints

- Do not change cross-group retrieval, permission boundaries, proactive rollout flags, or automatic-delivery behavior.
- Do not expose evidence text, message bodies, actor identities, entity IDs, or candidate idempotency keys in the Admin Console.
- A stale candidate stays visible and dismissible, but cannot be approved through either the UI or direct API.
- All manual approval, runtime, suppression, dispatcher, and final-send gates remain in force.
- No database migration or new dependency is allowed.
- Production rollout remains exact-SHA, bounded to the existing pilot, and must not merge the draft pull request.

---

### Task 1: Repository candidate context projection

**Files:**
- Modify: `apps/core/src/proactive-signals/proactive-signal-repository.ts`
- Test: `apps/core/tests/proactive-signal-repository.test.ts`

**Interfaces:**
- Produces: `PendingProactiveSignalCandidate` with `approvalState: "ready" | "stale"` and optional `subjectLabel`.
- Produces: shared constant SQL fragments for exact thread/action target joins, subject selection, and readiness predicates.
- Preserves: `PersistedProactiveSignalCandidate` and `ProactiveSignalDeliveryContext` contracts used by the dispatcher.

- [ ] **Step 1: Write failing repository projection tests**

Add rows and assertions for a ready thread, a ready action, and a stale target:

```ts
expect(await repository.listPendingCandidates({ groupId: "group-a", limit: 10 })).toEqual([
  expect.objectContaining({
    entityType: "thread",
    approvalState: "ready",
    subjectLabel: "Launch feedback dashboard",
  }),
]);
```

Assert the generated query contains exact group/version/visibility/status checks and the action parent dependency, while continuing to exclude raw conversation text.

- [ ] **Step 2: Run the projection tests and observe the intended failure**

Run:

```powershell
pnpm --filter @iris/core test -- proactive-signal-repository.test.ts
```

Expected: FAIL because pending candidates do not yet expose `approvalState` or `subjectLabel`.

- [ ] **Step 3: Implement the minimal typed projection**

Add the focused response type:

```ts
export type PendingProactiveSignalCandidate = PersistedProactiveSignalCandidate & {
  approvalState: "ready" | "stale";
  subjectLabel?: string;
};
```

Change `listPendingCandidates` to return that type. Reuse constant SQL fragments equivalent to:

```sql
LEFT JOIN discussion_threads thread_state
  ON candidate.entity_type = 'thread'
 AND thread_state.id = candidate.entity_id
 AND thread_state.group_id = candidate.group_id
 AND thread_state.version = candidate.entity_version
 AND thread_state.retrieval_state = 'visible'
 AND thread_state.status = 'open'
LEFT JOIN action_items action_state
  ON candidate.entity_type = 'action'
 AND action_state.id = candidate.entity_id
 AND action_state.group_id = candidate.group_id
 AND action_state.version = candidate.entity_version
 AND action_state.retrieval_state = 'visible'
 AND action_state.status = 'open'
 AND (
   action_state.thread_id IS NULL
   OR EXISTS (
     SELECT 1 FROM discussion_threads dependency
     WHERE dependency.id = action_state.thread_id
       AND dependency.group_id = action_state.group_id
       AND dependency.status IN ('open', 'resolved')
       AND dependency.retrieval_state = 'visible'
   )
 )
```

Select the thread title or action description as `subject_label`, classify ready only when the matching joined row exists, and map the list through a new `mapPendingCandidateRow` helper. Keep `getProactiveSignalDeliveryContext` on the same shared target fragments so its rules cannot drift.

- [ ] **Step 4: Run the projection tests**

Run:

```powershell
pnpm --filter @iris/core test -- proactive-signal-repository.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the repository projection**

```powershell
git add apps/core/src/proactive-signals/proactive-signal-repository.ts apps/core/tests/proactive-signal-repository.test.ts
git commit -m "feat: project proactive candidate subjects"
```

---

### Task 2: Atomic stale approval and API contract

**Files:**
- Modify: `apps/core/src/proactive-signals/proactive-signal-repository.ts`
- Modify: `apps/core/src/proactive-signals/proactive-signal-api.ts`
- Test: `apps/core/tests/proactive-signal-repository.test.ts`
- Test: `apps/core/tests/proactive-signal-api.test.ts`

**Interfaces:**
- Consumes: shared exact-target readiness SQL from Task 1.
- Produces: repository result `{ status: "stale" }`.
- Produces: HTTP 409 body `{ ok: false, error: "proactive_signal_candidate_stale" }`.

- [ ] **Step 1: Write failing repository stale-approval tests**

Model an approval transaction where the outbox insert returns no row, no existing delivery exists, and the candidate classification row reports `approval_ready: false`:

```ts
expect(await repository.approveCandidateForDelivery(input)).toEqual({ status: "stale" });
expect(allSql).toContain("discussion_threads");
expect(allSql).toContain("action_items");
expect(allSql).toContain("candidate.entity_version");
```

Also preserve a test proving a conflicting existing delivery returns `already_queued` idempotently.

- [ ] **Step 2: Write the failing API mapping test**

Stub the repository with `{ status: "stale" }` and assert:

```ts
expect(response.statusCode).toBe(409);
expect(response.json()).toEqual({
  ok: false,
  error: "proactive_signal_candidate_stale",
});
```

- [ ] **Step 3: Run both focused test files and observe failures**

Run:

```powershell
pnpm --filter @iris/core test -- proactive-signal-repository.test.ts proactive-signal-api.test.ts
```

Expected: FAIL because `stale` is not yet a repository or API result.

- [ ] **Step 4: Implement atomic target validation**

Add `stale` to `approveCandidateForDelivery`'s result union. Apply the Task 1 exact-target joins and readiness predicate directly to the outbox `INSERT ... SELECT`. If no row is inserted:

1. return `already_queued` when the unique delivery already exists;
2. query the still-pending, unsuppressed candidate through the same joins;
3. return `stale` when the candidate exists but the exact target is not ready;
4. otherwise retain `not_found`.

No stale path may insert a queued event or outbox row.

- [ ] **Step 5: Map stale approval in Fastify**

Immediately after the repository call:

```ts
if (result.status === "stale") {
  return reply.code(409).send({
    ok: false,
    error: "proactive_signal_candidate_stale",
  });
}
```

Keep existing 404, 503, and 500 mappings unchanged.

- [ ] **Step 6: Run both focused test files**

Run:

```powershell
pnpm --filter @iris/core test -- proactive-signal-repository.test.ts proactive-signal-api.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the atomic approval contract**

```powershell
git add apps/core/src/proactive-signals/proactive-signal-repository.ts apps/core/src/proactive-signals/proactive-signal-api.ts apps/core/tests/proactive-signal-repository.test.ts apps/core/tests/proactive-signal-api.test.ts
git commit -m "fix: reject stale proactive approvals"
```

---

### Task 3: Admin Console human subject and stale controls

**Files:**
- Modify: `apps/core/src/admin-console/admin-console-assets.ts`
- Test: `apps/core/tests/admin-console-assets.test.ts`

**Interfaces:**
- Consumes: `approvalState` and optional `subjectLabel` from the candidate API.
- Produces: a human-readable subject cell, stale explanatory text, disabled stale approval, and unchanged dismissal.

- [ ] **Step 1: Write failing DOM tests**

Update the candidate fixture to include a ready subject, and add a stale fixture. Assert:

```ts
expect(renderedText).toContain("Discussion: Launch feedback dashboard");
expect(renderedText).not.toContain("thread-a");
expect(renderedText).not.toContain("quiet_open_thread:thread-a:1");
```

For stale rows, assert the explanatory text is present, the approve button is disabled, and the dismiss button remains enabled. Trigger the ready approve path and assert event history uses the subject label instead of the idempotency key.

- [ ] **Step 2: Run the Admin Console tests and observe failure**

Run:

```powershell
pnpm --filter @iris/core test -- admin-console-assets.test.ts
```

Expected: FAIL because the table still renders raw internal identifiers and enables both actions.

- [ ] **Step 3: Implement bounded rendering behavior**

Use `textContent` only. Replace the raw key/entity text with:

```js
const ready = candidate.approvalState === "ready" && Boolean(candidate.subjectLabel);
entityCell.textContent = ready
  ? (candidate.entityType === "thread" ? "Discussion: " : "Action: ") + text(candidate.subjectLabel)
  : "Stale (the work item changed, closed, or is no longer visible)";
```

Do not append `candidate.idempotencyKey` or `candidate.entityId` to any visible row or event message. Disable only the approve action when `ready` is false, set an accessible title, and leave dismissal enabled.

- [ ] **Step 4: Run the Admin Console tests**

Run:

```powershell
pnpm --filter @iris/core test -- admin-console-assets.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the Admin Console behavior**

```powershell
git add apps/core/src/admin-console/admin-console-assets.ts apps/core/tests/admin-console-assets.test.ts
git commit -m "feat: clarify proactive approval candidates"
```

---

### Task 4: Regression gates, review, and draft delivery

**Files:**
- Append after verified rollout: `/opt/iris/deployments.log` on the production VPS

**Interfaces:**
- Consumes: all behavior from Tasks 1-3.
- Produces: reviewed exact-SHA draft PR and bounded pilot deployment evidence.

- [ ] **Step 1: Run focused regression tests together**

```powershell
pnpm --filter @iris/core test -- proactive-signal-repository.test.ts proactive-signal-api.test.ts admin-console-assets.test.ts proactive-signal-dispatcher.test.ts proactive-signal-card-renderer.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run static and full Core gates**

```powershell
pnpm --filter @iris/core typecheck
pnpm --filter @iris/core build
pnpm --filter @iris/core test
```

Expected: all commands exit 0.

- [ ] **Step 3: Inspect the final diff and request independent review**

```powershell
git diff cd0a975a548dbd7497e3be76a65418838a90c985...HEAD --check
git status --short
```

Expected: no whitespace errors and no unintended files. Review specifically for SQL target-predicate drift, stale approval races, internal-ID leakage, and disabled-button regressions. Fix only release-blocking findings and rerun the affected gates.

- [ ] **Step 4: Push and open a stacked draft pull request**

Push `codex/iris-proactive-approval-context` and open a draft PR against `codex/iris-proactive-card-context`. Do not merge it. Wait for Core and AI Worker checks to succeed on the exact head SHA.

- [ ] **Step 5: Roll out with the existing bounded runbook**

Before deployment, record the exact candidate SHA and verify current production health and pilot scope. Deploy Core and AI Worker at that SHA. Confirm:

- public `/health` is 200;
- public `/internal/status` and `/internal/readiness` are 404;
- malformed Feishu event and card callbacks are 401;
- global/pilot/proactive settings are unchanged;
- all event, document, reindex, memory, projection-repair, and knowledge-card queues/DLQs are zero;
- the Admin Console returns a human subject for ready candidates and prevents stale direct approval with HTTP 409.

If no natural pending candidate exists, validate the API/repository behavior through a production-data read-only projection or an isolated internal fixture; do not send a duplicate proactive card merely to create evidence.

- [ ] **Step 6: Record evidence without merging**

Update the deployment log and draft PR with exact SHA, CI links, gate outputs, queue state, runtime scope, and any explicitly deferred non-blocking hardening. Leave the PR draft and unmerged.
