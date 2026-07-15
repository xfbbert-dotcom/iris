# Iris Phase 3B: Semantic Thread and Action Memory

Status: approved for implementation planning

Date: 2026-07-16

Parent constitution: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

Predecessor: `docs/superpowers/specs/2026-07-14-iris-automatic-group-memory-extraction-design.md`

## 1. Purpose

The first Phase 3B slice lets Iris extract evidence-bound group memories from ordinary Feishu messages. It does not yet represent how one discussion evolves, whether a discussion is still open, or which explicit commitments arose from it.

This slice adds stable semantic discussion threads and action memory. Iris may group ordinary messages into the same topic even when participants do not use Feishu reply threads. It may remember explicit commitments and explicit completion signals. These states remain internal working context and never execute an external action by themselves.

This design implements the whitepaper's `thread memory` and `action memory` responsibilities. It does not change the whitepaper's authority boundaries.

## 2. Accepted Product Decisions

The following decisions are fixed for this slice:

1. A discussion thread is semantic. It may span ordinary group messages, time gaps, and Feishu reply boundaries.
2. Iris resolves a thread only when conversation contains explicit completion or decision language. New evidence may reopen it.
3. Iris creates an action item only from an explicit commitment with a concrete action and an explicit owner. A due date is optional.
4. Suggestions, questions, and brainstorming do not create action items.
5. When thread association is uncertain, Iris creates an isolated candidate thread. It must not contaminate an existing thread.
6. Later evidence may promote or merge candidates. Every transition and merge remains traceable.
7. This slice records state but does not let Iris proactively send reminders or follow-up messages.

## 3. Scope

### 3.1 Included

- stable current-group discussion-thread entities;
- candidate, open, resolved, reopened, and merged lifecycle behavior;
- message-to-thread evidence binding;
- explicit action-item creation, completion, and cancellation;
- stable and unresolved owner references;
- append-only thread and action state history;
- model-proposed, Core-validated thread and action operations;
- bounded retrieval of relevant threads and actions during answer generation;
- independent rollout controls for thread and action extraction;
- operator status, audit, recovery, and deterministic acceptance coverage.

### 3.2 Excluded

- cross-group or company-wide thread sharing;
- proactive speech, reminders, alerts, or unresolved-thread follow-up;
- task creation in Feishu or another external system;
- automatic knowledge-base drafting or publication;
- assignment notifications or due-date reminders;
- a user-facing task board or Admin Console;
- multi-tenant installation and billing;
- document content as evidence for conversational thread state.

The excluded capabilities may consume these entities later, but they may not bypass the evidence, scope, or state-machine rules defined here.

## 4. Constitutional Boundaries

1. Feishu Gateway acknowledges callbacks before topic analysis begins.
2. Postgres conversation messages remain the fact-layer evidence.
3. Redis transports identifiers only and is not the source of truth.
4. Python AI Worker proposes structured operations only.
5. TypeScript Core owns stable identifiers, policy, state machines, validation, transactions, and audit.
6. No model output may directly change Postgres or trigger an external write.
7. Every thread and action transition must be evidence-bound to messages from the same group.
8. Candidate threads are not answer context, official knowledge, or proactive-signal input.
9. Runtime disablement must prevent content loading and final writes without later silent backfill.
10. Current-group isolation remains the default. Cross-group joins are forbidden in this slice.

## 5. Domain Model

### 5.1 Discussion Thread

`discussion_threads` is the authoritative topic entity. It contains:

- `id`: stable generated identifier;
- `group_id`: immutable Feishu group boundary;
- `title`: bounded human-readable topic label;
- `summary`: bounded current summary derived from evidence;
- `status`: `candidate`, `open`, `resolved`, or `merged`;
- `confidence`: latest bounded confidence;
- `merged_into_thread_id`: same-group target when status is `merged`;
- `version`: optimistic-concurrency version;
- `first_evidence_at` and `last_activity_at`;
- `resolved_at` when currently resolved;
- creation and update timestamps.

`reopened` is an append-only transition event, not a durable status. A reopened thread returns to `open` while retaining its prior `resolved` event.

A merged thread is immutable except for administrative deletion. Reads follow `merged_into_thread_id` to the final canonical thread. Core rejects self-merges, cross-group merges, and merge cycles.

### 5.2 Thread Evidence and Events

`discussion_thread_evidence` binds a thread to a conversation message. The `(thread_id, message_id)` pair is unique. Core verifies that the thread group and `conversation_messages.chat_id` match before insertion.

`discussion_thread_events` is append-only and records `created`, `promoted`, `summary_updated`, `resolved`, `reopened`, `merged`, and `corrected` transitions. Event evidence is normalized through an event-to-message join table so every transition can cite one or more exact messages.

Deleting or invalidating required evidence causes derived summaries to be rebuilt. A thread with insufficient remaining evidence becomes non-retrievable until new valid evidence promotes it again.

### 5.3 Action Item

`action_items` is the authoritative commitment entity. It contains:

