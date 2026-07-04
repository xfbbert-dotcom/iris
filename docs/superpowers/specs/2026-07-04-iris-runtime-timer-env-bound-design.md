# Iris Runtime Timer Environment Bound Design

## Context

Iris now rejects timer delays above Node's `2147483647ms` limit inside external
adapter constructors and worker loop constructors. Environment config still
parses timer-related values as positive safe integers first, which means an
operator can receive a later runtime-construction error instead of an immediate
configuration-loading error.

## Decision

Environment readers must reject timer-bound values above `2147483647`:

- model provider timeout;
- embedding provider timeout;
- Feishu document fetch timeout;
- raw event worker interval;
- document sync worker interval;
- document reindex worker interval.

Non-timer values such as batch limits, embedding dimensions, and ports keep
their existing validation and product-specific bounds.

## Error Handling

Out-of-range timer environment values throw:

`<ENV_NAME> must not exceed 2147483647`

## Testing

Add focused env tests for request timeout and worker interval fields, then run
the env test suite and full verification.
