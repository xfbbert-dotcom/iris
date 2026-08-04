# Iris Agent Execution Ledger Runtime Wiring

## Scope

This slice turns the existing append-only agent execution ledger foundation into an optional,
queryable runtime capability:

- semantic idempotency rejects conflicting reuse of an operation key while allowing exact replay;
- a best-effort observer writes bounded lifecycle evidence without changing authoritative results;
- a default-off runtime composes the Postgres repository and observer;
- bearer-protected `GET /internal/agent-executions` supports group, subject, and tool-call queries;
- answer turns and provider calls emit start, completion, and failure events;
- the real-time permission guard emits one allowed, denied, or error decision per unique document;
- action proposals, approval decisions, knowledge publication, and proactive delivery emit governed
  lifecycle events;
- application status exposes whether the ledger is enabled and healthy.

## Data And Safety Boundary

- `IRIS_AGENT_EXECUTION_LEDGER_ENABLED=false` remains the repository default.
- Migration `0039_agent_execution_ledger.sql` creates the append-only event table, indexes, unique
  operation keys, semantic fingerprints, and update/delete/truncate guards.
- Observer writes are best effort. Ledger write failure is observable but cannot change an answer,
  permission decision, approval outcome, publication result, or proactive delivery result.
- Exact retries are idempotent. Reusing an operation key for different semantic content fails
  closed with an operation conflict.
- The internal query route remains behind the existing bearer guard and is not exposed by Caddy.
- Production activation is explicitly outside this code slice and requires a separate fail-closed
  deployment with Caddy stopped and Iris globally disabled.

The ledger stores lifecycle metadata and fingerprints only. It does not store chat text, prompts,
model responses, document or memory bodies, approval/revision comments, Feishu card JSON,
credentials, access tokens, or raw provider error bodies.

## Covered Lifecycles

- Answer: turn start/completion/failure and provider request start/completion/failure.
- Permission: live per-document allow, deny, and provider/error decisions.
- Approval: proposal creation and applied approve/revision/reject outcomes without comment text.
- Publication: execution start, completion, failure, and reconciliation-required unknown outcome.
- Proactive delivery: tool-call start, completion, failure, cancellation, and runtime/staleness skip.

## Operator Interface

```text
GET /internal/agent-executions?groupId=oc_group_id&limit=20
GET /internal/agent-executions?subjectType=turn&subjectId=om_message_id&limit=20
GET /internal/agent-executions?toolCallId=delivery_id&limit=20
```

`subjectType` and `subjectId` are paired filters. `limit` is bounded to `1..100`. A disabled ledger
returns `404 agent_execution_ledger_unavailable`; malformed filters return `400 invalid_request`.

## Verification

- Focused ledger/runtime slice:
  `npm --workspace apps/core test -- agent-execution-ledger.test.ts agent-execution-observer.test.ts agent-execution-ledger-runtime.test.ts agent-execution-ledger-api.test.ts answer-draft-runtime.test.ts permission-guard.test.ts action-approval-worker.test.ts knowledge-publication-executor.test.ts proactive-signal-dispatcher.test.ts`
  passed with 9 files, 89 tests passed, and 2 Postgres-conditional tests skipped.
- Consolidated-status contract correction:
  `npm --workspace apps/core test -- answer-draft-api.test.ts internal-readiness-api.test.ts`
  passed with 2 files and 178 tests.
- Full Core suite: 145 files passed, 2 Postgres-conditional files skipped; 2,357 tests passed,
  167 conditional tests skipped, and 0 failed.
- `npm run typecheck`: passed.
- `git diff --check`: recorded after the final documentation update.

## Release State

- Branch: `codex/iris-oauth-review-page`
- PR: `#13`
- Deployment: not performed by this slice
- Merge: not performed
- Runtime flag: remains default-off
