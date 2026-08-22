import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { createPostgresManagedKnowledgePageRepository } from "../src/action-approvals/postgres-managed-knowledge-page-repository.js";
import { createPostgresActionProposalRepository } from "../src/action-approvals/postgres-action-proposal-repository.js";
import { createPostgresKnowledgeCardRepository } from "../src/knowledge-cards/postgres-knowledge-card-repository.js";
import { createPostgresKnowledgeDraftRepository } from "../src/knowledge-governance/postgres-knowledge-draft-repository.js";
import type { PostgresKnowledgeDraftDataSource } from "../src/knowledge-governance/postgres-knowledge-draft-repository.js";
import { defaultMigrationsDir, runMigrations, type MigrationClient } from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim()
  || process.env.DATABASE_URL?.trim();
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

  it("adds exact approval and mutation executor identity without rewriting existing executions", async () => {
    const sql = await readFile(
      new URL("../migrations/0055_managed_update_execution_identity.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toMatch(/ALTER TABLE knowledge_publication_update_executions[\s\S]+ADD COLUMN approval_id/iu);
    expect(sql).toMatch(/ADD COLUMN executor_id/iu);
    expect(sql).toMatch(/REFERENCES action_approvals\s*\(id\)/iu);
    expect(sql).not.toMatch(/UPDATE knowledge_publication_update_executions/iu);
  });

  it("adds append-only exact-profile reindex completion and reconciled snapshot identity", async () => {
    const sql = await readFile(
      new URL("../migrations/0056_managed_resync_index_completion.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toMatch(/CREATE TABLE document_snapshot_reindex_completions/iu);
    expect(sql).toMatch(/UNIQUE\s*\(document_snapshot_id, embedding_profile_id\)/iu);
    expect(sql).toMatch(/fragment_count[^\n]+CHECK\s*\(fragment_count >= 0\)/iu);
    expect(sql).toMatch(/current_reconciled_snapshot_id/iu);
    expect(sql).toMatch(/document_snapshot_reindex_completions_append_only/iu);
  });

  it("exposes a focused managed-page repository", () => {
    const repository = createPostgresManagedKnowledgePageRepository({
      dataSource: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    });
    expect(repository.registerPublication).toBeTypeOf("function");
    expect(repository.claimApprovedUpdate).toBeTypeOf("function");
    expect(repository.markRemoteRequestDispatched).toBeTypeOf("function");
    expect(repository.claimRemoteRetry).toBeTypeOf("function");
    expect(repository.findResyncReadyExecution).toBeTypeOf("function");
    expect(repository.completeResync).toBeTypeOf("function");
    expect(repository.getSourceAvailability).toBeTypeOf("function");
  });

  it("discovers durable uncertain/applied work plus only stale claimed/dispatched requests", async () => {
    const source = await readFile(
      new URL("../src/action-approvals/postgres-managed-knowledge-page-repository.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/state IN \('outcome_unknown','reconciliation_required','remote_applied'\).*remote_request_dispatched/isu);
    expect(source).toMatch(/remote_request_dispatched_at <= \$2/iu);
    expect(source).toMatch(/state = 'claimed'[\s\S]+updated_at <= \$3/iu);
  });
});

describe("managed knowledge page exact remote identity lookup", () => {
  const pageRow = {
    id: "managed-1",
    origin_knowledge_publication_id: "publication-1",
    target_policy_id: "policy-1",
    target_policy_version: "1",
    authorization_group_id: "group-1",
    remote_node_token: "wiki-node-1",
    remote_document_token: "docx-1",
    managed_body_block_id: "blk_body",
    linked_document_source_id: null,
    current_remote_revision_id: "12",
    current_body_content_hash: "a".repeat(64),
    expected_resync_content_hash: null,
    state: "active",
    version: "1",
    created_at: new Date("2026-08-20T00:00:00.000Z"),
    updated_at: new Date("2026-08-20T00:00:00.000Z"),
  };

  it("finds one page only when every supplied token identifies that exact row", async () => {
    const query = vi.fn(async () => ({ rows: [pageRow], rowCount: 1 }));
    const repository = createPostgresManagedKnowledgePageRepository({
      dataSource: { query } as never,
    });

    await expect(repository.findByRemoteIdentity({
      remoteWikiNodeToken: "wiki-node-1",
      remoteDocumentToken: "docx-1",
    })).resolves.toMatchObject({ id: "managed-1" });
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/remote_node_token = \$1[\s\S]+remote_document_token = \$2/iu), [
      "wiki-node-1",
      "docx-1",
    ]);
  });

  it("fails closed for absent, disagreeing, or ambiguous exact identities", async () => {
    const repository = createPostgresManagedKnowledgePageRepository({
      dataSource: {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [pageRow], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [pageRow, { ...pageRow, id: "managed-2" }], rowCount: 2 }),
      } as never,
    });

    await expect(repository.findByRemoteIdentity({})).rejects.toThrow("remote identity is required");
    await expect(repository.findByRemoteIdentity({
      remoteWikiNodeToken: "wiki-node-1",
      remoteDocumentToken: "different-docx",
    })).rejects.toThrow("remote identity is ambiguous");
    await expect(repository.findByRemoteIdentity({
      remoteWikiNodeToken: "wiki-node-1",
    })).rejects.toThrow("remote identity is ambiguous");
  });

  it("does not hide an existing ineligible page behind an absent-page result", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        ...pageRow,
        linked_document_source_id: "source-1",
        state: "blocked",
      }],
      rowCount: 1,
    }));
    const repository = createPostgresManagedKnowledgePageRepository({
      dataSource: { query } as never,
    });

    await expect(repository.findPageForConflict({
      documentSourceId: "source-1",
      authorizationGroupId: "group-1",
    })).resolves.toMatchObject({ id: "managed-1", state: "blocked" });
    expect(query).toHaveBeenCalledWith(
      expect.not.stringMatching(/state\s*=\s*'active'/iu),
      ["source-1", "group-1"],
    );
  });
});

describe("managed update admin metadata projection", () => {
  it("binds metadata to the exact proposal target instead of a newer draft target", async () => {
    const at = new Date("2026-08-21T00:00:00.000Z");
    const oldTarget = managedTargetRow({ id: "target-old", expected_remote_revision_id: "11" });
    const newerTarget = managedTargetRow({ id: "target-new", expected_remote_revision_id: "12" });
    const page = managedPageRow({ id: "page-1", linked_document_source_id: "source-1", version: "4", updated_at: at });
    const execution = managedExecutionRow({ update_target_id: "target-old", managed_page_id: "page-1", created_at: at, updated_at: at });
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replaceAll(/\s+/gu, " ");
      if (normalized.includes("FROM knowledge_publication_update_targets") && normalized.includes("JOIN action_proposals")) {
        return { rows: [oldTarget] };
      }
      if (normalized.includes("FROM knowledge_publication_update_targets")) return { rows: [newerTarget] };
      if (normalized.includes("FROM managed_knowledge_pages")) return { rows: [page] };
      if (normalized.includes("FROM knowledge_publication_update_executions")) return { rows: [execution] };
      if (normalized.includes("FROM knowledge_publication_update_execution_events")) return { rows: [] };
      return { rows: [] };
    });
    const repository = createPostgresManagedKnowledgePageRepository({ dataSource: { query } as never });

    const metadata = await repository.getMetadataForProposal("proposal-old");

    expect(metadata?.managedTarget).toMatchObject({ id: "target-old", expectedRevision: "11" });
  });

  it("projects only safe target, page, execution, and immutable event metadata", async () => {
    const at = new Date("2026-08-21T00:00:00.000Z");
    const target = {
      id: "target-1", draft_id: "draft-1", draft_revision: "2", draft_version: "7",
      conflict_candidate_id: "candidate-1", conflict_candidate_version: "5", managed_page_id: "page-1",
      managed_page_version: "8", linked_document_source_id: "source-1", target_snapshot_id: "snapshot-1",
      target_snapshot_hash: "c".repeat(64), target_source_version: "source-v1", remote_document_token: "docx_secret",
      managed_body_block_id: "blk_secret", expected_remote_revision_id: "13",
      current_body_content_hash: "a".repeat(64), proposed_body_content_hash: "b".repeat(64),
      authorization_group_id: "group-1", target_policy_id: "policy-1", target_policy_version: "3",
      operation_key: "target-op", operation_fingerprint: "d".repeat(64), created_at: at,
    };
    const page = managedPageRow({
      id: "page-1", linked_document_source_id: "source-1", remote_node_token: "wiki-node-1",
      remote_document_token: "docx_secret", managed_body_block_id: "blk_secret", current_remote_revision_id: "12",
      state: "reconciliation_required", version: "8", updated_at: at,
    });
    const execution = {
      id: "execution-1", proposal_id: "proposal-1", approval_id: "approval-1", executor_id: "worker-1",
      managed_page_id: "page-1", managed_page_version: "8", update_target_id: "target-1", attempt_number: "1",
      state: "outcome_unknown", operation_key: "execution-op", operation_fingerprint: "e".repeat(64),
      request_fingerprint: "f".repeat(64), expected_remote_revision_id: "13", before_body_content_hash: "a".repeat(64),
      after_body_content_hash: "b".repeat(64), client_token: "tenant-token", response_revision_id: null,
      response_classification: "timeout", reconciliation_reason_code: "readback_unavailable",
      remote_request_dispatched_at: at, version: "4", created_at: at, updated_at: at,
    };
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replaceAll(/\s+/gu, " ");
      if (normalized.includes("FROM knowledge_publication_update_execution_events")) {
        return { rows: [{ execution_id: "execution-1", event_type: "remote_outcome_unknown", from_version: "3",
          to_version: "4", reason_code: "readback_unavailable", created_at: at }] };
      }
      if (normalized.includes("FROM knowledge_publication_update_executions")) return { rows: [execution] };
      if (normalized.includes("FROM managed_knowledge_pages")) return { rows: [page] };
      if (normalized.includes("FROM knowledge_publication_update_targets")) return { rows: [target] };
      return { rows: [] };
    });
    const repository = createPostgresManagedKnowledgePageRepository({ dataSource: { query } as never });

    const metadata = await repository.getMetadataForProposal("proposal-1");

    expect(metadata).toMatchObject({
      managedTarget: { id: "target-1", expectedRevision: "13", currentBodyHash: "a".repeat(64) },
      page: { id: "page-1", sourceId: "source-1", currentRevision: "12", version: 8,
        safeWikiUrl: "https://www.feishu.cn/wiki/wiki-node-1" },
      executions: [{ id: "execution-1", requestFingerprint: "f".repeat(64), reasonCode: "readback_unavailable",
        events: [{ type: "remote_outcome_unknown", fromVersion: 3, toVersion: 4, reasonCode: "readback_unavailable" }] }],
    });
    expect(JSON.stringify(metadata)).not.toMatch(/docx_secret|blk_secret|tenant-token|New approved body/iu);
  });
});

