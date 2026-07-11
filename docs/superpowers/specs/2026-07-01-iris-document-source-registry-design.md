# Iris Document Source Registry Design

Date: 2026-07-01
Status: Phase 2B approved design
Product name: Iris

## 1. Purpose

Document Source Registry is Iris's unified registry for all document-like material Iris may later read, parse, index, retrieve, or cite.

Phase 2A already normalizes Feishu message events and extracts Feishu document links from group chat text. Phase 2B turns those discovered links and future knowledge-base/user-submitted materials into one consistent domain model before any real document body fetching is added.

The registry is not a document parser, crawler, vector index, or permission authority. It is the fact-layer entry point that records what Iris has seen or been given, where it came from, whether Iris is allowed to use it, and what processing state it is in.

## 2. Design Goals

The registry must support three document source types:

- Group-visible document: a document link appeared in a Feishu group where Iris is present.
- Authorized wiki document: an administrator authorized a Feishu wiki or knowledge-base document or space.
- User-submitted document: a user manually gave Iris a file, link, or document reference.

The registry must make later document fetching safer by preserving:

- source URI;
- source type;
- origin group and message when applicable;
- submitting user when applicable;
- authorized wiki or space when applicable;
- permission state;
- sync state;
- capability flags;
- timestamps;
- source evidence.

Constitutional alignment:

> Iris reads both chat text and readable document bodies, but every document entering memory must preserve source, permission, version, and visibility scope.

## 3. Out Of Scope

This phase does not implement:

- real Feishu document body fetching;
- real Feishu wiki traversal;
- OAuth installation or token refresh;
- Postgres persistence;
- pgvector indexing;
- document parsing, chunking, or embeddings;
- real-time Feishu permission API calls;
- admin UI screens.

Those features should attach to the registry later instead of replacing it.

## 4. Core Domain Model

### 4.1 DocumentSource

`DocumentSource` is the canonical record for a registered material source.

Fields:

- `id`: stable Iris-side identifier.
- `sourceType`: `group_visible_document | authorized_wiki_document | user_submitted_document`.
- `sourceUri`: canonical URI or stable external reference.
- `title`: optional display title when known.
- `originGroupId`: group where the document appeared.
- `originMessageId`: message where the document appeared.
- `submittedByUserId`: user who manually submitted the source.
- `authorizedSpaceId`: Feishu wiki or knowledge-base space identifier.
- `permissionState`: `unknown | readable | denied | stale`.
- `syncState`: `pending | syncing | synced | failed`.
- `canUseForAnswering`: whether retrieval may consider this source after live permission guard passes.
- `canUseForKnowledgeDrafts`: whether this source may support knowledge draft generation.
- `createdAt`: first registration time.
- `updatedAt`: last mutation time.

### 4.2 Source Evidence

The registry should preserve enough evidence to explain why Iris knows about a source.

For v1 in-memory implementation, each source should keep a compact `evidence` list:

- `kind`: `group_message | admin_authorization | user_submission`.
- `groupId`: optional group identifier.
- `messageId`: optional message identifier.
- `userId`: optional user identifier.
- `spaceId`: optional authorized space identifier.
- `observedAt`: timestamp.

Evidence lets Iris merge repeated sightings without losing provenance.

Evidence must be idempotent. Feishu may retry delivery for the same message event during network jitter, so registering the same document link from the same `messageId` must not append duplicate evidence. For v1, evidence deduplication should treat entries with the same `kind`, `sourceUri`, `messageId`, `groupId`, `userId`, and `spaceId` as the same observation.

## 5. Registration Behavior

### 5.1 Group-Visible Document

When a Feishu group message contains a document link, Iris registers it as `group_visible_document`.

Required input:

- `sourceUri`;
- `originGroupId`;
- `originMessageId`;
- `observedAt`.

Defaults:

- `permissionState`: `unknown`;
- `syncState`: `pending`;
- `canUseForAnswering`: `true`;
- `canUseForKnowledgeDrafts`: `true`.

The registry does not decide whether the document is actually readable. It records the candidate and leaves live authorization to later permission guard and sync modules.

### 5.2 Authorized Wiki Document

When an administrator authorizes a Feishu wiki or knowledge-base document/space, Iris registers it as `authorized_wiki_document`.

Required input:

- `sourceUri`;
- `authorizedSpaceId`;
- `observedAt`.

Defaults:

- `permissionState`: `unknown`;
- `syncState`: `pending`;
- `canUseForAnswering`: `true`;
- `canUseForKnowledgeDrafts`: `true`.

