# Iris Feishu Message Fact Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist supported Feishu message raw events into a durable conversation message fact store.

**Architecture:** Add a `conversation` module with a repository interface and Postgres implementation, then add a Feishu raw event processor that writes supported message events through that repository. Wire the existing event worker runtime to use the processor by default while preserving dependency injection for tests.

**Tech Stack:** TypeScript, Postgres migrations, Vitest, existing Iris migration runner, existing raw event worker runtime.

---

## File Structure

- Create `apps/core/src/conversation/conversation-message-repository.ts`: domain types and repository interface.
- Create `apps/core/src/conversation/postgres-conversation-message-repository.ts`: Postgres implementation.
- Create `apps/core/src/conversation/feishu-message-event-processor.ts`: raw event processor.
- Add migration `apps/core/migrations/0012_conversation_messages.sql`.
- Modify `apps/core/src/runtime/event-worker-runtime.ts`: compose Postgres repository and processor.
- Tests:
  - `apps/core/tests/conversation-message-repository.test.ts`
  - `apps/core/tests/postgres-conversation-message-repository.test.ts`
  - `apps/core/tests/feishu-message-event-processor.test.ts`
  - `apps/core/tests/event-worker-runtime.test.ts`
  - `apps/core/tests/migration-runner.test.ts`

## Task 1: Conversation Message Repository And Migration

**Files:**
- Create: `apps/core/src/conversation/conversation-message-repository.ts`
- Create: `apps/core/src/conversation/postgres-conversation-message-repository.ts`
- Create: `apps/core/migrations/0012_conversation_messages.sql`
- Test: `apps/core/tests/conversation-message-repository.test.ts`
- Test: `apps/core/tests/postgres-conversation-message-repository.test.ts`
- Test: `apps/core/tests/migration-runner.test.ts`

- [ ] **Step 1: Write repository interface tests with a fake queryable**

Create `apps/core/tests/postgres-conversation-message-repository.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  createPostgresConversationMessageRepository,
  type Queryable,
} from "../src/conversation/postgres-conversation-message-repository.js";

describe("PostgresConversationMessageRepository", () => {
  it("upserts conversation messages", async () => {
    const queryable = fakeQueryable([
      {
        id: "feishu:message-1",
        provider: "feishu",
        provider_message_id: "message-1",
        chat_id: "chat-1",
        sender_id: "user-1",
        message_type: "text",
        text: "Hello",
        sent_at: new Date("2026-07-02T01:00:00.000Z"),
        raw_event_idempotency_key: "raw-event:feishu:event-1",
        created_at: new Date("2026-07-02T01:00:01.000Z"),
      },
    ]);
    const repository = createPostgresConversationMessageRepository({ queryable });

    await expect(
      repository.upsertMessage({
        provider: "feishu",
        providerMessageId: "message-1",
        chatId: "chat-1",
        senderId: "user-1",
        messageType: "text",
        text: "Hello",
        sentAt: new Date("2026-07-02T01:00:00.000Z"),
        rawEventIdempotencyKey: "raw-event:feishu:event-1",
      }),
    ).resolves.toMatchObject({
      id: "feishu:message-1",
      providerMessageId: "message-1",
      chatId: "chat-1",
      text: "Hello",
    });
    expect(queryable.query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT"), expect.any(Array));
  });

  it("lists recent messages by chat", async () => {
    const queryable = fakeQueryable([
      {
        id: "feishu:message-2",
        provider: "feishu",
        provider_message_id: "message-2",
        chat_id: "chat-1",
        sender_id: null,
        message_type: "text",
        text: "Second",
        sent_at: new Date("2026-07-02T01:01:00.000Z"),
        raw_event_idempotency_key: "raw-event:feishu:event-2",
        created_at: new Date("2026-07-02T01:01:01.000Z"),
      },
    ]);
    const repository = createPostgresConversationMessageRepository({ queryable });

    await expect(repository.listRecentByChat({ chatId: "chat-1", limit: 20 })).resolves.toEqual([
      {
        id: "feishu:message-2",
        provider: "feishu",
        providerMessageId: "message-2",
        chatId: "chat-1",
        senderId: undefined,
        messageType: "text",
        text: "Second",
        sentAt: new Date("2026-07-02T01:01:00.000Z"),
        rawEventIdempotencyKey: "raw-event:feishu:event-2",
        createdAt: new Date("2026-07-02T01:01:01.000Z"),
      },
    ]);
    expect(queryable.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE chat_id = $1"),
      ["chat-1", 20],
    );
  });
});

function fakeQueryable(rows: unknown[]): Queryable {
  return {
    query: vi.fn(async () => ({ rows })),
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- postgres-conversation-message-repository.test.ts
```

Expected: FAIL because repository files do not exist.

- [ ] **Step 3: Implement repository types**

Create `apps/core/src/conversation/conversation-message-repository.ts`:

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
  listRecentByChat(input: { chatId: string; limit: number }): Promise<ConversationMessage[]>;
}
```

- [ ] **Step 4: Implement Postgres repository**

Create `apps/core/src/conversation/postgres-conversation-message-repository.ts`:

```ts
import type {
  ConversationMessage,
  ConversationMessageRepository,
  UpsertConversationMessageInput,
} from "./conversation-message-repository.js";

