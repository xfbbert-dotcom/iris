# Iris Permission Guard Concurrency Design

## Goal

Reduce answer-time latency from real-time document permission checks without weakening fail-closed
permission behavior.

## Architecture

Production rate-limit evidence on 2026-07-30 superseded fully concurrent external probes.
`filterFragmentsByLivePermission` still resolves one permission per unique `documentId`, while the
process-local Feishu checker now serializes external probes with a 650 ms minimum start interval and
coalesces simultaneous checks for the same source. This protects the current 100-calls-per-minute
wiki-node boundary and 5-calls-per-second docx metadata boundary without caching authorization.

The guard still performs one permission check per unique document ID, then iterates over the
original fragment list to:

- keep allowed fragments in original retrieval order,
- report denied document IDs once,
- record one audit event per denied or errored document.

## Invariants

- Permission errors still deny the affected document.
- Duplicate fragments from the same document still trigger only one live permission check.
- Concurrent answer requests for the same source share only the currently running probe; completed
  decisions are not cached.
- Different external source probes never overlap inside one Core process.
- Allowed fragment output order still follows the input fragment order.
- Denied/error audit events still include every fragment ID from that document in the current call.
- Audit logging remains best-effort and cannot make permission filtering fail open.

## Out Of Scope

- Changing Feishu permission API timeout values.
- Adding cross-process rate coordination or a dedicated Permission Guard Service.
- Changing document retrieval candidate limits.
- Changing audit event schemas.
