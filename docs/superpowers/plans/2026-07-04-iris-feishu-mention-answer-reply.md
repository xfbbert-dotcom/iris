# Iris Feishu Mention Answer Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire explicit @Iris Feishu group mentions to answer drafting and Feishu text replies.

**Architecture:** Add a focused `FeishuMentionAnswerResponder` that owns mention detection, question cleanup, answer drafting, and reply dispatch. The message event processor passes parsed mention metadata to the responder after storing facts. The event worker runtime composes the responder only when all required env and runtime dependencies exist.

**Tech Stack:** TypeScript, Vitest, existing raw-event worker, answer-draft orchestrator, Feishu message replier, and runtime-control modules.

---

### Task 1: Add Mention Answer Responder

**Files:**
- Create: `apps/core/src/conversation/feishu-mention-answer-responder.ts`
- Create: `apps/core/tests/feishu-mention-answer-responder.test.ts`

- [x] **Step 1: Write failing responder tests**

Cover:

- bot mention triggers answer drafting and replies with a stable `iris-` UUID;
- non-bot mentions skip;
- disabled runtime gate skips;
- blank mention sends clarification without calling the model.

- [x] **Step 2: Run focused responder tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-mention-answer-responder.test.ts
```

Expected: tests fail because the responder does not exist.

- [x] **Step 3: Implement responder**

Create `createFeishuMentionAnswerResponder` with `maybeRespond(input)` returning
`"replied" | "skipped"`. Use the configured bot open ID, strip only Iris mention keys, call
`answerDraftOrchestrator.generateDraft`, and reply with `FeishuMessageReplier.replyText`.

- [x] **Step 4: Run focused responder tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-mention-answer-responder.test.ts
```

Expected: responder tests pass.

### Task 2: Pass Mentions Through Message Processor

**Files:**
- Modify: `apps/core/src/conversation/feishu-message-event-processor.ts`
- Modify: `apps/core/tests/feishu-message-event-processor.test.ts`

- [x] **Step 1: Write failing processor integration tests**

Cover:

- parsed Feishu `mentions` are passed to `mentionAnswerResponder.maybeRespond`;
- document reading disabled still allows mention response after message fact storage;
- disabled incoming event or disabled group context does not call responder.

- [x] **Step 2: Run focused processor tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-message-event-processor.test.ts
```

Expected: new tests fail because the processor does not parse or pass mentions yet.

- [x] **Step 3: Implement processor mention passing**

Extend parsed message context with `mentions`, keep storage input unchanged, and call the responder
after message upsert and best-effort document discovery gating.

- [x] **Step 4: Run focused processor tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-message-event-processor.test.ts
```

Expected: processor tests pass.

### Task 3: Compose Runtime Wiring

**Files:**
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/tests/env.test.ts`
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Modify: `apps/core/tests/event-worker-runtime.test.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Write failing config and runtime tests**

Cover:

- `IRIS_FEISHU_BOT_OPEN_ID` trims when present and is optional when absent;
- event runtime composes a responder only when bot open ID, Feishu OpenAPI config, and an answer
  orchestrator are available;
- event runtime does not compose a responder when any required dependency is missing.

- [x] **Step 2: Run focused config/runtime tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/env.test.ts tests/event-worker-runtime.test.ts
```

Expected: tests fail because config and runtime composition do not exist.

- [x] **Step 3: Implement runtime composition**

Add optional bot open ID config, create Feishu token provider and replier in event runtime, create
the mention responder, pass it into the processor, and pass `answerDraftOrchestrator` from `app.ts`
into event worker runtime.

- [x] **Step 4: Run focused config/runtime tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/env.test.ts tests/event-worker-runtime.test.ts
```

Expected: config and runtime tests pass.

### Task 4: Verify and Publish

**Files:**
- Modify: `docs/operations/internal-rollout-runbook.md`
- Modify: `docs/superpowers/specs/2026-07-04-iris-feishu-mention-answer-reply-design.md`
- Modify: `docs/superpowers/plans/2026-07-04-iris-feishu-mention-answer-reply.md`

- [x] **Step 1: Update rollout runbook**

Document `IRIS_FEISHU_BOT_OPEN_ID` and mention-triggered reply behavior.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 on 2026-07-04. Core passed 58 test files
with 848 tests passing and 4 skipped; Python worker tests passed 7/7; Docker Compose config rendered
successfully.

- [x] **Step 3: Commit, push, update PR, and verify checks**

Commit the mention reply patch, push `codex/iris-document-source-registry`, update PR #3, and
confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed and pushed `84cd784b95c2e20e28d54cb91aad15de7fbb42ec`, updated PR #3, and
confirmed GitHub Actions `Core` and `AI Worker` check runs completed successfully.
