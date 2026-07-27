# Iris Proactive Feedback Loop

## Scope

This change closes the governed feedback loop for bounded proactive reminders while preserving the
existing fail-closed proactive runtime gates.

- Adds migration `0040_proactive_signal_feedback.sql` with append-only feedback events and a
  mutable active-suppression projection.
- Adds typed Feishu `helpful` and `irrelevant` feedback-card actions bound to the exact sent
  delivery, candidate, group, and entity version.
- Requires a current group member and rechecks the proactive runtime gate before feedback is
  persisted. Duplicate callbacks remain acknowledged without creating duplicate feedback.
- Adds `IRIS_PROACTIVE_IRRELEVANT_SUPPRESSION_DAYS=30`; it accepts whole days from `1` through
  `365` and does not enable proactive planning, delivery, speech, Caddy, or Iris globally.
- Rechecks suppression in one atomic authorization immediately before external send, so feedback
  committed after queue claim cancels the delivery and clears its lease.
- Rechecks the runtime gate after that database authorization and immediately before invoking
  Feishu, closing disable-during-authorization races.
- Requires the knowledge-card feedback runtime and group allowlist to cover every enabled
  proactive delivery group; startup fails closed and cleans up otherwise.
- Exposes only a group-scoped aggregate feedback summary in the Admin Console: total, helpful,
  irrelevant, helpful rate, active suppression count, and last feedback time.

## Privacy And Safety Boundary

Feedback storage and aggregate responses do not contain raw Feishu actor identities, message
bodies, evidence text, prompts, or answers. The persisted attribution is a SHA-256 fingerprint
used solely for per-delivery idempotency. Feedback is accepted only for a sent delivery with an
exact binding and a current member of its source group. An irrelevant result suppresses only the
same group, signal kind, and entity until the bounded expiry; a helpful result creates no
suppression. A claimed delivery cannot bypass a newly committed suppression.

Production remains disabled for proactive planning, delivery, and speech pending one real Feishu
feedback-card gray pass in an explicitly approved small group. Local verification is not approval
to change runtime state.

## Local Verification

Fresh verification on the final working tree:

- `npm run verify` passed end to end. This includes `git diff --check`, Core typecheck and build,
  the complete Core suite, the complete AI Worker suite, pilot operations tests, both Compose
  contracts, and the fail-closed rollout-readiness profile.
- The proactive feedback focused Core suite passed with 68 tests.
- The runtime assembly regression passed with 19 tests and now asserts the exact delivery-binding
  repository call before membership and mutation.
- The real PostgreSQL migration/repository integration passed with 9 tests against a disposable
  PostgreSQL 16 instance, including the claim-to-feedback pre-send race.
- GitHub CI now runs that Postgres suite with `IRIS_TEST_DATABASE_URL`, and a pilot contract test
  prevents the real-database race gate from silently disappearing.
- The deterministic streaming-timeout regression passed 30 consecutive focused runs before the
  complete AI Worker suite was rerun.

## Independent Review Resolution

The independent review found no critical issue and two important issues. Both are closed:

- a suppression created after queue claim now cancels the exact claimed delivery in the final
  atomic pre-send authorization;
- a runtime disable during final database authorization is rechecked before any Feishu call;
- proactive delivery configuration and runtime assembly now require the matching feedback-card
  runtime before any delivery worker starts.

## External Acceptance Pending

The branch does not deploy itself or change production runtime state. The following remain external
release gates:

- deploy the reviewed candidate with Core and AI Worker images pinned to the approved commit;
- apply migration `0040_proactive_signal_feedback.sql`;
- complete one real Feishu feedback-card gray pass in an explicitly approved small group;
- prove `helpful` records an aggregate event without suppression;
- prove `irrelevant` suppresses only the same group, signal kind, and entity until expiry;
- prove a stale delivery, bot actor, removed member, disabled runtime, and duplicate callback all
  fail closed or no-op as specified;
- recheck global and desired-global runtime disabled, `proactiveSpeech=false`, Caddy stopped,
  service health, and empty pending/DLQ counts before any public ingress or enablement.
