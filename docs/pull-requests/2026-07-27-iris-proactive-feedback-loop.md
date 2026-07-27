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
- Exposes only a group-scoped aggregate feedback summary in the Admin Console: total, helpful,
  irrelevant, helpful rate, active suppression count, and last feedback time.

## Privacy And Safety Boundary

Feedback storage and aggregate responses do not contain raw Feishu actor identities, message
bodies, evidence text, prompts, or answers. The persisted attribution is a SHA-256 fingerprint
used solely for per-delivery idempotency. Feedback is accepted only for a sent delivery with an
exact binding and a current member of its source group. An irrelevant result suppresses only the
same group, signal kind, and entity until the bounded expiry; a helpful result creates no
suppression.

Production remains disabled for proactive planning, delivery, and speech pending one real Feishu
feedback-card gray pass in an explicitly approved small group. Local verification is not approval
to change runtime state.

## Local Verification

The Task 5 report records the focused Core suite, full Core suite, typecheck, build, pilot Compose
contract test, and `git diff --check` results from the documentation commit.

## External Acceptance Pending Controller Completion

The following are intentionally not performed by this documentation task and remain pending
controller completion:

- read-only VPS fail-closed inspection;
- deployment, migration application, or any runtime-state change;
- real Feishu feedback-card gray pass;
- push, GitHub pull request creation, and GitHub Actions check verification.

The controller must confirm global and desired-global runtime disabled, `proactiveSpeech=false`,
Caddy stopped, Core/Postgres/Redis/AI Worker healthy, and clean event/document/reindex/memory
pending and DLQ counts before and after any future gray pass.
