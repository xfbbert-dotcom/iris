# Iris Document Link Supported Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unsupported Feishu/Lark product URLs from being registered as document sources.

**Architecture:** Keep host validation in `FeishuDocumentLinkExtractor`, then add path validation that mirrors the current body fetcher support surface: direct `docx/docs` documents and `wiki` nodes. This keeps unsupported file/minutes links out before registration and sync planning.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Supported Path Filter

**Files:**
- Modify: `apps/core/tests/feishu-document-link-extractor.test.ts`
- Modify: `apps/core/src/documents/feishu-document-link-extractor.ts`
- Modify: `docs/superpowers/plans/2026-07-03-iris-document-link-supported-paths.md`

- [x] **Step 1: Write the failing extractor test**

Add a test that includes `https://foo.feishu.cn/file/file_token` and `https://foo.feishu.cn/minutes/min_token` and expects no extracted links.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/feishu-document-link-extractor.test.ts --reporter=dot`

Expected: FAIL because unsupported Feishu paths are currently accepted.

- [x] **Step 3: Write minimal implementation**

Add path-segment validation in `normalizeCandidateUrl()` so only first path segments `docx`, `docs`, and `wiki` survive.

- [x] **Step 4: Run focused verification**

Run: `npm --workspace apps/core test -- tests/feishu-document-link-extractor.test.ts --reporter=dot`

Expected: PASS.

- [x] **Step 5: Run full verification**

Run:

```powershell
npm run typecheck
Push-Location workers\ai; python -m pytest; Pop-Location
docker compose config
npm test
```

Expected: all commands PASS.

- [x] **Step 6: Commit and update PR**

Run:

```powershell
git add apps/core/src/documents/feishu-document-link-extractor.ts apps/core/tests/feishu-document-link-extractor.test.ts docs/superpowers/specs/2026-07-03-iris-document-link-supported-paths-design.md docs/superpowers/plans/2026-07-03-iris-document-link-supported-paths.md
git commit -m "fix: ignore unsupported feishu document paths"
git push --force-with-lease origin codex/iris-document-source-registry
```
