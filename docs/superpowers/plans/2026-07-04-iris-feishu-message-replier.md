# Iris Feishu Message Replier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a focused Feishu text reply adapter for Iris group-message replies.

**Architecture:** Create a new `FeishuMessageReplier` outbound adapter under `apps/core/src/feishu`. It uses the existing tenant-token provider, validates inputs, posts a text reply to Feishu's message reply endpoint, and checks Feishu response codes.

**Tech Stack:** TypeScript, Vitest, Fetch API, existing Feishu token provider patterns.

---

### Task 1: Add Feishu Text Reply Adapter

**Files:**
- Create: `apps/core/tests/feishu-message-replier.test.ts`
- Create: `apps/core/src/feishu/feishu-message-replier.ts`

- [x] **Step 1: Write failing request-shape test**

Create a test that calls `replyText` and asserts:

- the tenant token is requested once;
- the URL is `/open-apis/im/v1/messages/om_1/reply`;
- the body contains `msg_type: "text"` and serialized `content: "{\"text\":\"Hello\"}"`;
- the returned value includes the Feishu reply message id.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-message-replier.test.ts
```

Expected: the test fails because `feishu-message-replier.ts` does not exist yet.

Observed: the focused test failed because `../src/feishu/feishu-message-replier.js` did not exist.

- [x] **Step 3: Implement minimal successful adapter**

Create `createFeishuMessageReplier` with `replyText(input)`:

```typescript
export type FeishuMessageReplier = {
  replyText(input: {
    messageId: string;
    text: string;
    uuid?: string;
    replyInThread?: boolean;
  }): Promise<{ replyMessageId?: string }>;
};
```

Use `POST ${baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`.

- [x] **Step 4: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-message-replier.test.ts
```

Expected: the first reply adapter test passes.

Observed: the first focused reply adapter test passed.

### Task 2: Harden Adapter Boundaries

**Files:**
- Modify: `apps/core/tests/feishu-message-replier.test.ts`
- Modify: `apps/core/src/feishu/feishu-message-replier.ts`

- [x] **Step 1: Add boundary tests**

Add tests for:

- trailing slash base URL normalization;
- optional `reply_in_thread` and `uuid`;
- blank message IDs and text rejected before token acquisition;
- oversized message IDs, text, and uuid rejected before token acquisition;
- HTTP non-OK errors;
- Feishu non-zero code errors;
- missing Feishu code errors;
- malformed JSON errors;
- request timeout and aborted JSON body read timeout;
- invalid timeout configuration.

- [x] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-message-replier.test.ts
```

Expected: the new boundary tests fail because the minimal adapter lacks these validations.

Observed: focused tests failed on optional request fields, input validation, HTTP and Feishu code
errors, JSON errors, timeout mapping, and invalid timeout configuration.

- [x] **Step 3: Implement boundary handling**

Add input guards, timeout handling with `AbortController`, JSON parsing errors, `response.ok`
checks, `code === 0` checks, and bounded error messages through `readExternalErrorMessage`.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-message-replier.test.ts
```

Expected: all Feishu message replier tests pass.

Observed: focused Feishu message replier tests passed with `16` tests.

### Task 3: Verify and Publish

**Files:**
- Modify: `docs/superpowers/specs/2026-07-04-iris-feishu-message-replier-design.md`
- Modify: `docs/superpowers/plans/2026-07-04-iris-feishu-message-replier.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `837` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, update PR, and verify checks**

Commit the Feishu message replier patch, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `4f5606ba`, pushed `codex/iris-document-source-registry`, updated PR #3, and
confirmed GitHub Actions Core and AI Worker checks passed for HEAD
`4f5606ba91eb3de7b784c419a0f0c845986ca5c4`.
