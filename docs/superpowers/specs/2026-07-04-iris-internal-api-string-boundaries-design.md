# Iris Internal API String Boundaries Design

## Goal

Prevent oversized internal API strings from entering Iris runtime controls, document source
operations, dead-letter operations, audit filters, or manual registration paths.

## Architecture

Add explicit length bounds at the Fastify internal API parsing layer. Keep the change local to
`apps/core/src/app.ts` so lower-level runtime and repository contracts do not change.

Use three limits:

- Internal IDs and human labels: 512 characters.
- Manually submitted raw Feishu document URLs: 8192 characters before Feishu URL normalization.
- Canonical document source URIs: 2048 characters after Feishu URL normalization, before they are
  persisted or passed to lower-level runtime contracts.

All existing blank-string behavior remains unchanged: blank values are invalid where a value is
required and omitted where an optional filter is absent. Oversized values are invalid and return the
same `400 { ok: false, error: "invalid_request" }` shape as other invalid internal API input.

## Invariants

- Oversized chat IDs, group filter IDs, document source IDs, snapshot IDs, DLQ IDs, titles, and
  operator hints do not reach runtime or audit mutation calls.
- Pathologically oversized raw source URL submissions do not reach Feishu URL normalization.
- Canonicalized source URIs that still exceed the document-source storage budget do not reach
  document-source registration.
- Copied Feishu links whose excess length is only disposable query strings or fragments can still
  be normalized to a valid canonical source URI.
- Valid existing IDs, titles, source URIs, and operator hints continue to work.
- Production document source and runtime behavior after parsing is unchanged.

## Out Of Scope

- Changing public Feishu callback event ID bounds.
- Overriding Fastify's own path-length protection for very long route params.
- Changing database schema column sizes.
- Adding a new user-facing error code for length-specific failures.
