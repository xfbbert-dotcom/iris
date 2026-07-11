# Iris Failed Sync Rediscovery Idempotency Design

## Problem

Document source registration intentionally resets a failed source to `pending` when Iris sees new evidence for the same document. That lets a document recover after a later group mention, wiki authorization, or user submission.

The current registry code resets `failed` to `pending` for every re-registration, including duplicate Feishu retries for the exact same evidence. A duplicated callback should not be treated as rediscovery.

## Requirements

- Keep resetting `failed` to `pending` when registration adds distinct evidence.
- Keep duplicate evidence idempotent.
- Do not reset `failed` to `pending` when the registration evidence already exists.
- Apply the rule to both in-memory and Postgres registries.
- Preserve admin-disabled answering/knowledge-draft policy behavior.

## Non-goals

- Do not change source type priority.
- Do not change evidence identity fields.
- Do not introduce new sync states.

## Acceptance

- In-memory duplicate evidence retry leaves a failed source failed.
- In-memory new evidence still reopens failed sources as pending.
- Postgres update SQL gates failed-to-pending reset on evidence non-existence.
- Full verification remains green.
