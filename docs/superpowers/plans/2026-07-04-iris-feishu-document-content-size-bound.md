# Iris Feishu Document Content Size Bound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject oversized Feishu document raw content before it can enter snapshots, indexing, or
answer context.

**Architecture:** Add `IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS` to Feishu OpenAPI config, pass the
value into `createFeishuDocumentBodyFetcher`, and enforce the bound in raw content parsing.

**Tech Stack:** TypeScript, Vitest, Feishu OpenAPI adapter tests, runtime composition tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`
- Modify: `apps/core/tests/env.test.ts`
- Modify: `apps/core/tests/document-sync-runtime.test.ts`

- [x] **Step 1: Add raw content size test**

Add a `FeishuDocumentBodyFetcher` test:

```ts
it("rejects raw content that exceeds the configured content size", async () => {
  const fetcher = createFeishuDocumentBodyFetcher({
    baseUrl: "https://open.feishu.cn",
    tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
    fetch: vi.fn(async () => jsonResponse({ code: 0, data: { content: "123456" } })),
    maxContentChars: 5,
  });

  await expect(fetcher.fetch(source())).rejects.toThrow(
    "Feishu document raw content exceeds 5 characters",
  );
});
```

- [x] **Step 2: Add Feishu OpenAPI config tests**

Update Feishu OpenAPI env tests so:

```ts
IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS: " 12345 ",
```

is returned as `documentMaxContentChars: 12345`, default config returns `2000000`, and `"0"` throws:

```ts
"IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS must be a positive integer"
```

- [x] **Step 3: Add runtime composition assertion**

In `document-sync-runtime.test.ts`, set:

```ts
IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS: "6000",
```

and assert `createFeishuDocumentBodyFetcher` receives:

```ts
maxContentChars: 6000,
```

- [x] **Step 4: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- feishu-document-body-fetcher.test.ts env.test.ts document-sync-runtime.test.ts -t "content|Feishu OpenAPI|composes"
```

Expected: tests fail because `maxContentChars` is not yet supported.

Observed: focused tests failed because env config omitted `documentMaxContentChars`, runtime did
not pass `maxContentChars`, and oversized raw content resolved instead of rejecting.

### Task 2: Implement Content Size Bound

**Files:**
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`

- [x] **Step 1: Add fetcher dependency and default**

Add `maxContentChars?: number` to `FeishuDocumentBodyFetcherDependencies`, define:

```ts
const DEFAULT_FEISHU_DOCUMENT_MAX_CONTENT_CHARS = 2_000_000;
```

and sanitize it with:

```ts
const safeMaxContentChars = readPositiveSafeInteger(
  maxContentChars,
  "Feishu document maxContentChars",
);
```

- [x] **Step 2: Enforce the max in raw content parsing**

Pass `safeMaxContentChars` into `readRawContent`. After trimming content, reject oversized text:

```ts
if (bodyText.length > maxContentChars) {
  throw new Error(`Feishu document raw content exceeds ${maxContentChars} characters`);
}
```

- [x] **Step 3: Extend env config**

Add `documentMaxContentChars: number` to `FeishuOpenApiConfig` and read:

```ts
documentMaxContentChars: readPositiveIntegerEnv(
  "IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS",
  env.IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS,
  2000000,
),
```

- [x] **Step 4: Pass config through document sync runtime**

Add `maxContentChars: feishuConfig.documentMaxContentChars` to the `createBodyFetcher` call.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- feishu-document-body-fetcher.test.ts env.test.ts document-sync-runtime.test.ts -t "content|Feishu OpenAPI|composes"
```

Expected: focused tests pass.

Observed: focused Feishu body fetcher, env config, and document sync runtime tests passed.

### Task 3: Docs, Verification, and Publication

**Files:**
- Modify: `docs/operations/internal-rollout-runbook.md`
- Create: `docs/superpowers/specs/2026-07-04-iris-feishu-document-content-size-bound-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-feishu-document-content-size-bound.md`

- [x] **Step 1: Document rollout env variable**

Add this line to the Feishu OpenAPI env block:

```powershell
$env:IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS="2000000"
```

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core 755 passed / 4 skipped, Python 7 passed, and
`docker compose config` succeeded.

- [x] **Step 3: Commit, push, and verify PR checks**

Commit the content-size bound update, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `05e9d16`, pushed to `codex/iris-document-source-registry`, updated PR #3, and
confirmed GitHub Actions Core and AI Worker checks passed.
