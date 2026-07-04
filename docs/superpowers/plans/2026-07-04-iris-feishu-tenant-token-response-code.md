# Iris Feishu Tenant Token Response Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent malformed HTTP 200 Feishu tenant token responses from being accepted or cached.

**Architecture:** Keep validation inside `apps/core/src/feishu/feishu-tenant-access-token-provider.ts`. Tighten `readTenantAccessToken()` so it requires a numeric `code` before reading `tenant_access_token`.

**Tech Stack:** TypeScript, Vitest, Feishu OpenAPI token adapter.

---

## File Structure

- Modify `apps/core/tests/feishu-tenant-access-token-provider.test.ts` with failing malformed-response tests.
- Modify `apps/core/src/feishu/feishu-tenant-access-token-provider.ts` with minimal code validation.

### Task 1: Regression Tests

**Files:**
- Modify: `apps/core/tests/feishu-tenant-access-token-provider.test.ts`

- [ ] **Step 1: Write failing tests**

Add a test inside `describe("FeishuTenantAccessTokenProvider", ...)`:

```ts
it("throws when successful token responses omit or mistype the Feishu code", async () => {
  for (const body of [
    { tenant_access_token: "tenant-token", expire: 7200 },
    { code: "0", tenant_access_token: "tenant-token", expire: 7200 },
  ]) {
    const provider = createFeishuTenantAccessTokenProvider({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
      fetch: vi.fn(async () => jsonResponse(body)),
    });

    await expect(provider.getTenantAccessToken()).rejects.toThrow(
      "Feishu tenant access token response did not include code",
    );
  }
});
```

- [ ] **Step 2: Run RED**

Run: `npm --workspace apps/core test -- feishu-tenant-access-token-provider.test.ts`

Expected: FAIL because the current provider accepts the missing-code response.

### Task 2: Minimal Implementation

**Files:**
- Modify: `apps/core/src/feishu/feishu-tenant-access-token-provider.ts`

- [ ] **Step 1: Require numeric code before reading tenant token**

Update `readTenantAccessToken()`:

```ts
const code = responseBody.code;
if (typeof code !== "number") {
  throw new Error("Feishu tenant access token response did not include code");
}
if (code !== 0) {
  throw new Error(`Feishu tenant access token request failed: ${readErrorMessage(responseBody)}`);
}
```

- [ ] **Step 2: Run GREEN**

Run: `npm --workspace apps/core test -- feishu-tenant-access-token-provider.test.ts`

Expected: PASS.

### Task 3: Verification And PR

- [ ] **Step 1: Run full verification**

Run: `npm run verify`

Expected: PASS for diff check, typecheck, Core tests, Python tests, and Docker Compose config.

- [ ] **Step 2: Commit and push**

Run:

```powershell
git add apps/core/src/feishu/feishu-tenant-access-token-provider.ts apps/core/tests/feishu-tenant-access-token-provider.test.ts docs/superpowers/specs/2026-07-04-iris-feishu-tenant-token-response-code-design.md docs/superpowers/plans/2026-07-04-iris-feishu-tenant-token-response-code.md
git commit -m "fix: require feishu tenant token response codes"
git push
```

- [ ] **Step 3: Watch PR checks**

Run: `gh pr checks 3 --watch --interval 10`

Expected: Core and AI Worker checks pass.
