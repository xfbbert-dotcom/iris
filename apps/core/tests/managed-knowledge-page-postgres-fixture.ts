import { randomUUID } from "node:crypto";

export type ManagedKnowledgePageFixtureState =
  | "active"
  | "updating"
  | "resync_required"
  | "reconciliation_required"
  | "blocked"
  | "retired";

type FixtureQueryable = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  connect?: unknown;
  release?: unknown;
};

type FixtureClient = FixtureQueryable & { release(): void };

export async function insertManagedKnowledgePageFixture(input: {
  queryable: FixtureQueryable;
  state: ManagedKnowledgePageFixtureState;
  documentSourceId?: string;
  currentReconciledSnapshotId?: string;
  suffix?: string;
  at?: Date;
}): Promise<{ pageId: string; pageVersion: number }> {
  if (isFixturePool(input.queryable)) {
    const client = await input.queryable.connect();
    try {
      await client.query("BEGIN");
      const result = await insertManagedKnowledgePageFixture({ ...input, queryable: client });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const suffix = input.suffix ?? randomUUID().replaceAll("-", "");
  const at = input.at ?? new Date("2026-08-20T00:00:00.000Z");
  const policyId = `managed-fixture-policy-${suffix}`;
  const draftId = `managed-fixture-draft-${suffix}`;
  const proposalId = `managed-fixture-proposal-${suffix}`;
  const executionId = `managed-fixture-execution-${suffix}`;
  const publicationId = `managed-fixture-publication-${suffix}`;
  const pageId = `managed-fixture-page-${suffix}`;

  await input.queryable.query(
    `INSERT INTO knowledge_publication_target_policies (
       id, space_id, display_name, allowed_group_ids, allowed_risk_levels, enabled,
       version, operation_key, operation_fingerprint, created_by, updated_by, created_at, updated_at
     ) VALUES ($1, $2, 'Managed fixture policy', ARRAY[$3], ARRAY['low'], TRUE,
       1, $4, repeat('a', 64), 'test', 'test', $5, $5)`,
    [policyId, `managed-fixture-space-${suffix}`, `managed-fixture-group-${suffix}`,
      `managed-fixture-policy-op-${suffix}`, at],
  );
  await input.queryable.query(
    `INSERT INTO knowledge_drafts (
       id, origin_kind, status, current_revision_number, version, created_by, created_at, updated_at
     ) VALUES ($1, 'user_requested', 'published', 1, 1, 'test', $2, $2)`,
    [draftId, at],
  );
  await input.queryable.query(
    `INSERT INTO knowledge_draft_revisions (
       draft_id, revision_number, title, content, risk_level, author, created_at
     ) VALUES ($1, 1, 'Managed fixture', 'Managed fixture body', 'low', 'test', $2)`,
    [draftId, at],
  );
  await input.queryable.query(
    `INSERT INTO action_proposals (
       id, action_type, subject_type, subject_id, subject_revision, subject_version,
       target_policy_id, target_policy_version, risk_level, status, operation_key,
       operation_fingerprint, version, created_at, updated_at
     ) VALUES ($1, 'publish_knowledge_draft', 'knowledge_draft', $2, 1, 1,
       $3, 1, 'low', 'succeeded', $4, repeat('b', 64), 1, $5, $5)`,
    [proposalId, draftId, policyId, `managed-fixture-proposal-op-${suffix}`, at],
  );
  await input.queryable.query(
    `INSERT INTO action_executions (
       id, proposal_id, attempt_number, state, request_fingerprint, provider,
       version, created_at, updated_at
     ) VALUES ($1, $2, 1, 'succeeded', repeat('c', 64), 'feishu_wiki', 1, $3, $3)`,
    [executionId, proposalId, at],
  );
  await input.queryable.query(
    `INSERT INTO knowledge_publications (
       id, proposal_id, execution_id, draft_id, revision_number, draft_version,
       target_policy_id, target_policy_version, space_id, remote_node_token,
       remote_document_token, remote_document_type, content_hash,
       permission_check_summary, operation_key, operation_fingerprint, published_at, created_at
     ) VALUES ($1, $2, $3, $4, 1, 1, $5, 1, $6, $7, $8, 'docx',
       repeat('d', 64), 'verified', $9, repeat('e', 64), $10, $10)`,
    [publicationId, proposalId, executionId, draftId, policyId,
      `managed-fixture-space-${suffix}`, `managed-fixture-node-${suffix}`,
      `managed-fixture-document-${suffix}`, `managed-fixture-publication-op-${suffix}`, at],
  );
  await input.queryable.query(
    `INSERT INTO managed_knowledge_pages (
       id, origin_knowledge_publication_id, target_policy_id, target_policy_version,
       authorization_group_id, remote_node_token, remote_document_token,
       managed_body_block_id, linked_document_source_id, current_remote_revision_id,
       current_body_content_hash, expected_resync_content_hash, current_reconciled_snapshot_id,
       state, version, created_at, updated_at
     ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, 'revision-1', repeat('f', 64),
       $9, $10, $11, 1, $12, $12)`,
    [pageId, publicationId, policyId, `managed-fixture-group-${suffix}`,
      `managed-fixture-node-${suffix}`, `managed-fixture-document-${suffix}`,
      `managed-fixture-block-${suffix}`, input.documentSourceId ?? null,
      input.state === "resync_required" ? "0".repeat(64) : null,
      input.currentReconciledSnapshotId ?? null, input.state, at],
  );

  return { pageId, pageVersion: 1 };
}

function isFixturePool(
  queryable: FixtureQueryable,
): queryable is FixtureQueryable & { connect(): Promise<FixtureClient> } {
  return typeof queryable.connect === "function" && typeof queryable.release !== "function";
}
