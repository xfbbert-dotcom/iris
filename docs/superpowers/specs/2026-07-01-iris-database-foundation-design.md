# Iris Database Foundation Design

Date: 2026-07-01
Status: Phase 2C approved design
Product name: Iris

## 1. Purpose

Phase 2C establishes Iris's Postgres fact-layer foundation and connects the Document Source Registry to durable storage.

Phase 2B intentionally implemented the registry in memory to validate source registration, merging, evidence idempotency, state mutation, and query semantics. That version is useful for fast tests, but it cannot preserve administrator changes across process restarts. Phase 2C fixes that limitation by introducing database infrastructure, SQL migrations, and a Postgres-backed registry implementation.

This phase is broader than a minimal registry persistence patch. It creates the database shape that later Iris modules will use for knowledge drafts, audit logs, task records, document parsing state, and pgvector semantic indexes.

Constitutional alignment:

> Postgres is Iris's fact layer. If Iris claims that something happened, the system should be able to trace that claim to fact-layer evidence.

## 2. Design Goals

Phase 2C must provide:

- a typed database configuration boundary;
- a Postgres connection pool managed by the TypeScript Core App;
- a repeatable SQL migration runner;
- initial schema for document sources and source evidence;
- a Postgres-backed Document Source Registry implementation;
- database-level idempotency for repeated Feishu message events;
- durable administrator mutations for permission, sync, and capability flags;
- a test strategy that does not require Docker to be installed for ordinary unit tests.

The in-memory registry remains valuable. It should stay available for unit tests, local isolated behavior checks, and future lightweight fallback scenarios.

## 3. Out Of Scope

This phase does not implement:

- Feishu document body fetching;
- Feishu wiki traversal;
- OAuth installation or token refresh;
- document parsing, chunking, or embedding generation;
- pgvector tables or vector search;
- real-time Feishu permission API calls;
- admin UI screens;
- Redis-backed queue persistence;
- multi-tenant database isolation.

Those later features should use the database foundation introduced here instead of creating separate persistence paths.

## 4. Architecture Choice

Phase 2C uses SQL migrations plus a small repository layer instead of introducing an ORM.

Chosen stack:

- `pg` for Postgres access and pooling;
- plain SQL migration files;
- a TypeScript migration runner;
- repository-style database access for document sources;
- existing Vitest unit tests for domain behavior;
- optional integration tests gated by `DATABASE_URL`.

Rejected alternatives:

- Full ORM from this phase: useful later if the schema grows rapidly, but too much abstraction before Iris's fact-layer patterns are proven.
- Event-sourced source store: excellent audit power, but too complex before document ingestion and admin workflows exist.
- Replacing the in-memory registry: unnecessary. It is still the fastest way to test domain semantics without infrastructure.

Constitutional principle:

> The database layer should make Iris more traceable, not more magical. SQL schema, constraints, and repository code must make source authority and evidence explicit.

## 5. Database Configuration

The TypeScript Core App should read:

- `DATABASE_URL`: Postgres connection string.

For local development, the existing Docker Compose service already exposes:

```text
postgres://iris:iris@localhost:5432/iris
```

The app should not require `DATABASE_URL` merely to run pure unit tests. Database-dependent scripts and integration tests should require it explicitly and fail with a clear message when missing.

The database module should expose:

- a connection pool factory;
- a graceful close function;
- a health check query such as `select 1`;
- a typed error for missing database configuration.

## 6. Migration System

Migrations should live under the Core App so the application owns its fact-layer schema.

Recommended location:

```text
apps/core/migrations/
  0001_document_sources.sql
```

The migration runner should:

- create a migration bookkeeping table, for example `schema_migrations`;
- run SQL files in lexical order;
- record applied migration names and timestamps;
- run each migration in a transaction;
- skip already-applied migrations;
- expose an npm script: `npm --workspace apps/core run db:migrate`.

Migration files should be idempotent at the runner level, not by weakening every schema statement with broad conditional behavior. The runner is responsible for deciding whether a migration has already run.

## 7. Schema

### 7.1 document_sources

`document_sources` stores one canonical source per normalized `source_uri`.

Required columns:

- `id text primary key`
- `source_type text not null`
- `source_uri text not null unique`
- `title text null`
- `origin_group_id text null`
- `origin_message_id text null`
- `submitted_by_user_id text null`
- `authorized_space_id text null`
- `permission_state text not null`
- `sync_state text not null`
- `can_use_for_answering boolean not null`
- `can_use_for_knowledge_drafts boolean not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Required constraints:

- `source_type` must be one of `group_visible_document`, `authorized_wiki_document`, `user_submitted_document`.
- `permission_state` must be one of `unknown`, `readable`, `denied`, `stale`.
- `sync_state` must be one of `pending`, `syncing`, `synced`, `failed`.
- `source_uri` must be unique.

Recommended indexes:

- `document_sources_updated_at_id_idx` on `updated_at desc, id asc`
- `document_sources_source_type_idx` on `source_type`
- `document_sources_origin_group_id_idx` on `origin_group_id`
- `document_sources_authorized_space_id_idx` on `authorized_space_id`
- `document_sources_submitted_by_user_id_idx` on `submitted_by_user_id`

### 7.2 document_source_evidence

`document_source_evidence` stores provenance for why Iris knows about a source.

Required columns:

- `id bigserial primary key`
- `document_source_id text not null references document_sources(id) on delete cascade`
- `kind text not null`
- `source_uri text not null`
- `group_id text null`
- `message_id text null`
- `user_id text null`
- `space_id text null`
- `observed_at timestamptz not null`
- `created_at timestamptz not null`

Required constraints:

- `kind` must be one of `group_message`, `admin_authorization`, `user_submission`.
- Evidence must be idempotent for repeated Feishu retries.

Because SQL unique constraints treat nulls differently across databases and versions, the first migration should use a functional unique index over normalized values:

```sql
create unique index document_source_evidence_dedupe_idx
on document_source_evidence (
  kind,
  source_uri,
  coalesce(group_id, ''),
  coalesce(message_id, ''),
  coalesce(user_id, ''),
  coalesce(space_id, '')
);
```

This mirrors the Phase 2B evidence key:

```text
kind + sourceUri + groupId + messageId + userId + spaceId
```

`observed_at` is intentionally excluded from the dedupe key. Feishu may retry the same event with the same `messageId`, and Iris must not append duplicate evidence merely because delivery timing changed.

## 8. Registry Persistence Behavior

The Postgres-backed registry must preserve Phase 2B semantics:

- register group-visible documents with group/message evidence;
- register authorized wiki documents with admin authorization evidence;
- register user-submitted documents with user submission evidence;
- deduplicate by `source_uri`;
- append distinct evidence;
- ignore duplicate evidence;
- preserve original `id` and `created_at`;
- update `updated_at` on repeated registration;
- upgrade source type only according to source-type priority;
- never downgrade an admin-authorized source because it later appears in a group;
- preserve administrator-disabled capability flags during re-registration;
- force `can_use_for_answering = false` when permission becomes `denied`;
- prevent `setAnsweringEnabled(id, true)` from overriding denied permission.

Source type priority remains:

1. `authorized_wiki_document`
2. `group_visible_document`
3. `user_submitted_document`

Registration should use a transaction. The transaction should:

1. find or insert the source by `source_uri`;
2. merge metadata and source type;
3. upsert/update the source row;
4. insert evidence with database-level dedupe;
5. return the canonical source with evidence.

The exact SQL may use `insert ... on conflict` where it keeps the merge rules readable. If the merge becomes hard to reason about in one statement, use a transaction with explicit select/update/insert steps.

## 9. Query Behavior

The Postgres-backed registry must expose the same interface as the in-memory registry:

- list all sources;
- list sources by type;
- find a source by id;
- find a source by URI;
- list sources usable for answering;
- list sources by group id;
- list sources by authorized space id;
- list sources by submitting user id.

Ordering remains deterministic:

1. newest `updated_at` first;
2. then `id` ascending.

Group, space, and user queries must consider both top-level source columns and evidence rows. This matters because one canonical source can be discovered from multiple groups or users over time.

## 10. Runtime Integration

Phase 2C should introduce the database-backed registry without forcing every test or local app run to require Postgres.

Recommended integration:

- keep `createDocumentSourceRegistry()` as the in-memory constructor;
- add `createPostgresDocumentSourceRegistry(pool, dependencies?)`;
- add database modules under `apps/core/src/database`;
- add an app dependency injection point so production can pass a Postgres registry later.

The Feishu event ingestion path does not need to call the Postgres registry in this phase unless the implementation plan explicitly keeps it small and tested. The priority is durable database foundation and repository correctness.

## 11. Testing Strategy

Testing should be layered:

1. Existing in-memory registry tests continue to run in every `npm test`.
2. Shared behavior tests should be extracted where practical so both implementations can be checked against the same contract.
3. Postgres integration tests should run only when `DATABASE_URL` is set.
4. Migration tests should be able to run against a real database and verify tables, constraints, and idempotent reruns.

Local environment limitation:

The current development machine may not have Docker CLI installed. Tests and typechecks must still pass without Docker. Commands requiring Docker or a running Postgres should be reported as environment-dependent verification.

## 12. Future Integration Points

The database foundation should support future phases:

- document fetcher records body-fetch state against `document_sources`;
- parser and embedding workers use source IDs when creating chunks;
- pgvector tables reference document source IDs for permission-bounded retrieval;
- Permission Guard writes permission denials and stale states;
- Admin Console edits capability flags;
- Knowledge Governance cites evidence when generating drafts;
- Audit Log records high-impact mutations.

Future schema should prefer explicit foreign keys to `document_sources(id)` instead of embedding source URIs as the only relationship.

Constitutional principle:

> Phase 2C turns document source memory from temporary process state into durable organizational fact. It must preserve the safety semantics already proven in memory while creating the database foundation for Iris's next modules.