describe("managed knowledge page source-link serialization", () => {
  it("locks the normalized source identity before reading or updating the managed page", async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const at = new Date("2026-08-20T00:00:00.000Z");
    const initialPage = managedPageRow({ updated_at: at });
    const linkedPage = managedPageRow({
      linked_document_source_id: "source-1",
      version: "2",
      updated_at: at,
    });
    const query = async (sql: string, values?: unknown[]) => {
      const normalized = sql.replaceAll(/\s+/gu, " ").trim();
      statements.push({ sql: normalized, values });
      if (normalized.includes("FROM managed_knowledge_page_events")) return { rows: [] };
      if (normalized.includes("FROM managed_knowledge_pages") && normalized.includes("FOR UPDATE")) {
        return { rows: [initialPage] };
      }
      if (normalized.includes("FROM managed_knowledge_pages")) return { rows: [linkedPage] };
      return { rows: [] };
    };
    const repository = createPostgresManagedKnowledgePageRepository({
      dataSource: {
        query,
        async connect() { return { query, release() {} }; },
      } as PostgresKnowledgeDraftDataSource,
    });

    await expect(repository.linkSource({
      managedPageId: "managed-1",
      expectedVersion: 1,
      documentSourceId: " source-1 ",
      operationKey: "managed-link:source-1",
      actor: "test",
      at,
    })).resolves.toMatchObject({
      outcome: "applied",
      page: { id: "managed-1", linkedDocumentSourceId: "source-1", version: 2 },
    });

    const sourceLockIndex = statements.findIndex(({ sql, values }) =>
      sql.includes("pg_advisory_xact_lock")
      && values?.[0] === "managed-knowledge-source:source-1");
    const pageLockIndex = statements.findIndex(({ sql }) =>
      sql.includes("FROM managed_knowledge_pages") && sql.includes("FOR UPDATE"));
    expect(sourceLockIndex).toBeGreaterThanOrEqual(0);
    expect(sourceLockIndex).toBeLessThan(pageLockIndex);
  });
});

