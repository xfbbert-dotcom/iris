# Iris Document Source Sync Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight `syncHealth` view model to source responses that already request latest snapshot enrichment.

**Architecture:** Keep runtime and repository unchanged. Derive `syncHealth` in `apps/core/src/app.ts` from the optional latest snapshot used for `includeLatestSnapshot=true`.

**Tech Stack:** TypeScript, Fastify, Vitest.

---

## File Structure

- `apps/core/src/app.ts`: add `toDocumentSourceSyncHealth()` and attach it in list/detail enrichment paths.
- `apps/core/tests/answer-draft-api.test.ts`: prove list and detail health states, including `never_synced`.

## Tasks

### Task 1: Source Sync Health View Model

- [x] **Step 1: Write failing API tests**

Update existing `includeLatestSnapshot=true` tests to expect:

```ts
expect(response.json().sources[0].syncHealth).toEqual({
  status: "failing",
  latestSnapshotId: "snapshot-1",
  lastFetchedAt: "2026-07-03T04:00:00.000Z",
  errorMessage: "Feishu returned 403",
});
expect(response.json().sources[1].syncHealth).toEqual({ status: "never_synced" });
```

For source detail with a succeeded latest snapshot:

```ts
expect(response.json().source.syncHealth).toEqual({
  status: "healthy",
  latestSnapshotId: "snapshot-1",
  lastFetchedAt: "2026-07-03T04:00:00.000Z",
});
```

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: fail because `syncHealth` is not returned.

- [x] **Step 3: Implement sync health derivation**

In `apps/core/src/app.ts`:

- Add `toDocumentSourceSyncHealth(snapshot?: DocumentSnapshot)`.
- Return `{ status: "never_synced" }` when snapshot is missing.
- Return healthy/failing health objects from `snapshot.fetchStatus`.
- Attach `syncHealth` in source list and detail `includeLatestSnapshot=true` branches.

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
git add docs/superpowers/specs/2026-07-03-iris-document-source-sync-health-design.md docs/superpowers/plans/2026-07-03-iris-document-source-sync-health.md apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: add document source sync health"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3U to PR #3:

```markdown
- Add Phase 3U document source sync health: lightweight healthy/failing/never-synced view model for enriched source responses.
```

## Self-Review

- Spec coverage: list/detail behavior, statuses, body-safety, tests, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: API view model only.
