# Iris Governed Feishu Task Action Implementation Plan

> **Execution rule:** implement each task test-first, keep every new external effect default-off,
> and commit at the end of each green task.

**Goal:** Deliver one complete governed path from an explicit Feishu task-draft request through real
group confirmation and exact-assignee approval to one idempotent Feishu Task v2 creation and a
durable result report.

**Architecture:** Add versioned formal-task draft facts beside knowledge drafts, extend the shared
action-proposal contract with typed task policy bindings, and add a focused Task v2 executor with
deterministic idempotency and reconciliation. Reuse the existing interaction, OAuth review,
approval, runtime-control, token, status, and Admin Console boundaries instead of creating a bypass.

**Spec:** `docs/superpowers/specs/2026-08-22-iris-governed-feishu-task-action-design.md`

## Global constraints

- Baseline is `origin/master@64468be7238276c0c93a68c702df343783bb527f`.
- No model output, internal API, or extracted action item may directly call Feishu Task v2.
- The first release supports one task, one exact assignee, optional due time, and at most one
  bounded reminder.
- Group confirmation, OAuth review, approval, and execution bind the same canonical task-spec hash.
- The assignee must approve their own assignment; no administrator fallback may assign another
  person in the first release.
- A deterministic Feishu `client_token` and exact payload are reused for every retry/reconciliation.
- No network request runs inside a PostgreSQL transaction.
- All flags and capabilities default off; one-group pilot allowlisting is mandatory.
- Logs and aggregate APIs remain content-free.
- Every task below starts red, ends green, and has a focused commit.

## Task 1: formal-task domain and append-only schema

Create:

- `apps/core/migrations/0057_governed_feishu_task_actions.sql`
- `apps/core/src/formal-tasks/formal-task-draft.ts`
- `apps/core/src/formal-tasks/formal-task-repository.ts`
- `apps/core/src/formal-tasks/postgres-formal-task-repository.ts`
- domain and PostgreSQL repository tests

Implement canonical task-spec normalization/hash, draft/revision/evidence/event tables, task target
policies, presentation/outbox facts, task execution/success/event tables, and append-only guards.
Extend migration-runner tests for fresh install, upgrade, constraints, idempotent operation keys, and
one-live-proposal/one-success invariants.

Verification:

```powershell
npm exec --workspace apps/core -- vitest run tests/formal-task-draft.test.ts tests/postgres-formal-task-repository.test.ts tests/migration-runner.test.ts
```

## Task 2: explicit chat task-draft command

Create a strict model adapter and command service modeled on the existing chat knowledge-draft
path. Recognize only explicit task-draft/create-task intent, preserve ordinary questions on the
answer path, use same-group context only, and persist the triggering message as evidence. Require an
exact `feishu_user` assignee; ambiguous/text-label owners produce a clarification response and no
draft.

Wire `generateTaskDrafts` through durable runtime control, event-worker runtime, readiness, default
configuration, and status. Add unit/integration tests for disabled global/group/capability state,
replay, model unavailability, malformed output, message budget, and control-group isolation.

## Task 3: real group confirmation card

Add task draft presentation/render/outbox support to the existing approval-interaction worker. The
card shows the bounded title, description, assignee display reference, due time, reminder, evidence
count, risk, revision, and content hash fingerprint. Support confirm, request revision, and reject.

Confirmation must recheck current group membership and exact draft/policy versions immediately
before the PostgreSQL mutation. Bot actors, nonmembers, stale cards, duplicates, disabled runtime,
and failed membership checks fail closed.

## Task 4: typed shared action-proposal extension

Extend `ActionProposalActionType` with `create_feishu_task` and `subjectType` with
`formal_task_draft`. Add typed task-policy columns/foreign keys and action-specific constraints; do
not weaken publication-policy integrity. Generalize proposal context without making knowledge
fields optional bags.

The proposal planner selects only group-confirmed current task drafts with current evidence and an
enabled matching policy. It creates exactly one designated-owner requirement for the exact
assignee. Existing publication and managed-update tests must remain unchanged and green.

## Task 5: exact-assignee OAuth review and approval

Extend the review repository/API/renderer for task title, description, assignee, due, reminder,
policy, and canonical task-spec hash. Bind the attestation to the task target fingerprint.

Extend approval cards and callback validation for `create_feishu_task`. Approval requires the exact
assignee, current membership, current task policy, current review attestation, current draft, and
all runtime gates. Request-revision and reject remain available without creating approval facts.

## Task 6: Feishu Task v2 adapter

Create `feishu-task-creator.ts` with strict request and response validation for:

```text
POST /open-apis/task/v2/tasks?user_id_type=open_id
GET  /open-apis/task/v2/tasks/:task_guid?user_id_type=open_id
```

Use the existing tenant-token provider, fixed official origin/path validation, bounded response
reads, timeout classification, deterministic `client_token`, and no sensitive logging. Unit tests
cover exact JSON, millisecond due time, member shape, omitted optionals, malformed success,
credential/redirect/host guards, rate limits, permanent errors, timeouts, and aborts.

## Task 7: executor, reconciliation, and result card

Implement a bounded executor loop that claims approved task proposals, performs a final gate and
membership check, commits, dispatches once, and persists success/failure/unknown results. Use the
same client token and payload for bounded retry and reconciliation. Stop at
`reconciliation_required` on any identity/spec mismatch.

Add a source-group result outbox and bounded card. Exactly one success fact and one result
presentation may exist per proposal. Disabled state prevents new claims and sends but preserves
facts.

## Task 8: composition, Admin Console, and readiness

Wire the draft, card, planner, executor, reconciliation, and result loops into app lifecycle with
reverse-order close isolation. Add:

- `createFeishuTasks` durable capability;
- default-off `IRIS_FEISHU_TASK_CREATION_ENABLED` and one-group allowlist;
- worker/readiness/status counts and degradation precedence;
- metadata-only draft/proposal/execution Admin Console views;
- safe request-revision/reject/reconcile operator controls.

Update `.env.example`, pilot Compose config, README, coverage baseline, and operational runbook.

## Task 9: verification and controlled pilot runbook

Run focused suites after each task, then:

```powershell
npm run verify
npm run pilot:config
npm run typecheck --workspaces --if-present
npm run build --workspaces --if-present
npm test --workspaces --if-present -- --reporter=dot
git diff --check
```

Create a production-safe acceptance runbook that starts and ends with global/group/capability/env
disabled, requires a real requester, real group confirmation, real assignee OAuth review/approval,
an immutable image/SHA, one fresh task, exact readback, one result card, and zero queue/DLQ/unknown
counts. Never use an internal endpoint to forge a human gate.
