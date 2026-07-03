# Iris Redis Document Invalid DLQ Listing Design

## Problem

Document sync and reindex Redis dequeue now write malformed queue payloads into the
same DLQ as normal failed jobs. The existing DLQ listing parser still assumes every
entry has a typed `job`. That means a diagnostic invalid-payload DLQ item can make
the internal DLQ list endpoint fail, hiding exactly the record operators need to see.

## Decision

Represent document DLQ entries as a union:

- Normal failed jobs include `job` and can be replayed when they have a stored id.
- Invalid queue payload diagnostics include `rawPayload`, have `replayable: false`,
  and can be deleted when they have a stored id.

Invalid queue payloads written by Redis dequeue should include a stable generated
`id`, so admins can remove them from the DLQ after inspection.

## Non-Goals

- Do not make malformed raw payloads replayable.
- Do not change existing normal failed-job replay behavior.
- Do not change endpoint names or Redis key names.

## Quality Bar

- DLQ listing returns invalid raw payload diagnostics without throwing.
- Replay of an invalid raw payload id returns the existing unsupported status.
- Delete of an invalid raw payload id removes the DLQ entry.
- Normal failed-job listing, replay, and deletion continue to work.
