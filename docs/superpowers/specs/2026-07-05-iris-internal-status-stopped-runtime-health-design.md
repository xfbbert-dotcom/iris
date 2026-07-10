# Iris Internal Status Stopped Runtime Health Design

**Goal:** Prevent `/internal/status` from looking healthy when an enabled worker is stopped.

**Problem:** The consolidated status builder derived top-level `ok` only from component `ok` fields. Enabled runtime components can report `ok: true` and `running: false`, which produced `status: "healthy"` even though an operator attention item existed.

**Decision:** Keep component-level status semantics unchanged: `stopped` means enabled and otherwise ok, but not running. Top-level `ok` must now also require zero stopped enabled runtime components. Disabled components remain info-level visibility and do not by themselves mark the rollout status degraded.

Summary health counts follow the derived component status, not the raw `ok` boolean. A stopped
enabled worker must not increase `healthyComponentCount`; it must be present in
`degradedComponents` and contribute to `degradedComponentCount` while still retaining its
component-level `status: "stopped"` for UI filtering.

**Quality Bar:** A status snapshot containing only `{ ok: true, enabled: true, running: false }` returns top-level `ok: false`, `status: "degraded"`, and warning-level attention for that component.
