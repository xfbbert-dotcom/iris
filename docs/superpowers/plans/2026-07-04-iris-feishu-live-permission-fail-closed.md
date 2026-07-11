# Iris Feishu Live Permission Fail-Closed Implementation Plan

**Goal:** Fail closed for Feishu document fragments when answer-time live permission checks are
unavailable.

**Architecture:** Keep local source policy as the first gate. Add a Feishu URL-sensitive second gate
inside answer-draft runtime: docx/docs/wiki sources require the Feishu live permission checker before
fragments can enter prompt context.

**Tech Stack:** TypeScript, Vitest, existing answer-draft runtime and Feishu document URL parser.

---

### Task 1: Add Failing Runtime Test

**Files:**
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

- [x] **Step 1: Cover Feishu cached fragment without live checker**

Add a `source-policy` runtime test where a locally readable Feishu docx source is retrieved while
Feishu OpenAPI credentials are absent.

Observed: focused answer-draft runtime tests failed because cached Feishu text entered prompt
context.

### Task 2: Implement Feishu Fail-Closed Gate

**Files:**
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`

- [x] **Step 1: Detect Feishu docx/docs/wiki URLs**

Reuse the existing Feishu document URL parsers to determine whether a source requires live
permission checks.

- [x] **Step 2: Deny Feishu fragments without live checker**

After local policy allows a source, return `false` for Feishu docx/docs/wiki URLs when the live
permission checker is unavailable. Keep unsupported non-Feishu URLs on local source policy.

Observed: focused answer-draft runtime tests passed with `13` tests.

### Task 3: Update Architecture and Operations Docs

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: `docs/operations/internal-rollout-runbook.md`
- Create: `docs/superpowers/specs/2026-07-04-iris-feishu-live-permission-fail-closed-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-feishu-live-permission-fail-closed.md`

- [x] **Step 1: Align docs with fail-closed behavior**

Document that `source-policy` requires Feishu OpenAPI live permission checks before Feishu document
content enters model context.
