# Iris Runtime Control API Design

## Problem

The architecture requires Admin Console support for global Iris enable/disable
and per-group enable/disable. `RuntimeController` exists, but it is not wired
into the Core App routes or Feishu gateway ingestion path.

Without an API and ingestion gate, administrators cannot actually turn Iris off
from the backend, and disabled scopes may still enqueue new Feishu message
events.

## Decision

Add a v1 in-memory runtime-control API:

- `GET /internal/runtime-control/status`
- `POST /internal/runtime-control/global` with `{ "enabled": boolean }`
- `POST /internal/runtime-control/groups/:groupId` with `{ "enabled": boolean }`

Wire the shared `RuntimeController` into Feishu Gateway. The gateway must still
return HTTP 200 for accepted Feishu callbacks, but if the runtime controller says
the event scope is disabled, it must skip queueing the event.

## Non-Goals

- Do not add persistent runtime-control storage in this patch.
- Do not add authentication or RBAC in this patch.
- Do not add capability-specific pause/resume endpoints yet.
- Do not change worker start/stop lifecycle.

## Quality Bar

- Global disable prevents new Feishu events from entering queues while keeping
  callback ACK behavior.
- Per-group disable prevents that group's events from entering queues.
- Re-enabling global or group scope allows later events to queue again.
- Runtime status snapshots expose cloned config state.
