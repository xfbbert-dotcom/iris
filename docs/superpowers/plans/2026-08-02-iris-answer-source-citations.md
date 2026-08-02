# Iris Answer Source Citations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add visible, deterministic Iris document citations and a durable, permission-safe answer receipt to ordinary Feishu mention replies.

**Architecture:** The existing answer orchestrator remains responsible for retrieval, the first real-time permission guard, and model sampling. TypeScript Core renders citations only from `allowedFragments`, prepares an immutable PostgreSQL receipt, rechecks every unique source immediately before each Feishu send attempt, and resumes retries from stored text instead of sampling again. The existing Redis raw-event worker and deterministic Feishu UUID remain the retry and external-idempotency boundary.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Redis raw-event worker, Feishu OpenAPI, Vitest, Node.js `crypto`

## Global Constraints

- Preserve the modular-monolith boundaries in `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`.
- Follow the approved design in `docs/superpowers/specs/2026-08-02-iris-answer-source-citations-design.md`.
- The model writes only the answer body; it never writes or numbers the citation footer.
- The visible footer label is exactly `Iris 参考资料：`, never Feishu's native `相关知识` label.
- Show at most three unique documents in first-permitted-fragment order, while tracing every permitted fragment.
- Source labels are exactly `知识库`, `群文档`, and `用户文档`.
- The complete Feishu text reply must be at most 8,000 characters and must never cut a citation footer in half.
- Only canonical HTTPS Feishu wiki/docx URLs may enter a visible citation or durable source trace.
- Permission denial and permission-check errors are fail-closed and must never send sourced answer text.
- A retry of a prepared ordinary answer must not call the model a second time.
- Existing capacity, invalid-response, and blank-answer fallbacks remain direct, deterministic, uncited replies without answer receipts.
- Do not store prompts, fragment text, message text, credentials, provider bodies, or model answer text in immutable trace/event rows.
- `answer_reply_source_traces` and `answer_reply_delivery_events` are append-only; prepared answer text is cleared after send or permission block.
- Do not change proactive-speech, knowledge-publication, retrieval-ranking, chunking, or embedding behavior.
- Keep every quality gate bounded. Move non-blocking hardening findings to follow-up work after the agreed acceptance gates pass.
- Do not merge the pull request without a separate explicit user decision.

## File Map

- `apps/core/src/documents/document-fragment-repository.ts`: attach source title/type to retrieval-only fragment results.
- `apps/core/src/answer-replies/answer-source-citation-renderer.ts`: pure canonicalization, citation rendering, body budgeting, and trace construction.
- `apps/core/src/answer-replies/answer-reply-repository.ts`: answer-delivery domain types, repository interface, errors, and deterministic identifiers.
- `apps/core/src/answer-replies/postgres-answer-reply-repository.ts`: transactional PostgreSQL state machine and inspection reads.
- `apps/core/src/answer-replies/answer-source-permission-verifier.ts`: narrow source recheck contract and fail-closed fallback verifier.
- `apps/core/src/answer-replies/answer-reply-delivery-service.ts`: prepare/resume/send/block/safe-notice orchestration.
- `apps/core/src/answer-replies/answer-reply-api.ts`: content-free internal receipt inspection endpoint.
- `apps/core/src/runtime/answer-draft-runtime.ts`: expose the verifier backed by the existing source policy and Feishu checker.
- `apps/core/src/conversation/feishu-mention-answer-responder.ts`: route only ordinary answers through the durable service.
- `apps/core/src/runtime/event-worker-runtime.ts`: own the answer repository/service and share the existing Postgres lifecycle.
- `apps/core/src/app.ts`: pass the verifier and register the internal inspection API.
- `apps/core/migrations/0045_answer_source_citations.sql`: durable answer, source-trace, and lifecycle-event schema.
- `scripts/pilot-smoke.mjs`: explicitly prove the new internal path remains hidden at the public Caddy boundary.
- `docs/runbooks/iris-answer-source-citations-acceptance.md`: bounded operator and real-Feishu acceptance procedure.
- `docs/pull-requests/2026-08-02-iris-answer-source-citations.md`: implementation and deployment evidence for the draft PR.

---

### Task 1: Carry Source Metadata Through Retrieval

**Files:**
- Modify: `apps/core/src/documents/document-fragment-repository.ts`
- Modify: `apps/core/tests/document-fragment-repository.test.ts`
- Modify: `apps/core/tests/document-retrieval-context.test.ts`
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

**Interfaces:**
- Consumes: existing `document_sources ds` join in `searchSimilarFragments()`
- Produces:

```ts
export type RetrievedDocumentFragment = DocumentFragment & {
  sourceTitle?: string;
  sourceType: RetrievedDocumentSourceType;
  distance?: number;
};

export type RetrievedDocumentSourceType =
  | "feishu_group_document"
  | "feishu_wiki"
  | "manual_upload";
```

- [ ] **Step 1: Write a failing retrieval-metadata test**

Add a test whose fake query returns one row with `source_title` and `source_type`:

```ts
{
  id: "fragment-1",
  document_source_id: "source-1",
  document_snapshot_id: "snapshot-1",
  source_uri: "https://example.feishu.cn/wiki/wikcnSource1",
  source_title: " Quello Life Engine ",
  source_type: "authorized_wiki_document",
  chunk_index: 0,
  text: "Life Engine context",
  content_hash: "a".repeat(64),
  embedding: "[1,0,0,0,0,0]",
  embedding_profile_id: "static-dev-6d",
  created_at: new Date("2026-08-02T02:00:00.000Z"),
  distance: "0.125",
}
```

