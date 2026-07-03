# Iris Idempotency Key Blank Guard Design

## Problem

Queue idempotency key factories trim IDs before composing stable keys. If a caller accidentally passes whitespace-only IDs, the factories currently produce keys with empty suffixes such as `document-sync:` or `raw-event:feishu:`.

Those keys are technically nonempty, so queue-level dedupe accepts them. In an abnormal caller path, multiple unrelated blank-ID jobs could collapse into one key and hide work.

## Requirements

- Preserve trimming and stable key composition for valid IDs.
- Reject whitespace-only raw event IDs.
- Reject whitespace-only document source IDs.
- Reject whitespace-only reindex profile and snapshot IDs.
- Fail fast with clear field-specific errors.

## Non-goals

- Do not change queue enqueue APIs in this patch.
- Do not change Redis serialization formats.
- Do not change normal runtime behavior for valid IDs.

## Acceptance

- Existing valid key tests keep passing.
- Blank key inputs throw explicit errors before enqueueing can occur.
- Full test and typecheck suites remain green.
