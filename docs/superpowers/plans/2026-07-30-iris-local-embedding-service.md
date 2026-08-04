# Iris Local Embedding Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Iris a quota-free, private embedding path that can index and query the full
authorized Feishu knowledge space on the pilot VPS.

**Architecture:** Preserve the existing OpenAI-compatible provider contract. Add native
model-dimension pgvector storage and an internal Ollama service whose one-shot seed job verifies
the approved model before Core can start.

**Tech Stack:** TypeScript, PostgreSQL with pgvector, Docker Compose, Ollama 0.32.0,
EmbeddingGemma 300M, Node test runner.

## Approved Implementation Correction

The original tasks below record the first Qwen3 candidate and remain as implementation history.
Production-shaped measurement rejected that candidate: one real 1,200-character Chinese chunk took
54-70 seconds under the pilot resource limit, so the 64-item batch repeatedly timed out. The
approved implementation keeps the same architecture but uses
`embeddinggemma:300m-qat-q4_0`, profile
`openai-compatible:embeddinggemma:300m-qat-q4_0:768`, migration
`0043_document_fragment_embeddings_768.sql`, batches of four, and a 60-second provider deadline.
The Qwen 1024-dimensional table and profile data remain intact for rollback. The final design and
acceptance contract are authoritative in
`docs/superpowers/specs/2026-07-30-iris-local-embedding-service-design.md`.

## Global Constraints

- Do not change the answer-generation or memory-extraction provider.
- Do not expose Ollama on a host, edge, or public port.
- Pin the Ollama image digest and verify the full model-manifest SHA256
  `ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d`.
- Store 1024-dimensional vectors natively; do not pad them to 1536 dimensions.
- Keep Iris global runtime disabled and Caddy stopped until all internal acceptance gates pass.
- Preserve existing Gemini profile data for rollback.

---

### Task 1: Add Native 1024-Dimensional Fragment Storage

**Files:**
- Create: `apps/core/migrations/0042_document_fragment_embeddings_1024.sql`
- Modify: `apps/core/src/model/embedding-profile-id.ts`
- Modify: `apps/core/src/documents/document-fragment-repository.ts`
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/tests/document-fragment-repository.test.ts`
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`
- Create: `apps/core/tests/embedding-profile-id.test.ts`
- Modify: `apps/core/tests/migration-runner.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProfile.dimensions` and existing `resolveEmbeddingTable()` routing.
- Produces: support for profile
  `openai-compatible:qwen3-embedding:0.6b:1024` and table
  `document_fragment_embeddings_1024`.

- [ ] **Step 1: Write failing 1024-dimension tests**

Add repository assertions that replacement inserts into
`document_fragment_embeddings_1024`, and add direct and answer-runtime guard assertions that 1024
is accepted. Extend the migration contract test to require the new table and `vector(1024)`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npm exec --workspace apps/core -- vitest run tests/document-fragment-repository.test.ts tests/answer-draft-runtime.test.ts tests/embedding-profile-id.test.ts tests/migration-runner.test.ts
```

Expected: failures show that dimension 1024 is unsupported and no 1024 table exists.

- [ ] **Step 3: Add the migration and minimal routing**

Create the table and profile index using the same metadata columns and foreign keys as the 1536
table. Extend `EmbeddingTable`, `resolveEmbeddingTable()`, and
`assertSupportedRuntimeEmbeddingDimension()` with 1024. Remove the duplicate answer-runtime guard
and import the shared guard so every answer, reindex, sync, and readiness path enforces one
dimension contract.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused command and require all selected tests to pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/core/migrations/0042_document_fragment_embeddings_1024.sql apps/core/src/model/embedding-profile-id.ts apps/core/src/documents/document-fragment-repository.ts apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/document-fragment-repository.test.ts apps/core/tests/answer-draft-runtime.test.ts apps/core/tests/embedding-profile-id.test.ts apps/core/tests/migration-runner.test.ts
git commit -m "feat: support 1024-dimensional embeddings"
```

### Task 2: Add the Private Ollama Pilot Service

**Files:**
- Modify: `deploy/pilot/docker-compose.yml`
- Modify: `deploy/pilot/ci.env`
- Modify: `.env.pilot.example`
- Modify: `scripts/pilot-compose.test.mjs`

**Interfaces:**
- Consumes: Core's existing `IRIS_EMBEDDING_*` OpenAI-compatible configuration.
- Produces: `embedding-model-init`, `embedding-model`, and volume
  `iris_embedding_models`.

- [ ] **Step 1: Write failing Compose contract tests**

Assert:

