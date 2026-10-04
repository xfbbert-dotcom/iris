# Iris Source Plan PostgreSQL Acceptance Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the isolated test task, followed by independent review and verification.

**Goal:** Verify that the accepted source-plan output survives the real local PostgreSQL evaluation, prepared delivery and receipt path.

**Architecture:** Replay original, checked-in synthetic model response contents through `createPdModel` using `pdOpinionModeOptions("source-plan")`. Use the real context builder, registrar, evaluation worker, repository and delivery worker, with synthetic source reading and a fake Feishu replier.

**Tech Stack:** Existing TypeScript/Vitest and PostgreSQL/pgvector fixtures; no new dependency.

**Spec:** [Source-plan contract and accepted pair](../../development/iris-opinion-runtime-20261004.md), [whitepaper §6 and §11.2](../specs/2026-06-30-iris-architecture-whitepaper.md).

## Constraints and exit condition

- This closes one cross-module evidence gap: previous PG e2e used a handwritten PdModel; previous source-plan replay ended at the eval pair.
- Exactly two new cases: arithmetic accepted pair and hypothesis structured skip. No new prompt, sampling, provider HTTP, Feishu HTTP or production access.
- Actual PG context/catalog versions remain authoritative. Normalize only those dynamic request versions for archived request comparison; never change the database to match an old run.
- Response contents remain unchanged. Extra or mismatched model calls fail, with no network fallback.
- Exit when these two PG cases and the existing e2e cases pass with zero skips, typecheck passes, independent review is addressed, and the four documentation dispositions are recorded. A skipped DB test cannot satisfy this gate.
- Retain initial-assessment/reviewer limitations and the distinction between offline integration, synthetic semantics, real Feishu and deployment.

## Review focus

- Accepted assessment/draft, not the initial assessment, must be persisted and sent.
- Request schema, stage, source refs and business material must match the archived case; only real PG version counters may differ.
- A skip must consume only its assessment response and create no issue or prepared delivery.
- Prepared text, fake delivered text and sent receipt must agree; a second delivery run must be idle.
- Existing random schema cleanup and isolated localhost test DB must remain in place.

## Task 1: Add and run the bounded acceptance cases

**File:** `apps/core/tests/proactive-discussion-e2e.test.ts`.

- [x] Add a file-local source-plan setup using `openPdDatabase`, real source/context/evaluation/delivery components and the two original catalog cases.
- [x] Replay arithmetic's three and hypothesis's one original response content from `iris-opinion-decision-resumed-20261004.json`, strictly checking requests.
- [x] Assert the final arithmetic pair in evaluation, issue and prepared delivery, fake single delivery and sent receipt; assert hypothesis creates none.
- [x] Run `npm --workspace apps/core test -- proactive-discussion-e2e.test.ts --no-cache` with an isolated local `IRIS_TEST_DATABASE_URL`; require all cases pass, zero skipped.
- [x] Run `npm run typecheck`, review the bounded diff, and address concrete failures only.
- [x] Record evidence/limitations and four documentation dispositions, then commit locally. No push/deploy/send.

Completion: test commit `dae37c65`, 6/6 e2e with zero skips, typecheck exit0 and independent review without findings. [Acceptance record](../../development/iris-opinion-postgres-20261004.md) preserves exact scope and remaining product gates.
