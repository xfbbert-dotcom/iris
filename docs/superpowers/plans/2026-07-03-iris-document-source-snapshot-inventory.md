# Iris Document Source Snapshot Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an internal API to list recent sync snapshot summaries for a document source.

**Architecture:** Extend `DocumentSyncRuntime.sources` with `listSnapshots()`, backed by the existing snapshot repository. Expose `GET /internal/document-sync/sources/:id/snapshots` and summarize snapshots without returning `bodyText`.

**Tech Stack:** TypeScript, Fastify, Vitest, existing Postgres snapshot repository.

---

## File Structure

- `apps/core/src/runtime/document-sync-runtime.ts`: add `sources.listSnapshots()`.
- `apps/core/src/app.ts`: add snapshot list route, limit parsing, and summary mapping.
- `apps/core/tests/document-sync-runtime.test.ts`: prove runtime checks source existence and delegates snapshot listing.
- `apps/core/tests/answer-draft-api.test.ts`: prove HTTP success, 404, validation, unavailable, and failure paths.

## Tasks

### Task 1: Runtime Snapshot Listing

- [x] **Step 1: Write failing runtime test**

Add a snapshot repository mock:

```ts
listSnapshotsForSource: vi.fn(async () => [snapshot]),
```

Assert:

```ts
await expect(runtime?.sources.listSnapshots({ id: "source-1", limit: 1 })).resolves.toEqual([
  snapshot,
]);
expect(documentSources.findSourceById).toHaveBeenCalledWith("source-1");
expect(snapshots.listSnapshotsForSource).toHaveBeenCalledWith("source-1");
```

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: fail because `sources.listSnapshots` does not exist.

- [x] **Step 3: Implement runtime method**

In `document-sync-runtime.ts`:

- Import `DocumentSnapshot` already exists.
- Add `listSnapshots()` to `DocumentSyncRuntime.sources`.
- Add `listSnapshotsForSource` to `DocumentSyncRuntimeSnapshots`.
- Implement source existence check and limit slicing.

- [x] **Step 4: Verify green**

Run:

```bash
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: pass.

### Task 2: HTTP Snapshot Inventory API

- [x] **Step 1: Write failing API tests**

Add `listSnapshots` to `fakeDocumentSyncRuntime().sources`.

Add tests for:

- 503 when runtime unavailable.
- 200 with summary objects and no `bodyText`.
- 404 when runtime returns `undefined`.
- 400 for invalid limit.
- 500 when runtime throws.

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: fail because route is missing.

- [x] **Step 3: Implement route**

In `app.ts`:

- Add `GET /internal/document-sync/sources/:id/snapshots`.
- Reuse `parseDeadLetterLimit()` for `limit`.
- Add `toDocumentSnapshotSummary()`.
- Ensure returned summaries omit `bodyText` and include `bodyTextLength` when body text exists.

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
git add docs/superpowers/specs/2026-07-03-iris-document-source-snapshot-inventory-design.md docs/superpowers/plans/2026-07-03-iris-document-source-snapshot-inventory.md apps/core/src/runtime/document-sync-runtime.ts apps/core/src/app.ts apps/core/tests/document-sync-runtime.test.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: expose document source snapshots"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3N to PR #3:

```markdown
- Add Phase 3N document source snapshot inventory: internal source snapshot summary API for recent sync attempts.
```

## Self-Review

- Spec coverage: runtime, route, summary shape, errors, tests, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: read-only snapshot summaries only.
