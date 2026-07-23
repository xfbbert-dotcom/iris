# Iris Phase 5B-3 Publication Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the minimal approved-action executor that publishes an approved knowledge draft revision to Feishu Wiki and records local publication facts.

**Architecture:** Keep the existing Phase 5B layering: Feishu cards create human approval facts, the executor consumes only `approved` `publish_knowledge_draft` proposals, and Postgres remains the source of truth. External Wiki writes are behind `globalEnabled`, source group, `writeKnowledgeBase`, policy, evidence, and duplicate-publication gates.

**Tech Stack:** TypeScript Core, Fastify internal APIs, Postgres migrations/repositories, Feishu OpenAPI, Vitest, Docker pilot deployment.

## Global Constraints

- Do not redesign Iris architecture; implement Phase 5B-3 from `docs/superpowers/specs/2026-07-19-iris-knowledge-approval-publication-design.md`.
- `writeKnowledgeBase` remains default `false`; production rollout stays fail-closed until real pilot acceptance passes.
- No external Wiki write before a proposal is approved and all runtime/policy/evidence gates pass.
- Outcome-unknown writes must not be blindly retried.
- Public Caddy must expose only `/health`, Feishu callbacks, and explicit review routes; `/internal/*` remains 404.

---

## File Structure

- Modify `apps/core/migrations/0035_knowledge_publications.sql`: add publication facts and any execution indexes/constraints not already present in `0032`.
- Modify `apps/core/src/action-approvals/action-proposal-repository.ts`: add execution claim, success, failure, and status interfaces.
- Modify `apps/core/src/action-approvals/postgres-action-proposal-repository.ts`: implement transactional claim and completion logic.
- Create `apps/core/src/action-approvals/feishu-knowledge-publisher.ts`: bounded Feishu Wiki/document writer interface and implementation.
- Create `apps/core/src/action-approvals/action-execution-worker.ts`: polls approved proposals, checks runtime gates, calls publisher, records result.
- Modify `apps/core/src/runtime/action-approval-runtime.ts` and `apps/core/src/app.ts`: wire worker and internal endpoints.
- Add tests in `apps/core/tests/postgres-action-execution-repository.test.ts`, `apps/core/tests/action-execution-worker.test.ts`, and `apps/core/tests/feishu-knowledge-publisher.test.ts`.

## Task 1: Publication Facts And Draft Terminal Transition

- [ ] Write failing migration/state tests proving `knowledge_publications` exists, is append-only, unique on `(draft_id, revision_number)`, and `publication_succeeded` can move `pending_review -> published`.
- [ ] Add migration `0035_knowledge_publications.sql`.
- [ ] Update draft state machine to allow only `publication_succeeded` into `published`.
- [ ] Run targeted migration/state tests and commit.

## Task 2: Repository Execution Gates

- [ ] Write failing Postgres tests for claiming an approved proposal only when all requirements are satisfied, draft/policy/evidence match, no prior publication exists, and runtime has allowed execution.
- [ ] Implement `claimApprovedPublicationAction`.
- [ ] Write failing tests for `completePublicationExecution`, `failPublicationExecution`, and `markPublicationOutcomeUnknown`.
- [ ] Implement atomic updates for `action_executions`, `action_events`, `knowledge_publications`, and `knowledge_drafts`.
- [ ] Run targeted repository tests and commit.

## Task 3: Feishu Publisher Adapter

- [ ] Write failing tests for deterministic bounded request bodies, success parsing, non-retryable failure classification, timeout, and outcome-unknown classification.
- [ ] Implement `FeishuKnowledgePublisher` with no secret/body leakage in errors.
- [ ] Run publisher tests and commit.

## Task 4: Execution Worker And Internal API

- [ ] Write failing worker tests for disabled global/group/writeKnowledgeBase no-op, successful publish, failure, outcome-unknown, and no duplicate publish.
- [ ] Implement worker loop and `/internal/action-executions/status`.
- [ ] Add `/internal/action-proposals/:id/execute` to enqueue/trigger approved proposals without synchronous external writes.
- [ ] Wire readiness/status to expose bounded execution counts.
- [ ] Run worker/API/readiness tests and commit.

## Task 5: Pilot Runbook And Deployment Gate

- [ ] Add `docs/runbooks/iris-publication-executor-acceptance.md`.
- [ ] Add default-off env/readiness checks for Phase 5B-3.
- [ ] Run full targeted Core checks and pilot config checks.
- [ ] Deploy fail-closed, run real Feishu pilot only after internal gates pass, then restore disabled state and update PR notes.

## Self-Review

- The plan implements only Phase 5B-3 and does not reopen 5B-1/5B-2 design.
- The first production behavior change is guarded by failing tests.
- External writes are not introduced until repository gates and publisher classification exist.
- No task asks for unrelated UI polish or broad hardening.
