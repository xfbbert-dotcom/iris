# Iris Feishu Link Fullwidth Punctuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Feishu/Lark document links cleanly when followed by CJK fullwidth punctuation.

**Architecture:** Update the existing link extractor regex constants and add focused tests.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Fullwidth Punctuation Link Extraction

**Files:**
- Modify: `apps/core/tests/feishu-document-link-extractor.test.ts`
- Modify: `apps/core/src/documents/feishu-document-link-extractor.ts`

- [x] **Step 1: Write failing extractor test**

Add a test with `https://docs.feishu.cn/docx/a，` and `https://foo.feishu.cn/docx/b。`, expecting punctuation-free URLs.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/feishu-document-link-extractor.test.ts --reporter=dot`

Expected: FAIL if punctuation is captured or not normalized as expected.

- [x] **Step 3: Implement explicit fullwidth punctuation handling**

Replace the garbled punctuation character class with explicit ASCII and CJK punctuation constants in both URL matching and trailing trimming.

- [x] **Step 4: Run extractor test to verify it passes**

Run: `npm --workspace apps/core test -- tests/feishu-document-link-extractor.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-feishu-link-fullwidth-punctuation.md`

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
git add apps/core/src/documents/feishu-document-link-extractor.ts apps/core/tests/feishu-document-link-extractor.test.ts docs/superpowers/specs/2026-07-03-iris-feishu-link-fullwidth-punctuation-design.md docs/superpowers/plans/2026-07-03-iris-feishu-link-fullwidth-punctuation.md
git commit -m "fix: trim fullwidth punctuation from feishu links"
git push --force-with-lease origin codex/iris-document-source-registry
```
