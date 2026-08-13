# Iris Knowledge Conflict Candidate And Update Draft Design

Date: 2026-08-13  
Status: Direction approved in conversation on 2026-08-13; written spec awaiting review  
Product: Iris  
Implementation baseline: `origin/master@64305009bf19cf289740d1a23316ef48d09f53b5`  
Constitution: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

## 1. Problem And Current Evidence

The whitepaper requires Iris to expose conflicts between newer group conclusions and the current
Feishu knowledge base, identify both sides, suggest an update, and request confirmation or review.
The current production baseline does not implement that loop.

The repository already contains most of the downstream governance foundation:

- grounded answering now separates evidence planning from answer rendering and accepts stable
  conversation, memory, thread, document, and action references;
- group memories preserve source-message evidence, category, confidence, status, and correction
  history;
- authorized Wiki documents preserve source, snapshots, fragments, usage policy, and live Feishu
  permission checks;
- `KnowledgeDraftOriginKind` already includes `knowledge_conflict`;
- knowledge drafts can bind conversation-message, discussion-thread, action-item, and document-source
  evidence;
- group confirmation, OAuth full-text review, approval, publication, and result reporting already
  form a governed downstream path;
- proactive delivery already proves the product rule that unsolicited group messages require an
  operator-reviewed candidate and runtime permission.

What is missing is the evidence-first bridge between a durable group conclusion and an inconsistent
authorized knowledge snapshot. Existing memory-extraction `conflict` candidates compare new memory
against old group memory; they do not compare group conclusions with the knowledge base and cannot
be treated as knowledge-conflict evidence.

## 2. Scope Decision And Decomposition

This design implements the first independently usable knowledge-conflict subproject:

```text
eligible current-group conclusion
  -> authorized knowledge retrieval
  -> structured conflict classification
  -> durable, reviewable conflict candidate
  -> operator-approved bounded group card
  -> group-member confirmation
  -> knowledge_conflict update draft
  -> existing confirmation, review, approval, publication, and result path
```

It also makes an open, evidence-current candidate available to grounded answering so Iris exposes the
known conflict rather than answering with false certainty when the same memory and document source
are present in the answer window.

The current publisher creates a new Wiki page. It does not edit an existing page in place. Feishu's
current Docx APIs support revision-bound block updates and idempotent client tokens, but adding that
behavior requires a second high-impact action type, exact remote-revision validation, a new executor,
and outcome-unknown reconciliation. That is a separate subproject and is not hidden inside this
design.

The accepted outcome of this design is therefore a reviewed update draft entering the existing
publication path. It must not be described as an in-place replacement of the conflicting page.

## 3. Alternatives Considered

### 3.1 Selected: event-driven, evidence-first candidate

Iris claims eligible active group memories from a durable Postgres scan inbox, retrieves matching
authorized Wiki evidence, classifies the pair, stores a version-bound candidate, and uses the
existing human-reviewed proactive pattern before sending a conflict card.

This approach is asynchronous, traceable, default-off, and independent of answer latency. It also
creates an authoritative candidate that answer-time planning can consult.

### 3.2 Answer-time detection only

The grounded-answer planner could classify conflicts on every question. This is faster to add but
increases latency and cost, produces no durable governance fact, and misses conflicts until somebody
asks the right question. Model output from one answer also cannot directly create an update draft.

### 3.3 Scheduled full-knowledge-base comparison

A broad scanner could repeatedly compare all group memory with all Wiki content. It offers wide
coverage but has poor first-release cost, noisy matching, weak event identity, and a large permission
surface. It should be considered only after the event-driven pilot supplies precision evidence.

## 4. Architectural Boundaries

The implementation remains inside the TypeScript modular monolith.

New modules under `apps/core/src/knowledge-conflicts/` own:

- scan eligibility and durable claim/retry state;
- authorized Wiki evidence retrieval for one group-memory subject;
- strict model-output validation;
- conflict candidate facts, evidence, events, and state transitions;
- Admin API governance and bounded card rendering;
- card callback handling and conversion to a knowledge draft;
- answer-time lookup of already established, current conflicts.

