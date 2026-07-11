# Iris Feishu Document Body Fetcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first Feishu-backed `DocumentBodyFetcher` for docx-style document raw content.

**Architecture:** Add a token provider, URL token parser, and fetcher module. Keep all HTTP behavior injectable and keep runtime wiring out of this phase.

**Tech Stack:** TypeScript, Vitest, global Fetch-compatible types, existing `DocumentBodyFetcher` interface.

---

## File Structure

- Create `apps/core/src/feishu/feishu-tenant-access-token-provider.ts`
  - Fetches and caches tenant access tokens.
- Create `apps/core/tests/feishu-tenant-access-token-provider.test.ts`
  - Covers request shape, caching, invalid response, and HTTP failures.
- Create `apps/core/src/documents/feishu-document-body-fetcher.ts`
  - Extracts docx/docs tokens and fetches raw content.
- Create `apps/core/tests/feishu-document-body-fetcher.test.ts`
  - Covers token extraction, success, unsupported URL/source, API errors, invalid JSON, and empty content.

## Task 1: Feishu Tenant Access Token Provider

**Files:**
- Create: `apps/core/src/feishu/feishu-tenant-access-token-provider.ts`
- Test: `apps/core/tests/feishu-tenant-access-token-provider.test.ts`

- [ ] **Step 1: Write failing token provider tests**

Tests should assert:

- provider POSTs app credentials to `/open-apis/auth/v3/tenant_access_token/internal`;
- returns `tenant_access_token`;
- caches token before expiry;
- refetches after expiry;
- throws on non-ok HTTP status, non-zero Feishu code, invalid JSON, and missing token.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- feishu-tenant-access-token-provider.test.ts`

Expected: FAIL because the provider file does not exist.

- [ ] **Step 3: Implement token provider**

Expose:

```ts
export type FeishuTenantAccessTokenProvider = {
  getTenantAccessToken(): Promise<string>;
};
export function createFeishuTenantAccessTokenProvider(deps): FeishuTenantAccessTokenProvider;
```

Use `fetch`, `baseUrl`, `appId`, `appSecret`, and `now`. Cache until `now + expireSeconds * 1000 - 60_000`.

- [ ] **Step 4: Run token provider tests**

Run: `npm test -- feishu-tenant-access-token-provider.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/feishu/feishu-tenant-access-token-provider.ts apps/core/tests/feishu-tenant-access-token-provider.test.ts
git commit -m "feat: add Feishu tenant token provider"
```

## Task 2: Feishu Document Body Fetcher

**Files:**
- Create: `apps/core/src/documents/feishu-document-body-fetcher.ts`
- Test: `apps/core/tests/feishu-document-body-fetcher.test.ts`

- [ ] **Step 1: Write failing fetcher tests**

Tests should assert:

- `/docx/<id>` and `/docs/<id>` tokens are extracted;
- raw content endpoint is called with tenant token;
- successful content returns `DocumentBodyFetchResult`;
- unsupported source type and unsupported URL shape throw;
- non-ok HTTP, non-zero Feishu code, invalid JSON, and empty content throw.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- feishu-document-body-fetcher.test.ts`

Expected: FAIL because the fetcher file does not exist.

- [ ] **Step 3: Implement fetcher**

Expose:

```ts
export function parseFeishuDocxDocumentId(sourceUri: string): string | undefined;
export function createFeishuDocumentBodyFetcher(deps): DocumentBodyFetcher;
```

Only support `group_visible_document` and `authorized_wiki_document` when URL shape is docx/docs. Call:

```text
GET /open-apis/docx/v1/documents/{documentId}/raw_content
```

Read `data.content` as non-blank string.

- [ ] **Step 4: Run fetcher tests**

Run: `npm test -- feishu-document-body-fetcher.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/documents/feishu-document-body-fetcher.ts apps/core/tests/feishu-document-body-fetcher.test.ts
git commit -m "feat: add Feishu document body fetcher"
```

## Task 3: Full Verification And PR Update

- [ ] **Step 1: Run TypeScript typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 2: Run TypeScript tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Run Python worker tests**

Run: `python -m pytest` from `workers/ai`

Expected: all tests pass.

- [ ] **Step 4: Run Docker Compose validation**

Run: `docker compose config`

Expected: exit 0.

- [ ] **Step 5: Push and update PR**

```bash
git push origin codex/iris-document-source-registry
gh pr edit 3 --repo xfbbert-dotcom/iris --body "<updated body with Phase 2Z summary>"
```

Expected: PR #3 contains Phase 2Z summary and checked test plan.

## Self-Review

- Spec coverage: token provider, fetcher, token parsing, error handling, and deferred runtime wiring are covered.
- Placeholder scan: no incomplete placeholder markers are present.
- Type consistency: `FeishuTenantAccessTokenProvider`, `createFeishuDocumentBodyFetcher`, `parseFeishuDocxDocumentId`, and `DocumentBodyFetcher` names are consistent across tasks.
