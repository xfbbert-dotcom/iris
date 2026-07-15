# Iris Phase 3B: Automatic Group Memory Extraction

Status: implemented first slice; local executable acceptance passed; rollout remains disabled by default

Date: 2026-07-14

Parent constitution: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

## 1. Purpose

Phase 3A gave Iris a durable, evidence-bound current-group memory store and made those memories available during answer generation. It did not make Iris learn from ordinary group conversation automatically.

Phase 3B closes that gap. Messages in an enabled Feishu group may schedule asynchronous analysis even when nobody mentions Iris. A dedicated Python AI Worker proposes long-term memory candidates. TypeScript Core remains the authority that checks runtime policy, evidence, scope, idempotency, and persistence.

This phase implements an existing constitutional responsibility. It does not change the whitepaper's authority boundaries.

This design is the first delivery slice of the coverage baseline's broader Phase 3B. It learns evidence-bound `group` memories from ordinary conversation. Automatic topic aggregation plus `thread` and `action` memory extraction remain the next Phase 3B slice; this document and its implementation must not be presented as the completion of those capabilities or of Iris as a whole.

## 2. Scope

Phase 3B includes:

- automatic extraction from readable text messages in the current Feishu group;
- processing of ordinary messages that do not mention Iris;
- a dedicated durable Redis queue with retries, cooldowns, and a DLQ;
- a production Python AI Worker reachable only on the internal backend network;
- bounded batch extraction so busy conversation does not cause one model request per message;
- durable extraction requests and runs for exact recovery and idempotency;
- strict TypeScript validation before an extracted candidate becomes active group memory;
- operator status and DLQ recovery surfaces;
- fail-closed runtime behavior when Iris or group-context reading is disabled.

Phase 3B does not include:

- cross-group learning or company-wide memory;
- proactive messages, unresolved-thread reminders, or risk alerts;
- automatic task creation or action execution;
- automatic correction or deletion of an existing memory;
- automatic publication to a Feishu knowledge base;
- document or wiki content as extraction evidence;
- multi-tenant productization.

These exclusions keep automatic learning independently testable. Later proactive and knowledge-governance phases may consume the resulting memory but may not bypass its evidence and permission rules.

## 3. Constitutional Boundaries

The implementation must preserve these boundaries:

1. Feishu Gateway acknowledges callbacks before extraction work begins.
2. Postgres conversation messages remain the fact-layer evidence.
3. Redis transports asynchronous work; it is not the source of truth for message or memory content.
4. Python AI Worker performs intelligent extraction and returns candidates only.
5. TypeScript Core owns runtime policy, validation, persistence, audit, and operator actions.
6. Python AI Worker cannot call Feishu, write Iris Postgres tables, send messages, or execute actions.
7. An extracted group memory is internal working context, not official company knowledge.
8. Writing to the Feishu knowledge base remains a separate approval-gated action.

## 4. Architecture

### 4.1 Components

#### Extraction Planner

After a readable group message has been persisted, the event processor asks the planner to register extraction work. The planner stores one durable extraction request per provider message and enqueues a compact Redis job. A repeated Feishu event reuses the existing request and queue idempotency key.

The planner does not send message text through Redis. Queue jobs contain bounded identifiers only.

Eligible input requires non-blank readable text, an enabled group-context gate, and a sender other than the configured Iris bot identity. Iris must not extract memories from its own replies and create a self-reinforcing feedback loop.

#### Memory Extraction Queue

The new queue follows the existing Iris queue contract:

- pending, delayed, processing, seen, and dead-letter storage;
- atomic enqueue deduplication;
- startup recovery for the single-consumer rollout;
- atomic processed, retry, dead-letter, invalid-payload, and replay acknowledgements;
- bounded identifiers, payloads, batch limits, attempts, and error messages;
- tolerant operator-side parsing for malformed DLQ records.

The first 20-30 person deployment runs one active extraction consumer. Horizontal consumers require leased ownership and are out of scope.

#### Extraction Runtime

The TypeScript extraction runtime consumes queue jobs, resolves their durable requests, groups pending requests by group, and creates deterministic bounded extraction runs. It loads message evidence and existing active memories from the same group, then calls Python AI Worker.

The runtime re-checks policy before loading content and immediately before committing candidates.

#### Python AI Worker

The Python service exposes an internal versioned extraction endpoint. It validates request size, invokes the configured model provider, parses strict structured output, and returns candidates or a typed failure.

It receives only the bounded current-group extraction window and a bounded list of that group's existing active memories. Existing memories are supplied for duplicate and conflict detection; they are not valid message evidence for a new candidate.

#### Candidate Validator And Applier

TypeScript Core treats every model field as untrusted. It validates schema, category, length, confidence, evidence ownership, relation to existing memory, and runtime policy. Accepted candidates are applied in a transaction with the extraction run. Partial candidate application is forbidden.

### 4.2 Deployment Shape

The pilot deployment adds one `ai-worker` container:

```text
Feishu -> Core callback -> raw event queue -> event worker -> Postgres message fact
                                                    |
                                                    v
                                      memory extraction queue
                                                    |
                                                    v
                                  TypeScript extraction runtime
                                                    |
                                      internal authenticated HTTP
                                                    v
                                        Python AI Worker
                                                    |
                                      structured candidates only
                                                    v
                                  TypeScript validation + Postgres
```

The Python service has no public port. It joins only the Docker backend network and requires a dedicated bearer token in addition to network isolation.

## 5. Durable Data Model

### 5.1 Extraction Requests

`group_memory_extraction_requests` records one request for each eligible conversation message:

- request id;
- group id;
- conversation message id;
- provider message id;
- status: `pending`, `processing`, `completed`, or `skipped`;
- skip reason when applicable;
- extraction run id when claimed;
- created and updated timestamps.

The conversation message id is unique. Re-registering the same message is an idempotent replay, not new work.

### 5.2 Extraction Runs

`group_memory_extraction_runs` records a deterministic group batch:

- run id;
- group id;
- ordered request and evidence message ids;
- canonical SHA-256 input fingerprint;
- status: `processing`, `completed`, or `failed`;
- validated candidate result;
- failure classification without secrets or full prompt text;
- created, completed, and updated timestamps.

The input fingerprint is unique. Recovery reuses the same run and evidence window. A completed run is never sent to the model again.

The fingerprint covers canonical message-content hashes and the ids plus update versions of the active memories supplied for duplicate detection. The run stores references and hashes, not another unrestricted copy of the chat transcript. Before a retry, Core reloads the referenced facts and verifies the fingerprint. If an input was deleted or changed, the stale run is closed without a model call and the still-eligible requests are replanned from current facts.

The run and its accepted memories commit atomically. Request rows become `completed` in the same transaction. A crash cannot leave a completed request without its memories or visible memories from an incomplete run.

### 5.3 Message Selection

The runtime claims the earliest unclaimed requests for one group, ordered by conversation-message ingestion cursor `(created_at, id)`. It includes at most 40 new readable messages and may prepend up to 10 older readable messages as non-evidence conversational context.

Only claimed new-message ids may be cited as evidence. Prepended context helps interpretation but cannot independently support a memory.

If more requests remain, the runtime schedules a continuation. No request is skipped because a group exceeded one batch.

## 6. Queue Contract

A version 1 queue job contains:

```json
{
  "schemaVersion": 1,
  "idempotencyKey": "memory-extraction:<request-id>",
  "requestId": "<bounded-id>",
  "groupId": "<bounded-id>",
  "enqueuedAt": "<ISO timestamp>",
  "notBefore": "<ISO timestamp>",
  "attempts": 0
}
```

Message text, sender names, model prompts, and API credentials are forbidden in Redis payloads and DLQ diagnostics.

Jobs are deduplicated per extraction request. The worker may combine multiple jobs for the same group into one deterministic run. A job whose request is already completed or skipped is acknowledged as a safe no-op.

The job's `groupId` is routing metadata, not authority. It must exactly match the durable request and conversation-message ownership or the job is rejected as an invalid payload.

Ready jobs use a list and delayed retries use a sorted set scored by `notBefore`. Due jobs are promoted atomically before dequeue. A future-dated job is never repeatedly popped and requeued, so provider cooldown cannot turn into a Redis or CPU busy loop.

## 7. Python API Contract

### 7.1 Request

The request is bounded to:

- one group id;
- one run id and input fingerprint;
- at most 50 chronological message entries;
- at most 40 evidence-eligible message ids;
- at most 8 existing active group memories;
- an overall serialized request budget;
- explicit model timeout and response-size limits.

Each message includes only its Iris message id, sender id when available, timestamp, and normalized text.

### 7.2 Candidate Response

The service returns at most 8 candidates. Each candidate contains:

- category: `project`, `preference`, `person`, `term`, `workflow`, or `decision`;
- concise content;
- importance from 1 to 5;
- confidence from 0 to 1;
- one or more exact evidence message ids;
- relation: `new`, `duplicate`, or `conflict`;
- an existing memory id only when relation is `duplicate` or `conflict`.

Scope is fixed to `group` in Phase 3B. The model cannot create thread or action memory in this phase.

Free-form text outside the schema, unknown properties, excessive candidates, duplicate ids, non-finite numbers, and oversized fields make the response invalid.

When a candidate names an existing memory, Core verifies that the memory is active, was included in the exact request, and belongs to the same group. A model-provided memory id never expands visibility.

## 8. Candidate Admission Policy

A candidate becomes active memory only when all conditions pass:

- Iris remains globally enabled;
- incoming-event and group-context reading remain enabled for the group;
- relation is `new`;
- confidence is at least `0.85`;
- content and category pass Group Memory validation;
- every evidence id belongs to the exact extraction run;
- every evidence message still exists and belongs to the same group;
- the candidate is not an exact normalized duplicate of active group memory;
- the complete batch can commit atomically.

Duplicate candidates are recorded as rejected diagnostics and do not create memory. Conflict candidates are retained in the extraction-run result for future review but do not automatically correct or supersede existing memory.

