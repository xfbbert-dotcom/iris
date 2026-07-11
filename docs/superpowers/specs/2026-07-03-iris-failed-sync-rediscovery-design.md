# Iris Failed Sync Rediscovery Design

## Problem

When a document source sync fails, its `syncState` becomes `failed`. If the same document
link later appears again in a group, registration appends evidence but preserves the failed
sync state. The discovered-document planner only enqueues `pending` sources, so a temporary
fetch failure can prevent later rediscovery from automatically retrying the document.

For a 20-30 person team using Iris in live Feishu groups, this makes the system feel brittle:
one transient failure can keep a useful document unavailable until someone manually
intervenes.

## Decision

When registering a source URI that already exists:

- If the existing `syncState` is `failed`, reset it to `pending`.
- Preserve `syncing` and `synced` states.
- Preserve permission and capability checks; denied or fully disabled sources still do not
  become sync candidates.

Apply the same rule to both in-memory and Postgres registries.

## Non-Goals

- Do not resync already synced sources on every repeated mention.
- Do not bypass permission denial.
- Do not bypass admin-disabled answering/knowledge draft capabilities.
- Do not change document sync job retry limits.

## Quality Bar

- In-memory registry resets `failed -> pending` when new evidence is registered.
- Postgres registration merge SQL resets `failed -> pending`.
- Existing evidence dedupe and source type merge behavior remain intact.
