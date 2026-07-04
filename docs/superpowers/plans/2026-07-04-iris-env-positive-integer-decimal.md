# Iris Environment Positive Integer Decimal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject non-decimal string forms for positive integer environment settings.

**Architecture:** Tighten the shared `readPositiveIntegerEnv()` and
`readOptionalPositiveIntegerEnv()` helpers in `apps/core/src/config/env.ts` so all env-driven
positive integers use the same decimal-only rule.

**Tech Stack:** TypeScript, Vitest, Markdown.

---

### Task 1: Failing Env Parsing Coverage

**Files:**
- Modify: `apps/core/tests/env.test.ts`

- [x] **Step 1: Add failing non-decimal env tests**

Add tests that reject:

- `IRIS_MODEL_TIMEOUT_MS=1e3`;
- `IRIS_EMBEDDING_DIMENSIONS=0x600`;
- `IRIS_EVENT_WORKER_BATCH_LIMIT=10.0`.

- [x] **Step 2: Run focused env tests and confirm RED**

Run:

```powershell
npm test --workspace apps/core -- env.test.ts
```

Expected: the new tests fail because `Number()` currently coerces non-decimal forms.

### Task 2: Decimal-Only Env Parser

**Files:**
- Modify: `apps/core/src/config/env.ts`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Create: `docs/superpowers/specs/2026-07-04-iris-env-positive-integer-decimal-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-env-positive-integer-decimal.md`

- [x] **Step 1: Enforce decimal digit strings**

Before numeric conversion, reject trimmed env values that do not match `^\d+$` in both positive
integer env readers.

- [x] **Step 2: Run focused env tests and confirm GREEN**

Run:

```powershell
npm test --workspace apps/core -- env.test.ts
```

Expected: env tests pass.

- [x] **Step 3: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [x] **Step 4: Commit, push, and verify PR checks**

Commit the env decimal parsing update, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions returns Core and AI Worker success.
