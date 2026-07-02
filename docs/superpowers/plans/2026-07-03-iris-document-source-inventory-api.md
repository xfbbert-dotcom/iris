# Iris Document Source Inventory API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add internal read APIs that let operators list and inspect document sources known to Iris.

**Architecture:** Extend `DocumentSyncRuntime` with a `sources` read namespace backed by the existing document source registry. Expose two Fastify routes: a list endpoint with one optional filter and a detail endpoint by source id.

**Tech Stack:** TypeScript, Fastify, Vitest, existing Postgres document source registry.

---

## File Structure

- `apps/core/src/runtime/document-sync-runtime.ts`: add runtime inventory types and delegate source list/detail lookups to the registry.
- `apps/core/src/app.ts`: add internal source list/detail routes and query parsing helpers.
- `apps/core/tests/document-sync-runtime.test.ts`: prove runtime delegates to the registry and applies limits.
- `apps/core/tests/answer-draft-api.test.ts`: prove HTTP routes, validation, errors, and JSON serialization.

## Tasks

### Task 1: Runtime Source Inventory

**Files:**
- Modify: `apps/core/tests/document-sync-runtime.test.ts`
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`

- [x] **Step 1: Write the failing runtime test**

Add a reusable `inventorySource` object in the existing runtime composition test and add assertions after the registration assertions:

```ts
await expect(runtime?.sources.list({ limit: 1 })).resolves.toEqual([inventorySource]);
expect(documentSources.listSources).toHaveBeenCalledOnce();

await expect(
  runtime?.sources.list({ limit: 10, sourceType: "authorized_wiki_document" }),
).resolves.toEqual([inventorySource]);
expect(documentSources.listSourcesByType).toHaveBeenCalledWith("authorized_wiki_document");

await expect(runtime?.sources.get("source-1")).resolves.toEqual(inventorySource);
expect(documentSources.findSourceById).toHaveBeenCalledWith("source-1");
```

The mock registry must also include the single-filter methods used by runtime:

```ts
listSources: vi.fn(async () => [inventorySource, userSubmittedSource]),
listSourcesByType: vi.fn(async () => [inventorySource]),
listSourcesByGroupId: vi.fn(async () => [inventorySource]),
listSourcesByAuthorizedSpaceId: vi.fn(async () => [inventorySource]),
listSourcesBySubmittingUserId: vi.fn(async () => [userSubmittedSource]),
listSourcesUsableForAnswering: vi.fn(async () => [inventorySource, userSubmittedSource]),
findSourceById: vi.fn(async () => inventorySource),
```

- [x] **Step 2: Run runtime test and verify red**

Run:

```bash
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: fail because `runtime.sources` does not exist.

- [x] **Step 3: Implement runtime source inventory**

In `apps/core/src/runtime/document-sync-runtime.ts`:

- Import `DocumentSource` and `DocumentSourceType`.
- Add `DocumentSourceInventoryListInput`.
- Add `sources` to `DocumentSyncRuntime`.
- Widen `DocumentSyncRuntimeDocumentSources` to include read registry methods.
- Implement `sources.list()` and `sources.get()`.

The list implementation chooses exactly one registry method based on the input and slices to `input.limit`.

- [x] **Step 4: Run runtime test and verify green**

Run:

```bash
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: pass.

### Task 2: HTTP Inventory API

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Write failing API tests**

Add `sources` defaults to `fakeDocumentSyncRuntime()`:

```ts
sources: {
  list: vi.fn(async () => []),
  get: vi.fn(async () => undefined),
},
```

Add a `describe("document sync source inventory API", ...)` suite covering:

- unavailable runtime returns `503 document_sync_worker_unavailable`
- list returns `{ ok: true, sources }` and calls `runtime.sources.list({ limit: 2 })`
- `sourceType` filter calls `runtime.sources.list({ limit: 20, sourceType: "authorized_wiki_document" })`
- multiple filters return `400 invalid_request`
- invalid limit returns `400 invalid_request`
- detail route returns `{ ok: true, source }`
- missing detail route returns `404 document_source_not_found`
- lookup failures return `500 document_source_lookup_failed`

- [x] **Step 2: Run API test and verify red**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: fail because the new routes are not implemented.

- [x] **Step 3: Implement Fastify routes and parsers**

In `apps/core/src/app.ts`:

- Import `DocumentSourceType`.
- Add `GET /internal/document-sync/sources`.
- Add `GET /internal/document-sync/sources/:id`.
- Add `parseDocumentSourceListQuery()`.
- Add `isDocumentSourceType()`.

Validation rules:

- Default limit is `20`.
- Limit must be an integer `>= 0`, capped at `100`.
- At most one filter besides limit is allowed.
- `usableForAnswering` only accepts `"true"` in v1.
- Blank ids and blank filter values are invalid.

- [x] **Step 4: Run API test and verify green**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: pass.

### Task 3: Full Verification and PR Update

**Files:**
- Modify: PR #3 body only through `gh pr edit`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
npm test
python -m pytest
docker compose config
```

Expected:

- TypeScript passes.
- Vitest passes.
- Python tests pass.
- Docker Compose config renders successfully.

- [x] **Step 2: Commit implementation**

Run:

```bash
git add docs/superpowers/specs/2026-07-03-iris-document-source-inventory-api-design.md docs/superpowers/plans/2026-07-03-iris-document-source-inventory-api.md apps/core/src/runtime/document-sync-runtime.ts apps/core/src/app.ts apps/core/tests/document-sync-runtime.test.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: expose document source inventory"
```

- [x] **Step 3: Push and update PR**

Run:

```bash
git push
gh pr edit 3 --repo xfbbert-dotcom/iris --body-file <updated-body-file>
gh pr view 3 --repo xfbbert-dotcom/iris --json state,isDraft,mergeable,headRefOid,url
```

Expected: PR remains open and points at the new head commit.

## Self-Review

- Spec coverage: the plan covers runtime, HTTP API, validation, tests, and PR update.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: `DocumentSourceInventoryListInput`, `sources.list`, and `sources.get` are consistently named across design, tests, and implementation.
