# Iris Pilot Fail-Closed And Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pilot restarts fail closed and accurately classify the observed Gemini quota and Feishu Wiki permission responses.

**Architecture:** Keep runtime control in the TypeScript Core modular monolith. Add one startup-only environment setting, extend the shared bounded external-error reader, and add one known Feishu denial code without changing APIs, queues, retrieval, or model selection.

**Tech Stack:** TypeScript, Vitest, Node test runner, Docker Compose, Feishu OpenAPI, Gemini OpenAI-compatible API.

## Global Constraints

- The architecture whitepaper remains authoritative.
- Pilot Core restarts must initialize global runtime control as disabled.
- Permission failures remain fail closed.
- Provider errors remain bounded and must not expose credentials.
- Follow red-green TDD for every behavior change.

---

### Task 1: Fail-closed pilot startup

**Files:**
- Create: `apps/core/tests/runtime-config.test.ts`
- Modify: `apps/core/src/config/runtime-config.ts`
- Modify: `scripts/pilot-compose.test.mjs`
- Modify: `deploy/pilot/docker-compose.yml`
- Modify: `.env.pilot.example`
- Modify: `docs/operations/internal-rollout-runbook.md`

**Interfaces:**
- Consumes: `createDefaultRuntimeConfig(env?)` and pilot Compose environment interpolation.
- Produces: `IRIS_RUNTIME_GLOBAL_ENABLED` startup configuration with a pilot default of `false`.

- [x] **Step 1: Write failing runtime and Compose tests**

Require absent configuration to preserve the development default, explicit `false` to disable,
explicit `true` to enable, invalid values to throw, and rendered pilot Compose to pass `false`.

- [x] **Step 2: Run focused tests and verify RED**

Run `npm test --workspace apps/core -- runtime-config.test.ts` and
`node --test scripts/pilot-compose.test.mjs`. Expected: failures because the environment setting is
not implemented or passed.

- [x] **Step 3: Implement the minimal startup parser and pilot configuration**

Read the optional environment value in `createDefaultRuntimeConfig`, fail on invalid values, pass it
through Compose, document it in the example environment, and update the restart limitation in the
runbook.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the same commands. Expected: all focused tests pass.

- [x] **Step 5: Commit the startup correction**

Commit with message `fix: make pilot runtime startup fail closed`.

### Task 2: Preserve Gemini quota diagnostics

**Files:**
- Modify: `apps/core/tests/external-error-message.test.ts`
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts`
- Modify: `apps/core/src/integrations/external-error-message.ts`

**Interfaces:**
- Consumes: bounded JSON response values passed to `readExternalErrorMessage()`.
- Produces: the first useful message from a top-level provider response array.

- [x] **Step 1: Write failing array-wrapped error tests**

Use the observed Gemini shape `[{ error: { message: "quota exhausted" } }]` and require both the
shared reader and model provider exception to retain the message.

- [x] **Step 2: Run focused tests and verify RED**

Run `npm test --workspace apps/core -- external-error-message.test.ts openai-compatible-model-provider.test.ts`.
Expected: the new assertions receive `unknown error`.

- [x] **Step 3: Implement first-useful-entry array parsing**

Inspect top-level array entries in order, reuse the existing record precedence, and preserve the
existing truncation bound.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the same focused command. Expected: all tests pass.

- [x] **Step 5: Commit the provider diagnostic correction**

Commit with message `fix: preserve array-wrapped provider errors`.

### Task 3: Classify Feishu Wiki revocation correctly

**Files:**
- Modify: `apps/core/tests/feishu-document-permission-checker.test.ts`
- Modify: `apps/core/src/permissions/feishu-document-permission-checker.ts`

**Interfaces:**
- Consumes: Feishu Wiki HTTP status and bounded JSON body.
- Produces: `false` for HTTP 400/code `131006`; errors remain thrown for unknown HTTP 400 bodies.

- [x] **Step 1: Write the failing known-denial test**

Require HTTP 400 with `{ code: 131006, msg: "permission denied" }` to resolve `false`, and retain an
unknown HTTP 400 case that rejects.

- [x] **Step 2: Run the focused test and verify RED**

Run `npm test --workspace apps/core -- feishu-document-permission-checker.test.ts`. Expected: the
known-denial case throws before returning `false`.

- [x] **Step 3: Implement the exact denial-code classification**

Add `131006` to the known denial codes and allow known denial bodies through the HTTP-status gate so
the existing success classifier returns `false`.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the same focused command. Expected: all tests pass.

- [x] **Step 5: Commit the permission diagnostic correction**

Commit with message `fix: classify revoked Feishu wiki access`.

### Task 4: Verify and deploy disabled

**Files:**
- Verify only: repository and deployment files.

**Interfaces:**
- Consumes: the three reviewed commits and private pilot environment.
- Produces: a commit-pinned Core image whose startup runtime state is disabled.

- [x] **Step 1: Run `npm run verify`**

Expected: TypeScript, Core, Python, deployment, Compose, and readiness checks all pass.

Verified after review corrections with 68 Core test files (1095 passed, 4 skipped), 7 Python tests, 16 pilot tests, and
13/13 rollout-readiness checks passing.

- [x] **Step 2: Build the exact commit image**

Build and run readiness using the commit SHA; do not use moving image tags.

- [x] **Step 3: Recreate Core with Caddy stopped**

Set `IRIS_RUNTIME_GLOBAL_ENABLED=false`, recreate Core, and verify the first runtime-control status is
globally disabled without an operator mutation.

- [x] **Step 4: Repeat private safety checks**

Require empty event/document/reindex queues and DLQs, healthy workers, protected internal APIs, and
the exact Feishu denial audit type before restoring any public ingress.

Deployed `2f28683f0a96af8351a122070e9394fbe89fe758` with Caddy stopped. Core initialized disabled on
both recreation and a subsequent restart; all worker queues and DLQs were empty, and the revoked
Wiki source emitted `permission_guard_denied` rather than `permission_guard_error`.