Assert that the SQL contains `ds.title as source_title` and `ds.source_type`, and that the mapped result contains `sourceTitle: "Quello Life Engine"`, `sourceType: "feishu_wiki"`, and `distance: 0.125`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm exec --workspace apps/core -- vitest run tests/document-fragment-repository.test.ts
```

Expected: the new assertion fails because retrieval rows do not expose title/type.

- [ ] **Step 3: Select and validate retrieval-only metadata**

Extend `RetrievedDocumentFragmentRow` with:

```ts
source_title: string | null;
source_type: DocumentSourceType;
```

Select the two columns beside `f.*`, then trim and bound the title and map the persisted
registry type into the retrieval-only vocabulary with an exhaustive table:

```ts
const RETRIEVED_SOURCE_TYPE_BY_PERSISTED_SOURCE_TYPE: Record<
  DocumentSourceType,
  RetrievedDocumentSourceType
> = {
  group_visible_document: "feishu_group_document",
  authorized_wiki_document: "feishu_wiki",
  user_submitted_document: "manual_upload",
};
```

Reject a source type outside the three `DocumentSourceType` values and a title longer than the existing `DOCUMENT_SOURCE_METADATA_MAX_CHARS` boundary instead of silently passing corrupt metadata downstream.

Update the two shared `fragment()` test fixtures to default to:

```ts
sourceType: "feishu_wiki",
```

Individual source-policy tests may override that value with `feishu_group_document` or
`manual_upload`. Do not make production `sourceType` optional to preserve old fixtures.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command.

Expected: all document-fragment repository tests pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/core/src/documents/document-fragment-repository.ts apps/core/tests/document-fragment-repository.test.ts apps/core/tests/document-retrieval-context.test.ts apps/core/tests/answer-draft-runtime.test.ts
git commit -m "feat(core): carry answer source metadata"
```

---

### Task 2: Render Deterministic Citations And Immutable Trace Inputs

**Files:**
- Create: `apps/core/src/answer-replies/answer-source-citation-renderer.ts`
- Create: `apps/core/tests/answer-source-citation-renderer.test.ts`

**Interfaces:**
- Consumes: `RetrievedDocumentFragment[]` after the existing permission guard
- Produces:

```ts
export type AnswerReplySourceTraceInput = {
  promptRank: number;
  citationRank?: number;
  documentSourceId: string;
  documentSnapshotId: string;
  fragmentId: string;
  chunkIndex: number;
  sourceType: RetrievedDocumentSourceType;
  sourceUri: string;
  sourceTitle?: string;
  contentHash: string;
  embeddingProfileId: string;
  initialPermissionCheckedAt: Date;
};

export function renderAnswerWithSourceCitations(input: {
  answerText: string;
  allowedFragments: readonly RetrievedDocumentFragment[];
  initialPermissionCheckedAt: Date;
}): {
  renderedText: string;
  sourceTraces: AnswerReplySourceTraceInput[];
};
```

- [ ] **Step 1: Write failing ordering, deduplication, and trace tests**

Create fragments in this order: wiki A chunk 2, group B chunk 0, wiki A chunk 3, user C chunk 0, wiki D chunk 0. Assert:

```ts
expect(result.renderedText).toContain(
  "Iris 参考资料：\n" +
  "[1] [知识库] Wiki A\nhttps://tenant.feishu.cn/wiki/wikiA\n" +
  "[2] [群文档] Group B\nhttps://tenant.feishu.cn/docx/docB\n" +
  "[3] [用户文档] User C\nhttps://tenant.feishu.cn/docx/docC",
);
expect(result.renderedText).not.toContain("Wiki D");
expect(result.sourceTraces).toHaveLength(5);
expect(result.sourceTraces.map((trace) => trace.promptRank)).toEqual([1, 2, 3, 4, 5]);
expect(result.sourceTraces.map((trace) => trace.citationRank)).toEqual([1, 2, 1, 3, undefined]);
expect(JSON.stringify(result.sourceTraces)).not.toContain("Life Engine context");
```

- [ ] **Step 2: Write failing boundary tests**

Cover all of these named cases:

```ts
it("omits the footer and traces when no document fragments were allowed");
it("normalizes query and fragment parts out of canonical Feishu URLs");
it("rejects HTTP, credential-bearing, non-Feishu, and malformed source URLs");
it("rejects conflicting URI, title, or source type metadata for one document ID");
it("uses 飞书文档 when the registered title is blank");
it("truncates a visible title to 120 characters with the shared marker");
it("reserves the footer before truncating an 8000-character answer body");
it("keeps the maximum valid bounded footer within 8000 characters");
```

For the length test, assert `renderedText.length <= 8000`, the text ends with the complete final URL, and the body contains ` ... [truncated]`.
The maximum valid footer cannot exceed 8,000 characters because only three sources are
visible, each canonical URI is already bounded to 2,048 characters, and each visible
title is bounded to 120 characters. Prove that invariant with maximum-valid inputs;
do not use an invalid overlong URI as evidence for the footer-overflow branch.

- [ ] **Step 3: Run the renderer tests and verify RED**

Run:

```powershell
npm exec --workspace apps/core -- vitest run tests/answer-source-citation-renderer.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 4: Implement the pure renderer**

Use `normalizeFeishuDocumentSourceUri()` from `feishu-document-body-fetcher.ts`; do not add a second URL parser. Normalize every fragment before grouping, require metadata consistency for duplicate `documentSourceId` values, reject source-type values that are not own keys in the exact label map, and map labels exactly:

```ts
const SOURCE_LABELS: Record<RetrievedDocumentSourceType, string> = {
  feishu_wiki: "知识库",
  feishu_group_document: "群文档",
  manual_upload: "用户文档",
};
```

Use these exact bounds:

```ts
const MAX_REPLY_CHARS = 8000;
const MAX_VISIBLE_SOURCES = 3;
const MAX_VISIBLE_TITLE_CHARS = 120;
const TRUNCATION_MARKER = " ... [truncated]";
```

Build the footer first, reserve `footer.length + 2` characters for `\n\n`, and truncate only the answer body. The returned source trace must copy only IDs, bounded metadata, hashes, ranks, and the supplied check timestamp.
Keep the full normalized, registry-bounded title in the immutable trace; apply the
120-character display truncation only while building visible footer lines.

- [ ] **Step 5: Run the renderer tests and verify GREEN**

Run the Step 3 command.

Expected: every renderer test passes.

- [ ] **Step 6: Commit**

```powershell
git add apps/core/src/answer-replies/answer-source-citation-renderer.ts apps/core/tests/answer-source-citation-renderer.test.ts
git commit -m "feat(core): render deterministic answer citations"
```

---

### Task 3: Add The Durable Answer Delivery State Machine

**Files:**
- Create: `apps/core/migrations/0045_answer_source_citations.sql`
- Create: `apps/core/src/answer-replies/answer-reply-repository.ts`
- Create: `apps/core/src/answer-replies/postgres-answer-reply-repository.ts`
- Create: `apps/core/tests/postgres-answer-reply-repository.test.ts`
- Modify: `apps/core/tests/migration-runner.test.ts`

**Interfaces:**
- Consumes: `AnswerReplySourceTraceInput[]` from Task 2 and a Postgres data source with `connect()`
- Produces:

```ts
export type AnswerReplyDeliveryState =
  | "prepared"
  | "sending"
  | "sent"
  | "permission_blocked"
  | "reconciliation_required";

export type AnswerReplyProvider = "feishu";

export type AnswerReplyDelivery = {
  id: string;
  provider: AnswerReplyProvider;
  incomingMessageId: string;
  chatId: string;
  replyUuid: string;
  safeNoticeUuid: string;
  state: AnswerReplyDeliveryState;
  preparedReplyText?: string;
  renderedReplyFingerprint: string;
  semanticFingerprint: string;
  replyMessageId?: string;
  safeNoticeMessageId?: string;
  attemptCount: number;
  safeNoticeAttemptCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  lastSendStartedAt?: Date;
  sentAt?: Date;
  permissionBlockedAt?: Date;
  reconciliationRequiredAt?: Date;
  safeNoticeSentAt?: Date;
};

export type AnswerReplySourceTrace = AnswerReplySourceTraceInput & {
  id: string;
  deliveryId: string;
};

export type AnswerReplyDeliveryEventType =
  | "prepared"
  | "send_started"
  | "sent"
  | "permission_blocked"
  | "reconciliation_required"
  | "safe_notice_send_started"
  | "safe_notice_sent";

export type AnswerReplyDeliveryEvent = {
  id: string;
  deliveryId: string;
  sequence: number;
  eventType: AnswerReplyDeliveryEventType;
  attemptNumber?: number;
  sourceCount: number;
  documentSourceIds: string[];
  createdAt: Date;
};

export type AnswerReplyReceipt = {
  delivery: AnswerReplyDelivery;
  sources: AnswerReplySourceTrace[];
  events: AnswerReplyDeliveryEvent[];
};

export type PrepareAnswerReplyInput = {
  provider: AnswerReplyProvider;
  incomingMessageId: string;
  chatId: string;
  replyUuid: string;
  safeNoticeUuid: string;
  renderedText: string;
  sourceTraces: readonly AnswerReplySourceTraceInput[];
  at: Date;
};

export type VersionedTransitionInput = {
  deliveryId: string;
  expectedVersion: number;
  at: Date;
};

export type AnswerReplyRepositoryStatus = {
  unresolvedCount: number;
  pendingSafeNoticeCount: number;
  reconciliationRequiredCount: number;
};

export interface AnswerReplyRepository {
  findByIncomingMessage(input: {
    provider: AnswerReplyProvider;
    incomingMessageId: string;
  }): Promise<AnswerReplyReceipt | undefined>;
  prepare(input: PrepareAnswerReplyInput): Promise<{
    outcome: "applied" | "already_applied";
    receipt: AnswerReplyReceipt;
  }>;
  beginAnswerSend(input: VersionedTransitionInput): Promise<AnswerReplyReceipt>;
  completeAnswerSend(input: VersionedTransitionInput & {
    replyMessageId?: string;
  }): Promise<AnswerReplyReceipt>;
  blockForPermission(input: VersionedTransitionInput & {
    documentSourceIds: string[];
  }): Promise<AnswerReplyReceipt>;
  beginSafeNoticeSend(input: VersionedTransitionInput): Promise<AnswerReplyReceipt>;
  completeSafeNoticeSend(input: VersionedTransitionInput & {
    safeNoticeMessageId?: string;
  }): Promise<AnswerReplyReceipt>;
  getStatus(): Promise<AnswerReplyRepositoryStatus>;
}
```

- [ ] **Step 1: Write the failing migration-contract test**

Read `0045_answer_source_citations.sql` and assert it defines:

```text
answer_reply_deliveries
answer_reply_source_traces
answer_reply_delivery_events
unique (provider, incoming_message_id)
prepared_reply_text
rendered_reply_fingerprint
semantic_fingerprint
attempt_count
safe_notice_attempt_count
version
answer_reply_source_traces_append_only
answer_reply_delivery_events_append_only
```

Assert source traces have no `text`, `fragment_text`, `prompt`, or `answer_text` column and delivery events have no free-form content column.

- [ ] **Step 2: Run the migration test and verify RED**

Run:

```powershell
npm exec --workspace apps/core -- vitest run tests/migration-runner.test.ts
```

Expected: file-not-found failure for migration `0045`.

- [ ] **Step 3: Add the constrained migration**

Create the three tables with these state/event enums:

```sql
CHECK (state IN (
  'prepared', 'sending', 'sent',
  'permission_blocked', 'reconciliation_required'
))

