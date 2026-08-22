# Iris Managed Knowledge Publication Update Design

**Date:** 2026-08-19

**Status:** Scope approved in conversation on 2026-08-19; design awaiting review

**Baseline:** `master@36aca0ab1080c41b1a70f4b7a2ce102954e52de7`

**Constitution:** `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

**Predecessor:** `docs/superpowers/specs/2026-07-28-iris-knowledge-conflict-design.md`

## 1. Executive Summary

Iris can already detect knowledge conflicts, create a governed update draft, collect group confirmation, collect an authorized approval, and publish the draft as a new Wiki page. That loop deliberately stops short of editing the original page.

This design closes that gap for a deliberately narrow and provable target class: Wiki pages originally created and managed by Iris, whose single plain-text body block, document token, block identifier, revision, source binding, and content hash are all known exactly.

The new high-impact action is `update_knowledge_publication`. It reuses the existing action-proposal lifecycle but has its own target binding, execution ledger, freshness barrier, Feishu client path, reconciliation logic, and success fact. It never edits arbitrary documents, never guesses block identity, never adopts legacy pages automatically, and never falls back silently from “update this page” to “publish another page.”

The end-to-end result is:

1. Iris detects a conflict against an eligible Iris-managed page.
2. Iris creates a draft that explicitly says it will update that existing page.
3. The group confirms the exact draft and target.
4. An authorized reviewer sees the full text through the existing OAuth review surface and approves the exact action fingerprint.
5. The executor revalidates permissions, versions, revision, body identity, and policy.
6. Iris blocks stale indexed content, updates the exact Feishu block at the exact revision, and records the outcome durably.
7. Iris resynchronizes and reindexes the page before making it available for retrieval again.
8. Iris reports a content-free result and retains append-only audit facts.

## 2. Problem and Current Evidence

### 2.1 The current conflict loop publishes a new page

The conflict loop creates a `knowledge_conflict` draft, but the downstream planner and action proposal are hardcoded to `publish_knowledge_draft`:

- `apps/core/src/action-approvals/action-proposal.ts` exposes only the publication action literal.
- `apps/core/src/action-approvals/action-proposal-planner.ts` always creates a publication operation key and publication proposal.
- `apps/core/src/action-approvals/knowledge-publication-executor.ts` only calls the publication publisher.
- `apps/core/src/action-approvals/feishu-knowledge-publication-publisher.ts` creates a new Wiki node and adds a new body block.

The predecessor conflict design explicitly records in-place modification as a future, separate high-impact action.

### 2.2 Arbitrary document editing is unsafe in the current data model

The ingestion pipeline preserves normalized source text, snapshots, fragments, source versions when available, and content hashes. It does not preserve a lossless mapping from every indexed fragment back to an exact Feishu rich-document block and element range.

Therefore Iris cannot safely infer which arbitrary remote block should be replaced from a retrieved text fragment. Text matching would be ambiguous under repeated text, formatting, tables, embeds, concurrent edits, and chunk boundaries.

### 2.3 Iris-created pages provide a safe first boundary

The current Feishu publisher creates one plain-text child block under a newly created document. If publication captures the created block identity and revision, Iris can prove the full managed body boundary without reverse-engineering arbitrary document structure.

This produces a useful end-to-end update loop while keeping the action boundary narrow enough to validate safely in a controlled pilot.

## 3. Goals

This increment must:

1. Add `update_knowledge_publication` as a distinct, governed high-impact action.
2. Restrict the action to active Iris-managed Wiki publications with exact remote identity.
3. Route eligible conflict drafts to an update action without changing the existing publish-new behavior for unbound drafts.
4. Bind confirmation, review, approval, and execution to the exact draft revision, conflict candidate, managed page version, remote revision, block, and before/after content hashes.
5. Prevent stale pre-update content from being retrieved or sent after the remote write begins.
6. Use exact-revision, idempotent Feishu writes with bounded retries and explicit outcome-unknown reconciliation.
7. Resynchronize and reindex the remote page before reopening it to answers and future conflict detection.
8. Preserve append-only execution and audit facts without storing document bodies in logs or operational observations.
9. Keep the current publication path and all existing controlled-pilot loops working.
10. Finish with controlled Feishu acceptance and then move on; non-blocking hardening becomes backlog.

## 4. Non-Goals

This increment does not:

- edit arbitrary existing Feishu documents;
- auto-adopt publications created before exact block tracking exists;
- edit multi-block documents, titles, tables, images, embeds, comments, or rich formatting;
- delete, move, or archive Wiki nodes;
- update a page in a different authorization group;
- choose which conflicting claim is true without the existing human-governed draft flow;
- permit a model or answer generator to call a write API directly;
- create a generic document-patching language;
- implement Feishu Task creation or persistent multi-step workflow audit;
- broaden rollout beyond an explicit controlled pilot allowlist.

## 5. Alternatives Considered

### 5.1 Selected: exact single-block updates for Iris-managed pages

Capture page and block identity during new publication, bind eligible conflict drafts to that managed page, and replace the entire managed plain-text body block at an exact remote revision.

This is the smallest action that closes the whitepaper’s conflict-update loop without guessing remote structure.

### 5.2 Deferred: arbitrary block-aware document editing

This would require lossless block ingestion, stable block-to-fragment provenance, element-level patch generation, richer concurrency rules, and broader permission semantics. It is valuable but materially larger and riskier than the selected increment.

### 5.3 Existing behavior: always publish a new page

This remains the fallback only when a draft was created without an eligible update target. It does not satisfy the original-page update capability by itself and can create duplicate truth sources.

### 5.4 Separate future action: create a formal Feishu task

Formal tasks are useful for operational follow-through, but they do not close the knowledge-conflict content loop. They should be designed as another action type after this increment.

## 6. Constitutional Invariants

The implementation must preserve all of these invariants:

1. **No direct model write.** Only an approved executor may invoke the remote mutation API.
2. **Managed targets only.** An update requires one active `managed_knowledge_page` created from an Iris publication with exact block identity.
3. **One managed block.** The first version replaces exactly one Iris-owned plain-text body block; it never edits neighboring blocks.
4. **Exact intent binding.** Confirmation and approval bind the action type, draft revision, candidate version, managed-page version, source snapshot, remote document, block, expected revision, current hash, and proposed hash.
5. **No silent fallback.** A stale or ineligible update action is cancelled, failed, or reconciled; it never becomes publish-new automatically.
6. **Capability gates are conjunctive.** Global runtime enablement, group enablement, `writeKnowledgeBase`, and `updateManagedKnowledge` must all be enabled.
7. **Exact remote revision.** Execution never uses a latest-revision wildcard for mutation.
8. **Deterministic idempotency.** Every remote write uses a deterministic client token derived from the durable operation identity.
9. **Permission revalidation.** Source read permission, target policy, authorization group, and Feishu write authorization are rechecked immediately before mutation.
10. **No network calls under database locks.** Claims and state transitions are short transactions; remote reads and writes occur outside locks.
11. **No blind retry after uncertain delivery.** A timeout or connection loss after request dispatch enters outcome-unknown handling and requires readback.
12. **No stale-answer window.** The linked source becomes unavailable to retrieval before mutation and stays unavailable until the expected new snapshot is indexed.
13. **Send-time protection.** Answers prepared before the barrier must fail the final source check rather than send stale content.
14. **Append-only evidence.** Executions, state transitions, approvals, reconciliations, and successful updates retain immutable facts.
15. **Content-free telemetry.** Logs, metrics, agent observations, and list endpoints do not include document or draft bodies.
16. **Default off.** The feature and its per-group capability remain disabled until dependencies, migrations, and allowlist configuration are valid.

## 7. Domain Model

### 7.1 Managed knowledge page projection

Add a `managed_knowledge_pages` projection with one row for each publication that is eligible for later in-place updates.

Recommended fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable internal page identifier |
| `origin_knowledge_publication_id` | Unique link to the immutable original publication success fact |
| `target_policy_id` / `target_policy_version` | Policy that authorized page creation |
| `authorization_group_id` | Group within which this page may be governed |
| `remote_node_token` | Exact Wiki node token |
| `remote_document_token` | Exact Docx document identifier, unique among managed pages |
| `managed_body_block_id` | Exact body block Iris owns |
| `linked_document_source_id` | Exact ingested source once it is resolved |
| `current_remote_revision_id` | Last reconciled Feishu document revision |
| `current_body_content_hash` | Last reconciled canonical managed-body hash |
| `expected_resync_content_hash` | Proposed hash while resynchronization is pending |
| `state` | `active`, `updating`, `resync_required`, `reconciliation_required`, `blocked`, or `retired` |
| `version` | Optimistic concurrency version |
| timestamps | Creation and transition timing |

The row is created only when the publication response and follow-up readback prove:

- the Wiki node and Docx document tokens;
- the exact created body block identifier;
- the exact resulting document revision;
- the normalized hash of the managed body;
- the publication policy and authorization group.

If exact identity cannot be proven, the original publication may still complete successfully, but no managed-page row is created and the page is not update-eligible.

### 7.2 No automatic legacy adoption

Existing publications are not inferred to be managed merely because their content looks similar or they were created by the same app. A future explicit adoption workflow may inspect and attest legacy pages, but this increment does not include it.

This rule keeps migration deterministic and prevents a schema rollout from silently broadening write scope.

### 7.3 Source binding

After the published page is ingested, the system resolves its `document_source` by exact canonical identity:

- canonical Wiki node token where the connector models the source as Wiki; or
- exact Docx document token where the connector models the source as Docx.

The resolver may use a live Feishu token resolution call, but it may not use title or body similarity. Once resolved, `linked_document_source_id` is versioned and may change only through an explicit reconciliation transition.

Only a conflict candidate whose exact target source is this linked source may create an update binding.

### 7.4 Canonical body observation

The ordinary `document_snapshots.content_hash` may represent a connector-normalized whole document rather than the exact managed body block. It must not be compared directly with the draft body hash unless the connector contract proves they use the same bytes and normalization.

For a linked managed source, ingestion records a `managed_knowledge_snapshot_observation` tied to the successful snapshot. It contains:

- managed-page ID and version;
- document-snapshot ID;
- observed remote document revision;
- observed managed body block ID and block type;
- canonical managed-body hash;
- observation timestamp and adapter version.

The canonical managed-body hash uses one shared normalizer for publication capture, update preflight, update request construction, remote readback, and ingestion observation. The normalizer is deterministic, versioned, and covered by cross-adapter contract tests.

If ingestion cannot observe the exact expected block, revision, or supported block type, the snapshot may remain useful for ordinary document administration but cannot reactivate the managed page.

### 7.5 Append-only managed-page events

Add immutable events for:

- page registration;
- source linked;
- update claimed;
- remote outcome confirmed;
- resync completed;
- reconciliation required;
- page blocked, retired, or reactivated.

The mutable projection provides efficient gating; the events preserve audit history.

## 8. Update Target Binding

Add `knowledge_publication_update_targets`, keyed to an exact draft revision. It records:

- draft ID, revision, and optimistic version;
- knowledge-conflict candidate ID and version;
- managed-page ID and version;
- linked document-source ID;
- target document-snapshot ID, snapshot hash, and source version when available;
- remote document token and managed body block ID;
- expected remote revision and current body hash;
- proposed body content hash;
- authorization group and target policy version;
- deterministic operation key;
- creation timestamp.

The binding is created transactionally with the eligible conflict draft revision. Eligibility requires exactly one active managed page matching the conflict target source and authorization group.

If zero or multiple pages match, the draft is not update-bound. Existing publish-new behavior remains available, but the card and proposal must describe it as publication, not update.

If an update binding exists, the group card must say that confirmation authorizes a proposal to replace the existing managed page and must include a safe Feishu link and metadata-only target identity. The binding is immutable for that draft revision.

A new draft revision requires a new target binding and new confirmation. A target that changes after binding makes the old action stale; it does not silently retarget.

## 9. Action Proposal Generalization

### 9.1 Action types

Generalize `ActionProposal.actionType` to:

```ts
type ActionProposalActionType =
  | "publish_knowledge_draft"
  | "update_knowledge_publication";
