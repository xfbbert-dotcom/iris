# Iris Internal Status Enabled Runtime Summary Design

## Problem

The internal status summary separates disabled and degraded components, but enabled workers can still be stopped. Operators need a quick way to distinguish:

- disabled components that are intentionally unavailable;
- degraded components that failed status checks;
- enabled runtime components that are not running.

This keeps the first internal admin view actionable without forcing the UI to infer runtime state from every component payload.

## Decision

Add enabled-runtime summary fields to `GET /internal/status`:

```json
{
  "summary": {
    "enabledRuntimeComponentCount": 2,
    "runningEnabledRuntimeComponentCount": 1,
    "stoppedEnabledRuntimeComponentCount": 1,
    "stoppedEnabledRuntimeComponents": ["eventWorker"]
  }
}
```

Only components with `enabled: true` and a boolean `running` field are included. Disabled runtimes remain covered by the disabled component summary.

## Semantics

- `enabledRuntimeComponentCount`: enabled components that expose runtime `running` state.
- `runningEnabledRuntimeComponentCount`: enabled runtime components where `running` is true.
- `stoppedEnabledRuntimeComponentCount`: enabled runtime components where `running` is false.
- `stoppedEnabledRuntimeComponents`: stable component keys for stopped enabled runtimes, in component-map order.

## Quality Bar

- Stopped enabled runtime count must match the stopped list length.
- Running and stopped enabled runtime counts must add up to enabled runtime count.
- Disabled components must not be counted as stopped enabled runtimes.
