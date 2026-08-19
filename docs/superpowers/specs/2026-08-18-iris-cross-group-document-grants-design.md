# Iris Cross-Group Document Grants Design

## Status

Approved for implementation on 2026-08-18 under the user's standing instruction to select and
continue the next unclosed whitepaper core capability without another approval prompt.

This design advances IRIS-CORE-004 with one bounded end-to-end capability: an administrator may
explicitly grant one group read-only answer access to one `group_visible_document` that is
authoritatively evidenced in another group. It does not enable cross-group chat memory, knowledge
draft generation, proactive speech, or broad company-wide sharing.

## Problem

Production answer retrieval currently allows a group-visible document only when the current group
is the source's origin group or appears in `document_source_evidence`. This default-deny boundary is
correct, but IRIS-CORE-004 remains only partially implemented because there is no first-class way to
authorize a different group.

Adding an `OR target_group_id = current_group` check is insufficient. A safe implementation must:

- represent the grant as durable, versioned, auditable operator intent;
- apply it before vector ranking so unauthorized fragments cannot crowd the bounded candidate set;
- repeat the grant check before source text enters the model prompt;
- persist the exact grant identity and version in the answer receipt;
- prevent a grant revoked after answer preparation from being used for Feishu delivery;
- preserve source policy, live Feishu permission, runtime group isolation, and emergency pause;
- make grant/revoke retries idempotent without making authorization implicit.

## Scope

### Included

- First-class PostgreSQL grant projection and append-only events.
- Internal authenticated grant, revoke, and list APIs.
- Admin Console grant visibility and bounded grant/revoke controls.
- SQL pre-ranking eligibility for answer retrieval only.
- TypeScript defense-in-depth validation before prompt assembly.
- Exact grant ID/version/source/grantor/grantee binding in answer source traces.
- Atomic final-send validation and revoke-versus-send serialization.
- Content-free status, audit, test, and one-pilot/two-control acceptance evidence.

### Excluded

- Cross-group `group_memories`, `discussion_threads`, `action_items`, or raw chat history.
- Cross-group knowledge-conflict detection or knowledge-draft evidence.
- Cross-group proactive candidates, notifications, task creation, or Wiki writes.
- Automatic grants inferred from bot membership, enabled runtime state, common URLs, source-type
  upgrades, repeated registration, model output, or missing group IDs.
- End-user grant management, group-owner role discovery, tenant-wide policies, expiry schedules,
  bulk grants, or wildcard groups.

## Constitutional Invariants

1. No grant is the default. Existing same-group behavior remains unchanged.
2. Only `group_visible_document` can use this grant path. Wiki and user-submitted sources retain
   their existing policies.
3. A grant names exactly one source, one grantor group evidenced on that source, and one distinct
   grantee group.
4. A grant authorizes answer retrieval only. `usage=knowledge_drafts` always keeps the existing
   exact-group predicate.
5. A grant never overrides `can_use_for_answering=false`, `permission_state=denied|stale`, a failed
   live Feishu permission check, `readGroupDocuments=false`, a disabled grantee group, or a disabled
   global runtime.
6. SQL eligibility runs before vector ranking. The TypeScript source-policy guard independently
   revalidates the same exact grant before prompt assembly.
7. Every cross-group fragment carries the exact grant ID, version, grantor, and grantee. Same-group
   fragments carry no grant binding even if a redundant grant exists.
8. Answer preparation and final send reject missing, revoked, version-changed, source-mismatched,
   grantor-evidence-stale, or grantee-mismatched bindings.
9. Grant revocation and answer send use grant-before-delivery lock order. Revocation is rejected
   while a bound answer is `sending` or `reconciliation_required`; if revocation wins first, send
   fails closed before external Feishu I/O.
10. Grant mutation history is append-only. Status and audit surfaces expose metadata only, never
    source text, fragment text, answer text, callback payloads, or authorization secrets.

## Durable Model

Migration `0051_document_source_group_grants.sql` creates the projection:

