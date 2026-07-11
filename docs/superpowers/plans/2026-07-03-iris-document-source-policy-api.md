# Iris Document Source Policy API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an internal API that lets operators change whether a document source can be used for answers or knowledge drafts.

**Architecture:** Reuse the existing document source registry policy methods through `DocumentSyncRuntime.sources.updatePolicy()`, then expose one Fastify `PATCH` route. The route validates a small boolean body, maps missing sources to 404, and returns the final updated `DocumentSource`.

**Tech Stack:** TypeScript, Fastify, Vitest, existing document source registries.

---

## File Structure

- `apps/core/src/runtime/document-sync-runtime.ts`: add `sources.updatePolicy()` and include registry policy methods in the runtime dependency type.
- `apps/core/src/app.ts`: add `PATCH /internal/document-sync/sources/:id/policy` and a request parser.
- `apps/core/tests/document-sync-runtime.test.ts`: prove runtime policy updates delegate to registry methods in order and return final state.
- `apps/core/tests/answer-draft-api.test.ts`: prove route validation, success, 404, 503, and failure handling.

## Tasks

### Task 1: Runtime Policy Update

**Files:**
- Modify: `apps/core/tests/document-sync-runtime.test.ts`
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`

- [x] **Step 1: Write failing runtime test**

Add these registry mocks:

```ts
setAnsweringEnabled: vi.fn(async () => ({
  ...inventorySource,
  canUseForAnswering: false,
})),
setKnowledgeDraftsEnabled: vi.fn(async () => ({
  ...inventorySource,
  canUseForAnswering: false,
  canUseForKnowledgeDrafts: false,
})),
```

Add this assertion near other `runtime.sources` assertions:

```ts
await expect(
  runtime?.sources.updatePolicy({
    id: "source-1",
    canUseForAnswering: false,
    canUseForKnowledgeDrafts: false,
  }),
).resolves.toEqual({
  ...inventorySource,
  canUseForAnswering: false,
  canUseForKnowledgeDrafts: false,
});
expect(documentSources.findSourceById).toHaveBeenCalledWith("source-1");
expect(documentSources.setAnsweringEnabled).toHaveBeenCalledWith("source-1", false);
expect(documentSources.setKnowledgeDraftsEnabled).toHaveBeenCalledWith("source-1", false);
```

- [x] **Step 2: Run runtime test and verify red**

Run:

```bash
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: fail because `runtime.sources.updatePolicy` does not exist.

- [x] **Step 3: Implement runtime update**

In `apps/core/src/runtime/document-sync-runtime.ts`:

- Add `DocumentSourcePolicyUpdateInput`.
- Add `updatePolicy()` to `DocumentSyncRuntime.sources`.
- Add `setAnsweringEnabled` and `setKnowledgeDraftsEnabled` to `DocumentSyncRuntimeDocumentSources`.
- Implement update:
  - call `findSourceById(id)` first.
  - return `undefined` if missing.
  - apply `setAnsweringEnabled` if present.
  - apply `setKnowledgeDraftsEnabled` if present.
  - return the final source.

- [x] **Step 4: Run runtime test and verify green**

Run:

```bash
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: pass.

### Task 2: HTTP Policy API

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Write failing API tests**

Add `updatePolicy` to `fakeDocumentSyncRuntime().sources`.

Add tests under `document sync source inventory API` or a nearby `document sync source policy API` suite:

- unavailable runtime returns `503 document_sync_worker_unavailable`.
- success calls `runtime.sources.updatePolicy({ id, canUseForAnswering, canUseForKnowledgeDrafts })` and returns updated source.
- missing source returns `404 document_source_not_found`.
- invalid body returns `400 invalid_request`.
- thrown update returns `500 document_source_policy_update_failed`.

- [x] **Step 2: Run API test and verify red**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: fail because the route is missing.

- [x] **Step 3: Implement route and parser**

In `apps/core/src/app.ts`:

- Add `DocumentSourcePolicyUpdateRequest`.
- Add `PATCH /internal/document-sync/sources/:id/policy`.
- Add `parseDocumentSourcePolicyUpdateRequest()`.

Parser rules:

- Body must be an object.
- At least one of `canUseForAnswering` or `canUseForKnowledgeDrafts` must be present.
- Present fields must be booleans.

- [x] **Step 4: Run API test and verify green**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: pass.

### Task 3: Full Verification, Commit, and PR Update

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
npm test
python -m pytest
docker compose config
```

If root-level Python cannot import `iris_worker`, run `python -m pytest` from `workers/ai` and record that command in the final summary.

- [x] **Step 2: Commit**

Run:

```bash
git add docs/superpowers/specs/2026-07-03-iris-document-source-policy-api-design.md docs/superpowers/plans/2026-07-03-iris-document-source-policy-api.md apps/core/src/runtime/document-sync-runtime.ts apps/core/src/app.ts apps/core/tests/document-sync-runtime.test.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: expose document source policy updates"
```

- [x] **Step 3: Push and update PR**

Run:

```bash
git push
gh pr edit 3 --repo xfbbert-dotcom/iris --body-file <updated-body-file>
gh pr view 3 --repo xfbbert-dotcom/iris --json state,isDraft,mergeable,headRefOid,url
```

Expected: PR remains open and non-draft.

## Self-Review

- Spec coverage: runtime update, HTTP route, validation, error mapping, tests, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: `DocumentSourcePolicyUpdateInput`, `DocumentSourcePolicyUpdateRequest`, and `sources.updatePolicy()` are consistently named.
