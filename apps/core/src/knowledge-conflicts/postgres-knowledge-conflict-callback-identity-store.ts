import { createHash, randomUUID } from "node:crypto";

import {
  KnowledgeConflictCallbackIdentityConflictError,
  type KnowledgeConflictCallbackIdentityStore,
  type PersistKnowledgeConflictCallbackIdentityInput,
} from "./knowledge-conflict-callback-identity-store.js";
import {
  normalizeApprovalInteractionJob,
  type KnowledgeConflictConfirmationInteractionJob,
} from "../knowledge-cards/knowledge-card.js";

export { KnowledgeConflictCallbackIdentityConflictError } from
  "./knowledge-conflict-callback-identity-store.js";

type Queryable = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type IdentityRow = {
  id: string;
  callback_key: string;
  event_id: string;
  app_id: string;
  actor_open_id: string;
  chat_id: string;
  message_id: string;
  presentation_id: string;
  candidate_id: string;
  candidate_version: string | number;
  group_id: string;
  nonce: string;
  action: PersistKnowledgeConflictCallbackIdentityInput["action"];
  operation_fingerprint: string;
  received_at: Date;
  created_at: Date;
};

export function createPostgresKnowledgeConflictCallbackIdentityStore({
  dataSource,
  idGenerator = randomUUID,
}: {
  dataSource: Queryable;
  idGenerator?: () => string;
}): KnowledgeConflictCallbackIdentityStore {
  return {
    async persistIdentity(input) {
      const normalized = normalizeIdentity(input);
      const id = requireReference("id", idGenerator());
      const fingerprint = identityFingerprint(normalized);
      const inserted = await dataSource.query<{ id: string }>(
        `INSERT INTO knowledge_conflict_callback_identities (
          id, callback_key, event_id, app_id, actor_open_id, chat_id, message_id,
          presentation_id, candidate_id, candidate_version, group_id, nonce, action,
          operation_fingerprint, received_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
        ON CONFLICT (callback_key) DO NOTHING
        RETURNING id`,
        [id, normalized.idempotencyKey, normalized.eventId, normalized.appId,
          normalized.actorOpenId, normalized.chatId, normalized.messageId,
          normalized.presentationId, normalized.candidateId, normalized.candidateVersion,
          normalized.groupId, normalized.nonce, normalized.action, fingerprint,
          normalized.receivedAt],
      );
      if (inserted.rows[0] !== undefined) return { id: inserted.rows[0].id };
      const existing = await dataSource.query<IdentityRow>(
        `${identitySelect()} WHERE callback_key = $1`,
        [normalized.idempotencyKey],
      );
      const row = existing.rows[0];
      if (row === undefined || !identityMatches(row, normalized)) {
        throw new KnowledgeConflictCallbackIdentityConflictError();
      }
      return { id: row.id };
    },

    async resolveIdentity(input) {
      const id = requireReference("id", input.id);
      const interaction = normalizeConflictJob(input.interaction);
      if (interaction.callbackIdentityId !== id) {
        throw new KnowledgeConflictCallbackIdentityConflictError();
      }
      const result = await dataSource.query<IdentityRow>(`${identitySelect()} WHERE id = $1`, [id]);
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const normalized = normalizeIdentity({
        idempotencyKey: interaction.idempotencyKey,
        eventId: row.event_id,
        appId: row.app_id,
        actorOpenId: row.actor_open_id,
        chatId: row.chat_id,
        messageId: row.message_id,
        presentationId: interaction.presentationId,
        candidateId: interaction.candidateId,
        candidateVersion: interaction.candidateVersion,
        groupId: interaction.groupId,
        nonce: interaction.nonce,
        action: interaction.action,
        receivedAt: interaction.receivedAt,
      });
      if (!identityMatches(row, normalized)) {
        throw new KnowledgeConflictCallbackIdentityConflictError();
      }
      return {
        eventId: row.event_id,
        appId: row.app_id,
        actorOpenId: row.actor_open_id,
        chatId: row.chat_id,
        messageId: row.message_id,
      };
    },
  };
}

