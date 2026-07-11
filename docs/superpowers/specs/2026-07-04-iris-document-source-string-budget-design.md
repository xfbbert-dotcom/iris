# Iris Document Source String Budget Design

## Goal

Prevent direct document source registry callers from storing oversized source URIs or metadata
strings when bypassing the internal API layer.

## Architecture

The internal document-source APIs already bound source URIs to `2048` characters and ordinary
metadata strings to `512` characters. The in-memory and Postgres document source registries now
share the same boundary:

- `sourceUri` must be non-blank and at most `2048` characters.
- Titles, group IDs, message IDs, user IDs, and space IDs must be at most `512` characters.
- Optional metadata still trims whitespace and disappears when blank.

The Postgres registry performs this validation before opening a transaction, so malformed direct
calls fail cheaply and cannot create oversized rows or evidence entries.

## Invariants

- Existing valid source registrations are unchanged.
- Blank required strings still fail with `DocumentSourceValidationError`.
- Duplicate evidence detection and source-type upgrade behavior remain unchanged.
- API-level Feishu URL normalization and source URI validation remain the first line of defense.

## Out Of Scope

- Changing source URI normalization rules.
- Validating that every registry source URI is a Feishu URL.
- Migrating or truncating legacy oversized database rows.
- Adding a per-source evidence count limit.