```

The proposal lifecycle remains shared:

- `pending_approval`
- `approved`
- `executing`
- `succeeded`
- `failed`
- `cancelled`
- `expired`
- `reconciliation_required`

The subject remains the exact knowledge draft. Action-specific target and execution details live behind dedicated repositories instead of adding more publication-specific branches to the already large Postgres action-proposal repository.

### 9.2 Planner routing

The planner routes an eligible, confirmed draft as follows:

- exact active update target exists: create only `update_knowledge_publication`;
- no update target exists: retain existing `publish_knowledge_draft` planning;
- target exists but is stale, blocked, already updating, or unresolved: create neither action and record a content-free planning reason.

The same draft revision may never have active publish and update proposals simultaneously.

The operation key includes at least:

- action type;
- draft ID and revision;
- managed-page ID and version;
- expected remote revision;
- proposed content hash.

### 9.3 Proposal requirements

The existing risk-policy machinery remains authoritative. A typical conflict update requires:

- prior group confirmation of the exact update-bound draft;
- an eligible designated owner or Iris administrator;
- full-text OAuth review of the exact proposed body;
- approval of the exact attestation fingerprint.

Policy may require a stricter reviewer or classify a page as non-updatable. The new action does not weaken existing publication rules.

## 10. Review and Approval Binding

The full-text review surface remains OAuth-protected. List endpoints and cards remain metadata-only.

The update review shows:

- action type: update existing Iris-managed page;
- target Wiki link and stable internal page ID;
- draft revision and complete proposed body;
- current reconciled revision and before-content fingerprint;
- policy, authorization group, risk level, and required approver role;
- a clear warning that the single managed body block will be replaced.

The review attestation fingerprint includes all execution-critical fields:

```text
action_type
proposal_id + proposal_version
draft_id + draft_revision + proposed_content_hash
conflict_candidate_id + candidate_version
managed_page_id + managed_page_version
document_source_id + target_snapshot_id + target_snapshot_hash
remote_document_token + managed_body_block_id
expected_remote_revision + current_body_content_hash
target_policy_id + target_policy_version
authorization_group_id
```

Any change to these fields invalidates the approval. Approval never authorizes “whatever is current at execution time.”

## 11. Runtime and Rollout Controls

Add a durable runtime capability:

```text
updateManagedKnowledge
```

It defaults to `false` globally and for all groups. Execution requires:

```text
global enabled
AND group enabled
AND writeKnowledgeBase enabled
AND updateManagedKnowledge enabled
```

Use an additional deployment-level feature flag and explicit group allowlist for the first pilot, for example:

- `IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED=false`
- `IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST=`

Startup and readiness fail closed when the feature is enabled but migrations, Feishu write credentials, review dependencies, or allowlist configuration are missing.

Disabling either write capability prevents new claims. An already claimed remote outcome is still reconciled to a durable state; disabling the capability must not abandon an uncertain write.

## 12. Freshness Barrier

### 12.1 Why a dedicated barrier is required

Remote mutation and local reindexing are not atomic. Without a barrier, answers could continue using the old successful snapshot after the Feishu page has changed.

Permission state is not the right mechanism: the source may remain readable while its indexed content is temporarily stale. The managed-page state therefore acts as a dedicated content-availability barrier.

### 12.2 Barrier semantics

When an executor successfully claims an update, a short transaction:

1. locks the managed page;
2. rechecks the proposal, binding, page version, and absence of another unresolved update;
3. creates the execution attempt;
4. changes the page from `active` to `updating`;
5. commits before any Feishu call.

Fragment search and knowledge-draft search exclude a linked source whenever its managed page is in:

- `updating`;
- `resync_required`;
- `reconciliation_required`;
- `blocked`;
- `retired`.

This exclusion happens before ranking so unavailable content cannot influence answer generation.

The final answer-source verifier also checks the managed-page barrier. A reply prepared before the transition must produce the existing safe source-changed/unavailable behavior rather than send stale claims.

### 12.3 Barrier release

- Failure proven to occur before remote request dispatch: restore the page to `active` if all bound versions still match.
- Confirmed remote success: move the page to `resync_required` and store the expected new hash and revision.
- Uncertain remote outcome or local commit failure after possible remote success: move to `reconciliation_required`.
- Confirmed external deletion or permission loss: move to `blocked` or `retired` according to the reconciler result.
- Successful exact resync: move to `active` only after the latest successful snapshot has a managed-body observation whose block, revision, and canonical body hash match the expected result and whose source identity still matches.

The barrier cannot be released merely because a sync job returned success. Content identity must match.

## 13. Execution Flow

The executor processes approved update proposals in this order:

1. Check deployment, global, group, write, and update capability gates.
2. Load proposal, approval, review attestation, draft revision, conflict candidate, update target, managed page, source, snapshot, policy, and permission state.
3. Claim the action and activate the freshness barrier in a short transaction.
4. Outside database locks, read the live Feishu document and exact managed block.
5. Revalidate:
   - document and block still exist;
   - block is still the supported plain-text type;
   - live revision equals the bound expected revision;
   - normalized live block hash equals the bound current hash;
   - source and Wiki permission are still allowed;
   - authorization group and target policy are still valid;
   - proposed body satisfies size and content constraints.
6. Send one exact block replacement using the bound revision and deterministic client token.
7. Classify the remote outcome.
8. Persist confirmed success, failure, or reconciliation state in a short transaction.
9. On success, enqueue exact source resynchronization and keep the page unavailable.
10. After the expected snapshot is indexed, reactivate the page and publish a metadata-only result notification.

The executor never holds a database row lock across live permission checks, document reads, mutations, or resynchronization.

## 14. Feishu Mutation Contract

Use Feishu Docx batch update:

```text
PATCH /open-apis/docx/v1/documents/:document_id/blocks/batch_update
```

The request must:

- address the exact `remote_document_token`;
- include the exact bound `document_revision_id`;
- include a deterministic `client_token` within Feishu constraints;
- contain one update-text-elements operation against `managed_body_block_id`;
- replace the full managed body with the reviewed draft body;
- remain within both Iris draft limits and Feishu request limits;
- use bounded connect, response, and total deadlines.

Execution must never pass a wildcard revision such as `-1`.

Before mutation, the Feishu client reads the current block and revision. After mutation, it performs bounded readback when the response does not prove the resulting state completely.

The client returns a typed result that distinguishes:

- confirmed applied;
- confirmed not applied and retryable;
- confirmed rejected as stale, forbidden, missing, or invalid;
- outcome unknown.

Raw response bodies and document text are not logged.

## 15. Durable Update Records

### 15.1 Execution attempts

Add `knowledge_publication_update_executions` with one row per attempt. Recommended fields include:

- proposal and managed-page identity/version;
- update-target identity;
- attempt number and state;
- deterministic client token or its stable non-secret operation identifier;
- request fingerprint;
- expected revision and before/after hashes;
- remote request dispatch timestamp;
- typed outcome classification;
- response revision when proven;
- reconciliation reason code;
- actor and timestamps.

Execution states include:

- `claimed`
- `preflight_failed`
- `remote_request_dispatched`
- `outcome_unknown`
- `remote_applied`
- `resync_required`
- `succeeded`
- `failed`
- `reconciliation_required`

State transitions append immutable execution events. Mutable state is only a projection.

### 15.2 Successful update facts

Add an immutable `knowledge_publication_updates` success fact containing:

- originating publication;
- proposal, approval, draft revision, and conflict candidate;
- managed page and source;
- before and after remote revisions;
- before and after normalized content hashes;
- executor identity and completion timestamp.

Document bodies are not duplicated into the success fact.

### 15.3 One unresolved update per page

A partial unique constraint prevents more than one active or unresolved update execution for the same managed page. Another proposal may wait, become stale, or require a new draft; it may not overtake an update awaiting resync or reconciliation.

## 16. Outcome Classification and Reconciliation

### 16.1 Proven before-dispatch failure

Validation, authorization, or client-construction failures before request dispatch are safe failures. The proposal records a typed failure. The barrier may return to `active` if the target is still unchanged.

### 16.2 Explicit remote rejection

Explicit stale-revision, forbidden, not-found, or invalid-block responses are terminal for the bound action:

- stale revision or body mismatch: fail as stale and require a new draft/binding;
- permission loss: fail and block until permission reconciliation;
- document or block missing: fail and retire or block the managed page;
- invalid request/content: fail without automatic mutation retry.

### 16.3 Explicit transient response

For explicit rate-limit or server-error responses, perform bounded backoff. Before a retry, read back the exact block. Retry only when the old hash and expected revision prove the update was not applied. Reuse the same deterministic client token.

### 16.4 Timeout or connection loss after dispatch

Mark the attempt `outcome_unknown`; do not blindly retry. Read back the exact document and block:

- proposed hash observed: complete remote success and proceed to resync;
- old hash and old revision observed: bounded retry with the same client token is allowed;
- another hash, unexpected revision, missing block, or unreadable target: enter `reconciliation_required`.

### 16.5 Local commit failure after remote success

If Feishu success is confirmed but the local success transition cannot commit, preserve or recreate an outcome-unknown marker keyed by the deterministic operation identity. The page remains barred and the reconciler reconstructs state through remote readback.

### 16.6 Reconciler

A bounded background reconciler processes outcome-unknown and reconciliation-required executions. It uses remote revision and block hash, never content similarity, to decide:

- applied, proceed to resync;
- not applied, terminal failure or safe retry;
- externally modified, remain blocked for operator review;
- missing/forbidden, block or retire.

No automatic reconciler path may overwrite a human edit discovered after approval.

## 17. Resynchronization and Reactivation

Confirmed remote success enqueues an exact sync for the linked document source. The managed page remains `resync_required` while ingestion runs.

Reactivation requires all of the following:

- the source identity is still bound to the same managed page;
- a newer successful snapshot exists;
- the snapshot has a managed-body observation for the exact block and resulting revision;
- that observation’s canonical body hash equals `expected_resync_content_hash`;
- the source permission state permits use;
- the update execution and proposal are durably marked successful or ready-to-complete;
- no newer unresolved managed update exists.

After reactivation:

- fragment search may use the new snapshot;
- future conflicts bind against the new page version and revision;
- the result notification may link to the page and state the action outcome without including the body.

If resync repeatedly fails or returns a different hash, the page stays unavailable and enters reconciliation; old indexed content is not reopened as a fallback.

## 18. Concurrency and Locking

Use optimistic versions plus short row locks. The canonical mutation lock order is:

1. managed knowledge page;
2. update target / conflict candidate;
3. action proposal;
4. update execution.

Code paths that require more than one of these records must use this order. Remote calls never occur while locks are held.

Required race behavior:

- **Two executors claim one proposal:** one wins; the other observes the durable claim.
- **Two proposals target one page:** the unresolved-page uniqueness rule allows only one to proceed.
- **Draft revised after confirmation:** old binding and approval become stale.
- **Page edited by a human before execution:** revision/hash preflight fails; Iris does not overwrite.
- **Answer prepared before update claim:** send-time barrier prevents delivery.
- **Answer searched after claim:** source is excluded before ranking.
- **Capability disabled mid-flight:** no new claim; the in-flight attempt is still reconciled safely.
- **Sync completes before success projection commit:** reactivation waits for durable execution state and expected hash.

## 19. APIs and Admin Surface

Add internal-token, operator-audited endpoints for:

- listing managed pages with metadata-only eligibility and state;
- viewing one managed page’s identifiers, versions, and event history without body text;
- listing update executions and typed outcome states;
- requesting reconciliation of an eligible unresolved execution;
- blocking, retiring, or reactivating a page after explicit checks.

The Admin UI shows:

- action type and proposal lifecycle;
- managed page, source link, and policy;
- current/expected revision and fingerprint metadata;
- freshness-barrier state;
- resync and reconciliation status;
- authorized operator actions.

Full draft text remains available only on the existing OAuth review route. List views, readiness, logs, and agent observations remain content-free.

## 20. Observability and Readiness

Add content-free metrics for:

- eligible managed pages by state;
- update targets created, skipped, or stale by reason;
- proposal claims and terminal states;
- Feishu outcome classification;
- barrier duration;
- resync latency and mismatch count;
- outcome-unknown and reconciliation queue depth;
- send-time answers blocked by the freshness barrier.

Readiness remains healthy while the feature is disabled. When enabled for a pilot group, readiness reports not-ready if required schemas, credentials, background workers, or group configuration are unavailable.

Readiness must surface unresolved outcome-unknown executions as a distinct degraded reason. It must not expose body content, tokens, or raw remote errors.

## 21. Security and Privacy

- Reuse the existing OAuth review boundary for complete proposed text.
- Reuse internal-token and operator-identity requirements for metadata and reconciliation endpoints.
- Never expose Feishu access tokens, document bodies, or raw rich-text payloads in logs.
- Treat document and block tokens as sensitive operational identifiers; expose them only where necessary for authorized operators.
- Revalidate both source-read and target-write authorization immediately before execution.
- Use safe Feishu links rather than rendering untrusted titles or content as HTML.
- Enforce existing draft length limits and Feishu request limits before request construction.
- Store hashes and typed reason codes instead of raw before/after bodies in operational tables.

## 22. Test-Driven Implementation Boundaries

Implementation starts with failing tests and is split into independently verifiable slices:

1. **Schema and repositories**
   - managed page registration and immutable events;
   - update target and execution constraints;
   - one unresolved update per page;
   - migration rollback and startup compatibility.

2. **Publication capture**
   - exact block and revision capture for new publications;
   - successful publication without update eligibility when identity is incomplete;
   - no legacy auto-adoption.

3. **Conflict binding and proposal routing**
   - exact source/group match;
   - update card wording and confirmation binding;
   - exclusive update-versus-publish routing;
   - stale target creates no action.

4. **Review and approval**
   - action-specific fingerprint;
   - changed target/revision/hash invalidates review or approval;
   - metadata-only list behavior.

5. **Freshness barrier**
   - source excluded before answer ranking;
   - source excluded from knowledge-draft evidence;
   - send-time verifier blocks prepared replies;
   - barrier releases only on the defined terminal conditions.

6. **Feishu client and executor**
   - exact block and exact revision request;
   - deterministic client token;
   - permission, policy, revision, and hash revalidation;
   - no database lock across network calls;
   - existing publication executor regression coverage.

7. **Outcome handling**
   - proven before-dispatch failure;
   - explicit stale/forbidden/missing classification;
   - timeout readback applied/not-applied/ambiguous branches;
   - local commit failure after remote success;
   - no blind retry.

8. **Resync and concurrency**
   - expected managed-body observation reactivates page;
   - mismatched snapshot remains barred;
   - competing update, human edit, draft revision, and answer-send races.

9. **Admin, readiness, and privacy**
   - role and operator enforcement;
   - no body content in lists, logs, metrics, or observations;
   - disabled/enabled readiness matrix.

The full existing unit and integration suite must pass after every slice that changes shared action-proposal or retrieval behavior.

## 23. Controlled Feishu Pilot

The live acceptance pilot uses a dedicated allowlisted group and a fresh page created after managed-page capture is deployed.

Pilot sequence:

1. Publish a controlled Iris knowledge draft and prove its managed-page row contains exact node, document, block, revision, policy, and hash identity.
2. Sync that page and prove the exact document source is linked.
3. Introduce a controlled conflicting source in the same authorization group.
4. Trigger conflict detection and generate an update-bound draft.
5. Verify the group card explicitly identifies an existing-page update.
6. Verify no proposal exists before group confirmation.
7. Confirm the exact draft and verify one update proposal, not a publication proposal.
8. Review the full text over OAuth and approve as an eligible owner/admin.
9. Verify the freshness barrier activates before remote mutation.
10. Verify exactly one managed block changes and the Feishu revision advances.
11. Verify no neighboring document structure changes.
12. Verify the page remains unavailable until a matching snapshot is indexed.
13. Verify retrieval returns the new content only after reactivation.
14. Verify a control managed page and an arbitrary non-managed page are untouched.
15. Verify proposal, update, resync, and notification facts are durable and content-free.
16. Verify worker queues and dead-letter queues return to zero.

Automated acceptance additionally covers stale revision, revoked permission, duplicate claim, timeout after dispatch, mismatched resync, and concurrent human edit. Those branches do not require destructive live-pilot manipulation when the automated adapter proves them deterministically.

## 24. Acceptance Gates and Exit Condition

This increment is complete only when:

- all new tests pass;
- the full repository test suite passes;
- build, type-check, lint, and migration validation pass;
- existing publication and conflict controlled loops do not regress;
- the controlled Feishu pilot passes against one fresh eligible page;
- exact deployed image/tag/SHA evidence is recorded;
- no unresolved update execution, resync, reconciliation, or dead-letter work remains;
- the feature remains default-off outside the allowlisted pilot group;
- README/current-state/core-coverage documents are corrected to the verified deployed state.

Once these gates pass, development moves to the next missing core capability. Non-blocking robustness ideas are recorded rather than extending this module indefinitely.

## 25. Follow-Up Backlog

Deferred work includes:

- explicit legacy managed-page adoption;
- arbitrary block-aware document editing;
- multi-block and rich-content updates;
- title, move, archive, and delete actions;
- cross-group write delegation;
- formal Feishu Task creation;
- persistent multi-step execution plans and broader audit workflows;
- bulk update proposals;
- richer operator diff visualization;
- automated policy suggestions from pilot evidence.

Each requires its own design and approval boundary.

## 26. Design Decision Record

The approved direction is intentionally narrower than “edit the original document” in general:

- **Selected:** update only newly tracked Iris-managed Wiki pages with exact single-block identity.
- **Reason:** it closes a real whitepaper loop while maintaining provable intent, concurrency, and recovery boundaries.
- **Rejected for this increment:** inferred block matching, arbitrary rich-doc patches, silent legacy adoption, and automatic fallback to publication.
- **Next gate:** review and approve this committed design before implementation planning begins.
