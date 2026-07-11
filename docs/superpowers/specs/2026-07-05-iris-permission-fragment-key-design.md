# Iris Permission Fragment Key Design

## Context

`DocumentRetrievalContextBuilder` retrieves semantic fragments, converts them into permission-guard fragments, then maps the guard-approved fragments back to the original retrieved fragments before assembling `<background_documents>`.

Before this hardening pass, that final map used only `fragment.id`. Under normal repository invariants, fragment IDs are unique. But answer-time permission filtering is a security boundary and must stay safe even if indexed data is corrupted, manually repaired, or produced by an older importer.

If two retrieved fragments share one fragment ID but belong to different document sources, an allowed source can accidentally authorize a denied source's text when the final map keys only by fragment ID.

## Decision

Permission-filtered retrieval must join guard-approved fragments back to retrieved fragments with a compound key:

- retrieved side: `fragment.id` plus `fragment.documentSourceId`;
- permission-guard side: `fragment.id` plus `fragment.documentId`.

The delimiter is an internal NUL byte so normal text IDs cannot visually collide through string concatenation.

## Scope

- Does not change vector search ranking.
- Does not change permission guard API shape.
- Does not relax live permission checks.
- Does not require a migration because this is an answer-time mapping guard.

## Quality Bar

- A duplicate fragment ID in two document sources must not leak denied source text into prompt context.
- Denied document IDs must still be reported for auditability.
- Allowed fragments from the approved source must continue to appear normally.
- This guard is in addition to repository uniqueness constraints, not a replacement for them.
