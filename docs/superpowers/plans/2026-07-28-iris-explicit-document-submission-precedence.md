# Iris Explicit Document Submission Precedence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an explicit Feishu document-submission command canonical as `user_submitted_document` when generic discovery observes the same URI in the same message.

**Architecture:** Add optional chat/message provenance to user-submission evidence and centralize source-type merging in one deterministic function shared by the in-memory and Postgres registries. Preserve the existing global precedence whenever a group observation is independent, and preserve authorized wiki priority unconditionally.

**Tech Stack:** TypeScript, Vitest, PostgreSQL, existing Feishu event worker and document source registries.

## Global Constraints

- Preserve global source precedence: authorized wiki, group visible, user submitted.
- A same-message match requires identical canonical URI, nonblank group ID, and nonblank message ID.
- Keep evidence append-only and idempotent.
- Do not change retrieval scope, permission guards, runtime enablement, or database schema.
- Keep production fail-closed until the bounded pilot acceptance is complete.

---

### Task 1: Lock The Registry Contract With Failing Tests

**Files:**
- Modify: `apps/core/tests/document-source-registry.test.ts`
- Modify: `apps/core/tests/postgres-document-source-registry.test.ts`

**Interfaces:**
- Consumes: `registerUserSubmittedDocument()` and `registerGroupVisibleDocument()`.
- Produces: regression coverage for order-independent same-message precedence.

- [ ] **Step 1: Add the in-memory user-first regression**

Register a user submission with `submissionGroupId: "group-1"` and
`submissionMessageId: "message-1"`, then register group discovery with the same
URI/group/message. Assert one source, type `user_submitted_document`, and two
distinct evidence rows.

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```powershell
npm --workspace apps/core test -- tests/document-source-registry.test.ts
```

Expected: TypeScript or assertion failure because submission provenance is not
supported and the source becomes `group_visible_document`.

- [ ] **Step 3: Add reverse-order, retry, independent-group, and authorized-wiki cases**

Use hand-written literal expectations:

- group-first then matching user submission ends as user submitted;
- retrying both calls keeps exactly two evidence rows;
- a later ordinary group message ends as group visible;
- authorized wiki remains authorized.

- [ ] **Step 4: Add equivalent Postgres integration cases**

Under `runIfDatabase`, exercise the real migrated tables in both registration
orders and assert source type plus exact evidence count.

### Task 2: Add Provenance And Deterministic Merge Behavior

**Files:**
- Modify: `apps/core/src/documents/document-source-registry.ts`
- Modify: `apps/core/src/documents/postgres-document-source-registry.ts`

**Interfaces:**
- Consumes:
  `RegisterUserSubmittedDocumentInput.submissionGroupId?: string` and
  `submissionMessageId?: string`.
- Produces:
  `mergeDocumentSourceType(existingType, nextType, existingEvidence, nextEvidence)`.

- [ ] **Step 1: Validate optional submission provenance**

Normalize both fields. Throw `DocumentSourceValidationError` when only one is
present. Store both on `user_submission` evidence, while leaving source-level
`originGroupId` and `originMessageId` unchanged.

- [ ] **Step 2: Implement the shared merge function**

Return authorized wiki whenever either type is authorized. For a user/group
merge, combine existing and incoming evidence and retain user-submitted only
when every group-message row has a matching user-submission row for the same
URI/group/message. Otherwise delegate to the unchanged global priority helper.

- [ ] **Step 3: Use the function in the in-memory registry**

Replace the direct priority merge in `registerSource()` with the evidence-aware
function.

- [ ] **Step 4: Use the function in the Postgres registry**

After locking the source row, read its evidence inside the same transaction,
calculate the merged type with the shared function, then update and append the
incoming evidence as before.

- [ ] **Step 5: Run focused registry tests and observe GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/document-source-registry.test.ts tests/postgres-document-source-registry.test.ts
```

Expected: PASS, including database-backed cases when `DATABASE_URL` is set.

### Task 3: Forward Feishu Event Provenance

**Files:**
- Modify: `apps/core/tests/feishu-mention-answer-responder.test.ts`
- Modify: `apps/core/src/conversation/feishu-mention-answer-responder.ts`

**Interfaces:**
- Consumes: `FeishuMentionAnswerInput.chatId` and `messageId`.
- Produces: a user-submission registration carrying both provenance fields.

- [ ] **Step 1: Change the responder expectation and observe RED**

Require the registration input to include:

```typescript
submissionGroupId: "chat-1",
submissionMessageId: "message-1",
```

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-mention-answer-responder.test.ts
```

Expected: FAIL because the responder does not forward the fields.

- [ ] **Step 2: Forward the two fields**

Add `input.chatId` and `input.messageId` to the existing registration call. Do
not change command detection, reply wording, or model bypass behavior.

- [ ] **Step 3: Run the responder and event-worker suites**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-mention-answer-responder.test.ts tests/feishu-message-event-processor.test.ts tests/event-worker-runtime.test.ts tests/document-sync-runtime.test.ts
```

Expected: PASS.

### Task 4: Verify, Publish, And Re-run The Pilot

**Files:**
- Modify: `docs/runbooks/iris-user-submitted-document-acceptance.md`
- Modify: `docs/operations/engineering-failure-ledger.md`

**Interfaces:**
- Consumes: the candidate commit and production fail-closed deployment scripts.
- Produces: CI evidence and one bounded real Feishu acceptance result.

- [ ] **Step 1: Run local verification**

Run focused tests, Core typecheck, Core build, and the repository's normal CI
commands. Confirm the worktree contains only intended files.

- [ ] **Step 2: Commit and push the branch**

Commit the design/plan separately from behavior where practical, push
`codex/iris-user-document-gray`, and verify PR #17 Core and AI Worker checks
reach success.

- [ ] **Step 3: Re-run production preflight**

Confirm approved/candidate commit identity, global and group disable state,
proactive speech disabled, Caddy stopped, all services healthy, and all queues
and DLQs empty. Abort and restore fail-closed on any mismatch.

- [ ] **Step 4: Deploy and run one bounded pilot submission**

Use a fresh document/marker, enable only the pilot group behind an automatic
close timer, submit one explicit command, and verify:

- source type is `user_submitted_document`;
- one matching `user_submission` and one matching `group_message` evidence row;
- sync and indexing are healthy;
- exact marker retrieval succeeds;
- queues and DLQs are empty.

- [ ] **Step 5: Restore fail-closed and record evidence**

Set global and desired global false, disable all known groups, stop Caddy,
cancel the timer, verify health/queues again, and update the runbook, failure
ledger, deployment log, and PR #17 acceptance comment.