CHECK (event_type IN (
  'prepared', 'send_started', 'sent',
  'permission_blocked', 'reconciliation_required',
  'safe_notice_send_started', 'safe_notice_sent'
))
```

Use `TEXT` checks of 1-512 characters for IDs/chat/provider references, 1-50 for Feishu UUIDs, at most 8,000 for unresolved `prepared_reply_text`, 64 lowercase hexadecimal characters for fingerprints/hashes, `citation_rank` null or 1-3, and positive `prompt_rank`. Require unresolved `prepared`/`sending` rows to retain text and resolved `sent`/blocked rows to have `prepared_reply_text IS NULL`.

Add `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` guards for source traces and lifecycle events using the existing `knowledge_draft_append_only_guard()` function. Index `(provider, incoming_message_id)`, `(delivery_id, prompt_rank)`, and `(delivery_id, sequence)`.

- [ ] **Step 4: Run the migration test and verify GREEN**

Run the Step 2 command.

Expected: all migration contract tests pass.

- [ ] **Step 5: Write failing repository replay and transition tests**

Use an isolated schema when `IRIS_TEST_DATABASE_URL` is present. Cover:

```ts
it("prepares delivery, traces, and prepared event in one transaction");
it("treats changed row IDs and timestamps as exact semantic replay");
it("rejects changed rendered text or source facts as a semantic conflict");
it("increments version and attempt count for each send start");
it("clears prepared text and retains its SHA-256 after sent");
it("records permission_blocked before any send attempt");
it("records reconciliation_required after a send attempt began");
it("retries a safe notice without restoring blocked answer text");
it("prevents update, delete, and truncate of traces and events");
it("returns sources and events in deterministic rank and sequence order");
it("counts unresolved answers, unsent safe notices, and reconciliation cases");
```

An exact replay changes only generated row IDs and `at`; a conflict changes `citationRank` or `renderedText`. Assert conflict throws `AnswerReplyPreparationConflictError` and stale transitions throw `AnswerReplyVersionConflictError`.

- [ ] **Step 6: Run repository tests and verify RED**

Run:

```powershell
npm exec --workspace apps/core -- vitest run tests/postgres-answer-reply-repository.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 7: Implement deterministic identifiers and repository types**

In `answer-reply-repository.ts`, export deterministic helpers:

```ts
export function createAnswerReplyDeliveryId(
  provider: AnswerReplyProvider,
  incomingMessageId: string,
): string;

export function createAnswerReplyUuid(incomingMessageId: string): string;
export function createAnswerReplySafeNoticeUuid(incomingMessageId: string): string;
```

Use SHA-256 and exact UUID formats `iris-${digest.slice(0, 45)}` and `iris-safe-${digest.slice(0, 40)}` so both remain at most 50 characters. Export `AnswerReplyPreparationConflictError` and `AnswerReplyVersionConflictError` with stable non-content-bearing messages.

- [ ] **Step 8: Implement transactional preparation and transitions**

In `postgres-answer-reply-repository.ts`:

1. acquire `pg_advisory_xact_lock(hashtextextended($1, 0))` using `provider:incomingMessageId` for prepare and the delivery ID for transitions;
2. canonicalize semantic input by sorting object keys while preserving source-trace array order;
3. exclude generated IDs and timestamps from `semantic_fingerprint`;
4. insert delivery, every trace, and the `prepared` event in one transaction;
5. on replay, compare the stored semantic fingerprint before returning `already_applied`;
6. require `expectedVersion` on every transition and increment version/event sequence together;
7. choose `permission_blocked` when `attempt_count = 0`, otherwise `reconciliation_required`;
8. clear `prepared_reply_text` only on `sent` or blocked/reconciliation transitions;
9. never persist exception text or Feishu/provider response bodies.

Use explicit column lists in every query and explicit row mappers; do not return raw database rows.

- [ ] **Step 9: Run repository tests and verify GREEN**

Run the Step 6 command.

Expected: all in-memory contract tests pass; Postgres tests pass when `IRIS_TEST_DATABASE_URL` is set and otherwise skip with the existing repository-test convention.

- [ ] **Step 10: Commit**

```powershell
git add apps/core/migrations/0045_answer_source_citations.sql apps/core/src/answer-replies/answer-reply-repository.ts apps/core/src/answer-replies/postgres-answer-reply-repository.ts apps/core/tests/postgres-answer-reply-repository.test.ts apps/core/tests/migration-runner.test.ts
git commit -m "feat(core): persist answer source receipts"
```

---

### Task 4: Expose The Existing Permission Path As A Recheck Verifier

**Files:**
- Create: `apps/core/src/answer-replies/answer-source-permission-verifier.ts`
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

**Interfaces:**
- Consumes: the answer runtime's existing source registry, runtime capabilities, and `FeishuDocumentPermissionChecker`
- Produces:

```ts
export type AnswerSourcePermissionDecision = {
  documentSourceId: string;
  outcome: "allowed" | "denied" | "error";
};

export interface AnswerSourcePermissionVerifier {
  verify(input: {
    chatId: string;
    documentSourceIds: readonly string[];
  }): Promise<AnswerSourcePermissionDecision[]>;
}
```

- [ ] **Step 1: Write failing verifier tests in the runtime suite**

Create allowed, denied, missing, locally-disabled, and checker-error sources. Call:

```ts
await runtime!.answerSourcePermissionVerifier.verify({
  chatId: "oc_pilot",
  documentSourceIds: ["source-a", "source-a", "source-b", "source-error"],
});
```

Assert one decision per unique ID in first-seen order, duplicate `source-a` is checked once, missing/locally-disabled sources are `denied`, thrown checker errors become `error`, and no verifier call throws.

- [ ] **Step 2: Run the runtime test and verify RED**

Run:

```powershell
npm exec --workspace apps/core -- vitest run tests/answer-draft-runtime.test.ts
```

