# Iris Runtime Capability Control API Design

## Problem

The architecture requires high-risk and proactive Iris capabilities to be
configurable and pausable. `RuntimeController` has one-way pause helpers, but the
backend has no API for administrators to disable and later re-enable individual
capabilities.

## Decision

Add a v1 in-memory capability update API:

- `PATCH /internal/runtime-control/capabilities`
- request body is a partial map of known capability names to booleans
- response returns the full runtime-control snapshot

Add `RuntimeController.setCapability()` so capability changes use the same
controller boundary as global and group enablement.

## Non-Goals

- Do not add persistence in this patch.
- Do not add role-based authorization in this patch.
- Do not wire every capability into product behavior in this patch.

## Quality Bar

- Known capabilities can be disabled and re-enabled.
- Unknown capability names are rejected.
- Non-boolean capability values are rejected.
- Runtime status snapshots reflect updated capability values.
