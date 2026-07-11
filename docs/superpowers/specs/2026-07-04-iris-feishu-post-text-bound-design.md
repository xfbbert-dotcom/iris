# Iris Feishu Post Text Bound Design

## Context

Feishu post messages can contain nested rich-text JSON. Iris extracts readable
text and links from this tree so group-visible documents can be discovered from
post messages. The current traversal is recursive and unbounded, so a malformed
or unusually deep payload can consume unnecessary worker time or hit recursion
limits before the raw event retry path can handle it cleanly.

## Decision

Post text extraction must be bounded:

- traverse only a reasonable nesting depth for real Feishu post content;
- collect only a bounded number of readable text/url parts;
- preserve existing extraction for normal post messages;
- ignore content beyond the traversal budget instead of throwing.

## Testing

Add focused processor tests proving normal post extraction still works and
deeply nested post content beyond the traversal budget is ignored without
throwing.
