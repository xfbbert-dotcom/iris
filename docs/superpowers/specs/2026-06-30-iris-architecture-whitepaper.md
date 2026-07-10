# Iris Architecture Whitepaper

Date: 2026-06-30
Status: Constitutional architecture for Iris v1
Product name: Iris

## 1. Product Identity

Iris is the company's female AI assistant and AI teammate. The name comes from the company's first AI assistant product, and should be treated as part of the product's identity rather than a generic bot label.

Iris is not only a Feishu knowledge-base chatbot. Iris is a company collaboration agent that lives in Feishu group chats, understands ongoing work, reads authorized documents and knowledge-base content, participates proactively, prepares actions, and helps turn discussions into trusted organizational knowledge.

Iris v1 is built for single-company internal/private deployment. The first version optimizes for validating company collaboration value, not for complete multi-tenant SaaS infrastructure.

Constitutional principle:

> Iris should feel like one coherent company AI teammate to users, while internally preserving clear module boundaries so the system can grow into company intelligence infrastructure.

## 2. Architecture Choice

Iris v1 uses a modular monolith plus Python workers:

- TypeScript Core App for Feishu integration, API, web admin console, permissions, approval, audit, orchestration, and product behavior.
- Python AI Workers for document parsing, embeddings, retrieval, memory extraction, summarization, draft generation, and proactive signal scanning.
- Postgres as the fact database.
- pgvector as the first semantic retrieval layer.
- Redis Queue as the async job layer.

This architecture is chosen over early microservices and over directly building on a generic RAG platform.

Rejected alternatives:

- Event-driven microservices from day one: powerful long term, but too much infrastructure before Iris's product behavior is validated.
- Dify/RAGFlow/AnythingLLM as the core platform: useful references, but Iris's core identity is a Feishu-native company collaboration agent, not a generic knowledge-base chat app.

Relevant references:

- [larksuite/oapi-sdk-python](https://github.com/larksuite/oapi-sdk-python) and [larksuite/node-sdk](https://github.com/larksuite/node-sdk) should guide Feishu/Lark API integration.
- [Dify](https://github.com/langgenius/dify), [RAGFlow](https://github.com/infiniflow/ragflow), and [AnythingLLM](https://github.com/mintplex-labs/anything-llm) may be studied for workflow, RAG, observability, private assistant, and document pipeline ideas, but they do not define Iris's architecture.

Constitutional principle:

> First use a small deployment shape to win speed; use strict domain boundaries to preserve future scale.

## 3. Core Modules

### 3.1 Feishu Gateway

Feishu Gateway receives Feishu events, validates signatures, parses group messages, identifies users and groups, sends Iris messages, and reads authorized Feishu documents and wiki content.

Feishu Gateway translates between Feishu and Iris. It must not make agent decisions by itself.

Feishu Gateway must acknowledge Feishu event callbacks immediately. The gateway should validate only the minimum required request authenticity, derive a bounded idempotency key, schedule raw event persistence, and return HTTP 200 within the platform timeout budget. Signal filtering, denoising, classification, memory extraction, queue persistence, and agent decisions must happen asynchronously after the gateway response.

Core App applies a global `256 KiB` JSON body budget before custom JSON parsing, Feishu verification, internal API validation, or queue enqueueing. Oversized direct JSON uploads are out of scope for the v1 chat and operator API surface; future larger ingestion paths need dedicated endpoints with their own streaming/storage budgets.

### 3.2 Conversation Memory

Conversation Memory stores the context Iris is allowed to know:

- messages from Feishu groups where Iris is present and enabled;
- documents that appeared in those groups and are readable by Iris under Feishu permissions;
- authorized Feishu wiki and knowledge-base content;
- documents or files manually given to Iris by users;
- decisions, tasks, unresolved threads, and action history derived from those sources.

### 3.3 Agent Orchestrator

Agent Orchestrator decides whether Iris should answer, ask a follow-up question, summarize, detect unresolved work, generate a task draft, generate a knowledge draft, or prepare another action.

Agent Orchestrator may use memory and retrieval, but it must not bypass permissions or approval rules.

### 3.4 Knowledge Governance

Knowledge Governance turns temporary discussions into trusted knowledge. It handles knowledge drafts, risk levels, evidence, review, publication, conflict detection, and Feishu knowledge-base synchronization.

Knowledge Governance must not directly trust model output as official company knowledge.

### 3.5 Approval & Action Layer

Approval & Action Layer is the gate for high-impact actions. Iris may proactively discover an opportunity and prepare a draft, but high-impact actions require confirmation before execution.

High-impact actions include:

- writing to the formal Feishu knowledge base;
- modifying or deleting documents;
- creating or assigning formal tasks;
- sending content to another group;
- using external systems;
- using data sources beyond the current approved visibility scope.

### 3.6 Admin Console

Admin Console is Iris's governance cockpit. Daily collaboration happens in Feishu; governance, configuration, review, and audit happen in the web admin console.

### 3.7 AI/RAG Workers

Python AI/RAG Workers perform intelligent processing:

- document parsing;
- document chunking;
- embedding generation;
- retrieval;
- memory extraction;
- group summarization;
- knowledge draft generation;
- proactive signal scanning;
- model-provider adaptation.

AI Workers must not directly operate Feishu or execute high-impact actions. They produce analysis, candidates, summaries, and drafts for the Core App.

Constitutional principle:

> Feishu Gateway does not decide. Agent Orchestrator does not bypass permissions. Knowledge Governance does not directly trust the model. Approval & Action Layer gates high-impact actions.

## 4. Visibility And Data Sources

Iris can read four categories of content:

1. Messages in Feishu groups where Iris is present and enabled.
2. Documents that appeared in those groups and are readable under Feishu permissions.
3. Feishu wiki or knowledge-base spaces explicitly authorized by administrators.
4. Documents, files, or links manually provided to Iris by users.

Iris must be able to read document bodies, not only document links, when a readable document appears in a group where Iris is present. The document must be registered as a group-visible document, then fetched through Feishu APIs, parsed, indexed, and associated with its source group, source message, version, and permission state.

Document source types:

- Group-visible document: appeared in a group where Iris is present.
- Authorized knowledge-base document: belongs to an authorized Feishu wiki or knowledge-base space.
- User-submitted document: manually given to Iris by a user.

Document-source evidence timestamps must be valid before entering either the in-memory v1 registry
or the Postgres fact layer. Invalid `observedAt` values are rejected before state mutation or
transaction work so document provenance remains sortable and auditable.

Document snapshot timestamps must be valid before persistence. Invalid `fetchedAt` values are
rejected before succeeded or failed snapshot inserts so snapshot ordering, latest-snapshot lookup,
and downstream indexing remain deterministic.

Conversation message timestamps must be valid before persistence. Invalid `sentAt` values are
rejected before live-chat context upserts so recent-message ordering remains trustworthy for
answer-time context assembly.

Iris must not use a document link to bypass Feishu permissions. If a document is deleted or its permissions change, Iris's index must be invalidated, refreshed, or downgraded.

When a document source is marked `denied`, Iris must disable every document-content capability for that source, including answer retrieval and knowledge draft generation. Later rediscovery, source-type upgrades, or repeated registration must not silently re-enable denied document usage; only an explicit permission state change and administrator policy update may make the source usable again.

When an administrator disables a document source capability, Iris must preserve that operator intent across later rediscovery or source-type upgrades. This includes the subtle case where a user-submitted document defaults to `canUseForKnowledgeDrafts=false`: the system must distinguish that default from an explicit admin override before auto-enabling knowledge draft usage after an authorized wiki upgrade.

Document source policy updates from Admin Console are control-plane writes. When one request changes more than one document-content capability, Iris must apply those policy fields as one authoritative source update rather than a sequence of independent writes. A failed policy update must not leave the source half-enabled or half-disabled.

Local permission state is never enough for sensitive retrieval. Before document fragments retrieved from pgvector are passed into the LLM, TypeScript Core App must run a real-time permission guard against Feishu for the candidate document IDs whenever the answer depends on document content. This guard exists because indirect permission changes, such as parent-folder permission changes or group membership changes, may lag behind or bypass clean webhook notifications.

Current implementation: answer-time `source-policy` retrieval first checks the local source registry and runtime capabilities, then requires a Feishu live permission probe for Feishu docx/docs/wiki URLs before allowing candidate fragments into prompt context. If Feishu OpenAPI credentials are missing, Feishu document fragments fail closed and are excluded from prompt context. Direct docx/docs URLs are checked through document metadata lookup; wiki URLs are resolved through wiki node lookup and then checked as documents. Unsupported non-Feishu URLs continue to rely on local source policy until a matching live checker exists. Explicit denied/not-found responses and known Feishu permission-denied response codes are excluded as denials; local source-registry lookup failures, unknown non-zero Feishu permission response codes, transient Feishu failures, and timeouts are excluded as permission guard errors so operators can diagnose infrastructure outages separately from real permission denials.

Runtime retrieval controls must be pushed down before vector search. When group document reading or knowledge-base retrieval is disabled, Iris must constrain semantic search to the remaining allowed document source types instead of fetching disabled categories and filtering them only after retrieval. User-submitted documents remain allowed unless a future dedicated user-document capability disables them.

Local document permission eligibility must also be pushed down before vector ranking. Semantic
search may rank only answering-enabled sources in `unknown` or `readable` permission state;
`stale` and `denied` sources must not consume the bounded candidate window. Local source policy and
the real-time Feishu permission guard still run after retrieval and remain the final authorization
boundary before document content enters the model.

Feishu document source URIs must pass the same token parser whether they arrive from group chat discovery, authorized wiki registration, or user-submitted registration. Query strings, fragments, and trailing path slashes may be stripped during canonicalization, but chat punctuation, adjacent prose, or percent-encoded token contamination must not be accepted as part of a document token. If a submitted Feishu docx/docs/wiki URI contains an ASCII comma or any percent-encoded sequence inside the token segment, Iris rejects it before registration, permission checks, sync, or retrieval.

Manual and authorized document registration distinguish raw copied URLs from canonical source URIs. The API boundary may accept a longer raw Feishu URL so disposable query strings and fragments can be stripped, but the normalized canonical `sourceUri` must still fit the document-source storage budget before it reaches runtime registration or persistence. Raw input leniency must never expand the long-lived fact-layer URI contract.

Supported Feishu document source paths must map to exactly one document token. Iris accepts only `/docx/:token`, `/docs/:token`, or `/wiki/:token` after host validation; extra path segments and percent-encoded path separators inside the token segment are rejected before registration and sync. Ambiguous URLs should be corrected by the user or re-shared from Feishu rather than partially parsed.

Feishu document sync reads are external I/O and must always be bounded by request timeouts that cover both response headers and body consumption. If tenant-token acquisition, wiki-node lookup, raw-content fetch, or response body reading stalls, Iris must fail the document sync attempt and let the queue retry/dead-letter policy handle recovery rather than occupying a worker indefinitely.

Document sync workers must not treat a stale pre-claim source read as permission to fetch. After a worker marks a source as `syncing`, it must treat the returned source record as authoritative, re-check permission state and usage capabilities, and abandon the fetch if the source has become denied or disabled. When this happens, the worker must restore the source to `pending` so future administrator changes can re-enable sync without leaving the source stuck in an in-flight state. The same restore-before-reject rule applies when a worker reads an already-`syncing` source that has since become denied or fully disabled; rejection must not preserve a stale in-flight lock.

Manual document sync enqueue is a control-plane recovery action. If Iris has to reset a source from `synced` or `failed` back to `pending` before enqueueing a manual sync job, and the queue enqueue fails, Iris must restore the source's previous sync state before surfacing the queue error. Operator status must not show a source as pending when no corresponding sync job exists. If a manual sync request observes a source already stuck in `syncing` but now denied or fully disabled, Iris must restore it to `pending` before returning the rejection so the operator action can clear stale in-flight locks without enqueueing unsafe work.

Constitutional principle:

> Iris reads both chat text and readable document bodies. Every document entering memory must preserve source, permission, version, and visibility scope.
> Retrieval must re-check live permissions before document content reaches the model. Cached permission state can accelerate recall, but cannot authorize final context injection.

## 5. Data Flow And Memory

Iris's data flow has four layers: event, fact, semantic, and action.

### 5.1 Event Layer

Feishu messages, document links, files, mentions, user submissions, wiki updates, and admin changes enter through Feishu Gateway or Admin Console.

Feishu Gateway's event ingestion path must be designed for overload. In high-volume groups, the gateway must avoid heavy signal filtering and Redis persistence work before acknowledgment. Raw events should be scheduled into Redis Queue or an equivalent durable queue immediately after acknowledgement, then processed by asynchronous workers with idempotency keys, retry limits, backpressure, and dead-letter handling.

Raw event idempotency keys must be bounded. Platform event IDs seed the primary
deduplication keys. When a Feishu message callback lacks a usable event ID, the
message ID becomes the secondary deduplication key so platform retries with
slightly different wrapper metadata do not duplicate the same message event. If
the `message:` prefix would make an otherwise usable message ID exceed the raw
event ID budget, Iris must hash the message ID itself into a compact
`message-hash:<sha256>` key rather than falling back to a body hash. If neither
event ID nor message ID is usable, Iris falls back to a canonical body hash.
Oversized external IDs must never create oversized Redis keys. The fallback hash
sorts JSON object keys recursively before SHA-256 hashing so semantically
identical callbacks do not duplicate merely because object key order changed.

Raw Feishu event DLQs are operator recovery surfaces. Iris must support bounded listing, explicit replay, and deletion for raw event dead letters. Replay must not remove the DLQ payload until the reset raw event has been accepted back into the queue.

Feishu message content parsing must be bounded before and after JSON parsing. The raw `message.content` JSON string must stay within a fixed budget before `JSON.parse`; over-budget content is treated as unreadable text while preserving message metadata. Post-message text extraction should preserve normal readable text and links, but it must cap traversal depth and collected text parts so malformed or unusually large payloads cannot monopolize an event worker.

The consolidated internal status endpoint is the operator's first health surface. Non-empty DLQs for raw events, document sync jobs, or reindex jobs must mark the corresponding component as degraded with an explicit dead-letter reason, even when the worker is still running and the latest batch succeeded.

Enabled runtime components that report `running: false` must make the consolidated top-level status non-healthy, even when their component-level `ok` field is otherwise true. A stopped enabled worker means Iris is configured to perform that job but is not actually doing it. Intentionally disabled components remain visible as disabled/info attention items rather than being treated as runtime failures.

Internal status summary counts must be derived from component `status` values. Components with
`status: "stopped"` are not healthy: they must be included in `degradedComponents` and counted by
`degradedComponentCount`, while disabled components remain in their separate disabled summary.

Every event must preserve:

- source group;
- source user;
- source message;
- thread or topic;
- referenced document;
- whether Iris was present in the group;
- whether the source belongs to an authorized knowledge base;
- whether the source was manually submitted;
- timestamp and processing state.

### 5.2 Fact Layer

Postgres stores Iris's provable facts:

- users, groups, roles, and configuration;
- Feishu event metadata;
- message and document indexes;
- data-source permissions;
- tasks, reminders, approvals, and action records;
- knowledge drafts;
- audit logs.

If Iris claims that something happened, the system should be able to trace that claim to fact-layer evidence.

### 5.3 Semantic Layer

pgvector stores embeddings for:

- group-chat fragments;
- document fragments;
- knowledge-base fragments;
- task contexts;
- long-term memories.

The semantic layer helps Iris retrieve context, but it is not the authority layer.

### 5.4 Memory Types

Iris memory is divided into:

- short-term context: recent messages in the current group;
- thread memory: how one topic evolved over time;
- group memory: long-term project, preference, person, term, and workflow knowledge for a group;
- company knowledge memory: authorized and reviewed knowledge-base content;
- user-submitted memory: materials explicitly given to Iris;
- action memory: what Iris suggested, what was approved, what was rejected, and what was completed.

### 5.5 Answer Retrieval Order

When answering, Iris should search in this order:

1. current group-chat context;
2. current group's long-term memory;
3. readable document bodies that appeared in the current group;
4. authorized Feishu knowledge-base content;
5. user-submitted materials;
6. Iris's prior action records.

If group discussion conflicts with the Feishu knowledge base, Iris must expose the conflict rather than pretending certainty. It should explain the knowledge-base version, explain the newer group discussion, and suggest creating an update draft.

The retrieval order is not the same as prompt assembly order. Agent Orchestrator must protect live conversation context from being diluted by large recalled documents. Recent raw group messages, such as the latest 20 relevant messages, must be treated as the context anchor and placed closest to the model's answer position. Background documents and knowledge-base passages must be separated from live chat with explicit structured tags, for example:

```xml
<background_documents>
  <!-- retrieved document and knowledge-base passages with citations -->
</background_documents>

<live_chat_context>
  <!-- recent raw group messages and current thread context -->
</live_chat_context>
```

Document recall must be budgeted and ranked so large PDFs or technical specifications cannot flood the context window and erase the user's current intent.

Semantic retrieval queries should include both the user's current question and the bounded live-chat
window that Iris will use as answer context. This lets follow-up questions such as "What about
this?" retrieve documents using the actual group discussion, while the final prompt still keeps live
chat anchored after background documents.

Live-chat history loading may scan more raw group events than it injects into the prompt because
recent Feishu traffic can include images, stickers, blank text, or document-only messages. The
current v1 Core implementation scans up to three times the requested live-chat output window, capped
at 100 raw messages, then filters to non-blank text and injects at most the latest 20 useful text
messages. This backfill improves answer continuity without increasing the prompt's live-chat budget.

Constitutional principle:

> Iris may use semantic memory for recall, but must use fact-layer sources for important claims. Long-term memory must be traceable, deletable, correctable, and permission-bounded.
> Live chat context is the anchor of an answer. Background documents inform the answer, but must not overwrite the immediate conversational intent.

## 6. Permission, Safety, And Proactive Behavior

Iris is proactive by design. It can participate like a teammate, not only respond after being mentioned.

Iris may proactively:

- summarize group progress;
- identify unresolved but quiet threads;
- remind the group of risks or missing follow-ups;
- suggest next actions;
- generate task drafts;
- generate knowledge drafts;
- detect potentially stale knowledge-base content;
- detect conflict between group discussion and knowledge-base content.

Iris may not execute high-impact actions without confirmation.

Actions requiring confirmation include:

- writing formal knowledge-base content;
- modifying or deleting Feishu documents;
- creating or assigning formal tasks;
- forwarding current-group content to another group;
- using unauthorized data sources;
- calling external tools or systems for high-impact effects.

All high-impact actions follow:

```text
Iris detects an opportunity
-> Iris prepares a suggestion or draft
-> Iris asks for confirmation in the relevant place
-> an authorized user confirms
-> Iris executes the action
-> Iris writes an audit log
-> Iris reports the result back
```

Proactivity must be controlled by strategy:

- group importance;
- discussion speed;
- whether humans are already driving the issue;
- whether a decision, task, risk, or blocker appeared;
- time since Iris last proactively spoke;
- user feedback on Iris's behavior.

Constitutional principle:

> Iris can be proactive, but every proactive behavior must be explainable, configurable, rate-limited, auditable, and pausable. Iris cannot use "I remember" as a substitute for "I am allowed to know."

## 7. Knowledge Governance

Iris's knowledge goal is not to dump all chat into the knowledge base. Iris turns temporary discussion into trusted company knowledge.

### 7.1 Knowledge Draft Sources

Iris may generate knowledge drafts from:

- group conclusions;
- repeated questions and answers;
- emergent workflows, rules, or SOPs;
- documents discussed in groups;
- outdated or conflicting knowledge-base pages;
- user-requested summaries or materials.

### 7.2 Content Risk Levels

Low-risk content:

- group summaries;
- meeting notes;
- project weekly summaries;
- FAQ drafts.

Low-risk content may be written to a configured location after group confirmation.

Medium-risk content:

- project workflows;
- collaboration norms;
- product descriptions;
- customer background;
- retrospectives.

Medium-risk content enters the knowledge draft area and requires owner review.

High-risk content:

- company policy;
- finance;
- HR;
- legal;
- strategy;
- customer commitments;
- permission rules.

High-risk content must enter the knowledge draft area and require review by an administrator or authorized owner.

### 7.3 Knowledge Draft Area

The Admin Console must include a knowledge draft area with:

- draft title;
- source group, document, or knowledge-base page;
- evidence used by Iris;
- generated content;
- suggested publication location;
- risk level;
- reviewer;
- status: pending confirmation, pending review, published, rejected, or needs revision.

### 7.4 Publication Flow

```text
Iris generates a knowledge draft
-> Iris asks for confirmation in the group when relevant
-> draft enters the Admin Console
-> reviewer reviews or edits the draft
-> Iris writes to Feishu knowledge base
-> Iris records Feishu document ID and version
-> Iris reports publication back to the group
```

### 7.5 Conflict Handling

When group discussion conflicts with the knowledge base, Iris must:

- identify the conflicting sources;
- state the current knowledge-base version;
- state the newer group conclusion;
- generate an update suggestion;
- request confirmation or review.

Constitutional principle:

> Iris can help the company form knowledge, but cannot unilaterally define official company knowledge. Everything entering the knowledge base must be traceable, reviewable, editable, and reversible.

## 8. Admin Console And Runtime Control

Feishu groups are Iris's collaboration surface. The web admin console is Iris's governance surface.

The Admin Console must support:

- global enable/disable for Iris;
- per-group enable/disable;
- emergency pause for all proactive behavior;
- pause for document reading;
- pause for knowledge-base writing;
- pause for external tool calls;
- system health and runtime status.

The consolidated operator status surface must include runtime-control state. An operator who reads
`/internal/status` should be able to tell whether Iris is globally disabled and how many group
scopes are disabled without needing to know the dedicated runtime-control endpoint first.
It must also surface broken core chat wiring. If the Feishu event worker is running but @Iris
mention replies are unavailable because bot identity, Feishu OpenAPI config, or the answer draft
orchestrator is missing, the consolidated `eventWorker` component must be degraded with
`degradedReason: "mention_replies_unavailable"`. Non-empty raw-event DLQs still take precedence as
`degradedReason: "dead_letters_present"`.

Consolidated worker health must also reflect the latest polling result. If the event, document-sync,
or reindex runtime reports `latestBatch.status = "failed"`, its `/internal/status` component must be
degraded with `degradedReason: "latest_batch_failed"` while preserving the bounded batch error
snapshot. A later successful batch replaces the snapshot and may restore health. Worker health
evidence precedence is non-empty DLQ, failed latest batch, then event mention-reply unavailability.
Worker-specific status endpoints keep their existing status-read semantics.

Internal operator APIs must have an explicit protection boundary. During the early internal rollout,
Core may use a shared `IRIS_INTERNAL_API_TOKEN` Bearer guard for `/internal/*` routes while Feishu
callback and health endpoints remain separately governed. The guard must match the request path
before the query string so `/internal?probe=1` and `/internal/status?details=1` cannot bypass the
boundary. It must also evaluate the once percent-decoded path so encoded variants such as
`/%69nternal/status` or `/internal%2Fstatus` cannot be decoded by the router after bypassing the
guard. The `Bearer` scheme may be matched case-insensitively for HTTP client compatibility, but the
token value itself must remain an exact shared-secret match. This is a rollout control, not the final
admin identity model.

The direct Core server entry point must fail safe when that shared token is absent. Credential-free
local development may continue, but the process must bind only to `127.0.0.1`; listening on all host
interfaces (`0.0.0.0`) requires both a valid `IRIS_INTERNAL_API_TOKEN` and a non-blank
`FEISHU_VERIFICATION_TOKEN`. This listener rule complements both request guards and prevents an
omitted credential from silently exposing operator APIs or an unauthenticated Feishu callback to the
host network. `FEISHU_ENCRYPT_KEY` alone does not satisfy this v1 listener prerequisite.

Internal rollout readiness is a configuration contract, not a runtime-health substitute. Iris must
provide a shared readiness profile for the first 20-30 person rollout through both a local CLI and
an internal operator endpoint. The profile must fail blocked configurations that would prevent the
core product loop or operator boundary from working: Feishu event ingestion, document sync, semantic
reindexing, @Iris answer drafting, Feishu OpenAPI access, bot identity, model provider, embedding
provider, `source-policy` live permission checks, and `IRIS_INTERNAL_API_TOKEN`. A trusted private
network is still required, but it is not a substitute for the v1 bearer-token guard on `/internal/*`
operator APIs. The readiness surface must list the responsible environment variables and must not
attempt live network calls; live status remains the responsibility of `/internal/status` and the
worker-specific status endpoints.

For v1 Feishu callback readiness, `FEISHU_VERIFICATION_TOKEN` is required. `FEISHU_ENCRYPT_KEY` may
be configured for request signature verification, but it must not be treated as encrypted callback
payload support until Iris implements encrypted body decryption and challenge extraction. At runtime,
each configured Feishu callback secret is a required check: token-only deployments require the body
token, signature-only deployments require the Feishu signature, and deployments with both configured
require both the token and signature to match.

When Iris is disabled, it should stop processing new messages, stop proactive speech, and stop executing tasks. Admins may still view logs and configuration.

Feishu may still deliver events to the system while Iris is disabled. In that state, Iris should acknowledge or safely discard events according to Feishu platform requirements, but must not index message content, update semantic memory, generate replies, or execute actions unless an administrator explicitly re-enables the relevant scope.

Runtime-control mutations must be auditable. During the early internal rollout this can use the
same bounded in-memory audit log as permission diagnostics, but emergency enable/disable paths must
remain available even if the audit sink is unavailable.

App shutdown is also a runtime-control boundary. If one composed runtime fails during close, Iris must still attempt to close the remaining runtimes before surfacing the shutdown error, so worker loops and external clients do not leak because an earlier cleanup step failed.

Group management should show:

- groups where Iris is installed;
- whether Iris is enabled in each group;
- proactive level per group;
- knowledge-base spaces available to each group;
- group owners;
- recent summaries, tasks, knowledge drafts, and errors.

Data-source management should cover:

- group-visible documents;
- authorized Feishu knowledge-base spaces;
- user-submitted materials.

Each data source must expose:

- source;
- permission scope;
- sync status;
- last update time;
- whether it can be used for answering;
- whether it can be used for cross-group reference;
- whether it can be used to generate knowledge drafts.

Capability switches should include:

- answer after being mentioned;
- read group context;
- read group-visible document bodies;
- retrieve Feishu knowledge base;
- proactively summarize;
- proactively ask follow-up questions;
- proactively warn about risks;
- generate task drafts;
- generate knowledge drafts;
- write to Feishu knowledge base;
- call external tools.

Constitutional principle:

> All Iris capabilities must be controllable by administrators. Proactivity must be adjustable. High-risk capabilities must support emergency pause.

`readGroupContext` is a hard runtime boundary for passive group memory. When disabled for a group or
globally, Iris must stop writing new group-message facts and must not automatically load stored live
chat history into answer prompts. A user may still explicitly provide the current request text to
Iris when mention replies are enabled, but previously persisted group chat history must stay out of
the answer-time context until group-context reading is re-enabled.

## 9. Technical Stack And Deployment

Minimum v1 deployment:

```text
1 TypeScript Core App
1 Python AI Worker pool
1 Postgres instance with pgvector
1 Redis instance for queues
```

Docker Compose is acceptable for the first internal deployment.

TypeScript Core App responsibilities:

- Feishu Gateway;
- API service;
- Admin Console backend;
- permission and audit;
- approval flow;
- Agent Orchestrator;
- Knowledge Governance;
- task and reminder scheduling.

Python AI Worker responsibilities:

- parse documents;
- chunk documents;
- create embeddings;
- retrieve context;
- extract long-term memory;
- summarize groups;
- generate knowledge drafts;
- scan proactive signals;
- adapt model providers.

Postgres stores facts. pgvector stores semantic indexes. Redis Queue handles async work.

Constitutional principle:

> TypeScript Core App owns product behavior, permissions, and actions. Python AI Workers own intelligent processing. Postgres is the fact layer; pgvector is the semantic layer. They must not be confused.

## 10. Evolution And Service Splitting

Iris v1 does not start as microservices. It starts as a modular monolith with clear service boundaries.

Evolution stages:

1. Internal MVP: validate Feishu group collaboration, document reading, knowledge-base retrieval, proactive participation, approval-before-action, knowledge drafts, and lightweight admin control.
2. Internal stable version: strengthen permission, audit, knowledge review, proactive configuration, unresolved-thread follow-up, and memory correction.
3. Module splitting: split specific modules only when real bottlenecks appear.
4. Multi-company or multi-tenant productization: introduce tenant-level data isolation, app installation, billing, tenant audit, and tenant admin.
5. Company Agent OS: extend Iris beyond Feishu into GitHub, CRM, email, calendar, code repositories, project management, data systems, and other connectors.

Modules likely to split later:

- AI/RAG Worker Service;
- Feishu Ingestion Service;
- Proactive Engine;
- Knowledge Sync Service;
- Audit & Compliance Service.

Service splitting criteria:

- performance bottleneck;
- stability bottleneck;
- independent scaling need;
- release-risk isolation;
- team ownership boundary;
- security isolation.

Splitting sequence:

```text
module boundary
-> internal interface
-> async queue
-> independent deployment
-> independent database only if needed
```

Splitting is an upgrade, not deletion. A split module continues to evolve as a specialized Iris subsystem.

Constitutional principle:

> Do not microservice Iris for imagined scale. Split only when real bottlenecks justify it. Splitting must never reduce permission, audit, or traceability guarantees.

## 11. Future Requirement Decision Rules

Every future requirement must be classified before implementation.

Ask:

1. Does this change what Iris can see?
2. Does this let Iris perform high-impact actions?
3. Does this change the authority of the knowledge base?
4. Does this bypass the fact layer?
5. Does this change how proactive Iris can be?
6. Does this require a new module boundary?
7. Does this require service splitting?
8. Does this block future multi-company productization?

Requirement classes:

- Ordinary requirement: does not change permission, knowledge governance, or high-impact actions. It can proceed to product design and implementation.
- Architecture-related requirement: adds a data source, proactive behavior, tool call, or knowledge-writing path. It must update the design before implementation.
- Constitutional requirement: changes Iris's identity, permission boundary, memory mechanism, knowledge authority, deployment shape, or multi-tenant direction. It must be discussed and approved before implementation.

Constitutional principle:

> New requirements cannot only ask "can we build this?" They must ask whether the requirement changes Iris's visibility, action power, knowledge authority, memory boundary, or deployment boundary. If it does, update architecture before writing code.

## 12. Architecture Pressure Tests And Evolution Simulations

Iris architecture decisions must be tested against real collaboration pressure, not only ideal flows.

### 12.1 Permission Invalidation Delay

Pressure:

Feishu may provide clean webhook notifications for direct document deletion or updates, but indirect permission changes can be delayed or incomplete. Examples include permission changes inherited from parent folders, wiki-space permission changes, or group membership changes that indirectly remove a user's or group's document access.

Required architectural response:

- Do not trust local permission cache as final authorization for retrieved document content.
- Run a real-time permission guard before injecting retrieved document fragments into the model context.
- If real-time permission verification fails or times out for sensitive content, exclude that fragment from the prompt.
- Record permission-guard denials and timeouts in audit logs.
- Keep background invalidation jobs, but treat them as cleanup and acceleration rather than final enforcement.
- Map guard-approved fragments back to retrieved content by both fragment ID and document/source ID. A fragment ID alone is not a sufficient authorization join key.

Implementation status:

- TypeScript Core App now requires a Feishu live permission checker before answer-time `source-policy` retrieval can inject Feishu docx/docs/wiki fragments into prompt context.
- The checker avoids external calls for unsupported non-Feishu URLs, resolves wiki nodes before document checks, uses bounded request timeouts, and keeps transient Feishu failures distinct from explicit denied/not-found responses.
- The checker treats only known Feishu permission-denied response codes as ordinary denials. Unknown non-zero Feishu codes are permission guard errors, preserving fail-closed filtering while keeping upstream/auth failures observable.
- Local source-registry lookup failures propagate through the permission guard as `permission_guard_error` audit events. Missing sources, disabled capabilities, denied sources, and stale sources remain ordinary denials.
- Permission-filtered retrieval now binds allowed fragments to both fragment ID and document source ID, so duplicate or corrupted fragment IDs cannot leak denied document text into prompt context.
- The current checker is process-local. If latency, rate limiting, or repeated checks become material, the next architecture step is a dedicated Permission Guard Service.

Evolution signal:

If real-time permission checks become a latency bottleneck, Iris may introduce a dedicated Permission Guard Service with short-lived permission tokens, request coalescing, and per-document permission freshness policies. This service must remain on the critical path before model context injection.

### 12.2 Feishu Callback Timeout And Message Overload

Pressure:

Feishu event callbacks have strict response-time expectations. If high-volume group traffic triggers heavy signal filtering inside Feishu Gateway, callback responses can time out and cause Feishu to retry, creating duplicate events and additional load.

Required architectural response:

- Feishu Gateway must be "ack-first": validate minimally, derive bounded idempotency keys, schedule raw event persistence, and return HTTP 200 quickly.
- Raw queue persistence, signal filtering, denoising, categorization, memory extraction, and agent decisions must happen after acknowledgment.
- Ack-first applies to every queue backend, including the legacy in-memory fallback. A degraded or local queue adapter must not start persistence work before the callback response has been produced.
- Async workers must support idempotency, retry limits, backpressure, and dead-letter handling.
- Queue overload must degrade Iris's intelligence gracefully rather than breaking Feishu callback handling.

Evolution signal:

If event throughput grows beyond the Core App's ingestion capacity, split Feishu Ingestion Service first. It should specialize in callback reliability, deduplication, rate limits, and event delivery guarantees while keeping Agent Orchestrator separate.

### 12.3 Long-Document Context Washout

Pressure:

Large documents, such as long technical PDFs or specifications, may produce many chunks. If too many retrieved chunks enter the prompt, the live group conversation can be diluted and Iris may answer the background document rather than the current user intent.

Required architectural response:

- Treat recent group conversation as the Context Anchor.
- Keep live chat close to the model answer position in prompt assembly.
- Separate background documents from live chat with explicit structured tags.
- Budget document recall aggressively by source, recency, relevance, and question intent.
- Prefer citations and concise extracted evidence over raw bulk context.

Evolution signal:

If document-heavy groups become common, introduce a Context Assembly module or service responsible for ranking, compression, source budgeting, prompt layout, and evaluation of answer faithfulness to live-chat intent.

### 12.4 Feishu Document Fetch Stall

Pressure:

Feishu document APIs or the network may stall during tenant-token acquisition, wiki-node lookup, raw-content fetch, or response body reading. Without a bounded request timeout across the full HTTP response lifecycle, a document sync worker can remain occupied by one external call and reduce the system's ability to process newer work.

Required architectural response:

- Every Feishu document sync token request and document body request must carry an abortable timeout through response body consumption.
- Timeout failures must become explicit document sync failures, not hanging promises.
- Queue retry and dead-letter policy must handle repeated fetch stalls.
- Operators must be able to tune the timeout for their deployment without changing code.

Evolution signal:

If document fetch stalls or Feishu rate limits become frequent, Iris may introduce a dedicated Document Fetch Service with request coalescing, adaptive backoff, per-source freshness policies, and provider-specific rate-limit handling. The service must still preserve source visibility and permission boundaries.

### 12.5 Worker Observability Hook Failure

Pressure:

Worker loops may call observability hooks for batch failures. If those hooks throw because logging, metrics, or status capture code is broken, Iris must not turn an already-handled batch failure into an unhandled worker-loop rejection.

Required architectural response:

- Worker loops must record failed batch snapshots before reporting errors.
- Error reporting hooks must be best effort and isolated from polling control flow.
- A throwing observability hook must not stop future worker polling.

Evolution signal:

If observability becomes more complex, Iris may introduce a dedicated telemetry adapter with bounded queues and explicit drop policies. That adapter must remain noncritical to event processing, document sync, and reindex polling.

### 12.6 Feishu Gateway Enqueue Observer Failure

Pressure:

Feishu Gateway records queue persistence failures through an enqueue-error observer while preserving ack-first callback behavior. If that observer throws because app status capture, logging, or metrics code is broken, Iris must not create an unhandled rejection after acknowledging Feishu.

Required architectural response:

- Feishu Gateway must acknowledge valid callbacks independently of asynchronous queue persistence failures.
- Queue persistence failures should still be reported to the observer with the original error.
- Enqueue-error observers must be best effort and isolated from callback control flow.
- A throwing observer must not produce an unhandled rejection or affect later callback handling.

Evolution signal:

If gateway observability grows beyond simple counters and snapshots, Iris may route gateway events through a dedicated telemetry adapter with bounded buffering and explicit drop policy. That adapter must remain noncritical to Feishu callback acknowledgement.

### 12.7 Permission Guard Audit Failure

Pressure:

Answer-time permission filtering writes audit events when document fragments are denied or permission checks fail. If audit storage fails, Iris must not turn a safe fail-closed permission decision into a failed answer draft.

Required architectural response:

- Live permission guard decisions must remain authoritative even when audit logging fails.
- Denied or uncertain fragments must stay out of model context.
- Allowed fragments from other documents should still be usable in the same answer.
- Audit writes must be best effort unless a future product decision explicitly makes compliance-grade audit durability mandatory.

Evolution signal:

If audit durability becomes a compliance requirement, Iris should split audit persistence into a dedicated durable audit pipeline with retries and operator-visible backlog. That pipeline must not weaken answer-time permission enforcement.

### 12.8 Runtime Configuration Safety

Pressure:

Iris uses environment variables for external base URLs, timeouts, worker batch limits, and embedding
dimensions. JavaScript accepts integers beyond its safe precision range, which can silently distort
operator intent before values reach timers, queues, or embedding-profile logic. Invalid external
base URLs can defer configuration mistakes until request time, making rollout failures harder to
diagnose.

Required architectural response:

- Positive integer environment settings must be written as decimal digit strings and must also be
  safe JavaScript integers.
- The executable app listen port must use the same environment config boundary, default to `3000`,
  and reject values outside the valid TCP port range.
- Unsafe integers must be rejected during config loading with explicit errors.
- Model, embedding, and Feishu OpenAPI base URLs must be absolute `http` or `https`
  URLs without embedded credentials, query strings, or fragments before provider or fetcher
  runtimes are constructed.
- Redis connection URLs must be valid `redis://` or `rediss://` URLs before
  worker runtimes are constructed. Credentials and database paths may remain in
  the Redis URL because they are common deployment forms.
- Database connection URLs must be valid `postgres://` or `postgresql://` URLs
  before Postgres pools are constructed. Credentials, database paths, and query
  parameters may remain in the database URL because they are common deployment
  forms.
- External I/O adapters must re-validate timeout values at construction time so
  direct dependency injection cannot bypass environment validation.
- Worker loops must re-validate interval and batch-limit values at construction
  time so direct composition cannot bypass environment validation.
- Timeout and polling interval values that enter Node timers must also reject
  values above `2147483647ms` so timer overflow cannot turn an operator's long
  delay into an unexpectedly short timeout or polling loop.
- Worker `processBatch()` entrypoints must reject unsafe finite batch limits
  before dequeuing work, while retaining defensive `LIMIT 0` equivalent
  behavior for non-finite direct-call values.
- Queue `dequeueBatch()` and DLQ list entrypoints must reject unsafe finite
  limits before consuming in-memory entries or issuing Redis `lPop`/`lRange`,
  while retaining empty-result behavior for non-finite values. For v1, queue
  batch reads and DLQ list reads must cap safe finite direct-call limits to 100.
- Operator-facing numeric request fields that control batch or planning scope
  must reject unsafe integers at the API boundary, and planning components must
  defensively sanitize unsafe limits before reaching storage queries.
- Admin list/query limits must also reject unsafe integers before applying
  product caps such as maximum page size. For v1, the shared internal admin page
  cap is 100.
- Runtime list boundaries and audit-summary windows must reject unsafe finite
  limits before slicing already-loaded arrays, while retaining empty-result
  behavior for non-finite values. For v1, document-sync runtime lists and audit
  summary windows cap safe finite direct-call limits to 100.
- Answer-context window limits must reject unsafe numeric magnitudes before
  model orchestration or live-chat history reads. Retrieval and prompt assembly
  components, live-chat context providers, and conversation-message storage
  adapters must also reject unsafe numeric magnitudes when called directly,
  while retaining their defensive prompt-budget caps for safe finite values.
- Semantic fragment-search storage adapters must reject unsafe finite query
  limits before pgvector SQL is issued, while retaining the existing defensive
  `LIMIT 0` behavior for non-finite values. For v1, direct fragment search caps
  safe finite storage limits to 100; answer-time retrieval keeps its smaller
  prompt-specific candidate cap.
- Snapshot/reindex candidate storage adapters must reject unsafe finite query
  limits before SQL is issued, while retaining defensive `LIMIT 0` behavior
  for non-finite values. For v1, direct missing-profile and conversation-history
  storage queries cap safe finite limits to 100.
- Validation should not invent new product-specific business caps unless a
  separate architecture decision calls for them. Raising any v1 cap above 100
  requires revisiting operator UX, storage cost, and abuse resistance together.

Evolution signal:

If operators need richer deployment profiles, Iris may add named configuration presets for internal rollout, staging, and production. Numeric validation must remain strict before preset values reach runtime components.

### 12.9 Queue Retry Attempt Numeric Safety

Pressure:

Queue payloads persist retry attempt counters across process restarts, and queue constructors accept retry limit configuration. Redis payloads can be produced by old code, manual repair, or corrupted external state. If unsafe integer attempts or retry limits are accepted, retry and DLQ decisions can run on values JavaScript cannot represent exactly.

Required architectural response:

- Missing attempts remain backward-compatible and default to zero.
- Non-number, fractional, negative, and unsafe integer attempts must be rejected as invalid payloads.
- Queue `maxAttempts` configuration must reject unsafe integers before workers start.
- Invalid queued payloads must use the existing dead-letter diagnostic path instead of entering worker processing.

Evolution signal:

If queues gain schema versions, retry attempt validation should move into versioned payload decoders shared across raw event, document sync, and reindex queues.

### 12.10 Redis Dead-Letter Record Corruption

Pressure:

Redis dead-letter queues are operator recovery surfaces. During manual repair,
old deployments, interrupted writes, or external Redis manipulation, a DLQ list
item may be malformed or non-JSON. If one corrupt item makes the whole DLQ list,
replay, or delete operation throw, operators can lose visibility into the valid
entries they need to recover Iris.

Required architectural response:

- DLQ list-management parsers must be tolerant at the operator boundary.
- Corrupt DLQ records must be represented as non-replayable diagnostics rather
  than crashing the whole list.
- Diagnostics must preserve the exact raw Redis payload for inspection.
- If a malformed record still exposes a stored id, delete-by-id may remove it.
- Corrupt records must never be replayed into typed worker queues.

Evolution signal:

If DLQ schemas become more complex, Iris should introduce versioned queue payload
decoders and a repair/export tool for operators. The repair tool must improve
recovery visibility without weakening replay safety.

### 12.11 Feishu Tenant Token Refresh Stampede

Pressure:

Many Iris operations share Feishu tenant access tokens. When the cached token is
missing or expired, concurrent document sync, wiki lookup, or future Feishu API
calls can arrive at the same time. If every caller performs its own refresh,
Iris can create avoidable latency spikes, waste Feishu rate budget, and amplify
transient token endpoint failures.

Required architectural response:

- Token providers must return valid cached tokens immediately.
- Concurrent callers inside the same Core App process must share one in-flight
  refresh request.
- Failed or timed-out refreshes must clear the in-flight state so later calls can
  retry.
- Failed token responses must not be cached as successful credentials.

Evolution signal:

If Iris runs multiple Core App replicas and token refresh pressure appears across
processes, introduce a distributed token cache or short-lived refresh lock. That
cache must preserve timeout handling and must not turn token failures into stale
credential reuse.

### 12.12 Document Chunker Numeric Safety

Pressure:

Document chunking feeds embeddings and semantic retrieval. If invalid numeric
settings such as `NaN`, `Infinity`, fractional values, or unsafe integers are
accepted, JavaScript slicing and loop arithmetic can produce empty or distorted
chunks. That weakens Iris's ability to retrieve document evidence and may make
answers appear less grounded even when the source document was synced.

Required architectural response:

- Chunker size settings must be validated before any text is processed.
- `maxChunkChars` and `minChunkChars` must be positive safe integers.
- `minChunkChars` must remain less than or equal to `maxChunkChars`.
- Invalid chunker configuration must fail loudly rather than silently producing
  poor semantic memory.

Evolution signal:

If document types require specialized chunking, Iris may introduce document-type
profiles for prose, tables, code, transcripts, and PDFs. Those profiles must
still pass through strict numeric validation before reaching chunking logic.

### 12.13 Redis Retry Duplicate Upsert

Pressure:

Redis-backed queues release an idempotency key when a worker dequeues an item so
lost in-flight work can be recovered. If the platform or planner delivers the
same idempotency key again while the first item is still processing, a pending
duplicate with an older `attempts` value can already exist when the in-flight
item fails. A simple `SADD`/`RPUSH` retry can then no-op and leave the older
payload in Redis, weakening retry limits and delaying dead-letter visibility.

Required architectural response:

- Retry handling must preserve idempotency while upgrading pending duplicates to
  the newest retry payload.
- Redis retry paths for raw events, document sync jobs, and reindex jobs must
  atomically replace a queued duplicate when the idempotency key already exists.
- If no queued duplicate can be found, retry handling should enqueue the failed
  payload rather than silently losing the retry.
- Normal first-time enqueue semantics remain deduplicating and should not replace
  an existing queued item.

Evolution signal:

If queue semantics grow beyond simple Redis lists, Iris should move retry
ownership into a shared durable queue adapter with explicit in-flight leases.
That adapter must retain the same rule: failed work advances retry state instead
of being hidden behind an older duplicate.

### 12.14 Redis Seen Release Guard

Pressure:

Redis-backed queues also release seen keys when a queued payload is invalid and
has been moved to DLQ. That cleanup prevents a corrupt item from blocking future
work forever. However, Redis state may be manually repaired, stale, or partially
corrupted. If cleanup trusts only an `idempotencyKey` string from an invalid
payload, that payload can unlock unrelated work and let duplicate jobs enter the
system.

Required architectural response:

- Invalid-payload cleanup must never release a seen key from the key string
  alone.
- Document sync cleanup must recompute the canonical key from
  `documentSourceId` and release only on an exact match.
- Document reindex cleanup must recompute the canonical key from
  `embeddingProfileId` and `documentSnapshotId` and release only on an exact
  match.
- Raw event cleanup must at least prove Feishu provenance and the canonical
  `raw-event:feishu:` key shape before releasing.
- Payloads that cannot pass this lightweight check still go to DLQ, but they do
  not mutate the seen set.

Evolution signal:

If queues move to versioned payloads or a leased queue adapter, seen-release
guards should become part of the shared decoder contract. The operator recovery
surface must preserve the same principle: cleanup may unblock its own key, never
one inferred from untrusted data alone.

### 12.15 Group-Visible Retrieval Source Evidence

Pressure:

Group-visible documents are authorized through the groups where Iris observed
them. If a group-visible source loses its origin group and evidence group IDs
because of corrupted data, a partial migration, or a bad manual repair, Iris can
no longer prove which enabled group made the document visible. Letting that
document enter answer context would weaken group-level runtime controls.

Required architectural response:

- Answer-time source-policy retrieval must require at least one nonblank source
  group ID for group-visible documents when group-level runtime gating is
  available.
- If no group evidence exists, the source must be treated as denied for prompt
  assembly.
- User-submitted and authorized wiki documents keep their own source-type
  policies and are not affected by this group evidence requirement.

Evolution signal:

If Iris later introduces explicit cross-group document grants, those grants
should be represented as first-class evidence rather than inferred from a
group-visible source with missing group IDs.

### 12.16 Document Source Policy Partial Update

Pressure:

Admin Console may update multiple usage capabilities for one document source in
one request, such as disabling both answer retrieval and knowledge draft usage.
If Core App implements this as two separate storage writes, a transient database
or adapter failure between writes can leave the source half-updated. Operators
then see a policy state that does not match their intent, and later retrieval or
knowledge-governance gates may behave inconsistently.

Required architectural response:

- Treat one source policy request as one control-plane operation.
- Use a registry-level `updatePolicy` boundary for multi-field capability
  changes.
- Postgres-backed policy updates must write all requested capability fields in
  one statement or transaction boundary.
- Denied-source capability locks must be preserved inside the same authoritative
  update.
- Policy storage must preserve explicit admin overrides separately from source
  type defaults, so later rediscovery or source-type upgrades cannot silently
  undo an operator's disable decision.

Evolution signal:

If source policy grows to include roles, group grants, publication scopes, or
time-limited access, Iris should introduce a dedicated policy aggregate with
versioned writes and optimistic concurrency. That aggregate must keep the same
rule: one operator intent becomes one authoritative policy transition.

### 12.17 Mention Reply Duplicate Delivery Guard

Pressure:

Feishu can retry a message event after callback or worker failures. Iris also
releases raw-event idempotency keys at dequeue time so lost in-flight work can be
recovered. A deterministic Feishu reply `uuid` protects the visible reply in the
platform, but it does not prevent Iris from generating the same answer twice or
calling the Feishu reply API twice during a local retry or concurrent duplicate
delivery window.

Required architectural response:

- Mention reply responders must deduplicate by source `messageId`, not only by
  raw-event idempotency key.
- The local deduper must claim a message while reply generation is in flight and
  skip concurrent duplicates.
- Successful replies and runtime-disabled suppressions must be remembered in a
  bounded recent-message set so later platform retries do not regenerate the same
  answer or answer an old message after replies are re-enabled.
- Failed answer generation or reply dispatch must release the local claim so a
  valid retry can proceed.
- The deterministic Feishu `uuid` remains required as the platform-side visible
  reply idempotency guard.

Evolution signal:

If Iris runs multiple Core App replicas, this responder-local guard should move
to a shared short-lived idempotency store such as Redis. The behavior must stay
the same: duplicates should not consume model budget or call reply APIs again,
while failed attempts remain retryable.

### 12.18 Prompt XML Escaping Expansion

Pressure:

Prompt assembly stores live chat and retrieved documents as XML-like tagged
context. Even when raw text is capped, XML escaping can expand repeated
characters such as `&`, `<`, `>`, or quotes. A group message that contains logs,
code, stack traces, or malformed pasted content can therefore exceed its intended
prompt budget after formatting and cause the model request to fail.

Required architectural response:

- Prompt item budgets must apply to the escaped XML text that is injected into
  model context, not only to raw source text before formatting.
- Background document text and live-chat message text must keep their existing
  per-item budgets after XML escaping.
- Truncation markers must remain inside the escaped-output budget so the model
  can see that evidence was shortened without losing the budget guarantee.
- Stored conversation messages and document fragments must remain unchanged;
  this is a prompt assembly boundary, not a persistence mutation.

Evolution signal:

If Iris later moves from character budgets to token budgets, the token-budgeting
layer must still operate on the final escaped/rendered context representation
that is sent to the model. Intermediate raw text budgets can help, but cannot be
the final guard.

### 12.19 Mention Reply And Document Discovery Isolation

Pressure:

A single Feishu message can mention Iris, create a conversation fact, and contain
document links. If message fact persistence, document discovery,
document-source registration, or document-sync planning fails before the mention
responder runs, Iris can appear silent to the user even though the explicit
@Iris request could still be answered. This is especially painful during a first
20-30 person rollout because a transient database or sync queue issue would look
like a broken chat assistant.

Required architectural response:

- After message parsing and runtime gating, explicit mention response attempts
  must not be blocked by message fact persistence, document discovery, or
  document sync planning failures.
- Message fact persistence must still run after the reply attempt and must still
  surface failures so the raw-event worker can retry memory recovery.
- Document discovery must still run for the same event when possible.
- If document discovery fails, the processor should surface that failure after
  the reply attempt so the raw-event worker can retry memory recovery.
- Runtime gates remain authoritative: disabled incoming events still skip
  everything, and disabled group-context reading still avoids fact persistence
  and document discovery while allowing the current explicit mention request.

Evolution signal:

If document discovery gains its own durable event queue, mention responses and
document memory recovery can become fully independent downstream tasks. The v1
behavior should remain: user-visible explicit replies are prioritized, while
document memory failures stay observable and retryable.

### 12.20 Blank Model Answer User Feedback

Pressure:

The answer draft orchestrator correctly rejects blank model output so internal
APIs and tests do not treat an empty answer as success. In a group chat, however,
an explicit @Iris request that produces a blank model answer can otherwise become
a silent retry loop: the worker retries, the user sees no response, and repeated
events may consume model budget without improving the conversation.

Required architectural response:

- The orchestrator must continue to reject blank model answer drafts.
- The Feishu mention responder may catch that specific blank-answer error and
  send a concise fallback reply to the user.
- Other model, retrieval, permission, or Feishu reply errors must remain
  retryable and observable.
- A successful fallback reply must mark the source `messageId` as handled so
  Feishu retries do not repeatedly post fallback messages.

Evolution signal:

If Iris later has richer answer-quality classifiers, this fallback can become a
typed responder policy instead of matching the orchestrator's blank-answer error
message. The user-visible contract should remain: explicit mentions should get
clear feedback when Iris cannot produce a usable answer.

### 12.21 Unreadable Mention Message Feedback

Pressure:

Feishu message events may contain an explicit @Iris mention while the message
body is unavailable to Iris, for example because the content payload is
oversized, malformed, or a non-text message type. Treating that situation as an
ordinary blank question makes the user think they failed to ask clearly, when
the actual issue is that Iris did not receive readable text.

Required architectural response:

- Mention detection must still run from Feishu mention metadata.
- If Iris is mentioned but the parsed message text is unavailable, the responder
  must send a concise unreadable-message clarification instead of invoking the
  answer draft orchestrator.
- A successful unreadable-message clarification must mark the source `messageId`
  as handled, using the same deterministic Feishu reply UUID as normal replies.
- Feishu reply dispatch failures must remain retryable and observable.

Evolution signal:

When Iris supports image/file/audio understanding, unreadable mention handling
can become a typed capability policy per message type. The v1 contract should
remain: explicit mentions get honest feedback about what Iris could and could
not read.

### 12.22 Worker Error Normalization Must Not Throw

Pressure:

Raw event ingestion, document sync, and document reindex workers all rely on a
shared failure path to update retry state, write dead letters, and expose batch
errors. JavaScript dependencies can throw arbitrary values. If Iris attempts to
stringify a non-standard thrown value and that stringify operation itself
throws, the failure handler becomes the new failure and the original event may
lose its observable retry/dead-letter trail.

Required architectural response:

- Worker error-message normalization must be best-effort and non-throwing.
- Standard `Error` values should keep using their trimmed `.message`.
- Non-standard thrown values may be stringified when safe, but values that
  cannot be stringified must degrade to `unknown error`.
- Blank and oversized worker error messages must keep the existing fallback and
  truncation policy.

Evolution signal:

If Iris later adopts typed error envelopes across queues and integrations, this
normalizer can become a compatibility boundary for legacy thrown values. The v1
contract should remain: failure handling must not fail while formatting the
failure.

### 12.23 Document Source Retries Must Not Refresh UpdatedAt

Pressure:

Feishu retries can deliver the same message event and the same discovered
document link more than once. Iris already deduplicates source evidence by
semantic evidence keys, including `messageId`, but a duplicate retry that still
refreshes `updatedAt` makes an old source look newly changed. That can distort
operator views, latest-source ordering, and manual rollout judgment.

Required architectural response:

- Document-source registration must preserve `updatedAt` for duplicate evidence
  retries when no effective source metadata, source type, sync state, or policy
  value changes.
- Registration must still refresh `updatedAt` when new evidence is added, a
  source type is upgraded, missing metadata is filled, failed sync is reset to
  pending, or effective knowledge-draft policy changes.
- The in-memory v1 registry and Postgres registry must follow the same
  idempotency contract.

Evolution signal:

When source provenance becomes event-sourced, this rule should move into the
projection layer: replaying the same event should produce the same projected
source state and timestamp. The v1 contract remains that Feishu retry noise
must not masquerade as fresh document activity.

### 12.24 Document Sync Failure Formatting Must Not Lose Failed Snapshots

Pressure:

Document sync fetch failures should become failed snapshots and observable
source state. JavaScript dependencies can throw arbitrary values. If Iris fails
while formatting that thrown value, the failed snapshot is not recorded and the
source may miss the intended recoverable `failed` transition.

Required architectural response:

- Fetch-failure error-message normalization in the document sync runner must be
  best-effort and non-throwing.
- Standard `Error` values should keep using their message.
- Non-standard thrown values may be stringified when safe, but values that
  cannot be stringified must degrade to `unknown error`.
- Blank and oversized messages must continue through the existing document
  snapshot error-message normalizer.

Evolution signal:

If Iris later adopts typed integration errors, this compatibility behavior
should remain at the boundary where unknown dependency failures enter the
document sync state machine. The v1 contract remains that a fetch failure should
be visible as a failed snapshot whenever snapshot persistence itself is healthy.

### 12.25 Permission Guard Error Audits Need Safe Messages

Pressure:

Answer-time permission checks are fail-closed: if the live guard cannot verify a
document, Iris excludes the fragment. Operators still need to know whether the
exclusion was an ordinary denial or an infrastructure/error path. If a
permission checker throws a non-`Error` value and Iris omits the message, the
audit log loses useful diagnostics.

Required architectural response:

- Permission guard audit logging must record a safe message for any thrown
  permission-check failure.
- Standard `Error` values should keep using their message.
- Non-standard thrown values may be stringified when safe, but values that
  cannot be stringified must degrade to `unknown error`.
- Ordinary `permission_guard_denied` events should remain message-free unless a
  real error occurred.
- Audit logging remains best-effort; audit storage failures must not affect
  fail-closed permission filtering.

Evolution signal:

If Iris later wraps every integration failure in typed errors, this safe-message
reader can become a legacy compatibility boundary. The v1 contract remains that
permission guard errors are both safe and diagnosable.

### 12.26 Internal Status Error Formatting Must Not Hide Degradation

Pressure:

Internal status is the operator's first place to see gateway enqueue failures
and runtime degradation. If status error formatting itself throws because a
dependency produced a non-standard thrown value, the status surface can lose the
very degradation signal it is supposed to expose.

Required architectural response:

- Internal status error-message normalization must be best-effort and
  non-throwing.
- Standard `Error` values should keep using their message.
- Non-standard thrown values may be stringified when safe, but values that
  cannot be stringified must degrade to `unknown error`.
- Existing blank and oversized status-message normalization must remain.

Evolution signal:

As Iris gains richer health probes, each probe may return typed status errors.
This normalizer remains the compatibility boundary for unexpected failures. The
v1 contract remains: status reporting should not fail while formatting a status
failure.

### 12.27 Redis Processing Recovery Is Single-Consumer Only

Pressure:

Redis-backed raw event, document sync, and reindex queues use a pending list, a
processing list, and a startup recovery step that moves abandoned processing
payloads back to pending before polling. This prevents silent loss after a
single worker crashes. It does not provide in-flight ownership. If two worker
replicas consume the same queue at the same time, one replica can recover
another replica's active processing payload and duplicate work before the first
replica acknowledges it.

Required architectural response:

- Iris v1 internal rollout must run at most one active consumer loop for each
  Redis queue family: raw events, document sync, and document reindex.
- Deployment and operations docs must treat horizontal worker replicas as
  unsupported until the queue adapter has leases or per-consumer processing
  ownership.
- Worker processing must remain idempotent because at-least-once delivery still
  applies after crashes, Redis partial failures, and operator DLQ replay.
- Consolidated status and DLQ surfaces remain the recovery mechanism for the
  single-consumer rollout shape.

Evolution signal:

Before Iris scales worker replicas horizontally, replace the shared processing
list recovery model with a leased queue adapter. The adapter must make
ownership explicit, recover only expired leases, and preserve current
idempotency, retry, and dead-letter guarantees.

### 12.28 Redis Processed ACK Must Be Atomic

Pressure:

After a worker successfully processes a Redis-backed raw event, document sync
job, or reindex job, Iris must remove the processing payload and release the
corresponding idempotency key. If those two Redis mutations are issued as
separate commands, a transient failure after processing-list removal but before
seen-key release can strand the idempotency key without any queued or
processing payload. Future work with the same key may then be blocked even
though there is nothing left to process or recover.

Required architectural response:

- Successful Redis ACK for raw events, document sync jobs, and reindex jobs must
  remove the processing payload and release the seen key in one Redis eval/Lua
  operation.
- ACK must release the seen key only after the exact processing payload is
  removed, so a missing or already-recovered processing item cannot unlock a
  queued duplicate.
- Dequeue must continue to keep seen keys claimed until successful ACK.
- Failed processing paths still own retry/DLQ state transitions and must not
  rely on successful ACK cleanup.
- The single-consumer v1 recovery contract remains unchanged.

Evolution signal:

When Iris moves to a leased queue adapter, processed ACK must remain a single
adapter-level commit that clears in-flight ownership and idempotency state
together.

### 12.29 Redis Retry ACK Must Be Atomic

Pressure:

When a worker fails a Redis-backed raw event, document sync job, or reindex
job below the max-attempt threshold, Iris must requeue the retry payload and
remove the original processing payload. If retry upsert and processing cleanup
are split across separate commands, a transient failure after requeue can leave
the same logical work in both pending and processing. The next recovery pass can
then duplicate retry work or overwrite fresher retry metadata.

Required architectural response:

- Retriable Redis failure handling for raw events, document sync jobs, and
  reindex jobs must upsert the retry payload and remove the exact processing
  payload in one Redis eval/Lua operation.
- Retry upsert must keep existing duplicate-upgrade semantics: update an
  already queued duplicate when present, otherwise push the retry payload.
- DLQ replay keeps using retry/upsert semantics but remains separate from
  processing ACK because DLQ items are not processing-list claims.
- Dead-letter transitions use their own atomic ACK path because they also own
  processing-list cleanup and idempotency-key release.
- The v1 single-consumer recovery contract remains unchanged.

Evolution signal:

When Iris moves to a leased queue adapter, retry ACK must become one
adapter-level commit that records the retry attempt and clears in-flight
ownership together.

### 12.30 Redis Dead-Letter ACK Must Be Atomic

Pressure:

When a Redis-backed raw event, document sync job, or reindex job reaches max
attempts, Iris must move the failed payload into the DLQ, remove the original
processing payload, and release the idempotency key. If those mutations are
split across separate commands, a transient failure can leave a DLQ entry while
the original processing payload remains recoverable, or it can strand a seen key
after the work has already been dead-lettered.

Required architectural response:

- Max-attempt Redis failure handling for raw events, document sync jobs, and
  reindex jobs must write the DLQ payload, remove the exact processing payload,
  and release the seen key in one Redis eval/Lua operation.
- The DLQ payload must be written only after the exact processing payload is
  removed, so a client retry after a successful but unacknowledged eval cannot
  duplicate dead-letter entries.
- Error messages stored in DLQ entries must remain bounded and diagnostic.
- DLQ replay and DLQ deletion remain separate operator-controlled operations;
  this ACK only covers worker-owned processing-to-DLQ transitions.
- The v1 single-consumer recovery contract remains unchanged.

Evolution signal:

When Iris moves to a leased queue adapter, dead-letter ACK must become one
adapter-level commit that records the terminal failure, clears in-flight
ownership, and releases idempotency state together.

### 12.31 Redis Invalid Payload DLQ ACK Must Be Atomic

Pressure:

When Redis dequeue moves a payload into the processing list and Iris then fails
to parse or validate that payload, the worker must preserve a diagnostic DLQ
entry and remove the bad processing payload. If the DLQ write, processing-list
cleanup, and optional seen-key release are split across separate commands, a
transient Redis failure can leave the corrupt payload recoverable while also
creating a DLQ diagnostic, or it can keep a safe idempotency key blocked after
the bad payload is no longer actionable.

Required architectural response:

- Invalid queued payload handling for raw events, document sync jobs, and
  reindex jobs must write the diagnostic DLQ payload, remove the exact
  processing payload, and release the seen key when a safe key can be derived in
  one Redis eval/Lua operation.
- The script must skip seen-key release when the payload cannot prove a safe
  idempotency key, so corrupted or mismatched payloads cannot unlock unrelated
  work.
- Diagnostic DLQ payloads must keep bounded, operator-readable error messages
  and stable generated ids.
- The DLQ payload must be written only after the exact processing payload is
  removed, so client retries cannot duplicate invalid-payload diagnostics.
- The v1 single-consumer recovery contract remains unchanged.

Evolution signal:

When Iris moves to a leased queue adapter, invalid-payload DLQ ACK must remain
one adapter-level commit that records the diagnostic failure, clears in-flight
ownership, and conditionally releases idempotency state.

### 12.32 Redis DLQ Replay Must Be Atomic

Pressure:

Operator DLQ replay moves work out of a dead-letter list and back into the
pending queue. If replay first enqueues/upserts the work and then removes the
DLQ entry with a separate command, a transient Redis failure can leave the same
logical work visible both as queued work and as a still-replayable DLQ entry.
Operators may then replay it again after the original retry already succeeded.

Required architectural response:

- Redis DLQ replay for raw events, document sync jobs, and reindex jobs must
  remove the exact DLQ payload and enqueue/upsert the reset retry payload in one
  Redis eval/Lua operation.
- Replay must preserve stale-seen-key recovery semantics: if the seen key
  already exists but no queued duplicate is found, replay still pushes the reset
  payload so operator recovery cannot silently drop work.
- Replay must update an existing queued duplicate with the reset payload when
  one exists, preserving the existing retry/upsert contract.
- If the exact DLQ payload is already missing, replay must not enqueue and must
  surface a not-found result.
- The v1 single-consumer recovery contract remains unchanged.

Evolution signal:

When Iris moves to a leased queue adapter, DLQ replay must remain one
adapter-level operator action that transfers ownership from DLQ storage back to
pending work without exposing both states at once.

### 12.33 Reindex Jobs Must Match The Active Embedding Profile

Pressure:

Iris v1 runs one active embedding profile at a time. Normal reindex planning
validates that manual and document-synced reindex jobs use the active profile,
but Redis queues and DLQs can still contain stale jobs from an older embedding
model or dimension. If a stale job is processed by a worker whose indexer writes
the current active profile, Iris can report work under the stale profile while
mutating fragments for the active profile, making operator status and retrieval
state disagree.

Required architectural response:

- The reindex worker runtime must pass the current `activeEmbeddingProfileId`
  into the worker.
- The worker must check a job's `embeddingProfileId` before reading snapshots,
  checking fragments, embedding text, or replacing fragments.
- Jobs whose profile is not active must be acknowledged as processed with a
  `profile_not_active` skip result, not retried or dead-lettered, because the
  payload is obsolete rather than transiently failed.
- Manual reindex APIs must continue to reject non-active profiles at ingress.
- Reindex queue and DLQ replay remain at-least-once mechanisms; profile
  isolation is the last safety gate before side effects.

Evolution signal:

If Iris later supports multiple active embedding profiles at the same time,
reindex workers must become profile-scoped or queue namespaces must carry
profile ownership explicitly. Until then, one worker may only mutate fragments
for its configured active profile.

### 12.34 Fact-Layer Evidence Fields Must Preserve Upstream Queue Budgets

Pressure:

Raw Feishu event idempotency keys are bounded by the event layer, not by each
downstream fact table. A valid queue payload can contain
`raw-event:feishu:` plus the maximum supported Feishu event identifier. If a
conversation, document, audit, or action repository uses a smaller local string
budget for that evidence field, Iris can accept work into the raw queue and then
retry or dead-letter it forever when writing facts.

Required architectural response:

- Fact-layer fields that store upstream evidence identifiers must inherit the
  upstream contract for that identifier.
- Conversation message storage must accept the full raw-event idempotency-key
  budget defined by the raw event queue.
- Narrower limits may still apply to independent domain identifiers such as
  provider message IDs, chat IDs, user IDs, and message types.
- Validation errors should occur at the original boundary where an identifier
  first becomes invalid, not after Iris has already accepted the event into a
  durable queue.
- Tests for downstream repositories must include the maximum valid upstream
  evidence key and the first invalid key above that budget.

Evolution signal:

If Iris introduces schema-versioned event envelopes, the envelope schema becomes
the single source of truth for evidence-key budgets. Downstream repositories
should import or derive those budgets instead of copying numeric limits.

Constitutional principle:

> Every architecture pressure test must identify the failure mode, the required v1 guardrail, and the future split point. Iris should evolve by hardening proven weak points, not by adding complexity before pressure appears.
