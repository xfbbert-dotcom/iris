# Iris Proactive Feedback Loop Design

**Status:** Approved by the product decision to implement option A on 2026-07-27.

## 1. Purpose

Iris already discovers quiet open threads and overdue actions, lets an operator
approve a proactive delivery, and sends a bounded Feishu card. The remaining
whitepaper gap is the feedback loop after delivery: group members cannot tell
Iris whether a reminder helped, Iris cannot suppress reminders that the group
found irrelevant, and operators cannot inspect reminder quality.

This slice closes that gap for the first 20-30 internal users without expanding
the proactive-speech rollout. Production remains fail closed and proactive
delivery stays disabled until a separate real-Feishu acceptance gate passes.

## 2. Goals

- Add `有帮助` and `不相关` actions to every proactive reminder card.
- Acknowledge Feishu card callbacks quickly through the existing durable
  interaction queue.
- Accept feedback only from a current member of the exact destination group.
- Record feedback idempotently and audibly without exposing member identities in
  the Admin Console.
- Treat `不相关` as a bounded suppression signal for future reminders about the
  same semantic entity.
- Show group-level helpful, irrelevant, total, helpful-rate, and active
  suppression metrics in the existing proactive Admin Console panel.

## 3. Non-Goals

- No free-form feedback text.
- No model call, sentiment analysis, automatic threshold tuning, or cross-group
  learning from feedback.
- No automatic enablement of proactive speech.
- No permanent mute, per-user preference center, or company-wide ranking model.
- No redesign of the existing approval interaction queue or Admin Console.

## 4. Product Contract

### 4.1 Card interaction

The proactive card uses Chinese product copy and must identify the exact work item
without exposing raw evidence text. Immediately before rendering, Core resolves one
bounded subject label from the current conversation-state projection using the exact
candidate group ID, entity ID, entity type, and entity version. Thread reminders use
the thread title; overdue-action reminders use the action description. Core does not
copy this label into the proactive candidate or delivery tables.

If that exact version-bound subject cannot be resolved, Iris treats the delivery as
stale and sends no ambiguous reminder. The card includes the subject label and a
bounded count of related group messages, but not raw messages, summaries, evidence
IDs, owners, or hidden callback facts.

The card also includes one compact form with two buttons:

- `有帮助` records `helpful`.
- `不相关` records `irrelevant`.

The callback payload is typed as `proactive_signal_feedback` and binds the
interaction to:

- proactive delivery ID;
- candidate idempotency key;
- candidate entity version;
- destination group ID from the signed Feishu callback;
- delivered Feishu message ID when Feishu supplies one.

The callback gateway authenticates and decodes the envelope, validates the
bounded payload, enqueues one normalized interaction job, and immediately
returns HTTP 200. It does not access Postgres, check membership, or apply
suppression synchronously.

### 4.2 Feedback semantics

The first valid feedback from one actor for one delivery wins. Repeated callbacks
with the same Feishu event ID or repeated clicks by the same actor are
idempotent and do not change metrics.

The worker rejects feedback when:

- proactive speech is disabled for the group at processing time;
- the actor is the Iris bot;
- the actor is not a current group member;
- the delivery, candidate, group, message, or entity version no longer matches;
- the repository or membership checker is unavailable.

Stable denials are acknowledged. Transient infrastructure failures use the
existing bounded retry and dead-letter behavior.

### 4.3 Suppression

`helpful` only records product feedback.

`irrelevant` creates or extends an active suppression for the same:

- group ID;
- proactive signal kind;
- semantic entity ID.

The default suppression period is 30 days. It is configured by
`IRIS_PROACTIVE_IRRELEVANT_SUPPRESSION_DAYS`, accepts safe integer values from 1
through 365, and does not depend on model availability.

Candidate persistence excludes signals covered by an active suppression. The
scanner reports `suppressedCount` separately from `recordedCount` and
`existingCount`, so suppression is observable rather than silently appearing as
missing work. A later entity version remains suppressed until the bounded period
expires; after expiry it can be considered normally.

Suppression is also checked during approval, queue claim, and one final atomic
database authorization immediately before external send. If feedback creates a
suppression after a delivery was claimed, that authorization changes the delivery
to `cancelled`, clears its lease, and prevents the Feishu request. One final
synchronous runtime gate follows authorization and immediately precedes the
external client call.