Existing modules retain their authority:

- group-memory repositories own memory facts and correction/supersession;
- document repositories and Permission Guard own source eligibility and live read permission;
- grounded-answer planning owns the visible answer state;
- knowledge-governance repositories own drafts and evidence validation;
- knowledge-card runtime owns draft presentation and group confirmation;
- Approval & Action Layer owns publication approval and execution;
- Feishu Gateway transports callbacks but makes no conflict or authorization decision.

The Python memory extractor is not modified to declare knowledge conflicts. The detector may use the
existing OpenAI-compatible Core model client because this phase is a bounded product decision over
already selected evidence. It produces a candidate only; it receives no Feishu write authority.

## 5. Eligibility And Durable Scan Inbox

The first release scans only active, group-scoped memories with:

- category `decision`, `workflow`, or `term`;
- confidence at least `0.80`;
- importance at least `3`;
- at least one current conversation-message evidence reference;
- a source group in the explicit knowledge-conflict allowlist.

`summary`, `person`, `preference`, `action`, and general `project` memories are excluded from the
first pilot because they frequently contain descriptive or subjective text rather than a stable
company rule. Expanding the category set requires pilot precision evidence.

A Postgres-backed inbox discovers eligible active memories by anti-joining them against existing
scan rows. This covers extractor, operator-created, and corrected memories without placing a
non-atomic Redis enqueue after memory persistence. A correction creates a new memory fact and is
therefore independently eligible; superseded or deleted memories are not claimable.

Each scan row records:

- memory ID, group ID, and memory `updatedAt` fingerprint;
- status `pending`, `processing`, `retry`, `completed`, or `dead_lettered`;
- bounded attempt count, next-attempt time, lease owner, and lease expiry;
- terminal outcome `conflict`, `no_conflict`, `insufficient_evidence`, `superseded`, or
  `permission_blocked`;
- content-free failure classification and timestamps.

Claims use `FOR UPDATE SKIP LOCKED`. Expired processing leases are recoverable. Retry attempts are
bounded; exhausted rows enter a visible dead-letter state with explicit replay and delete APIs. A
single failed subject cannot permanently block later memories.

## 6. Knowledge Retrieval And Permission Ordering

The scanner embeds only the normalized memory content. It searches only:

- `authorized_wiki_document` sources;
- sources currently `synced` and locally `readable` or `unknown`;
- sources whose `canUseForKnowledgeDrafts` policy is true;
- authorized spaces available to the source group under the current publication/knowledge policy.

Search returns a bounded candidate window grouped by document source. At most three fragments per
source and twelve fragments total enter conflict planning. Retrieval reuses source-aware selection,
but uses a knowledge-governance purpose so answering policy cannot silently authorize draft use.

Before any fragment text enters the detector, Core runs the existing live Feishu permission guard.
A denial, timeout, missing credential, unsupported source, or policy-read failure excludes the text
and records `permission_blocked` or a retryable infrastructure outcome. Cached permission never
authorizes conflict planning.

The first release uses a conservative, programmatic chronology rule. The group conclusion is called
"newer" only when every conversation message used as group evidence was sent after the target
knowledge snapshot's `fetchedAt`. A sync timestamp is not treated as the remote document's edit time,
and an optional Feishu revision ID is not converted into a timestamp. If this ordering cannot be
proved, the detector may record `insufficient_evidence` but may not create a knowledge-conflict
candidate. This intentionally reduces recall to preserve the whitepaper's evidence claim.

Immediately before candidate persistence, Core re-reads:

- the memory and its active status;
- all referenced conversation messages and tombstones;
- the document source policy and `updatedAt`;
- the current snapshot ID, source version when available, and content hash;
- live Feishu read permission.

Any change makes the plan stale. Stale work is not persisted as a conflict candidate.

## 7. Structured Conflict Detector

The detector receives one eligible group-memory subject, its source-message evidence, and selected
authorized Wiki fragments. Every input field is untrusted data, not an instruction.

It returns strict JSON equivalent to:

