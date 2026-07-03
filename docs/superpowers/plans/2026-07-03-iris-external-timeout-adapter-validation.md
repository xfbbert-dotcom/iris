# Iris External Timeout Adapter Validation Plan

## Goal

Prevent direct adapter construction from bypassing timeout numeric safety.

## Tasks

- [x] Add failing tests for invalid timeout values in model, embedding, Feishu
  tenant token, and Feishu document body adapters.
- [x] Add a shared positive-safe-integer guard.
- [x] Validate timeout values during adapter construction before request logic
  can run.
- [x] Update the architecture whitepaper numeric safety guardrail.

## Verification

- `npm test -- tests/openai-compatible-model-provider.test.ts tests/openai-compatible-embedding-provider.test.ts tests/feishu-tenant-access-token-provider.test.ts tests/feishu-document-body-fetcher.test.ts`
