# Iris Document Sync Claimed Source Fetch Design

## Context

Document sync workers first read a candidate source, then mark it `syncing`.
The architecture whitepaper requires the source returned by that claim to be
treated as authoritative before any Feishu document fetch begins. The runner
already rechecked permissions and capabilities on the claimed source, but still
used the pre-claim source for external fetches and snapshot writes.

## Decision

After `markSyncState(id, "syncing")` returns, document sync must use that
claimed source for:

- the external document body fetch;
- succeeded snapshot `documentSourceId` and `sourceUri`;
- failed snapshot `documentSourceId` and `sourceUri`;
- later sync-state transitions and pending restoration.

## Consequences

- If source metadata changes during the claim, Iris fetches and records the
  source it actually owns after the claim.
- Permission and capability rechecks stay aligned with the document body that
  gets fetched.