### 5.3 User-Submitted Document

When a user manually gives Iris a file, link, or document reference, Iris registers it as `user_submitted_document`.

Required input:

- `sourceUri`;
- `submittedByUserId`;
- `observedAt`.

Defaults:

- `permissionState`: `unknown`;
- `syncState`: `pending`;
- `canUseForAnswering`: `true`;
- `canUseForKnowledgeDrafts`: `false`.

Manual submissions should not automatically become formal knowledge draft evidence unless later policy allows it.

## 6. Deduplication And Merging

The registry deduplicates by canonical `sourceUri`.

If the same URI appears again:

- keep the original `id` and `createdAt`;
- update `updatedAt`;
- append new evidence if it is not an exact duplicate;
- merge missing metadata such as title;
- preserve the most explicit source type only when a source is re-registered through a stronger administrative path.

Source type precedence:

1. `authorized_wiki_document`
2. `group_visible_document`
3. `user_submitted_document`

This means an admin-authorized wiki source can upgrade a prior group-visible or user-submitted source, but a casual group mention should not downgrade an admin-authorized source.

Feishu retry handling:

- repeated registration of the same source from the same Feishu message must be idempotent;
- `evidence.messageId` is the primary retry signal for group-visible document observations;
- repeated events may update `updatedAt`, but must not create duplicate evidence records.

## 7. State Mutations

The registry supports explicit state changes:

- mark permission as `readable`, `denied`, `stale`, or `unknown`;
- mark sync as `pending`, `syncing`, `synced`, or `failed`;
- enable or disable `canUseForAnswering`;
- enable or disable `canUseForKnowledgeDrafts`.

Rules:

- If `permissionState` becomes `denied`, `canUseForAnswering` must become `false`.
- If `permissionState` becomes `stale`, `canUseForAnswering` may remain true only if a later real-time permission guard is required before context injection. For v1, keep it true but make the state visible.
- If a source is disabled for answering by an admin, later registration should not silently re-enable it.
- If a source is disabled for knowledge draft usage by an admin, later source-type upgrades should not silently re-enable it. The registry must distinguish default user-submitted document policy from an explicit admin override.

Phase 2B known limitation:

The v1 registry is intentionally in-memory. Admin mutations such as disabling a source for answering, disabling knowledge-draft usage, or manually changing permission/sync state will be lost if the Core App process restarts. This is acceptable for Phase 2B because the goal is to validate domain behavior and tests before persistence. Phase 2C must move registry state to Postgres so administrator changes survive restarts and become auditable.

## 8. Query Behavior

The registry exposes focused read methods:

- list all sources;
- list sources by type;
- find a source by id;
- find a source by URI;
- list sources usable for answering;
- list sources by group id;
- list sources by authorized space id;
- list sources by submitting user id.

For v1, in-memory ordering should be deterministic:

1. newest `updatedAt` first;
2. then stable `id` ascending.

## 9. Error Handling

Registration rejects invalid input:

- blank source URI;
- unsupported or malformed Feishu docx/docs/wiki source URIs before they enter the registry;
- missing required group/message/user/space fields for the selected registration path;
- invalid state values.

Errors should be typed enough for tests and future API routes to distinguish validation failures from unexpected failures.

No external network calls happen inside the registry. Therefore registry operations should be deterministic and fast.

## 10. Testing Strategy

Unit tests should cover:

- registering each source type with correct defaults;
- deduplicating repeated URIs;
- appending evidence on repeated sightings;
- source type upgrade when admin authorization appears;
- no downgrade from admin authorization to group/user source;
- permission denied disables answering;
- admin-disabled answering is not silently re-enabled by re-registration;
- admin-disabled knowledge draft usage is not silently re-enabled by source-type upgrades;
- duplicate Feishu message retries do not append duplicate evidence;
- querying by type, group, space, user, id, and URI;
- deterministic ordering;
- validation errors for missing required fields.

## 11. Future Integration Points

Later phases should attach to this registry:

- Feishu document fetcher reads pending document sources and fetches bodies.
- Feishu knowledge-base sync registers authorized wiki documents and spaces.
- Permission Guard updates permission state and enforces live checks before LLM context injection.
- Document parser and embedding workers update sync state after successful processing.
- Admin Console displays and edits data source capability flags.
- Knowledge Governance cites registry evidence when generating knowledge drafts.

Constitutional principle:

> Document Source Registry records what Iris may consider. It does not decide what Iris is currently allowed to inject into an answer. Final permission remains with live permission guard and action governance.