- `id`, `group_id`, and optional canonical `thread_id`;
- bounded `description` containing the committed action;
- `owner_ref_type`: `feishu_user` or `text_label`;
- `owner_ref`: a stable Feishu open ID or an exact unresolved owner label;
- optional `due_at` only when explicitly stated;
- `status`: `open`, `completed`, or `cancelled`;
- `confidence` and optimistic-concurrency `version`;
- creation, update, completion, and cancellation timestamps.

An owner is explicit when it is one of:

- the message sender taking responsibility in first person;
- a persisted Feishu mention linked to the commitment;
- an exact person label present in the evidence text.

Only `feishu_user` is eligible for future direct notification. `text_label` remains useful for memory and answers but is unresolved identity data and cannot be used to ping a person.

`action_item_events` records `created`, `completed`, `cancelled`, `reopened`, `owner_resolved`, and `corrected`. Action event evidence is append-only and same-group constrained.

### 5.4 Persisted Mention Identity

The current event parser reads Feishu mentions but drops them before persisting conversation facts. This slice adds a normalized message-mention fact table containing message ID, mention key, and mentioned Feishu open ID. Upsert is idempotent with the parent message.

Core may bind an action owner to a Feishu user only from the sender identity or this persisted mention mapping. The model cannot invent or translate a display name into an open ID.

### 5.5 Group Memory Projection

`group_memories` remains the answer-oriented long-term summary store, not the source of truth for thread or action lifecycle.

Open thread summaries project to `scope=thread` with a stable `thread_key`. Open action summaries may project to `scope=action`. Resolving, merging, completing, or cancelling removes the active projection; the authoritative entity and event history remain available for bounded relevant retrieval. Projection rows carry evidence and can be rebuilt from authoritative entities. A projection failure does not roll back the authoritative thread or action transaction; it schedules bounded repair and keeps the incomplete projection out of retrieval.

## 6. Extraction Contract

### 6.1 Versioned Request

The existing extraction request, run, Redis queue, retry, provider cooldown, and DLQ remain in use. A versioned contract adds:

- current-group candidate and active threads with stable IDs and versions;
- current-group open actions with stable IDs and versions;
- persisted message sender and mention identities;
- independent capability flags for group memory, thread extraction, and action extraction.

Input remains bounded and contains no data from another group.

### 6.2 Versioned Response

One model call may return:

- the existing group-memory candidates;
- thread operations: `create`, `attach_evidence`, `promote`, `merge`, `resolve`, `reopen`, `update_summary`, or `correct`;
- action operations: `create`, `complete`, `cancel`, `reopen`, `resolve_owner`, or `correct`.

Every operation includes confidence, evidence message IDs, and the expected target version when it changes an existing entity. Lifecycle operations also include an exact evidence span. Core verifies that the span occurs in the named message text; this grounds the operation but does not grant the model authority.

### 6.3 Confidence Policy

Two bounded thresholds control application:

- below the candidate floor: reject without persistence;
- at or above the candidate floor but below the automatic-apply threshold: only an isolated `candidate` thread may be created;
- at or above the automatic-apply threshold: Core may apply an otherwise valid thread or action operation.

The initial defaults are `0.65` for the candidate floor and `0.85` for automatic application. Both are configuration, validated within `[0, 1]`, with the candidate floor required to be lower than the application threshold.

Model confidence alone is never sufficient for resolve, merge, complete, cancel, or owner binding. Structural and evidence rules must also pass.

## 7. Processing Flow

1. Event Worker parses, deduplicates, and persists the Feishu message plus mention facts.
2. The existing planner registers extraction only after message persistence.
3. Extraction runtime re-checks the current-group read gate before loading any content.
4. It builds a bounded run from chronological messages, relevant current-group threads, open actions, and active group memories.
5. Python AI Worker returns structured candidate operations.
6. Core validates schema, group ownership, evidence, exact spans, owner identity, versions, confidence, and state transitions.
7. Structurally invalid responses fail the run without domain writes and follow existing retry or DLQ behavior.
8. Semantically invalid individual operations are rejected with bounded reason codes. Remaining valid operations are applied atomically.
9. Core re-checks runtime policy immediately before the transaction commits.
10. Projection updates run after the authoritative transaction. Failed projections are invisible and enter bounded repair.

A repeated Feishu event, queue delivery, run replay, or Worker retry must reuse deterministic fingerprints and operation idempotency keys. It cannot create duplicate threads, evidence links, events, or actions.

## 8. State Rules

### 8.1 Thread Creation and Promotion

- uncertain association creates a separate `candidate`;
- candidates are invisible to answer retrieval;
- additional same-group evidence may promote a candidate to `open`;
- high-confidence, well-grounded new topics may be created directly as `open`;
- attachment to an existing thread requires the automatic-apply threshold and matching target version.

### 8.2 Resolution and Reopening

Resolution requires explicit conversational language indicating completion, a settled decision, or that the issue is no longer active. Silence and elapsed time are never resolution evidence.

New evidence that explicitly resumes or contradicts a resolved topic creates a `reopened` event and returns the thread to `open`. A resolved thread is not duplicated merely because discussion restarts.

### 8.3 Merge

Merge requires strong same-group evidence that two threads represent the same continuing topic. The canonical target is selected deterministically by status, evidence count, then creation time and ID. Merge history remains visible and retrieval follows the canonical target.

