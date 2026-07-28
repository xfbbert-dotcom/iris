# Iris Explicit Document Submission Precedence Design

## Status

Approved architecture clarification derived from:

- the document source registry rule that a manual submission is registered as
  `user_submitted_document`;
- the Feishu command acceptance rule that an explicit in-chat submission creates
  a canonical `user_submitted_document`;
- the real pilot event on 2026-07-28 that was first registered as a user
  submission and then reclassified by generic link discovery from the same
  message.

This clarification does not change the global source precedence:

1. `authorized_wiki_document`
2. `group_visible_document`
3. `user_submitted_document`

## Problem

The Feishu event processor handles an explicit `@Iris 请收录这个文档 <link>`
command before it runs generic group-document link discovery. Both paths
register the same URI:

1. the command path records `user_submission`;
2. generic discovery records `group_message`;
3. the global priority rule upgrades the source to `group_visible_document`.

The second observation is not independent evidence that should override the
user's explicit intent. It is a mechanical duplicate produced from the same
group, message, and URI.

## Decision

An in-chat user submission records optional submission provenance:

- `submissionGroupId`
- `submissionMessageId`

Both values must be present together or both omitted. Admin/API submissions may
continue to omit them.

The provenance is stored on the `user_submission` evidence row as `groupId` and
`messageId`. No schema migration is needed.

When merging `user_submitted_document` and `group_visible_document`, Iris keeps
`user_submitted_document` only when every group-message evidence row for the
source has a matching user-submission evidence row with the same:

- canonical source URI;
- group ID;
- message ID.

This makes the result independent of processing order:

- user submission, then generic discovery;
- generic discovery, then user submission;
- duplicate Feishu delivery of either operation.

If any group-message evidence has no matching explicit submission, normal
precedence applies and the source is `group_visible_document`. An authorized
wiki source always remains `authorized_wiki_document`.

## Security And Scope Invariants

- Do not raise the global priority of `user_submitted_document`.
- Do not suppress or discard group-message evidence.
- Do not treat messages from different groups or message IDs as the same event.
- Do not change answer retrieval scope or live Feishu permission checks.
- Do not re-enable a source policy disabled by an administrator.
- Evidence remains idempotent under Feishu retries.

## Acceptance

- The real command shape produces one source with type
  `user_submitted_document`, one user-submission evidence row, and one
  group-message evidence row.
- Reversing registration order produces the same result.
- Replaying either registration does not duplicate evidence.
- A later ordinary group mention upgrades the source to
  `group_visible_document`.
- An authorized wiki registration remains highest priority.
- In-memory and Postgres registries implement identical behavior.
- The Feishu responder forwards the current chat and message IDs as submission
  provenance.

## Rollout

Deploy only after focused registry/responder tests, Core typecheck/build, and the
repository CI checks pass. Keep Iris fail-closed during deployment. Re-run the
single pilot submission using a fresh document marker, verify the source and
evidence postconditions, then restore fail-closed before recording the result.
