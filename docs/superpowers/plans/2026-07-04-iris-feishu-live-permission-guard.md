# Iris Feishu Live Permission Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight Feishu real-time permission guard before answer-time document fragments enter Iris model context.

**Architecture:** Keep `DocumentRetrievalContextBuilder` as the single prompt gate. Extend answer runtime source-policy checks so local registry approval must also pass an optional Feishu live checker when OpenAPI credentials are configured.

**Tech Stack:** TypeScript, Vitest, Feishu OpenAPI, existing tenant access token provider.

---

### Task 1: Feishu Permission Checker

**Files:**
- Create: `apps/core/src/permissions/feishu-document-permission-checker.ts`
- Test: `apps/core/tests/feishu-document-permission-checker.test.ts`

- [x] Write failing tests for direct docx URLs, wiki URLs, denied responses, unsupported URLs, and timeout numeric safety.
- [x] Run `npm --workspace apps/core test -- feishu-document-permission-checker.test.ts` and verify the tests fail before implementation.
- [x] Implement the checker using Feishu tenant token auth, document metadata GET, and wiki node resolution.
- [x] Re-run the focused test and verify it passes.

### Task 2: Answer Runtime Wiring

**Files:**
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Test: `apps/core/tests/env.test.ts`
- Test: `apps/core/tests/answer-draft-runtime.test.ts`

- [x] Write failing runtime tests proving local source policy and Feishu live guard must both pass.
- [x] Add optional Feishu OpenAPI config reading for answer runtime.
- [x] Compose the token provider and live permission checker when credentials exist.
- [x] Re-run focused answer runtime and env tests.

### Task 3: Verification and Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: PR body

- [x] Update the whitepaper implementation status for the live guard.
- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `python -m pytest` in `workers/ai`.
- [x] Run `docker compose config`.
- [ ] Commit and push to PR #3.