Expected: `answerSourcePermissionVerifier` is absent.

- [ ] **Step 3: Implement the narrow verifier contract**

Create `createAnswerSourcePermissionVerifier({ canReadDocument })`. Normalize IDs to nonblank strings of at most 512 characters, deduplicate them, and return `error` for validation or checker exceptions without exposing exception messages.

Also export:

```ts
export function createUnavailableAnswerSourcePermissionVerifier():
  AnswerSourcePermissionVerifier;
```

The unavailable verifier returns `error` for each unique source and therefore permits source-free answers while blocking sourced answers.

- [ ] **Step 4: Reuse the existing answer-runtime policy closure**

Create one `canReadDocument` closure from the same `permissionMode`, source registry, runtime controller, live checker, and per-call `chatId` used by retrieval. Expose the resulting verifier on `AnswerDraftRuntime`:

```ts
export type AnswerDraftRuntime = {
  answerDraftOrchestrator: Pick<AnswerDraftOrchestrator, "generateDraft">;
  answerSourcePermissionVerifier: AnswerSourcePermissionVerifier;
  chatKnowledgeDraftGenerator?: ChatKnowledgeDraftGenerator;
  groupMemoryService?: GroupMemoryService;
  close(): Promise<void>;
};
```

Do not duplicate Feishu permission logic and do not turn a checker error into `allowed`.

- [ ] **Step 5: Run the runtime test and verify GREEN**

Run the Step 2 command.

Expected: all answer-draft runtime tests pass, including source-policy and allow-indexed modes.

- [ ] **Step 6: Commit**

```powershell
git add apps/core/src/answer-replies/answer-source-permission-verifier.ts apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/answer-draft-runtime.test.ts
git commit -m "feat(core): expose answer source permission rechecks"
```

---

### Task 5: Deliver Or Resume An Exact Prepared Answer

**Files:**
- Create: `apps/core/src/answer-replies/answer-reply-delivery-service.ts`
- Create: `apps/core/tests/answer-reply-delivery-service.test.ts`

**Interfaces:**
- Consumes: `AnswerReplyRepository`, `AnswerSourcePermissionVerifier`, and `FeishuMessageReplier`
- Produces:

```ts
export const ANSWER_PERMISSION_CHANGED_NOTICE =
  "资料权限已变化，我没有发送原答案。请重新提问。";

export type AnswerReplyDeliveryRequest = {
  provider: "feishu";
  incomingMessageId: string;
  chatId: string;
  replyUuid: string;
  safeNoticeUuid: string;
  prepareAnswer(): Promise<{
    renderedText: string;
    sourceTraces: AnswerReplySourceTraceInput[];
    preparedAt: Date;
  }>;
};

export interface AnswerReplyDeliveryService {
  respond(input: AnswerReplyDeliveryRequest): Promise<{ replyMessageId?: string }>;
}
```

- [ ] **Step 1: Write failing exact-retry tests**

Use a recording fake repository/replier. First Feishu send rejects after `send_started`; call `respond()` again for the same incoming message. The repository returns the stored `sending` receipt and the service must not invoke the second call's `prepareAnswer` callback. Assert:

```ts
expect(replier.replyText).toHaveBeenNthCalledWith(1, {
  messageId: "om_1",
  text: preparedText,
  replyInThread: true,
  uuid: preparedReplyUuid,
});
expect(replier.replyText).toHaveBeenNthCalledWith(2, {
  messageId: "om_1",
  text: preparedText,
  replyInThread: true,
  uuid: preparedReplyUuid,
});
```

Assert `prepareAnswer` ran exactly once across both calls, the service never accepts replacement text on resume, and `completeAnswerSend` stores the returned Feishu reply ID.

- [ ] **Step 2: Write failing permission and safe-notice tests**

Cover:

```ts
it("checks each unique source once before every external answer attempt");
it("sends source-free prepared answers without calling the verifier");
it("blocks before first send when any source is denied");
it("blocks before first send when any source check errors");
it("blocks when verifier decisions are missing, duplicated, reordered, or unexpected");
it("blocks when the verifier unexpectedly throws");
it("records reconciliation_required when a prior send had started");
it("sends only the content-free notice with the separate safe UUID");
it("retries only the notice after notice delivery fails");
it("returns a sent receipt without another Feishu call");
```

For denied/error cases, assert neither prepared answer text nor source title/URI appears in any `replyText` call.

- [ ] **Step 3: Run delivery tests and verify RED**

Run:

```powershell
npm exec --workspace apps/core -- vitest run tests/answer-reply-delivery-service.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 4: Implement the delivery state flow**

At the start of `respond()`, call `findByIncomingMessage()`. Only when it returns `undefined` may the service await `prepareAnswer()` and call repository `prepare()` with this exact mapping:

```ts
const prepared = await input.prepareAnswer();
const result = await repository.prepare({
  provider: input.provider,
  incomingMessageId: input.incomingMessageId,
  chatId: input.chatId,
  replyUuid: input.replyUuid,
  safeNoticeUuid: input.safeNoticeUuid,
  renderedText: prepared.renderedText,
  sourceTraces: prepared.sourceTraces,
  at: prepared.preparedAt,
});
const receipt = result.receipt;
```

Implement this exact dispatch for the resulting receipt:

```ts
switch (receipt.delivery.state) {
  case "sent":
    return optionalReplyId(receipt.delivery.replyMessageId);
  case "permission_blocked":
  case "reconciliation_required":
    return sendOrResumeSafeNotice(receipt);
  case "prepared":
  case "sending":
    return verifyThenSendPreparedAnswer(receipt);
}
```

Before normal send, derive unique source IDs from immutable traces. Require the verifier
to return exactly one decision for every requested ID in the same order, with no
missing, duplicate, reordered, or unexpected IDs, and require every decision to be
`allowed`. Treat a thrown verifier exception as an error decision for the requested
sources. Then call `beginAnswerSend`, send the stored `preparedReplyText` with the
stored UUID, and call `completeAnswerSend`. Let any Feishu or persistence failure
escape so the existing raw-event worker retries. The retry enters through `respond()`,
finds the receipt, and never awaits `prepareAnswer()`.

On denied/error, call `blockForPermission` before any notice. Send only `ANSWER_PERMISSION_CHANGED_NOTICE` using `safeNoticeUuid`; after notice success call `completeSafeNoticeSend`. A blocked receipt never reloads or reconstructs prepared answer text.

- [ ] **Step 5: Run delivery tests and verify GREEN**

Run the Step 3 command.

Expected: every exact-retry and permission test passes.

- [ ] **Step 6: Commit**

```powershell
git add apps/core/src/answer-replies/answer-reply-delivery-service.ts apps/core/tests/answer-reply-delivery-service.test.ts
git commit -m "feat(core): deliver permission-safe prepared answers"
```

---

### Task 6: Route Ordinary Mentions Through The Durable Service

**Files:**
- Modify: `apps/core/src/conversation/feishu-mention-answer-responder.ts`
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/feishu-mention-answer-responder.test.ts`
- Modify: `apps/core/tests/event-worker-runtime.test.ts`
- Modify: `apps/core/tests/server-startup.test.ts`

**Interfaces:**
- Consumes: Tasks 2-5
- Produces: ordinary Feishu mention answers with durable prepare/resume behavior

- [ ] **Step 1: Write failing responder citation and replay tests**

Inject a fake `AnswerReplyDeliveryService`. For a draft with one allowed wiki fragment, make the fake invoke `input.prepareAnswer()` and assert the responder:

1. returns Task 2 renderer output from `prepareAnswer()`;
2. includes `executionId: input.messageId` in the one model call;
3. passes deterministic normal/safe UUIDs, provider, incoming message ID, and chat ID to `respond()`;
4. returns the service's reply message ID.

Add a retry test whose fake `respond()` deliberately does not invoke `prepareAnswer()`; assert `generateDraft` is not called. Add a source-free draft test whose fake invokes `prepareAnswer()` and proves the returned payload has no footer and an empty trace list.

- [ ] **Step 2: Write failing fallback isolation tests**

For blank-model and capacity fallbacks, let `respond()` invoke `prepareAnswer()` and propagate the model error; assert no repository receipt is prepared by the fake, the direct fallback reply remains unchanged and at most 8,000 characters, and the existing deterministic normal UUID is preserved. For knowledge-draft and user-submitted-document command paths, assert `respond()` is never called.

- [ ] **Step 3: Run responder tests and verify RED**

Run:

```powershell
npm exec --workspace apps/core -- vitest run tests/feishu-mention-answer-responder.test.ts
```

Expected: durable service/citation assertions fail.

- [ ] **Step 4: Integrate the ordinary-answer path**

After command detection and nonblank-question validation, hand the model work to the service as a lazy callback:

```ts
return toRepliedResult(await answerReplyDeliveryService.respond({
  provider: "feishu",
  incomingMessageId: input.messageId,
  chatId: input.chatId,
  replyUuid: createAnswerReplyUuid(input.messageId),
  safeNoticeUuid: createAnswerReplySafeNoticeUuid(input.messageId),
  prepareAnswer: async () => {
    const answer = await answerDraftOrchestrator.generateDraft({
      executionId: input.messageId,
      question,
      chatId: input.chatId,
      ...(normalizedSenderId === undefined ? {} : { askerId: normalizedSenderId }),
      liveChatMessages: [{
        speaker: normalizedSenderId ?? "unknown",
        text: question,
      }],
    });
    const preparedAt = now();
    return {
      ...renderAnswerWithSourceCitations({
        answerText: answer.answerText,
        allowedFragments: answer.allowedFragments,
        initialPermissionCheckedAt: preparedAt,
      }),
      preparedAt,
    };
  },
}));
```

Make `answerReplyDeliveryService: Pick<AnswerReplyDeliveryService, "respond">` a required responder dependency. In the responder test file, replace direct factory calls with this compatibility helper so unrelated intent/fallback cases remain focused:

```ts
function createTestMentionResponder(
  input: Omit<FeishuMentionAnswerResponderDependencies, "answerReplyDeliveryService"> & {
    answerReplyDeliveryService?: Pick<AnswerReplyDeliveryService, "respond">;
  },
) {
  const answerReplyDeliveryService = input.answerReplyDeliveryService ?? {
    async respond(request: AnswerReplyDeliveryRequest) {
      const prepared = await request.prepareAnswer();
      return input.replier.replyText({
        messageId: request.incomingMessageId,
        text: prepared.renderedText,
        replyInThread: true,
        uuid: request.replyUuid,
      });
    },
  };
  return createFeishuMentionAnswerResponder({
    ...input,
    answerReplyDeliveryService,
  });
}
```

Export `AnswerReplyDeliveryRequest` from Task 5 as the `respond()` parameter type. New receipt tests inject their own service. The production event runtime always injects the real durable service.

- [ ] **Step 5: Run responder tests and verify GREEN**

Run the Step 3 command.

Expected: all existing responder tests and new receipt tests pass.

- [ ] **Step 6: Write failing runtime-composition tests**

In `event-worker-runtime.test.ts`, assert:

- the Postgres pool is created before `createMentionAnswerResponder`;
- `createPostgresAnswerReplyRepository({ dataSource: pool })` is called once;
- `createAnswerReplyDeliveryService()` receives repository, replier, verifier, and `now`;
- the responder receives that service;
- `EventWorkerRuntime.answerReplies` exposes only the repository inspection method;
- event-worker status exposes `answerReplyUnresolvedCount`, `answerReplyPendingSafeNoticeCount`, and `answerReplyReconciliationRequiredCount` from `repository.getStatus()`;
- an absent answer-runtime verifier is replaced by the fail-closed verifier;
- pool close remains exactly once.

