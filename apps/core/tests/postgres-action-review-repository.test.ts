import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ActionProposalOperationConflictError,
  ActionProposalReviewRequiredError,
  ActionProposalVersionConflictError,
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

  it("reports the applied action-review migration from schema history", async () => {
    const repository = createPostgresActionProposalRepository({ dataSource: pool });
    await expect(repository.hasActionReviewMigration?.()).resolves.toBe(true);
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
    await pool.query(
      `UPDATE document_sources
       SET permission_state = 'denied',
           can_use_for_answering = FALSE,
           can_use_for_knowledge_drafts = FALSE
       WHERE id = $1`,
      [invalidEvidence.documentSourceId],
    );
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

  it("requires an exact current review attestation before approving", async () => {
    const acceptance = await createReviewApprovalCase("approval-gate", `ou_approval_${suffix}`);
    const input = approvalInput(acceptance);

    await expect(acceptance.repository.preflightApprovalAction({
      ...input,
      requireReviewAttestation: true,
    })).rejects.toBeInstanceOf(ActionProposalReviewRequiredError);
    await expect(acceptance.repository.applyApprovalAction({
      ...input,
      action: "approve",
      requireReviewAttestation: true,
      callbackEventId: `approval-gate-missing-${suffix}`,
      operationKey: `approval-gate-missing-${suffix}`,
      at,
    })).rejects.toBeInstanceOf(ActionProposalReviewRequiredError);

    const context = await requireReviewContext(acceptance);
    await acceptance.repository.recordReviewAttestation(reviewAttestationInput(
      acceptance,
      context,
      "approval-gate",
    ));

    await expect(acceptance.repository.applyApprovalAction({
      ...input,
      action: "approve",
      requireReviewAttestation: true,
      callbackEventId: `approval-gate-approved-${suffix}`,
      operationKey: `approval-gate-approved-${suffix}`,
      at,
    })).resolves.toMatchObject({ outcome: "applied", action: "approve" });
  });

  it("enforces append-only attestation history and both database uniqueness constraints", async () => {
    const acceptance = await createReviewCase("append-only", "medium", `ou_append_${suffix}`);
    const context = await acceptance.repository.getAuthorizedReviewContext({
      proposalId: acceptance.proposal.id,
      actorOpenId: acceptance.actorOpenId,
    });
    expect(context).toBeDefined();
    const input = reviewAttestationInput(acceptance, context!, "append-only");
    await acceptance.repository.recordReviewAttestation(input);

    await expect(pool.query(
      "UPDATE action_review_attestations SET reviewed_at = reviewed_at + INTERVAL '1 second' WHERE operation_key = $1",
      [input.operationKey],
    )).rejects.toThrow(/append-only/iu);
    await expect(pool.query(
      "DELETE FROM action_review_attestations WHERE operation_key = $1",
      [input.operationKey],
    )).rejects.toThrow(/append-only/iu);
    await expect(pool.query("TRUNCATE action_review_attestations")).rejects.toThrow(/append-only/iu);

    await expect(pool.query(
      `INSERT INTO action_review_attestations (
        id, proposal_id, actor_open_id, subject_revision, subject_version, proposal_version,
        content_hash, session_id_hash, operation_key, operation_fingerprint, reviewed_at
      )
      SELECT $1, proposal_id, actor_open_id, subject_revision, subject_version, proposal_version,
             content_hash, session_id_hash, $2, operation_fingerprint, reviewed_at
      FROM action_review_attestations WHERE operation_key = $3`,
      [randomUUID(), `review-attestation:duplicate-identity:${suffix}`, input.operationKey],
    )).rejects.toMatchObject({ code: "23505" });
    await expect(pool.query(
      `INSERT INTO action_review_attestations (
        id, proposal_id, actor_open_id, subject_revision, subject_version, proposal_version,
        content_hash, session_id_hash, operation_key, operation_fingerprint, reviewed_at
      )
      SELECT $1, proposal_id, $2, subject_revision, subject_version, proposal_version,
             content_hash, session_id_hash, operation_key, operation_fingerprint, reviewed_at
      FROM action_review_attestations WHERE operation_key = $3`,
      [randomUUID(), `ou_other_${suffix}`, input.operationKey],
    )).rejects.toMatchObject({ code: "23505" });

    await expect(acceptance.repository.recordReviewAttestation({
      ...input,
      operationKey: `review-attestation:different-operation:${suffix}`,
    })).rejects.toBeInstanceOf(ActionProposalOperationConflictError);
  });

  it("rejects every stale expected review field on the write side", async () => {
    const acceptance = await createReviewCase("write-mismatch", "medium", `ou_mismatch_${suffix}`);
    const context = await acceptance.repository.getAuthorizedReviewContext({
      proposalId: acceptance.proposal.id,
      actorOpenId: acceptance.actorOpenId,
    });
    expect(context).toBeDefined();
    const input = reviewAttestationInput(acceptance, context!, "write-mismatch");
    const mismatches = [
      { expectedProposalVersion: input.expectedProposalVersion + 1 },
      { expectedSubjectRevision: input.expectedSubjectRevision + 1 },
      { expectedSubjectVersion: input.expectedSubjectVersion + 1 },
      { expectedContentHash: sha256("mismatched content") },
    ];

    for (const [index, mismatch] of mismatches.entries()) {
      await expect(acceptance.repository.recordReviewAttestation({
        ...input,
        ...mismatch,
        operationKey: `${input.operationKey}:${index}`,
      })).rejects.toBeInstanceOf(ActionProposalVersionConflictError);
    }
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM action_review_attestations WHERE proposal_id = $1",
      [acceptance.proposal.id],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("rechecks authorization, policy, evidence, and proposal/draft versions before writing", async () => {
    const revoked = await createReviewCase("write-revoked", "high", `ou_write_revoked_${suffix}`);
    await revoked.repository.upsertRoleGrant({
      roleType: "authorized_high_risk_owner",
      actorOpenId: revoked.actorOpenId,
      enabled: true,
      expectedVersion: 0,
      operationKey: `grant:${revoked.label}:enable:${suffix}`,
      operator: "test",
      at,
    });
    const revokedContext = await requireReviewContext(revoked);
    await revoked.repository.upsertRoleGrant({
      roleType: "authorized_high_risk_owner",
      actorOpenId: revoked.actorOpenId,
      enabled: false,
      expectedVersion: 1,
      operationKey: `grant:${revoked.label}:disable:${suffix}`,
      operator: "test",
      at,
    });
    await expect(revoked.repository.recordReviewAttestation(
      reviewAttestationInput(revoked, revokedContext, "write-revoked"),
    )).rejects.toBeInstanceOf(ActionProposalVersionConflictError);

    const disabledPolicy = await createReviewCase(
      "write-disabled-policy",
      "medium",
      `ou_write_policy_${suffix}`,
    );
    const disabledPolicyContext = await requireReviewContext(disabledPolicy);
    await disablePolicy(disabledPolicy);
    await expect(disabledPolicy.repository.recordReviewAttestation(
      reviewAttestationInput(disabledPolicy, disabledPolicyContext, "write-disabled-policy"),
    )).rejects.toBeInstanceOf(ActionProposalVersionConflictError);

    const invalidEvidence = await createReviewCase(
      "write-invalid-evidence",
      "medium",
      `ou_write_evidence_${suffix}`,
    );
    const invalidEvidenceContext = await requireReviewContext(invalidEvidence);
    await denyDocumentSource(invalidEvidence.documentSourceId);
    await expect(invalidEvidence.repository.recordReviewAttestation(
      reviewAttestationInput(invalidEvidence, invalidEvidenceContext, "write-invalid-evidence"),
    )).rejects.toBeInstanceOf(ActionProposalVersionConflictError);

    const staleProposal = await createReviewCase(
      "write-stale-proposal",
      "medium",
      `ou_write_proposal_${suffix}`,
    );
    const staleProposalContext = await requireReviewContext(staleProposal);
    await pool.query("UPDATE action_proposals SET subject_version = subject_version + 1 WHERE id = $1", [
      staleProposal.proposal.id,
    ]);
    await expect(staleProposal.repository.recordReviewAttestation(
      reviewAttestationInput(staleProposal, staleProposalContext, "write-stale-proposal"),
    )).rejects.toBeInstanceOf(ActionProposalVersionConflictError);

    const staleDraft = await createReviewCase(
      "write-stale-draft",
      "medium",
      `ou_write_draft_${suffix}`,
    );
    const staleDraftContext = await requireReviewContext(staleDraft);
    await pool.query("UPDATE knowledge_drafts SET version = version + 1 WHERE id = $1", [
      staleDraft.draft.id,
    ]);
    await expect(staleDraft.repository.recordReviewAttestation(
      reviewAttestationInput(staleDraft, staleDraftContext, "write-stale-draft"),
    )).rejects.toBeInstanceOf(ActionProposalVersionConflictError);
  });

  it("returns false for every attestation identity mismatch", async () => {
    const acceptance = await createReviewCase("current-mismatch", "medium", `ou_current_${suffix}`);
    const context = await requireReviewContext(acceptance);
    const input = reviewAttestationInput(acceptance, context, "current-mismatch");
    await acceptance.repository.recordReviewAttestation(input);
    const currentInput = currentAttestationInput(input);
    const mismatches = [
      { actorOpenId: `ou_other_${suffix}` },
      { expectedProposalVersion: input.expectedProposalVersion + 1 },
      { expectedSubjectRevision: input.expectedSubjectRevision + 1 },
      { expectedSubjectVersion: input.expectedSubjectVersion + 1 },
      { expectedContentHash: sha256("other content") },
    ];

    for (const mismatch of mismatches) {
      await expect(acceptance.repository.hasCurrentReviewAttestation({
        ...currentInput,
        ...mismatch,
      })).resolves.toBe(false);
    }
  });

  it("invalidates a recorded attestation when current authorization or evidence changes", async () => {
    const revoked = await createReviewCase("current-revoked", "high", `ou_current_admin_${suffix}`);
    await revoked.repository.upsertRoleGrant({
      roleType: "authorized_high_risk_owner",
      actorOpenId: revoked.actorOpenId,
      enabled: true,
      expectedVersion: 0,
      operationKey: `grant:${revoked.label}:enable:${suffix}`,
      operator: "test",
      at,
    });
    const revokedContext = await requireReviewContext(revoked);
    const revokedInput = reviewAttestationInput(revoked, revokedContext, "current-revoked");
    await revoked.repository.recordReviewAttestation(revokedInput);
    await revoked.repository.upsertRoleGrant({
      roleType: "authorized_high_risk_owner",
      actorOpenId: revoked.actorOpenId,
      enabled: false,
      expectedVersion: 1,
      operationKey: `grant:${revoked.label}:disable:${suffix}`,
      operator: "test",
      at,
    });
    await expect(revoked.repository.hasCurrentReviewAttestation(
      currentAttestationInput(revokedInput),
    )).resolves.toBe(false);

    const invalidEvidence = await createReviewCase(
      "current-invalid-evidence",
      "medium",
      `ou_current_evidence_${suffix}`,
    );
    const invalidEvidenceContext = await requireReviewContext(invalidEvidence);
    const invalidEvidenceInput = reviewAttestationInput(
      invalidEvidence,
      invalidEvidenceContext,
      "current-invalid-evidence",
    );
    await invalidEvidence.repository.recordReviewAttestation(invalidEvidenceInput);
    await denyDocumentSource(invalidEvidence.documentSourceId);
    await expect(invalidEvidence.repository.hasCurrentReviewAttestation(
      currentAttestationInput(invalidEvidenceInput),
    )).resolves.toBe(false);
  });

  it("authorizes a current iris_admin for high risk and fails closed after revocation", async () => {
    const ownerOpenId = `ou_admin_case_owner_${suffix}`;
    const adminOpenId = `ou_iris_admin_${suffix}`;
    const acceptance = await createReviewCase("iris-admin", "high", ownerOpenId);
    await acceptance.repository.upsertRoleGrant({
      roleType: "iris_admin",
      actorOpenId: adminOpenId,
      enabled: true,
      expectedVersion: 0,
      operationKey: `grant:iris-admin:enable:${suffix}`,
      operator: "test",
      at,
    });

    const context = await acceptance.repository.getAuthorizedReviewContext({
      proposalId: acceptance.proposal.id,
      actorOpenId: adminOpenId,
    });
    expect(context).toMatchObject({
      proposalId: acceptance.proposal.id,
      riskLevel: "high",
      requirements: [{ kind: "iris_admin_or_authorized_owner", state: "pending" }],
    });
    const input = {
      ...reviewAttestationInput(acceptance, context!, "iris-admin"),
      actorOpenId: adminOpenId,
    };
    await expect(acceptance.repository.recordReviewAttestation(input)).resolves.toEqual({
      outcome: "applied",
    });
    await expect(acceptance.repository.hasCurrentReviewAttestation(
      currentAttestationInput(input),
    )).resolves.toBe(true);

    await acceptance.repository.upsertRoleGrant({
      roleType: "iris_admin",
      actorOpenId: adminOpenId,
      enabled: false,
      expectedVersion: 1,
      operationKey: `grant:iris-admin:disable:${suffix}`,
      operator: "test",
      at,
    });
    await expect(acceptance.repository.getAuthorizedReviewContext({
      proposalId: acceptance.proposal.id,
      actorOpenId: adminOpenId,
    })).resolves.toBeUndefined();
    await expect(acceptance.repository.hasCurrentReviewAttestation(
      currentAttestationInput(input),
    )).resolves.toBe(false);
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

  async function createReviewApprovalCase(label: string, actorOpenId: string) {
    const acceptance = await createReviewCase(label, "medium", actorOpenId);
    const proposalContext = await acceptance.repository.getProposal(acceptance.proposal.id);
    expect(proposalContext).toBeDefined();
    const requirement = proposalContext!.requirements[0]!;
    const presentationId = `review-presentation-${label}-${suffix}`;
    await pool.query(
      `INSERT INTO action_approval_presentations (
        id, proposal_id, requirement_id, proposal_version, recipient_open_id,
        state, message_id, operation_key, operation_fingerprint,
        version, created_at, activated_at
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, 1, $9, $9)`,
      [
        presentationId,
        acceptance.proposal.id,
        requirement.id,
        acceptance.proposal.version,
        actorOpenId,
        `om-review-${label}-${suffix}`,
        `review-presentation:${label}:${suffix}`,
        sha256(`review-presentation:${label}:${suffix}`),
        at,
      ],
    );
    return { ...acceptance, requirementId: requirement.id, presentationId };
  }

  function approvalInput(
    acceptance: Awaited<ReturnType<typeof createReviewApprovalCase>>,
  ) {
    return {
      proposalId: acceptance.proposal.id,
      requirementId: acceptance.requirementId,
      expectedProposalVersion: acceptance.proposal.version,
      expectedSubjectRevision: acceptance.proposal.subjectRevision,
      expectedSubjectVersion: acceptance.proposal.subjectVersion,
      expectedTargetPolicyVersion: acceptance.policy.version,
      sourcePresentationId: acceptance.presentationId,
      actorOpenId: acceptance.actorOpenId,
      action: "approve" as const,
    };
  }

  function reviewAttestationInput(
    acceptance: Awaited<ReturnType<typeof createReviewCase>>,
    context: NonNullable<Awaited<ReturnType<typeof acceptance.repository.getAuthorizedReviewContext>>>,
    label: string,
  ) {
    return {
      proposalId: acceptance.proposal.id,
      actorOpenId: acceptance.actorOpenId,
      expectedProposalVersion: context.proposalVersion,
      expectedSubjectRevision: context.subjectRevision,
      expectedSubjectVersion: context.subjectVersion,
      expectedContentHash: context.contentHash,
      sessionIdHash: sha256(`session-${label}`),
      operationKey: `review-attestation:${label}:${suffix}`,
      at,
    };
  }

  async function requireReviewContext(
    acceptance: Awaited<ReturnType<typeof createReviewCase>>,
  ) {
    const context = await acceptance.repository.getAuthorizedReviewContext({
      proposalId: acceptance.proposal.id,
      actorOpenId: acceptance.actorOpenId,
    });
    expect(context).toBeDefined();
    return context!;
  }

  function currentAttestationInput(input: ReturnType<typeof reviewAttestationInput>) {
    return {
      proposalId: input.proposalId,
      actorOpenId: input.actorOpenId,
      expectedProposalVersion: input.expectedProposalVersion,
      expectedSubjectRevision: input.expectedSubjectRevision,
      expectedSubjectVersion: input.expectedSubjectVersion,
      expectedContentHash: input.expectedContentHash,
    };
  }

  async function disablePolicy(
    acceptance: Awaited<ReturnType<typeof createReviewCase>>,
  ): Promise<void> {
    await acceptance.repository.upsertTargetPolicy({
      id: acceptance.policy.id,
      spaceId: acceptance.policy.spaceId,
      displayName: acceptance.policy.displayName,
      allowedGroupIds: [],
      allowedRiskLevels: [acceptance.proposal.riskLevel],
      enabled: false,
      expectedVersion: acceptance.policy.version,
      operationKey: `policy:${acceptance.label}:disable:${suffix}`,
      operator: "test",
      at,
    });
  }

  async function denyDocumentSource(documentSourceId: string): Promise<void> {
    await pool.query(
      `UPDATE document_sources
       SET permission_state = 'denied',
           can_use_for_answering = FALSE,
           can_use_for_knowledge_drafts = FALSE
       WHERE id = $1`,
      [documentSourceId],
    );
  }
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
