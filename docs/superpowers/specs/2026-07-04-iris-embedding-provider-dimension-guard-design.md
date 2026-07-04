# Iris Embedding Provider Dimension Guard Design

## Goal

Reject OpenAI-compatible embedding responses whose vector length does not match the configured
embedding dimensions.

## Architecture

`createOpenAICompatibleEmbeddingProvider` already validates response counts, optional response
indices, and finite numeric vector values. When `config.dimensions` is configured, the provider now
also checks each returned vector length against that configured dimension before returning vectors
to callers.

This is an early provider-boundary check. The document fragment repository still validates vectors
against the active embedding profile before writes or vector search, so this change adds clearer
external-provider diagnostics without removing the lower-level safety net.

## Invariants

- Empty input still returns an empty vector list without calling `fetch`.
- Unconfigured dimensions continue to omit the `dimensions` request field and skip length checks.
- Count mismatch, invalid indices, invalid numeric values, non-2xx responses, and timeouts keep
  their existing behavior.
- Configured dimension mismatches fail before vectors can enter indexing or retrieval flows.

## Out Of Scope

- Inferring dimensions when `config.dimensions` is omitted.
- Changing supported runtime embedding dimensions.
- Changing document fragment repository vector validation.
- Retrying provider responses with bad dimensions.
