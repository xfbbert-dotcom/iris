# Iris Feishu URL Marker Case Design

## Context

The Feishu document link extractor accepts `docx`, `docs`, and `wiki` path markers case-insensitively, but the body fetcher parsed those markers case-sensitively. A link could therefore be discovered and registered, then fail later when Iris tried to read it.

## Decision

Parse Feishu document URL path markers case-insensitively in the body fetcher while preserving the document token as provided.

## Scope

- Does not add new supported Feishu product paths.
- Does not normalize document tokens.
- Does not change host allowlisting.

## Quality Bar

- Uppercase `DOCX` and `WIKI` markers parse successfully.
- Unsupported nested paths remain unsupported.
- Body fetch requests still encode document tokens safely.
