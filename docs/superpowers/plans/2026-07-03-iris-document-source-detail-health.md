# Iris Document Source Detail Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional latest snapshot summary enrichment to source detail responses.

**Architecture:** Reuse the existing `sources.getLatestSnapshot()` runtime method in the source detail handler. Parse `includeLatestSnapshot=true` with the same parser used by source inventory and attach a snapshot summary only when one exists.

**Tech Stack:** TypeScript, Fastify, Vitest.

---

## File Structure

- `apps/core/src/app.ts`: parse `includeLatestSnapshot` in source detail and attach latest snapshot summaries.
- `apps/core/tests/answer-draft-api.test.ts`: prove default omission, enriched detail success, no body exposure, invalid query handling, and failure behavior.

## Tasks

### Task 1: Source Detail Latest Snapshot Enrichment

- [x] **Step 1: Write failing API tests**

Add tests in `apps/core/tests/answer-draft-api.test.ts`:

```ts
const response = await app.inject({
  method: "GET",
  url: "/internal/document-sync/sources/source-1?includeLatestSnapshot=true",
});
expect(response.json().source.latestSnapshot).toMatchObject({
  id: "snapshot-1",
  fetchStatus: "succeeded",
});
expect(response.json().source.latestSnapshot).not.toHaveProperty("bodyText");
expect(response.json().source.latestSnapshot).not.toHaveProperty("bodyTextPreview");
```

Add invalid query coverage:

```ts
const response = await app.inject({
  method: "GET",
  url: "/internal/document-sync/sources/source-1?includeLatestSnapshot=false",
});
expect(response.statusCode).toBe(400);
```

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: fail because source detail does not include `latestSnapshot` and invalid `includeLatestSnapshot` is ignored.

- [x] **Step 3: Implement detail enrichment**

In `apps/core/src/app.ts`:

- Parse `includeLatestSnapshot` in the source detail route.
- Return `400 invalid_request` when the parser returns `false`.
- Keep the default response unchanged.
- When requested, call `documentSyncRuntime.sources.getLatestSnapshot({ sourceId })`.
- Attach `latestSnapshot: toDocumentSnapshotSummary(snapshot)` only when a snapshot exists.

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
git add docs/superpowers/specs/2026-07-03-iris-document-source-detail-health-design.md docs/superpowers/plans/2026-07-03-iris-document-source-detail-health.md apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: add document source detail health"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3S to PR #3:

```markdown
- Add Phase 3S document source detail health: optional latest snapshot summary enrichment for source detail.
```

## Self-Review

- Spec coverage: query parsing, default behavior, enrichment, body-safety, error behavior, tests, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: read-only source detail enrichment only.
