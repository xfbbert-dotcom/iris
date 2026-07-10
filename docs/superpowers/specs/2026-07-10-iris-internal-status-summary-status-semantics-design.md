# Iris Internal Status Summary Status Semantics Design

## Problem

After stopped enabled runtimes became top-level health failures, the consolidated status summary
still counted components with `ok: true` as healthy. That made an enabled worker with
`running: false` increase `healthyComponentCount` even though the same response returned
`status: "degraded"` and surfaced the worker as an attention item.

## Decision

Derive operator-facing health summary fields from component `status` values:

- `healthyComponentCount`: components with `status: "healthy"`.
- `degradedComponentCount`: components with `status: "degraded"` or `status: "stopped"`.
- `degradedComponents`: stable keys for components with `status: "degraded"` or
  `status: "stopped"`.

Disabled components remain separated into the disabled summary. This keeps intentional rollout
switches visible without presenting them as runtime failures.

## Quality Bar

- A stopped enabled runtime cannot be counted as healthy.
- A stopped enabled runtime appears in `degradedComponents` while retaining component-level
  `status: "stopped"`.
- Disabled components do not affect `degradedComponentCount`.
