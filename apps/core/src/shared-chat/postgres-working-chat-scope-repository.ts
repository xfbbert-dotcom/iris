import { decodeDurableRuntimeControlSnapshot } from "../admin/runtime-control-state-repository.js";
import { lockConversationMessageIngestScope } from "../conversation/conversation-message-replay-guard.js";
import {
  MAX_SHARED_CHAT_SOURCE_BINDINGS,
  WORKING_CHAT_SCOPE_ID,
  WorkingChatScopeConflictError,
  WorkingChatScopeStaleError,
  normalizeSharedChatSourceBinding,
  normalizeWorkingChatScopeReplacement,
  type SharedChatSourceBinding,
  type WorkingChatScope,
  type WorkingChatScopeRepository,
} from "./working-chat-scope.js";

export type WorkingChatScopeQueryable = {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
};
export type WorkingChatScopeTransactionClient = WorkingChatScopeQueryable & { release(): void };
export type WorkingChatScopeDataSource = WorkingChatScopeQueryable & {
  connect(): Promise<WorkingChatScopeTransactionClient>;
};

const SCOPE_LOCK_KEY = `iris:working-chat-scope:${WORKING_CHAT_SCOPE_ID}`;
const SCOPE_SELECT = "SELECT id, version, state, groups, updated_at, updated_by FROM working_chat_scopes WHERE id = $1";

export function createPostgresWorkingChatScopeRepository({ dataSource }: {
  dataSource: WorkingChatScopeDataSource;
}): WorkingChatScopeRepository {
  return {
    get: () => readScope(dataSource),
    async resolveForChat(chatId) {
      if (typeof chatId !== "string" || chatId.trim() !== chatId || chatId.length < 1 || chatId.length > 512) return undefined;
      const scope = await readScope(dataSource);
      return scope?.state === "active" && scope.groups.some(group => group.chatId === chatId) ? scope : undefined;
    },
    async replace(input) {
      const normalized = normalizeWorkingChatScopeReplacement(input);
      return withTransaction(dataSource, async client => {
        await lockScope(client);
        const current = await readScope(client);
        if ((current?.version ?? 0) !== normalized.expectedVersion) throw new WorkingChatScopeConflictError();
        const activeAnswers = await client.query<{ id: string }>(
          `SELECT delivery.id FROM answer_reply_deliveries delivery
           WHERE delivery.state IN ('sending', 'reconciliation_required') AND EXISTS (
             SELECT 1 FROM answer_reply_chat_source_traces trace
             WHERE trace.delivery_id = delivery.id AND trace.scope_id = $1
           ) ORDER BY delivery.id FOR UPDATE OF delivery`, [WORKING_CHAT_SCOPE_ID],
        );
        if (activeAnswers.rows.length !== 0) throw new WorkingChatScopeConflictError();
        const result = await client.query<Record<string, unknown>>(
          `INSERT INTO working_chat_scopes (id,version,state,groups,updated_at,updated_by)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6)
           ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, state = EXCLUDED.state,
             groups = EXCLUDED.groups, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
           WHERE working_chat_scopes.version = $7
           RETURNING id,version,state,groups,updated_at,updated_by`,
          [WORKING_CHAT_SCOPE_ID, normalized.expectedVersion + 1, normalized.state,
            JSON.stringify(normalized.groups), normalized.at, normalized.updatedBy, normalized.expectedVersion],
        );
        if (result.rows.length !== 1) throw new WorkingChatScopeConflictError();
        return decodeScope(result.rows[0]);
      });
    },
    async validateExact(binding) {
      try {
        const normalized = normalizeSharedChatSourceBinding(binding);
        await withTransaction(dataSource, client => lockSharedChatSources(client, [normalized], normalized.destinationChatId));
        return true;
      } catch (error) {
        if (error instanceof WorkingChatScopeStaleError) return false;
        throw error;
      }
    },
  };
}

