# Iris Feishu Link Query and Fragment Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent copied Feishu document link query strings and fragments from creating duplicate Iris document sources.

**Architecture:** Strip `URL.search` and `URL.hash` inside `createFeishuDocumentLinkExtractor` after supported-host validation.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Link Canonicalization

**Files:**
- Modify: `apps/core/tests/feishu-document-link-extractor.test.ts`
- Modify: `apps/core/src/documents/feishu-document-link-extractor.ts`

- [x] **Step 1: Write failing extractor test**

Assert copied Feishu links with query strings and fragments normalize to one clean source URI.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/feishu-document-link-extractor.test.ts --reporter=dot`

Expected: FAIL because current extractor preserves query strings and fragments.

- [x] **Step 3: Implement normalization**

Set `url.search = ""` and `url.hash = ""` before returning `url.href`.

- [x] **Step 4: Run focused test to verify it passes**

Run: `npm --workspace apps/core test -- tests/feishu-document-link-extractor.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-feishu-link-query-fragment-normalization.md`

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
git add apps/core/src/documents/feishu-document-link-extractor.ts apps/core/tests/feishu-document-link-extractor.test.ts docs/superpowers/specs/2026-07-03-iris-feishu-link-query-fragment-normalization-design.md docs/superpowers/plans/2026-07-03-iris-feishu-link-query-fragment-normalization.md
git commit -m "fix: normalize copied feishu document links"
git push --force-with-lease origin codex/iris-document-source-registry
```