In `server-startup.test.ts`, assert `app.ts` passes `answerDraftRuntime.answerSourcePermissionVerifier` into the event-worker factory.

- [ ] **Step 7: Run runtime tests and verify RED**

Run:

```powershell
npm exec --workspace apps/core -- vitest run tests/event-worker-runtime.test.ts tests/server-startup.test.ts
```

Expected: repository/service/verifier wiring assertions fail.

- [ ] **Step 8: Reorder and compose the event-worker runtime**

Create the Postgres pool before mention responder composition. Build messages, replay guard, document registry, and user-submitted registrar without the current deferred placeholder. Then create the answer repository, replier, durable delivery service, and mention responder. Extend runtime input with:

```ts
answerSourcePermissionVerifier?: AnswerSourcePermissionVerifier;
```

and runtime output with:

```ts
answerReplies?: Pick<AnswerReplyRepository, "findByIncomingMessage">;
```

Extend `EventWorkerRuntimeStatus` with the three nonnegative answer-repository counts. A repository status failure makes the event-worker status request fail; it must not be rewritten as healthy zeroes.

Use `createUnavailableAnswerSourcePermissionVerifier()` when the app supplies a custom orchestrator without an answer runtime. Do not open a second Postgres pool.

- [ ] **Step 9: Pass the verifier from `app.ts` and run GREEN tests**

Pass `answerDraftRuntime?.answerSourcePermissionVerifier` beside the existing orchestrator input. Run the Step 7 command plus the responder test.

Expected: all selected tests pass and runtime resource-close counts remain unchanged.

- [ ] **Step 10: Commit**

```powershell
git add apps/core/src/conversation/feishu-mention-answer-responder.ts apps/core/src/runtime/event-worker-runtime.ts apps/core/src/app.ts apps/core/tests/feishu-mention-answer-responder.test.ts apps/core/tests/event-worker-runtime.test.ts apps/core/tests/server-startup.test.ts
git commit -m "feat(core): route mentions through answer receipts"
```

---

### Task 7: Add Content-Free Internal Inspection And Public Boundary Proof

**Files:**
- Create: `apps/core/src/answer-replies/answer-reply-api.ts`
- Create: `apps/core/tests/answer-reply-api.test.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `scripts/pilot-smoke.mjs`
- Modify: `scripts/pilot-smoke-lib.test.mjs`

**Interfaces:**
- Consumes: `EventWorkerRuntime.answerReplies`
- Produces: `GET /internal/answer-replies/:provider/:incomingMessageId`

- [ ] **Step 1: Write failing internal API tests**

Build an app with bearer token `operator-secret` and a fake receipt containing a deliberately sensitive prepared answer marker. Assert:

```ts
const unauthorized = await app.inject({
  method: "GET",
  url: "/internal/answer-replies/feishu/om_1",
});
expect(unauthorized.statusCode).toBe(401);

