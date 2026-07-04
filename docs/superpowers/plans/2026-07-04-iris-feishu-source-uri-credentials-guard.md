# Iris Feishu Source URI Credentials Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject embedded username/password credentials in manually registered or fetched Feishu
document source URIs.

**Architecture:** Tighten the shared Feishu path-token parser used by
`parseFeishuDocxDocumentId()` and `parseFeishuWikiNodeToken()`. Because internal document
registration APIs call those helpers, one parser-level guard keeps automatic discovery, manual
registration, and body fetch validation aligned.

**Tech Stack:** TypeScript, Vitest, Markdown.

---

### Task 1: Source URI Credential Rejection

**Files:**
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`

- [x] **Step 1: Write failing parser and API tests**

Add tests that reject:

- `parseFeishuDocxDocumentId("https://user:pass@docs.feishu.cn/docx/doc_token_1")`
- `parseFeishuWikiNodeToken("https://user@acme.feishu.cn/wiki/wiki_token_1")`
- `POST /internal/document-sync/authorized-wiki-documents` with a credential-bearing `sourceUri`

Expected before implementation: the parser returns tokens and the API accepts the URL.

- [x] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
npm test --workspace apps/core -- feishu-document-body-fetcher.test.ts answer-draft-api.test.ts
```

Expected: the new assertions fail because URL userinfo is currently accepted.

- [x] **Step 3: Reject URL userinfo in the shared parser**

In `parseFeishuPathToken()`, return `undefined` when `url.username` or `url.password` is non-empty.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm test --workspace apps/core -- feishu-document-body-fetcher.test.ts answer-draft-api.test.ts
```

Expected: the command exits 0.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-03-iris-feishu-body-fetch-host-guard-design.md`
- Modify: `docs/superpowers/specs/2026-07-03-iris-document-registration-api-url-gate-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-feishu-source-uri-credentials-guard.md`

- [x] **Step 1: Document source URI credential rejection**

Document that manually registered/fetched Feishu source URIs must not include embedded credentials.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the source URI credential guard update, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions returns Core and AI Worker success.