Accepted memory uses `origin: "extractor"`, a system extraction identity for `createdBy`, and a Core-derived idempotency key based on the immutable run id and canonical candidate index. The model never chooses persistence identifiers.

## 9. Runtime And Permission Behavior

Runtime gates are checked at three points:

1. before registering an extraction request;
2. before loading message or memory content;
3. immediately before the transactional apply.

If global Iris, incoming-event processing, or `readGroupContext` is disabled, affected pending requests become `skipped` with a bounded reason and their queue jobs are acknowledged. They are not held for automatic processing after re-enable.

Disabling `readDocuments` does not affect this phase because document text is not an extraction source.

Cross-group evidence is always rejected. A group id from the queue or model cannot authorize data; Postgres ownership is authoritative.

## 10. Failure Handling

### 10.1 Isolation

Extraction registration happens after message persistence. Extraction model calls never run inside the raw event processor. Model latency, malformed output, provider errors, and extraction retries cannot delay Feishu callback acknowledgement, message fact persistence, document discovery, or mention replies.

If durable request registration or initial queue enqueue fails, the raw event worker surfaces the failure and retries the idempotent recovery path. Existing user-visible mention-reply idempotency remains authoritative.

### 10.2 Retry Classification

- network timeout and provider 5xx: retry after 30 seconds, 2 minutes, and then 10 minutes, capped at five attempts;
- provider 429: honor a valid `Retry-After` clamped between 60 seconds and 24 hours; otherwise begin at 15 minutes and exponentially increase the shared cooldown up to 6 hours;
- repeated quota exhaustion: keep the shared provider cooldown open instead of polling rapidly, then dead-letter after the bounded attempt limit for explicit operator replay;
- invalid model schema: retry once, then dead-letter with a bounded classification;
- invalid queue payload: atomically move to diagnostic DLQ;
- permission or runtime denial: skip and acknowledge, never retry;
- deterministic Core validation rejection: complete the run with rejected diagnostics, never retry.

`notBefore` is enforced without busy-loop model calls. Provider cooldown is shared by extraction jobs in Redis so multiple groups cannot independently hammer the same exhausted quota.

### 10.3 DLQ And Recovery

Internal operator APIs expose bounded status, DLQ listing, replay, batch replay, and deletion using the existing token-protected conventions. Replay resets attempts but does not bypass runtime gates or evidence validation.

An enabled but stopped extraction runtime, an unavailable Python worker, or a non-empty extraction DLQ degrades consolidated internal status. It does not make the public callback endpoint unavailable.

## 11. Observability And Audit

Status includes:

- extraction runtime enabled and running state;
- pending, processing, and DLQ counts;
- latest batch timing and outcome;
- Python worker readiness;
- provider cooldown state without credentials;
- accepted, rejected, duplicate, conflict, skipped, and failed counts.

Audit events identify run ids, memory ids, evidence ids, group ids, result classifications, and operator recovery actions. Audit and logs must not contain API keys, bearer tokens, full prompts, or complete message bodies.

## 12. Testing Strategy

### 12.1 TypeScript Unit Tests

- only eligible persisted messages register extraction requests;
- runtime-disabled groups do not register or process work;
- request and queue idempotency survive Feishu retries;
- queue bounds, atomic ACK paths, retry upgrade, corruption handling, and DLQ replay match existing queue invariants;
- batching is deterministic and never crosses groups;
- evidence context cannot become evidence;
- unknown, malformed, oversized, low-confidence, duplicate, and conflict candidates are rejected;
- cross-group and missing evidence fail closed;
- applying a run and its memories is atomic and replay-safe;
- 429 cooldown prevents repeated model calls;
- extraction failures do not block mention replies or document discovery.

### 12.2 Python Tests

- authenticated endpoint and strict request budgets;
- model prompt separates instructions from untrusted chat text;
- strict structured response parsing;
- candidate count and field bounds;
- timeout, 429, 5xx, blank response, and malformed JSON classification;
- no Feishu or Postgres capability exists in the worker.

### 12.3 Integration Tests

- real Postgres migrations and transactional recovery;
- real Redis enqueue, recovery, retry, cooldown, DLQ, and replay;
- Core-to-Python contract with a deterministic fake model;
- Docker Compose health and backend-only network access;
- a non-mention Feishu event produces an evidence-bound current-group memory;
- the new memory appears in a later answer for that group;
- disable-before-apply produces no memory and no delayed learning after re-enable;
- queue and DLQ return to zero after the acceptance path.

## 13. Rollout

The feature ships disabled by default behind a dedicated extraction runtime flag. Deployment order:

1. migrate Postgres;
2. start Python AI Worker and verify internal readiness;
3. start the extraction runtime with global Iris still disabled;
4. run deterministic internal contract and failure-path checks;
5. enable extraction for one pilot group;
6. observe memory quality, queue health, model cost, duplicate rate, and false-memory reports;
7. expand to the first 20-30 users only with no unresolved P0 or P1 finding.

Phase 3B is complete when ordinary non-mention conversation can produce useful, traceable current-group memory without weakening callback reliability, permissions, runtime disable, document access, or mention replies.
