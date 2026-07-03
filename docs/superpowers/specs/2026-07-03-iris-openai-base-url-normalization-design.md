# Iris OpenAI-Compatible Base URL Normalization Design

## Problem

OpenAI-compatible model and embedding providers built endpoint URLs by directly appending
paths to `config.baseUrl`. If the configured base URL ended with a slash, requests used
double slashes such as:

- `https://api.example.com/v1//chat/completions`
- `https://api.example.com/v1//embeddings`

Many providers tolerate this, but some gateways and proxies do not. Operators also commonly
copy base URLs with trailing slashes.

## Decision

Normalize endpoint construction in both providers by stripping trailing slashes from
`baseUrl` before appending the fixed endpoint path.

## Non-Goals

- Do not validate URL syntax in this patch.
- Do not change provider request bodies.
- Do not change timeout, error parsing, or response parsing behavior.

## Quality Bar

- Model provider maps `https://api.example.com/v1/` to
  `https://api.example.com/v1/chat/completions`.
- Embedding provider maps `https://api.example.com/v1/` to
  `https://api.example.com/v1/embeddings`.
- Existing request bodies and headers remain unchanged.
