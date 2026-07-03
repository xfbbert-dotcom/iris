# Iris Answer Draft Source Policy Permission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `source-policy` permission mode so answer draft runtime filters retrieved fragments through local source policy instead of always allowing indexed content.

**Architecture:** Keep `DocumentRetrievalContextBuilder` as the single prompt gate. Extend runtime config to accept `source-policy`, compose the Postgres document source registry in `createAnswerDraftRuntime()`, and choose a mode-specific `canReadDocument` function.

**Tech Stack:** TypeScript, Vitest, Postgres repository abstractions.

---

## File Structure

- `apps/core/src/config/env.ts`: extend `AnswerDraftRuntimeConfig` and validation.
- `apps/core/tests/env.test.ts`: add config coverage for `source-policy`.
- `apps/core/src/runtime/answer-draft-runtime.ts`: compose source registry and add local permission resolver.
- `apps/core/tests/answer-draft-runtime.test.ts`: prove `source-policy` filters unsafe fragments.
- `docs/superpowers/specs/2026-07-03-iris-answer-draft-source-policy-permission-design.md`: design record.

## Tasks

### Task 1: Config Mode

- [x] **Step 1: Write failing config test**

Add a test in `apps/core/tests/env.test.ts`:

```ts
it("reads enabled source-policy runtime config", () => {
  expect(
    readAnswerDraftRuntimeConfig({
      IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: " true ",
      IRIS_INTERNAL_DRAFT_PERMISSION_MODE: " source-policy ",
    }),
  ).toEqual({
    enabled: true,
    permissionMode: "source-policy",
  });
});
```

- [x] **Step 2: Verify red**

Run:

```powershell
npm --workspace apps/core test -- tests/env.test.ts
```

Expected: fail with unsupported permission mode.

- [x] **Step 3: Implement config support**

In `apps/core/src/config/env.ts`, change:

```ts
export type AnswerDraftRuntimeConfig =
  | { enabled: false }
  | { enabled: true; permissionMode: "allow-indexed" };
```

to:

```ts
export type AnswerDraftPermissionMode = "allow-indexed" | "source-policy";

export type AnswerDraftRuntimeConfig =
  | { enabled: false }
  | { enabled: true; permissionMode: AnswerDraftPermissionMode };
```

and accept both values in `readAnswerDraftRuntimeConfig()`.

- [x] **Step 4: Verify green**

Run:

```powershell
npm --workspace apps/core test -- tests/env.test.ts
```

Expected: pass.

### Task 2: Runtime Source Policy

- [x] **Step 1: Write failing runtime test**

Add a test in `apps/core/tests/answer-draft-runtime.test.ts` that enables `source-policy`, returns six fragments, and verifies only allowed source text reaches the model prompt:

```ts
it("filters answer draft fragments through local source policy", async () => {
  const model = {
    generateAnswerDraft: vi.fn(async () => ({ answerText: "Runtime draft" })),
  };
  const fragments = {
    searchSimilarFragments: vi.fn(async () => [
      fragment({ id: "fragment-allowed", documentSourceId: "source-allowed", text: "Allowed text" }),
      fragment({ id: "fragment-disabled", documentSourceId: "source-disabled", text: "Disabled text" }),
      fragment({ id: "fragment-denied", documentSourceId: "source-denied", text: "Denied text" }),
      fragment({ id: "fragment-stale", documentSourceId: "source-stale", text: "Stale text" }),
      fragment({ id: "fragment-missing", documentSourceId: "source-missing", text: "Missing text" }),
      fragment({ id: "fragment-error", documentSourceId: "source-error", text: "Error text" }),
    ]),
  };
  const sourceRegistry = {
    findSourceById: vi.fn(async (id: string) => {
      if (id === "source-error") {
        throw new Error("registry unavailable");
      }
      return sources[id];
    }),
  };
  const runtime = createAnswerDraftRuntime({
    env: {
      ...enabledEnv(),
      IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
    },
    dependencies: {
      createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
      createDocumentFragmentRepository: vi.fn(() => fragments),
      createDocumentSourceRegistry: vi.fn(() => sourceRegistry),
      createModelProvider: vi.fn(() => model),
      createEmbeddingProfileRepository: vi.fn(() => ({
        getStaticDevelopmentProfile: vi.fn(async () => profile()),
        findOrCreateProfile: vi.fn(),
        getProfileById: vi.fn(),
      })),
    },
  });

  const result = await runtime?.answerDraftOrchestrator.generateDraft({
    question: "What can Iris use?",
    liveChatMessages: [],
  });

  const promptContext = vi.mocked(model.generateAnswerDraft).mock.calls[0]?.[0].promptContext ?? "";
  expect(promptContext).toContain("Allowed text");
  expect(promptContext).not.toContain("Disabled text");
  expect(promptContext).not.toContain("Denied text");
  expect(promptContext).not.toContain("Stale text");
  expect(promptContext).not.toContain("Missing text");
  expect(promptContext).not.toContain("Error text");
  expect(result?.allowedFragments.map((item) => item.id)).toEqual(["fragment-allowed"]);
  expect(result?.deniedDocumentIds.sort()).toEqual([
    "source-denied",
    "source-disabled",
    "source-error",
    "source-missing",
    "source-stale",
  ]);
});
```

- [x] **Step 2: Verify red**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-runtime.test.ts
```

Expected: fail because `source-policy` config is unsupported or runtime dependency is missing.

- [x] **Step 3: Implement runtime policy**

In `apps/core/src/runtime/answer-draft-runtime.ts`:

- import `createPostgresDocumentSourceRegistry`;
- add optional dependency factory `createDocumentSourceRegistry`;
- create `sourceRegistry` from the same pool;
- pass `canReadDocument: createCanReadDocument({ permissionMode: runtimeConfig.permissionMode, sourceRegistry })`;
- implement `createCanReadDocument()` and `canReadBySourcePolicy()`.

Policy:

```ts
source !== undefined &&
source.canUseForAnswering &&
(source.permissionState === "unknown" || source.permissionState === "readable")
```

Errors return `false`.

- [x] **Step 4: Verify green**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-runtime.test.ts
```

Expected: pass.

### Task 3: Full Verification And PR Update

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run typecheck
npm test
python -m pytest
docker compose config
```

If root-level Python cannot import `iris_worker`, run `python -m pytest` from `workers/ai`.

- [x] **Step 2: Commit and push**

Run:

```powershell
git add docs/superpowers/specs/2026-07-03-iris-answer-draft-source-policy-permission-design.md docs/superpowers/plans/2026-07-03-iris-answer-draft-source-policy-permission.md apps/core/src/config/env.ts apps/core/tests/env.test.ts apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/answer-draft-runtime.test.ts
git commit -m "feat: add answer draft source policy permissions"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3V to PR #3:

```markdown
- Add Phase 3V answer draft source-policy permissions: local source policy guard for runtime document context before Feishu live checks are available.
```

## Self-Review

- Spec coverage: config, runtime resolver, deny states, testing, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: local answer runtime permission mode only; no Feishu API claims.
