# Iris Agent Execution Ledger Runtime Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Iris's content-free append-only execution ledger to answer, permission, approval, publication, and proactive-delivery runtime boundaries, with an internal inspection API.

**Architecture:** A single optional Core runtime owns the Postgres ledger repository and exposes a best-effort typed observer. Existing business components receive the observer through dependency injection and emit bounded lifecycle events; their current repositories and state machines remain authoritative. The observer catches storage failures so observability cannot change an answer, permission denial, approval, publication, or proactive delivery outcome.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Vitest, Node.js `crypto`

## Global Constraints

- Keep the modular-monolith architecture from `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`.
- Do not add ledger work to the Feishu callback acknowledgement path.
- Do not store prompts, answers, message text, document/wiki bodies, titles, tokens, or headers.
- Permission checks remain fail-closed.
- Existing approval, action, knowledge-publication, and proactive-signal repositories remain authoritative.
- Ledger observation failures must not alter business results.
- `IRIS_AGENT_EXECUTION_LEDGER_ENABLED` defaults to disabled.
- Internal event listing is bounded to 1-100 rows and remains bearer protected under `/internal/*`.
- Do not start Caddy, enable Iris, or change production runtime flags as part of this plan.

---

### Task 1: Make Ledger Replay Semantic

**Files:**
- Modify: `apps/core/src/agent-runtime/agent-execution-ledger-repository.ts`
- Modify: `apps/core/tests/agent-execution-ledger.test.ts`

**Interfaces:**
- Consumes: `AgentExecutionLedgerRepository.recordEvent(input)`
- Produces: exact semantic replay independent of row ID, observation timestamp, and metadata object key order

- [ ] **Step 1: Write the failing replay tests**

Add Postgres-backed tests that replay one semantic event with:

```ts
{
  ...original,
  id: "evt-retry",
  at: new Date("2026-07-27T00:01:00.000Z"),
  metadata: { attempt: 1, route: "mention" },
}
```

after the original used a different `id`, earlier `at`, and metadata keys in reverse order.
Assert `outcome === "already_applied"` and that the returned event is the original row.

Keep a separate test changing `outcome` from `"success"` to `"error"` and assert
`AgentExecutionLedgerOperationConflictError`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm --workspace apps/core test -- agent-execution-ledger.test.ts
```

Expected: the replay test fails with an operation conflict because `id`, `at`, or
metadata key order still affects the fingerprint.

- [ ] **Step 3: Implement a semantic canonical fingerprint**

Change `operationFingerprint` to omit `id` and `at`, recursively sort object keys, preserve
array order, and serialize dates as ISO strings:

```ts
function operationFingerprint(
  value: ReturnType<typeof normalizeRecordEventInput>,
): string {
  const { id: _id, at: _at, ...semantic } = value;
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeJson(semantic)))
    .digest("hex");
}
```

Reject non-JSON metadata through the existing `requireMetadata` boundary; do not expand
the stored schema.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- agent-execution-ledger.test.ts
```

Expected: all ledger contract tests pass; DB tests skip only when
`IRIS_TEST_DATABASE_URL` is absent.

- [ ] **Step 5: Commit**

```powershell
git add apps/core/src/agent-runtime/agent-execution-ledger-repository.ts apps/core/tests/agent-execution-ledger.test.ts
git commit -m "fix(core): make execution ledger replay semantic"
```

---

### Task 2: Add The Best-Effort Observer And Optional Runtime

**Files:**
- Create: `apps/core/src/agent-runtime/agent-execution-observer.ts`
- Create: `apps/core/src/runtime/agent-execution-ledger-runtime.ts`
- Create: `apps/core/tests/agent-execution-observer.test.ts`
- Create: `apps/core/tests/agent-execution-ledger-runtime.test.ts`
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/tests/env.test.ts`

**Interfaces:**
- Consumes: `AgentExecutionLedgerRepository`
- Produces:

```ts
export type AgentExecutionObservation = Omit<
  RecordAgentExecutionLedgerEventInput,
  "id" | "tenantKey" | "at"
> & {
  id?: string;
  tenantKey?: string;
  at?: Date;
};

