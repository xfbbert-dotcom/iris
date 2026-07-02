# Iris OpenAI-Compatible Model Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2H of Iris: add a real OpenAI-compatible chat completions adapter behind the existing `ModelProvider` interface.

**Architecture:** Extend env config with optional model provider settings, then add an `OpenAICompatibleModelProvider` that uses injected `fetch` for deterministic tests. Keep `AnswerDraftOrchestrator` unchanged.

**Tech Stack:** TypeScript, Vitest, Node.js `AbortController`, built-in `fetch` types, existing `ModelProvider`.

---

## Scope

This plan implements the approved Phase 2H design in `docs/superpowers/specs/2026-07-02-iris-openai-compatible-model-provider-design.md`.

It includes:

- model provider environment config reader;
- OpenAI-compatible model provider;
- fake-fetch tests for request/response/error behavior.

It intentionally does not implement:

- streaming;
- retries;
- tool calling;
- provider SDKs;
- app runtime wiring;
- Feishu sending.

## File Structure

Create:

```text
apps/core/src/model/
  openai-compatible-model-provider.ts

apps/core/tests/
  openai-compatible-model-provider.test.ts
```

Modify:

```text
apps/core/src/config/env.ts
apps/core/tests/env.test.ts
```

Responsibilities:

- `env.ts`: reads and validates optional model provider config.
- `openai-compatible-model-provider.ts`: implements `ModelProvider` using OpenAI-compatible chat completions.
- `openai-compatible-model-provider.test.ts`: validates fake-fetch request, response, and error behavior.

## Task 1: Add Model Provider Env Config

**Files:**
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/tests/env.test.ts`

- [ ] **Step 1: Add failing env tests**

Append to `apps/core/tests/env.test.ts`:

```ts
import { readModelProviderConfig } from "../src/config/env.js";

describe("readModelProviderConfig", () => {
  it("returns undefined when no model provider is configured", () => {
    expect(readModelProviderConfig({})).toBeUndefined();
  });

  it("reads openai-compatible model config and trims values", () => {
    expect(
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: " openai-compatible ",
        IRIS_MODEL_BASE_URL: " https://api.example.com/v1/ ",
        IRIS_MODEL_API_KEY: " key-a ",
        IRIS_MODEL_NAME: " model-a ",
        IRIS_MODEL_TIMEOUT_MS: " 1500 ",
      }),
    ).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "key-a",
      model: "model-a",
      timeoutMs: 1500,
    });
  });

  it("rejects incomplete openai-compatible config", () => {
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
      }),
    ).toThrow("IRIS_MODEL_API_KEY is required");
  });

  it("rejects invalid timeout values", () => {
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
        IRIS_MODEL_API_KEY: "key-a",
        IRIS_MODEL_NAME: "model-a",
        IRIS_MODEL_TIMEOUT_MS: "0",
      }),
    ).toThrow("IRIS_MODEL_TIMEOUT_MS must be a positive integer");
  });
});
```

- [ ] **Step 2: Run env tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- env.test.ts
```

Expected: FAIL because `readModelProviderConfig` does not exist.

- [ ] **Step 3: Implement config reader**

Modify `apps/core/src/config/env.ts`:

```ts
export type ModelProviderConfig =
  | {
      provider: "openai-compatible";
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
    };

export function readModelProviderConfig(env: EnvLike = process.env): ModelProviderConfig | undefined {
  const provider = readOptionalEnv(env.IRIS_MODEL_PROVIDER);
  if (provider === undefined) {
    return undefined;
  }
  if (provider !== "openai-compatible") {
    throw new Error(`Unsupported IRIS_MODEL_PROVIDER: ${provider}`);
  }

  return {
    provider,
    baseUrl: trimTrailingSlash(readRequiredEnv("IRIS_MODEL_BASE_URL", env.IRIS_MODEL_BASE_URL)),
    apiKey: readRequiredEnv("IRIS_MODEL_API_KEY", env.IRIS_MODEL_API_KEY),
    model: readRequiredEnv("IRIS_MODEL_NAME", env.IRIS_MODEL_NAME),
    timeoutMs: readPositiveIntegerEnv("IRIS_MODEL_TIMEOUT_MS", env.IRIS_MODEL_TIMEOUT_MS, 30000),
  };
}
```

