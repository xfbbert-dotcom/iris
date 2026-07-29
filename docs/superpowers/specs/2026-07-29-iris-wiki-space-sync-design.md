# Iris Feishu Wiki Space Sync Design

Date: 2026-07-29
Status: Approved architecture extension
Product: Iris

## 1. Purpose

Iris already supports registering and synchronizing one authorized Feishu wiki
page at a time. The internal pilot showed that this is not enough for the
whitepaper requirement:

> After an administrator grants Iris access to a Feishu knowledge base, Iris
> can learn from that knowledge base without requiring every page link to be
> registered manually.

This design adds durable, asynchronous wiki-space discovery to the existing
modular monolith. An administrator registers one wiki root URL. Iris resolves
the root, enumerates supported descendant pages, idempotently registers them as
authorized wiki documents, and hands them to the existing document sync and
semantic indexing pipeline.

The feature does not replace the document source registry, document sync
worker, vector index, or answer-time permission guard. It connects those
existing components into the missing end-to-end knowledge-base ingestion loop.

## 2. Architectural Decision

The first 20-30-person internal version keeps wiki-space sync inside the
TypeScript Core modular monolith:

```text
Admin Console / Internal API
          |
          | register root URL (fast, no Feishu network call)
          v
wiki_space_authorizations (Postgres)
          |
          | claim due scan with lease
          v
Wiki Space Sync Worker
          |
          | Feishu wiki node APIs, bounded breadth-first traversal
          v
Document Source Registry
          |
          | existing idempotent registration + document-sync enqueue
          v
Document Sync -> Reindex -> Retrieval -> Real-time Permission Guard
```

This is preferred over a separate service because the pilot load is small,
Core already owns the Feishu tenant token and document registration pipeline,
and a process boundary would add deployment and consistency cost without
improving the current product loop. The repository and worker interfaces keep
the module extractable later if scale or ownership requires it.

## 3. Scope

### 3.1 Included

- register one authorized Feishu wiki root URL;
- persist authorization and scan state in Postgres;
- asynchronously resolve the root node and its space ID;
- recursively enumerate descendants with pagination;
- register supported pages through the existing
  `registerAuthorizedWikiDocument` path;
- enqueue each registered page through the existing document-sync planner;
- periodically refresh the space and allow an administrator to request a
  rescan;
- expose scan state, counts, last success, and safe error classification;
- disable or re-enable an authorization explicitly;
- use leases, bounded retries, and a terminal dead-letter state;
- preserve the existing live answer-time permission guard as the final
  authority.

### 3.2 Not Included

- automatic traversal into a different Feishu space;
- automatic deletion or disabling of pages missing from one scan;
- support for Feishu sheets, bitables, slides, mind notes, or arbitrary files;
- a new vector model or embedding dimension;
- provider failover or local-model deployment;
- multi-tenant installation and billing;
- splitting the worker into a standalone service.

Unsupported node types are counted and skipped. They do not fail an otherwise
valid scan.

## 4. Durable Model

Migration `0041_wiki_space_authorizations.sql` creates
`wiki_space_authorizations`.

Fields:

- `id`: stable Iris-side identifier.
- `root_source_uri`: normalized Feishu wiki root URL; unique.
- `root_node_token`: token parsed from the normalized URL.
- `space_id`: resolved Feishu space ID, nullable before the first successful
  resolution.
- `title`: most recently observed root title, nullable.
- `enabled`: explicit administrator policy.
- `scan_state`: `pending | scanning | synced | retry_wait | dead_letter |
  disabled`.
- `attempt_count`: consecutive failed scan attempts.
- `next_scan_at`: earliest time a worker may claim the authorization.
- `lease_expires_at`: recovery boundary for a worker that stops mid-scan.
- `last_scan_started_at`: most recent claim time.
- `last_scan_completed_at`: most recent terminal attempt time.
- `last_success_at`: most recent successful full traversal.
- `last_error_classification`: bounded safe classification without upstream
  response bodies or credentials.
- `discovered_node_count`: nodes seen in the last successful traversal.
- `registered_document_count`: supported pages handed to the document source
  registry in the last successful traversal.
- `skipped_node_count`: unsupported nodes skipped in the last successful
  traversal.
- `revision`: optimistic state-transition version.
- `created_at` and `updated_at`.

Registration is idempotent by normalized `root_source_uri`. Re-registering an
existing enabled root requests a scan without creating another row.
Re-registering a disabled root does not silently re-enable it.

## 5. State Machine And Scheduling

```text
register -> pending -> scanning -> synced
                     |          |
                     |          +-> next periodic pending claim
                     |
                     +-> retry_wait -> scanning
                     |
                     +-> dead_letter

any non-scanning state --admin disable--> disabled
disabled --admin enable--> pending
synced/retry_wait/dead_letter --manual rescan--> pending
```

The repository claims work with a transaction and
`FOR UPDATE SKIP LOCKED`. A claim sets `scan_state=scanning`, records the start,
increments `revision`, and assigns a lease. An expired scanning lease is
claimable again.

Success resets `attempt_count`, clears errors and leases, records counts, and
sets `next_scan_at` to the periodic refresh time.

Retriable failures include Feishu rate limits, timeouts, transport failures,
and upstream 5xx responses. They enter `retry_wait` with bounded exponential
backoff. Authentication denial, malformed root data, cross-space traversal,
and exhausted retries enter `dead_letter`. Manual rescan is required to leave
`dead_letter`.

The first internal release uses:

- one scan at a time per Core process;
- a maximum of 500 discovered nodes per authorization;
- a maximum depth of 20;
- Feishu page size of 50;
- a 10-minute lease;
- at most 5 consecutive attempts;
- a 6-hour successful refresh interval;
- retry delays capped at 30 minutes.

