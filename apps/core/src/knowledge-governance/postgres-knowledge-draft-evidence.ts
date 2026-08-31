import type { KnowledgeDraftEvidenceReference } from "./knowledge-draft.js";
import type { KnowledgeDraftEvidenceInvalidReason } from "./knowledge-draft-repository.js";

export type KnowledgeDraftEvidenceQueryable = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export const KNOWLEDGE_CONFLICT_PERMISSION_ATTESTATION_MAX_AGE_MS = 60_000;

type MessageStateRow = { chat_id: string | null; deleted: boolean };
type VersionedStateRow = { group_id: string; version: string | number };
type DocumentStateRow = {
  source_type: "group_visible_document" | "authorized_wiki_document" | "user_submitted_document";
  permission_state: "unknown" | "readable" | "denied" | "stale";
  sync_state: "pending" | "syncing" | "synced" | "failed";
  can_use_for_knowledge_drafts: boolean;
  updated_at: Date;
  exact_group_evidence: boolean;
};
type GroupMemoryStateRow = {
  group_id: string;
  status: "active" | "superseded";
  updated_at: Date;
};

export class KnowledgeDraftEvidenceError extends Error {
  constructor(public readonly reason: KnowledgeDraftEvidenceInvalidReason) {
    super("knowledge draft evidence is not current");
    this.name = "KnowledgeDraftEvidenceError";
  }
}

export async function validateCurrentKnowledgeDraftEvidence(
  input: Parameters<typeof findInvalidKnowledgeDraftEvidence>[0],
): Promise<void> {
  const reason = await findInvalidKnowledgeDraftEvidence(input);
  if (reason !== undefined) throw new KnowledgeDraftEvidenceError(reason);
}

