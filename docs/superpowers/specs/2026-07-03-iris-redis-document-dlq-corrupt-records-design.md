# Iris Redis Document DLQ Corrupt Records Design

## Problem

Document sync and reindex Redis DLQs are operator-facing recovery tools. They
already list normal failed jobs and invalid queue-payload diagnostics. However,
if the DLQ record itself is corrupted, such as a non-JSON Redis list item or a
malformed object with a stored `id`, listing or deleting dead letters can throw
and make the internal recovery endpoint unusable.

That failure mode hides the other valid DLQ entries operators need during an
incident.

## Decision

Redis document DLQ parsers must be tolerant at the list-management boundary:

- A corrupt DLQ payload is represented as a non-replayable diagnostic item.
- The diagnostic `rawPayload` is the exact Redis list item.
- If a stored `id` can be recovered from a malformed object, delete operations
  may remove that item by id.
- If the item has no stored `id`, it receives the existing legacy generated id
  and remains non-replayable.
- If the original failure timestamp cannot be recovered, the diagnostic
  `failedAt` uses the queue clock at parse time.

This keeps the admin DLQ surface usable without making corrupt records replayable
or pretending they are typed jobs.

## Non-Goals

- Do not make corrupt DLQ records replayable.
- Do not change Redis key names or endpoint paths.
- Do not add a new DLQ schema version in this patch.
- Do not rewrite existing normal failed-job or invalid raw-payload diagnostics.

## Quality Bar

- Document sync DLQ listing returns corrupt records as diagnostics and continues
  listing subsequent valid entries.
- Document reindex DLQ listing returns corrupt records as diagnostics and
  continues listing subsequent valid entries.
- Malformed DLQ objects with stored ids can be deleted by id.
- Existing normal failed-job, invalid raw-payload, replay, and delete behavior
  remains intact.
