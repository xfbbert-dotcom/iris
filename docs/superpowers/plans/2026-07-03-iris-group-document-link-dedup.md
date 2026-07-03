# Iris Group Document Link Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid duplicate document registration and sync planning for repeated links in the same group message.

**Architecture:** Add a small local deduplication helper in `group-visible-document-registrar.ts` and apply it before the registration loop.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Link Deduplication

**Files:**
- Modify: `apps/core/tests/group-visible-document-registrar.test.ts`
- Modify: `apps/core/src/documents/group-visible-document-registrar.ts`

- [x] **Step 1: Write failing registrar test**

Add a test with duplicate `sourceUri` values and assert registration and sync planning are called once.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/group-visible-document-registrar.test.ts --reporter=dot`

Expected: FAIL because duplicates are currently registered and planned twice.

- [x] **Step 3: Implement link deduplication**

Add a helper that filters links by first-seen `sourceUri` and iterate over that result.

- [x] **Step 4: Run registrar test to verify it passes**

Run: `npm --workspace apps/core test -- tests/group-visible-document-registrar.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-group-document-link-dedup.md`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Mark checklist complete**

Update this plan so completed steps are checked.

- [x] **Step 3: Commit and push**

Run:

```bash
git add apps/core/src/documents/group-visible-document-registrar.ts apps/core/tests/group-visible-document-registrar.test.ts docs/superpowers/specs/2026-07-03-iris-group-document-link-dedup-design.md docs/superpowers/plans/2026-07-03-iris-group-document-link-dedup.md
git commit -m "feat: dedupe discovered group document links"
git push --force-with-lease origin codex/iris-document-source-registry
```
