# Iris Chat Knowledge Drafts

## Scope

This change makes the existing governed knowledge-publication loop directly usable from a Feishu
group. An authorized member can explicitly ask `@Iris` to create a knowledge draft from the recent
discussion. Iris creates one durable draft, sends the existing group-confirmation card, and leaves
all later review, approval, and Wiki publication gates unchanged.

- Recognizes only explicit knowledge-draft or knowledge-base archival commands after a real Iris
  mention; ordinary knowledge-base questions remain on the normal answer path.
- Generates from at most the latest 20 nonblank messages from the same group and no documents,
  memories, other groups, or model background knowledge.
- Requires current-group context access, draft, card, and action-approval runtime gates plus exactly
  one enabled medium-risk publication policy for the source group before invoking the model.
- Records the requesting Feishu user as reviewer and the selected publication policy as an
  unapproved suggestion.
- Uses the Feishu message ID to derive stable draft, create-operation, and presentation-operation
  identities. Retries resume an existing pending draft without another model call or duplicate
  card.
- Reuses the existing group confirmation, full-draft OAuth review, owner/admin approval, and Wiki
  publication pipeline. Creating the chat draft never writes to Wiki.

## Fail-Closed Behavior

- Disabled or incomplete runtime composition reports that no draft or Wiki content was created.
- The group-context gate is enforced before coordination, before the message-repository read, and
  again after context assembly immediately before the model call; every creation gate is also
  rechecked after model generation and before persistence.
- Missing requester identity, no recent group context, and missing or ambiguous publication policy
  all stop before durable creation.
- Only a positive creation/archive intent is accepted. Informational questions and negated requests
  stay on the ordinary answer path, while explicit polite requests such as "can you create" remain
  actionable.
- Only a real Feishu `open_id` can become the designated reviewer; union/user ID fallbacks are
  rejected for governed draft creation.
- Provider capacity, provider unavailability/timeout, and invalid model envelopes return bounded
  Chinese non-creation responses without provider details. Repository and card failures remain on
  the event retry path.
- Repository rows whose `chatId` differs from the requested group are excluded even if a repository
  implementation violates its query contract.
- A retry can repair a previously persisted pending draft without rerunning creation gates, policy
  resolution, or the model; the card runtime gate remains authoritative for the repair effect.
- A draft that has already left group confirmation is not reopened or re-presented by command
  replay.

## Local Verification

Fresh verification on the final working tree before publication:

- Focused generator, coordinator, responder, and Feishu event-processor review regressions:
  99 passed.
- `npm run verify`: exit `0`; this includes `git diff --check`, Core typecheck, production build,
  complete Core tests, Python tests, pilot operation/backup/restore tests, Compose validation,
  readiness, and pilot configuration validation.
- Independent review passes found authorization, partial-recovery, permission-race, requester-ID,
  provider-failure, and intent-classification blockers. Every finding received regression coverage
  and was fixed before publication; the final review did not report a critical issue.

## External Acceptance Status

Real Feishu acceptance is pending deployment of the exact reviewed candidate. The rollout remains
limited to the existing pilot group and requires:

1. exact Core/AI Worker image SHA parity and successful GitHub checks;
2. fail-closed deployment entry with zero pending, DLQ, outcome-unknown, and terminal failures;
3. one explicit pilot discussion and one `@Iris` knowledge-draft command;
4. exactly one group card, group confirmation, full-draft OAuth review, current approval, and one
   Wiki publication beneath the authorized target;
5. no non-pilot effects and zero queues/DLQs after the loop.

This document does not claim live acceptance until those gates are recorded.
