# Iris Chat Knowledge Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a member of the approved Feishu pilot group explicitly ask `@Iris` to turn the recent group discussion into a governed knowledge draft that is shown to the group and can proceed through the existing review, approval, and Feishu Wiki publication flow.

**Architecture:** Keep the whitepaper boundaries unchanged. A narrow command adapter in the conversation layer recognizes an explicit knowledge-draft request, a generator uses only the latest authorized current-group messages as model context and evidence, and a coordinator writes the existing knowledge-draft facts before enqueueing the existing group-confirmation card. Existing action-policy, OAuth review, approval, publication, runtime, and permission gates remain authoritative.

**Tech Stack:** TypeScript, Fastify, Vitest, Postgres repositories, existing OpenAI-compatible model adapter, Feishu interactive cards, Docker Compose.

## Global Constraints

- The command must require an explicit `@Iris` mention and an explicit knowledge-draft or knowledge-base archival phrase.
- Never create a draft when global, group, or `generateKnowledgeDrafts` runtime permission is disabled.
- Use only recent messages from the same group as generation context and immutable evidence; do not silently include documents, memories, or another group.
- Default chat-created drafts to `medium` risk and the requesting Feishu user as reviewer.
- Require exactly one enabled publication policy matching the source group and medium risk before invoking the model.
- Creating the draft and card must be idempotent by Feishu message ID; a retry after a partial failure must resume without another model call or duplicate draft.
- No Wiki write occurs during draft creation. Publication remains behind group confirmation, current full-draft review, current approval facts, and `writeKnowledgeBase`.
- Preserve Context Anchor behavior: the latest 20 messages are chronological and isolated in `<live_chat_context>`.
- Model or parsing failure creates no draft and returns a bounded Chinese failure response.
- No new dependency and no architecture-whitepaper amendment.

---

### Task 1: Current-Group Knowledge Draft Generator

**Files:**
- Create: `apps/core/src/knowledge-governance/chat-knowledge-draft-generator.ts`
- Test: `apps/core/tests/chat-knowledge-draft-generator.test.ts`
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Test: `apps/core/tests/answer-draft-runtime.test.ts`

**Interfaces:**
- Consumes: `ConversationMessageRepository.listRecentByChat` and `ModelProvider.generateAnswerDraft`.
- Produces: `ChatKnowledgeDraftGenerator.generate(input): Promise<{ status: "generated"; title: string; content: string; evidence: KnowledgeDraftEvidenceReference[] } | { status: "no_context" }>`.

- [x] **Step 1: Write the failing generator tests**

```ts
it("generates from the latest same-group messages and returns matching evidence", async () => {
  const result = await generator.generate({
    chatId: "oc_pilot",
    requesterOpenId: "ou_owner",
    requestText: "把刚才讨论整理成知识草稿",
    observedAt: new Date("2026-08-02T01:00:00.000Z"),
  });
  expect(result).toMatchObject({
    status: "generated",
    title: "客户反馈看板上线范围",
    evidence: [
      { type: "conversation_message", id: "feishu:om_1", groupId: "oc_pilot" },
      { type: "conversation_message", id: "feishu:om_2", groupId: "oc_pilot" },
    ],
  });
});
```

Also assert no-context skips the model, the latest 20 messages stay chronological, messages after `observedAt` are excluded, malformed model output is rejected, and title/content bounds are enforced.

- [x] **Step 2: Run the test and verify RED**

Run: `npm --workspace apps/core test -- chat-knowledge-draft-generator.test.ts --reporter=dot`

Expected: FAIL because `chat-knowledge-draft-generator.ts` does not exist.

- [x] **Step 3: Implement the minimal generator**

Use `listRecentByChat({ chatId, limit: 60 })`, select the latest 20 nonblank messages at or before `observedAt`, reverse them to chronological order, and assemble an XML context with empty background sections. Ask the existing model for this exact envelope:

```text
TITLE: <one line, at most 256 characters>
CONTENT:
<grounded draft body>
```

Reject a response that lacks either exact marker, has a blank field, contains an overlong title/body, or includes text before `TITLE:`. Return evidence for exactly the selected messages.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `npm --workspace apps/core test -- chat-knowledge-draft-generator.test.ts answer-draft-runtime.test.ts --reporter=dot`

Expected: all focused tests pass.

