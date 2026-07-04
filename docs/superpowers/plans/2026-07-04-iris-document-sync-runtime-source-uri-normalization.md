# Iris Document Sync Runtime Source URI Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure direct document sync runtime registration calls cannot bypass Feishu source URI
normalization.

**Architecture:** Normalize and validate source URIs inside
`DocumentSyncRuntime.registerAuthorizedWikiDocument()` and
`DocumentSyncRuntime.registerUserSubmittedDocument()` before calling the document source registry.
Reuse the Feishu path parsers so unsupported or credential-bearing URIs are rejected consistently
with the HTTP API boundary.

**Tech Stack:** TypeScript, Vitest, Markdown.

---

### Task 1: Runtime Source URI Normalization

**Files:**
- Modify: `apps/core/tests/document-sync-runtime.test.ts`
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`

- [x] **Step 1: Write failing runtime normalization tests**

Update runtime registration calls in `document-sync-runtime.test.ts` so:

- authorized wiki registration passes `https://docs.feishu.cn/docx/doc_token_1?from=copy#heading`;
- user-submitted registration passes `https://docs.feishu.cn/docx/user_doc_token_1?open=1#top`;
- registry calls are still expected to receive path-only canonical source URIs.

Expected before implementation: the registry receives the full copied URLs.

- [x] **Step 2: Run focused runtime tests and confirm RED**

Run:

```powershell
npm test --workspace apps/core -- document-sync-runtime.test.ts
```

Expected: the updated source URI expectations fail.

- [x] **Step 3: Normalize source URIs in runtime registration**

Add a runtime helper that:

- validates with `parseFeishuDocxDocumentId()` or `parseFeishuWikiNodeToken()`;
- parses the URL;
- clears `search` and `hash`;
- returns the canonical `href`;
- throws `unsupported Feishu document source URI` when validation fails.

Use it before registry writes for both runtime registration methods.

- [x] **Step 4: Run focused runtime tests and confirm GREEN**

Run:

```powershell
npm test --workspace apps/core -- document-sync-runtime.test.ts
```

Expected: the command exits 0.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-03-iris-document-registration-api-url-gate-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-document-sync-runtime-source-uri-normalization.md`

- [x] **Step 1: Document runtime-level source URI normalization**

Document that direct document sync runtime registration also normalizes copied Feishu source URIs.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the runtime normalization update, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions returns Core and AI Worker success.