```json
{
  "outcome": "conflict",
  "subject": "The exact policy, workflow, or term being compared",
  "knowledgeBaseStatement": "The current synchronized knowledge statement",
  "knowledgeBaseCitationRefs": ["D1"],
  "groupConclusionStatement": "The newer group conclusion",
  "groupCitationRefs": ["M1", "C1"],
  "difference": "The material incompatibility",
  "suggestedUpdate": "A bounded replacement or amendment suggestion",
  "targetDocumentRef": "D1",
  "confidence": "high"
}
```

Allowed outcomes are `conflict`, `no_conflict`, and `insufficient_evidence`.

Programmatic validation enforces:

- exactly the documented fields and bounded strings/lists;
- every reference exists in the current allowed input;
- `conflict` has at least one document reference, one group-memory reference, one source-message
  reference, a selected target document, a material difference, a suggestion, and `medium` or
  `high` confidence;
- the target reference belongs to an `authorized_wiki_document` source allowed for knowledge drafts;
- `no_conflict` contains no difference, target, or suggested update;
- `insufficient_evidence` contains a bounded missing-evidence explanation and no update suggestion;
- duplicate, mixed-subject, malformed, unknown-field, oversized, or out-of-window references fail;
- one structurally invalid response may be retried once; a second invalid response is a provider
  failure and cannot create a candidate.

Whether natural-language claims are semantically contradictory is not falsely represented as a
deterministic schema guarantee. The application constrains evidence and structure; production-shaped
tests and the real pilot measure semantic precision.

## 8. Conflict Candidate Fact Model

`knowledge_conflict_candidates` stores one immutable detection intent and a small mutable status
projection:

- stable candidate ID and idempotency key;
- group ID and group-memory ID;
- detector contract version and input fingerprint;
- subject, current knowledge statement, group conclusion, material difference, and suggested update;
- target document source ID, snapshot ID, optional source version, source `updatedAt`, and content
  hash;
- confidence;
- status `pending_review`, `dismissed`, `approved_for_delivery`, `delivered`, `draft_created`, or
  `superseded`;
- candidate version and timestamps.

The idempotency key hashes the memory ID, memory fingerprint, target snapshot ID, target content hash,
and detector contract version. Replaying identical detection returns the existing candidate. Reusing
the identity with different content is an operation conflict.

Separate append-only tables store:

- exact conversation-message, memory, document-source, snapshot, fragment, and content-hash evidence;
- candidate lifecycle events with actor, operation key, from/to version, reason code, and timestamp;
- delivery outbox state and Feishu message identity;
- group-card interaction facts and the resulting knowledge draft ID.

No table stores hidden chain-of-thought, model prompts, full denied content, access tokens, or secrets.
Candidate summaries are bounded. Full source text remains in its existing authoritative repository.

When the memory is superseded/deleted, the source policy or snapshot changes, or permission is
revoked, any nonterminal candidate becomes `superseded`. A previously created draft keeps its own
evidence validator and will independently fail closed if the evidence is no longer current.

## 9. Governance And Group Interaction

Detection never sends a message automatically.

Admin Console and internal APIs expose group-scoped, content-bounded candidate summaries. An
operator can:

- inspect the two statements, difference, target source metadata, evidence identities, and current
  validation state;
- dismiss the candidate with a reason;
- approve one bounded delivery to the source group.

Approval requires the candidate version to match and all evidence to remain current. Delivery also
requires the existing global/group runtime gates, `proactiveSpeech`, `retrieveKnowledgeBase`, and
`generateKnowledgeDrafts`. Disabling any gate before the external send prevents delivery.

The Feishu card shows:

- that Iris found a possible conflict, never a proven official update;
- the current synchronized knowledge statement and snapshot/version label;
- the newer group conclusion;
- the material difference;
- the proposed update;
- source links that are currently safe to show;
- actions `生成更新草稿` and `不是冲突`.

The callback value contains only candidate ID, candidate version, group ID, action, and a bounded
idempotency nonce. Actor identity comes from verified Feishu callback context, not card data.

Before either action commits, Core checks current group membership, runtime gates, candidate version,
delivery binding, and evidence freshness. `不是冲突` dismisses the candidate and records feedback.
`生成更新草稿` creates exactly one draft with:

