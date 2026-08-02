# Iris Answer Source Citations Design

Date: 2026-08-02

Status: Approved direction for the internal 20-30 person MVP

## Goal

Make every Iris answer that uses Feishu documents or the authorized Feishu knowledge
base visibly distinguish its own sources from Feishu-native recommendations, while
preserving a durable, permission-aware receipt of exactly which indexed fragments were
available to that answer.

This closes a core whitepaper gap: Iris already retrieves permission-approved document
fragments, but the normal mention responder currently discards their provenance and
sends only model text. Feishu's native "related knowledge" UI is not Iris evidence and
must not be presented as such.

## Architectural Fit

The approved whitepaper keeps product behavior, permissions, and durable facts in the
TypeScript Core. This feature follows that boundary:

- retrieval and the real-time permission guard remain authoritative;
- the model writes only the answer body and never invents citation markers;
- Core deterministically selects, renders, persists, and delivers citations;
- Feishu remains a presentation and messaging adapter;
- PostgreSQL stores the answer delivery fact and bounded source provenance;
- the existing Redis raw-event worker and deterministic Feishu reply UUID continue to
  provide retry pressure and external idempotency.

No service split, generic event bus, or architecture-whitepaper amendment is required.

## Considered Approaches

### A. Deterministic citations plus a durable answer receipt

Core appends citations from live-permission-approved fragments and persists the final
reply plus its fragment provenance before calling Feishu.

Advantages:

- users can see which sources Iris actually supplied to the model;
- the model cannot fabricate or misnumber citations;
- retries reuse the exact prepared reply instead of sampling a different answer;
- operators can inspect source, snapshot, fragment, hash, and delivery state;
- permission changes remain fail-closed.

Trade-off:

- adds a small answer-delivery state machine and PostgreSQL facts.

### B. Model-authored inline citations

The prompt asks the model to emit markers such as `[1]` inside individual claims.

Advantages:

- richer claim-level reading experience;
- citations can appear next to the sentence they support.

Trade-offs:

- the model can omit, duplicate, or invent markers;
- validation and repair consume additional model quota;
- a valid marker still does not prove that the cited fragment supports the claim.

### C. Ephemeral link footer only

The responder appends links in memory and sends them without a durable receipt.

Advantages:

- smallest code change;
- fastest initial visual result.

Trade-offs:

- crashes and retries can make the stored execution evidence disagree with the reply;
- operators cannot reconstruct the exact answer/source relationship;
- does not satisfy the whitepaper's traceability requirement.

## Decision

Use approach A. Claim-level model-authored citations are explicitly deferred until the
deterministic source receipt has proven reliable in pilot usage.

## User Experience

When one or more document fragments entered the model context, Iris appends a plain-text
footer after the answer body:

```text
Iris 参考资料：
[1] [知识库] Quello Life Engine
https://tcnmvzw006k7.feishu.cn/wiki/...
[2] [群文档] 客户反馈看板
https://tcnmvzw006k7.feishu.cn/docx/...
```

Rules:

1. The label is always `Iris 参考资料` so it cannot be confused with Feishu's native
   `相关知识` presentation.
2. Sources are ordered by the first permitted fragment's retrieval rank.
3. Multiple fragments from the same document produce one visible citation.
4. At most three unique documents are displayed.
5. The source-kind labels are `知识库`, `群文档`, and `用户文档` for authorized wiki,
   group-visible, and user-submitted sources respectively.
6. The registered document title is used when available. The bounded fallback is
   `飞书文档`.
7. Only canonical HTTPS Feishu source URLs are rendered. An invalid stored URI fails
   the sourced delivery instead of being echoed to the group.
8. Answers with no allowed document fragments have no citation footer. Group memory,
   discussion-thread, action-item, and live-chat evidence are not presented as document
   citations in this slice.
9. The entire Feishu text reply remains within 8,000 characters. Citation text is
   reserved first; the answer body is truncated with the existing truncation marker if
   needed. A footer is never silently cut in half.

The footer means "these sources were supplied to this answer", not "every sentence is
fully entailed by these sources". The UI must not claim stronger evidence semantics.

## Retrieved Source Metadata

`RetrievedDocumentFragment` gains bounded retrieval-only metadata from the existing
`document_sources` join:

- `sourceTitle?: string`;
- `sourceType: RetrievedDocumentSourceType`, where the retrieval-facing values are
  exactly `feishu_wiki`, `feishu_group_document`, and `manual_upload`.

The repository maps the existing persisted `DocumentSourceType` values into this
retrieval-only vocabulary at the boundary. Persisted enum names never leak into the
renderer or durable answer-source trace.