const authorized = await app.inject({
  method: "GET",
  url: "/internal/answer-replies/feishu/om_1",
  headers: { authorization: "Bearer operator-secret" },
});
expect(authorized.statusCode).toBe(200);
expect(authorized.body).not.toContain("SENSITIVE_PREPARED_ANSWER");
```

Assert the response includes delivery state/version/fingerprints/timestamps, bounded source metadata and lifecycle events, but no `preparedReplyText`, fragment text, prompt, credentials, provider body, or exception message. Invalid provider, blank/over-512 IDs, missing receipts, and unavailable runtime return bounded `400` or `404` responses.

- [ ] **Step 2: Run API tests and verify RED**

Run:

```powershell
npm exec --workspace apps/core -- vitest run tests/answer-reply-api.test.ts
```

Expected: route/module is absent.

- [ ] **Step 3: Implement explicit response mapping**

Export:

```ts
export function registerAnswerReplyApi(
  app: FastifyInstance,
  repository: Pick<AnswerReplyRepository, "findByIncomingMessage"> | undefined,
): void;
```

Map every returned field explicitly. Never spread `receipt.delivery` because it contains unresolved prepared text. Return:

```ts
{
  ok: true,
  delivery: {
    id, provider, incomingMessageId, chatId, state,
    renderedReplyFingerprint, replyMessageId, safeNoticeMessageId,
    attemptCount, safeNoticeAttemptCount, version,
    createdAt, updatedAt, sentAt, permissionBlockedAt,
    reconciliationRequiredAt, safeNoticeSentAt,
  },
  sources,
  events,
}
```

Register it after the existing internal bearer hook using `eventWorkerRuntime?.answerReplies`.

- [ ] **Step 4: Run API tests and verify GREEN**

Run the Step 2 command.

Expected: all API tests pass.

- [ ] **Step 5: Add an explicit public smoke assertion**

Extend `runPublicBoundaryChecks()` with:

```js
await expectStatus(
  `${publicBaseUrl}/internal/answer-replies/feishu/public-boundary-probe`,
  404,
);
```

Update the smoke-library fixture to log and assert `public-answer-reply-404`. Do not add a Caddy matcher; the existing terminal `respond 404` remains the protection.

- [ ] **Step 6: Run public-boundary tests and verify GREEN**

Run:

```powershell
node --test --test-concurrency=1 scripts/pilot-smoke-lib.test.mjs scripts/pilot-compose.test.mjs
```

Expected: all public callback and hidden-internal-path tests pass.

- [ ] **Step 7: Commit**

```powershell
git add apps/core/src/answer-replies/answer-reply-api.ts apps/core/src/app.ts apps/core/tests/answer-reply-api.test.ts scripts/pilot-smoke.mjs scripts/pilot-smoke-lib.test.mjs
git commit -m "feat(core): expose private answer receipt inspection"
```

---

### Task 8: Verify, Document, Publish, And Gray The Feature

**Files:**
- Create: `docs/runbooks/iris-answer-source-citations-acceptance.md`
- Create: `docs/pull-requests/2026-08-02-iris-answer-source-citations.md`
- Modify: `docs/operations/internal-rollout-runbook.md`
- Modify: `docs/superpowers/plans/2026-08-02-iris-answer-source-citations.md`

**Interfaces:**
- Consumes: completed Tasks 1-7
- Produces: reproducible local evidence, draft PR, fail-closed deployment, and real pilot evidence

- [ ] **Step 1: Write the bounded acceptance runbook**

Document these exact gates:

1. candidate SHA equals Core and AI Worker image SHA;
2. Core/AI Worker checks are successful;
3. before migration/deploy, `globalEnabled=false`, `desiredGlobalEnabled=false`, Caddy stopped, workers/queues healthy, and every pending/DLQ count is zero;
4. PostgreSQL backup completes before migration `0045`;
5. internal receipt tests prove exact replay, cleared text, and content-free inspection;
6. public `/health` is 200 and `/internal/answer-replies/feishu/probe` is 404 while Iris remains globally disabled;
7. only the existing pilot group is enabled for a real authorized wiki-marker answer;
8. the reply visibly contains `Iris 参考资料：`, the correct title, and canonical Feishu URL;
9. the private receipt contains the exact snapshot/fragment/hash and no answer body;
10. after source permission is revoked, the unique marker is not emitted and only the safe notice may be sent;
11. final event/document/reindex pending and DLQ counts are zero, and answer receipt status reports `unresolvedCount=0`, `pendingSafeNoticeCount=0`, and `reconciliationRequiredCount=0`;
12. restore the previously approved pilot runtime state only after all gates pass.

The runbook must state that any failure restores global disablement and stops Caddy until the failing gate is understood.

- [ ] **Step 2: Run all focused feature tests**

Run:

```powershell
npm exec --workspace apps/core -- vitest run tests/document-fragment-repository.test.ts tests/answer-source-citation-renderer.test.ts tests/postgres-answer-reply-repository.test.ts tests/answer-draft-runtime.test.ts tests/answer-reply-delivery-service.test.ts tests/feishu-mention-answer-responder.test.ts tests/event-worker-runtime.test.ts tests/answer-reply-api.test.ts tests/server-startup.test.ts
```

Expected: zero failures; Postgres-only cases skip only when `IRIS_TEST_DATABASE_URL` is absent.

- [ ] **Step 3: Run full local verification**

Run each command separately:

```powershell
git diff --check
npm run typecheck
npm run build
npm test
npm run test:python
npm run test:pilot
docker compose config
npm run readiness -- --env-file deploy/pilot/ci.env
npm run pilot:config
```

Expected: every command exits 0. Record exact test counts and any legitimate database-test skips in the PR document.

- [ ] **Step 4: Review scope and sensitive-data boundaries**

Run:

```powershell
git status --short
git diff --stat b25d8298fd396366c97449dfbe6f11f3dc42f8f9...HEAD
rg -n "preparedReplyText|fragmentText|promptContext|appSecret|tenantAccessToken" apps/core/src/answer-replies
```

Confirm immutable source/event mappings contain no body text, API mapping does not spread the delivery row, no unrelated files changed, and no secret values entered the repository.

- [ ] **Step 5: Commit operational documentation**

```powershell
git add docs/runbooks/iris-answer-source-citations-acceptance.md docs/operations/internal-rollout-runbook.md docs/pull-requests/2026-08-02-iris-answer-source-citations.md docs/superpowers/plans/2026-08-02-iris-answer-source-citations.md
git commit -m "docs: add answer citation acceptance gates"
```

- [ ] **Step 6: Push and open a stacked draft PR**

Run:

```powershell
git push -u origin codex/iris-answer-source-citations
gh pr create --repo xfbbert-dotcom/iris --base codex/iris-chat-knowledge-drafts --head codex/iris-answer-source-citations --draft --title "feat: add permission-safe answer citations" --body-file docs/pull-requests/2026-08-02-iris-answer-source-citations.md
```

Expected: GitHub returns a new draft PR URL. Do not merge PR #22 or the new PR.

- [ ] **Step 7: Require CI before deployment**

Run:

```powershell
gh pr checks --repo xfbbert-dotcom/iris --watch
```

Expected: the new PR's Core and AI Worker checks both report success for the exact candidate SHA.

- [ ] **Step 8: Execute the fail-closed deployment gates**

Follow `docs/runbooks/iris-answer-source-citations-acceptance.md` exactly. Back up PostgreSQL, apply `0045`, deploy Core and AI Worker images from the same approved SHA, and keep global/desired global false with Caddy stopped through all private gates. Do not consume Gemini quota for repeated probes; use one real pilot answer only after the provider and all internal gates are healthy.

- [ ] **Step 9: Complete real Feishu citation and revocation acceptance**

Use a new authorized pilot wiki page with a unique non-secret marker. Capture the incoming Feishu message ID, visible Iris reply, internal receipt, source snapshot/fragment/hash, permission-revocation result, and final zero-queue/DLQ status. If a human must change Feishu sharing or send a message, request only that single action and keep the feature fail-closed until it is done.

- [ ] **Step 10: Update PR and deployment evidence**

Append exact candidate SHA, CI run URLs, migration result, backup identifier, public-boundary result, real citation screenshot/result, revocation result, and final queue/DLQ counts to `docs/pull-requests/2026-08-02-iris-answer-source-citations.md`; commit and push the evidence. Leave both PRs unmerged pending explicit user authorization.
