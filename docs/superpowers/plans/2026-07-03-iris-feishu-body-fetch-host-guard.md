# Iris Feishu Body Fetch Host Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the Feishu body fetcher only parses document tokens from trusted Feishu/Lark hosts.

**Architecture:** Add hostname validation inside the shared path-token parser used by both docx/docs and wiki parsing. This keeps direct fetch behavior and wiki resolution behavior aligned with link extraction.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Fetcher Host Guard

**Files:**
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`
- Modify: `docs/superpowers/plans/2026-07-03-iris-feishu-body-fetch-host-guard.md`

- [x] **Step 1: Write the failing parser tests**

Assert that `parseFeishuDocxDocumentId("https://evil.com/docx/doc_token")` and `parseFeishuWikiNodeToken("https://evil.com/wiki/wiki_token")` return `undefined`.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/feishu-document-body-fetcher.test.ts --reporter=dot`

Expected: FAIL because the parser currently accepts tokens from any host.

- [x] **Step 3: Write minimal implementation**

Add supported-host validation in `parseFeishuPathToken()`.

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
git add apps/core/src/documents/feishu-document-body-fetcher.ts apps/core/tests/feishu-document-body-fetcher.test.ts docs/superpowers/specs/2026-07-03-iris-feishu-body-fetch-host-guard-design.md docs/superpowers/plans/2026-07-03-iris-feishu-body-fetch-host-guard.md
git commit -m "fix: guard feishu body fetch host parsing"
git push --force-with-lease origin codex/iris-document-source-registry
```
