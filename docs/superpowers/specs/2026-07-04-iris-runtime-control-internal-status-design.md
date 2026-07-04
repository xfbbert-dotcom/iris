# Iris Runtime Control Internal Status Design

## Goal

Make the consolidated `/internal/status` response show whether Iris is globally enabled or disabled.
Small-team operators should not have to remember a separate runtime-control status endpoint before
they can understand whether Iris is intentionally off.

## Architecture

Reuse the shared in-memory `RuntimeController` owned by `buildApp()`. When building the consolidated
status response, read `runtimeController.getSnapshot()` and add a `runtimeControl` component after
`audit` and before runtime subsystems:

- `enabled`: mirrors `globalEnabled`
- `globalEnabled`: the raw global gate value
- `disabledGroupIds`: cloned sorted disabled group IDs from the controller snapshot
- `disabledGroupCount`: count of disabled group IDs

Let `buildInternalStatusSnapshot()` derive component status from the same component rules used by
the rest of the status surface. That means global disabled state appears as a disabled component,
while global enabled state appears healthy.

## Invariants

- `/internal/runtime-control/status` remains the detailed control endpoint.
- `/internal/status` remains read-only and cheap.
- The runtime-control component uses the same shared controller as Feishu ingress, queued event
  processing, and answer draft generation.
- Disabled runtime control is visible in `summary.attentionComponents` through existing disabled
  component rules.

## Out Of Scope

- Persistent runtime-control storage.
- Admin UI changes.
- Changing runtime-control mutation endpoints.