describe("managed update claim contract", () => {
  it("returns exact immutable draft content and derives a stable UUID client token after exact attestation validation", async () => {
    const fixture = managedUpdateClaimDataSource();
    const repository = createPostgresManagedKnowledgePageRepository({ dataSource: fixture.dataSource });

    const result = await repository.claimApprovedUpdate(managedUpdateClaimInput());
    if (result.outcome === "terminal") throw new Error("expected managed update claim");

    expect(result).toMatchObject({
      outcome: "applied",
      proposal: {
        id: "update-proposal-1",
        actionType: "update_knowledge_publication",
        status: "executing",
        version: 4,
      },
      draft: {
        id: "update-draft-1",
        sourceGroupId: "group-1",
        revisionNumber: 1,
        version: 4,
        content: "New approved body",
      },
      page: { id: "managed-1", state: "updating", version: 2 },
      execution: {
        id: "e4f1ec52-3d3d-5f72-a7e4-ecde994e3ed5",
        approvalId: "approval-1",
        executorId: "managed-update-worker",
        clientToken: "8b2dcd5d-37ab-5b63-94d2-7e3eb6d3b271",
        state: "claimed",
      },
    });
    expect(result.execution.clientToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(fixture.attestationFingerprints).toEqual([managedUpdateTargetFingerprint()]);
    const sourceLock = fixture.statements.findIndex((_sql, index) =>
      fixture.statementValues[index]?.[0] === "managed-knowledge-source:source-1");
    const pageLock = fixture.statements.findIndex((sql) =>
      sql.includes("FROM managed_knowledge_pages") && sql.includes("FOR UPDATE"));
    const targetLock = fixture.statements.findIndex((sql) =>
      sql.includes("FROM knowledge_publication_update_targets") && sql.includes("FOR UPDATE"));
    const proposalLock = fixture.statements.findIndex((sql) =>
      sql.includes("FROM action_proposals") && sql.includes("FOR UPDATE"));
    expect(sourceLock).toBeGreaterThanOrEqual(0);
    expect(sourceLock).toBeLessThan(pageLock);
    expect(pageLock).toBeLessThan(targetLock);
    expect(targetLock).toBeLessThan(proposalLock);
  });

  it("durably terminalizes a claim whose approval-time attestation is not bound to the exact target", async () => {
    const fixture = managedUpdateClaimDataSource({ hasExactAttestation: false });
    const repository = createPostgresManagedKnowledgePageRepository({ dataSource: fixture.dataSource });

    await expect(repository.claimApprovedUpdate(managedUpdateClaimInput())).resolves.toEqual({
      outcome: "terminal",
      proposalId: "update-proposal-1",
      proposalVersion: 4,
      code: "approval_chain_invalid",
    });
    expect(fixture.statements.some((sql) =>
      sql.includes("INSERT INTO knowledge_publication_update_executions"))).toBe(false);
  });

  it.each(["unknown", "denied", "stale"])(
    "terminalizes a claim whose durable source permission is %s",
    async (permissionState) => {
      const fixture = managedUpdateClaimDataSource({ permissionState });
      const repository = createPostgresManagedKnowledgePageRepository({
        dataSource: fixture.dataSource,
      });

      await expect(repository.claimApprovedUpdate(managedUpdateClaimInput())).resolves.toEqual({
        outcome: "terminal",
        proposalId: "update-proposal-1",
        proposalVersion: 4,
        code: "stale_target",
      });
      expect(fixture.statements.some((sql) =>
        sql.includes("INSERT INTO knowledge_publication_update_executions"))).toBe(false);
    },
  );

  it("atomically terminalizes an approved loser before starting the winning page execution", async () => {
    const fixture = managedUpdateClaimDataSource({ hasCompetingProposal: true });
    const repository = createPostgresManagedKnowledgePageRepository({ dataSource: fixture.dataSource });

    await expect(repository.claimApprovedUpdate(managedUpdateClaimInput())).resolves.toMatchObject({
      outcome: "applied",
      proposal: { id: "update-proposal-1", status: "executing" },
    });
    expect(fixture.terminalizedProposalIds).toEqual(["competing-proposal-1"]);
    const loserEvent = fixture.statements.findIndex((sql) =>
      sql.includes("'execution_failed'") && sql.includes("'competing_execution'"));
    const pageClaim = fixture.statements.findIndex((sql) =>
      sql.startsWith("UPDATE managed_knowledge_pages SET state = 'updating'"));
    expect(loserEvent).toBeGreaterThanOrEqual(0);
    expect(loserEvent).toBeLessThan(pageClaim);
  });
});

describe("managed update outcome transition contract", () => {
  it("records an operator reconciliation request with exact versions and a replay-safe operation key", async () => {
    const fixture = managedUpdateClaimDataSource({ executionState: "outcome_unknown", executionVersion: 4 });
    const repository = createPostgresManagedKnowledgePageRepository({ dataSource: fixture.dataSource });
    const input = {
      executionId: "e4f1ec52-3d3d-5f72-a7e4-ecde994e3ed5",
      expectedExecutionVersion: 4,
      expectedManagedPageVersion: 1,
      operationKey: "managed-update-reconcile:execution-1:4",
      operator: "operator@example.com",
      at: new Date("2026-08-21T02:00:00.000Z"),
    };

    const first = await repository.requestReconciliation(input);
    expect(first).toMatchObject({
      outcome: "applied",
      claim: { execution: { id: input.executionId } },
      acknowledgement: {
        executionId: input.executionId,
        state: "reconciliation_required",
        version: 5,
        reasonCode: "operator_requested",
      },
    });
    const executionEvent = fixture.statements.findIndex((sql) =>
      sql.includes("INSERT INTO knowledge_publication_update_execution_events"));
    const pageEvent = fixture.statements.findIndex((sql) =>
      sql.includes("INSERT INTO managed_knowledge_page_events"));
    expect(executionEvent).toBeGreaterThanOrEqual(0);
    expect(pageEvent).toBeGreaterThan(executionEvent);
    expect(fixture.statementValues[pageEvent]).toContain("operator@example.com");
    expect(fixture.statementValues[executionEvent]).toContain(5);
    expect(fixture.statementValues[pageEvent]).toContain(2);

    const replay = await repository.requestReconciliation({
      ...input,
      at: new Date("2026-08-21T02:00:01.000Z"),
    });
    expect(replay).toMatchObject({ outcome: "already_applied" });
    expect(replay.acknowledgement).toEqual(first.acknowledgement);

    await expect(repository.requestReconciliation({
      ...input,
      operator: "different-operator@example.com",
      at: new Date("2026-08-21T02:00:02.000Z"),
    })).rejects.toThrow(/operation conflict/iu);

    await expect(repository.requestReconciliation({ ...input, expectedExecutionVersion: 5,
      operationKey: "managed-update-reconcile:execution-1:5" })).rejects.toThrow(/version conflict/iu);

    await expect(repository.requestReconciliation({ ...input, expectedManagedPageVersion: 3,
      operationKey: "managed-update-reconcile:execution-1:page-3" })).rejects.toThrow(/version conflict/iu);
  });

  it.each([
    ["reconciliation_required", "reconciliation_required"],
    ["blocked", "blocked"],
    ["retired", "retired"],
  ] as const)("keeps a dispatched rejection safely %s", async (pageDisposition, expectedState) => {
    const fixture = managedUpdateOutcomeDataSource();
    const repository = createPostgresManagedKnowledgePageRepository({ dataSource: fixture.dataSource });

    const result = await repository.recordRemoteOutcome({
      executionId: "execution-1",
      expectedExecutionVersion: 2,
      classification: "failed",
      pageDisposition,
      responseClassification: pageDisposition === "blocked" ? "forbidden" : pageDisposition,
      reconciliationReasonCode: pageDisposition,
      operationKey: `managed-update-outcome:${pageDisposition}`,
      actor: "managed-update-worker",
      at: new Date("2026-08-21T02:00:00.000Z"),
    });

    expect(result.page.state).toBe(expectedState);
    expect(result.execution.state).toBe("failed");
  });

  it("refuses to reopen active content after a dispatched failure", async () => {
    const fixture = managedUpdateOutcomeDataSource();
    const repository = createPostgresManagedKnowledgePageRepository({ dataSource: fixture.dataSource });

    await expect(repository.recordRemoteOutcome({
      executionId: "execution-1",
      expectedExecutionVersion: 2,
      classification: "failed",
      pageDisposition: "active",
      responseClassification: "stale_revision",
      operationKey: "managed-update-unsafe-active",
      actor: "managed-update-worker",
      at: new Date("2026-08-21T02:00:00.000Z"),
    })).rejects.toThrow(/version conflict/iu);
  });

  it("requires exact verified remote identity/revision/hash proof before a pre-dispatch active restore", async () => {
    const withoutProof = createPostgresManagedKnowledgePageRepository({
      dataSource: managedUpdateOutcomeDataSource({ executionState: "claimed", executionVersion: 1 }).dataSource,
    });
    const input = {
      executionId: "execution-1",
      expectedExecutionVersion: 1,
      classification: "preflight_failed" as const,
      pageDisposition: "active" as const,
      responseClassification: "request_not_sent",
      operationKey: "managed-update-safe-active:test",
      actor: "managed-update-worker",
      at: new Date("2026-08-21T02:00:00.000Z"),
    };
    await expect(withoutProof.recordRemoteOutcome(input)).rejects.toThrow(/version conflict/iu);

    const withProof = createPostgresManagedKnowledgePageRepository({
      dataSource: managedUpdateOutcomeDataSource({ executionState: "claimed", executionVersion: 1 }).dataSource,
    });
    await expect(withProof.recordRemoteOutcome({
      ...input,
      verifiedUnchangedRemote: {
        remoteDocumentToken: "docx-1",
        managedBodyBlockId: "blk_body",
        remoteRevisionId: "12",
        bodyContentHash: canonicalHash("Old approved body"),
      },
    })).resolves.toMatchObject({ page: { state: "active" } });
  });

  it("claims a same-token retry only after a dispatched request crosses the durable cutoff", async () => {
    const repository = createPostgresManagedKnowledgePageRepository({
      dataSource: managedUpdateOutcomeDataSource().dataSource,
    });
    const input = {
      executionId: "execution-1",
      expectedExecutionVersion: 2,
      operationKey: "managed-update-safe-retry:test",
      actor: "managed-update-reconciler",
      at: new Date("2026-08-21T01:02:00.000Z"),
    };

    await expect(repository.claimRemoteRetry({
      ...input,
      staleDispatchedBefore: new Date("2026-08-21T00:59:59.000Z"),
    })).rejects.toThrow(/version conflict/iu);
    await expect(repository.claimRemoteRetry({
      ...input,
      staleDispatchedBefore: new Date("2026-08-21T01:00:00.000Z"),
    })).resolves.toMatchObject({
      execution: {
        state: "remote_request_dispatched",
        clientToken: "8b2dcd5d-37ab-5b63-94d2-7e3eb6d3b271",
        version: 3,
      },
    });
  });
});

describe("managed update exact resync contract", () => {
  it("reactivates from a new successful exact observation and writes immutable success/proposal facts", async () => {
    const fixture = managedResyncDataSource();
    const repository = createPostgresManagedKnowledgePageRepository({ dataSource: fixture.dataSource });

    await expect(repository.findResyncReadyExecution({
      observationId: "observation-new",
      activeEmbeddingProfileId: "profile-active",
    })).resolves.toEqual({
      executionId: "execution-1",
      executionVersion: 3,
      managedPageVersion: 3,
      observationId: "observation-new",
    });
    const result = await repository.completeResync({
      executionId: "execution-1",
      expectedExecutionVersion: 3,
      expectedManagedPageVersion: 3,
      observationId: "observation-new",
      activeEmbeddingProfileId: "profile-active",
      operationKey: "managed-resync-complete:test",
      actor: "document-sync",
      at: new Date("2026-08-21T04:00:00.000Z"),
    });

    expect(result).toMatchObject({
      page: {
        state: "active",
        currentRemoteRevisionId: "13",
        currentBodyContentHash: canonicalHash("New approved body"),
        version: 4,
      },
      execution: { state: "succeeded", version: 4 },
    });
    expect(fixture.statements.some((sql) =>
      sql.includes("INSERT INTO knowledge_publication_updates"))).toBe(true);
    expect(fixture.statements.some((sql) =>
      sql.includes("INSERT INTO knowledge_publication_update_execution_events"))).toBe(true);
    expect(fixture.statements.some((sql) =>
      sql.includes("INSERT INTO managed_knowledge_page_events"))).toBe(true);
    expect(fixture.statements.some((sql) =>
      sql.includes("INSERT INTO action_events") && sql.includes("execution_succeeded"))).toBe(true);
    expect(fixture.statements.some((sql) =>
      sql.includes("document_snapshot_reindex_completions") &&
      sql.includes("embedding_profile_id"))).toBe(true);
    expect(fixture.proposalState()).toBe("succeeded");
    expect(fixture.immutableExecutorIds()).toEqual(["managed-update-worker"]);
    expect(fixture.immutableApprovalIds()).toEqual(["approval-1"]);
    expect(fixture.successEventActors()).toEqual(["document-sync"]);
  });

  it("does not expose an exact candidate when source permission is unusable", async () => {
    const fixture = managedResyncDataSource({ permissionUsable: false });
    const repository = createPostgresManagedKnowledgePageRepository({ dataSource: fixture.dataSource });

    await expect(repository.findResyncReadyExecution({
      observationId: "observation-new",
      activeEmbeddingProfileId: "profile-active",
    })).resolves.toBeUndefined();
  });

  it("requires readable durable permission and the exact active-profile completion at both resync gates", async () => {
    const fixture = managedResyncDataSource();
    const repository = createPostgresManagedKnowledgePageRepository({ dataSource: fixture.dataSource });

    await repository.findResyncReadyExecution({
      observationId: "observation-new",
      activeEmbeddingProfileId: "profile-active",
    });
    await repository.completeResync({
      executionId: "execution-1",
      expectedExecutionVersion: 3,
      expectedManagedPageVersion: 3,
      observationId: "observation-new",
      activeEmbeddingProfileId: "profile-active",
      operationKey: "managed-resync-complete:profile-proof",
      actor: "document-sync",
      at: new Date("2026-08-21T04:00:00.000Z"),
    });

    const gates = fixture.statements.filter((sql) =>
      sql.includes("document_snapshot_reindex_completions"));
    expect(gates).toHaveLength(2);
    expect(gates.every((sql) => sql.includes("source.permission_state = 'readable'"))).toBe(true);
    expect(gates.every((sql) => sql.includes("completion.embedding_profile_id"))).toBe(true);
  });

  it("completes a proven apply after an earlier local queue failure barred the proposal", async () => {
    const fixture = managedResyncDataSource({ initialProposalState: "reconciliation_required" });
    const repository = createPostgresManagedKnowledgePageRepository({ dataSource: fixture.dataSource });

    await expect(repository.completeResync({
      executionId: "execution-1",
      expectedExecutionVersion: 3,
      expectedManagedPageVersion: 3,
      observationId: "observation-new",
      activeEmbeddingProfileId: "profile-active",
      operationKey: "managed-resync-complete:queue-recovery",
      actor: "managed-update-reconciler",
      at: new Date("2026-08-21T04:00:00.000Z"),
    })).resolves.toMatchObject({
      page: { state: "active" },
      execution: { state: "succeeded" },
    });
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
      const updateDraftId = `update-draft-${suffix}`;
      const updateProposalId = `update-proposal-${suffix}`;
      const proposedBody = "New approved body";
      const proposedBodyHash = canonicalHash(proposedBody);
      await pool.query(`
        INSERT INTO document_sources (
          id, source_type, source_uri, permission_state, sync_state,
          can_use_for_answering, can_use_for_knowledge_drafts, created_at, updated_at
        ) VALUES ($1, 'authorized_wiki_document', $2, 'readable', 'synced', TRUE, TRUE, $3, $3)
      `, [sourceId, `https://example.test/${sourceId}`, at]);
      const reviewerOpenId = `ou-managed-reviewer-${suffix}`;
      const draftRepository = createPostgresKnowledgeDraftRepository({
        dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
      });
      const updateDraft = (await draftRepository.createDraft({
        id: updateDraftId,
        operationKey: `managed-update-draft:${suffix}`,
        originKind: "knowledge_conflict",
        createdBy: "test",
        revision: {
          sourceGroupId: "group",
          title: "Managed update",
          content: proposedBody,
          riskLevel: "low",
          reviewer: { type: "feishu_user", ref: reviewerOpenId },
          suggestedPublication: { spaceId: "space" },
          evidence: [{ type: "document_source", id: sourceId, expectedUpdatedAt: at }],
        },
        at,
      })).draft;
      expect(updateDraft).toMatchObject({ id: updateDraftId, version: 1 });
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
      await repository.recordSnapshotObservation({
        id: `initial-observation-${suffix}`,
        managedPageId: linked.page.id,
        managedPageVersion: linked.page.version,
        documentSnapshotId: snapshotId,
        documentSourceId: sourceId,
        snapshotContentHash: "a".repeat(64),
        observedRemoteRevisionId: linked.page.currentRemoteRevisionId!,
        observedManagedBodyBlockId: linked.page.managedBodyBlockId,
        observedBlockType: "text",
        managedBodyContentHash: "f".repeat(64),
        adapterVersion: "configured-pg-initial-v1",
        observedAt: at,
        operationKey: `initial-observation:${suffix}`,
        at,
      });
      await repository.bindConflictDraft({
        id: targetId,
        draftId: updateDraftId,
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
        proposedBodyContentHash: proposedBodyHash,
        authorizationGroupId: "group",
        targetPolicyId: policyId,
        targetPolicyVersion: 1,
        operationKey: `managed-target:${suffix}`,
        at,
      });
      await pool.query(
        `UPDATE knowledge_conflict_candidates
            SET status = 'draft_created',version = 2,updated_at = $2
          WHERE id = $1`,
        [candidateId, at],
      );
      await pool.query(`
        INSERT INTO knowledge_conflict_interactions (
          id,candidate_id,callback_operation_key,actor_ref,action,result,draft_id,created_at
        ) VALUES ($1,$2,$3,'test','create_draft','applied',$4,$5)
      `, [`interaction-${suffix}`, candidateId, `interaction:${suffix}`, updateDraftId, at]);

      const cardRepository = createPostgresKnowledgeCardRepository({
        dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
      });
      const groupPresentationId = `group-presentation-${suffix}`;
      await cardRepository.createPresentation({
        id: groupPresentationId,
        draftId: updateDraftId,
        expectedDraftVersion: 1,
        expectedRevisionNumber: 1,
        chatId: "group",
        contentHash: "8".repeat(64),
        operationKey: `group-presentation:${suffix}`,
        at,
      });
      const cardWorker = `group-card-worker-${suffix}`;
      await cardRepository.claimPresentationSend({ workerId: cardWorker, leaseUntil: new Date(at.getTime() + 30_000), at });
      await cardRepository.beginExternalAttempt({ presentationId: groupPresentationId, workerId: cardWorker, at });
      await cardRepository.completePresentationSend({
        presentationId: groupPresentationId,
        workerId: cardWorker,
        messageId: `om-group-${suffix}`,
        at,
      });
      const confirmed = await cardRepository.applyInteraction({
        presentationId: groupPresentationId,
        draftId: updateDraftId,
        revisionNumber: 1,
        draftVersion: 1,
        chatId: "group",
        eventId: `group-confirm-callback-${suffix}`,
        actorOpenId: `ou-group-member-${suffix}`,
        membershipCheckedAt: at,
        at,
        action: "confirm",
      });
      expect(confirmed.draft).toMatchObject({ version: 2, status: "pending_review" });
      const groupUpdateSend = await cardRepository.claimPresentationSend({
        workerId: cardWorker,
        leaseUntil: new Date(at.getTime() + 30_000),
        at,
      });
      expect(groupUpdateSend?.presentation.id).toBe(groupPresentationId);
      await cardRepository.beginExternalAttempt({
        presentationId: groupPresentationId,
        workerId: cardWorker,
        at,
      });
      await cardRepository.completePresentationSend({
        presentationId: groupPresentationId,
        workerId: cardWorker,
        messageId: `om-group-${suffix}`,
        at,
      });

      const actionRepository = createPostgresActionProposalRepository({
        dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
      });
      const planned = await actionRepository.createProposal({
        proposalId: updateProposalId,
        actionType: "update_knowledge_publication",
        draftId: updateDraftId,
        expectedRevision: 1,
        expectedDraftVersion: confirmed.draft.version,
        targetPolicyId: policyId,
        expectedTargetPolicyVersion: 1,
        operationKey: `update-proposal:${suffix}`,
        at,
      });
      expect(planned.proposal).toMatchObject({ status: "pending_approval", subjectVersion: 2, version: 1 });
      const plannedContext = await actionRepository.getProposal(updateProposalId);
      expect(plannedContext?.requirements).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "group_confirmation", state: "satisfied" }),
        expect.objectContaining({ kind: "designated_owner", state: "pending", roleRef: reviewerOpenId }),
      ]));
      const ownerRequirement = plannedContext?.requirements.find((item) => item.kind === "designated_owner");
      expect(ownerRequirement).toBeDefined();
      const approvalSend = await actionRepository.claimApprovalPresentationSend({
        workerId: `approval-worker-${suffix}`,
        leaseUntil: new Date(at.getTime() + 30_000),
        at,
      });
      expect(approvalSend?.presentation).toMatchObject({
        proposalId: updateProposalId,
        requirementId: ownerRequirement!.id,
        proposalVersion: planned.proposal.version,
        recipientOpenId: reviewerOpenId,
      });
      await actionRepository.beginApprovalExternalAttempt({
        presentationId: approvalSend!.presentation.id,
        workerId: `approval-worker-${suffix}`,
        at,
      });
      await actionRepository.completeApprovalPresentationSend({
        presentationId: approvalSend!.presentation.id,
        workerId: `approval-worker-${suffix}`,
        messageId: `om-approval-${suffix}`,
        at,
      });
      const reviewContext = await actionRepository.getAuthorizedReviewContext({
        proposalId: updateProposalId,
        actorOpenId: reviewerOpenId,
      });
      expect(reviewContext).toMatchObject({
        actionType: "update_knowledge_publication",
        proposalVersion: planned.proposal.version,
        subjectVersion: confirmed.draft.version,
        contentHash: proposedBodyHash,
        actionTargetFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      await actionRepository.recordReviewAttestation({
        proposalId: updateProposalId,
        actorOpenId: reviewerOpenId,
        expectedProposalVersion: reviewContext!.proposalVersion,
        expectedSubjectRevision: reviewContext!.subjectRevision,
        expectedSubjectVersion: reviewContext!.subjectVersion,
        expectedContentHash: reviewContext!.contentHash,
        expectedActionTargetFingerprint: reviewContext!.actionTargetFingerprint,
        sessionIdHash: "d".repeat(64),
        operationKey: `managed-review:${suffix}`,
        at,
      });
      const approved = await actionRepository.applyApprovalAction({
        proposalId: updateProposalId,
        requirementId: ownerRequirement!.id,
        expectedProposalVersion: planned.proposal.version,
        expectedSubjectRevision: planned.proposal.subjectRevision,
        expectedSubjectVersion: planned.proposal.subjectVersion,
        expectedTargetPolicyVersion: planned.proposal.targetPolicyVersion,
        sourcePresentationId: approvalSend!.presentation.id,
        callbackEventId: `managed-approval-callback-${suffix}`,
        actorOpenId: reviewerOpenId,
        action: "approve",
        requireReviewAttestation: true,
        operationKey: `managed-approval:${suffix}`,
        at,
      });
      expect(approved).toMatchObject({
        proposal: { status: "approved", version: 3, subjectVersion: 3 },
        draftVersion: 3,
      });
      const approvedContext = await actionRepository.getProposal(updateProposalId);
      const exactApproval = approvedContext?.approvals.find((item) =>
        item.requirementId === ownerRequirement!.id);
      expect(exactApproval).toBeDefined();
      await expect(actionRepository.listProposals({
        statuses: ["approved"],
        actionTypes: ["update_knowledge_publication"],
        authorizationGroupIds: ["group"],
        limit: 1,
      })).resolves.toEqual([expect.objectContaining({ id: updateProposalId, version: 3 })]);
      const claimInput = {
        proposalId: updateProposalId,
        expectedProposalVersion: approved.proposal.version,
        runtimeGate: {
          deploymentEnabled: true,
          globalEnabled: true,
          writeKnowledgeBase: true,
          updateManagedKnowledge: true,
          disabledGroupIds: [],
          allowedGroupIds: ["group"],
        },
        operationKey: `managed-claim:${suffix}`,
        workerId: "test-worker",
        at,
      };
      const claims = await Promise.all([
        repository.claimApprovedUpdate(claimInput),
        repository.claimApprovedUpdate(claimInput),
      ]);
      expect(claims.map((claim) => claim.outcome).sort()).toEqual(["already_applied", "applied"]);
      const claimed = claims.find(({ outcome }) => outcome === "applied")!;
      if (claimed.outcome === "terminal") throw new Error("expected winning managed update claim");
      expect(claimed.execution).toMatchObject({
        approvalId: exactApproval!.id,
        executorId: "test-worker",
      });
      const dispatchedAt = new Date(at.getTime() + 1_000);
      const dispatched = await repository.markRemoteRequestDispatched({
        executionId: claimed.execution.id,
        expectedExecutionVersion: claimed.execution.version,
        operationKey: `managed-dispatch:${suffix}`,
        actor: "test-worker",
        at: dispatchedAt,
      });
      const reconciliationInput = {
        executionId: claimed.execution.id,
        expectedExecutionVersion: dispatched.execution.version,
        expectedManagedPageVersion: dispatched.page.version,
        operationKey: `managed-operator-reconcile:${suffix}`,
        operator: "operator@example.com",
        at: new Date(at.getTime() + 1_500),
      };
      const reconciled = await repository.requestReconciliation(reconciliationInput);
      expect(reconciled).toMatchObject({
        outcome: "applied",
        claim: {
          execution: { state: "reconciliation_required", version: dispatched.execution.version + 1 },
          page: { state: "reconciliation_required", version: dispatched.page.version + 1 },
        },
      });
      const reconciliationReplay = await repository.requestReconciliation({
        ...reconciliationInput,
        at: new Date(reconciliationInput.at.getTime() + 1_000),
      });
      expect(reconciliationReplay).toMatchObject({
        outcome: "already_applied",
        claim: { execution: { id: claimed.execution.id, version: reconciled.claim.execution.version } },
      });
      expect(reconciliationReplay.acknowledgement).toEqual(reconciled.acknowledgement);
      await expect(repository.requestReconciliation({
        ...reconciliationInput,
        expectedExecutionVersion: reconciliationInput.expectedExecutionVersion + 1,
      })).rejects.toThrow(/operation conflict/iu);
      const metadata = await repository.getMetadataForProposal(updateProposalId);
      expect(metadata).toMatchObject({
        page: { id: claimed.page.id, safeWikiUrl: expect.stringMatching(/^https:\/\/www\.feishu\.cn\/wiki\//u) },
        executions: [expect.objectContaining({ id: claimed.execution.id, events: expect.arrayContaining([
          expect.objectContaining({ type: "reconciliation_required", toVersion: dispatched.execution.version + 1 }),
        ]) })],
      });
      expect(JSON.stringify(metadata)).not.toMatch(/New approved body|docx_secret|blk_secret|tenant-token/iu);
      const appliedAt = new Date(at.getTime() + 2_000);
      const applied = await repository.recordRemoteOutcome({
        executionId: claimed.execution.id,
        expectedExecutionVersion: reconciled.claim.execution.version,
        classification: "remote_applied",
        pageDisposition: "resync_required",
        responseClassification: "applied",
        responseRevisionId: "13",
        operationKey: `managed-applied:${suffix}`,
        actor: "test-worker",
        at: appliedAt,
      });
      const newSnapshotId = `snapshot-new-${suffix}`;
      const newSnapshotHash = "9".repeat(64);
      const syncedAt = new Date(at.getTime() + 3_000);
      await pool.query(`
        INSERT INTO document_snapshots (
          id,document_source_id,source_uri,fetch_status,body_text,content_hash,fetched_at,created_at
        ) VALUES ($1,$2,$3,'succeeded','New snapshot body',$4,$5,$5)
      `, [newSnapshotId, sourceId, `https://example.test/${sourceId}`, newSnapshotHash, syncedAt]);
      const observation = await repository.recordSnapshotObservation({
        id: `observation-${suffix}`,
        managedPageId: applied.page.id,
        managedPageVersion: applied.page.version,
        documentSnapshotId: newSnapshotId,
        documentSourceId: sourceId,
        snapshotContentHash: newSnapshotHash,
        observedRemoteRevisionId: "13",
        observedManagedBodyBlockId: applied.page.managedBodyBlockId,
        observedBlockType: "text",
        managedBodyContentHash: proposedBodyHash,
        adapterVersion: "configured-pg-test-v1",
        observedAt: syncedAt,
        operationKey: `observation:${suffix}`,
        at: syncedAt,
      });
      await expect(repository.findResyncReadyExecution({
        observationId: observation.observation.id,
        activeEmbeddingProfileId: "static-dev-6d",
      })).resolves.toBeUndefined();

      const wrongProfileId = `wrong-profile-${suffix}`;
      await pool.query(`
        INSERT INTO embedding_profiles (
          id,provider,model,dimensions,display_name,status,created_at
        ) VALUES ($1,'configured-test',$1,6,'Wrong configured test profile','active',$2)
      `, [wrongProfileId, syncedAt]);
      await pool.query(`
        INSERT INTO document_snapshot_reindex_completions (
          id,document_snapshot_id,embedding_profile_id,completion_kind,fragment_count,
          completed_at,created_at
        ) VALUES ($1,$2,$3,'indexed',0,$4,$4)
      `, [`wrong-completion-${suffix}`, newSnapshotId, wrongProfileId, syncedAt]);
      await expect(repository.findResyncReadyExecution({
        observationId: observation.observation.id,
        activeEmbeddingProfileId: "static-dev-6d",
      })).resolves.toBeUndefined();

      await pool.query(`
        INSERT INTO document_snapshot_reindex_completions (
          id,document_snapshot_id,embedding_profile_id,completion_kind,fragment_count,
          completed_at,created_at
        ) VALUES ($1,$2,'static-dev-6d','indexed',0,$3,$3)
      `, [`active-completion-${suffix}`, newSnapshotId, syncedAt]);
      await pool.query(
        "UPDATE document_sources SET permission_state = 'unknown' WHERE id = $1",
        [sourceId],
      );
      await expect(repository.findResyncReadyExecution({
        observationId: observation.observation.id,
        activeEmbeddingProfileId: "static-dev-6d",
      })).resolves.toBeUndefined();
      await pool.query(
        "UPDATE document_sources SET permission_state = 'readable' WHERE id = $1",
        [sourceId],
      );
      const ready = await repository.findResyncReadyExecution({
        observationId: observation.observation.id,
        activeEmbeddingProfileId: "static-dev-6d",
      });
      expect(ready).toEqual({
        executionId: claimed.execution.id,
        executionVersion: applied.execution.version,
        managedPageVersion: applied.page.version,
        observationId: observation.observation.id,
      });
      const completed = await repository.completeResync({
        executionId: ready!.executionId,
        expectedExecutionVersion: ready!.executionVersion,
        expectedManagedPageVersion: ready!.managedPageVersion,
        observationId: ready!.observationId,
        activeEmbeddingProfileId: "static-dev-6d",
        operationKey: `complete-resync:${suffix}`,
        actor: "test-worker",
        at: new Date(at.getTime() + 4_000),
      });
      expect(completed).toMatchObject({
        page: { state: "active", version: applied.page.version + 1 },
        execution: { state: "succeeded", version: applied.execution.version + 1 },
      });
      const immutableUpdate = await pool.query<{
        count: string;
        approval_id: string;
        executor_id: string;
      }>(
        `SELECT count(*) OVER ()::TEXT AS count,approval_id,executor_id
           FROM knowledge_publication_updates WHERE execution_id = $1`,
        [claimed.execution.id],
      );
      expect(immutableUpdate.rows).toEqual([{
        count: "1",
        approval_id: exactApproval!.id,
        executor_id: "test-worker",
      }]);

      const createApprovedRaceProposal = async (label: "a" | "b") => {
        const raceAt = new Date(at.getTime() + (label === "a" ? 5_000 : 6_000));
        const raceDraftId = `race-draft-${label}-${suffix}`;
        const raceCandidateId = `race-candidate-${label}-${suffix}`;
        const raceTargetId = `race-target-${label}-${suffix}`;
        const raceProposalId = `race-proposal-${label}-${suffix}`;
        const raceReviewer = `ou-race-reviewer-${label}-${suffix}`;
        const raceBody = `Competing approved body ${label}`;
        const raceBodyHash = canonicalHash(raceBody);
        await pool.query(`
          INSERT INTO knowledge_conflict_candidates (
            id,idempotency_key,group_id,group_memory_id,memory_updated_at,source_message_id,
            target_document_source_id,target_source_updated_at,target_snapshot_id,target_content_hash,
            detector_contract_version,status,subject,knowledge_base_statement,group_conclusion_statement,
            difference,suggested_update,target_document_ref,confidence,version,created_at,updated_at
          ) VALUES ($1,$2,'group',$3,$4,$5,$6,$4,$7,$8,'v1','pending_review',$9,
            'Prior','Current','Difference','Update','D1','high',1,$10,$10)
        `, [raceCandidateId, `race-candidate-key-${label}-${suffix}`, memoryId, at,
          messageId, sourceId, newSnapshotId, newSnapshotHash, `Race ${label}`, raceAt]);
        const raceDraft = (await draftRepository.createDraft({
          id: raceDraftId,
          operationKey: `race-draft:${label}:${suffix}`,
          originKind: "knowledge_conflict",
          createdBy: "test",
          revision: {
            sourceGroupId: "group",
            title: `Race ${label}`,
            content: raceBody,
            riskLevel: "low",
            reviewer: { type: "feishu_user", ref: raceReviewer },
            suggestedPublication: { spaceId: "space" },
            evidence: [{ type: "document_source", id: sourceId, expectedUpdatedAt: at }],
          },
          at: raceAt,
        })).draft;
        await repository.bindConflictDraft({
          id: raceTargetId,
          draftId: raceDraftId,
          draftRevision: 1,
          draftVersion: raceDraft.version,
          conflictCandidateId: raceCandidateId,
          conflictCandidateVersion: 1,
          managedPageId: completed.page.id,
          managedPageVersion: completed.page.version,
          linkedDocumentSourceId: sourceId,
          targetSnapshotId: newSnapshotId,
          targetSnapshotHash: newSnapshotHash,
          remoteDocumentToken: completed.page.remoteDocumentToken,
          managedBodyBlockId: completed.page.managedBodyBlockId,
          expectedRemoteRevisionId: completed.page.currentRemoteRevisionId!,
          currentBodyContentHash: completed.page.currentBodyContentHash!,
          proposedBodyContentHash: raceBodyHash,
          authorizationGroupId: "group",
          targetPolicyId: policyId,
          targetPolicyVersion: 1,
          operationKey: `race-target:${label}:${suffix}`,
          at: raceAt,
        });
        await pool.query(
          `UPDATE knowledge_conflict_candidates
              SET status = 'draft_created',version = 2,updated_at = $2 WHERE id = $1`,
          [raceCandidateId, raceAt],
        );
        await pool.query(`
          INSERT INTO knowledge_conflict_interactions (
            id,candidate_id,callback_operation_key,actor_ref,action,result,draft_id,created_at
          ) VALUES ($1,$2,$3,'test','create_draft','applied',$4,$5)
        `, [`race-interaction-${label}-${suffix}`, raceCandidateId,
          `race-interaction:${label}:${suffix}`, raceDraftId, raceAt]);

        const raceCardId = `race-card-${label}-${suffix}`;
        const raceCardWorker = `race-card-worker-${label}-${suffix}`;
        await cardRepository.createPresentation({
          id: raceCardId,
          draftId: raceDraftId,
          expectedDraftVersion: 1,
          expectedRevisionNumber: 1,
          chatId: "group",
          contentHash: (label === "a" ? "6" : "7").repeat(64),
          operationKey: `race-card:${label}:${suffix}`,
          at: raceAt,
        });
        const initialCardSend = await cardRepository.claimPresentationSend({
          workerId: raceCardWorker,
          leaseUntil: new Date(raceAt.getTime() + 30_000),
          at: raceAt,
        });
        expect(initialCardSend?.presentation.id).toBe(raceCardId);
        await cardRepository.beginExternalAttempt({
          presentationId: raceCardId,
          workerId: raceCardWorker,
          at: raceAt,
        });
        await cardRepository.completePresentationSend({
          presentationId: raceCardId,
          workerId: raceCardWorker,
          messageId: `om-race-card-${label}-${suffix}`,
          at: raceAt,
        });
        const raceConfirmation = await cardRepository.applyInteraction({
          presentationId: raceCardId,
          draftId: raceDraftId,
          revisionNumber: 1,
          draftVersion: 1,
          chatId: "group",
          eventId: `race-confirm-${label}-${suffix}`,
          actorOpenId: `ou-race-member-${label}-${suffix}`,
          membershipCheckedAt: raceAt,
          at: raceAt,
          action: "confirm",
        });
        const updateCardSend = await cardRepository.claimPresentationSend({
          workerId: raceCardWorker,
          leaseUntil: new Date(raceAt.getTime() + 30_000),
          at: raceAt,
        });
        expect(updateCardSend?.presentation.id).toBe(raceCardId);
        await cardRepository.beginExternalAttempt({
          presentationId: raceCardId,
          workerId: raceCardWorker,
          at: raceAt,
        });
        await cardRepository.completePresentationSend({
          presentationId: raceCardId,
          workerId: raceCardWorker,
          messageId: `om-race-card-${label}-${suffix}`,
          at: raceAt,
        });

        const racePlan = await actionRepository.createProposal({
          proposalId: raceProposalId,
          actionType: "update_knowledge_publication",
          draftId: raceDraftId,
          expectedRevision: 1,
          expectedDraftVersion: raceConfirmation.draft.version,
          targetPolicyId: policyId,
          expectedTargetPolicyVersion: 1,
          operationKey: `race-proposal:${label}:${suffix}`,
          at: raceAt,
        });
        const raceContext = await actionRepository.getProposal(raceProposalId);
        const raceRequirement = raceContext?.requirements.find((item) =>
          item.kind === "designated_owner");
        expect(raceRequirement).toBeDefined();
        const raceApprovalWorker = `race-approval-worker-${label}-${suffix}`;
        const raceApprovalSend = await actionRepository.claimApprovalPresentationSend({
          workerId: raceApprovalWorker,
          leaseUntil: new Date(raceAt.getTime() + 30_000),
          at: raceAt,
        });
        expect(raceApprovalSend?.presentation).toMatchObject({
          proposalId: raceProposalId,
          requirementId: raceRequirement!.id,
        });
        await actionRepository.beginApprovalExternalAttempt({
          presentationId: raceApprovalSend!.presentation.id,
          workerId: raceApprovalWorker,
          at: raceAt,
        });
        await actionRepository.completeApprovalPresentationSend({
          presentationId: raceApprovalSend!.presentation.id,
          workerId: raceApprovalWorker,
          messageId: `om-race-approval-${label}-${suffix}`,
          at: raceAt,
        });
        const raceReview = await actionRepository.getAuthorizedReviewContext({
          proposalId: raceProposalId,
          actorOpenId: raceReviewer,
        });
        expect(raceReview).toBeDefined();
        await actionRepository.recordReviewAttestation({
          proposalId: raceProposalId,
          actorOpenId: raceReviewer,
          expectedProposalVersion: raceReview!.proposalVersion,
          expectedSubjectRevision: raceReview!.subjectRevision,
          expectedSubjectVersion: raceReview!.subjectVersion,
          expectedContentHash: raceReview!.contentHash,
          expectedActionTargetFingerprint: raceReview!.actionTargetFingerprint,
          sessionIdHash: canonicalHash(`race-session-${label}`),
          operationKey: `race-review:${label}:${suffix}`,
          at: raceAt,
        });
        const raceApproval = await actionRepository.applyApprovalAction({
          proposalId: raceProposalId,
          requirementId: raceRequirement!.id,
          expectedProposalVersion: racePlan.proposal.version,
          expectedSubjectRevision: racePlan.proposal.subjectRevision,
          expectedSubjectVersion: racePlan.proposal.subjectVersion,
          expectedTargetPolicyVersion: racePlan.proposal.targetPolicyVersion,
          sourcePresentationId: raceApprovalSend!.presentation.id,
          callbackEventId: `race-approval-${label}-${suffix}`,
          actorOpenId: raceReviewer,
          action: "approve",
          requireReviewAttestation: true,
          operationKey: `race-approve:${label}:${suffix}`,
          at: raceAt,
        });
        return {
          proposalId: raceProposalId,
          expectedProposalVersion: raceApproval.proposal.version,
          runtimeGate: {
            deploymentEnabled: true,
            globalEnabled: true,
            writeKnowledgeBase: true,
            updateManagedKnowledge: true,
            disabledGroupIds: [],
            allowedGroupIds: ["group"],
          },
          operationKey: `race-claim:${label}:${suffix}`,
          workerId: `race-worker-${label}`,
          at: new Date(at.getTime() + 7_000),
        };
      };

      const competingClaims = [
        await createApprovedRaceProposal("a"),
        await createApprovedRaceProposal("b"),
      ];
      await expect(actionRepository.listProposals({
        statuses: ["approved"],
        actionTypes: ["update_knowledge_publication"],
        authorizationGroupIds: ["group"],
        limit: 2,
      })).resolves.toHaveLength(2);
      const race = await Promise.all(competingClaims.map((input) =>
        repository.claimApprovedUpdate(input)));
      expect(race.map((result) => result.outcome).sort()).toEqual(["applied", "terminal"]);
      const loser = race.find((result) => result.outcome === "terminal");
      expect(loser).toMatchObject({ outcome: "terminal", code: "competing_execution" });
      await expect(pool.query(
        `SELECT status FROM action_proposals WHERE id = $1`,
        [loser!.proposalId],
      )).resolves.toMatchObject({ rows: [{ status: "failed" }] });
      await expect(pool.query(
        `SELECT count(*)::INT AS count FROM action_events
          WHERE proposal_id = $1 AND event_type = 'execution_failed'
            AND reason_code = 'competing_execution'`,
        [loser!.proposalId],
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await expect(actionRepository.listProposals({
        statuses: ["approved"],
        actionTypes: ["update_knowledge_publication"],
        authorizationGroupIds: ["group"],
        limit: 1,
      })).resolves.toEqual([]);
      const unresolvedCount = await pool.query<{ count: string }>(
        `SELECT count(*)::TEXT AS count FROM knowledge_publication_update_executions
          WHERE managed_page_id = $1
            AND state IN ('claimed','remote_request_dispatched','outcome_unknown','remote_applied',
              'resync_required','reconciliation_required')`,
        [completed.page.id],
      );
      expect(unresolvedCount.rows[0]?.count).toBe("1");

    } finally {
      await pool?.end();
      await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool?.end();
    }
  });
});

function managedPageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const at = new Date("2026-08-20T00:00:00.000Z");
  return {
    id: "managed-1",
    origin_knowledge_publication_id: "publication-1",
    target_policy_id: "policy-1",
    target_policy_version: "1",
    authorization_group_id: "group-1",
    remote_node_token: "wiki-node-1",
    remote_document_token: "docx-1",
    managed_body_block_id: "blk_body",
    linked_document_source_id: null,
    current_remote_revision_id: "12",
    current_body_content_hash: "a".repeat(64),
    expected_resync_content_hash: null,
    current_reconciled_snapshot_id: null,
    state: "active",
    version: "1",
    created_at: at,
    updated_at: at,
    ...overrides,
  };
}

function managedTargetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const at = new Date("2026-08-20T00:00:00.000Z");
  return {
    id: "target-1", draft_id: "draft-1", draft_revision: "1", draft_version: "1",
    conflict_candidate_id: "candidate-1", conflict_candidate_version: "1", managed_page_id: "page-1",
    managed_page_version: "1", linked_document_source_id: "source-1", target_snapshot_id: "snapshot-1",
    target_snapshot_hash: "c".repeat(64), target_source_version: null, remote_document_token: "docx-1",
    managed_body_block_id: "blk-1", expected_remote_revision_id: "11", current_body_content_hash: "a".repeat(64),
    proposed_body_content_hash: "b".repeat(64), authorization_group_id: "group-1", target_policy_id: "policy-1",
    target_policy_version: "1", operation_key: "target-op", operation_fingerprint: "d".repeat(64), created_at: at,
    ...overrides,
  };
}

function managedExecutionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const at = new Date("2026-08-20T00:00:00.000Z");
  return {
    id: "execution-1", proposal_id: "proposal-1", approval_id: "approval-1", executor_id: "worker-1",
    managed_page_id: "page-1", managed_page_version: "1", update_target_id: "target-1", attempt_number: "1",
    state: "reconciliation_required", operation_key: "execution-op", operation_fingerprint: "e".repeat(64),
    request_fingerprint: "f".repeat(64), expected_remote_revision_id: "11", before_body_content_hash: "a".repeat(64),
    after_body_content_hash: "b".repeat(64), client_token: "client-token", response_revision_id: null,
    response_classification: null, reconciliation_reason_code: "operator_requested", remote_request_dispatched_at: at,
    version: "2", created_at: at, updated_at: at, ...overrides,
  };
}

