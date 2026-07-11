# Iris External Base URL Config Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate model, embedding, and Feishu OpenAPI base URLs at config-read time.

**Architecture:** Add a shared `readHttpBaseUrlEnv()` helper in `apps/core/src/config/env.ts` and
use it for external provider base URLs. Keep existing required-env and trailing-slash behavior.

**Tech Stack:** TypeScript, Vitest, Markdown.

---

### Task 1: Config Validation

**Files:**
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/tests/env.test.ts`

- [x] **Step 1: Write failing config tests**

Add tests that reject malformed and non-HTTP(S) values for:

- `IRIS_MODEL_BASE_URL`
- `IRIS_EMBEDDING_BASE_URL`
- `FEISHU_OPEN_BASE_URL`

Expected before implementation: the malformed values are accepted.

- [x] **Step 2: Add shared URL helper**

Implement `readHttpBaseUrlEnv(name, value)` using the existing required-env path, `new URL()`,
`http:`/`https:` protocol checks, and `trimTrailingSlash()`.

- [x] **Step 3: Wire the helper into config readers**

Use the helper in `readModelProviderConfig()`, `readEmbeddingProviderConfig()`, and
`readFeishuOpenApiConfig()`.

- [x] **Step 4: Run focused tests**

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
- Create: `docs/superpowers/specs/2026-07-04-iris-external-base-url-config-validation-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-external-base-url-config-validation.md`

- [x] **Step 1: Document the config guardrail**

Document that external base URLs must be absolute HTTP(S) URLs and that Iris rejects invalid values
during configuration loading.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [x] **Step 3: Commit, push, and verify PR checks**

Commit the config validation update, push `codex/iris-document-source-registry`, update PR #3, and
confirm GitHub Actions returns Core and AI Worker success.
