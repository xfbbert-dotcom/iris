# Iris Model Capacity User Degradation Design

## Status

Approved for implementation on 2026-07-13 as the next autonomous pilot quality improvement. The
user explicitly approved continuing this work without additional checkpoints unless a product or
architecture decision is required.

## Goal

When the configured model provider returns HTTP 429, Iris must tell the mentioned employee that the
model service has temporarily reached its usage limit instead of silently entering the event retry
path. Other provider failures must remain observable and retryable.

## Scope

This change is limited to synchronous answers triggered by an Iris mention in Feishu:

- classify non-success model HTTP responses with a typed, provider-independent error;
- convert only HTTP 429 into a concise Chinese reply;
- mark the mention handled after the fallback reply succeeds;
- retain existing retry behavior when the fallback reply itself fails; and
- keep timeouts, malformed responses, authentication failures, and 5xx responses unchanged.

Automatic model failover, quota polling, paid-plan changes, new operator alerts, retry-policy
changes, and admin UI work are out of scope.

## Alternatives

### A. Typed provider HTTP error (selected)

The model adapter throws a `ModelProviderHttpError` carrying the HTTP status and a bounded,
redacted diagnostic message. The Feishu responder recognizes status 429 through a type guard.

This keeps classification independent from provider message wording, preserves diagnostics for
operators, and gives future adapters one stable error contract.

### B. Parse the existing error string

The responder could search for `status 429` in `Error.message`. This avoids one source file but is
brittle: copy changes, localization, or another adapter can silently break the behavior. It is
rejected.

### C. Reply with a fallback for every model failure

This maximizes visible replies but turns authentication, timeout, malformed-response, and provider
outage failures into apparently normal operation. It would hide incidents and suppress useful
retries. It is rejected.

## Error Contract

`ModelProviderHttpError` belongs to the model boundary rather than the concrete OpenAI-compatible
adapter. It exposes a read-only numeric `statusCode`, has the name `ModelProviderHttpError`, and
retains the existing bounded and redacted diagnostic text in its message.

`isModelProviderCapacityError(error)` returns true only for a `ModelProviderHttpError` whose status
is 429. It does not inspect provider-controlled text and does not classify timeout errors or generic
errors that happen to mention 429.

The existing exact error message remains available to logs and tests. Provider response content is
never included in the employee-facing reply.

## Feishu Reply Contract

For a genuine model HTTP 429, Iris replies in the same thread with exactly:

> 模型服务暂时达到使用上限，我现在无法可靠回答。恢复后，请再 @我一次。

The wording deliberately avoids promising a reset time because a 429 may represent a per-minute,
per-day, project, or provider-specific limit.

After Feishu accepts the fallback reply, the original message ID is marked handled so callback
retries do not produce duplicate replies. If Feishu cannot send the fallback, the responder releases
the in-flight dedupe claim and throws, preserving the existing retry path.

All non-429 model errors continue to throw. The event worker can therefore retry them and eventually
surface them through its existing failure handling.

## Architecture Alignment

The architecture whitepaper remains unchanged. The new error type is an adapter-to-orchestrator
contract inside the existing TypeScript Core modular monolith. No service boundary, queue, storage,
retrieval, permission, or prompt-assembly behavior changes.

## Verification

- Provider tests prove that HTTP 429 produces the typed error with status 429 while preserving the
  bounded diagnostic message.
- Responder tests prove that typed 429 produces the exact Chinese fallback once and then dedupes the
  message.
- Responder tests prove that generic errors and typed non-429 responses still throw without sending
  a fallback.
- Existing blank-answer, failed-Feishu-reply, timeout, secret-redaction, and full Core test suites
  remain green.
