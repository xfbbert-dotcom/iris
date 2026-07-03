# Iris Runtime Group ID Normalization Design

## Problem

`RuntimeController` stored and checked group IDs exactly as provided. If an admin or internal
caller passed a padded group ID such as `" chat-a "`, the disable rule did not match the
actual Feishu group ID. Blank group IDs were also treated as processable.

This weakens the backstage enable/disable controls for Iris.

## Decision

Normalize group IDs at the runtime-controller boundary:

- `disableGroup` and `enableGroup` trim group IDs.
- Blank group IDs are ignored for mutation.
- `canProcessGroupMessage` trims group IDs and rejects blank values.
- All group-scoped checks inherit the normalized behavior through `canProcessGroupMessage`.

## Non-Goals

- Do not add persistent storage for runtime config in this patch.
- Do not change global capability defaults.
- Do not change non-group capability checks.

## Quality Bar

- Disabling `" chat-a "` disables `"chat-a"`.
- Enabling `" chat-a "` re-enables `"chat-a"`.
- Blank group IDs cannot be processed or replied to.
- Existing per-group and global gates continue to work.
