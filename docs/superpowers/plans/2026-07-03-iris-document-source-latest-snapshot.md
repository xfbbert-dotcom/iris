# Iris Document Source Latest Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shortcut API for reading the latest sync snapshot summary for a document source.

**Architecture:** Extend `DocumentSyncRuntime.sources` with `getLatestSnapshot()`, backed by the existing snapshot repository. Add `GET /internal/document-sync/sources/:id/snapshots/latest` before the generic snapshot detail route and reuse the snapshot summary plus preview logic.

**Tech Stack:** TypeScript, Fastify, Vitest, existing Postgres snapshot repository.

---

## File Structure

- `apps/core/src/runtime/document-sync-runtime.ts`: add `sources.getLatestSnapshot()`.
- `apps/core/src/app.ts`: add latest snapshot route before `:snapshotId` route.
- `apps/core/tests/document-sync-runtime.test.ts`: prove runtime checks source existence and delegates latest snapshot lookup.
- `apps/core/tests/answer-draft-api.test.ts`: prove HTTP success, preview success, unavailable, not found, validation, and failure paths.

## Tasks

### Task 1: Runtime Latest Snapshot

- [x] **Step 1: Write failing runtime test**

Add `findLatestSnapshotForSource` to the snapshot repository mock:

```ts
findLatestSnapshotForSource: vi.fn(async () => snapshot),
```

Assert:

```ts
await expect(
  runtime?.sources.getLatestSnapshot({ sourceId: "source-1" }),
).resolves.toEqual(snapshot);
expect(documentSources.findSourceById).toHaveBeenCalledWith("source-1");
expect(snapshots.findLatestSnapshotForSource).toHaveBeenCalledWith("source-1");
```

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: fail because `sources.getLatestSnapshot` does not exist.

- [x] **Step 3: Implement runtime method**

In `document-sync-runtime.ts`:

- Add `getLatestSnapshot()` to `DocumentSyncRuntime.sources`.
- Add `DocumentSourceLatestSnapshotInput`.
- Add `findLatestSnapshotForSource()` to `DocumentSyncRuntimeSnapshots`.
- Implement source existence check and latest snapshot lookup.

- [x] **Step 4: Verify green**

Run:

```bash
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: pass.

### Task 2: HTTP Latest Snapshot API

- [x] **Step 1: Write failing API tests**

Add `getLatestSnapshot` to `fakeDocumentSyncRuntime().sources` and custom `sources` overrides.

Add tests for:

- 503 when runtime unavailable.
- 200 with latest snapshot summary and no body text by default.
- 200 with `previewLength`.
- 404 when runtime returns `undefined`.
- 400 for invalid source ID or invalid `previewLength`.
- 500 when runtime throws.

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: fail because the route is missing.

- [x] **Step 3: Implement route**

In `app.ts`:

- Add `GET /internal/document-sync/sources/:id/snapshots/latest` before `:sourceId/snapshots/:snapshotId`.
- Parse `id` with `readNonBlankId()`.
- Parse `previewLength` with `parseSnapshotPreviewLength()`.
- Call `documentSyncRuntime.sources.getLatestSnapshot({ sourceId })`.
- Return `404 document_source_snapshot_not_found` for missing source or no snapshots.
- Return `500 document_source_snapshot_lookup_failed` on unexpected errors.
- Reuse `toDocumentSnapshotSummary()`.

- [x] **Step 4: Verify green**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: pass.

### Task 3: Full Verification and PR Update

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
git add docs/superpowers/specs/2026-07-03-iris-document-source-latest-snapshot-design.md docs/superpowers/plans/2026-07-03-iris-document-source-latest-snapshot.md apps/core/src/runtime/document-sync-runtime.ts apps/core/src/app.ts apps/core/tests/document-sync-runtime.test.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: expose latest document source snapshot"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3Q to PR #3:

```markdown
- Add Phase 3Q latest document source snapshot: shortcut API for the newest source sync attempt with optional capped preview.
```

## Self-Review

- Spec coverage: runtime, route, preview reuse, error behavior, tests, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: latest snapshot read-only shortcut only.
