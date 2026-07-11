# Iris Answer Draft Runtime Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2J of Iris: compose the real answer draft runtime only when explicitly enabled by configuration.

**Architecture:** Add answer draft runtime config, create a runtime composer that wires Postgres fragments, static development query embedding, OpenAI-compatible model provider, context builder, and answer draft orchestrator, then let `buildApp()` use composed runtime only when no orchestrator is injected.

**Tech Stack:** TypeScript, Vitest, Fastify, pg, existing repositories/builders/providers.

---

## Scope

This plan implements the approved Phase 2J design in `docs/superpowers/specs/2026-07-02-iris-answer-draft-runtime-wiring-design.md`.

It includes:

- runtime enable config;
- runtime composer;
- static development query embedding provider;
- app runtime wiring and cleanup hook;
- focused tests.

It intentionally does not implement:

- real embedding provider;
- Feishu live permission checker;
- API authentication;
- Feishu replies;
- background jobs.

## File Structure

Create:

```text
apps/core/src/runtime/
  answer-draft-runtime.ts

apps/core/tests/
  answer-draft-runtime.test.ts
```

Modify:

```text
apps/core/src/config/env.ts
apps/core/tests/env.test.ts
apps/core/src/app.ts
apps/core/tests/answer-draft-api.test.ts
```

Responsibilities:

- `env.ts`: parse explicit answer draft runtime enablement and permission mode.
- `answer-draft-runtime.ts`: compose runtime dependencies and own cleanup.
- `app.ts`: prefer injected orchestrator, otherwise use composed runtime.
- tests: keep all runtime behavior deterministic with fake factories.

## Task 1: Add Answer Draft Runtime Config

**Files:**
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/tests/env.test.ts`

- [ ] **Step 1: Add failing config tests**

Append to `apps/core/tests/env.test.ts`:

```ts
import { readAnswerDraftRuntimeConfig } from "../src/config/env.js";