export async function findInvalidKnowledgeDraftEvidence(input: {
  queryable: KnowledgeDraftEvidenceQueryable;
  sourceGroupId?: string;
  evidence: readonly KnowledgeDraftEvidenceReference[];
  knowledgeConflictPermission?: {
    documentSourceIds: readonly string[];
    attestedAt: Date;
    validationAt: Date;
    maxAgeMs: number;
  };
  draftIdentity?: {
    draftId: string;
    revisionNumber: number;
    validationAt: Date;
    maxAgeMs: number;
  };
}): Promise<KnowledgeDraftEvidenceInvalidReason | undefined> {
  for (const evidence of input.evidence) {
    const reason = await findInvalidReference(input.queryable, input.sourceGroupId, evidence, input);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

async function findInvalidReference(
  queryable: KnowledgeDraftEvidenceQueryable,
  sourceGroupId: string | undefined,
  evidence: KnowledgeDraftEvidenceReference,
  context: Parameters<typeof findInvalidKnowledgeDraftEvidence>[0],
): Promise<KnowledgeDraftEvidenceInvalidReason | undefined> {
  if (evidence.type === "conversation_message") {
    const result = await queryable.query<MessageStateRow>(
      `
      SELECT
        (SELECT chat_id FROM conversation_messages WHERE id = $1) AS chat_id,
        EXISTS (
          SELECT 1 FROM conversation_message_deletion_tombstones
          WHERE conversation_message_id = $1
        ) AS deleted
      `,
      [evidence.id],
    );
    const row = result.rows[0];
    if (row?.deleted) return "message_deleted";
    if (row?.chat_id === null || row === undefined) return "source_missing";
    if (sourceGroupId === undefined || evidence.groupId !== sourceGroupId || row.chat_id !== sourceGroupId) {
      return "group_scope_mismatch";
    }
    return undefined;
  }

  if (evidence.type === "discussion_thread" || evidence.type === "action_item") {
    const table = evidence.type === "discussion_thread" ? "discussion_threads" : "action_items";
    const result = await queryable.query<VersionedStateRow>(
      `SELECT group_id, version FROM ${table} WHERE id = $1`,
      [evidence.id],
    );
    const row = result.rows[0];
    if (row === undefined) return "source_missing";
    if (sourceGroupId === undefined || evidence.groupId !== sourceGroupId || row.group_id !== sourceGroupId) {
      return "group_scope_mismatch";
    }
    if (Number(row.version) !== evidence.entityVersion) return "entity_version_changed";
    return undefined;
  }

  if (evidence.type === "group_memory") {
    const result = await queryable.query<GroupMemoryStateRow>(
      "SELECT group_id, status, updated_at FROM group_memories WHERE id = $1",
      [evidence.id],
    );
    const row = result.rows[0];
    if (row === undefined) return "memory_missing";
    if (sourceGroupId === undefined || evidence.groupId !== sourceGroupId
      || row.group_id !== sourceGroupId) return "group_scope_mismatch";
    if (row.status !== "active") return "memory_superseded";
    if (new Date(row.updated_at).getTime() !== evidence.expectedUpdatedAt.getTime()) {
      return "memory_timestamp_changed";
    }
    return undefined;
  }

  if (!("expectedUpdatedAt" in evidence)) {
    return "source_missing";
  }
  const result = await queryable.query<DocumentStateRow>(
    `
    SELECT
      source.source_type,
      source.permission_state,
      source.sync_state,
      source.can_use_for_knowledge_drafts,
      source.updated_at,
      EXISTS (
        SELECT 1
        FROM document_source_evidence evidence
        WHERE evidence.document_source_id = source.id
          AND evidence.kind = 'group_message'
          AND evidence.group_id = $2
      ) AS exact_group_evidence
    FROM document_sources source
    WHERE source.id = $1
    FOR SHARE OF source
    `,
    [evidence.id, sourceGroupId ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) return "source_missing";
  if (row.permission_state !== "readable") {
    if (row.permission_state !== "unknown"
      || !await hasFreshKnowledgeConflictPermission(queryable, evidence.id, context)) {
      return "document_permission_unavailable";
    }
  }
  if (row.sync_state !== "synced") return "document_not_synced";
  if (!row.can_use_for_knowledge_drafts) return "document_draft_use_disabled";
  if (new Date(row.updated_at).getTime() !== evidence.expectedUpdatedAt.getTime()) {
    return "source_timestamp_changed";
  }
  if (
    row.source_type === "group_visible_document" &&
    (sourceGroupId === undefined || !row.exact_group_evidence)
  ) return "group_scope_mismatch";
  return undefined;
}

async function hasFreshKnowledgeConflictPermission(
  queryable: KnowledgeDraftEvidenceQueryable,
  documentSourceId: string,
  context: Parameters<typeof findInvalidKnowledgeDraftEvidence>[0],
): Promise<boolean> {
  const direct = context.knowledgeConflictPermission;
  if (direct !== undefined
    && direct.documentSourceIds.includes(documentSourceId)
    && isFresh(direct.attestedAt, direct.validationAt, direct.maxAgeMs)) return true;
  const identity = context.draftIdentity;
  if (identity === undefined) return false;
  const result = await queryable.query<{ permission_attested_at: Date }>(
    `SELECT permission_attested_at
     FROM knowledge_conflict_draft_governance_attestations
     WHERE draft_id = $1 AND revision_number = $2 AND document_source_id = $3
       AND permission_attested_at <= $4
     ORDER BY permission_attested_at DESC
     LIMIT 1`,
    [identity.draftId, identity.revisionNumber, documentSourceId, identity.validationAt],
  );
  const attestedAt = result.rows[0]?.permission_attested_at;
  return attestedAt !== undefined
    && isFresh(new Date(attestedAt), identity.validationAt, identity.maxAgeMs);
}

function isFresh(attestedAt: Date, validationAt: Date, maxAgeMs: number): boolean {
  const attestedMs = attestedAt.getTime();
  const validationMs = validationAt.getTime();
  return Number.isFinite(attestedMs) && Number.isFinite(validationMs)
    && Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 0
    && attestedMs <= validationMs && validationMs - attestedMs <= maxAgeMs;
}
