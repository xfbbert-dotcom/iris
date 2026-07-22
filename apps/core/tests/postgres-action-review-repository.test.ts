import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ActionProposalOperationConflictError,
  createPostgresActionProposalRepository,
} from "../src/action-approvals/postgres-action-proposal-repository.js";
import { createPostgresKnowledgeDraftRepository } from "../src/knowledge-governance/postgres-knowledge-draft-repository.js";
import type { PostgresKnowledgeDraftDataSource } from "../src/knowledge-governance/postgres-knowledge-draft-repository.js";
import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID();
const schema = `action_review_${suffix.replaceAll("-", "")}`;
const at = new Date("2026-07-22T12:00:00.000Z");
const migrationUrl = new URL("../migrations/0034_action_review_attestations.sql", import.meta.url);
const migration = existsSync(migrationUrl) ? readFileSync(migrationUrl, "utf8") : "";

describe("action review attestation migration contract", () => {
  it("defines append-only review attestation facts", () => {
    expect(migration).toContain("CREATE TABLE action_review_attestations");
    expect(migration).toContain("action_review_attestations_append_only");
    expect(migration).toContain("UNIQUE (proposal_id, proposal_version, actor_open_id, content_hash)");
  });
});

runIfDatabase("PostgresActionReviewRepository with Postgres", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    pool = new pg.Pool({ connectionString: isolatedUrl.toString() });
    await runMigrations({
      client: pool as unknown as MigrationClient,
      migrationsDir: defaultMigrationsDir(),
    });
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  it("returns the full current review context only to the designated owner", async () => {
    const acceptance = await createReviewCase("context", "medium", `ou_owner_${suffix}`);

    await expect(acceptance.repository.getAuthorizedReviewContext({
      proposalId: acceptance.proposal.id,
      actorOpenId: acceptance.actorOpenId,
    })).resolves.toMatchObject({
      proposalId: acceptance.proposal.id,
      proposalVersion: 1,
      subjectRevision: 1,
      subjectVersion: 1,
      title: "Pilot SOP",
      content: "full body",
      contentHash: sha256("full body"),
      riskLevel: "medium",
      targetDisplayName: acceptance.policy.displayName,
      requirements: [{ kind: "designated_owner", state: "pending" }],
    });
  });

  it("returns undefined without disclosing why a review context is unavailable", async () => {
    const wrongActor = await createReviewCase("wrong-actor", "medium", `ou_owner_${suffix}`);
    await expect(wrongActor.repository.getAuthorizedReviewContext({
      proposalId: wrongActor.proposal.id,
      actorOpenId: `ou_wrong_${suffix}`,
    })).resolves.toBeUndefined();

    const disabledGrant = await createReviewCase("disabled-grant", "high", `ou_high_${suffix}`);
    await disabledGrant.repository.upsertRoleGrant({
      roleType: "authorized_high_risk_owner",
      actorOpenId: disabledGrant.actorOpenId,
      enabled: true,
      expectedVersion: 0,
      operationKey: `grant:${disabledGrant.label}:enable:${suffix}`,
      operator: "test",
      at,
    });
    await expect(disabledGrant.repository.getAuthorizedReviewContext({
      proposalId: disabledGrant.proposal.id,
      actorOpenId: disabledGrant.actorOpenId,
    })).resolves.toBeDefined();
    await disabledGrant.repository.upsertRoleGrant({
      roleType: "authorized_high_risk_owner",
      actorOpenId: disabledGrant.actorOpenId,
      enabled: false,
      expectedVersion: 1,
      operationKey: `grant:${disabledGrant.label}:disable:${suffix}`,
      operator: "test",
      at,
    });
    await expect(disabledGrant.repository.getAuthorizedReviewContext({
      proposalId: disabledGrant.proposal.id,
      actorOpenId: disabledGrant.actorOpenId,
    })).resolves.toBeUndefined();

    const staleProposal = await createReviewCase("stale-proposal", "medium", `ou_proposal_${suffix}`);
    await pool.query("UPDATE action_proposals SET subject_version = subject_version + 1 WHERE id = $1", [
      staleProposal.proposal.id,
    ]);
    await expect(staleProposal.repository.getAuthorizedReviewContext({
      proposalId: staleProposal.proposal.id,
      actorOpenId: staleProposal.actorOpenId,
    })).resolves.toBeUndefined();

    const staleDraft = await createReviewCase("stale-draft", "medium", `ou_stale_${suffix}`);
    await pool.query("UPDATE knowledge_drafts SET version = version + 1 WHERE id = $1", [
      staleDraft.draft.id,
    ]);
    await expect(staleDraft.repository.getAuthorizedReviewContext({
      proposalId: staleDraft.proposal.id,
      actorOpenId: staleDraft.actorOpenId,
    })).resolves.toBeUndefined();

    const disabledPolicy = await createReviewCase("disabled-policy", "medium", `ou_policy_${suffix}`);
    await disabledPolicy.repository.upsertTargetPolicy({
      id: disabledPolicy.policy.id,
      spaceId: disabledPolicy.policy.spaceId,
      displayName: disabledPolicy.policy.displayName,
      allowedGroupIds: [],
      allowedRiskLevels: ["medium"],
      enabled: false,
      expectedVersion: 1,
      operationKey: `policy:${disabledPolicy.label}:disable:${suffix}`,
      operator: "test",
      at,
    });
    await expect(disabledPolicy.repository.getAuthorizedReviewContext({
      proposalId: disabledPolicy.proposal.id,
      actorOpenId: disabledPolicy.actorOpenId,
    })).resolves.toBeUndefined();

    const invalidEvidence = await createReviewCase("invalid-evidence", "medium", `ou_evidence_${suffix}`);
    await pool.query("UPDATE document_sources SET permission_state = 'denied' WHERE id = $1", [
      invalidEvidence.documentSourceId,
    ]);
    await expect(invalidEvidence.repository.getAuthorizedReviewContext({
      proposalId: invalidEvidence.proposal.id,
      actorOpenId: invalidEvidence.actorOpenId,
    })).resolves.toBeUndefined();

    await expect(invalidEvidence.repository.getAuthorizedReviewContext({
      proposalId: `missing-${suffix}`,
      actorOpenId: invalidEvidence.actorOpenId,
    })).resolves.toBeUndefined();
  });

  it("records one exact attestation and recognizes only an exact operation replay", async () => {
    const acceptance = await createReviewCase("attest", "medium", `ou_attest_${suffix}`);
    const context = await acceptance.repository.getAuthorizedReviewContext({
      proposalId: acceptance.proposal.id,
      actorOpenId: acceptance.actorOpenId,
    });
    expect(context).toBeDefined();
    const input = {
      proposalId: acceptance.proposal.id,
      actorOpenId: acceptance.actorOpenId,
      expectedProposalVersion: context!.proposalVersion,
      expectedSubjectRevision: context!.subjectRevision,
      expectedSubjectVersion: context!.subjectVersion,
      expectedContentHash: context!.contentHash,
      sessionIdHash: sha256("session"),
      operationKey: `review-attestation:${suffix}`,
      at,
    };

    await expect(acceptance.repository.recordReviewAttestation(input)).resolves.toEqual({
      outcome: "applied",
    });
    await expect(acceptance.repository.recordReviewAttestation(input)).resolves.toEqual({
      outcome: "already_applied",
    });
    await expect(acceptance.repository.hasCurrentReviewAttestation({
      proposalId: input.proposalId,
      actorOpenId: input.actorOpenId,
      expectedProposalVersion: input.expectedProposalVersion,
      expectedSubjectRevision: input.expectedSubjectRevision,
      expectedSubjectVersion: input.expectedSubjectVersion,
      expectedContentHash: input.expectedContentHash,
    })).resolves.toBe(true);
    await expect(acceptance.repository.recordReviewAttestation({
      ...input,
      sessionIdHash: sha256("different-session"),
    })).rejects.toBeInstanceOf(ActionProposalOperationConflictError);
  });

  async function createReviewCase(
    label: string,
    riskLevel: "medium" | "high",
    actorOpenId: string,
  ) {
    const documentSourceId = `review-source-${label}-${suffix}`;
    await pool.query(
      `INSERT INTO document_sources (
        id, source_type, source_uri, title, origin_group_id, origin_message_id,
        permission_state, sync_state, can_use_for_answering,
        can_use_for_knowledge_drafts, created_at, updated_at
      ) VALUES ($1, 'authorized_wiki_document', $2, 'Review source', NULL, NULL,
        'readable', 'synced', TRUE, TRUE, $3, $3)`,
      [documentSourceId, `https://example.com/${documentSourceId}`, at],
    );
    const draftRepository = createPostgresKnowledgeDraftRepository({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
    });
    const draft = (await draftRepository.createDraft({
      id: `review-draft-${label}-${suffix}`,
      operationKey: `review-draft:${label}:${suffix}`,
      originKind: "user_requested",
      createdBy: "test",
      revision: {
        title: "Pilot SOP",
        content: "full body",
        riskLevel,
        reviewer: { type: "feishu_user", ref: actorOpenId },
        suggestedPublication: { spaceId: `review-space-${label}-${suffix}` },
        evidence: [{ type: "document_source", id: documentSourceId, expectedUpdatedAt: at }],
      },
      at,
    })).draft;
    const repository = createPostgresActionProposalRepository({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
    });
    const policy = (await repository.upsertTargetPolicy({
      id: `review-policy-${label}-${suffix}`,
      spaceId: `review-space-${label}-${suffix}`,
      displayName: `Review policy ${label}`,
      allowedGroupIds: [],
      allowedRiskLevels: [riskLevel],
      enabled: true,
      expectedVersion: 0,
      operationKey: `review-policy:${label}:${suffix}`,
      operator: "test",
      at,
    })).policy;
    const proposal = (await repository.createProposal({
      proposalId: `review-proposal-${label}-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: 1,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `review-proposal:${label}:${suffix}`,
      at,
    })).proposal;
    return { label, actorOpenId, documentSourceId, draft, policy, proposal, repository };
  }
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