function managedUpdateClaimInput() {
  return {
    proposalId: "update-proposal-1",
    expectedProposalVersion: 3,
    runtimeGate: {
      deploymentEnabled: true,
      globalEnabled: true,
      writeKnowledgeBase: true,
      updateManagedKnowledge: true,
      disabledGroupIds: [],
      allowedGroupIds: ["group-1"],
    },
    operationKey: "managed-update-claim:test",
    workerId: "managed-update-worker",
    at: new Date("2026-08-21T01:00:00.000Z"),
  };
}

function managedUpdateClaimDataSource({
  hasExactAttestation = true,
  hasCompetingProposal = false,
  executionState: initialExecutionState = "claimed",
  executionVersion: initialExecutionVersion = 1,
  permissionState = "readable",
}: {
  hasExactAttestation?: boolean;
  hasCompetingProposal?: boolean;
  executionState?: string;
  executionVersion?: number;
  permissionState?: string;
} = {}) {
  const at = new Date("2026-08-21T01:00:00.000Z");
  const statements: string[] = [];
  const statementValues: unknown[][] = [];
  const attestationFingerprints: string[] = [];
  const terminalizedProposalIds: string[] = [];
  const executionEvents = new Map<string, Record<string, unknown>>();
  let claimed = false;
  let proposalExecuting = false;
  const page = () => managedPageRow({
    target_policy_version: "3",
    linked_document_source_id: "source-1",
    current_remote_revision_id: "12",
    current_body_content_hash: canonicalHash("Old approved body"),
    current_reconciled_snapshot_id: "snapshot-old",
    state: claimed ? "updating" : "active",
    version: claimed ? "2" : "1",
    updated_at: at,
  });
  const target = {
    id: "target-1",
    draft_id: "update-draft-1",
    draft_revision: "1",
    draft_version: "1",
    conflict_candidate_id: "candidate-1",
    conflict_candidate_version: "5",
    managed_page_id: "managed-1",
    managed_page_version: "1",
    linked_document_source_id: "source-1",
    target_snapshot_id: "snapshot-old",
    target_snapshot_hash: "a".repeat(64),
    target_source_version: "source-version-1",
    remote_document_token: "docx-1",
    managed_body_block_id: "blk_body",
    expected_remote_revision_id: "12",
    current_body_content_hash: canonicalHash("Old approved body"),
    proposed_body_content_hash: canonicalHash("New approved body"),
    authorization_group_id: "group-1",
    target_policy_id: "policy-1",
    target_policy_version: "3",
    operation_key: "target-op",
    operation_fingerprint: "b".repeat(64),
    created_at: at,
  };
  const proposal = () => ({
    id: "update-proposal-1",
    action_type: "update_knowledge_publication",
    subject_type: "knowledge_draft",
    subject_id: "update-draft-1",
    subject_revision: "1",
    subject_version: "4",
    target_policy_id: "policy-1",
    target_policy_version: "3",
    risk_level: "low",
    status: proposalExecuting ? "executing" : "approved",
    operation_key: "proposal-op",
    operation_fingerprint: "c".repeat(64),
    version: proposalExecuting ? "4" : "3",
    created_at: at,
    updated_at: at,
  });
  const execution = {
    id: "e4f1ec52-3d3d-5f72-a7e4-ecde994e3ed5",
    proposal_id: "update-proposal-1",
    approval_id: "approval-1",
    executor_id: "managed-update-worker",
    managed_page_id: "managed-1",
    managed_page_version: "2",
    update_target_id: "target-1",
    attempt_number: "1",
    state: initialExecutionState,
    operation_key: "managed-update-claim:test",
    operation_fingerprint: "d".repeat(64),
    request_fingerprint: "e".repeat(64),
    expected_remote_revision_id: "12",
    before_body_content_hash: canonicalHash("Old approved body"),
    after_body_content_hash: canonicalHash("New approved body"),
    client_token: "8b2dcd5d-37ab-5b63-94d2-7e3eb6d3b271",
    response_revision_id: null,
    response_classification: null,
    reconciliation_reason_code: null,
    remote_request_dispatched_at: null,
    version: String(initialExecutionVersion),
    created_at: at,
    updated_at: at,
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const normalized = sql.replaceAll(/\s+/gu, " ").trim();
    statements.push(normalized);
    statementValues.push(values);
    if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      return { rows: [] };
    }
    if (normalized.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (normalized.includes("FROM knowledge_publication_update_execution_events") && normalized.includes("operation_key = $1")) {
      const event = executionEvents.get(String(values[0]));
      return { rows: event === undefined ? [] : [event] };
    }
    if (normalized.includes("FROM knowledge_publication_update_executions") && normalized.includes("operation_key = $1")) {
      return { rows: [] };
    }
    if (normalized.includes("FROM knowledge_publication_update_targets") && !normalized.includes("FOR UPDATE")) {
      return { rows: [target] };
    }
    if (normalized.includes("FROM managed_knowledge_pages")) return { rows: [page()] };
    if (normalized.includes("FROM knowledge_publication_update_targets")) return { rows: [target] };
    if (normalized.includes("FROM knowledge_conflict_candidates")) {
      return { rows: [{
        version: "6",
        status: "draft_created",
        group_id: "group-1",
        target_document_source_id: "source-1",
        target_snapshot_id: "snapshot-old",
        target_content_hash: "a".repeat(64),
        target_source_version: "source-version-1",
      }] };
    }
    if (normalized.includes("FROM action_proposals proposal") &&
      normalized.includes("proposal.id <> $2")) {
      return { rows: hasCompetingProposal ? [{ id: "competing-proposal-1", version: "7" }] : [] };
    }
    if (normalized.includes("FROM action_proposals")) return { rows: [proposal()] };
    if (normalized.includes("FROM knowledge_drafts")) {
      return { rows: [{
        id: "update-draft-1",
        source_group_id: "group-1",
        status: "pending_review",
        current_revision_number: "1",
        version: "4",
        title: "Managed update",
        content: "New approved body",
        risk_level: "low",
      }] };
    }
    if (normalized.includes("FROM knowledge_publication_target_policies")) {
      return { rows: [{
        id: "policy-1",
        space_id: "space-1",
        parent_node_token: null,
        display_name: "Policy",
        allowed_group_ids: ["group-1"],
        allowed_risk_levels: ["low"],
        enabled: true,
        version: "3",
        created_at: at,
        updated_at: at,
      }] };
    }
    if (normalized.includes("FROM document_sources")) {
      return { rows: [{
        id: "source-1",
        source_type: "authorized_wiki_document",
        permission_state: permissionState,
        sync_state: "synced",
        can_use_for_answering: true,
        can_use_for_knowledge_drafts: true,
      }] };
    }
    if (normalized.includes("FROM document_snapshots")) {
      return { rows: [{
        id: "snapshot-old",
        document_source_id: "source-1",
        content_hash: "a".repeat(64),
        source_version: "source-version-1",
        fetch_status: "succeeded",
      }] };
    }
    if (normalized.includes("FROM action_approval_requirements requirement") &&
      normalized.includes("JOIN action_approvals approval")) {
      return { rows: [{
        approval_id: "approval-1",
        actor_open_id: "reviewer-1",
        callback_event_id: "callback-1",
        subject_revision: "1",
        subject_version: "3",
        presentation_id: "presentation-1",
        proposal_version: "1",
        state: "closed",
        recipient_open_id: "reviewer-1",
        requirement_id: "requirement-1",
        satisfied_actor_open_id: "reviewer-1",
      }] };
    }
    if (normalized.includes("action_target_fingerprint")) {
      const fingerprint = values[6];
      if (typeof fingerprint === "string") attestationFingerprints.push(fingerprint);
      return { rows: [{ present: hasExactAttestation }] };
    }
    if (normalized.includes("FROM knowledge_publication_update_executions") &&
      normalized.includes("managed_page_id = $1") && normalized.includes("state IN")) {
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE managed_knowledge_pages")) {
      claimed = true;
      return { rows: [] };
    }
    if (normalized.startsWith("INSERT INTO knowledge_publication_update_execution_events")) {
      executionEvents.set(String(values[5]), {
        execution_id: values[1], event_type: values[2], from_version: values[3], to_version: values[4],
        operation_fingerprint: values[6], reason_code: values[7], created_at: values[8],
      });
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE action_proposals")) {
      if (values[0] === "competing-proposal-1") terminalizedProposalIds.push("competing-proposal-1");
      proposalExecuting = true;
      return { rows: [] };
    }
    if (normalized.includes("FROM knowledge_publication_update_executions")) {
      return { rows: [execution] };
    }
    return { rows: [] };
  });
  return {
    statements,
    statementValues,
    attestationFingerprints,
    terminalizedProposalIds,
    dataSource: {
      query,
      async connect() { return { query, release() {} }; },
    } as PostgresKnowledgeDraftDataSource,
  };
}

