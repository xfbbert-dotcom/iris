# Iris Feishu Gateway Enqueue Status Design

## Context

The Feishu Gateway now acknowledges callbacks without waiting for queue persistence. This protects the Feishu 3-second callback window, but enqueue failures must still be visible to operators or Iris can silently stop hearing group chat events.

## Decision

`/internal/status` includes a stable `feishuGateway` component. The component is healthy when no enqueue failures have been observed, and degraded after any gateway enqueue failure.

The component reports:

- `enqueueFailureCount`
- `latestEnqueueError.message`
- `latestEnqueueError.recordedAt`

The gateway still acknowledges Feishu callbacks immediately. Status reporting is diagnostic only and does not move queue persistence back into the response path.

## Scope

- Tracks in-process enqueue failures for the current app lifetime.
- Keeps the existing `onFeishuGatewayEnqueueError` hook available for logs or future persistent alerting.
- Does not change raw event retry, worker, or DLQ behavior.

## Quality Bar

- A queue enqueue failure leaves the Feishu callback response as HTTP 200.
- `/internal/status` marks `feishuGateway` degraded after the failure.
- Healthy status snapshots include the `feishuGateway` component with zero failures.