### 8.4 Action Lifecycle

Action creation requires a concrete action, explicit owner, and exact commitment evidence. Suggestions such as "we could", "should we", or "it may be useful" are not commitments unless a participant explicitly accepts responsibility.

Completion and cancellation require explicit evidence. A later explicit recommitment may reopen an action. No action status transition executes an external side effect.

## 9. Answer Retrieval and Context Assembly

Answer generation recalls a small relevant set rather than loading all domain state:

1. the explicitly associated canonical thread;
2. semantically relevant `open` threads;
3. relevant `resolved` threads only when the question refers to them;
4. actions related to the selected thread, question, or asking participant.

Candidate and merged source threads are never injected directly.

Prompt sections remain strictly separated and independently budgeted:

1. `<background_documents>`;
2. `<group_memories>`;
3. `<discussion_threads>`;
4. `<action_items>`;
5. `<live_chat_context>`.

The latest 20 raw current-group messages remain at the bottom, nearest model output. When context is constrained, Iris drops old documents and low-relevance resolved threads before reducing the live-chat anchor.

Document fragments still pass the real-time Feishu permission guard. Thread and action entries cite their conversation evidence IDs and cannot introduce cross-group content.

## 10. Failure and Recovery

- Feishu callback acknowledgement never waits for extraction.
- Provider timeouts, rate limits, unavailable responses, and invalid whole responses use existing retries, shared cooldown, and DLQ.
- A rejected candidate records a content-free reason code and entity identifiers, not conversation text.
- Concurrent version conflicts cause a bounded reload and recomputation; Core never overwrites a newer state.
- Runtime disablement before load or before commit skips the run without writes or later backfill.
- Thread/action failure never blocks message persistence or ordinary mention answers.
- Cross-group evidence, owner identity invention, merge cycles, stale versions, and unsupported transitions are terminal candidate rejections.
- Physical evidence deletion invalidates projections before the affected state may be retrieved again.

Operator status reports queue counts, oldest age, cooldown, rejection counts by reason, projection repair counts, and DLQ counts without exposing content.

## 11. Rollout

Thread and action extraction use separate capability flags while sharing the same extraction run:

- group-memory extraction may remain enabled alone;
- thread extraction may be enabled per group;
- action extraction requires thread extraction and may be enabled per group;
- all new capabilities default disabled in deployment examples.

The first production rollout targets one internal Feishu test group. It verifies ordinary non-mention learning while proactive speech remains disabled. Expansion to more company groups requires clean queues, no permission violations, acceptable false-association rates, and operator review of rejected candidates.

## 12. Verification

### 12.1 Unit and Contract Tests

- every allowed and forbidden thread transition;
- every allowed and forbidden action transition;
- confidence thresholds and candidate invisibility;
- exact evidence-span verification;
- sender, mention, and unresolved-label owner binding;
- canonical merge selection and cycle rejection;
- schema-version compatibility and malformed-response handling;
- prompt ordering and independent context budgets.

### 12.2 Postgres and Redis Integration

- forward-only migrations and role grants;
- same-group foreign-key and transaction constraints;
- optimistic concurrency and deterministic idempotency;
- Feishu replay and concurrent Worker delivery;
- atomic authoritative writes and projection repair;
- retries, cooldown, DLQ replay, and runtime-disable semantics;
- evidence deletion and non-retrievability.

### 12.3 Executable End-to-End Acceptance

The acceptance harness uses real Core HTTP, Event Worker, Postgres migrations, Redis, extraction runtime, and Python Worker HTTP. Only the model provider is deterministic fake. It proves:

1. ordinary messages form a candidate and later promote it to an open semantic thread;
2. explicit completion resolves it and later explicit discussion reopens it;
3. two candidates merge without a cycle or cross-group association;
4. an explicit commitment creates one action and explicit completion updates it;
5. suggestions and brainstorming create no action;
6. candidates never appear in answers while relevant open threads do;
7. replay, concurrency, 429 cooldown, and runtime disablement create no duplicates or unauthorized writes.
8. an explicit natural-language correction updates the canonical thread or action while preserving the prior event history.

### 12.4 Real Feishu Acceptance

In one approved group:

1. participants discuss a topic without mentioning Iris;
2. the internal operator view shows an evidence-bound thread;
3. an explicit commitment produces the correct owner and action;
4. a later mention question retrieves the thread and action accurately;
5. explicit correction, completion, and reopening update state correctly;
6. Iris sends no unsolicited message during this slice.

## 13. Exit Criteria

This slice is complete only when:

- migrations, Core, AI Worker, queue behavior, and retrieval pass automated verification;
- the executable end-to-end harness passes from a clean environment;
- independent requirement and code review find no release blocker;
- one real Feishu group passes the acceptance flow;
- queues and DLQs are empty after acceptance;
- rollout remains reversible through capability disablement;
- coverage baseline is updated without claiming proactive follow-up or the whole Iris product is complete.

Once these gates pass, work moves to Phase 4A proactive-signal candidates. Additional hardening without a concrete failed gate is recorded as backlog rather than extending this phase indefinitely.
