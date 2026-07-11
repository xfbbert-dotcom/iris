# Iris Feishu Live Permission Fail-Closed Design

## Goal

Prevent cached Feishu document fragments from entering model context when answer-time live permission
checks are unavailable.

## Architecture

In `source-policy` retrieval, Iris first applies local source policy and runtime capability checks.
For Feishu docx/docs/wiki URLs, local policy is necessary but not sufficient: Iris must also run the
Feishu live permission checker before injecting fragments into prompt context.

If the source is a Feishu docx/docs/wiki URL and no live permission checker is configured, Iris
fails closed for that document. This preserves the architecture rule that cached permission state can
accelerate recall but cannot authorize final context injection.

## Invariants

- `allow-indexed` remains the development mode that can use indexed fragments without source policy.
- `source-policy` locally denied, stale, disabled, or missing sources remain denied.
- Feishu docx/docs/wiki fragments require live permission checks before prompt injection.
- Missing Feishu OpenAPI credentials deny Feishu document fragments instead of trusting cached facts.
- Unsupported non-Feishu URLs continue to rely on local policy until a matching live checker exists.

## Out Of Scope

- Adding a dedicated Permission Guard Service.
- Caching live permission probe results.
- Changing document sync permission behavior.
