# Iris Feishu Body Fetch Path Prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align Feishu body-fetch token parsing with supported first-segment document paths.

**Architecture:** Update `parseFeishuPathToken()` to require the first path segment to be one of the requested markers and return the second segment as token. This mirrors `FeishuDocumentLinkExtractor` path filtering and avoids parsing nested unsupported product URLs.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: First-Segment Path Parsing

**Files:**
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`
- Modify: `docs/superpowers/plans/2026-07-03-iris-feishu-body-fetch-path-prefix.md`

- [x] **Step 1: Write the failing parser tests**

Assert that nested unsupported paths containing `docx` or `wiki` later in the path return `undefined`.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/feishu-document-body-fetcher.test.ts --reporter=dot`

Expected: FAIL because the parser currently searches marker segments anywhere in the path.

- [x] **Step 3: Write minimal implementation**

Require `segments[0]` to be included in `markers`, then read `segments[1]` as the token.

- [x] **Step 4: Run focused verification**

Run: `npm --workspace apps/core test -- tests/feishu-document-body-fetcher.test.ts --reporter=dot`

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
git add apps/core/src/documents/feishu-document-body-fetcher.ts apps/core/tests/feishu-document-body-fetcher.test.ts docs/superpowers/specs/2026-07-03-iris-feishu-body-fetch-path-prefix-design.md docs/superpowers/plans/2026-07-03-iris-feishu-body-fetch-path-prefix.md
git commit -m "fix: require feishu document path prefixes"
git push --force-with-lease origin codex/iris-document-source-registry
```
