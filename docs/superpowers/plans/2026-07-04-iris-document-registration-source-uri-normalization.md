# Iris Document Registration Source URI Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize manually registered Feishu document source URIs by dropping query strings and
fragments before they reach the document sync runtime.

**Architecture:** Add one helper at the internal API boundary that first validates a source URI with
the existing Feishu document parsers and then returns `URL.href` after clearing `search` and `hash`.
Use it for both authorized wiki and user-submitted document registration requests.

**Tech Stack:** TypeScript, Vitest, Markdown.

---

### Task 1: Manual Source URI Normalization

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Write failing registration normalization tests**

Add tests proving:

- authorized wiki registration with `https://docs.feishu.cn/docx/doc_token_1?from=copy#heading`
  calls `runtime.registerAuthorizedWikiDocument()` with `https://docs.feishu.cn/docx/doc_token_1`;
- user-submitted registration with `https://docs.feishu.cn/docx/user_doc_token_1?open=1#top`
  calls `runtime.registerUserSubmittedDocument()` with
  `https://docs.feishu.cn/docx/user_doc_token_1`.

Expected before implementation: the runtime receives the full copied URL.

- [x] **Step 2: Run focused API tests and confirm RED**

Run:

```powershell
npm test --workspace apps/core -- answer-draft-api.test.ts
```

Expected: the new expectations fail because copied query strings/fragments are currently preserved.

- [x] **Step 3: Normalize accepted source URIs**

Add a helper that:

- returns `undefined` when `isSupportedFeishuDocumentSourceUri(sourceUri)` is false;
- parses the source URI with `new URL(sourceUri)`;
- clears `url.search` and `url.hash`;
- returns `url.href`.

Use the normalized value in both registration request parsers.

- [x] **Step 4: Run focused API tests and confirm GREEN**

Run:

```powershell
npm test --workspace apps/core -- answer-draft-api.test.ts
```

Expected: the command exits 0.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-03-iris-document-registration-api-url-gate-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-document-registration-source-uri-normalization.md`

- [x] **Step 1: Document manual source URI normalization**

Document that internal document registration APIs strip copied query strings and fragments before
registration.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the source URI normalization update, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions returns Core and AI Worker success.