export type Queryable = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export function createPostgresConversationMessageRepository({
  queryable,
}: {
  queryable: Queryable;
}): ConversationMessageRepository {
  return {
    async upsertMessage(input) {
      const id = `${input.provider}:${input.providerMessageId}`;
      const result = await queryable.query<ConversationMessageRow>(
        `
        INSERT INTO conversation_messages (
          id,
          provider,
          provider_message_id,
          chat_id,
          sender_id,
          message_type,
          text,
          sent_at,
          raw_event_idempotency_key
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (provider, provider_message_id)
        DO UPDATE SET
          chat_id = EXCLUDED.chat_id,
          sender_id = EXCLUDED.sender_id,
          message_type = EXCLUDED.message_type,
          text = EXCLUDED.text,
          sent_at = EXCLUDED.sent_at,
          raw_event_idempotency_key = EXCLUDED.raw_event_idempotency_key
        RETURNING *
        `,
        [
          id,
          input.provider,
          input.providerMessageId,
          input.chatId,
          input.senderId ?? null,
          input.messageType,
          input.text ?? null,
          input.sentAt,
          input.rawEventIdempotencyKey,
        ],
      );
      return mapRow(readOne(result.rows, "conversation message upsert returned no rows"));
    },
    async listRecentByChat(input) {
      const limit = Math.max(0, Math.floor(input.limit));
      const result = await queryable.query<ConversationMessageRow>(
        `
        SELECT *
        FROM conversation_messages
        WHERE chat_id = $1
        ORDER BY sent_at DESC, created_at DESC
        LIMIT $2
        `,
        [input.chatId, limit],
      );
      return result.rows.map(mapRow);
    },
  };
}
```

Add `ConversationMessageRow`, `mapRow()`, and `readOne()` helpers.

- [ ] **Step 5: Add migration**

Create `apps/core/migrations/0012_conversation_messages.sql`:

```sql
CREATE TABLE IF NOT EXISTS conversation_messages (
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
);

CREATE INDEX IF NOT EXISTS conversation_messages_chat_sent_at_idx
  ON conversation_messages (chat_id, sent_at DESC);
```

- [ ] **Step 6: Run repository and migration tests**

Run:

```powershell
npm --workspace apps/core test -- postgres-conversation-message-repository.test.ts migration-runner.test.ts
npm run typecheck
```

Expected: tests PASS and typecheck PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add apps/core/src/conversation apps/core/migrations/0012_conversation_messages.sql apps/core/tests/postgres-conversation-message-repository.test.ts
git commit -m "feat: add conversation message repository"
```

## Task 2: Feishu Message Event Processor

**Files:**
- Create: `apps/core/src/conversation/feishu-message-event-processor.ts`
- Test: `apps/core/tests/feishu-message-event-processor.test.ts`

- [ ] **Step 1: Write processor tests**

Create `apps/core/tests/feishu-message-event-processor.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createFeishuMessageEventProcessor } from "../src/conversation/feishu-message-event-processor.js";
import type { RawEvent } from "../src/events/raw-event-queue.js";

describe("FeishuMessageEventProcessor", () => {
  it("persists text Feishu message events", async () => {
    const messages = { upsertMessage: vi.fn(async (input) => ({ id: "feishu:message-1", createdAt: new Date(), ...input })) };
    const processor = createFeishuMessageEventProcessor({ messages });

    await processor.process(rawEventFixture());

    expect(messages.upsertMessage).toHaveBeenCalledWith({
      provider: "feishu",
      providerMessageId: "message-1",
      chatId: "chat-1",
      senderId: "open-1",
      messageType: "text",
      text: "Hello",
      sentAt: new Date("2026-07-02T01:00:00.000Z"),
      rawEventIdempotencyKey: "raw-event:feishu:event-1",
    });
  });

  it("persists non-text messages without text", async () => {
    const messages = { upsertMessage: vi.fn(async (input) => ({ id: "feishu:message-1", createdAt: new Date(), ...input })) };
    const processor = createFeishuMessageEventProcessor({ messages });

    await processor.process(
      rawEventFixture({
        rawBody: {
          header: { event_id: "event-1", event_type: "im.message.receive_v1" },
          event: {
            message: {
              message_id: "message-1",
              chat_id: "chat-1",
              message_type: "image",
              create_time: "1782925200000",
            },
          },
        },
      }),
    );

    expect(messages.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageType: "image",
      text: undefined,
    }));
  });

  it("ignores unsupported events", async () => {
    const messages = { upsertMessage: vi.fn() };
    const processor = createFeishuMessageEventProcessor({ messages });

    await processor.process(rawEventFixture({ eventType: "unsupported", rawBody: { hello: "world" } }));

    expect(messages.upsertMessage).not.toHaveBeenCalled();
  });

  it("falls back to receivedAt for invalid timestamps and ignores malformed text content", async () => {
    const messages = { upsertMessage: vi.fn(async (input) => ({ id: "feishu:message-1", createdAt: new Date(), ...input })) };
    const processor = createFeishuMessageEventProcessor({ messages });

    await processor.process(
      rawEventFixture({
        rawBody: {
          header: { event_id: "event-1", event_type: "im.message.receive_v1" },
          event: {
            message: {
              message_id: "message-1",
              chat_id: "chat-1",
              message_type: "text",
              content: "{",
              create_time: "bad",
            },
          },
        },
      }),
    );

    expect(messages.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: undefined,
      sentAt: new Date("2026-07-02T01:00:00.000Z"),
    }));
  });
});
```

