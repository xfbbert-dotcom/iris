# Iris Disabled Group Answer Retrieval Guard Design

## Problem

Runtime group disablement already blocks new Feishu ingestion and answer drafts for that group.
However, previously indexed `group_visible_document` fragments from a disabled group can still
be recalled by another answer draft when source-policy retrieval is active.

That weakens the expected scope boundary: disabling a group should stop that group's chat and
group-visible document material from influencing Iris until the group is re-enabled.

## Decision

Extend the answer draft runtime retrieval gate for `group_visible_document` sources:

- keep requiring `canReadDocuments()`;
- when the source has one or more group ids, require at least one of those groups to still pass
  `canProcessGroupMessage(groupId)`;
- preserve existing behavior when no runtime controller is supplied;
- preserve existing behavior for authorized wiki and user-submitted sources.

Group ids come from `originGroupId` and any group ids recorded in source evidence.

## Non-Goals

- Do not add per-user document visibility.
- Do not change Feishu live permission checks.
- Do not block authorized wiki documents because a group is disabled.
- Do not change the development-only `allow-indexed` mode.

## Quality Bar

- A group-visible document whose only source groups are disabled must not enter the model prompt.
- A group-visible document with at least one enabled source group may still be used.
- User-submitted documents remain unaffected by group disablement.
