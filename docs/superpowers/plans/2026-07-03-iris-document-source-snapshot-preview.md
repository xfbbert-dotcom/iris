# Iris Document Source Snapshot Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, capped body preview option to the snapshot detail endpoint.

**Architecture:** Keep runtime snapshot lookup unchanged. Parse `previewLength` in the Fastify route and pass an optional preview limit to the existing snapshot summary mapper.

**Tech Stack:** TypeScript, Fastify, Vitest.

---

## File Structure

- `apps/core/src/app.ts`: parse `previewLength`, extend `toDocumentSnapshotSummary()`, and apply preview only on detail.
- `apps/core/tests/answer-draft-api.test.ts`: prove opt-in preview, default omission, list omission, invalid values, and zero-length behavior.

## Tasks

### Task 1: Snapshot Preview API

- [x] **Step 1: Write failing API tests**

Add assertions in `apps/core/tests/answer-draft-api.test.ts`:

```ts
expect(response.json().snapshot).not.toHaveProperty("bodyTextPreview");
```

Add a new request:

```ts
const response = await app.inject({
  method: "GET",
  url: "/internal/document-sync/sources/source-1/snapshots/snapshot-1?previewLength=8",
});
expect(response.json().snapshot.bodyTextPreview).toBe("Document");
```

Add invalid request coverage:

```ts
const response = await app.inject({
  method: "GET",
  url: "/internal/document-sync/sources/source-1/snapshots/snapshot-1?previewLength=2001",
});
expect(response.statusCode).toBe(400);
```

- [x] **Step 2: Verify red**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: fail because `bodyTextPreview` is not implemented and invalid `previewLength` is ignored.

- [x] **Step 3: Implement preview parsing and mapping**

In `apps/core/src/app.ts`:

- Add `parseSnapshotPreviewLength(value: unknown): number | undefined | false`.
- Accept only string integers from `0` to `2000`.
- Extend `toDocumentSnapshotSummary(snapshot, options)` with `bodyTextPreview`.
- Pass `{ previewLength }` only in the detail route.

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
git add docs/superpowers/specs/2026-07-03-iris-document-source-snapshot-preview-design.md docs/superpowers/plans/2026-07-03-iris-document-source-snapshot-preview.md apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: add document snapshot previews"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3P to PR #3:

```markdown
- Add Phase 3P document snapshot previews: explicit capped body preview support on source-owned snapshot detail.
```

## Self-Review

- Spec coverage: preview opt-in, cap, validation, summary mapping, tests, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: no full body endpoint and no list preview.
