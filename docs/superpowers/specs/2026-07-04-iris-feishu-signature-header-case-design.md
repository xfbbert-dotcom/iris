# Iris Feishu Signature Header Case Design

## Context

Feishu signature verification reads `X-Lark-*` callback headers before accepting
signed callbacks. Fastify usually normalizes incoming headers to lowercase, but
tests and direct adapter usage may provide canonical mixed-case names.

## Decision

Feishu auth header lookup must be case-insensitive:

- lowercase Fastify headers keep working;
- canonical mixed-case `X-Lark-*` headers also verify;
- missing or wrong signatures still fail closed;
- no product behavior changes outside header lookup compatibility.

## Testing

Add a Feishu auth regression test that signs a body and supplies mixed-case
signature headers. The test should fail before the lookup helper is hardened and
pass after the helper performs case-insensitive matching.
