# Iris User Submitted Document Body Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let document sync fetch body text for user-submitted Feishu docx/docs sources.

**Architecture:** Extend the existing Feishu document body fetcher source-type allowlist. Keep URL parsing, token acquisition, raw-content request, and error handling unchanged.

**Tech Stack:** TypeScript, Vitest, existing Feishu document sync pipeline.

---

## File Structure

- `apps/core/tests/feishu-document-body-fetcher.test.ts`: add a failing test that user-submitted sources fetch raw content.
- `apps/core/src/documents/feishu-document-body-fetcher.ts`: add `user_submitted_document` to supported source types.

## Tasks

### Task 1: User Submitted Fetch Support

- [x] **Step 1: Write failing fetcher test**

Add a test that calls:

```ts
await expect(fetcher.fetch(source({
  sourceType: "user_submitted_document",
  submittedByUserId: "ou_1",
  originGroupId: undefined,
  originMessageId: undefined,
}))).resolves.toEqual({
  bodyText: "User submitted body",
  fetchedAt: new Date("2026-07-03T03:20:00.000Z"),
});
```

Expected failure: `unsupported Feishu document source type: user_submitted_document`.

- [x] **Step 2: Run the focused test**

Run:

```bash
npm --workspace apps/core test -- tests/feishu-document-body-fetcher.test.ts
```

Expected: fail for the new user-submitted source support.

- [x] **Step 3: Implement allowlist change**

In `apps/core/src/documents/feishu-document-body-fetcher.ts`, add `"user_submitted_document"` to `supportedSourceTypes`.

- [x] **Step 4: Run focused test again**

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
git add docs/superpowers/specs/2026-07-03-iris-user-submitted-document-body-fetch-design.md docs/superpowers/plans/2026-07-03-iris-user-submitted-document-body-fetch.md apps/core/src/documents/feishu-document-body-fetcher.ts apps/core/tests/feishu-document-body-fetcher.test.ts
git commit -m "feat: fetch user submitted document bodies"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3L to PR #3:

```markdown
- Add Phase 3L user-submitted document body fetch: user-submitted Feishu docx/docs sources now use the document sync raw-content fetcher.
```

## Self-Review

- Spec coverage: source type allowlist, URL behavior, safety note, test and verification are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: focused on Feishu body fetch support only.
