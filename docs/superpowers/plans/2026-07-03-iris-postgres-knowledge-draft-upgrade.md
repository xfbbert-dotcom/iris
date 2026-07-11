# Iris Postgres Knowledge Draft Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align Postgres document source registration merge behavior with the in-memory registry for knowledge draft capability upgrades.

**Architecture:** During Postgres registration merges, OR existing `can_use_for_knowledge_drafts` with the incoming source type capability.

**Tech Stack:** TypeScript, Vitest, PostgreSQL SQL generation, existing Iris core app.

---

### Task 1: Postgres Registration Merge

**Files:**
- Modify: `apps/core/tests/postgres-document-source-registry.test.ts`
- Modify: `apps/core/src/documents/postgres-document-source-registry.ts`

- [x] **Step 1: Write failing SQL behavior test**

Assert registration update SQL merges `can_use_for_knowledge_drafts` with the incoming capability and passes the expected parameter order.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/postgres-document-source-registry.test.ts --reporter=dot`

Expected: FAIL because registration merge SQL does not update `can_use_for_knowledge_drafts`.

- [x] **Step 3: Implement SQL merge**

Add `can_use_for_knowledge_drafts = can_use_for_knowledge_drafts or $7` to the registration update SQL and shift later placeholders.

- [x] **Step 4: Run focused test to verify it passes**

Run: `npm --workspace apps/core test -- tests/postgres-document-source-registry.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-postgres-knowledge-draft-upgrade.md`

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
git add apps/core/src/documents/postgres-document-source-registry.ts apps/core/tests/postgres-document-source-registry.test.ts docs/superpowers/specs/2026-07-03-iris-postgres-knowledge-draft-upgrade-design.md docs/superpowers/plans/2026-07-03-iris-postgres-knowledge-draft-upgrade.md
git commit -m "fix: merge postgres knowledge draft capability"
git push --force-with-lease origin codex/iris-document-source-registry
```
