# Iris DLQ Status Degradation Design

## Goal

Make the consolidated internal status endpoint surface queue dead letters as operator attention
signals. A small internal rollout should not require administrators to open each DLQ endpoint before
noticing that events, document sync jobs, or reindex jobs are waiting for recovery.

## Architecture

`GET /internal/status` remains the cheap read-only health surface. Individual worker status
endpoints keep their current shape and continue to report whether the status lookup itself
succeeded. The consolidated snapshot converts worker status into component health:

- event worker status is degraded when `deadLetterEventCount > 0`
- document sync status is degraded when `deadLetterJobCount > 0`
- reindex status is degraded when `deadLetterJobCount > 0`

The component payload must preserve the original runtime fields and add a stable
`degradedReason: "dead_letters_present"` marker. This keeps the dashboard simple while letting the
operator click through to the matching DLQ management endpoint.

## Invariants

- A disabled runtime is still reported as disabled, not degraded.
- A status lookup failure is still degraded with its existing failure error code.
- A running worker with non-empty DLQ is degraded even if the latest batch succeeded.
- The logic is local to the consolidated status adapter and must not enqueue work, inspect DLQ
  contents, or perform external I/O beyond the existing runtime status call.

## Out Of Scope

- Alert delivery.
- DLQ severity levels.
- Changing individual worker status endpoints.
- Automatic DLQ replay.