describe("readAnswerDraftRuntimeConfig", () => {
  it("returns disabled config when internal answer drafts are not enabled", () => {
    expect(readAnswerDraftRuntimeConfig({})).toEqual({ enabled: false });
    expect(readAnswerDraftRuntimeConfig({ IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "false" })).toEqual({
      enabled: false,
    });
  });

  it("reads enabled allow-indexed runtime config", () => {
    expect(
      readAnswerDraftRuntimeConfig({
        IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: " true ",
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: " allow-indexed ",
      }),
    ).toEqual({
      enabled: true,
      permissionMode: "allow-indexed",
    });
  });

  it("requires permission mode when runtime is enabled", () => {
    expect(() =>
      readAnswerDraftRuntimeConfig({ IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true" }),
    ).toThrow("IRIS_INTERNAL_DRAFT_PERMISSION_MODE is required");
  });

  it("rejects unsupported permission modes", () => {
    expect(() =>
      readAnswerDraftRuntimeConfig({
        IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "live-feishu",
      }),
    ).toThrow("Unsupported IRIS_INTERNAL_DRAFT_PERMISSION_MODE: live-feishu");
  });
});
```

- [ ] **Step 2: Run env tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- env.test.ts
```

Expected: FAIL because `readAnswerDraftRuntimeConfig` does not exist.

- [ ] **Step 3: Implement config reader**

Modify `apps/core/src/config/env.ts`:

```ts
export type AnswerDraftRuntimeConfig =
  | { enabled: false }
  | { enabled: true; permissionMode: "allow-indexed" };

export function readAnswerDraftRuntimeConfig(env: EnvLike = process.env): AnswerDraftRuntimeConfig {
  const enabled = readOptionalEnv(env.IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS);
  if (enabled !== "true") {
    return { enabled: false };
  }

  const permissionMode = readRequiredEnv(
    "IRIS_INTERNAL_DRAFT_PERMISSION_MODE",
    env.IRIS_INTERNAL_DRAFT_PERMISSION_MODE,
  );
  if (permissionMode !== "allow-indexed") {
    throw new Error(`Unsupported IRIS_INTERNAL_DRAFT_PERMISSION_MODE: ${permissionMode}`);
  }

  return { enabled: true, permissionMode };
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- env.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit config**

Run:

```powershell
git add apps/core/src/config/env.ts apps/core/tests/env.test.ts
git commit -m "feat: add answer draft runtime config"
```

Expected: commit succeeds.

## Task 2: Add Answer Draft Runtime Composer

**Files:**
- Create: `apps/core/src/runtime/answer-draft-runtime.ts`
- Create: `apps/core/tests/answer-draft-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Create `apps/core/tests/answer-draft-runtime.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createAnswerDraftRuntime } from "../src/runtime/answer-draft-runtime.js";

describe("createAnswerDraftRuntime", () => {
  it("returns undefined when runtime is disabled", () => {
    expect(createAnswerDraftRuntime({ env: {} })).toBeUndefined();
  });

  it("composes runtime dependencies when explicitly enabled", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const dependencies = {
      createPostgresPool: vi.fn(() => pool),
      createDocumentFragmentRepository: vi.fn(() => ({
        searchSimilarFragments: vi.fn(async () => []),
      })),
      createModelProvider: vi.fn(() => ({
        generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft" })),
      })),
    };

    const runtime = createAnswerDraftRuntime({
      env: {
        IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "allow-indexed",
        DATABASE_URL: "postgres://iris:iris@localhost:5432/iris",
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
        IRIS_MODEL_API_KEY: "key-a",
        IRIS_MODEL_NAME: "model-a",
      },
      dependencies,
    });

    expect(runtime).toBeDefined();
    expect(dependencies.createPostgresPool).toHaveBeenCalledWith({
      databaseUrl: "postgres://iris:iris@localhost:5432/iris",
    });
    expect(dependencies.createDocumentFragmentRepository).toHaveBeenCalledWith({
      queryable: pool,
    });
    expect(dependencies.createModelProvider).toHaveBeenCalledWith({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "key-a",
      model: "model-a",
      timeoutMs: 30000,
    });

    await runtime?.close();
    expect(pool.end).toHaveBeenCalled();
  });

  it("creates a working orchestrator with allow-indexed development permissions", async () => {
    const model = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Runtime draft" })),
    };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => [
        {
          id: "fragment-1",
          documentSourceId: "source-1",
          documentSnapshotId: "snapshot-1",
          sourceUri: "https://example.com/doc",
          chunkIndex: 0,
          text: "Indexed text",
          contentHash: "hash",
          embedding: [1, 0, 0, 0, 0, 0],
          createdAt: new Date("2026-07-02T01:00:00.000Z"),
        },
      ]),
    };
    const runtime = createAnswerDraftRuntime({
      env: enabledEnv(),
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createModelProvider: vi.fn(() => model),
      },
    });

    const result = await runtime?.answerDraftOrchestrator.generateDraft({
      question: "What changed?",
      liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
    });

    expect(result?.answerText).toBe("Runtime draft");
    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith({
      embedding: [1, 0, 0, 0, 0, 0],
      limit: 8,
    });
    expect(model.generateAnswerDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "What changed?",
      }),
    );
  });
});

function enabledEnv() {
  return {
    IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
    IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "allow-indexed",
    DATABASE_URL: "postgres://iris:iris@localhost:5432/iris",
    IRIS_MODEL_PROVIDER: "openai-compatible",
    IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
    IRIS_MODEL_API_KEY: "key-a",
    IRIS_MODEL_NAME: "model-a",
  };
}
```

- [ ] **Step 2: Run runtime tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-runtime.test.ts
```

Expected: FAIL because runtime file does not exist.

- [ ] **Step 3: Implement runtime composer**

Create `apps/core/src/runtime/answer-draft-runtime.ts`.

Required exports:

- `AnswerDraftRuntime`;
- `AnswerDraftRuntimeDependencies`;
- `createAnswerDraftRuntime`;

Implementation:

- read `readAnswerDraftRuntimeConfig`;
- return undefined when disabled;
- read `readDatabaseConfig`;
- read `readModelProviderConfig`;
- create pool;
- create fragment repository;
- create OpenAI-compatible model provider;
- create `DocumentRetrievalContextBuilder` using:
  - static query embedder returning `[[1, 0, 0, 0, 0, 0]]`;
  - `canReadDocument` returning `true` for `allow-indexed`;
- create `AnswerDraftOrchestrator`;
- return `{ answerDraftOrchestrator, close }`;
- `close` calls `pool.end()`.

Allow dependency injection for tests:

```ts
dependencies?: {
  createPostgresPool?: typeof createPostgresPool;
  createDocumentFragmentRepository?: typeof createDocumentFragmentRepository;
  createModelProvider?: typeof createOpenAICompatibleModelProvider;
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-runtime.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit runtime**

Run:

```powershell
git add apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/answer-draft-runtime.test.ts
git commit -m "feat: add answer draft runtime composer"
```

Expected: commit succeeds.

## Task 3: Wire Runtime Into App

**Files:**
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [ ] **Step 1: Add failing app wiring tests**

Append to `apps/core/tests/answer-draft-api.test.ts`:

```ts
describe("answer draft runtime wiring", () => {
  it("uses injected orchestrator without composing runtime", async () => {
    const createAnswerDraftRuntime = vi.fn(() => {
      throw new Error("should not compose runtime");
    });
    const app = buildApp({
      createAnswerDraftRuntime,
      answerDraftOrchestrator: {
        generateDraft: vi.fn(async () => ({
          answerText: "Injected draft",
          promptContext: "",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
        })),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: { question: "Q", liveChatMessages: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(createAnswerDraftRuntime).not.toHaveBeenCalled();
  });

  it("uses composed runtime when no orchestrator is injected", async () => {
    const close = vi.fn(async () => undefined);
    const app = buildApp({
      createAnswerDraftRuntime: vi.fn(() => ({
        answerDraftOrchestrator: {
          generateDraft: vi.fn(async () => ({
            answerText: "Runtime draft",
            promptContext: "",
            allowedFragments: [],
            deniedDocumentIds: [],
            retrievedFragmentCount: 0,
          })),
        },
        close,
      })),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: { question: "Q", liveChatMessages: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().answerText).toBe("Runtime draft");

    await app.close();
    expect(close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run route tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
```

Expected: FAIL because `BuildAppDependencies` does not accept `createAnswerDraftRuntime`.

- [ ] **Step 3: Implement app wiring**

Modify `apps/core/src/app.ts`:

- import `createAnswerDraftRuntime` and `type AnswerDraftRuntime`;
- extend `BuildAppDependencies` with:

```ts
createAnswerDraftRuntime?: () => AnswerDraftRuntime | undefined;
```

- inside `buildApp`, compute:

```ts
const answerDraftRuntime =
  dependencies.answerDraftOrchestrator === undefined
    ? (dependencies.createAnswerDraftRuntime ?? createAnswerDraftRuntime)()
    : undefined;
const answerDraftOrchestrator =
  dependencies.answerDraftOrchestrator ?? answerDraftRuntime?.answerDraftOrchestrator;
```

- use `answerDraftOrchestrator` in route instead of `dependencies.answerDraftOrchestrator`;
- add `onClose` hook to close runtime.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit app wiring**

Run:

```powershell
git add apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: wire answer draft runtime into app"
```

Expected: commit succeeds.

## Task 4: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run TypeScript typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run all TypeScript tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 3: Run Python worker tests**

Run from `workers/ai`:

```powershell
python -m pytest
```

Expected: PASS.

- [ ] **Step 4: Validate Docker Compose**

Run:

```powershell
docker compose config
```

Expected: resolved compose config prints successfully.

- [ ] **Step 5: Push branch and update PR**

Run:

```powershell
git push origin codex/iris-document-source-registry
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url
```

Expected: push succeeds and PR #3 remains open and mergeable.

## Self-Review Checklist

- Runtime composition is disabled unless explicitly enabled.
- `allow-indexed` is the only supported Phase 2J permission mode.
- Injected orchestrator behavior remains unchanged.
- Runtime resources are closed on app close.
- No Feishu sending is introduced.
