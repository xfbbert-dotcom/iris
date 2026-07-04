# Iris Internal API Token Guard Before Body Design

## Goal

Reject unauthorized internal operator requests before Core parses request bodies. A shared token
guard should be cheap and early, especially when Core shares an ingress with Feishu callbacks.

## Architecture

The internal API token guard runs as a Fastify `onRequest` hook instead of a `preHandler` hook.
This keeps the same authorization behavior for valid requests while ensuring malformed or large
unauthorized internal request bodies are rejected before JSON parsing.

## Invariants

- Unauthorized `/internal/*` requests return 401 before route handling.
- Unauthorized `/internal/*` requests with invalid JSON still return 401, not a JSON parse error.
- Authorized requests continue to reach normal JSON parsing and route validation.
- `/health` and `/feishu/events` remain outside this guard.

## Out Of Scope

- Body size limits.
- Rate limiting.
- Full admin identity.
