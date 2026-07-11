# Iris Document Sync Claim Recheck Design

## Context

Document sync workers first load a document source, then mark it as `syncing`
before fetching the external Feishu document body. Between the initial read and
the claim update, administrators may disable source usage or Feishu permission
state may be marked denied by another control path.

## Decision

The claim update return value is the authoritative source record for deciding
whether the worker may perform external document I/O. After marking a source as
`syncing`, the runner must re-check:

- `permissionState !== "denied"`
- `canUseForAnswering || canUseForKnowledgeDrafts`

If either check fails, the runner must restore `syncState` to `pending`, skip
the fetch, avoid snapshot writes, and return a rejected sync result.

## Consequences

- Control-plane changes made during the sync claim window are respected before
  Iris reads a document body.
- Disabled or denied sources do not remain stuck as `syncing`.
- A later administrator re-enable can enqueue or select the source again because
  the source is left `pending`, while planner eligibility still filters denied
  or disabled sources.