The search query already joins `document_sources` for policy filtering, so this does
not add another read. Fragment list and indexing APIs remain unchanged.

The model prompt continues to receive the exact current fragment text and source URI.
The model does not receive citation numbering instructions in this slice.

## Deterministic Citation Renderer

A focused, pure citation module receives the answer body and `allowedFragments`. It:

- validates and normalizes source metadata;
- groups fragments by `documentSourceId`;
- preserves first-seen retrieval order;
- assigns visible citation ranks to the first three unique documents;
- returns the bounded rendered reply;
- returns an immutable trace for every allowed fragment, including fragments whose
  document did not fit in the three-item visible footer.

Each trace includes:

- prompt rank;
- optional visible citation rank;
- document source ID;
- document snapshot ID;
- fragment ID and chunk index;
- source type, URI, and title at answer time;
- fragment content hash and embedding profile ID.

The trace never copies fragment body text or the model prompt.

## Durable Answer Delivery Facts

Migration `0045_answer_source_citations.sql` introduces three focused tables.

### `answer_reply_deliveries`

One authoritative row per successfully generated ordinary Feishu mention answer:

- deterministic delivery ID;
- provider, incoming message ID, and chat ID;
- deterministic normal reply UUID;
- state: `prepared`, `sending`, `sent`, `permission_blocked`, or
  `reconciliation_required`;
- prepared rendered reply text while delivery is unresolved;
- SHA-256 rendered reply fingerprint retained after resolution;
- optional Feishu reply message ID;
- deterministic safe-notice UUID and optional safe-notice message ID;
- attempt count, version, and bounded timestamps.

`(provider, incoming_message_id)` is unique. Preparing the same semantic reply is
idempotent. A retry that proposes different text or different source facts conflicts
and fails closed instead of replacing the original prepared answer.

The full rendered reply is required only while the delivery is unresolved. A successful
`sent` transition clears it and retains its fingerprint. A blocked transition also
clears it so an answer based on revoked content is not left queued for later delivery.

### `answer_reply_source_traces`

Immutable rows for every fragment supplied to the model. The rows belong to one
delivery and contain only the bounded metadata listed above plus the initial permission
check timestamp. Update, delete, and truncate guards prevent historical mutation.

### `answer_reply_delivery_events`

Append-only lifecycle events record `prepared`, `send_started`, `sent`,
`permission_blocked`, `reconciliation_required`, `safe_notice_send_started`, and
`safe_notice_sent`. Metadata is bounded and content-free. It may contain counts and
document source IDs, but never answer text, fragment text, prompts, credentials, or
provider response bodies.

The delivery row is the current state; events are the audit history. This is not a
second conversation or knowledge state machine.

## Delivery And Retry Flow

For an ordinary @Iris answer:

1. The answer orchestrator retrieves fragments and applies the existing real-time
   permission guard before any fragment enters the model context.
2. The model produces only the answer body.
3. Core deterministically renders the citation footer and complete trace.
4. In one PostgreSQL transaction, Core prepares the delivery, immutable source traces,
   and `prepared` event.
5. Immediately before each external send attempt, Core rechecks every unique document
   source in the prepared trace through the same source-policy and Feishu live
   permission path.
6. If all sources remain allowed, Core records `send_started`, calls Feishu with the
   stored rendered text and deterministic UUID, then records `sent` with the returned
   message ID and clears prepared text.
7. If Feishu fails or times out, the delivery remains unresolved. The raw event fails
   and follows the existing retry/DLQ path. A retry loads the stored reply rather than
   calling the model again.
8. If a retry receives Feishu's existing idempotent reply, Core records the same
   delivery as sent without producing another answer.

Successfully generated ordinary answers without document sources still use the delivery
receipt, but skip the source-permission recheck and render no footer. Existing model
capacity, invalid-response, and blank-answer fallbacks remain deterministic direct
replies; they do not create answer deliveries or document source traces.

## Permission Revocation And Uncertain Outcomes

Permission denial and permission-check errors are both fail-closed.

If any prepared source is no longer readable before a send or resend:

- the sourced reply is not sent or resent;
- when no external answer attempt has started, Core records `permission_blocked` and
  clears the prepared reply text;
- Iris sends a separate content-free notice with a different deterministic UUID:
  `资料权限已变化，我没有发送原答案。请重新提问。`;
- the original source trace remains immutable for audit;
- denied source content and titles are never included in the notice.

If an earlier Feishu request timed out, its external outcome may be unknown. When a
later permission check blocks resending, Core records `reconciliation_required`, clears
the prepared reply text, and sends the same safe notice. This honestly represents the
possibility that Feishu accepted the first request even though Core did not receive its
response. The system never assumes that an unknown external outcome was either sent or
unsent.

