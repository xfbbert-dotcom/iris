# Iris Raw Source URL Budget Design

## Goal

Let admins and users paste real Feishu copied document links into internal registration APIs even
when the copied URL carries long disposable query strings or fragments.

## Architecture

The internal API separates two budgets:

- raw copied `sourceUri` input: 8192 characters before normalization;
- canonical document `sourceUri`: 2048 characters after Feishu URL normalization.

The raw budget exists only at the Fastify request parsing boundary. It is large enough for noisy
copied links, but still bounded by the API body-size limit. After normalization, the canonical URI
must pass the same Feishu document parser and document-source storage budget used by the rest of
Iris.

## Invariants

- Long query strings and fragments are stripped before runtime registration.
- Runtime registration and repositories continue to receive canonical source URIs only.
- Invalid Feishu paths, embedded credentials, HTTP links, token contamination, and oversized
  canonical URIs are still rejected as invalid requests.
- This does not change registry, Postgres, sync queue, or document fetcher contracts.

## Out Of Scope

- Increasing persisted document-source URI length.
- Accepting non-Feishu document URLs.
- Adding user-facing length-specific error codes.