// The caller owns the transaction and takes delivery locks only after this returns.
// No network I/O belongs here: send_started is the local authorization boundary.
export async function lockSharedChatSources(
  queryable: WorkingChatScopeQueryable,
  bindings: readonly SharedChatSourceBinding[],
  destinationChatId: string,
): Promise<void> {
  if (!Array.isArray(bindings) || bindings.length > MAX_SHARED_CHAT_SOURCE_BINDINGS) throw new WorkingChatScopeStaleError();
  if (bindings.length === 0) return;
  const normalized: SharedChatSourceBinding[] = [];
  const identities = new Map<string, string>();
  for (const value of bindings) {
    const binding = normalizeSharedChatSourceBinding(value);
    if (binding.destinationChatId !== destinationChatId) throw new WorkingChatScopeStaleError();
    const identity = JSON.stringify(binding);
    const previous = identities.get(binding.messageId);
    if (previous !== undefined && previous !== identity) throw new WorkingChatScopeStaleError();
    identities.set(binding.messageId, identity);
    normalized.push(binding);
  }

  await lockScope(queryable);
  let scope: WorkingChatScope | undefined;
  try { scope = await readScope(queryable); }
  catch { throw new WorkingChatScopeStaleError(); }
  if (scope?.state !== "active") throw new WorkingChatScopeStaleError();
  const groups = new Set(scope.groups.map(group => group.chatId));
  if (!groups.has(destinationChatId) || normalized.some(binding => binding.scopeVersion !== scope.version
    || !groups.has(binding.sourceChatId))) throw new WorkingChatScopeStaleError();

  const runtime = await queryable.query(
    `SELECT revision, desired_global_enabled, disabled_group_ids, capabilities, updated_at, updated_by
     FROM runtime_control_state WHERE singleton_id = 1 FOR SHARE`,
  );
  try {
    if (runtime.rows.length !== 1) throw new WorkingChatScopeStaleError();
    const policy = decodeDurableRuntimeControlSnapshot(runtime.rows[0]);
    if (!policy.desiredGlobalEnabled || !policy.capabilities.readGroupContext || !policy.capabilities.replyWhenMentioned
      || policy.disabledGroupIds.includes(destinationChatId)
      || normalized.some(binding => policy.disabledGroupIds.includes(binding.sourceChatId))) throw new WorkingChatScopeStaleError();
  } catch { throw new WorkingChatScopeStaleError(); }

  const messageIds = [...identities.keys()].sort();
  for (const messageId of messageIds) {
    await lockConversationMessageIngestScope({ queryable, conversationMessageId: `feishu:${messageId}` });
  }
  const tombstones = await queryable.query(
    `SELECT 1 FROM conversation_message_deletion_tombstones
     WHERE provider = 'feishu' AND provider_message_id = ANY($1::text[]) LIMIT 1`, [messageIds],
  );
  if (tombstones.rows.length !== 0) throw new WorkingChatScopeStaleError();
}

async function lockScope(queryable: WorkingChatScopeQueryable): Promise<void> {
  await queryable.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [SCOPE_LOCK_KEY]);
}

async function readScope(queryable: WorkingChatScopeQueryable): Promise<WorkingChatScope | undefined> {
  const result = await queryable.query<Record<string, unknown>>(SCOPE_SELECT, [WORKING_CHAT_SCOPE_ID]);
  if (result.rows.length === 0) return undefined;
  if (result.rows.length !== 1) throw new Error("invalid working chat scope row count");
  return decodeScope(result.rows[0]);
}

function decodeScope(row: unknown): WorkingChatScope {
  if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("invalid working chat scope row");
  const value = row as Record<string, unknown>;
  const version = typeof value.version === "string" && /^\d+$/u.test(value.version) ? Number(value.version) : value.version;
  if (value.id !== WORKING_CHAT_SCOPE_ID || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new Error("invalid working chat scope identity");
  }
  const normalized = normalizeWorkingChatScopeReplacement({
    expectedVersion: version - 1, state: value.state as WorkingChatScope["state"],
    groups: value.groups as WorkingChatScope["groups"], updatedBy: value.updated_by as string,
    at: value.updated_at instanceof Date ? value.updated_at : new Date(value.updated_at as string),
  });
  return { id: WORKING_CHAT_SCOPE_ID, version, state: normalized.state, groups: normalized.groups,
    updatedAt: normalized.at, updatedBy: normalized.updatedBy };
}

async function withTransaction<T>(dataSource: WorkingChatScopeDataSource, operation: (client: WorkingChatScopeTransactionClient) => Promise<T>): Promise<T> {
  const client = await dataSource.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally { client.release(); }
}
