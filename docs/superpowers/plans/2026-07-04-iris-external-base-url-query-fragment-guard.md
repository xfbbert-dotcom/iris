# Iris External Base URL Query Fragment Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject query strings and fragments in external provider base URLs.

**Architecture:** Tighten `readHttpBaseUrlEnv()` so it accepts only absolute HTTP(S) base URLs that
do not include `search` or `hash`. Keep endpoint paths owned by the provider/fetcher adapters.

**Tech Stack:** TypeScript, Vitest, Markdown.

---

### Task 1: Query And Fragment Rejection

**Files:**
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/tests/env.test.ts`

- [x] **Step 1: Write failing query/fragment tests**

Add env tests that reject:

- `IRIS_MODEL_BASE_URL=https://api.example.com/v1?tenant=a`
- `IRIS_EMBEDDING_BASE_URL=https://api.example.com/v1#fragment`
- `FEISHU_OPEN_BASE_URL=https://open.feishu.cn?tenant=a`

Expected before implementation: these values are accepted.

- [x] **Step 2: Tighten the shared helper**

Update `readHttpBaseUrlEnv()` to parse first, check protocol second, and then reject non-empty
`parsed.search` or `parsed.hash` with `<NAME> must not include query or fragment`.

- [x] **Step 3: Run focused tests**

Run:

```powershell
npm test --workspace apps/core -- env.test.ts
npm test --workspace apps/core -- openai-compatible-model-provider.test.ts openai-compatible-embedding-provider.test.ts feishu-document-body-fetcher.test.ts feishu-document-permission-checker.test.ts
```

Expected: both commands exit 0.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/operations/internal-rollout-runbook.md`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: `docs/superpowers/specs/2026-07-04-iris-external-base-url-config-validation-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-external-base-url-query-fragment-guard.md`

- [x] **Step 1: Document the stricter base URL rule**

Document that external base URLs must not include query strings or fragments.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [x] **Step 3: Commit, push, and verify PR checks**

Commit the query/fragment guard update, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions returns Core and AI Worker success.