- `originKind: "knowledge_conflict"`;
- the source group;
- medium risk for the first release;
- title and body that explicitly separate current knowledge, newer group conclusion, and proposed
  update;
- exact conversation-message, group-memory, and target document-source evidence;
- the existing publication target policy for that group;
- the confirming member as the initial reviewer, while existing owner/admin publication approval
  remains authoritative.

The draft is then presented through the existing knowledge-card flow. The conflict callback cannot
approve publication or write to Feishu Wiki.

## 10. Answer-Time Conflict Exposure

Grounded answering may consult only already persisted, non-dismissed candidates whose evidence is
current and overlaps the answer window's exact memory and document-source identities.

The evidence-plan contract gains a `conflict` company-fact state. The evidence-planner model cannot
originate this state on its own. When an exact current candidate overlaps the answer window, the
orchestrator constructs the conflict plan deterministically from that persisted candidate and its
mapped evidence references. A valid conflict plan requires:

- at least one current group premise and one current document premise;
- the exact persisted candidate identity;
- no synthesized resolution;
- `medium` or `high` confidence;
- the current knowledge statement, newer group conclusion, and material difference.

For this state, `proposedAnswer` contains the bounded conflict explanation rather than a resolution,
`missingInformation` is empty, and `confidence` must match the candidate. Existing premise reference
ordering remains authoritative, and only `D*` premises can become visible document citations. The
answer receipt records the candidate ID as content-free metadata without changing the plan's public
JSON shape.

The renderer visibly labels the conflict, cites the document premise, describes the group conclusion
as group evidence rather than official knowledge, and offers the update-draft path. It cannot select a
winner, silently merge the statements, or increase confidence.

If the candidate is not current, does not overlap exact evidence, or its source becomes denied, it is
not injected. Ordinary `explicit`, `complete_inference`, `partial`, and `none` behavior remains
unchanged. Send-time permission revalidation remains final for document citations.

## 11. Failure Handling And Observability

- disabled feature or group outside the allowlist: no scan, retrieval, model request, candidate, or
  delivery;
- no relevant authorized Wiki evidence: scan completes as `insufficient_evidence`;
- provider transport/capacity error: bounded retry, then durable retry/dead-letter policy;
- invalid detector response twice: retryable provider failure without candidate creation;
- memory/source/snapshot/version change: supersede or complete stale with no card;
- permission denial or permission-check failure: no denied text enters the detector or card;
- Admin approval race: optimistic version conflict, no duplicate delivery;
- Feishu send outcome unknown: durable reconciliation state, never blind retry;
- duplicate callback: exact replay returns the existing result; changed intent under the same key is
  rejected;
- draft creation succeeds but card presentation fails: the stable draft identity permits safe retry
  without creating a second draft;
- any existing publication failure continues through the current failed/reconciliation path.

Status and readiness expose content-free counts for pending, processing, retry, dead-lettered,
pending-review, approved, delivery-blocking, outcome-unknown, and stale candidates. Metrics may include
outcome and feedback counts but not source bodies, group conclusions, prompts, or actor open IDs.

## 12. Runtime And Rollout Controls

The feature is production-default-off.

It requires:

- `IRIS_KNOWLEDGE_CONFLICT_ENABLED=true`;
- a non-empty explicit `IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST`;
- Database, model, embedding, document retrieval, Permission Guard, knowledge-draft, knowledge-card,
  action-approval, and Feishu card dependencies;
- existing runtime capabilities appropriate to each stage.

Startup never resumes external delivery from a stale in-memory decision. Durable candidate/outbox
state is revalidated against live runtime controls after every restart. Readiness fails closed when
the feature is enabled but a required dependency, migration, worker, allowlist, or reconciliation
surface is missing.

## 13. Testing Strategy

Implementation is test-driven.

### 13.1 Eligibility and scan lifecycle

