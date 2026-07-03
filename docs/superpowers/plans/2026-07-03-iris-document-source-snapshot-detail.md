# Iris Document Source Snapshot Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an internal API to fetch one source-owned sync snapshot summary.

**Architecture:** Extend `DocumentSyncRuntime.sources` with `getSnapshot()`, backed by the existing snapshot repository. Expose `GET /internal/document-sync/sources/:sourceId/snapshots/:snapshotId` and return the existing summary shape without `bodyText`.

**Tech Stack:** TypeScript, Fastify, Vitest, existing Postgres snapshot repository.

---

## File Structure

- `apps/core/src/runtime/document-sync-runtime.ts`: add `sources.getSnapshot()` and enforce source ownership.
- `apps/core/src/app.ts`: add snapshot detail route before the broader snapshot list and source detail routes.
- `apps/core/tests/document-sync-runtime.test.ts`: prove runtime checks source existence, fetches a snapshot, and rejects cross-source snapshots.
- `apps/core/tests/answer-draft-api.test.ts`: prove HTTP success, validation, unavailable, not found, and failure paths.

## Tasks

### Task 1: Runtime Snapshot Detail

- [x] **Step 1: Write failing runtime test**

Add `findSnapshotById` to the snapshot repository mock:

```ts
findSnapshotById: vi.fn(async () => snapshot),
```

Assert:

```ts
await expect(
  runtime?.sources.getSnapshot({ sourceId: "source-1", snapshotId: "snapshot-1" }),
).resolves.toEqual(snapshot);
expect(documentSources.findSourceById).toHaveBeenCalledWith("source-1");
expect(snapshots.findSnapshotById).toHaveBeenCalledWith("snapshot-1");

snapshots.findSnapshotById.mockResolvedValueOnce({
  ...snapshot,
  id: "snapshot-2",
  documentSourceId: "other-source",
});
await expect(
  runtime?.sources.getSnapshot({ sourceId: "source-1", snapshotId: "snapshot-2" }),
).resolves.toBeUndefined();
```

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: fail because `sources.getSnapshot` does not exist.

- [x] **Step 3: Implement runtime method**

In `document-sync-runtime.ts`:

- Add `getSnapshot()` to `DocumentSyncRuntime.sources`.
- Add `DocumentSourceSnapshotGetInput`.
- Add `findSnapshotById()` to `DocumentSyncRuntimeSnapshots`.
- Implement source existence and snapshot ownership checks.

- [x] **Step 4: Verify green**

Run:

```bash
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: pass.

### Task 2: HTTP Snapshot Detail API

- [x] **Step 1: Write failing API tests**

Add `getSnapshot` to `fakeDocumentSyncRuntime().sources` and custom `sources` overrides.

Add tests for:

- 503 when runtime unavailable.
- 200 with a summary object and no `bodyText`.
- 404 when runtime returns `undefined`.
- 400 for blank source or snapshot IDs.
- 500 when runtime throws.

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: fail because the route is missing.

- [x] **Step 3: Implement route**

In `app.ts`:

- Add `GET /internal/document-sync/sources/:sourceId/snapshots/:snapshotId`.
- Parse both params with `readNonBlankId()`.
- Call `documentSyncRuntime.sources.getSnapshot({ sourceId, snapshotId })`.
- Return `404 document_source_snapshot_not_found` for missing or cross-source snapshots.
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
git add docs/superpowers/specs/2026-07-03-iris-document-source-snapshot-detail-design.md docs/superpowers/plans/2026-07-03-iris-document-source-snapshot-detail.md apps/core/src/runtime/document-sync-runtime.ts apps/core/src/app.ts apps/core/tests/document-sync-runtime.test.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: expose document source snapshot detail"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3O to PR #3:

```markdown
- Add Phase 3O document source snapshot detail: internal source-owned snapshot detail API without returning body text.
```

## Self-Review

- Spec coverage: runtime, route, summary shape, ownership guard, errors, tests, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: read-only snapshot summary only.
