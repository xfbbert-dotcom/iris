# Iris Feishu Group Document Link Discovery Design

Date: 2026-07-02
Status: Phase 2W design

## Goal

Phase 2W lets Iris discover Feishu document links inside group chat messages and register them as `group_visible_document` sources. This connects Iris's group conversation memory to the document source registry so later phases can fetch, parse, index, and cite document bodies.

This phase is discovery and registration only. It does not read document bodies, run embeddings, or decide final Feishu read permissions.

## Scope

In scope:

- Extract Feishu/Lark document URLs from text messages.
- Register extracted URLs as group-visible document sources.
- Preserve source evidence: `chatId`, `messageId`, sender id, and observed timestamp.
- Keep Feishu Gateway ack-first; discovery runs in the async raw event worker path.
- Keep registration idempotent across Feishu event retries and repeated links in a message.

Out of scope:

- Fetching document bodies through Feishu APIs.
- Parsing document tokens into Feishu API resource IDs.
- Permission verification beyond recording local unknown state.
- Rich card or attachment parsing.
- Knowledge-base space authorization.

## Link Extraction

Add `FeishuDocumentLinkExtractor`.

The extractor accepts plain text and returns normalized candidate URLs. It should support:

- `https://docs.feishu.cn/...`
- `https://*.feishu.cn/...`
- `https://*.larksuite.com/...`

The first version deliberately avoids guessing document type from opaque path details. It only decides whether the host is a supported Feishu/Lark host and returns a clean URL without trailing punctuation commonly found in chat text.

The extractor should deduplicate repeated URLs within the same message while preserving discovery order.

## Registration

Add `GroupVisibleDocumentRegistrar`.

The registrar accepts:

- `chatId`
- `messageId`
- optional `senderId`
- `observedAt`
- extracted links

For each link, it calls `registerGroupVisibleDocument`.

The existing `DocumentSourceRegistry` already deduplicates sources by `sourceUri` and deduplicates evidence by evidence key. Phase 2W extends group-visible registration with optional sender evidence so the fact layer can trace which user posted the document link.

The input name is `observedByUserId` to avoid implying document authorship. It means only "this user posted or surfaced the link in the group."

## Event Worker Integration

`FeishuMessageEventProcessor` remains responsible for turning Feishu message raw events into message facts. After successfully parsing a text message, it should:

1. upsert the message fact;
2. extract supported document links from the parsed text;
3. register each discovered link as a group-visible document source.

If message parsing returns no text, document discovery is skipped.

If registration fails, processing fails so the raw event worker can retry and eventually dead-letter the event. Silent failure would break the evidence chain.

## Idempotency

Idempotency is required at two layers:

- The extractor deduplicates identical normalized URLs in a single message.
- The registry deduplicates source/evidence records across retries.

This means a Feishu retry of the same message event should not create duplicate document sources or duplicate evidence entries.

## Permissions

Phase 2W records local evidence only. It does not authorize document content for model context.

New sources start with `permissionState = "unknown"` and `syncState = "pending"` through the existing registry defaults. Later body-fetch and answer-time retrieval phases must still run Feishu permission checks before content enters the model prompt.

## Testing

Tests must cover:

- extracting supported Feishu/Lark URLs and ignoring unrelated URLs;
- trimming trailing punctuation and deduplicating repeated links;
- registrar calling group-visible registration with chat/message/user evidence;
- event processor registering document links after message upsert;
- event processor skipping registration for non-text or unsupported messages.

## Constitutional Alignment

This phase implements the whitepaper rule that documents appearing in groups where Iris is present must be registered as group-visible document sources before they can be fetched and indexed. It keeps Gateway lightweight, preserves fact-layer traceability, and does not bypass live permission checks.
