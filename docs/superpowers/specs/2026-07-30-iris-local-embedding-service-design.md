# Iris Local Embedding Service Design

## Goal

Remove Gemini embedding quota from the Iris knowledge-retrieval critical path while preserving the
existing provider boundary, permission guard, retrieval behavior, and answer-generation model.
The first internal release must index and query the authorized Feishu knowledge space without a
paid embedding API or a daily request ceiling.

## Context

The complete Feishu wiki-space scan discovered 18 nodes and registered 17 supported documents.
Indexing then exhausted the shared Gemini free-tier metric
`embed_content_free_tier_requests` at 100 requests. Switching between
`gemini-embedding-2` and `gemini-embedding-001` did not create independent quota because Google
accounts both models against the same metric.

The current architecture already treats embeddings as an OpenAI-compatible provider. Replacing
the remote endpoint with an internal OpenAI-compatible service is therefore an implementation and
deployment change, not an amendment to the Iris architecture constitution.

## Decision

Run Ollama inside the pilot Docker Compose stack and serve
`embeddinggemma:300m-qat-q4_0` through its OpenAI-compatible `/v1/embeddings` endpoint.

- Ollama image: `ollama/ollama:0.32.0`, pinned to immutable image digest
  `sha256:57f573b47f1f71ebb445789f279fe3e596a8beab182f7cf486db9205bad87c5a`.
- Model tag: `embeddinggemma:300m-qat-q4_0`.
- Expected Ollama model-manifest SHA256:
  `101341d65c2ccbf23f16650b79d30b9fca94a45ffa09a9984c600157b81a58df`.
- Model size: approximately 239 MB.
- Embedding dimensions: 768.
- Index batch size: 4.
- Provider deadline: 60 seconds per batch.
- Exposure: Docker `backend` network only, with no host or edge port.
- Concurrency: one loaded model and one parallel request on the 2-core pilot VPS.
- Idle retention: 30 minutes, allowing the model to release memory between indexing bursts.

EmbeddingGemma supports Chinese and more than 100 languages. Iris applies the model's asymmetric
retrieval format only when that model is active: documents use
`title: none | text: <content>`, while queries use
`task: search result | query: <question>`. Other embedding profiles receive their original input
unchanged.

The initial local candidate, Qwen3 Embedding 0.6B, was rejected after production-shaped
benchmarking. Under the pilot's exact 1.5 CPU and 1.5 GiB limit, one 1,200-character Chinese chunk
took 54-70 seconds and exceeded the 30-second client deadline. EmbeddingGemma completed the full
374-chunk ten-page corpus in about three minutes with batches of four, and the Life Engine title,
description, and exact marker queries all ranked the intended source first. This is an
implementation correction inside the approved provider boundary, not a new architecture.

## Components

### Model seed job

`embedding-model-init` is a one-shot Compose service with the model volume and outbound-only
`model-egress` network. It starts a temporary local Ollama server, uses the cached model when it is
already present, otherwise pulls the approved model, and verifies the full SHA256 of Ollama's
stored model manifest. A manifest mismatch fails the job.

The seed job never receives Iris, Feishu, database, or model-provider credentials.

### Runtime embedding service

`embedding-model` starts only after the seed job succeeds. It mounts the same model volume and
joins only the internal `backend` network. It has no public port and no internet-egress network.
Its health check requires the approved model to be visible and its full stored manifest SHA256 to
match.

Core depends on `embedding-model` being healthy. A missing, corrupt, or unapproved model therefore
prevents Core startup instead of silently producing an incomplete index.

### 768-dimensional storage

Migration `0043_document_fragment_embeddings_768.sql` creates
`document_fragment_embeddings_768`, following the existing 6-, 1024-, and 1536-dimensional storage
pattern. The fragment repository routes profiles with dimension 768 to that table, and the runtime
dimension guard accepts 768.

Embedding profiles remain model-specific. Existing Gemini and Qwen fragments are retained for
audit and rollback but cannot be mixed with EmbeddingGemma vectors because retrieval always
selects the exact active profile.

## Data Flow

1. The wiki scanner resolves the authorized Feishu `space_id`, traverses every top-level tree, and
   registers supported pages.
2. Document sync fetches each page after the existing Feishu permission checks and stores the
   latest successful snapshot.
3. The reindex worker applies the EmbeddingGemma document format and sends batches of at most four
   to
   `http://embedding-model:11434/v1/embeddings`.
4. EmbeddingGemma returns 768-dimensional normalized vectors.
5. Iris writes vectors under profile
   `openai-compatible:embeddinggemma:300m-qat-q4_0:768`.
6. Answer-time query embeddings use the query format, same endpoint, and exact profile.
7. The real-time Feishu permission guard still removes unauthorized candidates before model
   context is assembled.

## Failure Behavior

- Model seed failure, model ID mismatch, or runtime health failure blocks Core startup.
- Embedding request failures use the existing bounded retry and DLQ flow.
- A new DLQ aborts the migration immediately; the operator does not wait for a 30-minute zero gate
  that cannot succeed.
- Iris never falls back to static development vectors, stale Gemini vectors, keyword guessing, or
  Feishu-native "related knowledge" decorations.
- Public ingress and global runtime activation remain last-step gates after index and permission
  acceptance.
- Old-profile DLQ entries may be deleted only after their full identifiers and failure
  classification are recorded and the new profile has been selected. Latest successful snapshots
  are then re-planned for the new exact profile.

## Security And Resource Boundaries

- The runtime model has no edge port and no egress network.
- The seed job has egress but no application secrets and exits after model verification.
- The service is limited to one parallel request and one loaded model.
- The selected 239 MB model stays near 403 MiB after a clean load. A final four-input,
  1,200-character acceptance batch completed under the exact 768 MiB limit at 580.9 MiB with no
  OOM, so it fits the pilot host's 3.6 GB RAM and 1.9 GB swap alongside Core, Postgres, Redis, and
  AI Worker.
- Answer generation and semantic memory extraction continue to use their existing providers and
  credentials; this change handles embeddings only.

## Acceptance Gates

1. Focused tests prove 768-dimensional insert, replacement, and similarity search routing plus
   model-scoped document/query formatting.
2. Compose tests prove immutable image pinning, full model-manifest SHA256 verification, network
   isolation, no host port, bounded resources, and Core's healthy dependency.
3. Full `npm run verify` passes.
4. Exact-SHA Core and AI Worker GitHub checks pass.
5. On the VPS, repository, Core image, and AI Worker image report the same approved SHA.
6. Ollama reports the approved model-manifest SHA256 and returns four ordered, document-prefixed,
   768-dimensional unit vectors under the same 60-second deadline used by Core.
7. The authorized wiki space reaches `synced`; event, document, reindex, and memory queues and DLQs
   all reach zero.
8. Every latest successful wiki snapshot has fragments for the EmbeddingGemma profile.
9. An internal query for the Life Engine material retrieves the intended page while global runtime
   and Caddy remain disabled.
10. Only after those gates pass may global runtime and Caddy be restored for real Feishu
    acceptance.

## Rollback

Keep Caddy stopped and global runtime disabled. Restore the previous `.env.pilot`, approved image
SHA, and paired Postgres/Redis backup. The 768-dimensional table is additive and does not alter or
delete the existing 1024-dimensional Qwen table or any prior profile data, so the previous Core
image can ignore it safely.
