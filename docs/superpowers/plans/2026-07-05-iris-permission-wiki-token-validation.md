# Iris Permission Wiki Token Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Feishu live permission checks reject contaminated wiki-resolved document tokens before metadata checks.

**Architecture:** Keep the existing `FeishuDocumentPermissionChecker` API unchanged. Add local resolved-token validation that matches the document body fetcher's comma/percent rejection semantics, then cover the fail-closed behavior with a focused unit test.

**Tech Stack:** TypeScript, Vitest, existing Feishu permission checker and document token constants.

---

### Task 1: Permission Checker Wiki Token Validation

**Files:**
- Modify: `apps/core/tests/feishu-document-permission-checker.test.ts`
- Modify: `apps/core/src/permissions/feishu-document-permission-checker.ts`

- [x] **Step 1: Write the failing test**

Add this test to `apps/core/tests/feishu-document-permission-checker.test.ts` near the existing wiki node token validation cases:

```ts
  it("returns false for contaminated wiki node document tokens before metadata checks", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { node: { obj_type: "docx", obj_token: "doccnWiki%2Fcontaminated" } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { document: { title: "Should not read" } } }));
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await expect(
      checker.canReadSource(source({ sourceUri: "https://example.feishu.cn/wiki/wiki-node" })),
    ).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
```

- [x] **Step 2: Run the focused test to verify RED**

Run:

```powershell
npm --workspace @iris/core exec vitest run tests/feishu-document-permission-checker.test.ts -t "contaminated wiki node document tokens"
```

Expected: FAIL because the checker performs the metadata request and returns `true`.

- [x] **Step 3: Implement minimal validation**

In `apps/core/src/permissions/feishu-document-permission-checker.ts`, add a local invalid-token
pattern and use it in `readWikiDocumentId`:

```ts
const invalidFeishuDocumentTokenPattern = /,|%/u;
```

Then replace the current return condition with:

```ts
return documentToken.length > 0 &&
  documentToken.length <= MAX_FEISHU_DOCUMENT_TOKEN_CHARS &&
  !invalidFeishuDocumentTokenPattern.test(documentToken)
  ? documentToken
  : undefined;
```

- [x] **Step 4: Run focused and related tests to verify GREEN**

Run:

```powershell
npm --workspace @iris/core exec vitest run tests/feishu-document-permission-checker.test.ts
npm --workspace @iris/core exec vitest run tests/permission-guard.test.ts tests/document-retrieval-context.test.ts tests/answer-draft-runtime.test.ts
```

Expected: all selected tests pass.

- [x] **Step 5: Run full verification**

Run:

```powershell
$log = Join-Path $env:TEMP 'iris-verify-permission-wiki-token.log'; npm run verify *> $log; $code = $LASTEXITCODE; Get-Content $log -Tail 120; exit $code
```

Expected: exit code 0 with Core, Python worker, and Docker Compose config checks passing.

- [x] **Step 6: Commit and push**

Run:

```powershell
git status --short
git add docs/superpowers/specs/2026-07-05-iris-permission-wiki-token-validation-design.md docs/superpowers/plans/2026-07-05-iris-permission-wiki-token-validation.md apps/core/src/permissions/feishu-document-permission-checker.ts apps/core/tests/feishu-document-permission-checker.test.ts
git commit -m "fix: reject contaminated wiki permission tokens"
git push
```

Expected: branch `codex/iris-document-source-registry` is pushed with the new commit.