### Task 2: Reusable Idempotent Group Presentation Service

**Files:**
- Create: `apps/core/src/knowledge-cards/knowledge-draft-presentation-service.ts`
- Test: `apps/core/tests/knowledge-draft-presentation-service.test.ts`
- Modify: `apps/core/src/knowledge-cards/knowledge-card-api.ts`
- Test: `apps/core/tests/knowledge-card-api.test.ts`

**Interfaces:**
- Consumes: `KnowledgeCardRuntime.repository`, `KnowledgeCardRuntime.canUseKnowledgeCards`, and the existing renderer.
- Produces: `presentKnowledgeDraft({ runtime, draftId, expectedVersion, operationKey, at })` with `applied | already_applied` outcome and the durable presentation.

- [x] **Step 1: Write failing service tests**

```ts
it("returns the existing presentation for an exact replay", async () => {
  const first = await presentKnowledgeDraft(input);
  const replay = await presentKnowledgeDraft(input);
  expect(first.outcome).toBe("applied");
  expect(replay).toEqual({ ...first, outcome: "already_applied" });
});
```

Also test runtime-disabled, missing draft, stale draft version, evidence-invalid, and operation-conflict behavior.

- [x] **Step 2: Run the test and verify RED**

Run: `npm --workspace apps/core test -- knowledge-draft-presentation-service.test.ts --reporter=dot`

Expected: FAIL because the service does not exist.

- [x] **Step 3: Extract the existing API behavior into the service**

Move stable presentation ID generation, rendering, exact replay comparison, and repository creation out of the Fastify route. Keep HTTP status/error mapping in `knowledge-card-api.ts` unchanged.

- [x] **Step 4: Run service and API tests**

Run: `npm --workspace apps/core test -- knowledge-draft-presentation-service.test.ts knowledge-card-api.test.ts --reporter=dot`

Expected: all focused tests pass and existing API contracts remain unchanged.

### Task 3: Idempotent Chat Command Coordinator

**Files:**
- Create: `apps/core/src/knowledge-governance/chat-knowledge-draft-command.ts`
- Test: `apps/core/tests/chat-knowledge-draft-command.test.ts`

**Interfaces:**
- Consumes: the generator, `KnowledgeDraftRuntime`, `KnowledgeCardRuntime`, and `ActionApprovalRuntime.repository.listTargetPolicies`.
- Produces: `ChatKnowledgeDraftCommand.execute(input)` returning `created | already_created | runtime_disabled | no_context | target_unavailable`.

- [x] **Step 1: Write failing coordinator tests**

```ts
it("creates one medium-risk reviewed draft and one group presentation", async () => {
  const result = await command.execute({
    messageId: "om_command",
    chatId: "oc_pilot",
    requesterOpenId: "ou_owner",
    requestText: "整理成知识草稿",
    observedAt,
  });
  expect(result.status).toBe("created");
  expect(repository.createDraft).toHaveBeenCalledWith(expect.objectContaining({
    originKind: "user_requested",
    revision: expect.objectContaining({
      riskLevel: "medium",
      reviewer: { type: "feishu_user", ref: "ou_owner" },
      suggestedPublication: { spaceId: "spc_pilot", parentNodeToken: "wikcn_parent" },
    }),
  }));
});
```

Also assert runtime and policy gates run before the model, multiple matching policies fail closed, exact replay skips generation, and retry after presentation failure resumes from the existing draft.

- [x] **Step 2: Run the test and verify RED**

Run: `npm --workspace apps/core test -- chat-knowledge-draft-command.test.ts --reporter=dot`

Expected: FAIL because the coordinator does not exist.

- [x] **Step 3: Implement stable IDs and ordered side effects**

Derive draft ID and operation keys from SHA-256 of provider/message ID. Check `getDraft` before generation. Resolve exactly one enabled medium-risk policy for the group, generate content, create the draft, then call `presentKnowledgeDraft`. Never enable publication or write Wiki content here.

- [x] **Step 4: Run coordinator tests and verify GREEN**

Run: `npm --workspace apps/core test -- chat-knowledge-draft-command.test.ts --reporter=dot`

Expected: all coordinator tests pass.

### Task 4: Mention Command UX and Runtime Wiring

