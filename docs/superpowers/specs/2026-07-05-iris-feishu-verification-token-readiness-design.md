# Iris Feishu Verification Token Readiness Design

## Problem

The v1 readiness check allowed Feishu callback authentication to pass when only
`FEISHU_ENCRYPT_KEY` was configured.

That is too optimistic for the first internal rollout. Iris can use the encrypt key for request
signature verification, but v1 does not decrypt encrypted Feishu callback payloads. During Feishu URL
verification, Iris must be able to read the `challenge` field from the parsed callback body.

## Decision

For v1 rollout readiness:

- `FEISHU_VERIFICATION_TOKEN` is required;
- `FEISHU_ENCRYPT_KEY` is optional and only adds signature verification for non-encrypted callback
  bodies;
- readiness must fail when the verification token is missing, even if an encrypt key is present.

For runtime request verification:

- when only `FEISHU_VERIFICATION_TOKEN` is configured, the callback body token must match;
- when only `FEISHU_ENCRYPT_KEY` is configured, the callback signature must match;
- when both are configured, both the token and signature must match. The encrypt key is an
  additional guard, not an alternative path that bypasses token validation.

## Non-Goals

- Do not remove signature verification support.
- Do not implement encrypted callback body decryption in this patch.
- Do not change gateway acknowledgement behavior.

## Quality Bar

- A token-only configuration can pass readiness.
- A token plus encrypt-key configuration can pass readiness.
- An encrypt-key-only configuration fails readiness with an actionable explanation.
- Runtime verification rejects token-only callbacks when an encrypt key is configured.
- Runtime verification rejects signed callbacks whose body token does not match when a verification
  token is configured.
