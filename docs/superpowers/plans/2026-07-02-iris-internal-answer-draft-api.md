# Iris Internal Answer Draft API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2I of Iris: expose answer draft generation through an internal Fastify route with injected orchestrator dependencies.

**Architecture:** Extend `buildApp` dependencies with an optional answer draft orchestrator and add `POST /internal/answer-drafts`. The route validates JSON input, calls the orchestrator when configured, and returns draft metadata without sending Feishu messages.

**Tech Stack:** TypeScript, Fastify, Vitest, existing `AnswerDraftOrchestrator` types.

---

## Scope

This plan implements the approved Phase 2I design in `docs/superpowers/specs/2026-07-02-iris-internal-answer-draft-api-design.md`.

It includes:

- internal answer draft route;
- request validation;
- dependency injection;
- Fastify injection tests.

It intentionally does not implement:

- authentication;
- production dependency wiring;
- Feishu replies;
- streaming;
- UI.

## File Structure

Modify:

```text
apps/core/src/app.ts
apps/core/tests/answer-draft-api.test.ts
```

Responsibilities:

- `app.ts`: route registration, request validation, response mapping.
- `answer-draft-api.test.ts`: route behavior using fake orchestrator.

## Task 1: Add Internal Answer Draft Route

**Files:**
- Modify: `apps/core/src/app.ts`
- Create: `apps/core/tests/answer-draft-api.test.ts`

- [ ] **Step 1: Write failing route tests**

Create `apps/core/tests/answer-draft-api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

describe("POST /internal/answer-drafts", () => {
  it("calls the injected orchestrator and returns draft metadata", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Draft answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [
          {
            id: "fragment-1",
            documentSourceId: "source-1",
            documentSnapshotId: "snapshot-1",
            sourceUri: "https://example.com/doc",
            chunkIndex: 0,
            text: "Evidence text",
            contentHash: "hash",
            embedding: [1, 0, 0, 0, 0, 0],
            createdAt: new Date("2026-07-02T01:00:00.000Z"),
            distance: 0.12,
          },
        ],
        deniedDocumentIds: ["source-denied"],
        retrievedFragmentCount: 2,
      })),
    };
    const app = buildApp({ answerDraftOrchestrator });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
        fragmentLimit: 4,
        liveChatLimit: 10,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledWith({
      question: "What changed?",
      liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
      fragmentLimit: 4,
      liveChatLimit: 10,
    });
    expect(response.json()).toEqual({
      answerText: "Draft answer.",
      promptContext: "<live_chat_context></live_chat_context>",
      allowedFragments: [
        {
          id: "fragment-1",
          documentSourceId: "source-1",
          documentSnapshotId: "snapshot-1",
          sourceUri: "https://example.com/doc",
          chunkIndex: 0,
          text: "Evidence text",
          contentHash: "hash",
          embedding: [1, 0, 0, 0, 0, 0],
          createdAt: "2026-07-02T01:00:00.000Z",
          distance: 0.12,
        },
      ],
      deniedDocumentIds: ["source-denied"],
      retrievedFragmentCount: 2,
    });
  });

  it("returns 503 when no orchestrator is configured", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        liveChatMessages: [],
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "answer_draft_orchestrator_unavailable",
    });
  });

  it("returns 400 for invalid requests", async () => {
    const app = buildApp({
      answerDraftOrchestrator: { generateDraft: vi.fn() },
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: " ",
        liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns 500 when draft generation fails", async () => {
    const app = buildApp({
      answerDraftOrchestrator: {
        generateDraft: vi.fn(async () => {
          throw new Error("model unavailable");
        }),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        liveChatMessages: [],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "answer_draft_failed" });
  });
});
```

- [ ] **Step 2: Run route tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
```

Expected: FAIL because the route does not exist and `BuildAppDependencies` does not accept `answerDraftOrchestrator`.

- [ ] **Step 3: Implement route**

Modify `apps/core/src/app.ts`:

- import `type AnswerDraftOrchestrator` and `type LiveChatMessage`;
- add `answerDraftOrchestrator?: Pick<AnswerDraftOrchestrator, "generateDraft">` to `BuildAppDependencies`;
- add `app.post("/internal/answer-drafts", ...)`;
- validate request body with helper functions:
  - `parseAnswerDraftRequest`;
  - `isLiveChatMessage`;
  - `isFiniteNumberOrUndefined`;
- return:
  - `400` `{ ok: false, error: "invalid_request" }` on invalid request;
  - `503` `{ ok: false, error: "answer_draft_orchestrator_unavailable" }` if dependency missing;
  - `500` `{ ok: false, error: "answer_draft_failed" }` on orchestrator error;
  - `200` orchestrator result on success.

The parsed request type:

```ts
type AnswerDraftRequest = {
  question: string;
  liveChatMessages: LiveChatMessage[];
  fragmentLimit?: number;
  liveChatLimit?: number;
};
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit route**

Run:

```powershell
git add apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: add internal answer draft API"
```

Expected: commit succeeds.

## Task 2: Final Verification

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

- The route does not send Feishu messages.
- Missing orchestrator returns 503.
- Invalid request returns 400.
- Orchestrator errors do not leak internal messages.
- Existing Feishu event route still works.
