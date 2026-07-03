# Iris Zero Fragment Limit Short-Circuit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid embedding, vector search, and permission checks when callers explicitly request zero document fragments.

**Architecture:** Sanitize `fragmentLimit` before query embedding and return a live-chat-only prompt context when it is zero.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Zero Fragment Limit Fast Path

**Files:**
- Modify: `apps/core/tests/document-retrieval-context.test.ts`
- Modify: `apps/core/src/memory/document-retrieval-context.ts`

- [x] **Step 1: Write failing retrieval context test**

Assert `fragmentLimit: 0` skips embedding, vector search, and permission checks while preserving live chat context.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/document-retrieval-context.test.ts --reporter=dot`

Expected: FAIL because embedding currently runs before the zero-limit check.

- [x] **Step 3: Implement zero-limit short-circuit**

Sanitize `fragmentLimit` before embedding and return an empty-document context when the limit is zero.

- [x] **Step 4: Run focused test to verify it passes**

Run: `npm --workspace apps/core test -- tests/document-retrieval-context.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-zero-fragment-limit-short-circuit.md`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Commit and push**

Run:

```bash
git add apps/core/src/memory/document-retrieval-context.ts apps/core/tests/document-retrieval-context.test.ts docs/superpowers/specs/2026-07-03-iris-zero-fragment-limit-short-circuit-design.md docs/superpowers/plans/2026-07-03-iris-zero-fragment-limit-short-circuit.md
git commit -m "fix: short-circuit zero fragment retrieval"
git push --force-with-lease origin codex/iris-document-source-registry
```
