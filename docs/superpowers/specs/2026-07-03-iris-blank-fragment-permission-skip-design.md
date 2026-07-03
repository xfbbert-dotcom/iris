# Iris Blank Fragment Permission Skip Design

## Problem

`DocumentRetrievalContextBuilder` filtered blank retrieved fragments after the live
permission guard. Blank fragments never enter the prompt, but they still triggered
`canReadDocument` calls and could generate denial audit noise.

In a Feishu-backed runtime, each permission check can become a live API call. Checking blank
chunks wastes latency budget and increases pressure on the Real-time Permission Guard.

## Decision

Filter retrieved fragments with blank `text` before calling `filterFragmentsByLivePermission`.

Keep `retrievedFragmentCount` based on the original search result so diagnostics still show
how many fragments vector search returned.

## Non-Goals

- Do not change vector search limits.
- Do not change permission behavior for nonblank fragments.
- Do not change prompt Context Anchor ordering.
- Do not include blank fragments in denied document diagnostics.

## Quality Bar

- Blank fragments do not call `canReadDocument`.
- Nonblank fragments still pass through the live permission guard.
- Returned `allowedFragments` and prompt context still exclude blank fragments.
- `retrievedFragmentCount` still counts the raw search result.
