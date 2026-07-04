# Iris Document Link Fan-Out Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the number of document registrations and sync plans created from one Feishu group
message.

**Architecture:** Enforce a shared per-message budget of `20` distinct document links in both link
extraction and group-visible document registration.

**Tech Stack:** TypeScript, Vitest, existing document link extractor and registrar tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/feishu-document-link-extractor.test.ts`
- Modify: `apps/core/tests/group-visible-document-registrar.test.ts`

- [x] **Step 1: Add extractor fan-out test**

Create a message with `25` supported document links and assert only the first `20` distinct links
are returned.

- [x] **Step 2: Add registrar fan-out test**

Call `registerDiscoveredLinks` with `25` links and assert only `20` are registered and planned for
sync.

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- feishu-document-link-extractor.test.ts group-visible-document-registrar.test.ts
```

Expected: the new tests fail because both layers currently allow all `25` links.

Observed: the focused tests failed. The extractor returned `25` links and the registrar registered
`25` links.

### Task 2: Implement Fan-Out Budget

**Files:**
- Modify: `apps/core/src/documents/feishu-document-link-extractor.ts`
- Modify: `apps/core/src/documents/group-visible-document-registrar.ts`

- [x] **Step 1: Add shared budget constant**

Add `MAX_FEISHU_DOCUMENT_LINKS_PER_MESSAGE = 20`.

- [x] **Step 2: Cap extracted links**

Stop extracting after the first `20` distinct normalized supported document links.

- [x] **Step 3: Cap registered links**

Stop deduplicating and registering after the first `20` distinct non-blank document links.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- feishu-document-link-extractor.test.ts group-visible-document-registrar.test.ts
```

Expected: focused document link extractor and registrar tests pass.

Observed: focused tests passed with `17` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-document-link-fanout-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-document-link-fanout-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `808` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the document link fan-out budget patch, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions Core and AI Worker checks pass.
