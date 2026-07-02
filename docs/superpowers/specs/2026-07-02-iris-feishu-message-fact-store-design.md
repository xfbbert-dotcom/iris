# Iris Feishu Message Fact Store Design

Date: 2026-07-02
Status: Phase 2U proposed design
Product name: Iris

## 1. Purpose

Phase 2T made Feishu callback ingestion reliable by introducing a Redis-backed raw event queue and worker foundation. The worker currently has a no-op processor. Phase 2U gives that worker its first real downstream behavior: convert supported Feishu message events into durable conversation message facts.

This is the first layer of Iris Conversation Memory. It stores what happened in a group chat as traceable facts, without summarizing, embedding, replying, or making agent decisions.

## 2. Design Goals

Phase 2U must provide:

- a conversation message domain model;
- a Postgres-backed conversation message repository;
- idempotent message persistence by provider and provider message ID;
- Feishu raw event processor for group message events;
- safe handling of unsupported raw events;
- recent-message lookup by chat ID;
- deterministic tests without requiring a live database for core processor behavior;
- runtime wiring so the raw event worker uses the message processor when configured.

The product goal is to let Iris reliably remember group chat messages as facts before building long-term memory, proactive behavior, or knowledge drafts.

## 3. Non-Goals

This phase does not implement:

- semantic indexing of chat messages;
- memory summarization;
- unresolved-thread detection;
- proactive actions;
- answer draft runtime integration;
- admin UI;
- message deletion and redaction flows;
- Feishu API backfill;
- cross-group memory sharing.

Those require a durable message fact layer first.

## 4. Data Model

Create a `conversation_messages` table:

```ts
{
  id: string;
  provider: "feishu";
  providerMessageId: string;
  chatId: string;
  senderId?: string;
  messageType: string;
  text?: string;
  sentAt: Date;
  rawEventIdempotencyKey: string;
  createdAt: Date;
}
```

Database columns:

```sql
id TEXT PRIMARY KEY,
provider TEXT NOT NULL,
provider_message_id TEXT NOT NULL,
chat_id TEXT NOT NULL,
sender_id TEXT,
message_type TEXT NOT NULL,
text TEXT,
sent_at TIMESTAMPTZ NOT NULL,
raw_event_idempotency_key TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
UNIQUE (provider, provider_message_id)
```

Indexes:

```sql
CREATE INDEX conversation_messages_chat_sent_at_idx
  ON conversation_messages (chat_id, sent_at DESC);
```

## 5. Repository Boundary

Create `ConversationMessageRepository`:

```ts
export type ConversationMessage = {
  id: string;
  provider: "feishu";
  providerMessageId: string;
  chatId: string;
  senderId?: string;
  messageType: string;
  text?: string;
  sentAt: Date;
  rawEventIdempotencyKey: string;
  createdAt: Date;
};

export type UpsertConversationMessageInput = {
  provider: "feishu";
  providerMessageId: string;
  chatId: string;
  senderId?: string;
  messageType: string;
  text?: string;
  sentAt: Date;
  rawEventIdempotencyKey: string;
};

export interface ConversationMessageRepository {
  upsertMessage(input: UpsertConversationMessageInput): Promise<ConversationMessage>;
  listRecentByChat(input: {
    chatId: string;
    limit: number;
  }): Promise<ConversationMessage[]>;
}
```

`upsertMessage()` is idempotent. If the same provider message ID is observed again, the repository returns the existing row or updates stable fields without creating duplicates.

## 6. Feishu Message Event Processor

Create `FeishuMessageEventProcessor` that implements:

```ts
process(event: RawEvent): Promise<void>;
```

Behavior:

1. Ignore non-Feishu events.
2. Parse only Feishu message events.
3. If the raw event is unsupported, return without throwing.
4. Extract message fields.
5. Persist via `ConversationMessageRepository.upsertMessage()`.

Supported Feishu shapes:

```ts
{
  header: {
    event_id: string;
    event_type: "im.message.receive_v1";
    create_time?: string;
  };
  event: {
    sender?: {
      sender_id?: {
        open_id?: string;
        union_id?: string;
        user_id?: string;
      };
    };
    message: {
      message_id: string;
      chat_id: string;
      message_type: string;
      content?: string;
      create_time?: string;
    };
  };
}
```

Text extraction:

- for `message_type = "text"`, parse `content` JSON and read `text`;
- for non-text messages, store `text` as undefined;
- malformed content should not throw; store undefined text.

Timestamp extraction:

- prefer `event.message.create_time` when present;
- then `header.create_time`;
- then `RawEvent.receivedAt`;
- Feishu millisecond timestamps should be parsed as numbers.

## 7. Runtime Wiring

`EventWorkerRuntime` currently uses a no-op processor. Phase 2U changes the default enabled runtime to compose:

```text
Redis raw event queue
Postgres conversation message repository
Feishu message event processor
Raw event worker
Raw event worker loop
```

The no-op processor can remain available only for tests through dependency injection.

Runtime dependencies should allow tests to inject:

- Redis client;
- Postgres pool;
- conversation message repository;
- worker loop;
- processor.

## 8. Internal APIs

No new public API is required in Phase 2U.

`GET /internal/events/status` continues to report worker status. Later phases can add:

```http
GET /internal/conversation/messages?chatId=...&limit=...
```

but this phase keeps message retrieval at the repository boundary.

## 9. Error Handling

Unsupported events:

- do not throw;
- are treated as successfully processed by the worker.

Malformed supported events:

- missing message ID or chat ID means unsupported; return without throwing;
- malformed text content stores undefined text;
- invalid timestamp falls back to `RawEvent.receivedAt`.

Repository failures:

- throw from processor;
- worker catches them;
- raw event queue handles retry/DLQ through Phase 2T behavior.

## 10. Testing Strategy

Migration tests:

- migration creates `conversation_messages`.

Repository tests:

- `upsertMessage()` inserts a message;
- repeated upsert with the same provider message ID does not duplicate;
- `listRecentByChat()` returns latest messages for one chat only.

Processor tests:

- text Feishu message event persists a conversation message;
- duplicate raw events call repository idempotently;
- non-text message persists without text;
- unsupported events do not throw and do not write;
- malformed text content does not throw;
- invalid timestamps fall back to received time.

Runtime tests:

- enabled event worker runtime composes Postgres repository and processor;
- runtime closes Redis and Postgres resources.

Final verification:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 11. Product Impact

After Phase 2U:

- Iris can persist Feishu group messages as durable facts;
- raw event processing has a real downstream behavior;
- future answer-draft, proactive, knowledge-draft, and memory extraction work can read from a trustworthy message fact layer;
- unsupported events remain safe and do not poison the raw event worker.
