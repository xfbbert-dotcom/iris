# Iris Internal API Loopback Fallback Design

## Goal

Prevent a locally started Iris Core process from exposing unauthenticated `/internal/*` operator
APIs to the host network when `IRIS_INTERNAL_API_TOKEN` is missing.

## Context

The existing bearer guard is intentionally optional so tests and local development can use
`buildApp()` without credentials. The direct server entry point nevertheless always listens on
`0.0.0.0`. That combination makes a forgotten token reachable from every host interface even though
rollout readiness already treats the token as mandatory.

## Considered Approaches

1. Require a token for every direct server start. This is the strongest rule, but it removes the
   documented credential-free local development path.
2. Bind to loopback when the token is absent, and bind to all interfaces only when a valid token is
   configured. This preserves local development while making accidental network exposure fail safe.
3. Require the token only when `NODE_ENV=production`. This keeps development convenient, but relies
   on another environment variable being configured correctly and leaves ambiguous deployments open.

## Decision

Use approach 2. The direct Core server entry point resolves its listen host from the same normalized
internal API token used by the request guard:

- missing or blank token: listen on `127.0.0.1`;
- valid token: listen on `0.0.0.0`;
- malformed configured token: reject startup through the existing token validator.

`buildApp()` remains embeddable and keeps its existing optional-token behavior. `/health` and
`/feishu/events` remain outside the internal bearer guard. Deployments that need container, private
network, or public callback ingress must configure a valid token, which rollout readiness already
requires.

## Verification

- Unit coverage must prove the host selection for missing, blank, and valid token values.
- Existing internal API authorization tests must remain green.
- Full Core tests, type checking, Python worker tests, and Compose validation must remain green.

## Out Of Scope

- Operator accounts or role-based access control.
- Separate listener ports for public and internal routes.
- Token rotation or secret distribution.
