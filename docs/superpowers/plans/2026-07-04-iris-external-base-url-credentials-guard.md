# Iris External Base URL Credentials Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject embedded username/password credentials in external provider base URLs.

**Architecture:** Extend the existing `readHttpBaseUrlEnv()` helper so all external HTTP base URLs
share the same credential-free invariant. Authentication continues to live in dedicated env fields
such as `IRIS_MODEL_API_KEY`, `IRIS_EMBEDDING_API_KEY`, and `FEISHU_APP_SECRET`.

**Tech Stack:** TypeScript, Vitest, Markdown.

---

### Task 1: Embedded Credential Rejection

**Files:**
- Modify: `apps/core/tests/env.test.ts`
- Modify: `apps/core/src/config/env.ts`

- [x] **Step 1: Write failing credential tests**

Add env tests that reject:

- `IRIS_MODEL_BASE_URL=https://user:pass@api.example.com/v1`
- `IRIS_EMBEDDING_BASE_URL=https://user@api.example.com/v1`
- `FEISHU_OPEN_BASE_URL=https://app:secret@open.feishu.cn`

Expected before implementation: these values are accepted.

- [x] **Step 2: Run focused env tests and confirm RED**

Run:

```powershell
npm test --workspace apps/core -- env.test.ts
```

Expected: the new credential assertions fail because the helper has not rejected URL userinfo yet.

- [x] **Step 3: Tighten the shared helper**

Update `readHttpBaseUrlEnv()` to reject non-empty `parsed.username` or `parsed.password` with:

```typescript
throw new Error(`${name} must not include embedded credentials`);
```

- [x] **Step 4: Run focused env tests and confirm GREEN**

Run:

```powershell
npm test --workspace apps/core -- env.test.ts
```

Expected: the command exits 0.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/operations/internal-rollout-runbook.md`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: `docs/superpowers/specs/2026-07-04-iris-external-base-url-config-validation-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-external-base-url-credentials-guard.md`

- [x] **Step 1: Document the credential-free base URL rule**

Document that external base URLs must not include embedded credentials.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the embedded credential guard update, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions returns Core and AI Worker success.
