# Iris Failed Sync Rediscovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let repeated document discovery recover sources stuck in `failed` sync state after transient fetch errors.

**Architecture:** During source registration merges, reset existing `syncState` from `failed` to `pending` in both in-memory and Postgres registries.

**Tech Stack:** TypeScript, Vitest, PostgreSQL SQL generation, existing Iris core app.

---

### Task 1: Registry Failed-State Recovery

**Files:**
- Modify: `apps/core/tests/document-source-registry.test.ts`
- Modify: `apps/core/tests/postgres-document-source-registry.test.ts`
- Modify: `apps/core/src/documents/document-source-registry.ts`
- Modify: `apps/core/src/documents/postgres-document-source-registry.ts`

- [x] **Step 1: Write failing registry tests**

Assert in-memory registration resets a failed source to pending when new evidence is registered, and Postgres merge SQL contains the same failed-to-pending rule.

- [x] **Step 2: Run focused tests to verify they fail**

Run:

```bash
npm --workspace apps/core test -- tests/document-source-registry.test.ts --reporter=dot
npm --workspace apps/core test -- tests/postgres-document-source-registry.test.ts --reporter=dot
```

Expected: FAIL because registration currently preserves `failed`.

- [x] **Step 3: Implement failed-state recovery**

Set `syncState` to `pending` only when the existing state is `failed`; preserve all other states.

- [x] **Step 4: Run focused tests to verify they pass**

Run:

```bash
npm --workspace apps/core test -- tests/document-source-registry.test.ts --reporter=dot
npm --workspace apps/core test -- tests/postgres-document-source-registry.test.ts --reporter=dot
```

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-failed-sync-rediscovery.md`

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
git add apps/core/src/documents/document-source-registry.ts apps/core/src/documents/postgres-document-source-registry.ts apps/core/tests/document-source-registry.test.ts apps/core/tests/postgres-document-source-registry.test.ts docs/superpowers/specs/2026-07-03-iris-failed-sync-rediscovery-design.md docs/superpowers/plans/2026-07-03-iris-failed-sync-rediscovery.md
git commit -m "fix: retry failed syncs on rediscovery"
git push --force-with-lease origin codex/iris-document-source-registry
```
