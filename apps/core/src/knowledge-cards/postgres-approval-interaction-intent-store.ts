import { createHash, randomUUID } from "node:crypto";

import type { PostgresKnowledgeDraftDataSource } from "../knowledge-governance/postgres-knowledge-draft-repository.js";
import {
  ApprovalInteractionIntentConflictError,
  type ApprovalInteractionIntent,
  type ApprovalInteractionIntentStore,
  type PersistApprovalInteractionIntentInput,
} from "./approval-interaction-intent-store.js";
import {
  KNOWLEDGE_CARD_REASON_MAX_CHARS,
  normalizeApprovalInteractionIntentIdentity,
  type ApprovalInteractionIntentIdentity,
} from "./knowledge-card.js";

export { ApprovalInteractionIntentConflictError } from "./approval-interaction-intent-store.js";

type IntentRow = {
  id: string;
  callback_key: string;
  interaction_kind: ApprovalInteractionIntentIdentity["kind"];
  action: ApprovalInteractionIntentIdentity["action"];
  operation_fingerprint: string;
  reason: string;
  rejection_confirmed: boolean;
};

export function createPostgresApprovalInteractionIntentStore({
  dataSource,
  idGenerator = randomUUID,
}: {
  dataSource: PostgresKnowledgeDraftDataSource;
  idGenerator?: () => string;
}): ApprovalInteractionIntentStore {
  return {
    async persistIntent(input) {
      const normalized = normalizePersistInput(input);
      const id = requireReference("id", idGenerator());
      const fingerprint = intentFingerprint(normalized);
      const inserted = await dataSource.query<{ id: string }>(
        `INSERT INTO approval_interaction_intents (
          id, callback_key, interaction_kind, action, operation_fingerprint,
          reason, rejection_confirmed, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (callback_key) DO NOTHING
        RETURNING id`,
        [
          id,
          normalized.interaction.idempotencyKey,
          normalized.interaction.kind,
          normalized.interaction.action,
          fingerprint,
          normalized.reason,
          normalized.rejectionConfirmed === true,
          normalized.at,
        ],
      );
      if (inserted.rows[0] !== undefined) return { id: inserted.rows[0].id };

      const existing = await dataSource.query<IntentRow>(
        `${intentSelect()} WHERE callback_key = $1`,
        [normalized.interaction.idempotencyKey],
      );
      const row = existing.rows[0];
      if (
        row === undefined ||
        row.interaction_kind !== normalized.interaction.kind ||
        row.action !== normalized.interaction.action ||
        row.operation_fingerprint !== fingerprint ||
        row.reason !== normalized.reason ||
        row.rejection_confirmed !== (normalized.rejectionConfirmed === true)
      ) throw new ApprovalInteractionIntentConflictError();
      return { id: row.id };
    },

    async resolveIntent(input) {
      const id = requireReference("id", input.id);
      const interaction = normalizeApprovalInteractionIntentIdentity(input.interaction);
      const result = await dataSource.query<IntentRow>(`${intentSelect()} WHERE id = $1`, [id]);
      const row = result.rows[0];
      if (row === undefined) return undefined;
      if (
        row.callback_key !== interaction.idempotencyKey ||
        row.interaction_kind !== interaction.kind ||
        row.action !== interaction.action
      ) throw new ApprovalInteractionIntentConflictError();
      const sensitive = normalizeSensitiveFields({
        action: interaction.action,
        reason: row.reason,
        ...(row.rejection_confirmed ? { rejectionConfirmed: true as const } : {}),
      });
      if (
        row.operation_fingerprint !== intentFingerprint({ interaction, ...sensitive })
      ) throw new ApprovalInteractionIntentConflictError();
      return {
        id: row.id,
        reason: row.reason,
        ...(row.rejection_confirmed ? { rejectionConfirmed: true as const } : {}),
      } satisfies ApprovalInteractionIntent;
    },

    async deleteIntent(rawId) {
      await dataSource.query("DELETE FROM approval_interaction_intents WHERE id = $1", [
        requireReference("id", rawId),
      ]);
    },
  };
}

function intentSelect(): string {
  return `SELECT id, callback_key, interaction_kind, action, operation_fingerprint,
    reason, rejection_confirmed FROM approval_interaction_intents`;
}

function normalizePersistInput(input: PersistApprovalInteractionIntentInput) {
  const interaction = normalizeApprovalInteractionIntentIdentity(input.interaction);
  return {
    interaction,
    ...normalizeSensitiveFields({
      action: interaction.action,
      reason: input.reason,
      ...(input.rejectionConfirmed === undefined
        ? {}
        : { rejectionConfirmed: input.rejectionConfirmed }),
    }),
    at: requireDate(input.at),
  };
}

function normalizeSensitiveFields(input: {
  action: ApprovalInteractionIntentIdentity["action"];
  reason: unknown;
  rejectionConfirmed?: unknown;
}) {
  if (!(input.action === "request_revision" || input.action === "reject")) {
    throw new Error("approval interaction intent action is not sensitive");
  }
  const reason = requireNormalizedReason(input.reason);
  if (input.action === "reject") {
    if (input.rejectionConfirmed !== true) throw new Error("rejection confirmation is required");
    return { reason, rejectionConfirmed: true as const };
  }
  if (input.rejectionConfirmed !== undefined) {
    throw new Error("revision intent contains unsupported fields");
  }
  return { reason };
}

function intentFingerprint(input: {
  interaction: ApprovalInteractionIntentIdentity;
  reason: string;
  rejectionConfirmed?: true;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "approval_interaction_intent_v1",
    input.interaction,
    input.reason,
    input.rejectionConfirmed === true,
  ])).digest("hex");
}

function requireReference(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireNormalizedReason(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value) {
    throw new Error("reason must be normalized");
  }
  if ([...value].length < 1 || [...value].length > KNOWLEDGE_CARD_REASON_MAX_CHARS) {
    throw new Error("reason length is invalid");
  }
  return value;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("date is invalid");
  return new Date(value);
}
