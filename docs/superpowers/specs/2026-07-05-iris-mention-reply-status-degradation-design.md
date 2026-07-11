# Iris Mention Reply Status Degradation Design

## Goal

Make `/internal/status` clearly surface when Iris can ingest Feishu events but cannot reply to
explicit @Iris mentions. For the first 20-30 person rollout, a healthy-looking operator dashboard
must not hide a broken core chat loop.

## Architecture

Worker-specific status endpoints keep their current shape. The consolidated operator status adapter
maps runtime wiring problems into component health:

- if the event worker reports `mentionRepliesUnavailableReason`, the `eventWorker` component is
  degraded;
- the component preserves `mentionRepliesEnabled: false` and the original unavailable reason;
- the component adds `degradedReason: "mention_replies_unavailable"`.

Dead letters remain higher-priority evidence. If `deadLetterEventCount > 0`, the consolidated
status keeps `degradedReason: "dead_letters_present"` so queue recovery is not masked by missing
mention reply wiring.

## Invariants

- Missing bot identity, Feishu OpenAPI config, or answer drafting must be visible from
  `/internal/status`.
- Runtime-control pauses such as `replyWhenMentioned: false` are not treated as missing wiring; they
  remain visible through runtime-control state.
- The adapter must not perform external I/O beyond the existing event worker status call.
- The event worker can still ingest messages and discover documents while mention replies are
  degraded.

## Out Of Scope

- Changing `/internal/events/status`.
- Alert delivery.
- Automatic remediation.
- Treating intentional runtime-control reply pauses as errors.