export interface AgentExecutionObserver {
  observe(input: AgentExecutionObservation): Promise<void>;
}

export type AgentExecutionLedgerRuntime = {
  observer: AgentExecutionObserver;
  repository: AgentExecutionLedgerRepository;
  getStatus(): {
    enabled: true;
    writeFailureCount: number;
    lastWriteFailureAt?: Date;
  };
  close(): Promise<void>;
};
```

- [ ] **Step 1: Write failing observer tests**

Cover:

```ts
it("fills tenant, id, and timestamp before recording");
it("swallows repository failures and reports bounded degradation");
it("does not include content fields in its generated event");
```

Use a recording fake repository and deterministic `now`/`createId`.

- [ ] **Step 2: Run observer tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- agent-execution-observer.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the observer**

Create `createAgentExecutionObserver({ repository, tenantKey, now, createId, onWriteFailure })`.
`observe()` awaits `recordEvent`, catches all failures, increments a bounded counter, stores
only the latest failure timestamp, and invokes the optional safe callback. It never throws.

- [ ] **Step 4: Run observer tests and verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- agent-execution-observer.test.ts
```

Expected: all observer tests pass.

- [ ] **Step 5: Write failing config and runtime tests**

Assert:

```ts
expect(readAgentExecutionLedgerRuntimeConfig({})).toEqual({ enabled: false });
expect(readAgentExecutionLedgerRuntimeConfig({
  IRIS_AGENT_EXECUTION_LEDGER_ENABLED: "true",
  DATABASE_URL: "postgres://iris",
})).toEqual({ enabled: true, databaseUrl: "postgres://iris" });
```

Runtime tests must prove disabled returns `undefined`, enabled creates one pool/repository,
status reflects observer write failures, and `close()` ends the pool once.

- [ ] **Step 6: Run runtime tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- env.test.ts agent-execution-ledger-runtime.test.ts
```

Expected: missing config reader/runtime failures.

- [ ] **Step 7: Implement config and runtime**

Add:

```ts
export type AgentExecutionLedgerRuntimeConfig =
  | { enabled: false }
  | { enabled: true; databaseUrl: string };
