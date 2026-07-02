# Iris Feishu Wiki Document Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing Feishu document body fetcher read single Feishu wiki URLs that point to document objects.

**Architecture:** Extend the fetcher URL parsing with `parseFeishuWikiNodeToken()`. Direct docx/docs links keep the current path. Wiki links first call Feishu's wiki node API to resolve `obj_token`, then reuse the existing raw-content fetch path.

**Tech Stack:** TypeScript, Vitest, Fetch-compatible mocked responses, existing Feishu tenant token provider.

---

## File Structure

- `apps/core/src/documents/feishu-document-body-fetcher.ts`: add wiki token parsing, wiki node resolution, and reusable JSON/error helpers.
- `apps/core/tests/feishu-document-body-fetcher.test.ts`: add tests for wiki token parsing, wiki resolution success, unsupported wiki object types, and wiki node API failures.

## Tasks

### Task 1: Wiki URL Parsing and Resolution

- [x] **Step 1: Write failing tests**

Add tests that:

- `parseFeishuWikiNodeToken("https://acme.feishu.cn/wiki/wiki_token_1")` returns `wiki_token_1`.
- Fetching a wiki URL first calls `/open-apis/wiki/v2/spaces/get_node?token=wiki_token_1`, then calls raw content with `obj_token`.
- Unsupported wiki object types fail with `unsupported Feishu wiki object type: sheet`.
- Wiki node non-ok responses fail with `Feishu wiki node request failed with status 403: forbidden`.

- [x] **Step 2: Run focused tests and verify red**

Run:

```bash
npm --workspace apps/core test -- tests/feishu-document-body-fetcher.test.ts
```

Expected: fail because wiki URLs still return `unsupported Feishu docx URL` and `parseFeishuWikiNodeToken` does not exist.

- [x] **Step 3: Implement wiki resolution**

In `feishu-document-body-fetcher.ts`:

- Export `parseFeishuWikiNodeToken`.
- Add `resolveDocumentId()`.
- Add `fetchWikiDocumentId()`.
- Add `readWikiDocumentId()`.
- Reuse `readErrorMessage()`.
- Parameterize `readJsonResponse()` so raw-content and wiki-node invalid JSON errors are distinct.

Keep direct docx/docs behavior unchanged.

- [x] **Step 4: Run focused tests and verify green**

Run:

```bash
npm --workspace apps/core test -- tests/feishu-document-body-fetcher.test.ts
```

Expected: pass.

### Task 2: Full Verification and PR Update

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
npm test
python -m pytest
docker compose config
```

If root-level Python cannot import `iris_worker`, run `python -m pytest` from `workers/ai`.

- [x] **Step 2: Commit and push**

Run:

```bash
git add docs/superpowers/specs/2026-07-03-iris-feishu-wiki-document-resolution-design.md docs/superpowers/plans/2026-07-03-iris-feishu-wiki-document-resolution.md apps/core/src/documents/feishu-document-body-fetcher.ts apps/core/tests/feishu-document-body-fetcher.test.ts
git commit -m "feat: resolve Feishu wiki document bodies"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3M to PR #3:

```markdown
- Add Phase 3M Feishu wiki document resolution: wiki URLs that point to doc/docx objects now resolve to raw-content document tokens before sync.
```

## Self-Review

- Spec coverage: direct URLs, wiki URLs, supported object types, error handling, tests, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: focused on single wiki node resolution, not wiki traversal.
