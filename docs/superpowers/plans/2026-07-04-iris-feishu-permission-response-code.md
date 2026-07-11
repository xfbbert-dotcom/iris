# Iris Feishu Permission Response Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent malformed HTTP 200 Feishu permission responses from being treated as readable documents.

**Architecture:** Keep the change inside `apps/core/src/permissions/feishu-document-permission-checker.ts`. Tighten the shared success-response helper so both direct document metadata checks and wiki-node resolution require an explicit numeric Feishu `code`.

**Tech Stack:** TypeScript, Vitest, Fastify-adjacent Core runtime.

---

## File Structure

- Modify `apps/core/tests/feishu-document-permission-checker.test.ts` with failing regression tests.
- Modify `apps/core/src/permissions/feishu-document-permission-checker.ts` with the minimal response-code guard.

### Task 1: Regression Tests

**Files:**
- Modify: `apps/core/tests/feishu-document-permission-checker.test.ts`

- [x] **Step 1: Write failing tests**

Add tests inside `describe("createFeishuDocumentPermissionChecker", ...)`:

```ts
it("throws when successful document metadata responses omit the Feishu code", async () => {
  const checker = createFeishuDocumentPermissionChecker({
    baseUrl: "https://open.feishu.cn",
    tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
    fetch: vi.fn(async () => jsonResponse({ data: { document: { title: "Spec" } } })),
  });

  await expect(
    checker.canReadSource(source({ sourceUri: "https://example.feishu.cn/docx/doccnMalformed" })),
  ).rejects.toThrow("Feishu document permission response did not include code");
});

it("throws before metadata checks when successful wiki node responses omit the Feishu code", async () => {
  const fetch = vi.fn(async () =>
    jsonResponse({
      data: { node: { obj_type: "docx", obj_token: "doccnWikiDocument" } },
    }),
  );
  const checker = createFeishuDocumentPermissionChecker({
    baseUrl: "https://open.feishu.cn",
    tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
    fetch,
  });

  await expect(
    checker.canReadSource(source({ sourceUri: "https://example.feishu.cn/wiki/wikcnNode" })),
  ).rejects.toThrow("Feishu document permission response did not include code");
  expect(fetch).toHaveBeenCalledTimes(1);
});
```

- [x] **Step 2: Run RED**

Run: `npm --workspace apps/core test -- feishu-document-permission-checker.test.ts`

Expected: FAIL because the direct malformed response currently resolves `true`, and the malformed
wiki response currently proceeds to the metadata path.

Observed: FAIL. Both malformed HTTP 200 responses resolved `true` instead of rejecting.

### Task 2: Minimal Implementation

**Files:**
- Modify: `apps/core/src/permissions/feishu-document-permission-checker.ts`

- [x] **Step 1: Require numeric Feishu code for successful HTTP responses**

Update `isSuccessfulFeishuResponse()`:

```ts
function isSuccessfulFeishuResponse(response: Response, responseBody: unknown): boolean {
  if (!response.ok) {
    return false;
  }
  if (!isRecord(responseBody) || typeof responseBody.code !== "number") {
    throw new Error("Feishu document permission response did not include code");
  }

  return responseBody.code === 0;
}
```

- [x] **Step 2: Run GREEN**

Run: `npm --workspace apps/core test -- feishu-document-permission-checker.test.ts`

Expected: PASS.

Observed: PASS with 8 permission checker tests passing.

### Task 3: Verification And PR

- [x] **Step 1: Run full verification**

Run: `npm run verify`

Expected: PASS for diff check, typecheck, Core tests, Python tests, and Docker Compose config.

Observed: PASS. Core reported 727 passing tests and 4 skipped tests. Python worker tests reported
7 passing tests. Docker Compose config rendered successfully.

- [x] **Step 2: Commit and push**

Run:

```powershell
git add apps/core/src/permissions/feishu-document-permission-checker.ts apps/core/tests/feishu-document-permission-checker.test.ts docs/superpowers/specs/2026-07-04-iris-feishu-permission-response-code-design.md docs/superpowers/plans/2026-07-04-iris-feishu-permission-response-code.md
git commit -m "fix: require feishu permission response codes"
git push
```

- [x] **Step 3: Watch PR checks**

Run: `gh pr checks 3 --watch --interval 10`

Expected: Core and AI Worker checks pass.

Observed: PASS. GitHub Actions reported Core and AI Worker success for PR #3.
