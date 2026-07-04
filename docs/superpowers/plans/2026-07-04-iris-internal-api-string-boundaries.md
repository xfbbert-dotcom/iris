# Iris Internal API String Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject oversized internal API strings before they reach runtime, audit, queue, or document
source code.

**Architecture:** Keep all validation in `apps/core/src/app.ts`. Add bounded string readers for
short internal identifiers/labels and source URIs, then wire existing parsers through those readers.

**Tech Stack:** TypeScript, Fastify app injection tests, Vitest.

---

### Task 1: Write Failing Boundary Tests

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add oversized answer draft chat ID test**

Add a test under `POST /internal/answer-drafts` that calls:

```ts
const answerDraftOrchestrator = { generateDraft: vi.fn() };
const app = buildApp({ answerDraftOrchestrator });

const response = await app.inject({
  method: "POST",
  url: "/internal/answer-drafts",
  payload: {
    question: "What changed?",
    chatId: "c".repeat(513),
    liveChatMessages: [],
  },
});

expect(response.statusCode).toBe(400);
expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
```

- [x] **Step 2: Add oversized document source filter test**

Add a test under `document sync source inventory API` that calls:

```ts
const runtime = fakeDocumentSyncRuntime();
const app = buildApp({
  createAnswerDraftRuntime: () => undefined,
  createDocumentSyncRuntime: () => runtime,
});

const response = await app.inject({
  method: "GET",
  url: `/internal/document-sync/sources?groupId=${"g".repeat(513)}`,
});

expect(response.statusCode).toBe(400);
expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
expect(runtime.sources.list).not.toHaveBeenCalled();
```

- [x] **Step 3: Add oversized source registration title test**

Add a test under the document source registration describe block that posts an otherwise valid
authorized wiki registration with `title: "t".repeat(513)` and expects:

```ts
expect(response.statusCode).toBe(400);
expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
expect(runtime.registerAuthorizedWikiDocument).not.toHaveBeenCalled();
```

- [x] **Step 4: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts -t "oversized"
```

Expected: the new tests fail because oversized strings are currently accepted by `readNonBlankId`.

Observed: the three focused tests failed with `expected 200 to be 400`.

### Task 2: Implement Bounded Internal API String Readers

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Add constants and bounded readers**

Add:

```ts
const maxInternalStringLength = 512;
const maxInternalSourceUriLength = 2048;

function readNonBlankBoundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}
```

- [x] **Step 2: Route existing ID reader through the bounded helper**

Change `readNonBlankId` to:

```ts
function readNonBlankId(value: unknown): string | undefined {
  return readNonBlankBoundedString(value, maxInternalStringLength);
}
```

- [x] **Step 3: Read source URIs with the wider source URI limit**

In `parseRegisterAuthorizedWikiDocumentRequest` and `parseRegisterUserSubmittedDocumentRequest`,
replace `readNonBlankId(value.sourceUri)` with:

```ts
readNonBlankBoundedString(value.sourceUri, maxInternalSourceUriLength)
```

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts -t "oversized"
```

Expected: the oversized-string tests pass.

Observed: the three focused oversized-string tests passed.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-internal-api-string-boundaries-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-internal-api-string-boundaries.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core 753 passed / 4 skipped, Python 7 passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the internal API string boundary update, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `61996c7`, pushed to `codex/iris-document-source-registry`, updated PR #3, and
confirmed GitHub Actions Core and AI Worker checks passed.
