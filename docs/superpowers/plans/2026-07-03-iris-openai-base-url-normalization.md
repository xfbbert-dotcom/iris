# Iris OpenAI-Compatible Base URL Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid double-slash OpenAI-compatible model and embedding endpoints when operators configure base URLs with trailing slashes.

**Architecture:** Strip trailing slashes from provider `baseUrl` before appending fixed endpoint paths.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Provider Endpoint Normalization

**Files:**
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts`
- Modify: `apps/core/tests/openai-compatible-embedding-provider.test.ts`
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`
- Modify: `apps/core/src/model/openai-compatible-embedding-provider.ts`

- [x] **Step 1: Write failing provider tests**

Assert trailing-slash base URLs produce single-slash model and embedding endpoint URLs.

- [x] **Step 2: Run focused tests to verify they fail**

Run:

```bash
npm --workspace apps/core test -- tests/openai-compatible-model-provider.test.ts --reporter=dot
npm --workspace apps/core test -- tests/openai-compatible-embedding-provider.test.ts --reporter=dot
```

Expected: FAIL because URLs currently contain double slashes.

- [x] **Step 3: Implement endpoint join helper**

Strip trailing slashes from `baseUrl` before appending `/chat/completions` and `/embeddings`.

- [x] **Step 4: Run focused tests to verify they pass**

Run:

```bash
npm --workspace apps/core test -- tests/openai-compatible-model-provider.test.ts --reporter=dot
npm --workspace apps/core test -- tests/openai-compatible-embedding-provider.test.ts --reporter=dot
```

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-openai-base-url-normalization.md`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Commit and push**

Run:

```bash
git add apps/core/src/model/openai-compatible-model-provider.ts apps/core/src/model/openai-compatible-embedding-provider.ts apps/core/tests/openai-compatible-model-provider.test.ts apps/core/tests/openai-compatible-embedding-provider.test.ts docs/superpowers/specs/2026-07-03-iris-openai-base-url-normalization-design.md docs/superpowers/plans/2026-07-03-iris-openai-base-url-normalization.md
git commit -m "fix: normalize openai compatible base urls"
git push --force-with-lease origin codex/iris-document-source-registry
```
