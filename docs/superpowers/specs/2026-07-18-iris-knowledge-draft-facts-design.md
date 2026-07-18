# Iris Knowledge Draft Facts Design

> Design date: 2026-07-18
> Constitutional basis: `2026-06-30-iris-architecture-whitepaper.md`
> Requirement baseline: IRIS-CORE-007, IRIS-CORE-008, and IRIS-CORE-013 in `2026-07-14-iris-core-requirement-coverage-baseline.md`

## 1. Goal

Implement Phase 5A of the approved roadmap: a durable, evidence-first knowledge draft fact layer with risk classification, immutable revisions, explicit lifecycle, current-source validation, and authenticated governance APIs.

Phase 5A does not call a model, post a draft to Feishu, approve content, or write to the Feishu knowledge base. It creates the governed intermediate object required before those Phase 5B actions can be implemented safely.

## 2. Selected Approach

Use a dedicated knowledge draft aggregate in TypeScript and Postgres:

- a mutable draft header contains identity, lifecycle, group scope, and current revision;
- each edit creates an immutable full revision;
- each revision owns exact evidence references;
- every lifecycle mutation emits an append-only event;
- reads recompute whether every evidence reference is still current and authorized;
- invalid evidence redacts draft title/content at the API boundary and blocks future actions.

Alternatives rejected:

1. Store a draft as a `document_source`. This confuses untrusted proposed content with readable source material and risks retrieval before review.
2. Build a generic workflow engine first. It would add a broad abstraction before Iris has one proven approval workflow.
3. Store only the latest draft body and a change log. This weakens review traceability because a reviewer cannot reconstruct the exact evidence and content they saw.

## 3. Constitutional Boundaries

- A knowledge draft is never official company knowledge.
- Phase 5A has no Feishu send, confirmation, approval, publication, or external-tool route.
- Draft content is never inserted into document fragments, embeddings, group memory, or answer retrieval.
- Draft creation requires global enablement, the `generateKnowledgeDrafts` capability, and an enabled source group when one exists.
- Governance reads, revision requests, and rejection remain available to authenticated operators while Iris is disabled.
- Every revision requires at least one current evidence reference.
- Document evidence must be `readable`, `synced`, and explicitly enabled by `canUseForKnowledgeDrafts`.
- Group-visible document evidence must include exact evidence for the draft's source group.
- Authorized wiki and explicitly enabled user-submitted sources are company-authorized; user-submitted sources remain unusable by default.
- A source change, deletion, denial, stale permission, disabled draft capability, group mismatch, or semantic version change makes the revision ineligible for content disclosure and publication.
- No model-proposed risk, reviewer, title, content, or publication location can bypass human review and the future Approval & Action Layer.

## 4. Domain Model

### 4.1 Draft Header

`knowledge_drafts` stores:

- `id`;
- optional `source_group_id`;
- `origin_kind`: `group_conclusion`, `repeated_qa`, `workflow`, `document_discussion`, `knowledge_conflict`, or `user_requested`;
- `status`: `pending_confirmation`, `pending_review`, `needs_revision`, `rejected`, or `published`;
- `current_revision_number` and compare-and-swap `version`;
- creator reference and timestamps;
- rejection actor/reason/time when terminally rejected;
- publication fields reserved for Phase 5B and nullable until a guarded publication succeeds.

The `published` state exists to preserve the whitepaper lifecycle, but Phase 5A exposes no operation that can enter it.

### 4.2 Immutable Revisions

`knowledge_draft_revisions` stores a full review snapshot:

- draft ID and monotonically increasing revision number;
- title and Markdown content;
- risk level: `low`, `medium`, or `high`;
- optional reviewer type/reference;
- optional Feishu publication suggestion (`space_id`, `parent_node_token`);
- author reference and creation time.

Revisions are append-only. A database trigger rejects update and delete. The header points to the current revision number.

### 4.3 Revision Evidence

`knowledge_draft_revision_evidence` stores one or more exact references per revision:

- `conversation_message` with message ID and source group;
- `discussion_thread` with entity ID, group, and expected integer version;
- `action_item` with entity ID, group, and expected integer version;
- `document_source` with source ID and expected `updated_at` value.

Evidence rows do not copy message text, document text, thread summaries, action descriptions, or source titles. They remain trace pointers. Rows are append-only and deduplicated within a revision.

### 4.4 Events

`knowledge_draft_events` records `created`, `revised`, `revision_requested`, and `rejected` in Phase 5A. Each event contains an operation key, from/to version, actor, bounded reason, revision number, and timestamp. Operation keys make retries idempotent.

Phase 5B will add confirmation, review, approval, publication, and publication-failure events through a new migration and state-machine extension.