function identitySelect(): string {
  return `SELECT id, callback_key, event_id, app_id, actor_open_id, chat_id, message_id,
    presentation_id, candidate_id, candidate_version, group_id, nonce, action,
    operation_fingerprint, received_at, created_at
    FROM knowledge_conflict_callback_identities`;
}

function normalizeConflictJob(
  input: KnowledgeConflictConfirmationInteractionJob,
): KnowledgeConflictConfirmationInteractionJob {
  const normalized = normalizeApprovalInteractionJob(input);
  if (normalized.kind !== "knowledge_conflict_confirmation") {
    throw new KnowledgeConflictCallbackIdentityConflictError();
  }
  return normalized;
}

function normalizeIdentity(input: PersistKnowledgeConflictCallbackIdentityInput) {
  const normalized = {
    idempotencyKey: requireReference("idempotencyKey", input.idempotencyKey),
    eventId: requireReference("eventId", input.eventId),
    appId: requireReference("appId", input.appId),
    actorOpenId: requireReference("actorOpenId", input.actorOpenId),
    chatId: requireReference("chatId", input.chatId),
    messageId: requireReference("messageId", input.messageId),
    presentationId: requireReference("presentationId", input.presentationId),
    candidateId: requireReference("candidateId", input.candidateId),
    candidateVersion: requirePositiveInteger("candidateVersion", input.candidateVersion),
    groupId: requireReference("groupId", input.groupId),
    nonce: requireReference("nonce", input.nonce, 128),
    action: input.action,
    receivedAt: requireDate(input.receivedAt),
  };
  if (normalized.presentationId !== normalized.candidateId
    || normalized.chatId !== normalized.groupId
    || (normalized.action !== "create_update_draft" && normalized.action !== "not_a_conflict")) {
    throw new KnowledgeConflictCallbackIdentityConflictError();
  }
  return normalized;
}

function identityMatches(row: IdentityRow, input: ReturnType<typeof normalizeIdentity>): boolean {
  return row.callback_key === input.idempotencyKey
    && row.event_id === input.eventId
    && row.app_id === input.appId
    && row.actor_open_id === input.actorOpenId
    && row.chat_id === input.chatId
    && row.message_id === input.messageId
    && row.presentation_id === input.presentationId
    && row.candidate_id === input.candidateId
    && Number(row.candidate_version) === input.candidateVersion
    && row.group_id === input.groupId
    && row.nonce === input.nonce
    && row.action === input.action
    && (row.operation_fingerprint === identityFingerprint(input)
      || row.operation_fingerprint === legacyIdentityFingerprint({
        ...input,
        receivedAt: new Date(row.received_at),
      }));
}

function identityFingerprint(input: ReturnType<typeof normalizeIdentity>): string {
  return createHash("sha256").update(JSON.stringify([
    "knowledge_conflict_callback_identity_v2",
    input.idempotencyKey,
    input.eventId,
    input.appId,
    input.actorOpenId,
    input.chatId,
    input.messageId,
    input.presentationId,
    input.candidateId,
    input.candidateVersion,
    input.groupId,
    input.nonce,
    input.action,
  ])).digest("hex");
}

function legacyIdentityFingerprint(input: ReturnType<typeof normalizeIdentity>): string {
  return createHash("sha256").update(JSON.stringify([
    "knowledge_conflict_callback_identity_v1",
    input.idempotencyKey,
    input.eventId,
    input.appId,
    input.actorOpenId,
    input.chatId,
    input.messageId,
    input.presentationId,
    input.candidateId,
    input.candidateVersion,
    input.groupId,
    input.nonce,
    input.action,
    input.receivedAt.toISOString(),
  ])).digest("hex");
}

function requireReference(name: string, value: unknown, maximum = 512): string {
  if (typeof value !== "string") throw new Error(`${name} is invalid`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) throw new Error(`${name} is invalid`);
  return normalized;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} is invalid`);
  return Number(value);
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("date is invalid");
  return new Date(value);
}