**Files:**
- Modify: `apps/core/src/conversation/feishu-mention-answer-responder.ts`
- Test: `apps/core/tests/feishu-mention-answer-responder.test.ts`
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Test: `apps/core/tests/event-worker-runtime.test.ts`
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/app-startup.test.ts` or the nearest existing app/runtime wiring test.

**Interfaces:**
- Consumes: optional `ChatKnowledgeDraftCommand` dependency.
- Produces: explicit Chinese/English command detection and bounded Chinese outcome replies.

- [x] **Step 1: Write failing responder tests**

```ts
it("handles an explicit knowledge-draft request before ordinary question answering", async () => {
  await responder.maybeRespond(mentioned("@_user_1 把刚才讨论整理成知识草稿"));
  expect(knowledgeDraftCommand.execute).toHaveBeenCalledTimes(1);
  expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
});
```

Also cover `归档到知识库`, ordinary knowledge-base questions that must not trigger, missing sender, disabled/unavailable command, no context, target unavailable, exact retry dedupe, and generation failure retry.

- [x] **Step 2: Run responder/runtime tests and verify RED**

Run: `npm --workspace apps/core test -- feishu-mention-answer-responder.test.ts event-worker-runtime.test.ts --reporter=dot`

Expected: FAIL because the responder dependency and command path are absent.

- [x] **Step 3: Implement command detection and wire existing runtimes**

Create the coordinator only when generator, draft runtime, card runtime, and action-approval runtime all exist. Pass it through the event-worker runtime into the responder. Return clear replies that state a draft is only pending confirmation and that no Wiki write has happened yet.

- [x] **Step 4: Run focused and complete verification**

Run:

```text
npm --workspace apps/core test -- chat-knowledge-draft-generator.test.ts knowledge-draft-presentation-service.test.ts chat-knowledge-draft-command.test.ts feishu-mention-answer-responder.test.ts event-worker-runtime.test.ts --reporter=dot
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
npm --workspace apps/core test -- --reporter=dot
git diff --check
```

Expected: all commands exit `0`.

### Task 5: Controlled Pilot Rollout and Real Feishu Acceptance

**Files:**
- Modify: `docs/runbooks/iris-internal-mvp-gray-checklist.md`
- Create: `docs/pull-requests/2026-08-02-iris-chat-knowledge-drafts.md`
- Append remotely: `/opt/iris/deployments.log`

**Interfaces:**
- Consumes: exact candidate SHA, successful Core/AI Worker CI, existing pilot group, existing authorized publication policy, and existing Feishu OAuth redirect.
- Produces: one real, fully governed knowledge publication and a restored healthy daily-pilot state.

- [ ] **Step 1: Publish the candidate**

Commit intentionally, push `codex/iris-chat-knowledge-drafts`, open a draft PR, and require Core and AI Worker checks to pass for the exact SHA.

- [ ] **Step 2: Enter fail-closed deployment state**

Back up `.env.pilot`, durably disable global Iris, stop Caddy, and verify all event/document/reindex/memory/knowledge/action/proactive pending, processing, delayed, outcome-unknown, terminal-failure, and DLQ counts are zero.

- [ ] **Step 3: Enable only the existing governed pilot scope**

Set the action/card/review environment gates to the original pilot group only, preserve all non-pilot groups disabled, recreate Core and AI Worker at the exact candidate SHA, and require private readiness to pass before restoring Caddy.

- [ ] **Step 4: Run one real user-visible loop**

In the original pilot group, send a clearly labeled test discussion followed by `@Iris 把刚才讨论整理成知识草稿`. Confirm exactly one draft card appears. Complete group confirmation, full-draft OAuth review, current owner approval, and exactly one publication beneath the authorized Wiki target. Verify the group receives the bounded publication result.

The first live attempt reached one successful Wiki publication but exposed a missing final group
projection: the original card stayed at `confirmed`. Acceptance therefore remains open. The fix
must enqueue an ordered, durable `published` update and prove that replaying this projection does
not create another Wiki node.

- [ ] **Step 5: Verify and record exit evidence**

Confirm exact image SHA parity, public `/health=200`, public `/internal/*=404`, no non-pilot effects, one publication fact, no duplicate node, and every queue/DLQ/outcome-unknown/terminal-failure count at zero. Update the PR and deployment log with content-free identifiers and retain the pilot only if every gate passes; otherwise restore the backed-up environment and previous images.
