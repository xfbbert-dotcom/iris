# Iris Feishu Gateway Status Reason Design

## Context

`/internal/status` is the first operator surface during the 20-30 person rollout.
Feishu Gateway enqueue failures already mark the component as degraded and
include the latest enqueue error, but the component does not expose a machine
readable degraded reason.

## Decision

When Feishu Gateway has observed enqueue failures, its status payload must
include `degradedReason: "enqueue_failures_present"`:

- healthy gateway status remains unchanged;
- failure count and latest error snapshot remain visible;
- consolidated status summaries continue to classify the component as degraded;
- the reason string lets operators and future UI code explain the red state.

## Testing

Extend the consolidated status regression test for gateway enqueue failures to
expect the degraded reason, then run focused API tests and full verification.