```

and `readAgentExecutionLedgerRuntimeConfig()`. The runtime creates one Postgres pool,
repository, observer, status closure, and idempotent close function.

- [ ] **Step 8: Run task tests and verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- env.test.ts agent-execution-observer.test.ts agent-execution-ledger-runtime.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 9: Commit**

```powershell
git add apps/core/src/agent-runtime apps/core/src/runtime/agent-execution-ledger-runtime.ts apps/core/src/config/env.ts apps/core/tests/agent-execution-observer.test.ts apps/core/tests/agent-execution-ledger-runtime.test.ts apps/core/tests/env.test.ts
git commit -m "feat(core): add execution ledger observer runtime"
```

---

### Task 3: Add The Internal Inspection API And App Composition

**Files:**
- Create: `apps/core/src/agent-runtime/agent-execution-ledger-api.ts`
- Create: `apps/core/tests/agent-execution-ledger-api.test.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/server-startup.test.ts`
- Modify: `apps/core/tests/runtime-close.test.ts`
- Modify: `apps/core/tests/internal-status-snapshot.test.ts`

**Interfaces:**
- Consumes: `AgentExecutionLedgerRuntime`
- Produces: bearer-protected `GET /internal/agent-executions`

- [ ] **Step 1: Write failing API tests**

Register the API on a test Fastify app with a fake repository. Cover:

```ts
GET /internal/agent-executions?groupId=oc_pilot&limit=20
GET /internal/agent-executions?subjectType=turn&subjectId=om_123&limit=20
GET /internal/agent-executions?toolCallId=delivery-1&limit=20
```

Assert invalid subject filter pairs, blank filters, and limits outside 1-100 return `400`.
Assert the response contains ledger metadata but no prompt, answer, text, document body, or
credential fields.

- [ ] **Step 2: Run API tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- agent-execution-ledger-api.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the API**

Export:

```ts
registerAgentExecutionLedgerApi(
  app: FastifyInstance,
  runtime?: Pick<AgentExecutionLedgerRuntime, "repository">,
): void
```

Return `404` when the runtime is disabled, otherwise validate the bounded query and return:

```ts
{ events: AgentExecutionLedgerEvent[] }
```

- [ ] **Step 4: Run API tests and verify GREEN**

Run the same focused command and expect all tests to pass.

- [ ] **Step 5: Write failing app lifecycle tests**

Prove:

- the ledger runtime factory is called once;
- its observer is supplied to answer, action, and proactive runtime factories;
- the API is registered behind the existing `/internal/*` bearer hook;
- runtime status includes enabled/degraded ledger state;
- app close closes the ledger runtime once.

- [ ] **Step 6: Run app lifecycle tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- server-startup.test.ts runtime-close.test.ts internal-status-snapshot.test.ts
```

Expected: missing factory/dependency/status assertions fail.

- [ ] **Step 7: Compose the runtime in `app.ts`**

Add dependency injection for `createAgentExecutionLedgerRuntime`, create it before answer/action/
proactive runtimes, pass `observer` to those factories, register its API, include status, and close
it after consumers have stopped.

- [ ] **Step 8: Run task tests and verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- agent-execution-ledger-api.test.ts server-startup.test.ts runtime-close.test.ts internal-status-snapshot.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 9: Commit**

```powershell
git add apps/core/src/agent-runtime/agent-execution-ledger-api.ts apps/core/src/app.ts apps/core/tests/agent-execution-ledger-api.test.ts apps/core/tests/server-startup.test.ts apps/core/tests/runtime-close.test.ts apps/core/tests/internal-status-snapshot.test.ts
git commit -m "feat(core): expose execution ledger inspection"
```

---

### Task 4: Instrument Answer Turns And Permission Decisions

**Files:**
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts`
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/src/memory/document-retrieval-context.ts`
- Modify: `apps/core/src/permissions/permission-guard.ts`
- Modify: `apps/core/src/conversation/feishu-mention-answer-responder.ts`
- Modify: `apps/core/tests/answer-draft-orchestrator.test.ts`
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`
- Modify: `apps/core/tests/document-retrieval-context.test.ts`
- Modify: `apps/core/tests/permission-guard.test.ts`
- Modify: `apps/core/tests/feishu-mention-answer-responder.test.ts`

**Interfaces:**
- Consumes: `AgentExecutionObserver`
- Produces: ordered turn/provider/permission events tied to a stable `executionId`

- [ ] **Step 1: Write failing turn lifecycle tests**

Extend `AnswerDraftInput` with optional `executionId`. In tests, pass
`executionId: "om_123"` and a recording observer. Assert:

```ts
[
  "turn_started",
  "provider_request_started",
  "provider_request_completed",
  "turn_completed",
]
```

For a provider error, assert `provider_request_failed` then `turn_failed`; rethrow the original
provider error unchanged.

- [ ] **Step 2: Run answer tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-orchestrator.test.ts answer-draft-runtime.test.ts
```

Expected: observer/dependency assertions fail.

- [ ] **Step 3: Implement turn and provider observation**

The runtime derives a stable subject ID from `input.executionId` or a generated UUID, records
bounded phase events, and passes a model wrapper into the existing orchestrator. Event metadata
contains counts only:

```ts
{
  retrievedFragmentCount,
  allowedFragmentCount,
  deniedDocumentCount,
  groupMemoryCount,
  discussionThreadCount,
  actionItemCount,
}
```

Do not include `question`, `promptContext`, or `answerText`.

- [ ] **Step 4: Run answer tests and verify GREEN**

Run the same command and expect all selected tests to pass.

- [ ] **Step 5: Write failing permission-observation tests**

Add an optional callback to the permission guard:

```ts
onPermissionDecision?(decision: {
  documentId: string;
  outcome: "allowed" | "denied" | "error";
}): Promise<void>;
```

Assert one observation per unique document ID, including duplicate fragments, and prove an
observer failure does not alter the allowed/denied result.

- [ ] **Step 6: Run permission tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- permission-guard.test.ts document-retrieval-context.test.ts
```

Expected: callback assertions fail.

- [ ] **Step 7: Implement permission observation**

Invoke the callback only after the live permission result is known. Catch callback failures locally.
Thread the callback from the per-turn context builder and emit `permission_allowed`,
`permission_denied`, or `permission_error` with the turn subject ID and document source ID only.

- [ ] **Step 8: Pass the Feishu message ID as the execution ID**

Update the mention responder call:

```ts
answerDraftOrchestrator.generateDraft({
  executionId: input.messageId,
  question,
  chatId: input.chatId,
  askerId: input.senderId,
  liveChatMessages: [...],
});
```

Add a focused responder assertion.

- [ ] **Step 9: Run the complete answer slice**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-orchestrator.test.ts answer-draft-runtime.test.ts permission-guard.test.ts document-retrieval-context.test.ts feishu-mention-answer-responder.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 10: Commit**

```powershell
git add apps/core/src/agent/answer-draft-orchestrator.ts apps/core/src/runtime/answer-draft-runtime.ts apps/core/src/memory/document-retrieval-context.ts apps/core/src/permissions/permission-guard.ts apps/core/src/conversation/feishu-mention-answer-responder.ts apps/core/tests/answer-draft-orchestrator.test.ts apps/core/tests/answer-draft-runtime.test.ts apps/core/tests/document-retrieval-context.test.ts apps/core/tests/permission-guard.test.ts apps/core/tests/feishu-mention-answer-responder.test.ts
git commit -m "feat(core): trace answer and permission lifecycle"
```

---

### Task 5: Instrument Approval, Publication, And Proactive Delivery

**Files:**
- Modify: `apps/core/src/action-approvals/action-proposal-planner.ts`
- Modify: `apps/core/src/action-approvals/action-approval-worker.ts`
- Modify: `apps/core/src/action-approvals/knowledge-publication-executor.ts`
- Modify: `apps/core/src/proactive-signals/proactive-signal-dispatcher.ts`
- Modify: `apps/core/src/runtime/action-approval-runtime.ts`
- Modify: `apps/core/src/runtime/proactive-signal-delivery-runtime.ts`
- Modify: `apps/core/tests/action-proposal-planner.test.ts`
- Modify: `apps/core/tests/action-approval-worker.test.ts`
- Modify: `apps/core/tests/knowledge-publication-executor.test.ts`
- Modify: `apps/core/tests/proactive-signal-dispatcher.test.ts`
- Modify: `apps/core/tests/action-approval-runtime.test.ts`
- Modify: `apps/core/tests/proactive-signal-runtime.test.ts`

**Interfaces:**
- Consumes: `AgentExecutionObserver`
- Produces: proposal, approval, external execution, and proactive tool-call events

- [ ] **Step 1: Write failing proposal and approval tests**

Use recording observers to assert:

- newly created proposal emits `action_proposed`;
- applied approve emits `action_approved`;
- applied reject emits `action_rejected`;
- request-revision emits `action_rejected` with reason code `revision_requested`;
- duplicate callbacks do not create a second semantic event;
- runtime/membership/policy denials emit `permission_denied` with bounded code only.

- [ ] **Step 2: Run proposal/approval tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- action-proposal-planner.test.ts action-approval-worker.test.ts
```

Expected: missing observer assertions fail.

- [ ] **Step 3: Implement proposal and approval observation**

Use proposal ID/version, presentation ID, actor open ID, source group ID, and existing result code.
Do not store card JSON, draft content, or revision reason text.

- [ ] **Step 4: Run proposal/approval tests and verify GREEN**

Run the same focused command and expect all selected tests to pass.

- [ ] **Step 5: Write failing publication execution tests**

Assert:

- claim emits `action_execution_started`;
- successful remote publication plus fact completion emits `action_execution_completed`;
- publisher failure emits `action_execution_failed`;
- remote success followed by fact completion failure emits
  `action_execution_reconciliation_required`;
- observer failure does not alter the executor result.

- [ ] **Step 6: Run publication tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- knowledge-publication-executor.test.ts
```

Expected: lifecycle assertions fail.

- [ ] **Step 7: Implement publication observation**

Use execution ID as `subjectId` and `toolCallId`, tool name
`iris.knowledge.publishDraft`, and existing proposal/draft versions in bounded metadata.

- [ ] **Step 8: Write failing proactive delivery tests**

Assert tool-call start/completion/failure events for one delivery ID. Map retrying to
`tool_call_failed` with outcome `error`, permanent failure to `error`, outcome unknown to
`unknown`, and runtime-disabled preflight to `skipped`.

- [ ] **Step 9: Run proactive tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- proactive-signal-dispatcher.test.ts proactive-signal-runtime.test.ts
```

Expected: lifecycle assertions fail.

- [ ] **Step 10: Implement proactive delivery observation and runtime injection**

Use tool name `iris.feishu.deliverProactiveSignal`; store delivery ID, group ID, signal type,
attempt number, and bounded result code only.

- [ ] **Step 11: Run the complete action slice**

Run:

```powershell
npm --workspace apps/core test -- action-proposal-planner.test.ts action-approval-worker.test.ts knowledge-publication-executor.test.ts proactive-signal-dispatcher.test.ts action-approval-runtime.test.ts proactive-signal-runtime.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 12: Commit**

```powershell
git add apps/core/src/action-approvals apps/core/src/proactive-signals/proactive-signal-dispatcher.ts apps/core/src/runtime/action-approval-runtime.ts apps/core/src/runtime/proactive-signal-delivery-runtime.ts apps/core/tests/action-proposal-planner.test.ts apps/core/tests/action-approval-worker.test.ts apps/core/tests/knowledge-publication-executor.test.ts apps/core/tests/proactive-signal-dispatcher.test.ts apps/core/tests/action-approval-runtime.test.ts apps/core/tests/proactive-signal-runtime.test.ts
git commit -m "feat(core): trace governed action execution"
```

---

### Task 6: Verify, Document, And Publish The Slice

**Files:**
- Modify: `.env.example`
- Modify: `docs/operations/internal-rollout-runbook.md`
- Create: `docs/pull-requests/2026-07-27-iris-agent-execution-ledger-runtime-wiring.md`

**Interfaces:**
- Consumes: completed Tasks 1-5
- Produces: operator configuration and verifiable PR evidence

- [ ] **Step 1: Document the default-off feature**

Add:

```dotenv
IRIS_AGENT_EXECUTION_LEDGER_ENABLED=false
```

Document migration `0039`, internal query examples, content-free boundaries, and that production
activation is a separate fail-closed deployment step.

- [ ] **Step 2: Run focused ledger and runtime tests**

Run:

```powershell
npm --workspace apps/core test -- agent-execution-ledger.test.ts agent-execution-observer.test.ts agent-execution-ledger-runtime.test.ts agent-execution-ledger-api.test.ts answer-draft-runtime.test.ts permission-guard.test.ts action-approval-worker.test.ts knowledge-publication-executor.test.ts proactive-signal-dispatcher.test.ts
```

Expected: all selected tests pass; Postgres-only tests may skip only when the test database URL is absent.

- [ ] **Step 3: Run the full Core suite and typecheck**

Run:

```powershell
npm --workspace apps/core test
npm run typecheck
git diff --check
```

Expected: zero test failures, TypeScript exit code 0, and no diff-check output.

- [ ] **Step 4: Inspect the final diff**

Run:

```powershell
git status --short
git diff --stat
git diff -- apps/core/src/agent-runtime apps/core/src/runtime apps/core/src/agent apps/core/src/permissions apps/core/src/action-approvals apps/core/src/proactive-signals
```

Confirm only task files are staged; preserve all unrelated historical untracked files.

- [ ] **Step 5: Commit**

```powershell
git add .env.example docs/operations/internal-rollout-runbook.md docs/pull-requests/2026-07-27-iris-agent-execution-ledger-runtime-wiring.md
git commit -m "docs: document execution ledger operations"
```

- [ ] **Step 6: Push and verify PR checks**

Run:

```powershell
git push origin codex/iris-oauth-review-page
gh pr checks 13 --repo xfbbert-dotcom/iris --watch
```

Expected: Core and AI Worker checks report `pass`.

Do not merge PR #13 and do not change production runtime flags in this task.
