# Iris Knowledge Draft Facts Implementation Plan

> **Execution rule:** Follow TDD for every behavior change. Keep Phase 5A free of model calls, Feishu sends, approval, and publication operations.

**Goal:** Implement a durable, evidence-first knowledge draft aggregate with immutable revisions, current-evidence redaction, lifecycle governance, and authenticated internal APIs.

**Architecture:** TypeScript owns validation and lifecycle. Postgres owns atomic persistence, idempotency, immutable revisions/evidence/events, and transactional current-source checks. The API exposes governance only; Phase 5B external actions remain absent.

**Base:** `32ef08934d50d797c3eaaacf66fd2d2fa40ff6ab` (PR #8 frozen candidate). Migration `0029` is reserved by the parallel Phase 4A PR #9, so this branch intentionally uses `0030` even though it can run independently after `0028`.

## Task 1: Domain Types And Lifecycle

**Create:**

- `apps/core/src/knowledge-governance/knowledge-draft.ts`
- `apps/core/src/knowledge-governance/knowledge-draft-state-machine.ts`
- `apps/core/tests/knowledge-draft-state-machine.test.ts`

**Steps:**

1. Write failing tests for initial status selection, revision transitions, request-revision, rejection, terminal states, CAS conflicts, operation-key replay semantics, bounded strings, risk levels, reviewer fields, and evidence deduplication.
2. Run `npm test -- --run tests/knowledge-draft-state-machine.test.ts` and confirm RED.
3. Implement focused domain types, validation helpers, and a pure state machine.
4. Re-run the focused test and typecheck until GREEN.
5. Commit: `feat(core): model governed knowledge drafts`.

## Task 2: Postgres Schema And Repository Contract

**Create:**

- `apps/core/migrations/0030_knowledge_draft_facts.sql`
- `apps/core/src/knowledge-governance/knowledge-draft-repository.ts`
- `apps/core/src/knowledge-governance/postgres-knowledge-draft-repository.ts`
- `apps/core/src/knowledge-governance/postgres-knowledge-draft-evidence.ts`
- `apps/core/tests/postgres-knowledge-draft-repository.test.ts`

**Modify:**

- `apps/core/tests/migration-runner.test.ts`

**Steps:**

1. Add failing static and real-Postgres tests for the four tables, constraints, immutable triggers, operation-key uniqueness, and application-role grants.
2. Add failing repository tests for create, exact revision snapshots, evidence rows, events, list/get, lifecycle mutations, expected-version conflicts, idempotent retry, and transaction rollback.
3. Add failing evidence tests for exact group messages, deleted messages, current/stale thread and action versions, readable/synced/capability-enabled document sources, group-document scope, company-authorized sources, mixed scope, and stale read redaction.
4. Implement migration `0030` and repository interfaces.
5. Implement evidence validation as bounded SQL helpers used inside write transactions and read-time disclosure guards.
6. Run migration and repository suites serially against a dedicated `pgvector/pgvector:pg16` container; never run separate migration suites concurrently.
7. Run focused unit tests and typecheck.
8. Commit: `feat(core): persist governed knowledge drafts`.

## Task 3: Authenticated Governance Runtime And API

**Create:**

- `apps/core/src/knowledge-governance/knowledge-draft-api.ts`
- `apps/core/src/runtime/knowledge-draft-runtime.ts`
- `apps/core/tests/knowledge-draft-api.test.ts`
- `apps/core/tests/knowledge-draft-runtime.test.ts`

**Modify:**

- `apps/core/src/admin/runtime-controller.ts`
- `apps/core/src/app.ts`
- exact app/status tests affected by the optional runtime

**Steps:**

1. Write failing runtime-controller tests proving create requires global enablement, `generateKnowledgeDrafts=true`, and an enabled source group when supplied.
2. Write failing API tests for bearer authentication on every route, unavailable-runtime fail-closed behavior, body/query limits, current-evidence redaction, status counts, CAS conflict, idempotency, and generic database errors.
3. Add explicit route-absence tests for `confirm`, `approve`, `publish`, `send`, and `write` operations.
4. Implement the runtime with a dedicated Postgres pool and idempotent close.
5. Implement API parsing/mapping in the feature module; keep `app.ts` limited to dependency wiring and registration.
6. Register runtime startup/close ownership without making ordinary Feishu callback startup depend on knowledge-draft generation.
7. Run focused API/runtime tests, full app tests, and typecheck.
8. Commit: `feat(core): expose knowledge draft governance`.

## Task 4: Operations Contract And Requirement Baseline

**Create:**

- `docs/runbooks/iris-knowledge-draft-facts-acceptance.md`

**Modify:**

- `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- `scripts/pilot-compose.test.mjs`

**Steps:**

1. Add a failing operations-contract test that requires the runbook to state no model call, no retrieval use, no Feishu send, no confirm/approve/publish route, evidence invalidation redaction, and fail-closed rollback.
2. Write the acceptance runbook for disabled-state deployment, internal create/read/revise/reject checks, evidence revocation, retrieval exclusion, and cleanup.
3. Update IRIS-CORE-007 honestly to “5A code complete, real governance acceptance and 5B missing”. Keep IRIS-CORE-008 and IRIS-CORE-013 incomplete.
4. Run Pilot contract tests and `git diff --check`.
5. Commit: `docs: add knowledge draft rollout contract`.

## Task 5: Full Verification And Publication

**Steps:**

1. Run `npm run verify`.
2. Run real Postgres migration and knowledge-draft repository tests serially one final time.
3. Review `git diff <base>..HEAD` for scope, secrets, model/Feishu send dependencies, and accidental draft retrieval.
4. Remove the dedicated test container and confirm a clean worktree.
5. Push `codex/iris-knowledge-draft-facts`.
6. Open a Draft PR based on `codex/iris-semantic-thread-action-memory`, state the PR #8 dependency, explain migration numbering, and list Phase 5B exclusions.
7. Wait for Core and AI Worker GitHub checks to reach success. Do not merge or deploy.
