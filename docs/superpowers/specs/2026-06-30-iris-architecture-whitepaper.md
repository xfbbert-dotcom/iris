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

Current implementation: answer-time `source-policy` retrieval first checks the local source registry and runtime capabilities, then requires a Feishu live permission probe for Feishu docx/docs/wiki URLs before allowing candidate fragments into prompt context. If Feishu OpenAPI credentials are missing, Feishu document fragments fail closed and are excluded from prompt context. Direct docx/docs URLs are checked through document metadata lookup; wiki URLs are resolved through wiki node lookup and then checked as documents. Unsupported non-Feishu URLs continue to rely on local source policy until a matching live checker exists. Explicit denied/not-found responses are excluded as denials; transient Feishu failures and timeouts are excluded as permission guard errors so operators can diagnose them separately.

Feishu document source URIs must pass the same token parser whether they arrive from group chat discovery, authorized wiki registration, or user-submitted registration. Query strings, fragments, and trailing path slashes may be stripped during canonicalization, but chat punctuation, adjacent prose, or percent-encoded token contamination must not be accepted as part of a document token. If a submitted Feishu docx/docs/wiki URI contains an ASCII comma or any percent-encoded sequence inside the token segment, Iris rejects it before registration, permission checks, sync, or retrieval.

Supported Feishu document source paths must map to exactly one document token. Iris accepts only `/docx/:token`, `/docs/:token`, or `/wiki/:token` after host validation; extra path segments and percent-encoded path separators inside the token segment are rejected before registration and sync. Ambiguous URLs should be corrected by the user or re-shared from Feishu rather than partially parsed.

Feishu document sync reads are external I/O and must always be bounded by request timeouts that cover both response headers and body consumption. If tenant-token acquisition, wiki-node lookup, raw-content fetch, or response body reading stalls, Iris must fail the document sync attempt and let the queue retry/dead-letter policy handle recovery rather than occupying a worker indefinitely.

Document sync workers must not treat a stale pre-claim source read as permission to fetch. After a worker marks a source as `syncing`, it must treat the returned source record as authoritative, re-check permission state and usage capabilities, and abandon the fetch if the source has become denied or disabled. When this happens, the worker must restore the source to `pending` so future administrator changes can re-enable sync without leaving the source stuck in an in-flight state.

Constitutional principle:

> Iris reads both chat text and readable document bodies. Every document entering memory must preserve source, permission, version, and visibility scope.
> Retrieval must re-check live permissions before document content reaches the model. Cached permission state can accelerate recall, but cannot authorize final context injection.

## 5. Data Flow And Memory

Iris's data flow has four layers: event, fact, semantic, and action.

### 5.1 Event Layer

Feishu messages, document links, files, mentions, user submissions, wiki updates, and admin changes enter through Feishu Gateway or Admin Console.

Feishu Gateway's event ingestion path must be designed for overload. In high-volume groups, the gateway must avoid heavy signal filtering and Redis persistence work before acknowledgment. Raw events should be scheduled into Redis Queue or an equivalent durable queue immediately after acknowledgement, then processed by asynchronous workers with idempotency keys, retry limits, backpressure, and dead-letter handling.

Raw event idempotency keys must be bounded. Platform event IDs can seed stable
deduplication keys, but oversized external IDs must be ignored in favor of a
canonical body hash so malformed callbacks cannot create oversized Redis keys.
The fallback hash sorts JSON object keys recursively before SHA-256 hashing so
semantically identical callbacks do not duplicate merely because object key order
changed.

Raw Feishu event DLQs are operator recovery surfaces. Iris must support bounded listing, explicit replay, and deletion for raw event dead letters. Replay must not remove the DLQ payload until the reset raw event has been accepted back into the queue.

Feishu message content parsing must be bounded before and after JSON parsing. The raw `message.content` JSON string must stay within a fixed budget before `JSON.parse`; over-budget content is treated as unreadable text while preserving message metadata. Post-message text extraction should preserve normal readable text and links, but it must cap traversal depth and collected text parts so malformed or unusually large payloads cannot monopolize an event worker.

The consolidated internal status endpoint is the operator's first health surface. Non-empty DLQs for raw events, document sync jobs, or reindex jobs must mark the corresponding component as degraded with an explicit dead-letter reason, even when the worker is still running and the latest batch succeeded.

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

Internal operator APIs must have an explicit protection boundary. During the early internal rollout,
Core may use a shared `IRIS_INTERNAL_API_TOKEN` Bearer guard for `/internal/*` routes while Feishu
callback and health endpoints remain separately governed. The guard must match the request path
before the query string so `/internal?probe=1` and `/internal/status?details=1` cannot bypass the
boundary. It must also evaluate the once percent-decoded path so encoded variants such as
`/%69nternal/status` or `/internal%2Fstatus` cannot be decoded by the router after bypassing the
guard. The `Bearer` scheme may be matched case-insensitively for HTTP client compatibility, but the
token value itself must remain an exact shared-secret match. This is a rollout control, not the final
admin identity model.

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

A single Feishu message can both mention Iris and contain document links. If
document discovery, document-source registration, or document-sync planning
fails before the mention responder runs, Iris can appear silent to the user even
though the explicit @Iris request could still be answered. This is especially
painful during a first 20-30 person rollout because a transient sync queue issue
would look like a broken chat assistant.

Required architectural response:

- After message parsing and fact persistence, explicit mention response attempts
  must not be blocked by document discovery or document sync planning failures.
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

Constitutional principle:

> Every architecture pressure test must identify the failure mode, the required v1 guardrail, and the future split point. Iris should evolve by hardening proven weak points, not by adding complexity before pressure appears.
