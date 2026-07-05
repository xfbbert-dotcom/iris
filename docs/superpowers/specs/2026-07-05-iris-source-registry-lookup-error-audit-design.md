# Iris Source Registry Lookup Error Audit Design

## Context

Answer-time `source-policy` retrieval uses the document source registry as the first permission gate. A missing source, disabled capability, denied source, or stale source is a normal policy outcome and should be audited as a denial.

Before this hardening pass, an exception from `findSourceById()` was swallowed by the answer draft runtime and converted into `false`. That still failed closed, but it made a database outage or registry dependency failure look identical to an intentional permission denial.

For the first 20-30 person Iris deployment, the behavior must stay conservative while making core failures easy to diagnose.

## Decision

`source-policy` must let source-registry lookup exceptions propagate into the existing permission guard. The permission guard already excludes the affected fragments and records `permission_guard_error` when `canReadDocument()` throws.

The local source-policy callback therefore distinguishes:

- missing source record: return `false`;
- disabled answer retrieval capability: return `false`;
- `denied` or `stale` permission state: return `false`;
- source-registry lookup exception: throw and let the permission guard record an error.

## Scope

- Does not allow any new document content into prompt context.
- Does not change `deniedDocumentIds`; excluded source IDs are still returned to callers.
- Does not add a new audit event type.
- Does not change Feishu live permission behavior.

## Quality Bar

- Registry lookup errors remain fail-closed.
- Operators can distinguish registry/database outages from ordinary local policy denials.
- Source-policy tests must assert `permission_guard_error` includes the registry error message.
