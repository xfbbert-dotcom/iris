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

Feishu Gateway must acknowledge Feishu event callbacks immediately. The gateway should validate only the minimum required request authenticity, enqueue the raw event, perform idempotency recording, and return HTTP 200 within the platform timeout budget. Signal filtering, denoising, classification, memory extraction, and agent decisions must happen asynchronously after the gateway response.

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

Iris must not use a document link to bypass Feishu permissions. If a document is deleted or its permissions change, Iris's index must be invalidated, refreshed, or downgraded.

Local permission state is never enough for sensitive retrieval. Before document fragments retrieved from pgvector are passed into the LLM, TypeScript Core App must run a real-time permission guard against Feishu for the candidate document IDs whenever the answer depends on document content. This guard exists because indirect permission changes, such as parent-folder permission changes or group membership changes, may lag behind or bypass clean webhook notifications.

Feishu document sync reads are external I/O and must always be bounded by request timeouts. If tenant-token acquisition, wiki-node lookup, or raw-content fetch stalls, Iris must fail the document sync attempt and let the queue retry/dead-letter policy handle recovery rather than occupying a worker indefinitely.

Constitutional principle:

> Iris reads both chat text and readable document bodies. Every document entering memory must preserve source, permission, version, and visibility scope.
> Retrieval must re-check live permissions before document content reaches the model. Cached permission state can accelerate recall, but cannot authorize final context injection.

## 5. Data Flow And Memory

Iris's data flow has four layers: event, fact, semantic, and action.

### 5.1 Event Layer

Feishu messages, document links, files, mentions, user submissions, wiki updates, and admin changes enter through Feishu Gateway or Admin Console.

Feishu Gateway's event ingestion path must be designed for overload. In high-volume groups, the gateway must avoid heavy signal filtering before acknowledgment. Raw events should be placed into Redis Queue or an equivalent durable queue first, then processed by asynchronous workers with idempotency keys, retry limits, backpressure, and dead-letter handling.

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

When Iris is disabled, it should stop processing new messages, stop proactive speech, and stop executing tasks. Admins may still view logs and configuration.

Feishu may still deliver events to the system while Iris is disabled. In that state, Iris should acknowledge or safely discard events according to Feishu platform requirements, but must not index message content, update semantic memory, generate replies, or execute actions unless an administrator explicitly re-enables the relevant scope.

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

Evolution signal:

If real-time permission checks become a latency bottleneck, Iris may introduce a dedicated Permission Guard Service with short-lived permission tokens, request coalescing, and per-document permission freshness policies. This service must remain on the critical path before model context injection.

### 12.2 Feishu Callback Timeout And Message Overload

Pressure:

Feishu event callbacks have strict response-time expectations. If high-volume group traffic triggers heavy signal filtering inside Feishu Gateway, callback responses can time out and cause Feishu to retry, creating duplicate events and additional load.

Required architectural response:

- Feishu Gateway must be "ack-first": validate minimally, enqueue raw events, record idempotency keys, and return HTTP 200 quickly.
- Signal filtering, denoising, categorization, memory extraction, and agent decisions must happen after acknowledgment.
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

Feishu document APIs or the network may stall during tenant-token acquisition, wiki-node lookup, or raw-content fetch. Without a bounded request timeout, a document sync worker can remain occupied by one external call and reduce the system's ability to process newer work.

Required architectural response:

- Every Feishu document sync token request and document body request must carry an abortable timeout.
- Timeout failures must become explicit document sync failures, not hanging promises.
- Queue retry and dead-letter policy must handle repeated fetch stalls.
- Operators must be able to tune the timeout for their deployment without changing code.

Evolution signal:

If document fetch stalls or Feishu rate limits become frequent, Iris may introduce a dedicated Document Fetch Service with request coalescing, adaptive backoff, per-source freshness policies, and provider-specific rate-limit handling. The service must still preserve source visibility and permission boundaries.

Constitutional principle:

> Every architecture pressure test must identify the failure mode, the required v1 guardrail, and the future split point. Iris should evolve by hardening proven weak points, not by adding complexity before pressure appears.
