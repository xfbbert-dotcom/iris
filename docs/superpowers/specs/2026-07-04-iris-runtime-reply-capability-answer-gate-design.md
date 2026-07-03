# Iris Reply Capability Answer Gate Design

## Problem

Runtime capability control can now toggle `replyWhenMentioned`, but
`POST /internal/answer-drafts` still only checks global/group runtime enablement.
If reply generation is disabled, the internal answer draft API can still produce
reply drafts.

## Decision

Add a `RuntimeController.canGenerateAnswerDraft()` helper and use it in the
answer draft route:

- global disabled blocks drafts
- disabled groups block drafts for that `chatId`
- `replyWhenMentioned: false` blocks draft generation
- enabled scopes with reply capability continue normally

## Non-Goals

- Do not change model orchestration.
- Do not add approval flow in this patch.
- Do not add persistence for runtime settings.

## Quality Bar

- Disabling `replyWhenMentioned` prevents answer draft generation.
- Re-enabling the capability allows answer draft generation again.
- Existing global and group disable behavior remains intact.