```sql
document_source_group_grants (
  id text primary key,
  document_source_id text not null references document_sources(id) on delete restrict,
  grantor_group_id text not null,
  grantee_group_id text not null,
  state text not null check (state in ('active', 'revoked')),
  version bigint not null check (version >= 1),
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (document_source_id, grantee_group_id),
  check (grantor_group_id <> grantee_group_id)
)
```

The uniqueness constraint deliberately permits only one current authorization path from a source
to a grantee. Replacing the grantor requires an explicit versioned transition and remains visible in
history.

Append-only facts use:

```sql
document_source_group_grant_events (
  id text primary key,
  grant_id text not null references document_source_group_grants(id) on delete restrict,
  event_type text not null check (event_type in ('granted', 'revoked')),
  from_version bigint,
  to_version bigint not null,
  operation_key text not null unique,
  operation_fingerprint text not null,
  actor_ref text not null,
  created_at timestamptz not null,
  unique (grant_id, to_version)
)
```

Row and statement triggers reject UPDATE, DELETE, and TRUNCATE on the event table. The projection is
mutable only through the repository's versioned transaction.

The same migration extends `answer_reply_source_traces` with nullable
`cross_group_grant_id`, `cross_group_grant_version`, `cross_group_grantor_group_id`, and
`cross_group_grantee_group_id`. An all-or-none check requires all four values together, requires a
positive version, requires `source_type='feishu_group_document'`, and rejects equal grantor/grantee
groups. The grant foreign key uses `ON DELETE RESTRICT`.

## Domain And Repository Contract

`DocumentSourceGroupGrant` contains the projection fields above with cloned dates. Repository
operations are:

```ts
grant(input: {
  documentSourceId: string;
  grantorGroupId: string;
  granteeGroupId: string;
  expectedVersion: number;
  operationKey: string;
  actorRef: string;
  at: Date;
}): Promise<{ outcome: "applied" | "already_applied"; grant: DocumentSourceGroupGrant }>;

revoke(input: {
  grantId: string;
  expectedVersion: number;
  operationKey: string;
  actorRef: string;
  at: Date;
}): Promise<{ outcome: "applied" | "already_applied"; grant: DocumentSourceGroupGrant }>;

findActiveForSourceAndGrantee(input: {
  documentSourceId: string;
  granteeGroupId: string;
}): Promise<DocumentSourceGroupGrant | undefined>;

validateExact(input: {
  grantId: string;
  version: number;
  documentSourceId: string;
  grantorGroupId: string;
  granteeGroupId: string;
}): Promise<boolean>;
```

`expectedVersion=0` is valid only when no projection exists. Regranting a revoked row requires its
current positive version. Exact operation replay returns `already_applied`; the same operation key
with a different fingerprint is a conflict. All strings are nonblank and bounded to 512 characters;
timestamps must be valid. The repository locks the document source and projection, proves
`source_type='group_visible_document'`, and proves the grantor appears in current source origin or
evidence before every grant transition.

Revocation locks the grant, then queries bound answer deliveries with `FOR UPDATE OF delivery`.
It rejects while any bound delivery is `sending` or `reconciliation_required`. The global lock order
is sorted grants, optional knowledge-conflict candidate, then answer delivery.

## Retrieval Flow

For `usage='answering'` with a current group, both fragment search queries add one deterministic
left join to the unique active grant for `(document_source_id, current_group_id)`. The join is usable
only when the grantor still appears in the source's origin/evidence.

The group-visible predicate becomes:

```sql
same_group_origin_or_evidence
or current_scope_grant.id is not null
```

This predicate remains inside the document-source join before the embedding join, distance order,
per-source rank, and global limit. For a same-group source, selected grant columns are forced to
NULL. For a cross-group source, the result includes the exact grant binding.

For `usage='knowledge_drafts'`, the query remains exact-group only and never joins or returns a
cross-group grant.

Source-aware neighbor expansion copies the seed fragment's exact grant binding. Retrieval fusion
rejects conflicting grant metadata for the same fragment instead of choosing one silently.

## Prompt-Time Defense In Depth

The answer runtime composes the PostgreSQL grant repository only in production `source-policy`
mode. A group-visible source is locally eligible when either:

- its origin/evidence contains the current group; or
- an active grant exists for the exact source and current group and its grantor is still evidenced.

