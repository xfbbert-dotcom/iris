# Iris Permission Wiki Token Validation Design

Status: approved by autonomous maintenance scope

## Context

Iris performs a real-time permission guard before retrieved document fragments are passed to the
answer model. For Feishu wiki URLs, the permission checker resolves the wiki node to a doc/docx
object token, then checks document metadata access.

The document body fetcher already rejects contaminated Feishu document tokens that include comma or
percent characters. The permission checker currently only checks that resolved wiki object tokens are
nonblank and at most 512 characters. This creates a small inconsistency: a wiki token resolved to a
contaminated document token can reach the metadata permission endpoint even though the body fetcher
would reject the same token.

## Decision

Make the permission checker fail closed for resolved wiki object tokens that violate the same token
shape rules used by document body fetching:

- token must be a string;
- token must be nonblank after trimming;
- token must be at most 512 characters;
- token must not include comma;
- token must not include percent.

This is intentionally narrower than a broader token parser refactor. The goal is to align the live
permission guard with existing Feishu body-fetch safety semantics without changing public APIs or
document retrieval policy.

## Behavior

When `createFeishuDocumentPermissionChecker().canReadSource()` resolves a wiki node:

- valid `doc` and `docx` object tokens continue to be checked via document metadata;
- unsupported object types continue to return `false`;
- oversized, blank, comma-contaminated, or percent-contaminated object tokens return `false`;
- the checker must not perform a document metadata request for invalid resolved tokens.

## Testing

Add a focused test in `apps/core/tests/feishu-document-permission-checker.test.ts` that returns a
successful wiki node response with a contaminated `obj_token`, configures any second fetch to look
readable, and asserts:

- `canReadSource()` resolves `false`;
- only the wiki node request is made.

Then update `apps/core/src/permissions/feishu-document-permission-checker.ts` with the minimal token
validation change and run the focused test, related permission tests, and full verification.
