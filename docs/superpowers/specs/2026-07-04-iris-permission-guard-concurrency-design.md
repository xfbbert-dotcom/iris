# Iris Permission Guard Concurrency Design

## Goal

Reduce answer-time latency from real-time document permission checks without weakening fail-closed
permission behavior.

## Architecture

`filterFragmentsByLivePermission` now resolves live permissions per unique `documentId` concurrently
before assembling the filtered fragment result.

The guard still performs one permission check per unique document ID, then iterates over the
original fragment list to:

- keep allowed fragments in original retrieval order,
- report denied document IDs once,
- record one audit event per denied or errored document.

## Invariants

- Permission errors still deny the affected document.
- Duplicate fragments from the same document still trigger only one live permission check.
- Allowed fragment output order still follows the input fragment order.
- Denied/error audit events still include every fragment ID from that document in the current call.
- Audit logging remains best-effort and cannot make permission filtering fail open.

## Out Of Scope

- Changing Feishu permission API timeout values.
- Adding a configurable permission-check concurrency limit.
- Changing document retrieval candidate limits.
- Changing audit event schemas.