function managedUpdateTargetFingerprint(): string {
  return createHash("sha256").update(JSON.stringify([
    ["action_type", "update_knowledge_publication"],
    ["proposal_id", "update-proposal-1"],
    ["proposal_version", 1],
    ["draft_id", "update-draft-1"],
    ["draft_revision", 1],
    ["proposed_content_hash", canonicalHash("New approved body")],
    ["conflict_candidate_id", "candidate-1"],
    ["candidate_version", 5],
    ["managed_page_id", "managed-1"],
    ["managed_page_version", 1],
    ["document_source_id", "source-1"],
    ["target_snapshot_id", "snapshot-old"],
    ["target_snapshot_hash", "a".repeat(64)],
    ["remote_document_token", "docx-1"],
    ["managed_body_block_id", "blk_body"],
    ["expected_remote_revision", "12"],
    ["current_body_content_hash", canonicalHash("Old approved body")],
    ["target_policy_id", "policy-1"],
    ["target_policy_version", 3],
    ["authorization_group_id", "group-1"],
  ])).digest("hex");
}

function canonicalHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function managedUpdateOutcomeDataSource({
  executionState: initialExecutionState = "remote_request_dispatched",
  executionVersion: initialExecutionVersion = 2,
}: { executionState?: string; executionVersion?: number } = {}) {
  const at = new Date("2026-08-21T01:00:00.000Z");
  let pageState = "updating";
  let pageVersion = 2;
  let executionState = initialExecutionState;
  let executionVersion = initialExecutionVersion;
  let proposalState = "executing";
  let proposalVersion = 3;
  const target = {
    id: "target-1", draft_id: "update-draft-1", draft_revision: "1", draft_version: "4",
    conflict_candidate_id: "candidate-1", conflict_candidate_version: "5",
    managed_page_id: "managed-1", managed_page_version: "1",
    linked_document_source_id: "source-1", target_snapshot_id: "snapshot-old",
    target_snapshot_hash: "a".repeat(64), target_source_version: null,
    remote_document_token: "docx-1", managed_body_block_id: "blk_body",
    expected_remote_revision_id: "12", current_body_content_hash: canonicalHash("Old approved body"),
    proposed_body_content_hash: canonicalHash("New approved body"), authorization_group_id: "group-1",
    target_policy_id: "policy-1", target_policy_version: "3", operation_key: "target-op",
    operation_fingerprint: "b".repeat(64), created_at: at,
  };
  const page = () => managedPageRow({
    target_policy_version: "3", linked_document_source_id: "source-1",
    current_remote_revision_id: "12", current_body_content_hash: canonicalHash("Old approved body"),
    state: pageState, version: String(pageVersion), updated_at: at,
  });
  const execution = () => ({
    id: "execution-1", proposal_id: "update-proposal-1", managed_page_id: "managed-1",
    managed_page_version: "2", update_target_id: "target-1", attempt_number: "1",
    state: executionState, operation_key: "execution-op", operation_fingerprint: "d".repeat(64),
    request_fingerprint: "e".repeat(64), expected_remote_revision_id: "12",
    before_body_content_hash: canonicalHash("Old approved body"),
    after_body_content_hash: canonicalHash("New approved body"),
    client_token: "8b2dcd5d-37ab-5b63-94d2-7e3eb6d3b271", response_revision_id: null,
    response_classification: null, reconciliation_reason_code: null,
    remote_request_dispatched_at: at, version: String(executionVersion), created_at: at, updated_at: at,
  });
  const proposal = () => ({
    id: "update-proposal-1", action_type: "update_knowledge_publication",
    subject_type: "knowledge_draft", subject_id: "update-draft-1", subject_revision: "1",
    subject_version: "4", target_policy_id: "policy-1", target_policy_version: "3",
    risk_level: "low", status: proposalState, operation_key: "proposal-op",
    operation_fingerprint: "c".repeat(64), version: String(proposalVersion), created_at: at, updated_at: at,
  });
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const normalized = sql.replaceAll(/\s+/gu, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized) || normalized.includes("pg_advisory_xact_lock")) {
      return { rows: [] };
    }
    if (normalized.includes("knowledge_publication_update_execution_events") && normalized.includes("operation_key = $1")) return { rows: [] };
    if (normalized.includes("FROM managed_knowledge_pages")) return { rows: [page()] };
    if (normalized.includes("FROM knowledge_publication_update_targets")) return { rows: [target] };
    if (normalized.includes("FROM action_proposals")) return { rows: [proposal()] };
    if (normalized.includes("FROM knowledge_publication_update_executions")) return { rows: [execution()] };
    if (normalized.startsWith("UPDATE knowledge_publication_update_executions")) {
      executionState = normalized.includes("SET state = 'remote_request_dispatched'")
        ? "remote_request_dispatched"
        : String(values[1]);
      executionVersion += 1;
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE managed_knowledge_pages")) {
      pageState = String(values[1]);
      pageVersion += 1;
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE action_proposals")) {
      proposalState = String(values[1]);
      proposalVersion += 1;
      return { rows: [] };
    }
    return { rows: [] };
  });
  return {
    dataSource: {
      query,
      async connect() { return { query, release() {} }; },
    } as PostgresKnowledgeDraftDataSource,
  };
}