## 5. Data Model

Migration `0040_proactive_signal_feedback.sql` adds:

### 5.1 `proactive_signal_feedback_events`

An append-only table with:

- callback idempotency key as primary key;
- delivery ID and candidate idempotency key;
- group ID;
- actor fingerprint;
- `helpful` or `irrelevant`;
- creation time.

`actor_fingerprint` is a Core-derived SHA-256 digest of the app ID and Feishu
open ID. Raw actor identity is used only for the live membership check and is
not stored in this feedback table or returned by metrics APIs.

A unique constraint on `(delivery_id, actor_fingerprint)` implements first
feedback wins. Append-only update, delete, and truncate guards match the existing
event tables.

### 5.2 `proactive_signal_suppressions`

A mutable projection keyed by `(group_id, kind, entity_id)` with:

- `suppress_until`;
- source feedback event ID;
- update time.

An irrelevant feedback transaction inserts the immutable feedback event and
upserts this projection. Replayed or losing duplicate feedback does not extend
the suppression.

## 6. Runtime Components

### 6.1 Parser and queue

The existing Feishu card-action parser and Redis interaction queue gain a third
typed interaction kind. Existing knowledge-draft and action-proposal contracts
remain unchanged.

### 6.2 Feedback worker

A focused proactive feedback worker:

1. checks the proactive runtime gate;
2. rejects the bot actor;
3. loads and validates the exact sent delivery binding;
4. checks current Feishu group membership;
5. rechecks the runtime gate;
6. hashes the actor identity;
7. commits feedback and optional suppression transactionally.

The existing approval interaction worker delegates only this new job kind to the
focused worker and retains queue acknowledgement/retry ownership.

Proactive delivery cannot be configured for a group unless knowledge-card feedback
is enabled for that group. Runtime assembly also fails closed if a delivery runtime
exists without the feedback runtime, and startup cleanup closes the unused delivery
resources.

### 6.3 Repository

The proactive repository gains:

- exact delivery binding lookup;
- feedback application;
- group feedback summary;
- active-suppression filtering during candidate recording.

All queries are bounded and group-scoped. Summary responses contain counts and
timestamps only.

### 6.4 Admin Console

The existing Proactive Candidates panel gains a small Feedback Effect section
for the entered group ID. Refreshing candidates also refreshes:

- total feedback;
- helpful count;
- irrelevant count;
- helpful rate;
- active suppression count;
- last feedback time.

No actor IDs, message bodies, evidence text, or candidate content are exposed.

## 7. Failure and Safety Behavior

- Callback authentication and the three-second acknowledgement boundary do not
  change.
- Unknown callback fields, actions, versions, or identifiers fail closed.
- Membership or repository outages are retried; they never count as feedback.
- Runtime disable is checked both before external membership I/O and before the
  database mutation.
- Active suppression is rechecked atomically after claim and immediately before
  the Feishu send.
- Proactive delivery cannot start without the corresponding feedback-card runtime.
- A failed Admin Console summary does not enable speech or mutate feedback.
- Migration absence makes the feedback capability unavailable; it does not
  weaken proactive delivery gates.
- No code in this slice starts Caddy, enables global Iris, or enables proactive
  speech.

## 8. Acceptance Criteria

1. Rendered proactive cards contain exactly the two bounded feedback actions and
   stay within the card byte/component limits. The visible Chinese card identifies
   the exact version-bound thread or action and refuses to render when that subject
   is unavailable.
2. Signed callbacks normalize into a typed queued job; malformed callbacks are
   rejected and duplicate events remain idempotent.
3. Current members can record feedback; bots, non-members, stale bindings, and
   disabled runtime states cannot.
4. One actor contributes at most one feedback result per delivery.
5. Irrelevant feedback suppresses the same group/kind/entity for the configured
   period; helpful feedback does not.
6. Suppressed candidates are counted separately and are not persisted or sent,
   including when suppression arrives after queue claim.
7. Admin APIs and UI expose bounded aggregate results without actor identity or
   message content.
8. Focused tests, the full Core test suite, typecheck, build, migration checks,
   and deployment contract checks pass.
9. Production remains fail closed after deployment until a separate controlled
   Feishu card-feedback acceptance pass is completed.