- [ ] **Step 2: Run processor test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- feishu-message-event-processor.test.ts
```

Expected: FAIL because processor does not exist.

- [ ] **Step 3: Implement processor**

Create `apps/core/src/conversation/feishu-message-event-processor.ts`:

```ts
import type { ConversationMessageRepository } from "./conversation-message-repository.js";
import type { RawEvent } from "../events/raw-event-queue.js";

export function createFeishuMessageEventProcessor({
  messages,
}: {
  messages: Pick<ConversationMessageRepository, "upsertMessage">;
}) {
  return {
    async process(event: RawEvent): Promise<void> {
      const parsed = parseFeishuMessageEvent(event);
      if (parsed === undefined) {
        return;
      }

      await messages.upsertMessage(parsed);
    },
  };
}
```

Implement helpers:

- `parseFeishuMessageEvent(event)`;
- `readSenderId(sender)`;
- `readText(messageType, content)`;
- `readFeishuTimestamp(value, fallback)`;
- `isRecord(value)`.

Rules:

- require `event.provider === "feishu"`;
- require `eventType === "im.message.receive_v1"` or `rawBody.header.event_type === "im.message.receive_v1"`;
- require non-empty message ID and chat ID;
- use `sender.sender_id.open_id`, then `union_id`, then `user_id`;
- parse text JSON only for `message_type === "text"`.

- [ ] **Step 4: Run processor tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- feishu-message-event-processor.test.ts
npm run typecheck
```

Expected: tests PASS and typecheck PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add apps/core/src/conversation/feishu-message-event-processor.ts apps/core/tests/feishu-message-event-processor.test.ts
git commit -m "feat: add Feishu message event processor"
```

## Task 3: Event Worker Runtime Wiring

**Files:**
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Test: `apps/core/tests/event-worker-runtime.test.ts`

- [ ] **Step 1: Update runtime tests**

Update `apps/core/tests/event-worker-runtime.test.ts` so enabled runtime dependencies include:

```ts
const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
const messages = {
  upsertMessage: vi.fn(),
  listRecentByChat: vi.fn(),
};
```

Assert:

```ts
expect(dependencies.createPostgresPool).toHaveBeenCalled();
expect(dependencies.createConversationMessageRepository).toHaveBeenCalledWith({ queryable: pool });
```

and after close:

```ts
expect(pool.end).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Run runtime test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- event-worker-runtime.test.ts
```

Expected: FAIL because runtime does not compose Postgres repository.

- [ ] **Step 3: Modify runtime dependencies**

In `apps/core/src/runtime/event-worker-runtime.ts`, import:

```ts
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import { createFeishuMessageEventProcessor } from "../conversation/feishu-message-event-processor.js";
import {
  createPostgresConversationMessageRepository,
  type Queryable,
} from "../conversation/postgres-conversation-message-repository.js";
```

Extend dependencies:

```ts
createPostgresPool?: (config: DatabaseConfig) => Queryable & { end(): Promise<void> };
createConversationMessageRepository?: typeof createPostgresConversationMessageRepository;
createProcessor?: typeof createFeishuMessageEventProcessor;
```

Compose:

```ts
const pool = createPool(readDatabaseConfig(env));
const messages = createMessages({ queryable: pool });
const processor = createProcessor({ messages });
```

Use `processor` in `createRawEventWorker()`.

Close:

```ts
await pool.end();
```

- [ ] **Step 4: Run runtime tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- event-worker-runtime.test.ts
npm run typecheck
```

Expected: tests PASS and typecheck PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add apps/core/src/runtime/event-worker-runtime.ts apps/core/tests/event-worker-runtime.test.ts
git commit -m "feat: wire message facts into event runtime"
```

## Task 4: Final Verification And PR Update

**Files:**
- Modify PR #3 body through `gh pr edit`.

- [ ] **Step 1: Run full verification**

Run:

```powershell
npm run typecheck
npm test
```

Run:

```powershell
python -m pytest
```

from `D:\work\AGE-org\workers\ai`.

Run:

```powershell
docker compose config
```

from `D:\work\AGE-org`.

Expected all commands exit 0.

- [ ] **Step 2: Push branch**

Run:

```powershell
git status --short --branch
git push origin codex/iris-document-source-registry
```

- [ ] **Step 3: Update PR body**

Append:

```markdown
- Add Phase 2U Feishu message fact store: conversation message persistence, Feishu raw event processor, and event runtime repository wiring.
```

- [ ] **Step 4: Verify PR status**

Run:

```powershell
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url,body
```

Expected PR is open, points to the latest pushed commit, and body includes Phase 2U.
