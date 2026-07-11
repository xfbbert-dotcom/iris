# Iris Runtime Capability Processing Gates Design

## Problem

The backend can now toggle runtime capabilities, but Feishu message processing
does not yet respect the `readGroupContext` and `readGroupDocuments` switches.

If these switches only change status output, administrators may believe Iris has
stopped reading group context or documents while workers continue to persist
messages and register document links.

## Decision

Apply capability gates in `FeishuMessageEventProcessor`:

- if `canReadGroupContext(chatId)` is false, skip message persistence and document discovery
- if `canReadDocuments()` is false, persist the message but skip document link extraction and registration

Keep existing global and per-group runtime gates in place.

## Non-Goals

- Do not add per-group document-reading policy in this patch.
- Do not change document sync queues.
- Do not change answer prompt assembly.

## Quality Bar

- Disabling group context reading prevents message fact writes.
- Disabling document reading prevents document-link discovery without dropping the message fact.
- Existing enabled behavior remains unchanged.
