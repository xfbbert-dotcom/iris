# Iris Internal API Token Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/internal/*` bearer token handling accept only one clean credential when internal API auth is configured.

**Architecture:** Keep auth in `apps/core/src/app.ts` where the current `onRequest` hook already lives. Add narrowly scoped parser helpers beside `isInternalApiAuthorized()` and preserve all existing route behavior and response shapes.

**Tech Stack:** Fastify, TypeScript, Vitest, Node `crypto.timingSafeEqual`.

---

## File Structure

- Modify `apps/core/tests/answer-draft-api.test.ts` for focused internal token guard regression tests.
- Modify `apps/core/src/app.ts` for stricter configured-token normalization and request-header parsing.
- Update `docs/operations/internal-rollout-runbook.md` with the token character rule.

### Task 1: Regression Tests

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [ ] **Step 1: Write the failing tests**

Add two tests inside `describe("internal API token guard", ...)`:

```ts
it("rejects malformed bearer credentials for internal routes", async () => {
  const app = buildApp({
    internalApiToken: "operator-secret",
    createAnswerDraftRuntime: () => undefined,
    createEventWorkerRuntime: () => undefined,
    createDocumentSyncRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined,
  });

  const tabSeparatedResponse = await app.inject({
    method: "GET",
    url: "/internal/status",
    headers: { authorization: "Bearer\toperator-secret" },
  });
  const combinedCredentialResponse = await app.inject({
    method: "GET",
    url: "/internal/status",
    headers: { authorization: "Bearer operator-secret, Bearer other-secret" },
  });

  expect(tabSeparatedResponse.statusCode).toBe(401);
  expect(combinedCredentialResponse.statusCode).toBe(401);
});

it("rejects configured internal API tokens that cannot be sent as one bearer credential", () => {
  const invalidTokens = ["operator secret", "operator\tsecret", "operator,secret"];

  for (const internalApiToken of invalidTokens) {
    expect(() =>
      buildApp({
        internalApiToken,
        createAnswerDraftRuntime: () => undefined,
        createEventWorkerRuntime: () => undefined,
        createDocumentSyncRuntime: () => undefined,
        createReindexWorkerRuntime: () => undefined,
      }),
    ).toThrow("IRIS_INTERNAL_API_TOKEN must be a single bearer token");
  }
});
```

- [ ] **Step 2: Run RED**

Run: `npm --workspace apps/core test -- answer-draft-api.test.ts -t "internal API token guard"`

Expected: FAIL because the current parser accepts `Bearer\toperator-secret` and does not reject invalid configured tokens.

### Task 2: Minimal Implementation

**Files:**
- Modify: `apps/core/src/app.ts`

- [ ] **Step 1: Implement strict token helpers**

Import `timingSafeEqual` from `node:crypto`, reject configured tokens that include whitespace,
control characters, or commas, and require literal spaces in the request header:

```ts
function readInternalApiToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }
  if (!isSingleBearerToken(trimmed)) {
    throw new Error("IRIS_INTERNAL_API_TOKEN must be a single bearer token");
  }

  return trimmed;
}

function isInternalApiAuthorized(authorization: string | undefined, token: string): boolean {
  const match = /^Bearer +([!-~]+)$/i.exec(authorization ?? "");
  const presentedToken = match?.[1];
  if (presentedToken === undefined || !isSingleBearerToken(presentedToken)) {
    return false;
  }

  return safeTokenEqual(presentedToken, token);
}

function isSingleBearerToken(value: string): boolean {
  return /^[!-~]+$/u.test(value) && !value.includes(",");
}
```

- [ ] **Step 2: Run GREEN**

Run: `npm --workspace apps/core test -- answer-draft-api.test.ts -t "internal API token guard"`

Expected: PASS.

### Task 3: Runbook And Verification

**Files:**
- Modify: `docs/operations/internal-rollout-runbook.md`

- [ ] **Step 1: Document the token rule**

Add a short note under the existing bearer-token paragraph: `IRIS_INTERNAL_API_TOKEN` must be a
single visible ASCII token without spaces, tabs, line breaks, or commas.

- [ ] **Step 2: Run full verification**

Run: `npm run verify`

Expected: PASS for diff check, typecheck, Core tests, Python tests, and Docker Compose config.

- [ ] **Step 3: Commit and push**

Run:

```powershell
git add apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts docs/operations/internal-rollout-runbook.md docs/superpowers/specs/2026-07-04-iris-internal-api-token-hardening-design.md docs/superpowers/plans/2026-07-04-iris-internal-api-token-hardening.md
git commit -m "fix: harden internal api bearer token parsing"
git push
```

- [ ] **Step 4: Watch PR checks**

Run: `gh pr checks 3 --watch --interval 10`

Expected: Core and AI Worker checks pass.
