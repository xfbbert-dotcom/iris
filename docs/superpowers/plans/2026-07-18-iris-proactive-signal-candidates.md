# Iris Proactive Signal Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for each task and `superpowers:verification-before-completion` before publishing.

**Goal:** Implement the candidate-only Phase 4A proactive loop over authoritative semantic thread/action state without model calls or Feishu sends.

**Architecture:** A deterministic evaluator scores bounded thread/action snapshots. A Postgres repository owns candidate lifecycle and scan runs. A gated polling runtime scans only explicit pilot groups when global, group, and `proactiveSpeech` policy all allow it. Authenticated internal APIs provide inspection, manual scan, and dismissal. Phase 4B delivery is intentionally absent.

**Tech Stack:** TypeScript 5, Node.js, Fastify 5, Vitest, PostgreSQL 16.

## Global Constraints

- Base all work on candidate `32ef08934d50d797c3eaaacf66fd2d2fa40ff6ab`; do not modify PR #8.
- Red-green-refactor for each task.
- Default disabled and empty allowlist.
- No Gemini, AI Worker, Redis queue, Feishu send, external action, or knowledge-base write.
- All APIs remain under `/internal/*` and existing bearer-token protection.
- Every list and mutation is exact-group scoped and bounded.
- Update the requirement baseline honestly: 4A implemented in code does not mean 4B or real proactive speech is complete.

## Task 1: Domain Evaluator And Candidate Lifecycle

**Create:**

- `apps/core/src/proactive/proactive-signal-candidate.ts`
- `apps/core/src/proactive/proactive-signal-evaluator.ts`
- `apps/core/src/proactive/proactive-signal-state-machine.ts`
- `apps/core/tests/proactive-signal-evaluator.test.ts`
- `apps/core/tests/proactive-signal-state-machine.test.ts`

Steps:

1. Write failing tests for eligibility, action-over-thread precedence inputs, reason precedence, exact thresholds, deterministic factors, explanation bounds, score clamp, and invalid lifecycle transitions.
2. Run focused tests and confirm red.
3. Implement bounded types, pure evaluator, and `pending -> dismissed|expired` state machine.
4. Run focused tests and confirm green.

## Task 2: Postgres Fact Layer

**Create:**

- `apps/core/migrations/0029_proactive_signal_candidates.sql`
- `apps/core/src/proactive/proactive-signal-repository.ts`
- `apps/core/src/proactive/postgres-proactive-signal-repository.ts`
- `apps/core/tests/postgres-proactive-signal-repository.test.ts`

**Modify:** `apps/core/tests/migration-runner.test.ts`

Steps:

1. Write failing migration and repository tests for constraints, indexes, group isolation, eligible-source query, action precedence, idempotent insertion, version supersession, dismissal, scan-run persistence, and concurrent duplicate suppression.
2. Run focused tests and confirm red.
3. Add migration and transactional repository implementation.
4. Run focused and real-Postgres tests and confirm green.

## Task 3: Scanner Service And Runtime Gates

**Create:**

- `apps/core/src/proactive/proactive-signal-scanner.ts`
- `apps/core/src/proactive/proactive-signal-runtime-config.ts`
- `apps/core/src/proactive/proactive-signal-worker-loop.ts`
- `apps/core/src/runtime/proactive-signal-runtime.ts`
- focused tests for each module.

Steps:

1. Write failing tests for bounded ranking, per-candidate gate recheck, global/group/capability/allowlist pauses, default-off configuration, timer isolation, idempotent starts, clean close, and status snapshots.
2. Run focused tests and confirm red.
3. Implement scanner, config, loop, and lazy Postgres runtime.
4. Run focused tests and confirm green.

## Task 4: Authenticated Internal API And Aggregate Status

**Create:**

- `apps/core/src/proactive/proactive-signal-api.ts`
- `apps/core/tests/proactive-signal-api.test.ts`

**Modify:**

- `apps/core/src/app.ts`
- `apps/core/tests/app.test.ts`
- internal status tests as appropriate.

Steps:

1. Write failing tests for candidate list/detail, versioned dismissal, bounded manual scan, unavailable runtime behavior, bearer authentication, aggregate status, and no send/approval endpoint.
2. Run focused tests and confirm red.
3. Wire runtime ownership, API registration, status, and shutdown.
4. Run focused tests and confirm green.

## Task 5: Deployment Contract And Acceptance Documentation

**Modify:**

- `deploy/pilot/.env.example`
- `deploy/pilot/docker-compose.yml`
- deployment contract tests
- `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`

**Create:** `docs/runbooks/iris-proactive-signal-candidates-acceptance.md`

Steps:

1. Add failing contract tests for default-off and empty allowlist behavior.
2. Add environment wiring and status/runbook commands.
3. Mark IRIS-CORE-005/006 as Phase 4A code only; keep proactive delivery/follow-up incomplete until 4B and real Feishu acceptance.
4. Run contract and documentation checks.

## Task 6: Verification And Publication

1. Run focused proactive tests.
2. Run Core typecheck and full Core tests.
3. Run real Postgres migration/repository acceptance when local Docker/WSL is available; otherwise use the approved VPS test database without changing production state.
4. Run root verification.
5. Review diff for scope, external side effects, secret leakage, and honest requirement status.
6. Commit intentionally, push `codex/iris-proactive-signal-candidates`, and open a draft PR based on PR #8's branch, not `master`.