function managedResyncDataSource({
  permissionUsable = true,
  initialProposalState = "executing",
}: { permissionUsable?: boolean; initialProposalState?: string } = {}) {
  const at = new Date("2026-08-21T03:00:00.000Z");
  const statements: string[] = [];
  let pageState = "resync_required";
  let pageVersion = 3;
  let pageRevision = "12";
  let pageHash = canonicalHash("Old approved body");
  let executionState = "remote_applied";
  let executionVersion = 3;
  let proposalState = initialProposalState;
  let proposalVersion = 3;
  const immutableExecutorIds: string[] = [];
  const immutableApprovalIds: string[] = [];
  const successEventActors: string[] = [];
  const target = {
    id: "target-1", draft_id: "update-draft-1", draft_revision: "1", draft_version: "1",
    conflict_candidate_id: "candidate-1", conflict_candidate_version: "5",
    managed_page_id: "managed-1", managed_page_version: "1",
    linked_document_source_id: "source-1", target_snapshot_id: "snapshot-old",
    target_snapshot_hash: "a".repeat(64), target_source_version: "source-version-1",
    remote_document_token: "docx-1", managed_body_block_id: "blk_body",
    expected_remote_revision_id: "12", current_body_content_hash: canonicalHash("Old approved body"),
    proposed_body_content_hash: canonicalHash("New approved body"), authorization_group_id: "group-1",
    target_policy_id: "policy-1", target_policy_version: "3", operation_key: "target-op",
    operation_fingerprint: "b".repeat(64), created_at: at,
  };
  const page = () => managedPageRow({
    target_policy_version: "3", linked_document_source_id: "source-1",
    current_remote_revision_id: pageRevision, current_body_content_hash: pageHash,
    expected_resync_content_hash: pageState === "resync_required" ? canonicalHash("New approved body") : null,
    state: pageState, version: String(pageVersion), updated_at: at,
  });
  const execution = () => ({
    id: "execution-1", proposal_id: "update-proposal-1", approval_id: "approval-1",
    executor_id: "managed-update-worker", managed_page_id: "managed-1",
    managed_page_version: "2", update_target_id: "target-1", attempt_number: "1",
    state: executionState, operation_key: "execution-op", operation_fingerprint: "d".repeat(64),
    request_fingerprint: "e".repeat(64), expected_remote_revision_id: "12",
    before_body_content_hash: canonicalHash("Old approved body"),
    after_body_content_hash: canonicalHash("New approved body"),
    client_token: "8b2dcd5d-37ab-5b63-94d2-7e3eb6d3b271", response_revision_id: "13",
    response_classification: "applied", reconciliation_reason_code: null,
    remote_request_dispatched_at: new Date("2026-08-21T02:59:00.000Z"),
    version: String(executionVersion), created_at: at, updated_at: at,
  });
  const proposal = () => ({
    id: "update-proposal-1", status: proposalState, subject_revision: "1",
    subject_version: "4", version: String(proposalVersion),
  });
  const observation = {
    id: "observation-new", managed_page_id: "managed-1", managed_page_version: "2",
    document_snapshot_id: "snapshot-new", document_source_id: "source-1",
    snapshot_content_hash: "9".repeat(64), observed_remote_revision_id: "13",
    observed_managed_body_block_id: "blk_body", observed_block_type: "text",
    managed_body_content_hash: canonicalHash("New approved body"),
    adapter_version: "feishu-docx-managed-block-v1", operation_key: "observation-op",
    operation_fingerprint: "f".repeat(64), observed_at: at,
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const normalized = sql.replaceAll(/\s+/gu, " ").trim();
    statements.push(normalized);
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized) || normalized.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (normalized.includes("AS execution_id") && normalized.includes("managed_knowledge_snapshot_observations")) {
      return { rows: permissionUsable ? [{
        execution_id: "execution-1", execution_version: "3",
        managed_page_version: "3", observation_id: "observation-new",
      }] : [] };
    }
    if (normalized.includes("knowledge_publication_update_execution_events") && normalized.includes("operation_key = $1")) return { rows: [] };
    if (normalized.includes("FROM managed_knowledge_pages")) return { rows: [page()] };
    if (normalized.includes("FROM knowledge_publication_update_targets")) return { rows: [target] };
    if (normalized.includes("FROM action_proposals")) return { rows: [proposal()] };
    if (normalized.includes("AS ready") && normalized.includes("document_snapshots")) {
      return { rows: [{
        ready: permissionUsable,
        approval_subject_revision: "1",
        approval_subject_version: "3",
      }] };
    }
    if (normalized.includes("FROM knowledge_publication_update_executions")) return { rows: [execution()] };
    if (normalized.includes("FROM managed_knowledge_snapshot_observations")) return { rows: [observation] };
    if (normalized.startsWith("UPDATE knowledge_publication_update_executions")) {
      executionState = "succeeded";
      executionVersion += 1;
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE managed_knowledge_pages")) {
      pageState = "active";
      pageRevision = String(values[1]);
      pageHash = String(values[2]);
      pageVersion += 1;
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE action_proposals")) {
      proposalState = "succeeded";
      proposalVersion += 1;
      return { rows: [] };
    }
    if (normalized.includes("INSERT INTO knowledge_publication_updates")) {
      immutableApprovalIds.push(String(values[3]));
      immutableExecutorIds.push(String(values[14]));
      return { rows: [] };
    }
    if (normalized.includes("INSERT INTO action_events") && normalized.includes("execution_succeeded")) {
      successEventActors.push(String(values[2]));
      return { rows: [] };
    }
    return { rows: [] };
  });
  return {
    statements,
    proposalState: () => proposalState,
    immutableExecutorIds: () => immutableExecutorIds,
    immutableApprovalIds: () => immutableApprovalIds,
    successEventActors: () => successEventActors,
    dataSource: {
      query,
      async connect() { return { query, release() {} }; },
    } as PostgresKnowledgeDraftDataSource,
  };
}
