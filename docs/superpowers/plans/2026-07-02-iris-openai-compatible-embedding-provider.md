# Iris OpenAI-Compatible Embedding Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2K of Iris: add an OpenAI-compatible embeddings adapter behind the existing `EmbeddingProvider` interface.

**Architecture:** Extend env config with optional embedding provider settings, then add an `OpenAICompatibleEmbeddingProvider` that uses injected `fetch` for deterministic tests. Do not change pgvector schema or runtime wiring in this phase.

**Tech Stack:** TypeScript, Vitest, Node.js `AbortController`, built-in `fetch` types, existing `EmbeddingProvider`.

---

## Scope

This plan implements the approved Phase 2K design in `docs/superpowers/specs/2026-07-02-iris-openai-compatible-embedding-provider-design.md`.

It includes:

- embedding provider environment config reader;
- OpenAI-compatible embedding provider;
- fake-fetch tests for request/response/error behavior.

It intentionally does not implement:

- pgvector dimension migration;
- document reindexing;
- runtime replacement of static query embeddings;
- provider SDKs;
- retries;
- Feishu live permissions.

## File Structure

Create:

```text
apps/core/src/model/
  openai-compatible-embedding-provider.ts

apps/core/tests/
  openai-compatible-embedding-provider.test.ts
```

Modify:

```text
apps/core/src/config/env.ts
apps/core/tests/env.test.ts
```

Responsibilities:

- `env.ts`: reads and validates optional embedding provider config.
- `openai-compatible-embedding-provider.ts`: implements `EmbeddingProvider` using OpenAI-compatible embeddings.
- tests: validate fake-fetch request, response, and error behavior.

## Task 1: Add Embedding Provider Env Config

**Files:**
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/tests/env.test.ts`

- [ ] **Step 1: Add failing env tests**

Append to `apps/core/tests/env.test.ts`:

```ts
import { readEmbeddingProviderConfig } from "../src/config/env.js";

describe("readEmbeddingProviderConfig", () => {
  it("returns undefined when no embedding provider is configured", () => {
    expect(readEmbeddingProviderConfig({})).toBeUndefined();
  });

  it("reads openai-compatible embedding config and trims values", () => {
    expect(
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: " openai-compatible ",
        IRIS_EMBEDDING_BASE_URL: " https://api.example.com/v1/ ",
        IRIS_EMBEDDING_API_KEY: " key-a ",
        IRIS_EMBEDDING_MODEL: " embedding-model ",
        IRIS_EMBEDDING_DIMENSIONS: " 1536 ",
        IRIS_EMBEDDING_TIMEOUT_MS: " 2500 ",
      }),
    ).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "key-a",
      model: "embedding-model",
      dimensions: 1536,
      timeoutMs: 2500,
    });
  });

  it("omits dimensions when not configured", () => {
    expect(
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
      }),
    ).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "key-a",
      model: "embedding-model",
      timeoutMs: 30000,
    });
  });

  it("rejects incomplete openai-compatible embedding config", () => {
    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
      }),
    ).toThrow("IRIS_EMBEDDING_API_KEY is required");
  });

  it("rejects invalid dimensions and timeout values", () => {
    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
        IRIS_EMBEDDING_DIMENSIONS: "-1",
      }),
    ).toThrow("IRIS_EMBEDDING_DIMENSIONS must be a positive integer");

    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
        IRIS_EMBEDDING_TIMEOUT_MS: "0",
      }),
    ).toThrow("IRIS_EMBEDDING_TIMEOUT_MS must be a positive integer");
  });
});
```

- [ ] **Step 2: Run env tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- env.test.ts
```

Expected: FAIL because `readEmbeddingProviderConfig` does not exist.

- [ ] **Step 3: Implement config reader**

Modify `apps/core/src/config/env.ts`:

```ts
export type EmbeddingProviderConfig = {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
  timeoutMs: number;
};

export function readEmbeddingProviderConfig(env: EnvLike = process.env): EmbeddingProviderConfig | undefined {
  const provider = readOptionalEnv(env.IRIS_EMBEDDING_PROVIDER);
  if (provider === undefined) {
    return undefined;
  }
  if (provider !== "openai-compatible") {
    throw new Error(`Unsupported IRIS_EMBEDDING_PROVIDER: ${provider}`);
  }

  const dimensions = readOptionalPositiveIntegerEnv(
    "IRIS_EMBEDDING_DIMENSIONS",
    env.IRIS_EMBEDDING_DIMENSIONS,
  );

  return {
    provider,
    baseUrl: trimTrailingSlash(readRequiredEnv("IRIS_EMBEDDING_BASE_URL", env.IRIS_EMBEDDING_BASE_URL)),
    apiKey: readRequiredEnv("IRIS_EMBEDDING_API_KEY", env.IRIS_EMBEDDING_API_KEY),
    model: readRequiredEnv("IRIS_EMBEDDING_MODEL", env.IRIS_EMBEDDING_MODEL),
    ...(dimensions === undefined ? {} : { dimensions }),
    timeoutMs: readPositiveIntegerEnv("IRIS_EMBEDDING_TIMEOUT_MS", env.IRIS_EMBEDDING_TIMEOUT_MS, 30000),
  };
}
```