Before permission filtering, the retrieval context validates every cross-group fragment's exact
binding. A source with mixed, missing, or conflicting bindings is entirely denied. Same-group
fragments with a grant binding are also denied because SQL must not attach one.

Only then does the existing live Feishu permission guard run. This ordering prevents source text
from reaching the prompt when the grant is stale while preserving the independent content
permission check.

## Answer Receipt And Final Send

The citation renderer copies the exact grant binding from each allowed fragment into its source
trace. All fragments for one document must agree on local scope or one exact grant. Receipt
normalization, semantic fingerprinting, API serialization, replay comparison, and append-only trace
loading include the binding.

`prepare` sorts unique grant IDs, locks them before the optional conflict candidate and delivery,
and validates every cross-group trace. A local group-document trace must not carry a grant.

`beginAnswerSend` repeats the same sorted grant locks and exact validation in its transaction before
the delivery becomes `sending`. A stale binding raises a typed permission-stale result; the delivery
service records the existing permission-blocked terminal path and performs no Feishu send.

If begin-send wins the grant lock, a concurrent revoke waits and then rejects because the delivery
is `sending`. If revoke wins, begin-send sees the revoked/version-changed grant and fails closed.
No database lock is held across Feishu network I/O.

## Internal API

All routes remain behind the existing internal bearer boundary and public Caddy 404 policy.
Mutations additionally require the existing nonblank `x-iris-operator` header; that value becomes
`actorRef`.

- `GET /internal/document-sync/sources/:id/group-grants?limit=N`
- `POST /internal/document-sync/sources/:id/group-grants`
- `POST /internal/document-sync/sources/:id/group-grants/:grantId/revoke`

Grant body fields are `grantorGroupId`, `granteeGroupId`, `expectedVersion`, and `operationKey`.
Revoke fields are `expectedVersion` and `operationKey`. Responses contain only grant metadata and
`applied|already_applied`. Validation is 400, missing source/grant is 404, stale version or operation
conflict is 409, active-answer conflict is 409, and unavailable persistence is 503/500 using the
existing internal error conventions.

## Admin Console

Document-source detail shows bounded group-grant metadata: grant ID, grantor group, grantee group,
state, version, and update time. An operator can create/regrant with exact expected version and
revoke an active grant. The console confirms both group IDs and exact source ID before mutation,
refreshes from the server after success, and never renders source body, fragment text, answers,
actor identity, operation keys, or credentials.

## Observability And Readiness

Document-source status adds content-free counts for active and revoked grants plus the latest
mutation timestamp. Count failure marks the internal status component unavailable. No public route
is added. Default readiness does not require an empty grant table, but it requires the migration and
readability of grant counts. Pilot readiness additionally requires the exact planned active grant
set and zero unresolved answer deliveries.

## Acceptance

The first acceptance uses one source group, one distinct grantee group, and one non-grantee control
group while all unrelated capabilities remain disabled.

1. Prove no cross-group result before a grant and no prompt/source receipt for the target source.
2. Create one exact grant through the authenticated operator API and prove one append-only event.
3. Ask from the grantee group and prove retrieval was pre-ranked with the exact grant binding, live
   Feishu permission passed, the answer receipt stored the same grant/version, and the visible reply
   cited only the authorized source.
4. Prove the control group still cannot retrieve the source.
5. Pause after answer preparation, revoke first, resume, and prove zero Feishu send plus a terminal
   permission-blocked receipt.
6. Regrant with the next exact version, deliver once, replay the same operation, and prove no
   duplicate grant event or answer delivery.
7. Race begin-send versus revoke in real PostgreSQL and accept only the two safe serial outcomes.
8. Revoke the pilot grant, disable all groups/global capabilities, stop Caddy, drain queues/outboxes,
   and prove append-only facts remain while mutable fingerprints stop changing.

## Completion Rule

Code completion requires focused and full automated gates plus conditional real-PostgreSQL
concurrency coverage in exact-SHA CI. IRIS-CORE-004 remains "partially implemented" until the live
three-group acceptance above passes. A successful pilot closes only cross-group document answers;
cross-group chat memory and knowledge drafts remain explicit future work.
