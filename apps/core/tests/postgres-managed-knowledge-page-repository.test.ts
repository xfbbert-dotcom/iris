import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import pg from "pg";
import { describe, expect, it } from "vitest";

import { createPostgresManagedKnowledgePageRepository } from "../src/action-approvals/postgres-managed-knowledge-page-repository.js";
import type { PostgresKnowledgeDraftDataSource } from "../src/knowledge-governance/postgres-knowledge-draft-repository.js";
import { defaultMigrationsDir, runMigrations, type MigrationClient } from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe.sequential : describe.skip;

describe("managed knowledge page migration contract", () => {
  it("installs exact managed-page and update invariants", async () => {
    const sql = await readFile(
      new URL("../migrations/0052_managed_knowledge_publication_updates.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toMatch(/CREATE TABLE managed_knowledge_pages/iu);
    expect(sql).toMatch(/CREATE TABLE knowledge_publication_update_targets/iu);
    expect(sql).toMatch(/CREATE UNIQUE INDEX managed_knowledge_updates_one_unresolved_page_idx/iu);
    expect(sql).toMatch(/managed_knowledge_page_events_append_only/iu);
    expect(sql).toMatch(/knowledge_publication_updates_append_only/iu);
  });

  it("exposes a focused managed-page repository", () => {
    const repository = createPostgresManagedKnowledgePageRepository({
      dataSource: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    });
    expect(repository.registerPublication).toBeTypeOf("function");
    expect(repository.claimApprovedUpdate).toBeTypeOf("function");
    expect(repository.markRemoteRequestDispatched).toBeTypeOf("function");
    expect(repository.getSourceAvailability).toBeTypeOf("function");
  });

  it("keeps only stale dispatched executions eligible for recovery", async () => {
    const source = await readFile(
      new URL("../src/action-approvals/postgres-managed-knowledge-page-repository.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/state IN \('outcome_unknown','reconciliation_required'\).*remote_request_dispatched/isu);
    expect(source).toMatch(/remote_request_dispatched_at <= \$2/iu);
  });
});

runIfDatabase("PostgresManagedKnowledgePageRepository", () => {
  const schema = `managed_page_${randomUUID().replaceAll("-", "")}`;
  const at = new Date("2026-08-20T00:00:00.000Z");
  let adminPool: pg.Pool;
  let pool: pg.Pool;

  it("registers one exact managed page idempotently and rejects a conflicting operation replay", async () => {
    adminPool = new pg.Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    pool = new pg.Pool({ connectionString: isolatedUrl.toString() });
    try {
      await runMigrations({ client: pool as unknown as MigrationClient, migrationsDir: defaultMigrationsDir() });
      const suffix = randomUUID();
      const policyId = `policy-${suffix}`;
      const draftId = `draft-${suffix}`;
      const proposalId = `proposal-${suffix}`;
      const executionId = `execution-${suffix}`;
      const publicationId = `publication-${suffix}`;
      await pool.query(`
        INSERT INTO knowledge_publication_target_policies (
          id, space_id, display_name, allowed_group_ids, allowed_risk_levels, enabled,
          version, operation_key, operation_fingerprint, created_by, updated_by, created_at, updated_at
        ) VALUES ($1, 'space', 'Policy', ARRAY['group'], ARRAY['low'], TRUE, 1, $2, repeat('a', 64), 'test', 'test', $3, $3)
      `, [policyId, `policy:${suffix}`, at]);
      await pool.query("BEGIN");
      try {
        await pool.query(`
        INSERT INTO knowledge_drafts (
          id, origin_kind, status, current_revision_number, version, created_by, created_at, updated_at
        ) VALUES ($1, 'user_requested', 'published', 1, 1, 'test', $2, $2)
        `, [draftId, at]);
        await pool.query(`
        INSERT INTO knowledge_draft_revisions (
          draft_id, revision_number, title, content, risk_level, author, created_at
        ) VALUES ($1, 1, 'Title', 'Content', 'low', 'test', $2)
        `, [draftId, at]);
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
      await pool.query(`
        INSERT INTO action_proposals (
          id, action_type, subject_type, subject_id, subject_revision, subject_version, target_policy_id,
          target_policy_version, risk_level, status, operation_key, operation_fingerprint, version, created_at, updated_at
        ) VALUES ($1, 'publish_knowledge_draft', 'knowledge_draft', $2, 1, 1, $3, 1, 'low', 'succeeded', $4, repeat('b', 64), 1, $5, $5)
      `, [proposalId, draftId, policyId, `proposal:${suffix}`, at]);
      await pool.query(`
        INSERT INTO action_executions (
          id, proposal_id, attempt_number, state, request_fingerprint, provider, version, created_at, updated_at
        ) VALUES ($1, $2, 1, 'succeeded', repeat('c', 64), 'feishu_wiki', 1, $3, $3)
      `, [executionId, proposalId, at]);
      await pool.query(`
        INSERT INTO knowledge_publications (
          id, proposal_id, execution_id, draft_id, revision_number, draft_version, target_policy_id,
          target_policy_version, space_id, remote_node_token, remote_document_token, remote_document_type,
          content_hash, permission_check_summary, operation_key, operation_fingerprint, published_at, created_at
        ) VALUES ($1, $2, $3, $4, 1, 1, $5, 1, 'space', 'node', 'document', 'docx', repeat('d', 64),
          'verified', $6, repeat('e', 64), $7, $7)
      `, [publicationId, proposalId, executionId, draftId, policyId, `publication:${suffix}`, at]);
      const repository = createPostgresManagedKnowledgePageRepository({
        dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
      });
      const validRegistration = {
        id: `page-${suffix}`,
        originKnowledgePublicationId: publicationId,
        targetPolicyId: policyId,
        targetPolicyVersion: 1,
        authorizationGroupId: "group",
        remoteNodeToken: `node-${suffix}`,
        remoteDocumentToken: `document-${suffix}`,
        managedBodyBlockId: `block-${suffix}`,
        currentRemoteRevisionId: "revision-12",
        currentBodyContentHash: "f".repeat(64),
        operationKey: `managed-register:${suffix}`,
        actor: "test",
        at,
      };
      const first = await repository.registerPublication(validRegistration);
      const replay = await repository.registerPublication(validRegistration);
      expect(first.outcome).toBe("applied");
      expect(replay).toEqual({ outcome: "already_applied", page: first.page });
      await expect(repository.registerPublication({
        ...validRegistration,
        currentRemoteRevisionId: "revision-13",
      })).rejects.toThrow(/operation conflict/iu);
      await expect(pool.query(
        "UPDATE managed_knowledge_page_events SET event_type = 'retired' WHERE managed_page_id = $1",
        [first.page.id],
      )).rejects.toThrow(/append-only/iu);

      const sourceId = `source-${suffix}`;
      const snapshotId = `snapshot-${suffix}`;
      const targetId = `target-${suffix}`;
      const updateProposalId = `update-proposal-${suffix}`;
      await pool.query(`
        INSERT INTO document_sources (
          id, source_type, source_uri, permission_state, sync_state,
          can_use_for_answering, can_use_for_knowledge_drafts, created_at, updated_at
        ) VALUES ($1, 'authorized_wiki_document', $2, 'readable', 'synced', TRUE, TRUE, $3, $3)
      `, [sourceId, `https://example.test/${sourceId}`, at]);
      await pool.query(`
        INSERT INTO document_snapshots (
          id, document_source_id, source_uri, fetch_status, body_text, content_hash, fetched_at, created_at
        ) VALUES ($1, $2, $3, 'succeeded', 'Snapshot body', repeat('a', 64), $4, $4)
      `, [snapshotId, sourceId, `https://example.test/${sourceId}`, at]);
      const messageId = `message-${suffix}`;
      const memoryId = `memory-${suffix}`;
      const candidateId = `candidate-${suffix}`;
      await pool.query(`INSERT INTO conversation_messages (id, provider, provider_message_id, chat_id, message_type, sent_at, raw_event_idempotency_key, created_at) VALUES ($1, 'feishu', $2, 'group', 'text', $3, $4, $3)`, [messageId, `provider-${suffix}`, at, `raw-${suffix}`]);
      await pool.query(`INSERT INTO group_memories (id, group_id, memory_scope, category, content, importance, confidence, status, idempotency_key, origin, created_by, request_fingerprint) VALUES ($1, 'group', 'group', 'decision', 'Current', 1, 0.9, 'active', $2, 'system', 'test', repeat('b', 64))`, [memoryId, `memory-key-${suffix}`]);
      await pool.query(`INSERT INTO knowledge_conflict_candidates (id,idempotency_key,group_id,group_memory_id,memory_updated_at,source_message_id,target_document_source_id,target_source_updated_at,target_snapshot_id,target_content_hash,detector_contract_version,status,subject,knowledge_base_statement,group_conclusion_statement,difference,suggested_update,target_document_ref,confidence,version,created_at,updated_at) VALUES ($1,$2,'group',$3,$4,$5,$6,$4,$7,repeat('a',64),'v1','pending_review','Subject','Prior','Current','Difference','Update','D1','high',1,$4,$4)`, [candidateId, `candidate-key-${suffix}`, memoryId, at, messageId, sourceId, snapshotId]);
      const linked = await repository.linkSource({
        managedPageId: first.page.id,
        expectedVersion: first.page.version,
        documentSourceId: sourceId,
        operationKey: `managed-link:${suffix}`,
        actor: "test",
        at,
      });
      await repository.bindConflictDraft({
        id: targetId,
        draftId,
        draftRevision: 1,
        draftVersion: 1,
        conflictCandidateId: candidateId,
        conflictCandidateVersion: 1,
        managedPageId: linked.page.id,
        managedPageVersion: linked.page.version,
        linkedDocumentSourceId: sourceId,
        targetSnapshotId: snapshotId,
        targetSnapshotHash: "a".repeat(64),
        remoteDocumentToken: linked.page.remoteDocumentToken,
        managedBodyBlockId: linked.page.managedBodyBlockId,
        expectedRemoteRevisionId: linked.page.currentRemoteRevisionId!,
        currentBodyContentHash: "f".repeat(64),
        proposedBodyContentHash: "c".repeat(64),
        authorizationGroupId: "group",
        targetPolicyId: policyId,
        targetPolicyVersion: 1,
        operationKey: `managed-target:${suffix}`,
        at,
      });
      await pool.query(`
        INSERT INTO action_proposals (
          id, action_type, subject_type, subject_id, subject_revision, subject_version, target_policy_id,
          target_policy_version, risk_level, status, operation_key, operation_fingerprint, version, created_at, updated_at
        ) VALUES ($1, 'update_knowledge_publication', 'knowledge_draft', $2, 1, 1, $3, 1,
          'low', 'approved', $4, repeat('b', 64), 1, $5, $5)
      `, [updateProposalId, draftId, policyId, `update-proposal:${suffix}`, at]);
      await pool.query(`INSERT INTO action_review_attestations (id, proposal_id, actor_open_id, subject_revision, subject_version, proposal_version, content_hash, session_id_hash, operation_key, operation_fingerprint, reviewed_at) VALUES ($1,$2,'reviewer',1,1,1,repeat('c',64),repeat('d',64),$3,repeat('e',64),$4)`, [`attestation-${suffix}`, updateProposalId, `attestation:${suffix}`, at]);
      const claimInput = {
        id: `update-execution-${suffix}`,
        proposalId: updateProposalId,
        updateTargetId: targetId,
        expectedManagedPageVersion: linked.page.version,
        operationKey: `managed-claim:${suffix}`,
        clientToken: `client-${suffix}`,
        workerId: "test-worker",
        at,
      };
      const claims = await Promise.all([
        repository.claimApprovedUpdate(claimInput),
        repository.claimApprovedUpdate(claimInput),
      ]);
      expect(claims.map((claim) => claim.outcome).sort()).toEqual(["already_applied", "applied"]);
    } finally {
      await pool?.end();
      await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool?.end();
    }
  });
});
