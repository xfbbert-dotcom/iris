# Iris Redis Seen Release Guard Design

## Problem

Redis-backed queues move invalid queued payloads to DLQ and try to release their
pending `seen` key so a corrupted item does not block future work forever.
Before this guard, that release path trusted the `idempotencyKey` field after
only a length check. A manually repaired, stale, or corrupted Redis payload could
therefore release another queued item's seen key.

## Decision

Invalid-payload cleanup may release a seen key only when the key can be verified
from trusted fields inside the same payload:

- document sync recomputes `document-sync:<documentSourceId>` and requires an
  exact match with the stored key;
- document reindex recomputes
  `reindex:<embeddingProfileId>:<documentSnapshotId>` and requires an exact
  match with the stored key;
- raw Feishu events require provider `feishu` and a valid
  `raw-event:feishu:` idempotency key prefix before releasing.

Payloads that fail these lightweight checks still enter DLQ, but they do not
remove any seen key.

## Quality Bar

- Corrupt Redis queue entries remain diagnosable through existing DLQs.
- Invalid payloads that clearly belong to their own pending key can still release
  that key and avoid permanent blockage.
- Mismatched payloads cannot unlock unrelated raw event, document sync, or
  reindex work.
- Queue Lua scripts, Redis key names, and DLQ schemas remain unchanged.