Add helpers:

- `readRequiredEnv(name, value)`;
- `readPositiveIntegerEnv(name, value, defaultValue)`;
- `trimTrailingSlash(value)`.

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
git commit -m "feat: add model provider config"
```

Expected: commit succeeds.

## Task 2: Add OpenAI-Compatible Model Provider

**Files:**
- Create: `apps/core/src/model/openai-compatible-model-provider.ts`
- Create: `apps/core/tests/openai-compatible-model-provider.test.ts`

- [ ] **Step 1: Write failing provider tests**

Create `apps/core/tests/openai-compatible-model-provider.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createOpenAICompatibleModelProvider } from "../src/model/openai-compatible-model-provider.js";

describe("OpenAICompatibleModelProvider", () => {
  it("sends a chat completions request and returns trimmed answer text", async () => {
    const fetch = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: "  Answer draft.  " } }],
    }));
    const provider = createOpenAICompatibleModelProvider({
      config: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "key-a",
        model: "model-a",
        timeoutMs: 5000,
      },
      fetch,
    });

    await expect(
      provider.generateAnswerDraft({
        question: "What changed?",
        promptContext: "<live_chat_context></live_chat_context>",
      }),
    ).resolves.toEqual({ answerText: "Answer draft." });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer key-a",
      "content-type": "application/json",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "model-a",
      temperature: 0.2,
      messages: [
        expect.objectContaining({ role: "system" }),
        {
          role: "user",
          content:
            "Question:\nWhat changed?\n\nContext:\n<live_chat_context></live_chat_context>",
        },
      ],
    });
  });

  it("throws on non-2xx responses", async () => {
    const provider = createOpenAICompatibleModelProvider({
      config: config(),
      fetch: vi.fn(async () => jsonResponse({ error: { message: "bad key" } }, { status: 401 })),
    });

    await expect(
      provider.generateAnswerDraft({ question: "Q", promptContext: "C" }),
    ).rejects.toThrow("model provider request failed with status 401: bad key");
  });

  it("throws on malformed responses", async () => {
    const provider = createOpenAICompatibleModelProvider({
      config: config(),
      fetch: vi.fn(async () => jsonResponse({ choices: [] })),
    });

    await expect(
      provider.generateAnswerDraft({ question: "Q", promptContext: "C" }),
    ).rejects.toThrow("model provider response did not include answer content");
  });

  it("aborts requests after timeout", async () => {
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      init?.signal?.dispatchEvent(new Event("abort"));
      return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
    const provider = createOpenAICompatibleModelProvider({
      config: { ...config(), timeoutMs: 1 },
      fetch,
    });

    await expect(
      provider.generateAnswerDraft({ question: "Q", promptContext: "C" }),
    ).rejects.toThrow("model provider request timed out");
  });
});

function config() {
  return {
    provider: "openai-compatible" as const,
    baseUrl: "https://api.example.com/v1",
    apiKey: "key-a",
    model: "model-a",
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
npm --workspace apps/core test -- openai-compatible-model-provider.test.ts
```

Expected: FAIL because provider file does not exist.

- [ ] **Step 3: Implement provider**

Create `apps/core/src/model/openai-compatible-model-provider.ts`.

Required exports:

- `createOpenAICompatibleModelProvider`;
- `OpenAICompatibleModelProviderDependencies`;

Implementation requirements:

- accept `{ config, fetch? }`;
- default fetch to `globalThis.fetch`;
- build URL as `${config.baseUrl}/chat/completions`;
- send lowercase headers matching tests;
- use `AbortController` and `setTimeout`;
- on `AbortError`, throw `model provider request timed out`;
- parse error body message from `error.message` when present;
- parse `choices[0].message.content`;
- trim returned content;
- throw if content is blank.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- openai-compatible-model-provider.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit provider**

Run:

```powershell
git add apps/core/src/model/openai-compatible-model-provider.ts apps/core/tests/openai-compatible-model-provider.test.ts
git commit -m "feat: add OpenAI-compatible model provider"
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

- No API keys are hard-coded.
- Tests use fake `fetch` only.
- `AnswerDraftOrchestrator` remains unchanged.
- Provider errors are explicit and actionable.
- No Feishu sending is introduced.
