# Iris Internal Status Component Cloning Design

## Problem

`buildInternalStatusSnapshot()` adds derived component statuses, but it only
shallow-copies component objects. Nested component details such as `retention` or
`latestBatch` can share references with the input runtime status objects.

The `/internal/status` response should behave as a point-in-time read model, not
as an alias to runtime-owned objects.

## Decision

Clone component values while building the internal status snapshot:

- clone `Date` instances as new `Date` objects
- clone arrays recursively
- clone plain objects recursively
- leave primitives and non-plain objects as-is

## Non-Goals

- Do not change status derivation or attention severity rules.
- Do not change `/internal/status` response shape.
- Do not introduce JSON serialization into the status builder.

## Quality Bar

- Mutating nested values on the returned status snapshot does not mutate the
  input component objects.
- Existing aggregate status and attention summary behavior remains unchanged.
