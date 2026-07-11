# Iris Answer-Time Document Context Design

Date: 2026-07-02
Status: Phase 2F approved design
Product name: Iris

## 1. Purpose

Phase 2F connects Iris's semantic document fragments to answer-time prompt context.

Phase 2E made successful document snapshots searchable as fragments. Phase 2F adds the safe assembly path that retrieves candidate fragments for a user query, filters them through live permission checks, converts allowed fragments into background document context, and anchors recent group chat closest to the model response position.

This phase does not call a large language model. It produces the prompt context and retrieval metadata that a later answer orchestrator can use.

Constitutional alignment:

> Retrieval must re-check live permissions before document content reaches the model.
> Recent raw group messages must be treated as the context anchor and placed closest to the model's answer position.

## 2. Design Goals

Phase 2F must provide:

- a `DocumentRetrievalContextBuilder` for answer-time context preparation;
- a query embedding boundary compatible with the Phase 2E `EmbeddingProvider`;
- fragment retrieval through the existing fragment repository contract;
- live permission filtering before any fragment text enters prompt context;
- conversion of allowed fragments into `BackgroundDocument` entries;
- use of the existing `assemblePromptContext` function so `<live_chat_context>` remains last;
- structured metadata for allowed and denied fragments;
- deterministic tests with fake embedding, fake retrieval, and fake permission checks.

The builder should be narrow. It prepares context; it does not decide whether Iris should answer, and it does not generate the answer.

## 3. Out Of Scope

This phase does not implement:

- real LLM calls;
- real embedding provider calls;
- answer drafting or citation formatting in final messages;
- proactive response decisions;
- Feishu message sending;
- live Feishu permission API integration;
- ranking fusion across chat memory, document memory, and knowledge base;
- background job scheduling;
- UI.

Those features should attach to the context builder in later phases.

## 4. Core Flow

Answer-time document context follows this order:

```text
query text
-> embed query text
-> search document fragments
-> map retrieved fragments into permission-guard input
-> run live permission guard
-> convert allowed fragments to background documents
-> assemble prompt context with live chat as final anchor
-> return prompt context and retrieval metadata
```

Permission filtering is not optional. Candidate fragments must not enter `<background_documents>` unless the guard allows their document/source id.

## 5. Builder Contract

The builder input should include:

- `queryText`;
- `liveChatMessages`;
- optional `fragmentLimit`;
- optional `liveChatLimit`.

The builder dependencies should include:

- `embedder: Pick<EmbeddingProvider, "embedTexts">`;
- `fragments: Pick<DocumentFragmentRepository, "searchSimilarFragments">`;
- `canReadDocument(documentId: string): Promise<boolean>`;
- optional `auditLog`.

The builder output should include:

- `promptContext`;
- `allowedFragments`;
- `deniedDocumentIds`;
- `retrievedFragmentCount`.

`documentId` for the permission guard should use the fragment's `documentSourceId`, because document source is Iris's current permission boundary.

## 6. Context Formatting

Allowed fragments become background documents with stable source labels.

Recommended source label:

```text
<sourceUri>#chunk-<chunkIndex>
```

The text should be the fragment text exactly as stored, with XML escaping handled by `assemblePromptContext`.

The final prompt context must preserve this shape:

```xml
<background_documents>
  <document source="...">...</document>
</background_documents>

<live_chat_context>
  <message speaker="...">...</message>
</live_chat_context>
```

`<live_chat_context>` must remain closest to the model response position.

## 7. Error Handling

The builder must throw when:

- the query embedding provider returns zero vectors;
- the query embedding provider returns more than one vector for a single query;
- the query embedding contains invalid values.

The builder should return a valid prompt context when:

- search returns no fragments;
- all fragments are denied by the permission guard.

In those cases, `<background_documents>` is empty and live chat is still included.

Permission guard errors are treated as denied by the existing guard behavior and should be reflected in `deniedDocumentIds`.

## 8. Testing Strategy

Unit tests should cover:

- query text is embedded once;
- fragment search receives the query embedding and limit;
- allowed fragments enter `<background_documents>`;
- denied fragments do not enter prompt context;
- denied document ids are returned;
- permission checks are deduplicated by document/source id through the guard;
- live chat remains after background documents;
- no-fragment retrieval still returns live chat context;
- invalid query embeddings throw.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 9. Future Integration Points

Phase 2G can add one of:

- real answer orchestrator that calls an LLM using this prompt context;
- real embedding provider configuration;
- citations and evidence display in Iris responses;
- Feishu group reply sending;
- broader retrieval across group memory and authorized knowledge-base fragments.

Recommended next phase after 2F:

> Add an answer orchestrator that consumes the safe prompt context and returns a draft answer with citations, while still keeping high-impact actions behind approval.
