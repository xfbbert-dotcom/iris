# Iris Group Document Link Normalized Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deduplicate group-discovered document links using normalized URI identity.

**Architecture:** Trim `sourceUri` inside `GroupVisibleDocumentRegistrar` before deduplication and before passing the link to the registry.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Normalized Link Deduplication

**Files:**
- Modify: `apps/core/tests/group-visible-document-registrar.test.ts`
- Modify: `apps/core/src/documents/group-visible-document-registrar.ts`

- [x] **Step 1: Write failing registrar test**

Add a test with whitespace variants of the same `sourceUri`; assert registration happens once and uses the trimmed URI.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/group-visible-document-registrar.test.ts --reporter=dot`

Expected: FAIL because the registrar currently deduplicates by raw `sourceUri`.

- [x] **Step 3: Implement normalized deduplication**

Trim each `sourceUri` before dedupe and return a link object with the normalized URI.

- [x] **Step 4: Run registrar test to verify it passes**

Run: `npm --workspace apps/core test -- tests/group-visible-document-registrar.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-group-document-link-normalized-dedup.md`

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
git add apps/core/src/documents/group-visible-document-registrar.ts apps/core/tests/group-visible-document-registrar.test.ts docs/superpowers/specs/2026-07-03-iris-group-document-link-normalized-dedup-design.md docs/superpowers/plans/2026-07-03-iris-group-document-link-normalized-dedup.md
git commit -m "feat: normalize discovered group document links"
git push --force-with-lease origin codex/iris-document-source-registry
```
