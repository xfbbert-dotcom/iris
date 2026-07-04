# Iris Document Registration API URL Gate Design

## Context

Group chat document discovery already filters Feishu links before registering document sources. The internal registration APIs for authorized wiki documents and user-submitted documents only checked that `sourceUri` was non-blank, so unsupported links could be registered and queued even though the current Feishu body fetcher could not read them.

For the first 20-30 person rollout, registration should fail early when Iris cannot read the document.

## Decision

The internal document registration APIs must validate `sourceUri` with the same Feishu parsing helpers used by the body fetcher. A source URI is accepted only when it resolves to a Feishu `docx`, `docs`, or `wiki` token that the fetcher can later read. URLs with embedded username/password credentials must be rejected through the same invalid-request path.

Accepted source URIs are normalized before they reach the document sync runtime by removing URL
query strings and fragments. This keeps manual registration aligned with group-chat link discovery
and prevents copied links from creating duplicate document sources for the same document path.

## Scope

This only gates the current Feishu-backed document registration APIs. Future support for uploaded files, PDFs, or external URLs should add explicit fetchers and registration paths rather than weakening this gate.

## Quality Bar

- Unsupported authorized wiki document URLs return `400 invalid_request`.
- Unsupported user-submitted document URLs return `400 invalid_request`.
- URLs with embedded username/password credentials return `400 invalid_request`.
- Copied links with query strings or fragments call the runtime with a canonical path-only
  `sourceUri`.
- Valid existing docx/wiki registration flows continue to call the runtime unchanged.