## 5. Lifecycle

```text
create group-relevant draft -> pending_confirmation
create company/reviewer draft -> pending_review

pending_confirmation | pending_review
  -> needs_revision
  -> rejected

needs_revision
  -> revised -> pending_confirmation (group-scoped) or pending_review (company-scoped)
  -> rejected
```

An ordinary edit to `pending_confirmation` or `pending_review` creates a revision and keeps the same gate. Editing `needs_revision` returns the draft to its required gate. `rejected` and `published` are terminal in Phase 5A.

Every mutation requires `expectedVersion`. A stale version returns a conflict and changes nothing. Replaying the same `operationKey` returns the previously committed result.

## 6. Evidence Validation And Redaction

Creation and revision validate all evidence in the same Postgres transaction that writes the revision:

- conversation message exists, has no deletion tombstone, and matches the source group;
- thread/action exists in the source group and has the expected current version;
- document source exists, is readable and synced, has knowledge-draft use enabled, and its `updated_at` matches;
- group-visible document source has a `group_message` evidence row for the exact source group;
- a group-scoped draft cannot mix evidence from another group.
- conversation-message, thread, action, and group-visible-document evidence requires a source group; a company-scoped draft may use only company-authorized wiki or explicitly enabled user-submitted document evidence.

List and detail reads re-evaluate the same current-state conditions. The API returns:

- lifecycle/risk/creator/revision metadata and an `evidenceState` classification;
- title, content, reviewer, publication suggestion, and evidence details only when `evidenceState=current`;
- no content fields when evidence is `invalidated`.

The response includes only a bounded reason code such as `message_deleted`, `entity_version_changed`, `document_permission_unavailable`, or `group_scope_mismatch`. It never includes stale source content.

This guard protects governance reads, but Phase 5B must independently repeat real-time Feishu permission checks immediately before confirmation previews and publication.

## 7. Internal Governance API

All endpoints require the existing internal bearer token:

- `POST /internal/knowledge-drafts`;
- `GET /internal/knowledge-drafts?groupId=&status=&riskLevel=&limit=`;
- `GET /internal/knowledge-drafts/:id`;
- `POST /internal/knowledge-drafts/:id/revisions`;
- `POST /internal/knowledge-drafts/:id/request-revision`;
- `POST /internal/knowledge-drafts/:id/reject`;
- `GET /internal/knowledge-drafts/status`.

Create is additionally gated by the runtime controller. Governance mutations are authenticated, version checked, and audited but do not require Iris to be globally enabled.

There is deliberately no `confirm`, `approve`, `publish`, `send`, or `write` endpoint in Phase 5A.

## 8. Limits

- title: 256 characters;
- content: 100,000 characters;
- actor/reviewer/reference IDs: 512 characters;
- reason: 2,000 characters;
- evidence count per revision: 1-100;
- list limit: 1-100;
- publication location fields: 512 characters each.

All strings are trimmed and validated before persistence. Evidence arrays reject duplicates and mixed group scope. API bodies remain under the existing bounded JSON request limit.

## 9. Failure Semantics

- invalid input: 400 with a stable generic error;
- runtime create gate closed: 409 with `knowledge_draft_generation_disabled`;
- missing draft or wrong group scope: 404;
- stale version or operation conflict: 409;
- stale/unauthorized evidence at write time: 409 with a bounded evidence classification;
- database or unexpected failure: 500 with no source content or SQL details;
- unavailable runtime/auth configuration: 503 fail closed.

Failed transactions create no partial header, revision, evidence, or event rows.

## 10. Testing And Exit Condition

Phase 5A code is complete when:

- pure state-machine tests cover every allowed/forbidden transition and idempotent replay contract;
- repository tests with real Postgres cover creation, immutable revisions, CAS conflicts, operation replay, group isolation, every evidence type, stale evidence redaction, and transaction rollback;
- API tests cover authentication, runtime creation gates, bounded validation, redaction, conflicts, and absence of Phase 5B routes;
- migration, typecheck, build, full Core/Python/Pilot tests, Compose rendering, and readiness pass;
- an acceptance runbook proves drafts never enter answer retrieval and no Feishu message or knowledge-base write occurs.

Real model-generated content quality and real group confirmation wait for Phase 5B. This dependency does not block the fact layer from being implemented and reviewed now.

## 11. Explicitly Out Of Scope

- automatic/model knowledge-draft generation;
- group preview and confirmation;
- owner/admin approval;
- Feishu knowledge-base creation or update;
- conflict detection and update proposals;
- Admin Console UI;
- cross-company or multi-tenant governance;
- using draft content in answers before publication.
