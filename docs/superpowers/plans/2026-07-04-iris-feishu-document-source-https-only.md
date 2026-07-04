# Iris Feishu Document Source HTTPS-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every shared Feishu document source parsing path rejects non-HTTPS document URLs.

**Architecture:** Add protocol validation to the shared Feishu document path parser used by body
fetching, live permission checks, internal registration APIs, and document sync runtime registration.
This keeps one source of truth and avoids duplicating scheme checks across callers.

**Tech Stack:** TypeScript, Vitest, Markdown.

---

### Task 1: Failing HTTPS-Only Coverage

**Files:**
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `apps/core/tests/document-sync-runtime.test.ts`
- Modify: `apps/core/tests/feishu-document-permission-checker.test.ts`

- [x] **Step 1: Add failing parser and caller tests**

Add tests that prove:

- docx/docs parser rejects `http://docs.feishu.cn/docx/...`;
- wiki parser rejects `http://example.feishu.cn/wiki/...`;
- internal authorized wiki registration rejects HTTP source URIs before runtime calls;
- direct document sync runtime registration rejects HTTP source URIs before registry writes;
- live permission checks treat HTTP source URIs as unsupported before tenant-token requests.

- [x] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
npm test --workspace apps/core -- feishu-document-body-fetcher.test.ts answer-draft-api.test.ts document-sync-runtime.test.ts feishu-document-permission-checker.test.ts
```

Expected: the new HTTPS-only expectations fail before implementation.

### Task 2: Parser Guard And Verification

**Files:**
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`
- Modify: `docs/superpowers/specs/2026-07-04-iris-feishu-document-source-https-only-design.md`
- Modify: `docs/superpowers/plans/2026-07-04-iris-feishu-document-source-https-only.md`

- [x] **Step 1: Enforce HTTPS in shared parser**

Reject parsed URLs whose `protocol` is not `https:` before host/path/token checks.

- [x] **Step 2: Run focused tests and confirm GREEN**

Run the same focused test command and confirm it exits 0.

- [x] **Step 3: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [x] **Step 4: Commit, push, and verify PR checks**

Commit the HTTPS-only source URI parser update, push `codex/iris-document-source-registry`,
update PR #3, and confirm GitHub Actions returns Core and AI Worker success.
