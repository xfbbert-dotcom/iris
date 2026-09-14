import { acquireManagedKnowledgeSourceLocks } from "../documents/managed-knowledge-source-lock.js";
import { AnswerReplyGrantStaleError } from "./answer-reply-repository.js";
import type { AnswerReplyTransactionClient } from "./postgres-answer-reply-repository.js";

export type AnswerDocumentSourceLockBinding = {
  documentSourceId: string;
  documentSnapshotId: string;
  crossGroupGrantId?: string;
  crossGroupGrantVersion?: number;
  crossGroupGrantorGroupId?: string;
  crossGroupGranteeGroupId?: string;
};

export async function lockAnswerDocumentSources(input: {
  client: AnswerReplyTransactionClient;
  sources: readonly AnswerDocumentSourceLockBinding[];
  chatId: string;
}): Promise<void> {
  await acquireManagedKnowledgeSourceLocks(input.client, input.sources.map(source => source.documentSourceId));
  await lockManagedSourceFreshness(input.client, input.sources);
  await lockCurrentSourceGrantBindings(input.client, input.sources, input.chatId);
}

type SourceGrantBinding = {
  grantId: string;
  version: number;
  documentSourceId: string;
  grantorGroupId: string;
  granteeGroupId: string;
};

type ManagedSourceStateRow = {
  linked_document_source_id: unknown;
  state: unknown;
  current_reconciled_snapshot_id: unknown;
};

async function lockManagedSourceFreshness(
  client: AnswerReplyTransactionClient,
  sources: readonly AnswerDocumentSourceLockBinding[],
): Promise<void> {
  const documentSourceIds = [...new Set(
    sources.map(({ documentSourceId }) => documentSourceId),
  )].sort();
  if (documentSourceIds.length === 0) return;

  const result = await client.query<ManagedSourceStateRow>(
    `SELECT linked_document_source_id, state, current_reconciled_snapshot_id
     FROM managed_knowledge_pages
     WHERE linked_document_source_id = ANY($1::text[])
     ORDER BY linked_document_source_id ASC
     FOR SHARE`,
    [documentSourceIds],
  );
  const requested = new Set(documentSourceIds);
  const snapshotsBySource = new Map<string, Set<string>>();
  for (const source of sources) {
    const snapshotIds = snapshotsBySource.get(source.documentSourceId) ?? new Set<string>();
    snapshotIds.add(source.documentSnapshotId);
    snapshotsBySource.set(source.documentSourceId, snapshotIds);
  }
  const seen = new Set<string>();
  for (const row of result.rows) {
    if (
      typeof row.linked_document_source_id !== "string"
      || !requested.has(row.linked_document_source_id)
      || seen.has(row.linked_document_source_id)
      || row.state !== "active"
      || snapshotsBySource.get(row.linked_document_source_id)?.size !== 1
      || row.current_reconciled_snapshot_id
        !== [...snapshotsBySource.get(row.linked_document_source_id)!][0]
    ) {
      throw new AnswerReplyGrantStaleError();
    }
    seen.add(row.linked_document_source_id);
  }
}

export async function lockCurrentSourceGrantBindings(
  client: AnswerReplyTransactionClient,
  sources: readonly AnswerDocumentSourceLockBinding[],
  expectedGranteeGroupId?: string,
): Promise<void> {
  const bindings = collectSourceGrantBindings(sources);
  if (
    expectedGranteeGroupId !== undefined &&
    bindings.some((binding) => binding.granteeGroupId !== expectedGranteeGroupId)
  ) {
    throw new AnswerReplyGrantStaleError();
  }

  const documentSourceIds = [...new Set(
    bindings.map(({ documentSourceId }) => documentSourceId),
  )].sort();
  for (const documentSourceId of documentSourceIds) {
    const sourceLock = await client.query<{ id: string }>(
      `SELECT id FROM document_sources WHERE id = $1 FOR KEY SHARE`,
      [documentSourceId],
    );
    if (sourceLock.rows.length !== 1) throw new AnswerReplyGrantStaleError();
  }

  for (const binding of [...bindings].sort((left, right) =>
    left.grantId.localeCompare(right.grantId))) {
    const result = await client.query<{ id: string }>(
      `SELECT group_grant.id
       FROM document_source_group_grants group_grant
       JOIN document_sources source ON source.id = group_grant.document_source_id
       WHERE group_grant.id = $1
         AND group_grant.version = $2
         AND group_grant.document_source_id = $3
         AND group_grant.grantor_group_id = $4
         AND group_grant.grantee_group_id = $5
         AND group_grant.state = 'active'
         AND source.source_type = 'group_visible_document'
         AND (
           source.origin_group_id = group_grant.grantor_group_id
           OR EXISTS (
             SELECT 1 FROM document_source_evidence evidence
             WHERE evidence.document_source_id = source.id
               AND evidence.kind = 'group_message'
               AND evidence.group_id = group_grant.grantor_group_id
           )
         )
       FOR UPDATE OF group_grant`,
      [
        binding.grantId,
        binding.version,
        binding.documentSourceId,
        binding.grantorGroupId,
        binding.granteeGroupId,
      ],
    );
    if (result.rows.length !== 1) throw new AnswerReplyGrantStaleError();
  }
}

function collectSourceGrantBindings(
  sources: readonly AnswerDocumentSourceLockBinding[],
): SourceGrantBinding[] {
  requireConsistentSourceGrantBindings(sources);
  const byGrantId = new Map<string, SourceGrantBinding>();
  for (const source of sources) {
    if (source.crossGroupGrantId === undefined) continue;
    const binding: SourceGrantBinding = {
      grantId: source.crossGroupGrantId,
      version: source.crossGroupGrantVersion!,
      documentSourceId: source.documentSourceId,
      grantorGroupId: source.crossGroupGrantorGroupId!,
      granteeGroupId: source.crossGroupGranteeGroupId!,
    };
    const existing = byGrantId.get(binding.grantId);
    if (existing !== undefined && sourceGrantSignature(existing) !== sourceGrantSignature(binding)) {
      throw new AnswerReplyGrantStaleError();
    }
    byGrantId.set(binding.grantId, binding);
  }
  return [...byGrantId.values()];
}

export function requireConsistentSourceGrantBindings(
  sources: readonly AnswerDocumentSourceLockBinding[],
): void {
  const byDocumentSourceId = new Map<string, string>();
  for (const source of sources) {
    const signature = JSON.stringify([
      source.crossGroupGrantId,
      source.crossGroupGrantVersion,
      source.crossGroupGrantorGroupId,
      source.crossGroupGranteeGroupId,
    ]);
    const existing = byDocumentSourceId.get(source.documentSourceId);
    if (existing !== undefined && existing !== signature) {
      throw new Error("sourceTrace cross-group grant is inconsistent");
    }
    byDocumentSourceId.set(source.documentSourceId, signature);
  }
}

function sourceGrantSignature(binding: SourceGrantBinding): string {
  return JSON.stringify([
    binding.version,
    binding.documentSourceId,
    binding.grantorGroupId,
    binding.granteeGroupId,
  ]);
}
