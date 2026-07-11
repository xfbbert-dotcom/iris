# Iris Feishu Link Credentials Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Feishu document discovery from storing URLs with embedded username/password
credentials as document source URIs.

**Architecture:** Extend `FeishuDocumentLinkExtractor` normalization. After parsing a supported
candidate URL and before stripping query strings/fragments, reject any URL whose `username` or
`password` field is non-empty. Normal Feishu/Lark document links keep the same behavior.

**Tech Stack:** TypeScript, Vitest, Markdown.

---

### Task 1: Credential-Bearing Link Rejection

**Files:**
- Modify: `apps/core/tests/feishu-document-link-extractor.test.ts`
- Modify: `apps/core/src/documents/feishu-document-link-extractor.ts`

- [x] **Step 1: Write the failing embedded-credential test**

Add a test where the message contains:

```text
https://user:pass@foo.feishu.cn/docx/token
```

Expected before implementation: the extractor emits that URL as a document link.

- [x] **Step 2: Run focused extractor tests and confirm RED**

Run:

```powershell
npm test --workspace apps/core -- feishu-document-link-extractor.test.ts
```

Expected: the new assertion fails because embedded URL credentials are currently accepted.

- [x] **Step 3: Reject URL userinfo**

In `normalizeCandidateUrl()`, return `undefined` when `url.username` or `url.password` is non-empty.

- [x] **Step 4: Run focused extractor tests and confirm GREEN**

Run:

```powershell
npm test --workspace apps/core -- feishu-document-link-extractor.test.ts
```

Expected: the command exits 0.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-03-iris-feishu-link-query-fragment-normalization-design.md`
- Modify: `docs/superpowers/specs/2026-07-03-iris-feishu-link-extractor-single-source-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-feishu-link-credentials-guard.md`

- [x] **Step 1: Document credential-bearing link rejection**

Document that document links with embedded credentials are ignored rather than normalized into
`sourceUri`.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [x] **Step 3: Commit, push, and verify PR checks**

Commit the link credential guard update, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions returns Core and AI Worker success.
