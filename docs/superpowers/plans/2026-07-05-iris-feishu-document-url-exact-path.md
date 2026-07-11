# Iris Feishu Document URL Exact Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject Feishu docx/docs/wiki source URLs that contain extra path segments after the document token or percent-encoded separators inside the token segment.

**Architecture:** The existing `parseFeishuDocxDocumentId()` and `parseFeishuWikiNodeToken()` functions remain the canonical guard. Group chat extraction and internal registration already call this parser, so tightening it protects every entry point consistently. Token segments reject percent-encoded content because Feishu document tokens are expected as raw path tokens, not encoded subpaths.

**Tech Stack:** TypeScript, Vitest, Fastify core app.

---

### Task 1: Add URL Shape Regression Tests

**Files:**
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`
- Modify: `apps/core/tests/feishu-document-link-extractor.test.ts`

- [x] **Step 1: Add failing parser tests**

Add expectations that docx/docs/wiki URLs with extra path segments return `undefined`.

- [x] **Step 2: Add failing extraction test**

Add a group-message extraction assertion that ignores an extra-path Feishu link while still extracting a later valid link.

- [x] **Step 3: Run focused tests and confirm red**

Run: `npm --workspace apps/core run test -- tests/feishu-document-body-fetcher.test.ts tests/feishu-document-link-extractor.test.ts`

Expected: fails because the parser currently accepts the first token segment and ignores extra path segments.

- [x] **Step 4: Add encoded separator regression tests**

Add parser, extractor, and internal registration assertions for `%2F` and `%5C` inside document token
segments. Expected: fails until the shared token parser rejects encoded token contamination.

### Task 2: Tighten Shared Feishu URL Parser

**Files:**
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`

- [x] **Step 1: Require exact supported path shape**

In `parseFeishuPathToken()`, reject URLs unless the path has exactly two non-empty segments.

- [x] **Step 2: Reject encoded token contamination**

Reject `%` inside the token segment so percent-encoded commas, slashes, backslashes, and double-encoded
separator attempts cannot bypass exact path validation.

- [x] **Step 3: Run focused tests and confirm green**

Run: `npm --workspace apps/core run test -- tests/feishu-document-body-fetcher.test.ts tests/feishu-document-link-extractor.test.ts`

Expected: all focused tests pass.

- [x] **Step 4: Run full verification**

Run: `npm run verify`

Expected: core tests, Python worker tests, and Docker Compose validation pass.

### Task 3: Canonicalize Trailing Slashes

**Files:**
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`
- Modify: `apps/core/src/documents/feishu-document-link-extractor.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`
- Modify: `apps/core/tests/feishu-document-link-extractor.test.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `apps/core/tests/document-sync-runtime.test.ts`

- [x] **Step 1: Write failing trailing-slash normalization tests**

Extend group link extraction and internal registration tests so copied URLs such as
`https://docs.feishu.cn/docx/token/?from=copy#heading` normalize to
`https://docs.feishu.cn/docx/token`.

- [x] **Step 2: Run focused tests and confirm red**

Run: `npm --workspace apps/core run test -- tests/feishu-document-link-extractor.test.ts tests/answer-draft-api.test.ts`

Expected: fails because canonicalized source URIs still contain the trailing slash.

- [x] **Step 3: Share Feishu document URL canonicalization**

Export `normalizeFeishuDocumentSourceUri()` from the Feishu document body fetcher and reuse it in
group link extraction, internal API registration parsing, and direct document sync runtime
registration.

- [x] **Step 4: Run focused tests and confirm green**

Run: `npm --workspace apps/core run test -- tests/feishu-document-link-extractor.test.ts tests/answer-draft-api.test.ts`

Expected: all focused tests pass.

- [x] **Step 5: Run direct runtime focused test and confirm green**

Run: `npm --workspace apps/core run test -- tests/document-sync-runtime.test.ts`

Expected: the runtime passes normalized source URIs without query strings, fragments, or trailing
slashes into the registry.
