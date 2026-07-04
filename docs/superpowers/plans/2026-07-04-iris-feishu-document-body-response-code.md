# Iris Feishu Document Body Response Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent malformed HTTP 200 Feishu document body responses from being synced into Iris snapshots.

**Architecture:** Keep response validation inside `apps/core/src/documents/feishu-document-body-fetcher.ts`. Tighten the existing `readWikiDocumentId()` and `readRawContent()` readers so each requires a numeric Feishu `code` before trusting payload fields.

**Tech Stack:** TypeScript, Vitest, Feishu OpenAPI adapters.

---

## File Structure

- Modify `apps/core/tests/feishu-document-body-fetcher.test.ts` with failing malformed-response tests.
- Modify `apps/core/src/documents/feishu-document-body-fetcher.ts` with minimal code checks.

### Task 1: Regression Tests

**Files:**
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests inside `describe("FeishuDocumentBodyFetcher", ...)`:

```ts
it("throws when raw content responses omit the Feishu code", async () => {
  const fetcher = createFeishuDocumentBodyFetcher({
    baseUrl: "https://open.feishu.cn",
    tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
    fetch: vi.fn(async () => jsonResponse({ data: { content: "Doc body" } })),
  });

  await expect(fetcher.fetch(source())).rejects.toThrow(
    "Feishu document raw content response did not include code",
  );
});

it("throws before raw content fetches when wiki node responses omit the Feishu code", async () => {
  const fetch = vi.fn(async () =>
    jsonResponse({
      data: { node: { obj_token: "doc_token_from_wiki", obj_type: "docx" } },
    }),
  );
  const fetcher = createFeishuDocumentBodyFetcher({
    baseUrl: "https://open.feishu.cn",
    tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
    fetch,
  });

  await expect(
    fetcher.fetch(
      source({
        sourceType: "authorized_wiki_document",
        sourceUri: "https://acme.feishu.cn/wiki/wiki_token_1",
        originGroupId: undefined,
        originMessageId: undefined,
        authorizedSpaceId: "space-1",
      }),
    ),
  ).rejects.toThrow("Feishu wiki node response did not include code");
  expect(fetch).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run RED**

Run: `npm --workspace apps/core test -- feishu-document-body-fetcher.test.ts`

Expected: FAIL because the current fetcher accepts missing-code responses when content/node fields
are present.

### Task 2: Minimal Implementation

**Files:**
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`

- [ ] **Step 1: Require numeric code in both successful response readers**

In `readWikiDocumentId()`:

```ts
const code = responseBody.code;
if (typeof code !== "number") {
  throw new Error("Feishu wiki node response did not include code");
}
if (code !== 0) {
  throw new Error(`Feishu wiki node request failed: ${readErrorMessage(responseBody)}`);
}
```

In `readRawContent()`:

```ts
const code = responseBody.code;
if (typeof code !== "number") {
  throw new Error("Feishu document raw content response did not include code");
}
if (code !== 0) {
  throw new Error(`Feishu document raw content request failed: ${readErrorMessage(responseBody)}`);
}
```

- [ ] **Step 2: Run GREEN**

Run: `npm --workspace apps/core test -- feishu-document-body-fetcher.test.ts`

Expected: PASS.

### Task 3: Verification And PR

- [ ] **Step 1: Run full verification**

Run: `npm run verify`

Expected: PASS for diff check, typecheck, Core tests, Python tests, and Docker Compose config.

- [ ] **Step 2: Commit and push**

Run:

```powershell
git add apps/core/src/documents/feishu-document-body-fetcher.ts apps/core/tests/feishu-document-body-fetcher.test.ts docs/superpowers/specs/2026-07-04-iris-feishu-document-body-response-code-design.md docs/superpowers/plans/2026-07-04-iris-feishu-document-body-response-code.md
git commit -m "fix: require feishu document body response codes"
git push
```

- [ ] **Step 3: Watch PR checks**

Run: `gh pr checks 3 --watch --interval 10`

Expected: Core and AI Worker checks pass.