Add helper:

```ts
function readOptionalPositiveIntegerEnv(name: string, value: string | undefined): number | undefined
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
git commit -m "feat: add embedding provider config"
```

Expected: commit succeeds.

## Task 2: Add OpenAI-Compatible Embedding Provider

**Files:**
- Create: `apps/core/src/model/openai-compatible-embedding-provider.ts`
- Create: `apps/core/tests/openai-compatible-embedding-provider.test.ts`

- [ ] **Step 1: Write failing provider tests**

Create `apps/core/tests/openai-compatible-embedding-provider.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createOpenAICompatibleEmbeddingProvider } from "../src/model/openai-compatible-embedding-provider.js";

describe("OpenAICompatibleEmbeddingProvider", () => {
  it("sends an embeddings request and returns vectors in order", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 0, embedding: [1, 0, 0] },
          { index: 1, embedding: [0, 1, 0] },
        ],
      }),
    );
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "key-a",
        model: "embedding-model",
        dimensions: 3,
        timeoutMs: 5000,
      },
      fetch,
    });

    await expect(provider.embedTexts(["alpha", "beta"])).resolves.toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer key-a",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "embedding-model",
      input: ["alpha", "beta"],
      dimensions: 3,
    });
  });

  it("omits dimensions when not configured and skips fetch for empty input", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, embedding: [1, 0, 0] }] }),
    );
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: config(),
      fetch,
    });

    await expect(provider.embedTexts([])).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();

    await provider.embedTexts(["alpha"]);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      model: "embedding-model",
      input: ["alpha"],
    });
  });

  it("throws on count mismatch", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: config(),
      fetch: vi.fn(async () => jsonResponse({ data: [] })),
    });

    await expect(provider.embedTexts(["alpha"])).rejects.toThrow("embedding response count mismatch");
  });

  it("throws on invalid vector values", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: config(),
      fetch: vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [Number.NaN] }] })),
    });

    await expect(provider.embedTexts(["alpha"])).rejects.toThrow("embedding vector contains invalid value");
  });

  it("throws on non-2xx responses", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: config(),
      fetch: vi.fn(async () => jsonResponse({ error: { message: "bad key" } }, { status: 401 })),
    });

    await expect(provider.embedTexts(["alpha"])).rejects.toThrow(
      "embedding provider request failed with status 401: bad key",
    );
  });

  it("aborts requests after timeout", async () => {
    const fetch = vi.fn(((_url: URL | RequestInfo, init?: RequestInit) => {
      init?.signal?.dispatchEvent(new Event("abort"));
      return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }) as typeof globalThis.fetch);
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: { ...config(), timeoutMs: 1 },
      fetch,
    });

    await expect(provider.embedTexts(["alpha"])).rejects.toThrow("embedding provider request timed out");
  });
});

function config() {
  return {
    provider: "openai-compatible" as const,
    baseUrl: "https://api.example.com/v1",
    apiKey: "key-a",
    model: "embedding-model",
    timeoutMs: 5000,
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 2: Run provider tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- openai-compatible-embedding-provider.test.ts
```

Expected: FAIL because provider file does not exist.

- [ ] **Step 3: Implement provider**

Create `apps/core/src/model/openai-compatible-embedding-provider.ts`.

Required exports:

- `createOpenAICompatibleEmbeddingProvider`;
- `OpenAICompatibleEmbeddingProviderDependencies`;

Implementation requirements:

- implement `EmbeddingProvider`;
- accept `{ config, fetch? }`;
- default fetch to `globalThis.fetch`;
- return `[]` without calling fetch when input is empty;
- build URL as `${config.baseUrl}/embeddings`;
- include `dimensions` only when configured;
- use `AbortController` and `setTimeout`;
- on `AbortError`, throw `embedding provider request timed out`;
- parse error body message from `error.message` when present;
- parse `data[].embedding`;
- sort response items by `index` when index is present;
- require one vector per input text;
- require finite number vector values.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- openai-compatible-embedding-provider.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit provider**

Run:

```powershell
git add apps/core/src/model/openai-compatible-embedding-provider.ts apps/core/tests/openai-compatible-embedding-provider.test.ts
git commit -m "feat: add OpenAI-compatible embedding provider"
```

Expected: commit succeeds.

## Task 3: Final Verification

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

- No embedding API keys are hard-coded.
- Tests use fake `fetch` only.
- No pgvector schema migration is included.
- Runtime static query embedding is not replaced in this phase.
- Provider errors are explicit and actionable.