```js
assert.match(compose.services["embedding-model"].image, /@sha256:[a-f0-9]{64}$/u);
assert.equal(compose.services["embedding-model"].ports, undefined);
assert.deepEqual(compose.services["embedding-model"].networks, { backend: null });
assert.deepEqual(compose.services["embedding-model-init"].networks, { "model-egress": null });
assert.equal(
  compose.services.core.depends_on["embedding-model"].condition,
  "service_healthy",
);
assert.equal(compose.services.core.environment.IRIS_EMBEDDING_DIMENSIONS, "1024");
assert.equal(
  compose.services["embedding-model"].environment.IRIS_EMBEDDING_MODEL_MANIFEST_SHA256,
  "ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d",
);
```

Also require the approved model tag and full manifest SHA256 in `ci.env` and
`.env.pilot.example`. Update the existing model-egress exclusivity assertion so only
`ai-worker` and the one-shot `embedding-model-init` may join that network; the long-running
`embedding-model` must still be rejected from it.

- [ ] **Step 2: Run the pilot Compose tests and verify RED**

Run:

```powershell
node --test --test-concurrency=1 scripts/pilot-compose.test.mjs
```

Expected: failures report missing embedding services and 1024 configuration.

- [ ] **Step 3: Add seed and runtime services**

Use image
`ollama/ollama:0.32.0@sha256:57f573b47f1f71ebb445789f279fe3e596a8beab182f7cf486db9205bad87c5a`
and model `qwen3-embedding:0.6b`. The seed service starts a temporary server, reuses a cached model
or pulls it, verifies the full stored manifest SHA256 with `sha256sum`, and exits. The runtime
service mounts the same volume, joins only `backend`, exposes no port, has a 1536 MiB memory limit
and 1.5 CPU limit, allows one parallel request, and keeps the model for 30 minutes. Its health
check must verify both server availability and the full stored manifest SHA256. Configure Core
with base URL `http://embedding-model:11434/v1`, the approved model tag, and 1024 dimensions, and
make Core depend on the runtime service's healthy state.

- [ ] **Step 4: Run the pilot Compose tests and verify GREEN**

Run the same focused command and require all tests to pass.

- [ ] **Step 5: Commit**

```powershell
git add deploy/pilot/docker-compose.yml deploy/pilot/ci.env .env.pilot.example scripts/pilot-compose.test.mjs
git commit -m "feat: add private local embedding service"
```

### Task 3: Document Operations And Verify The Candidate

**Files:**
- Modify: `scripts/pilot-compose.test.mjs`
- Modify: `deploy/pilot/README.md`
- Modify: `docs/operations/internal-rollout-runbook.md`
- Modify: `docs/operations/engineering-failure-ledger.md`
- Modify: `docs/runbooks/iris-wiki-space-sync.md`

**Interfaces:**
- Consumes: model seed/runtime services and 1024 profile from Tasks 1 and 2.
- Produces: exact deployment, profile migration, recovery, and rollback procedures.

- [ ] **Step 1: Add operational contract coverage**

Extend existing documentation checks in `scripts/pilot-compose.test.mjs` to require:

- full model-manifest SHA256 verification before Core startup;
- old-profile DLQ evidence recording before deletion;
- exact new profile `openai-compatible:qwen3-embedding:0.6b:1024` and full reindex planning through
  `/internal/reindex/document-profile`;
- zero queue/DLQ, live Feishu permission, and internal Life Engine retrieval gates before ingress.

- [ ] **Step 2: Run the documentation contract tests and verify RED**

Run:

```powershell
node --test --test-concurrency=1 scripts/pilot-compose.test.mjs
```

Expected: the new required markers are absent.

- [ ] **Step 3: Update runbooks and the failure ledger**

Document the quota root cause, local model boundaries, exact profile migration, old-DLQ evidence
capture, bounded full-reindex loop, acceptance queries, and fail-closed rollback. Preserve prior
profile fragments for rollback. State explicitly that Feishu-native related-knowledge UI is not
Iris evidence.

- [ ] **Step 4: Run all verification**

Run:

```powershell
npm run verify
```

Expected: exit code 0 with Core, Python worker, pilot operations, Compose, and readiness checks all
passing.

- [ ] **Step 5: Commit**

```powershell
git add scripts/pilot-compose.test.mjs deploy/pilot/README.md docs/operations/internal-rollout-runbook.md docs/operations/engineering-failure-ledger.md docs/runbooks/iris-wiki-space-sync.md
git commit -m "docs: define local embedding rollout"
```

The controller publishes only after the task reviews and final whole-branch review pass. The draft
pull request is based on `codex/iris-wiki-space-sync`; deployment uses only an exact SHA whose Core
and AI Worker checks pass.
