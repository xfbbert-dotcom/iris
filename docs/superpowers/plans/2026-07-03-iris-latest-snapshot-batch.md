# Iris Latest Snapshot Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace source inventory latest snapshot enrichment with a single batch latest snapshot lookup.

**Architecture:** Add a batch latest snapshot repository method, expose it through `DocumentSyncRuntime.sources.getLatestSnapshots()`, and update the source inventory handler to call the batch method once when `includeLatestSnapshot=true`.

**Tech Stack:** TypeScript, Fastify, Vitest, Postgres.

---

## File Structure

- `apps/core/src/documents/document-snapshot-repository.ts`: add `findLatestSnapshotsForSources()`.
- `apps/core/src/runtime/document-sync-runtime.ts`: add `sources.getLatestSnapshots()`.
- `apps/core/src/app.ts`: use the batch runtime method in source inventory enrichment.
- `apps/core/tests/document-snapshot-repository.test.ts`: prove SQL shape, empty input, and mapping.
- `apps/core/tests/document-sync-runtime.test.ts`: prove runtime delegates once and returns a map.
- `apps/core/tests/answer-draft-api.test.ts`: prove source inventory calls the batch method once.

## Tasks

### Task 1: Repository Batch Lookup

- [x] **Step 1: Write failing repository tests**

Add tests for:

```ts
await expect(repository.findLatestSnapshotsForSources([])).resolves.toEqual([]);
expect(query).not.toHaveBeenCalled();
```

and:

```ts
await expect(
  repository.findLatestSnapshotsForSources(["source-1", "source-2"]),
).resolves.toEqual([
  expect.objectContaining({ id: "snapshot-1", documentSourceId: "source-1" }),
  expect.objectContaining({ id: "snapshot-2", documentSourceId: "source-2" }),
]);
expect(normalizeSql(sql)).toContain("distinct on (document_source_id)");
expect(values).toEqual([["source-1", "source-2"]]);
```

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/document-snapshot-repository.test.ts
```

Expected: fail because `findLatestSnapshotsForSources` does not exist.

- [x] **Step 3: Implement repository method**

In `document-snapshot-repository.ts`:

- Add the method to the interface.
- Return `[]` for empty input.
- Query with `distinct on (document_source_id)` and `any($1::text[])`.
- Map rows with `mapSnapshotRow`.

- [x] **Step 4: Verify green**

Run:

```bash
npm --workspace apps/core test -- tests/document-snapshot-repository.test.ts
```

Expected: pass.

### Task 2: Runtime Batch Lookup

- [x] **Step 1: Write failing runtime test**

Add `findLatestSnapshotsForSources` to the snapshot mock and assert:

```ts
const latestSnapshots = await runtime?.sources.getLatestSnapshots({
  sourceIds: ["source-1", "user-source-1"],
});
expect(latestSnapshots?.get("source-1")).toEqual(snapshot);
expect(snapshots.findLatestSnapshotsForSources).toHaveBeenCalledWith([
  "source-1",
  "user-source-1",
]);
```

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: fail because `sources.getLatestSnapshots` does not exist.

- [x] **Step 3: Implement runtime method**

In `document-sync-runtime.ts`:

- Add `getLatestSnapshots()` to `DocumentSyncRuntime.sources`.
- Add `DocumentSourceLatestSnapshotsInput`.
- Add `findLatestSnapshotsForSources()` to `DocumentSyncRuntimeSnapshots`.
- Return a `Map` keyed by `snapshot.documentSourceId`.

- [x] **Step 4: Verify green**

Run:

```bash
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: pass.

### Task 3: Source Inventory Batch Enrichment

- [x] **Step 1: Write failing API expectation**

Update the existing `includeLatestSnapshot=true` source inventory test:

```ts
expect(runtime.sources.getLatestSnapshots).toHaveBeenCalledWith({
  sourceIds: ["source-1", "user-source-1"],
});
expect(runtime.sources.getLatestSnapshot).not.toHaveBeenCalled();
```

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: fail because the handler still calls `getLatestSnapshot()` per source.

- [x] **Step 3: Implement API batch usage**

In `app.ts`:

- Build `sourceIds` from the listed sources.
- Call `documentSyncRuntime.sources.getLatestSnapshots({ sourceIds })` once.
- Attach `latestSnapshot` from the map.

- [x] **Step 4: Verify green**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: pass.

### Task 4: Full Verification and PR Update

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
git add docs/superpowers/specs/2026-07-03-iris-latest-snapshot-batch-design.md docs/superpowers/plans/2026-07-03-iris-latest-snapshot-batch.md apps/core/src/documents/document-snapshot-repository.ts apps/core/src/runtime/document-sync-runtime.ts apps/core/src/app.ts apps/core/tests/document-snapshot-repository.test.ts apps/core/tests/document-sync-runtime.test.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: batch latest document snapshots"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3T to PR #3:

```markdown
- Add Phase 3T latest snapshot batch lookup: batch latest snapshot repository/runtime lookup for source inventory health enrichment.
```

## Self-Review

- Spec coverage: repository, runtime, API, no HTTP shape change, tests, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: performance refactor only.
