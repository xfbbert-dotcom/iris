# Iris Server Listen Security Boundaries Design

## Goal

Prevent direct Iris Core startup from exposing an unauthenticated Feishu callback endpoint when the
internal operator token is configured but `FEISHU_VERIFICATION_TOKEN` is missing.

## Context

Core has two independent ingress security boundaries:

- `/internal/*` uses `IRIS_INTERNAL_API_TOKEN`;
- `/feishu/events` uses Feishu callback verification.

The first loopback fallback checked only the internal API token. Because `buildApp()` intentionally
skips Feishu verification when no Feishu callback secret is configured, an internal-token-only
process could still listen on `0.0.0.0` with an unauthenticated callback endpoint.

## Considered Approaches

1. Require both v1 tokens before non-loopback listening. This keeps credential-free development on
   loopback and makes accidental network exposure fail safe across both ingress boundaries.
2. Always reject Feishu callbacks when callback auth is absent. This is stronger at the route layer,
   but changes the established local and injected `buildApp()` behavior across many tests.
3. Refuse every direct server startup unless the full rollout profile passes. This conflates startup
   with readiness and would block focused local development of partially configured components.

## Decision

Use approach 1. `resolveServerListenHost` receives both the internal API token and Feishu verification
token:

- both values non-blank and the internal token valid: `0.0.0.0`;
- either value missing or blank: `127.0.0.1`;
- malformed internal token: startup fails through the existing validator.

`FEISHU_ENCRYPT_KEY` alone is not sufficient for non-loopback v1 startup. The approved rollout
contract requires `FEISHU_VERIFICATION_TOKEN` because Iris reads the URL-verification challenge from
the unencrypted callback body and does not yet decrypt encrypted callback payloads.

The request guards themselves remain unchanged. `buildApp()` keeps its optional auth behavior for
tests and embedded local use, and `/health` remains unauthenticated.

## Verification

- Unit coverage must prove that either single-token configuration stays on loopback.
- Unit coverage must prove that both required tokens permit all-interface listening.
- Existing malformed internal-token coverage must remain green.
- A direct-start smoke test must observe the selected Windows listener address.
- Full repository verification and GitHub CI must pass.

## Out Of Scope

- Encrypted Feishu callback body support.
- Full operator identity or role-based access control.
- Separate public and private listener ports.
