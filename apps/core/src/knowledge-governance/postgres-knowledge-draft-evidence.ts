import type { KnowledgeDraftEvidenceReference } from "./knowledge-draft.js";
import type { KnowledgeDraftEvidenceInvalidReason } from "./knowledge-draft-repository.js";

export type KnowledgeDraftEvidenceQueryable = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

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

export class KnowledgeDraftEvidenceError extends Error {
  constructor(public readonly reason: KnowledgeDraftEvidenceInvalidReason) {
    super("knowledge draft evidence is not current");
    this.name = "KnowledgeDraftEvidenceError";
  }
}

export async function validateCurrentKnowledgeDraftEvidence(input: {
  queryable: KnowledgeDraftEvidenceQueryable;
  sourceGroupId?: string;
  evidence: readonly KnowledgeDraftEvidenceReference[];
}): Promise<void> {
  const reason = await findInvalidKnowledgeDraftEvidence(input);
  if (reason !== undefined) throw new KnowledgeDraftEvidenceError(reason);
}

export async function findInvalidKnowledgeDraftEvidence(input: {
  queryable: KnowledgeDraftEvidenceQueryable;
  sourceGroupId?: string;
  evidence: readonly KnowledgeDraftEvidenceReference[];
}): Promise<KnowledgeDraftEvidenceInvalidReason | undefined> {
  for (const evidence of input.evidence) {
    const reason = await findInvalidReference(input.queryable, input.sourceGroupId, evidence);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

async function findInvalidReference(
  queryable: KnowledgeDraftEvidenceQueryable,
  sourceGroupId: string | undefined,
  evidence: KnowledgeDraftEvidenceReference,
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

  if (!("expectedUpdatedAt" in evidence)) {
    return "source_missing";
  }
  const result = await queryable.query<DocumentStateRow>(
    `
    SELECT
      source_type,
      permission_state,
      sync_state,
      can_use_for_knowledge_drafts,
      updated_at,
      EXISTS (
        SELECT 1
        FROM document_source_evidence evidence
        WHERE evidence.document_source_id = document_sources.id
          AND evidence.kind = 'group_message'
          AND evidence.group_id = $2
      ) AS exact_group_evidence
    FROM document_sources
    WHERE id = $1
    `,
    [evidence.id, sourceGroupId ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) return "source_missing";
  if (row.permission_state !== "readable") return "document_permission_unavailable";
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