- only eligible active decision/workflow/term memories enter the inbox;
- corrected memory creates a new scan identity and superseded memory is skipped;
- allowlist and runtime disablement prevent reads and model calls;
- claims, lease recovery, retry, dead-letter, replay, and duplicate scans are deterministic;
- provider failure does not lose or duplicate work.

### 13.2 Retrieval and permission

- search includes only authorized Wiki sources usable for knowledge drafts;
- one noisy page cannot consume the evidence window;
- denied/stale/blank fragments never enter detector input;
- permission and policy changes between retrieval and persistence prevent a candidate;
- target document, snapshot, source timestamp, version, and content hash are exact.

### 13.3 Detector contract

- valid conflict/no-conflict/insufficient results pass;
- missing group or document evidence, unrelated-subject substitution, invalid target, duplicate refs,
  malformed JSON, unknown fields, and oversized content fail;
- prompt-injection text inside memory, messages, or documents cannot change the schema or authorize
  actions;
- one invalid response retries once and a second invalid response fails closed.

### 13.4 Governance and draft conversion

- detection alone never calls Feishu;
- only exact-version operator approval creates one delivery intent;
- runtime disablement, nonmembership, stale evidence, or permission revocation blocks callbacks;
- `生成更新草稿` creates one medium-risk `knowledge_conflict` draft with exact evidence and then
  uses the existing card flow;
- duplicate callbacks are idempotent and conflicting callbacks are rejected;
- `不是冲突` suppresses the exact candidate without suppressing unrelated subjects.

### 13.5 Answer behavior

- an exact open candidate forces visible conflict treatment when its evidence overlaps the answer;
- the answer states both sides and does not invent a resolution;
- unrelated or dismissed candidates do not affect the answer;
- document citation and send-time permission revocation remain fail closed;
- every pre-existing evidence state and direct-task route remains green.

### 13.6 Repository gates

Focused Core tests, Postgres integration tests, typecheck, build, Python tests, pilot/readiness tests,
Compose validation, and `git diff --check` must pass before any live pilot.

## 14. Live Pilot Acceptance

Use one explicitly allowlisted pilot group and one controlled authorized Wiki page. The fixture
contains an old statement with a known revision/snapshot. A new group conclusion provides a
deliberately incompatible replacement through normal group conversation.

Acceptance requires:

1. The eligible group memory creates exactly one durable scan and one conflict candidate.
2. Candidate evidence binds the exact group messages, memory, document source, snapshot, content
   hash, and source version when available.
3. An ordinary answer about the subject exposes the conflict instead of choosing one side.
4. No Feishu conflict card is sent before explicit operator approval.
5. The approved card shows both sides, the difference, the proposed update, and only readable source
   links.
6. A current group member's `生成更新草稿` action creates one exact `knowledge_conflict` draft and
   starts the existing confirmation/review path.
7. Duplicate card delivery and callback replay create no duplicate message or draft.
8. A no-conflict control produces no candidate, and a related-subject control does not substitute
   evidence.
9. Revoking source permission or changing the snapshot before answer, delivery, or callback prevents
   disclosure and draft creation.
10. Queues/inboxes, DLQs, outcome-unknown rows, card outboxes, and existing answer/publication queues
    return to their approved healthy state.

The pilot ends with all new feature flags disabled unless an explicit daily-pilot decision is made.
Any permission leak, unrelated-source substitution, duplicate side effect, or false-certainty answer
requires immediate rollback.

## 15. Exit Condition And Follow-Up Backlog

This subproject is complete only when its automated gates and the ten-step real Feishu acceptance
pass for an exact reviewed SHA. Code, migrations, feature flags, or an Admin Console panel alone do
not count as closure.

After closure, proceed to the next separately designed capability instead of indefinitely hardening
this module.

Follow-up work that is explicitly outside this implementation plan:

- governed in-place editing of the conflicting Feishu document using exact `revision_id`, idempotent
  `client_token`, a new high-impact action type, and outcome-unknown reconciliation;
- broad scheduled scans over all historical group memory;
- additional memory categories or cross-group conflict detection;
- automatic conflict resolution or model-selected official truth;
- bulk conflict review, analytics dashboards, and multilingual card variants;
- generic microservice extraction.
