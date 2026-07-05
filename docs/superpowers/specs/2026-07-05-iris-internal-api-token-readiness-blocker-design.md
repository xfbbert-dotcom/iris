# Iris Internal API Token Readiness Blocker Design

## Goal

Prevent the first internal rollout from being marked ready while `/internal/*` operator APIs are
missing the shared bearer-token guard.

## Decision

`IRIS_INTERNAL_API_TOKEN` is a blocking readiness requirement for the 20-30 person rollout profile.
If the token is missing or blank, readiness returns `blocked` with a failed `internalApiToken` check.

The Core service should still run without the token for local development and tests, but the rollout
readiness contract must not call that configuration ready.

## Invariants

- `/health` and `/feishu/events` remain outside the internal bearer-token guard.
- `/internal/*` token format still requires one visible ASCII value without whitespace or commas.
- Placeholder token values fail readiness.
- Trusted private networking is still required, but it is not a replacement for the internal API
  token during rollout readiness.

## Out Of Scope

- Replacing the shared token with full operator identity.
- Adding a browser Admin Console login flow.
- Changing Feishu callback authentication.