All values except the hard maximum node count are configuration inputs with
safe defaults. The node limit is deliberately conservative for the internal
company deployment.

## 6. Feishu Traversal

The worker uses the existing cached `FeishuTenantAccessTokenProvider`.

For each claimed authorization:

1. Resolve `root_node_token` through the Feishu wiki node API.
2. Record the authoritative `space_id` and root title.
3. Add the root node to a breadth-first queue.
4. For each node, list direct children with Feishu pagination.
5. Reject any child whose reported `space_id` differs from the root.
6. Stop with a safe terminal classification if depth or node limits are
   exceeded.
7. For each supported wiki page, build a canonical
   `https://<tenant-host>/wiki/<node_token>` source URI.
8. Call the existing authorized-wiki registration method with the resolved
   space ID and title.
9. Use the existing manual document-sync planner to enqueue the resulting
   source.

Supported v1 pages are wiki nodes whose object type can be fetched by the
existing Feishu document body fetcher. The scanner never guesses an object URL
or bypasses the fetcher.

Traversal order is deterministic breadth-first order. Node tokens are
deduplicated in memory during a scan so malformed cyclic API results cannot
create an infinite traversal or duplicate registrations.

## 7. API And Admin Console

Internal endpoints:

- `POST /internal/document-sync/wiki-spaces`
  - body: `{ "rootSourceUri": "https://.../wiki/<token>" }`;
  - validates and normalizes locally;
  - persists `pending`;
  - returns `202` without calling Feishu.
- `GET /internal/document-sync/wiki-spaces?limit=<n>`
  - lists authorizations and scan state.
- `POST /internal/document-sync/wiki-spaces/:id/rescan`
  - moves an existing authorization to `pending`.
- `PATCH /internal/document-sync/wiki-spaces/:id`
  - body: `{ "enabled": true | false }`;
  - disabling moves the row to `disabled`;
  - enabling moves it to `pending`.

The internal Admin Console adds a compact "Wiki Spaces" section with a root
URL field, registration command, status table, rescan control, and enabled
toggle. It does not expose credentials or raw upstream error text.

Public ingress continues to block `/internal/*`.

## 8. Idempotency And Existing Source Policy

The scanner does not create a second document model. Every discovered page is
registered in the existing `document_sources` and
`document_source_evidence` tables.

Existing invariants remain authoritative:

- canonical source URI deduplication;
- one admin-authorization evidence record per source URI and space ID;
- administrator-disabled source capabilities are not silently re-enabled;
- repeated scans may enqueue a source, but queue idempotency prevents duplicate
  pending work;
- successful content hashing prevents unchanged content from creating
  unnecessary snapshots;
- answer-time live permission checks decide whether a retrieved fragment may
  reach the model.

One failed or partial scan does not mark previously known pages denied, stale,
or deleted. Feishu permission propagation can lag, and absence from one listing
is not sufficient revocation evidence. Explicit administrator action and the
live permission guard remain fail-closed.

## 9. Error Handling And Observability

The scanner records classifications such as:

- `feishu_rate_limited`;
- `feishu_timeout`;
- `feishu_unavailable`;
- `feishu_unauthorized`;
- `root_not_found`;
- `cross_space_node`;
- `node_limit_exceeded`;
- `depth_limit_exceeded`;
- `invalid_feishu_response`;
- `document_registration_failed`.

It never stores Feishu response bodies, tenant tokens, app secrets, or document
content in the authorization row.

Document-sync status gains a nested `wikiSpaceSync` snapshot:

- enabled and running;
- pending, retry-wait, scanning, and dead-letter counts;
- latest completed batch;
- last safe loop error classification.

The normal document-sync and reindex queue metrics remain separate. A
successful space traversal means discovery and enqueue succeeded; it does not
pretend downstream embedding has completed.

## 10. Test Strategy

Tests must cover:

- migration presence and constraints;
- URI normalization and token extraction;
- idempotent registration and disabled-policy preservation;
- transactional claims and expired-lease recovery;
- success, retry, dead-letter, enable, disable, and manual-rescan transitions;
- root resolution, pagination, deterministic breadth-first traversal, node
  deduplication, unsupported node skipping, and same-space enforcement;
- node/depth bounds;
- idempotent document registration and enqueue on repeated scans;
- no Feishu call on the registration HTTP request;
- API validation and unavailable-runtime behavior;
- Admin Console registration, status rendering, rescan, and enable controls;
- runtime start, status, and graceful shutdown;
- unchanged existing document-source, document-sync, permission-guard, and
  public-ingress tests.

No unit, integration, or CI test may consume Gemini quota. Deterministic fake
Feishu clients and the existing static development embedding profile cover
automated behavior. Gemini is reserved for the final small real-data
acceptance.

## 11. Acceptance And Exit Conditions

The feature is complete for the internal release when:

1. Registering the pilot root URL returns before any Feishu network request.
2. One worker scan discovers the root and both current child pages.
3. Exactly three authorized wiki document sources exist for that space.
4. Repeating the scan creates no duplicate source or evidence rows.
5. Adding a fourth child and rescanning discovers it without manual page
   registration.
6. Disabling the space prevents future scans but does not delete history.
7. Revoking a page permission prevents its fragments from reaching the answer
   model through the existing real-time permission guard.
8. Space-sync, document-sync, and reindex pending/DLQ counts return to zero
   after the acceptance run.
9. Core tests, typecheck, build, and repository CI pass.
10. The currently running pilot remains on its approved commit until this
    candidate passes review and receives explicit deployment approval.

Provider capacity that blocks semantic indexing is recorded as a downstream
reindex failure; it does not extend this feature indefinitely. Local free-model
test infrastructure is a separate architecture change.

