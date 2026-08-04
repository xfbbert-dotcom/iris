import type { UpsertConversationMessageInput } from "./conversation-message-repository.js";
import { MAX_CONVERSATION_MESSAGE_ID_CHARS } from "./postgres-conversation-message-repository.js";
import type {
  PostgresConversationStateDataSource,
  Queryable,
  TransactionClient,
} from "../conversation-state/postgres-conversation-state-repository.js";

const MESSAGE_LOCK_NAMESPACE = "iris:conversation-message:";

export type ConversationMessageReplayIdentity = Pick<
  UpsertConversationMessageInput,
  "provider" | "providerMessageId" | "chatId"
>;

export type ConversationMessageReplayGuardResult<T> =
  | { status: "active"; value: T }
  | { status: "deleted" };

export interface ConversationMessageReplayGuard {
  runUnlessDeleted<T>(input: {
    identity: ConversationMessageReplayIdentity;
    effect: () => Promise<T>;
  }): Promise<ConversationMessageReplayGuardResult<T>>;
}

export function createPostgresConversationMessageReplayGuard(input: {
  dataSource: PostgresConversationStateDataSource;
}): ConversationMessageReplayGuard {
  return {
    async runUnlessDeleted<T>({ identity, effect }: {
      identity: ConversationMessageReplayIdentity;
      effect: () => Promise<T>;
    }): Promise<ConversationMessageReplayGuardResult<T>> {
      const normalized = normalizeIdentity(identity);
      return withTransaction(input.dataSource, async (client) => {
        await lockConversationMessageIngestScope({
          queryable: client,
          conversationMessageId: conversationMessageId(normalized),
        });
        const tombstone = await client.query(
          `
          SELECT 1
          FROM conversation_message_deletion_tombstones
          WHERE provider = $1 AND provider_message_id = $2
          `,
          [normalized.provider, normalized.providerMessageId],
        );
        if (tombstone.rows.length > 0) return { status: "deleted" };
        return { status: "active", value: await effect() };
      });
    },
  };
}

export async function lockConversationMessageIngestScope(input: {
  queryable: Queryable;
  conversationMessageId: string;
}): Promise<void> {
  const messageId = requireIdentifier("conversationMessageId", input.conversationMessageId);
  await input.queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${MESSAGE_LOCK_NAMESPACE}${messageId}`],
  );
}

function normalizeIdentity(identity: ConversationMessageReplayIdentity): ConversationMessageReplayIdentity {
  if (identity.provider !== "feishu") throw new Error("message provider is invalid");
  return {
    provider: identity.provider,
    providerMessageId: requireIdentifier("providerMessageId", identity.providerMessageId),
    chatId: requireIdentifier("chatId", identity.chatId),
  };
}

function conversationMessageId(identity: ConversationMessageReplayIdentity): string {
  return requireIdentifier("conversationMessageId", `${identity.provider}:${identity.providerMessageId}`);
}

function requireIdentifier(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > MAX_CONVERSATION_MESSAGE_ID_CHARS) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

async function withTransaction<T>(
  dataSource: PostgresConversationStateDataSource,
  operation: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await dataSource.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  } finally {
    client.release();
  }
}