The safe notice has its own deterministic UUID. If safe-notice delivery fails, the raw
event retries only that notice; it never regenerates or reloads the blocked sourced
answer. Successful notice delivery records its Feishu message ID.

## Runtime Composition

The answer-draft runtime exposes a narrow `AnswerSourcePermissionVerifier` that reuses
the same source registry, runtime capabilities, and Feishu permission checker as
retrieval. It accepts a chat ID and unique document source IDs and returns one
allow/deny/error decision per source.

The event-worker runtime owns the PostgreSQL answer-delivery repository and injects it,
the verifier, and the Feishu replier into the mention responder. Pool creation occurs
before responder composition so the repository shares the event worker's existing
database lifecycle.

The mention responder remains the coordinator for ordinary answers. Knowledge-draft
commands, document-submission commands, and existing bounded fallback replies retain
their current behavior and do not receive source footers.

## Failure Policy

- Delivery preparation failure: do not call Feishu; fail the raw event for retry.
- Source-trace conflict on replay: do not call the model or Feishu; fail closed and
  expose an operator-visible conflict.
- Permission denial or checker error: never send the sourced answer; record the blocked
  or reconciliation state and send only the safe notice.
- Feishu send failure or timeout: keep the prepared reply and retry through the current
  raw-event queue.
- Sent-state persistence failure after Feishu success: retry the same stored text with
  the same UUID; never resample the model.
- Citation rendering or URI validation failure: do not degrade to an uncited sourced
  answer; fail the raw event.
- Database source-receipt failure must never be treated as best-effort observability.
  The receipt is part of the answer contract.

## Inspection

Add a bearer-protected internal read endpoint:

`GET /internal/answer-replies/:provider/:incomingMessageId`

It returns delivery state, IDs, timestamps, fingerprints, source metadata, and delivery
events. It never returns prepared answer text, fragment text, prompts, credentials, or
provider response bodies. Caddy must continue returning 404 for this path publicly.

## Testing

Tests must prove:

- retrieved fragments include bounded source title and source type from the existing
  policy join;
- the renderer uses only allowed fragments, preserves rank, deduplicates documents,
  caps visible citations at three, traces all allowed fragments, and respects 8,000
  characters;
- no fragments means no footer;
- malformed or non-HTTPS source URIs cannot be echoed;
- prepare is transactional, idempotent for exact replay, and conflicts on changed
  reply or source facts;
- source traces and delivery events are append-only;
- a successful send clears prepared answer text and preserves its hash;
- a failed or timed-out send is retried with the exact stored reply and UUID without a
  second model call;
- permission is rechecked once per unique source before every external attempt;
- permission denial and permission-check error never send sourced text;
- an uncertain prior attempt plus later denial records reconciliation required;
- capacity and blank-answer fallbacks remain uncited and bounded;
- the internal endpoint is authenticated, content-free, bounded, and publicly hidden;
- existing mention, document, knowledge-draft, event-worker, and runtime-control tests
  remain green.

Production acceptance must use an authorized pilot wiki page with a unique marker. The
visible Iris reply must show `Iris 参考资料`, the correct title and Feishu URL, while
the private receipt identifies the exact snapshot and fragment. A separate revocation
case must prove that the marker is not emitted after access is removed. Event,
document, reindex, answer-delivery, and DLQ counts must finish at zero.

## Rollout

Deployment follows the existing fail-closed procedure:

1. require exact candidate SHA and successful Core/AI Worker checks;
2. set global and desired global enablement false and stop Caddy;
3. back up PostgreSQL and apply migration `0045`;
4. deploy Core and AI Worker images built from the same candidate SHA;
5. validate internal repository, permission, retry, and inspection gates;
6. start Caddy while Iris remains globally disabled and verify public internal routes
   are 404;
7. enable only the existing pilot group for real Feishu citation and revocation tests;
8. restore the approved pilot runtime state only after every gate passes.

Failure at any gate restores the previous runtime state and keeps the sourced-answer
feature closed. PR merge remains a separate explicit user decision.

## Out Of Scope

- model-authored claim-level citation markers;
- citations for live-chat messages, long-term memories, threads, or action items;
- a public citations dashboard;
- changing retrieval ranking, chunking, embedding, or source authorization rules;
- changing proactive speech or knowledge-publication behavior;
- a generic tool/event bus or a new microservice;
- automatic source summarization or citation-quality scoring.

Pilot feedback determines whether the next slice adds message and memory evidence or
claim-level validated markers. This slice ends when document and wiki citations are
visible, durable, permission-safe, and usable by the current 20-30 person team.
