# Iris Document Source Health Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional latest snapshot summaries to the document source inventory API.

**Architecture:** Keep the runtime unchanged and compose `sources.list()` with `sources.getLatestSnapshot()` in the Fastify handler when `includeLatestSnapshot=true`. Reuse the existing source objects and snapshot summary mapper without body preview.

**Tech Stack:** TypeScript, Fastify, Vitest.

---

## File Structure

- `apps/core/src/app.ts`: parse `includeLatestSnapshot`, enrich source list rows, and keep default responses unchanged.
- `apps/core/tests/answer-draft-api.test.ts`: prove default omission, enriched list success, no body exposure, validation, filter compatibility, and failure behavior.

## Tasks

### Task 1: Source Inventory Latest Snapshot Enrichment

- [x] **Step 1: Write failing API tests**

Add tests in `apps/core/tests/answer-draft-api.test.ts`:

```ts
const response = await app.inject({
  method: "GET",
  url: "/internal/document-sync/sources?limit=2&includeLatestSnapshot=true",
});
expect(response.json().sources[0].latestSnapshot).toMatchObject({
  id: "snapshot-1",
  fetchStatus: "failed",
});
expect(response.json().sources[0].latestSnapshot).not.toHaveProperty("bodyText");
expect(response.json().sources[0].latestSnapshot).not.toHaveProperty("bodyTextPreview");
```

Add invalid query coverage:

```ts
const response = await app.inject({
  method: "GET",
  url: "/internal/document-sync/sources?includeLatestSnapshot=false",
});
expect(response.statusCode).toBe(400);
```

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: fail because source list rows do not include `latestSnapshot` and invalid `includeLatestSnapshot` is ignored.

- [x] **Step 3: Implement query parsing and enrichment**

In `apps/core/src/app.ts`:

- Add `includeLatestSnapshot?: true` to `DocumentSourceListQuery`.
- Add `parseIncludeLatestSnapshot(value: unknown): true | false | undefined`.
- Include the flag in `parseDocumentSourceListQuery()`.
- In the source list route, call `sources.list(parsedQuery)` once.
- If `includeLatestSnapshot` is missing, return the same source array.
- If present, map each source to `{ ...source, latestSnapshot }` when `getLatestSnapshot()` returns a snapshot.

- [x] **Step 4: Verify green**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
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
git add docs/superpowers/specs/2026-07-03-iris-document-source-health-summary-design.md docs/superpowers/plans/2026-07-03-iris-document-source-health-summary.md apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: add document source health summaries"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3R to PR #3:

```markdown
- Add Phase 3R document source health summaries: optional latest snapshot summary enrichment for source inventory rows.
```

## Self-Review

- Spec coverage: query parsing, default behavior, enrichment, body-safety, error behavior, tests, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: read-only source list enrichment only.
