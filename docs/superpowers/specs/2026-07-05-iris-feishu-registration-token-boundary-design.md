# Iris Feishu Registration Token Boundary Design

## Goal

Prevent Feishu document source URIs submitted through manual or internal registration paths from
absorbing adjacent prose into the document token.

## Decision

The shared Feishu document token parser rejects docx/docs/wiki token segments that contain an ASCII
comma or percent-encoded ASCII comma. Document source registration uses this parser before
canonicalizing and writing a source, so `https://docs.feishu.cn/docx/token,please` is rejected
instead of becoming a pending document source.

## Invariants

- Group chat discovery, authorized wiki registration, user-submitted registration, permission checks,
  and document body fetching share the same Feishu token boundary.
- Supported Feishu and Lark hosts remain unchanged.
- Query strings and fragments are still stripped during registration canonicalization.
- Invalid Feishu tokens fail before registry writes and before sync queue enqueue.
- Percent-encoding cannot bypass the comma boundary.

## Out Of Scope

- Expanding supported Feishu URL shapes.
- Replacing live Feishu permission checks.
- Inferring and auto-correcting malformed manually submitted URLs.
