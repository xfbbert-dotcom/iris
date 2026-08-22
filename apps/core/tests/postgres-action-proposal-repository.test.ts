import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  ActionProposalRepository,
  ActionProposalStatusCounts,
} from "../src/action-approvals/action-proposal-repository.js";
import {
  ActionProposalIneligibleError,
  ActionProposalAuthorizationError,
  ActionProposalOperationConflictError,
  ActionProposalVersionConflictError,
  createPostgresActionProposalRepository,
} from "../src/action-approvals/postgres-action-proposal-repository.js";
import {
  createPostgresKnowledgeDraftRepository,
  type PostgresKnowledgeDraftDataSource,
} from "../src/knowledge-governance/postgres-knowledge-draft-repository.js";
import { createPostgresKnowledgeCardRepository } from "../src/knowledge-cards/postgres-knowledge-card-repository.js";
import { createPostgresFormalTaskRepository } from
  "../src/formal-tasks/postgres-formal-task-repository.js";
import { createPostgresFormalTaskCardRepository } from
  "../src/formal-tasks/postgres-formal-task-card-repository.js";
import {
  ApprovalInteractionIntentConflictError,
  createPostgresApprovalInteractionIntentStore,
} from "../src/knowledge-cards/postgres-approval-interaction-intent-store.js";
import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID();
const schema = `action_approval_${suffix.replaceAll("-", "")}`;
const groupId = `approval-group-${suffix}`;
const at = new Date("2026-07-20T12:00:00.000Z");

describe("action approval migration contract", () => {
  const migration = readFileSync(
    new URL("../migrations/0032_action_approval_facts.sql", import.meta.url),
    "utf8",
  );
  const interactionIntentMigration = readFileSync(
    new URL("../migrations/0033_approval_interaction_intents.sql", import.meta.url),
    "utf8",
  );

  it("defines durable policy, proposal, approval, card, and execution facts", () => {
    for (const table of [
      "knowledge_publication_target_policies",
      "action_target_policy_operations",
      "action_role_grants",
      "action_role_grant_operations",
      "action_proposals",
      "action_approval_requirements",
      "action_approvals",
      "action_events",
      "action_approval_presentations",
      "action_approval_presentation_events",
      "action_approval_presentation_outbox",
      "action_executions",
      "action_execution_events",
    ]) expect(migration).toMatch(new RegExp(`create table ${table}`, "iu"));

    expect(migration).toMatch(/action_proposals_one_live_subject_idx/iu);
    expect(migration).toMatch(/action_approvals_one_requirement_actor_idx/iu);
    expect(migration).toMatch(/action_approval_presentations_one_active_recipient_idx/iu);
    expect(migration).toMatch(/action_approvals_append_only/iu);
    expect(migration).toMatch(/action_events_append_only/iu);
    expect(migration).toMatch(/action_approval_presentation_events_append_only/iu);
    expect(migration).toMatch(/action_execution_events_append_only/iu);
    expect(migration).toMatch(/review_approved/iu);
    expect(migration).toMatch(/approval_invalidated/iu);
    expect(interactionIntentMigration).toMatch(/create table approval_interaction_intents/iu);
    expect(interactionIntentMigration).toMatch(/operation_fingerprint/iu);
    expect(interactionIntentMigration).toMatch(/callback_key.*unique/isu);
  });

  it("keeps repository status counts content free", () => {
    const counts: ActionProposalStatusCounts = {
      pending_approval: 1,
      approved: 2,
      executing: 3,
      succeeded: 4,
      failed: 5,
      cancelled: 6,
      expired: 7,
      reconciliation_required: 8,
    };
    const repository = {} as ActionProposalRepository;

    expect(counts).not.toHaveProperty("content");
    expect(repository).not.toHaveProperty("approveAsActor");
  });

  it("exposes publication execution as the only path from approved proposal to published draft", () => {
    const repository = createPostgresActionProposalRepository({
      dataSource: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as PostgresKnowledgeDraftDataSource,
    });

    expect(repository.claimApprovedPublicationExecution).toBeTypeOf("function");
    expect(repository.completePublicationExecution).toBeTypeOf("function");
    expect(repository).not.toHaveProperty("publishDraftDirectly");
  });

  it("qualifies publication execution replay columns when joined with execution events", () => {
    const source = readFileSync(
      new URL("../src/action-approvals/postgres-action-proposal-repository.ts", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(/publicationExecutionSelect\("execution"\)\}\s+JOIN action_execution_events event/iu);
    expect(source).not.toMatch(/publicationExecutionSelect\(\) execution\s+JOIN action_execution_events event/iu);
  });

  it("classifies exact current targets and omits stale bound revisions from planning", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM knowledge_drafts draft") && sql.includes("LIMIT $2")) {
        expect(sql).toMatch(/knowledge_publication_update_targets/iu);
        expect(sql).toMatch(/managed_knowledge_pages/iu);
        expect(sql).toMatch(/managed_page_version/iu);
        expect(sql).toMatch(/state\s*=\s*'active'/iu);
        expect(sql).toMatch(/knowledge_conflict_candidates/iu);
        expect(sql).toMatch(/document_snapshots/iu);
        expect(sql).toMatch(/knowledge_publication_target_policies/iu);
        expect(sql).toMatch(/has_any_update_target/iu);
        expect(sql).toMatch(
          /WHERE draft\.status = 'pending_review'.*target\.id IS NULL AND NOT EXISTS\s*\(\s*SELECT 1 FROM knowledge_publication_update_targets prior_target.*page\.id IS NOT NULL.*target_policy\.id IS NOT NULL.*ORDER BY/isu,
        );
        return { rows: [
          draftCandidateRow("draft-publish", null, null),
          draftCandidateRow("draft-update", "target-1", "target-1"),
          draftCandidateRow("draft-stale", "target-stale", null),
          draftCandidateRow("draft-revised-bound", null, null, true),
        ] };
      }
      if (sql.includes("FROM knowledge_draft_revision_evidence")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const repository = createPostgresActionProposalRepository({
      dataSource: { query } as unknown as PostgresKnowledgeDraftDataSource,
    });

    await expect(repository.listEligibleDrafts({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        id: "draft-publish",
        actionType: "publish_knowledge_draft",
      }),
      expect.objectContaining({
        id: "draft-update",
        actionType: "update_knowledge_publication",
      }),
    ]);
  });

  it("filters action type before proposal batch limits", async () => {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      expect(sql).toMatch(/action_type = ANY\(\$2::TEXT\[\]\).*LIMIT \$5/isu);
      expect(params).toEqual([
        ["approved"],
        ["publish_knowledge_draft"],
        null,
        null,
        1,
      ]);
      return { rows: [] };
    });
    const repository = createPostgresActionProposalRepository({
      dataSource: { query } as unknown as PostgresKnowledgeDraftDataSource,
    });

    await expect(repository.listProposals({
      statuses: ["approved"],
      actionTypes: ["publish_knowledge_draft"],
      limit: 1,
    })).resolves.toEqual([]);
  });

  it("filters update authorization groups before proposal batch limits", async () => {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      expect(sql).toMatch(
        /EXISTS\s*\(\s*SELECT 1\s+FROM knowledge_publication_update_targets target[\s\S]+target\.authorization_group_id = ANY\(\$4::TEXT\[\]\)[\s\S]+LIMIT \$5/iu,
      );
      expect(sql).toMatch(/managed_knowledge_pages page[\s\S]+page\.state = 'active'/iu);
      expect(sql).toMatch(/document_sources source[\s\S]+source\.permission_state IN \('readable','unknown'\)/iu);
      expect(sql).toMatch(/document_snapshots snapshot[\s\S]+snapshot\.fetch_status = 'succeeded'/iu);
      expect(sql).toMatch(/knowledge_publication_target_policies policy[\s\S]+policy\.enabled = TRUE/iu);
      expect(sql).toMatch(/knowledge_drafts draft[\s\S]+draft\.current_revision_number = target\.draft_revision/iu);
      expect(sql).toMatch(/knowledge_conflict_interactions interaction[\s\S]+interaction\.draft_id = target\.draft_id/iu);
      expect(sql).not.toMatch(/target\.draft_version = action_proposals\.subject_version/iu);
      expect(params).toEqual([
        ["approved"],
        ["update_knowledge_publication"],
        null,
        ["group-1"],
        1,
      ]);
      return { rows: [] };
    });
    const repository = createPostgresActionProposalRepository({
      dataSource: { query } as unknown as PostgresKnowledgeDraftDataSource,
    });

    await expect(repository.listProposals({
      statuses: ["approved"],
      actionTypes: ["update_knowledge_publication"],
      authorizationGroupIds: ["group-1"],
      limit: 1,
    })).resolves.toEqual([]);
  });

  it("stores the supplied update action and fingerprints its exact type", async () => {
    const fixture = proposalCreationDataSource({ hasManagedTarget: true });
    const repository = createPostgresActionProposalRepository({ dataSource: fixture.dataSource });
    const input = proposalCreationInput("update_knowledge_publication", "shared-operation");

    await expect(repository.createProposal(input)).resolves.toMatchObject({
      outcome: "applied",
      proposal: { actionType: "update_knowledge_publication" },
    });
    await expect(repository.createProposal({
      ...input,
      actionType: "publish_knowledge_draft",
    })).rejects.toBeInstanceOf(ActionProposalOperationConflictError);
  });

  it("never falls back to publication when the current revision has a stale binding", async () => {
    const fixture = proposalCreationDataSource({ hasManagedTarget: true, targetCurrent: false });
    const repository = createPostgresActionProposalRepository({ dataSource: fixture.dataSource });

    await expect(repository.createProposal(
      proposalCreationInput("publish_knowledge_draft", "stale-bound-publication"),
    )).rejects.toBeInstanceOf(ActionProposalIneligibleError);
  });

  it("never publishes or updates a reconfirmed revision whose binding belongs to an older revision", async () => {
    const fixture = proposalCreationDataSource({
      hasManagedTarget: true,
      targetRevision: 1,
      draftRevision: 2,
      draftVersion: 4,
    });
    const repository = createPostgresActionProposalRepository({ dataSource: fixture.dataSource });
    const revisedInput = {
      ...proposalCreationInput("publish_knowledge_draft", "reconfirmed-revised-binding"),
      expectedRevision: 2,
      expectedDraftVersion: 4,
    };

    await expect(repository.createProposal(revisedInput))
      .rejects.toBeInstanceOf(ActionProposalIneligibleError);
    await expect(repository.createProposal({
      ...revisedInput,
      proposalId: "proposal-reconfirmed-revised-update",
      actionType: "update_knowledge_publication",
      operationKey: "reconfirmed-revised-update",
    })).rejects.toBeInstanceOf(ActionProposalIneligibleError);
  });

  it("rejects a publication replay key presented for a different update proposal", async () => {
    const fixture = publicationClaimReplayDataSource();
    const repository = createPostgresActionProposalRepository({ dataSource: fixture.dataSource });

    await expect(repository.claimApprovedPublicationExecution({
      proposalId: "proposal-update",
      expectedProposalVersion: 2,
      runtimeGate: {
        globalEnabled: true,
        writeKnowledgeBase: true,
        disabledGroupIds: [],
      },
      workerId: "publication-worker",
      operationKey: "publication-claim-existing",
      at,
    })).rejects.toBeInstanceOf(ActionProposalOperationConflictError);
  });

  it("rejects a publication replay whose stored request fingerprint is not exact", async () => {
    const fixture = publicationClaimReplayDataSource({ requestFingerprint: "f".repeat(64) });
    const repository = createPostgresActionProposalRepository({ dataSource: fixture.dataSource });

    await expect(repository.claimApprovedPublicationExecution({
      proposalId: "proposal-publish",
      expectedProposalVersion: 2,
      runtimeGate: {
        globalEnabled: true,
        writeKnowledgeBase: true,
        disabledGroupIds: [],
      },
      workerId: "publication-worker",
      operationKey: "publication-claim-existing",
      at,
    })).rejects.toBeInstanceOf(ActionProposalOperationConflictError);
  });

  it("preserves exact legacy publish-new proposal replays after action typing", async () => {
    const fixture = proposalCreationDataSource({ hasManagedTarget: false });
    const repository = createPostgresActionProposalRepository({ dataSource: fixture.dataSource });
    const input = proposalCreationInput("publish_knowledge_draft", "legacy-publish-replay");

    await repository.createProposal(input);
    fixture.setStoredFingerprint(legacyActionProposalFingerprint(input));

    await expect(repository.createProposal(input)).resolves.toMatchObject({
      outcome: "already_applied",
      proposal: { actionType: "publish_knowledge_draft" },
    });
  });
});

runIfDatabase("PostgresActionProposalRepository with Postgres", () => {
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

  it("durably preserves exact sensitive intent and rejects a conflicting callback replay", async () => {
    const intentId = "66ec104d-7e24-4dae-bad5-3bcb64968a7a";
    const exactReason = "Preserve  interior spacing\nand exact case.";
    const store = createPostgresApprovalInteractionIntentStore({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
      idGenerator: () => intentId,
    });
    const interaction = {
      kind: "action_proposal_approval" as const,
      idempotencyKey: `feishu-card:cli_intent:event-intent-${suffix}`,
      eventId: `event-intent-${suffix}`,
      appId: "cli_intent",
      actorOpenId: `ou_intent_${suffix}`,
      chatId: `oc_intent_${suffix}`,
      messageId: `om_intent_${suffix}`,
      presentationId: `presentation-intent-${suffix}`,
      proposalId: `proposal-intent-${suffix}`,
      requirementId: `requirement-intent-${suffix}`,
      proposalVersion: 4,
      subjectRevision: 2,
      subjectVersion: 7,
      targetPolicyVersion: 3,
      action: "reject" as const,
    };
    const input = {
      interaction,
      reason: exactReason,
      rejectionConfirmed: true as const,
      at,
    };

    await expect(store.persistIntent(input)).resolves.toEqual({ id: intentId });
    await expect(store.persistIntent(input)).resolves.toEqual({ id: intentId });
    await expect(pool.query(
      `SELECT reason, rejection_confirmed FROM approval_interaction_intents WHERE id = $1`,
      [intentId],
    )).resolves.toMatchObject({
      rows: [{ reason: exactReason, rejection_confirmed: true }],
    });
    await expect(store.resolveIntent({ id: intentId, interaction })).resolves.toEqual({
      id: intentId,
      reason: exactReason,
      rejectionConfirmed: true,
    });
    await expect(store.resolveIntent({
      id: intentId,
      interaction: { ...interaction, action: "request_revision" },
    })).rejects.toBeInstanceOf(ApprovalInteractionIntentConflictError);
    await expect(store.persistIntent({ ...input, reason: `${exactReason} changed` }))
      .rejects.toBeInstanceOf(ApprovalInteractionIntentConflictError);

    await expect(store.deleteIntent(intentId)).resolves.toBeUndefined();
    await expect(store.resolveIntent({ id: intentId, interaction })).resolves.toBeUndefined();
  });

  it("upserts target policies with exact replay and version checks", async () => {
    const repository = actionRepository();
    const input = policyInput("policy-upsert", {
      enabled: false,
      expectedVersion: 0,
      allowedGroupIds: ["oc_z", "oc_a"],
      allowedRiskLevels: ["high", "low", "medium"],
    });

    await expect(repository.upsertTargetPolicy(input)).resolves.toMatchObject({
      outcome: "applied",
      policy: {
        id: input.id,
        enabled: false,
        version: 1,
        allowedGroupIds: ["oc_a", "oc_z"],
        allowedRiskLevels: ["high", "low", "medium"],
      },
    });
    await expect(repository.getTargetPolicy(input.id)).resolves.toMatchObject({
      id: input.id,
      allowedGroupIds: ["oc_a", "oc_z"],
    });
    await expect(repository.upsertTargetPolicy(input)).resolves.toMatchObject({
      outcome: "already_applied",
      policy: { id: input.id, version: 1 },
    });
    await expect(repository.upsertTargetPolicy({
      ...input,
      displayName: "Conflicting replay",
    })).rejects.toBeInstanceOf(ActionProposalOperationConflictError);

    const update = policyInput("policy-upsert", {
      enabled: true,
      expectedVersion: 1,
      operationKey: `${input.operationKey}:enable`,
    });
    await expect(repository.upsertTargetPolicy(update)).resolves.toMatchObject({
      outcome: "applied",
      policy: { enabled: true, version: 2 },
    });
    await expect(repository.upsertTargetPolicy({
      ...update,
      operationKey: `${input.operationKey}:stale`,
      expectedVersion: 1,
    })).rejects.toBeInstanceOf(ActionProposalVersionConflictError);
  });

  it("versions and revokes exact role grants", async () => {
    const repository = actionRepository();
    const create = {
      roleType: "iris_admin" as const,
      actorOpenId: `ou_admin_${suffix}`,
      enabled: true,
      expectedVersion: 0,
      operationKey: `grant:${suffix}:create`,
      operator: "acceptance",
      at,
    };

    await expect(repository.upsertRoleGrant(create)).resolves.toMatchObject({
      outcome: "applied",
      grant: { enabled: true, version: 1 },
    });
    await expect(repository.upsertRoleGrant(create)).resolves.toMatchObject({
      outcome: "already_applied",
      grant: { enabled: true, version: 1 },
    });
    await expect(repository.upsertRoleGrant({
      ...create,
      enabled: false,
    })).rejects.toBeInstanceOf(ActionProposalOperationConflictError);
    await expect(repository.actorHasCurrentRole({
      roleType: "iris_admin",
      actorOpenId: create.actorOpenId,
    })).resolves.toBe(true);
    await expect(repository.upsertRoleGrant({
      ...create,
      enabled: false,
      expectedVersion: 1,
      operationKey: `grant:${suffix}:revoke`,
    })).resolves.toMatchObject({ grant: { enabled: false, version: 2 } });
    await expect(repository.actorHasCurrentRole({
      roleType: "iris_admin",
      actorOpenId: create.actorOpenId,
    })).resolves.toBe(false);
  });

  it("creates an approved low-risk proposal from exact confirmed facts", async () => {
    const policy = await createEnabledPolicy("proposal-low", ["low"]);
    const draft = await createConfirmedDraft("proposal-low", "low");
    const repository = actionRepository();
    const input = {
      proposalId: `proposal-low-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: 2,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: "p".repeat(512),
      at,
    };

    await expect(repository.createProposal(input)).resolves.toMatchObject({
      outcome: "applied",
      proposal: {
        id: input.proposalId,
        subjectId: draft.id,
        subjectRevision: 1,
        subjectVersion: 2,
        status: "approved",
        riskLevel: "low",
      },
    });
    await expect(repository.createProposal(input)).resolves.toMatchObject({
      outcome: "already_applied",
      proposal: { id: input.proposalId },
    });
    await expect(repository.getProposal(input.proposalId)).resolves.toMatchObject({
      requirements: [{
        kind: "group_confirmation",
        state: "satisfied",
        roleRef: groupId,
      }],
      approvals: [],
    });
  });

  it("claims an approved publication execution and completes it into durable publication facts", async () => {
    const label = "proposal-publication-execution";
    const policy = await createEnabledPolicy(label, ["low"]);
    const draft = await createConfirmedDraft(label, "low");
    const repository = actionRepository();
    const proposal = (await repository.createProposal({
      proposalId: `${label}-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: draft.version,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${label}:${suffix}`,
      at,
    })).proposal;

    const claim = await repository.claimApprovedPublicationExecution({
      proposalId: proposal.id,
      expectedProposalVersion: proposal.version,
      runtimeGate: {
        globalEnabled: true,
        writeKnowledgeBase: true,
        disabledGroupIds: [],
      },
      workerId: `worker-${label}`,
      operationKey: `publication-claim:${label}:${suffix}`,
      at,
    });

    expect(claim).toMatchObject({
      outcome: "applied",
      execution: {
        proposalId: proposal.id,
        attemptNumber: 1,
        state: "executing",
        provider: "feishu_wiki",
      },
      proposal: { status: "executing", version: proposal.version + 1 },
      draft: {
        id: draft.id,
        revisionNumber: proposal.subjectRevision,
        version: proposal.subjectVersion,
        title: `Title ${label}`,
        content: `Content ${label}`,
      },
      policy: {
        id: policy.id,
        version: policy.version,
        spaceId: policy.spaceId,
      },
    });

    await expect(repository.claimApprovedPublicationExecution({
      proposalId: proposal.id,
      expectedProposalVersion: proposal.version,
      runtimeGate: {
        globalEnabled: true,
        writeKnowledgeBase: true,
        disabledGroupIds: [],
      },
      workerId: `worker-${label}`,
      operationKey: `publication-claim:${label}:${suffix}`,
      at,
    })).resolves.toMatchObject({
      outcome: "already_applied",
      execution: { id: claim.execution.id },
    });

    const completion = await repository.completePublicationExecution({
      proposalId: proposal.id,
      executionId: claim.execution.id,
      expectedProposalVersion: claim.proposal.version,
      expectedExecutionVersion: claim.execution.version,
      expectedDraftVersion: claim.draft.version,
      expectedSubjectRevision: claim.draft.revisionNumber,
      remoteNodeToken: `node-${label}-${suffix}`,
      remoteDocumentToken: `doc-${label}-${suffix}`,
      remoteDocumentType: "docx",
      remoteDocumentVersion: 7,
      contentHash: "c".repeat(64),
      permissionCheckSummary: "feishu_write_access_verified",
      operationKey: `publication-complete:${label}:${suffix}`,
      at,
    });

    expect(completion).toMatchObject({
      outcome: "applied",
      proposal: { status: "succeeded", version: claim.proposal.version + 1 },
      execution: {
        id: claim.execution.id,
        state: "succeeded",
        version: claim.execution.version + 1,
        remoteNodeToken: `node-${label}-${suffix}`,
        remoteDocumentToken: `doc-${label}-${suffix}`,
      },
      draftStatus: "published",
      draftVersion: claim.draft.version + 1,
      publication: {
        proposalId: proposal.id,
        executionId: claim.execution.id,
        draftId: draft.id,
        revisionNumber: proposal.subjectRevision,
        draftVersion: claim.draft.version,
      },
    });

    await expect(repository.getProposal(proposal.id)).resolves.toMatchObject({
      proposal: { status: "succeeded", version: claim.proposal.version + 1 },
    });
    const draftRepository = createPostgresKnowledgeDraftRepository({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
    });
    await expect(draftRepository.getDraft(draft.id)).resolves.toMatchObject({
      status: "published",
      version: claim.draft.version + 1,
    });
    await expect(repository.listEvents(proposal.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "execution_started", toVersion: claim.proposal.version }),
        expect.objectContaining({ eventType: "execution_succeeded", toVersion: claim.proposal.version + 1 }),
      ]),
    );
    await expect(pool.query(
      `SELECT delivery_sequence, state, idempotency_key
       FROM knowledge_draft_presentation_outbox
       WHERE presentation_id = $1
       ORDER BY delivery_sequence ASC`,
      [`presentation-${label}-${suffix}`],
    )).resolves.toMatchObject({
      rows: [
        { delivery_sequence: 1, state: "sent" },
        {
          delivery_sequence: 2,
          state: "pending",
          idempotency_key: expect.stringMatching(/^knowledge-publication-result:/u),
        },
      ],
    });
    const publicationResultClaim = await createPostgresKnowledgeCardRepository({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
    }).claimPresentationSend({
      workerId: `publication-result-worker-${suffix}`,
      leaseUntil: plusSeconds(30),
      at,
    });
    expect(publicationResultClaim).toMatchObject({
      presentation: {
        id: `presentation-${label}-${suffix}`,
        state: "closed",
      },
      attempts: 1,
    });
  });

  it("publishes a company-scoped draft without requiring a group-card result", async () => {
    const label = "company-publication-execution";
    const ownerOpenId = `ou_${label}_${suffix}`;
    const policy = (await actionRepository().upsertTargetPolicy(policyInput(label, {
      enabled: true,
      expectedVersion: 0,
      allowedGroupIds: [],
      allowedRiskLevels: ["low"],
    }))).policy;
    const draft = await createCompanyDraft(label, "low", ownerOpenId);
    const repository = actionRepository();
    const proposal = (await repository.createProposal({
      proposalId: `${label}-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: draft.version,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${label}:${suffix}`,
      at,
    })).proposal;
    const requirement = (await repository.getProposal(proposal.id))?.requirements.find(
      (item) => item.kind === "designated_owner",
    );
    expect(requirement).toBeDefined();
    const presentationId = await createActiveActionPresentation({
      proposalId: proposal.id,
      proposalVersion: proposal.version,
      requirementId: requirement!.id,
      recipientOpenId: ownerOpenId,
      label,
    });
    const approval = await repository.applyApprovalAction({
      proposalId: proposal.id,
      requirementId: requirement!.id,
      expectedProposalVersion: proposal.version,
      expectedSubjectRevision: proposal.subjectRevision,
      expectedSubjectVersion: proposal.subjectVersion,
      expectedTargetPolicyVersion: proposal.targetPolicyVersion,
      sourcePresentationId: presentationId,
      callbackEventId: `callback-action-${label}-${suffix}`,
      actorOpenId: ownerOpenId,
      action: "approve",
      requireReviewAttestation: false,
      operationKey: `action-approval:${label}:${suffix}`,
      at: plusSeconds(1),
    });
    const claim = await repository.claimApprovedPublicationExecution({
      proposalId: proposal.id,
      expectedProposalVersion: approval.proposal.version,
      runtimeGate: {
        globalEnabled: true,
        writeKnowledgeBase: true,
        disabledGroupIds: [],
      },
      workerId: `worker-${label}`,
      operationKey: `publication-claim:${label}:${suffix}`,
      at: plusSeconds(2),
    });

    await expect(repository.completePublicationExecution({
      proposalId: proposal.id,
      executionId: claim.execution.id,
      expectedProposalVersion: claim.proposal.version,
      expectedExecutionVersion: claim.execution.version,
      expectedDraftVersion: claim.draft.version,
      expectedSubjectRevision: claim.draft.revisionNumber,
      remoteNodeToken: `node-${label}-${suffix}`,
      remoteDocumentToken: `doc-${label}-${suffix}`,
      remoteDocumentType: "docx",
      contentHash: "d".repeat(64),
      permissionCheckSummary: "feishu_write_access_verified",
      operationKey: `publication-complete:${label}:${suffix}`,
      at: plusSeconds(3),
    })).resolves.toMatchObject({
      outcome: "applied",
      proposal: { status: "succeeded" },
      draftStatus: "published",
    });
  });

  it("keeps a medium-risk proposal pending for the exact owner", async () => {
    const policy = await createEnabledPolicy("proposal-medium", ["medium"]);
    const draft = await createConfirmedDraft("proposal-medium", "medium", `ou_owner_${suffix}`);
    const repository = actionRepository();

    const result = await repository.createProposal({
      proposalId: `proposal-medium-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: 2,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${suffix}:medium`,
      at,
    });

    expect(result.proposal.status).toBe("pending_approval");
    await expect(repository.getProposal(result.proposal.id)).resolves.toMatchObject({
      requirements: [
        { kind: "group_confirmation", state: "satisfied" },
        {
          kind: "designated_owner",
          state: "pending",
          roleRefType: "feishu_user",
          roleRef: `ou_owner_${suffix}`,
        },
      ],
    });
    await expect(pool.query(
      `SELECT presentation.recipient_open_id, presentation.state, outbox.state AS outbox_state
       FROM action_approval_presentations presentation
       JOIN action_approval_presentation_outbox outbox
         ON outbox.presentation_id = presentation.id
       WHERE presentation.proposal_id = $1`,
      [result.proposal.id],
    )).resolves.toMatchObject({
      rows: [{
        recipient_open_id: `ou_owner_${suffix}`,
        state: "pending_send",
        outbox_state: "pending",
      }],
    });
  });

  it("creates one typed formal-task proposal for the exact confirmed assignee", async () => {
    const label = "formal-task-proposal";
    const taskGroupId = `oc_${label}_${suffix}`;
    const assigneeOpenId = `ou_${label}_${suffix}`;
    const providerMessageId = `om_${label}_${suffix}`;
    const evidenceMessageId = `feishu:${providerMessageId}`;
    await pool.query(
      `INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id, message_type,
        text, sent_at, raw_event_idempotency_key, created_at
      ) VALUES ($1, 'feishu', $2, $3, 'ou_requester', 'text', 'task evidence', $4, $5, $4)`,
      [evidenceMessageId, providerMessageId, taskGroupId, at, `event-${label}-${suffix}`],
    );
    const taskRepository = createPostgresFormalTaskRepository({ dataSource: pool });
    const policy = (await taskRepository.upsertTargetPolicy({
      id: `task-policy-${label}-${suffix}`,
      sourceGroupId: taskGroupId,
      displayName: "Formal task pilot",
      allowedAssigneeOpenIds: [assigneeOpenId],
      maxDueHorizonDays: 30,
      enabled: true,
      expectedVersion: 0,
      operationKey: `task-policy:${label}:${suffix}`,
      operator: "acceptance",
      at,
    })).policy;
    const draft = (await taskRepository.createDraft({
      id: `task-draft-${label}-${suffix}`,
      operationKey: `task-draft:${label}:${suffix}`,
      createdBy: "ou_requester",
      revision: {
        taskSpec: {
          title: "Complete governed pilot",
          description: "Archive exact acceptance evidence.",
          assigneeOpenId,
          dueAtUtc: "2026-07-22T14:00:00.000Z",
          reminderMinutes: 30,
          sourceGroupId: taskGroupId,
          targetPolicyId: policy.id,
          targetPolicyVersion: policy.version,
        },
        riskLevel: "high",
        author: "iris",
        evidence: [{ type: "conversation_message", id: evidenceMessageId }],
      },
      at,
    })).draft;
    const cardRepository = createPostgresFormalTaskCardRepository({ dataSource: pool });
    const confirmationPresentationId = `task-confirmation-${label}-${suffix}`;
    await cardRepository.createPresentation({
      id: confirmationPresentationId,
      draftId: draft.id,
      expectedDraftVersion: draft.version,
      expectedDraftRevision: draft.currentRevisionNumber,
      taskSpecHash: draft.currentTaskSpecHash,
      groupId: taskGroupId,
      operationKey: `task-confirmation:${label}:${suffix}`,
      at,
    });
    const workerId = `task-confirmation-worker-${suffix}`;
    await cardRepository.claimPresentationSend({
      workerId,
      leaseUntil: plusSeconds(30),
      at,
    });
    await cardRepository.beginExternalAttempt({
      presentationId: confirmationPresentationId,
      workerId,
      at,
    });
    await cardRepository.completePresentationSend({
      presentationId: confirmationPresentationId,
      workerId,
      messageId: `om-task-confirmation-${suffix}`,
      at,
    });
    const confirmed = (await cardRepository.applyInteraction({
      presentationId: confirmationPresentationId,
      draftId: draft.id,
      draftRevision: draft.currentRevisionNumber,
      draftVersion: draft.version,
      taskSpecHash: draft.currentTaskSpecHash,
      targetPolicyId: policy.id,
      targetPolicyVersion: policy.version,
      groupId: taskGroupId,
      eventId: `task-confirmation-callback-${suffix}`,
      actorOpenId: `ou_member_${suffix}`,
      membershipCheckedAt: at,
      at,
      action: "confirm",
    })).draft;

    const repository = actionRepository();
    await expect(repository.listEligibleFormalTaskDrafts!({
      groupIds: [taskGroupId],
      limit: 10,
    })).resolves.toEqual([expect.objectContaining({
      id: draft.id,
      actionType: "create_feishu_task",
      version: confirmed.version,
      assigneeOpenId,
      targetPolicyId: policy.id,
      targetPolicyVersion: policy.version,
      groupConfirmationPresentationId: confirmationPresentationId,
      evidenceState: { status: "current" },
      hasCurrentGroupConfirmation: true,
    })]);
    await expect(repository.listFeishuTaskTargetPolicies!({ enabled: true, limit: 10 }))
      .resolves.toContainEqual(expect.objectContaining({ id: policy.id, enabled: true }));

    const proposalInput = {
      proposalId: `proposal-${label}-${suffix}`,
      actionType: "create_feishu_task" as const,
      draftId: draft.id,
      expectedRevision: confirmed.currentRevisionNumber,
      expectedDraftVersion: confirmed.version,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${label}:${suffix}`,
      at,
    };
    await expect(repository.createProposal(proposalInput)).resolves.toMatchObject({
      outcome: "applied",
      proposal: {
        actionType: "create_feishu_task",
        subjectType: "formal_task_draft",
        subjectId: draft.id,
        subjectRevision: confirmed.currentRevisionNumber,
        subjectVersion: confirmed.version,
        targetPolicyId: policy.id,
        targetPolicyVersion: policy.version,
        status: "pending_approval",
      },
    });
    await expect(repository.createProposal(proposalInput)).resolves.toMatchObject({
      outcome: "already_applied",
    });
    await expect(repository.getProposal(proposalInput.proposalId)).resolves.toMatchObject({
      formalTask: {
        sourceGroupId: taskGroupId,
        title: "Complete governed pilot",
        description: "Archive exact acceptance evidence.",
        assigneeOpenId,
        dueAt: new Date("2026-07-22T14:00:00.000Z"),
        reminderMinutes: 30,
        taskSpecHash: draft.currentTaskSpecHash,
        groupConfirmationPresentationId: confirmationPresentationId,
      },
      requirements: [{
        kind: "designated_owner",
        roleRefType: "feishu_user",
        roleRef: assigneeOpenId,
        targetPolicyId: policy.id,
        targetPolicyVersion: policy.version,
        state: "pending",
      }],
      approvals: [],
    });
    await expect(pool.query(
      `SELECT subject_id, target_policy_id, task_draft_id, task_target_policy_id,
              task_assignee_open_id, task_spec_hash,
              task_group_confirmation_presentation_id
       FROM action_proposals WHERE id = $1`,
      [proposalInput.proposalId],
    )).resolves.toMatchObject({ rows: [{
      subject_id: null,
      target_policy_id: null,
      task_draft_id: draft.id,
      task_target_policy_id: policy.id,
      task_assignee_open_id: assigneeOpenId,
      task_spec_hash: draft.currentTaskSpecHash,
      task_group_confirmation_presentation_id: confirmationPresentationId,
    }] });

    const resultUpdateWorker = `task-confirmation-result-worker-${suffix}`;
    const resultUpdateClaim = await cardRepository.claimPresentationSend({
      workerId: resultUpdateWorker,
      leaseUntil: plusSeconds(30),
      at,
    });
    expect(resultUpdateClaim?.presentation.id).toBe(confirmationPresentationId);
    await cardRepository.beginExternalAttempt({
      presentationId: confirmationPresentationId,
      workerId: resultUpdateWorker,
      at,
    });
    await cardRepository.completePresentationSend({
      presentationId: confirmationPresentationId,
      workerId: resultUpdateWorker,
      messageId: resultUpdateClaim!.presentation.messageId!,
      at,
    });
    const needsRevision = (await taskRepository.requestRevision({
      id: draft.id,
      expectedVersion: confirmed.version,
      expectedRevision: confirmed.currentRevisionNumber,
      expectedTaskSpecHash: confirmed.currentTaskSpecHash,
      operationKey: `task-request-revision:${label}:${suffix}`,
      actor: assigneeOpenId,
      reason: "Clarify the acceptance evidence.",
      at: plusSeconds(1),
    })).draft;
    const revised = (await taskRepository.reviseDraft({
      id: draft.id,
      expectedVersion: needsRevision.version,
      operationKey: `task-revise:${label}:${suffix}`,
      actor: "ou_requester",
      revision: {
        taskSpec: {
          title: "Complete governed pilot with archive",
          description: "Archive exact acceptance evidence.",
          assigneeOpenId,
          dueAtUtc: "2026-07-22T14:00:00.000Z",
          reminderMinutes: 30,
          sourceGroupId: taskGroupId,
          targetPolicyId: policy.id,
          targetPolicyVersion: policy.version,
        },
        riskLevel: "high",
        author: "iris",
        evidence: [{ type: "conversation_message", id: evidenceMessageId }],
      },
      at: plusSeconds(2),
    })).draft;
    const revisedPresentationId = `task-confirmation-revised-${label}-${suffix}`;
    await cardRepository.createPresentation({
      id: revisedPresentationId,
      draftId: revised.id,
      expectedDraftVersion: revised.version,
      expectedDraftRevision: revised.currentRevisionNumber,
      taskSpecHash: revised.currentTaskSpecHash,
      groupId: taskGroupId,
      operationKey: `task-confirmation-revised:${label}:${suffix}`,
      at: plusSeconds(2),
    });
    const revisedWorkerId = `task-confirmation-revised-worker-${suffix}`;
    await cardRepository.claimPresentationSend({
      workerId: revisedWorkerId,
      leaseUntil: plusSeconds(32),
      at: plusSeconds(2),
    });
    await cardRepository.beginExternalAttempt({
      presentationId: revisedPresentationId,
      workerId: revisedWorkerId,
      at: plusSeconds(2),
    });
    await cardRepository.completePresentationSend({
      presentationId: revisedPresentationId,
      workerId: revisedWorkerId,
      messageId: `om-task-confirmation-revised-${suffix}`,
      at: plusSeconds(2),
    });
    const reconfirmed = (await cardRepository.applyInteraction({
      presentationId: revisedPresentationId,
      draftId: revised.id,
      draftRevision: revised.currentRevisionNumber,
      draftVersion: revised.version,
      taskSpecHash: revised.currentTaskSpecHash,
      targetPolicyId: policy.id,
      targetPolicyVersion: policy.version,
      groupId: taskGroupId,
      eventId: `task-confirmation-revised-callback-${suffix}`,
      actorOpenId: `ou_member_${suffix}`,
      membershipCheckedAt: plusSeconds(2),
      at: plusSeconds(2),
      action: "confirm",
    })).draft;
    await expect(repository.cancelStaleFormalTaskProposals!({
      draftId: reconfirmed.id,
      currentRevision: reconfirmed.currentRevisionNumber,
      currentDraftVersion: reconfirmed.version,
      operationKey: `cancel-stale-task-proposals:${label}:${suffix}`,
      at: plusSeconds(3),
    })).resolves.toEqual({
      outcome: "applied",
      cancelledProposalIds: [proposalInput.proposalId],
      draftVersion: reconfirmed.version,
    });
    await expect(repository.getProposal(proposalInput.proposalId)).resolves.toMatchObject({
      proposal: { status: "cancelled", version: 2 },
      requirements: [{ state: "invalidated" }],
    });
    await expect(pool.query(
      `SELECT state FROM action_approval_presentations WHERE proposal_id = $1`,
      [proposalInput.proposalId],
    )).resolves.toMatchObject({ rows: [{ state: "superseded" }] });
  });

  it("keeps high risk pending for an explicitly bound authorized owner", async () => {
    const policy = await createEnabledPolicy("proposal-high", ["high"]);
    const reviewerOpenId = `ou_high_owner_${suffix}`;
    const draft = await createConfirmedDraft("proposal-high", "high", reviewerOpenId);
    const repository = actionRepository();

    const result = await repository.createProposal({
      proposalId: `proposal-high-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: 2,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${suffix}:high`,
      at,
    });

    expect(result.proposal.status).toBe("pending_approval");
    await expect(repository.getProposal(result.proposal.id)).resolves.toMatchObject({
      requirements: [
        { kind: "group_confirmation", state: "satisfied" },
        {
          kind: "iris_admin_or_authorized_owner",
          state: "pending",
          roleRefType: "feishu_user",
          roleRef: reviewerOpenId,
        },
      ],
    });
  });

  it("never downgrades a missing reviewer into an arbitrary group approval", async () => {
    const policy = await createEnabledPolicy("proposal-unassigned", ["medium"]);
    const draft = await createConfirmedDraft("proposal-unassigned", "medium");
    const repository = actionRepository();

    const result = await repository.createProposal({
      proposalId: `proposal-unassigned-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: 2,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${suffix}:unassigned`,
      at,
    });

    expect(result.proposal.status).toBe("pending_approval");
    await expect(repository.getProposal(result.proposal.id)).resolves.toMatchObject({
      requirements: [
        { kind: "group_confirmation", state: "satisfied" },
        {
          kind: "designated_owner",
          state: "pending",
          roleRefType: "unassigned",
        },
      ],
    });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM action_approval_presentations WHERE proposal_id = $1",
      [result.proposal.id],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("requires a designated owner for a company-scoped medium-risk draft", async () => {
    const policy = (await actionRepository().upsertTargetPolicy(policyInput("proposal-company", {
      enabled: true,
      expectedVersion: 0,
      allowedGroupIds: [],
      allowedRiskLevels: ["medium"],
    }))).policy;
    const reviewerOpenId = `ou_company_owner_${suffix}`;
    const draft = await createCompanyDraft("proposal-company", "medium", reviewerOpenId);
    const repository = actionRepository();

    const result = await repository.createProposal({
      proposalId: `proposal-company-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: 1,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${suffix}:company`,
      at,
    });

    expect(result.proposal.status).toBe("pending_approval");
    await expect(repository.getProposal(result.proposal.id)).resolves.toMatchObject({
      requirements: [{
        kind: "designated_owner",
        state: "pending",
        roleRefType: "feishu_user",
        roleRef: reviewerOpenId,
      }],
    });
  });

  it("claims, retries, and atomically activates one approval presentation", async () => {
    await pool.query(
      `UPDATE action_approval_presentation_outbox
       SET state = 'failed', error_code = 'test_isolation'
       WHERE state = 'pending'`,
    );
    const label = "proposal-delivery";
    const ownerOpenId = `ou_delivery_owner_${suffix}`;
    const policy = await createEnabledPolicy(label, ["medium"]);
    const draft = await createConfirmedDraft(label, "medium", ownerOpenId);
    const repository = actionRepository();
    const proposal = (await repository.createProposal({
      proposalId: `proposal-delivery-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: 2,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${suffix}:delivery`,
      at,
    })).proposal;
    const firstClaim = await repository.claimApprovalPresentationSend({
      workerId: "approval-delivery-worker",
      at,
      leaseUntil: plusSeconds(30),
    });
    expect(firstClaim).toMatchObject({
      workerId: "approval-delivery-worker",
      attempts: 1,
      presentation: {
        proposalId: proposal.id,
        proposalVersion: proposal.version,
        recipientOpenId: ownerOpenId,
        state: "pending_send",
      },
    });
    const context = await repository.getApprovalDeliveryContext(firstClaim!.presentation.id);
    expect(context).toMatchObject({
      context: { proposal: { id: proposal.id }, approvals: [] },
      requirement: { state: "pending", roleRef: ownerOpenId },
      policy: { id: policy.id, displayName: policy.displayName },
      presentation: { id: firstClaim!.presentation.id },
    });
    expect(JSON.stringify(context)).not.toMatch(/Title proposal-delivery|Content proposal-delivery|approval evidence/iu);

    await repository.beginApprovalExternalAttempt({
      presentationId: firstClaim!.presentation.id,
      workerId: "approval-delivery-worker",
      at,
    });
    await repository.failApprovalPresentationSend({
      presentationId: firstClaim!.presentation.id,
      workerId: "approval-delivery-worker",
      classification: "retryable",
      errorCode: "retryable_remote_failure",
      retryAt: plusSeconds(60),
      at,
    });
    await expect(repository.claimApprovalPresentationSend({
      workerId: "approval-delivery-worker",
      at: plusSeconds(59),
      leaseUntil: plusSeconds(89),
    })).resolves.toBeUndefined();
    const secondClaim = await repository.claimApprovalPresentationSend({
      workerId: "approval-delivery-worker",
      at: plusSeconds(60),
      leaseUntil: plusSeconds(90),
    });
    expect(secondClaim).toMatchObject({
      attempts: 2,
      presentation: { id: firstClaim!.presentation.id, state: "pending_send" },
    });
    await repository.beginApprovalExternalAttempt({
      presentationId: secondClaim!.presentation.id,
      workerId: "approval-delivery-worker",
      at: plusSeconds(60),
    });
    await repository.completeApprovalPresentationSend({
      presentationId: secondClaim!.presentation.id,
      workerId: "approval-delivery-worker",
      messageId: `om-delivery-${suffix}`,
      at: plusSeconds(61),
    });
    await expect(repository.getApprovalDeliveryContext(secondClaim!.presentation.id)).resolves.toMatchObject({
      presentation: {
        state: "active",
        messageId: `om-delivery-${suffix}`,
        version: 2,
      },
    });
    await expect(repository.getApprovalOutboxStatusCounts()).resolves.toMatchObject({
      sent: 1,
      external_attempting: 0,
      outcome_unknown: 0,
    });
    await expect(repository.completeApprovalPresentationSend({
      presentationId: secondClaim!.presentation.id,
      workerId: "approval-delivery-worker",
      messageId: `om-delivery-${suffix}`,
      at: plusSeconds(62),
    })).resolves.toBeUndefined();
    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM action_approval_presentation_events
       WHERE presentation_id = $1 AND event_type = 'send_succeeded'`,
      [secondClaim!.presentation.id],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("fails closed without persisting when the current policy rejects the risk", async () => {
    const policy = await createEnabledPolicy("proposal-unsupported", ["low"]);
    const draft = await createConfirmedDraft(
      "proposal-unsupported",
      "medium",
      `ou_owner_${suffix}`,
    );
    const repository = actionRepository();
    const before = await repository.getStatusCounts();

    await expect(repository.createProposal({
      proposalId: `proposal-unsupported-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: 2,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${suffix}:unsupported`,
      at,
    })).rejects.toBeInstanceOf(ActionProposalIneligibleError);
    await expect(repository.getProposal(`proposal-unsupported-${suffix}`)).resolves.toBeUndefined();
    await expect(repository.getStatusCounts()).resolves.toEqual(before);
  });

  it("invalidates an old live proposal after a new draft revision", async () => {
    const label = "proposal-stale-revision";
    const reviewerOpenId = `ou_stale_owner_${suffix}`;
    const policy = await createEnabledPolicy(label, ["medium"]);
    const draft = await createConfirmedDraft(label, "medium", reviewerOpenId);
    const repository = actionRepository();
    const proposal = (await repository.createProposal({
      proposalId: `proposal-stale-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: 2,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${suffix}:stale`,
      at,
    })).proposal;
    const outboxBeforeInvalidation = await repository.getApprovalOutboxStatusCounts();
    const draftRepository = createPostgresKnowledgeDraftRepository({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
    });
    await draftRepository.requestRevision({
      id: draft.id,
      expectedVersion: 2,
      operationKey: `draft:${suffix}:request-revision`,
      actor: reviewerOpenId,
      reason: "Update the approved wording.",
      at: plusSeconds(1),
    });
    const revised = (await draftRepository.reviseDraft({
      id: draft.id,
      expectedVersion: 3,
      operationKey: `draft:${suffix}:revise`,
      actor: "acceptance",
      at: plusSeconds(2),
      revision: {
        sourceGroupId: groupId,
        title: "Revised title",
        content: "Revised content",
        riskLevel: "medium",
        reviewer: { type: "feishu_user", ref: reviewerOpenId },
        suggestedPublication: { spaceId: policy.spaceId },
        evidence: [{
          type: "conversation_message",
          id: `feishu:om-${label}-${suffix}`,
          groupId,
        }],
      },
    })).draft;

    const input = {
      draftId: draft.id,
      currentRevision: revised.currentRevisionNumber,
      currentDraftVersion: revised.version,
      operationKey: `action-proposal:${suffix}:invalidate`,
      at: plusSeconds(3),
    };
    await expect(repository.cancelStaleProposals(input)).resolves.toEqual({
      outcome: "applied",
      cancelledProposalIds: [proposal.id],
      draftVersion: 5,
    });
    await expect(repository.getApprovalOutboxStatusCounts()).resolves.toMatchObject({
      failed: outboxBeforeInvalidation.failed + 1,
      terminalFailed: outboxBeforeInvalidation.terminalFailed,
    });
    await expect(repository.cancelStaleProposals(input)).resolves.toEqual({
      outcome: "already_applied",
      cancelledProposalIds: [proposal.id],
      draftVersion: 5,
    });
    await expect(repository.getProposal(proposal.id)).resolves.toMatchObject({
      proposal: { status: "cancelled", version: 2 },
      requirements: expect.arrayContaining([
        expect.objectContaining({ state: "invalidated" }),
      ]),
    });
    await expect(repository.listEvents(proposal.id)).resolves.toEqual([
      expect.objectContaining({ eventType: "created", toVersion: 1 }),
      expect.objectContaining({
        eventType: "approval_invalidated",
        fromVersion: 1,
        toVersion: 2,
      }),
    ]);
    await expect(draftRepository.listEvents(draft.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "approval_invalidated", toVersion: 5 }),
    ]));
  });

  it("records one exact owner approval and advances the proposal atomically", async () => {
    const label = "proposal-owner-approval";
    const ownerOpenId = `ou_approval_owner_${suffix}`;
    const policy = await createEnabledPolicy(label, ["medium"]);
    const draft = await createConfirmedDraft(label, "medium", ownerOpenId);
    const repository = actionRepository();
    const proposal = (await repository.createProposal({
      proposalId: `proposal-owner-approval-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: 2,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${suffix}:owner-approval`,
      at,
    })).proposal;
    const context = await repository.getProposal(proposal.id);
    const requirement = context?.requirements.find((item) => item.kind === "designated_owner");
    expect(requirement).toBeDefined();
    const presentationId = await createActiveActionPresentation({
      proposalId: proposal.id,
      proposalVersion: proposal.version,
      requirementId: requirement!.id,
      recipientOpenId: ownerOpenId,
      label,
    });
    const baseInput = {
      proposalId: proposal.id,
      requirementId: requirement!.id,
      expectedProposalVersion: proposal.version,
      expectedSubjectRevision: proposal.subjectRevision,
      expectedSubjectVersion: proposal.subjectVersion,
      expectedTargetPolicyVersion: proposal.targetPolicyVersion,
      sourcePresentationId: presentationId,
      callbackEventId: `callback-action-${label}-${suffix}`,
      actorOpenId: ownerOpenId,
      action: "approve" as const,
      requireReviewAttestation: false,
      operationKey: `action-approval:${label}:${suffix}`,
      at: plusSeconds(1),
    };

    await expect(repository.preflightApprovalAction({
      proposalId: proposal.id,
      requirementId: requirement!.id,
      expectedProposalVersion: proposal.version,
      expectedSubjectRevision: proposal.subjectRevision,
      expectedSubjectVersion: proposal.subjectVersion,
      expectedTargetPolicyVersion: proposal.targetPolicyVersion,
      sourcePresentationId: presentationId,
      actorOpenId: ownerOpenId,
      action: "approve",
      requireReviewAttestation: false,
    })).resolves.toEqual({ sourceGroupId: groupId });

    await expect(repository.applyApprovalAction({
      ...baseInput,
      actorOpenId: `ou_wrong_${suffix}`,
      operationKey: `action-approval:${label}:${suffix}:wrong`,
      callbackEventId: `callback-action-${label}-${suffix}:wrong`,
    })).rejects.toBeInstanceOf(ActionProposalAuthorizationError);
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM action_approvals WHERE proposal_id = $1",
      [proposal.id],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await expect(repository.applyApprovalAction(baseInput)).resolves.toMatchObject({
      outcome: "applied",
      action: "approve",
      proposal: { id: proposal.id, status: "approved", version: 3, subjectVersion: 3 },
      draftStatus: "pending_review",
      draftVersion: 3,
    });
    await expect(repository.inspectApprovalActionReplay(baseInput)).resolves.toMatchObject({
      result: {
        outcome: "already_applied",
        action: "approve",
        proposal: { id: proposal.id, status: "approved" },
        draftVersion: 3,
      },
      sourceGroupId: groupId,
    });
    await expect(repository.inspectApprovalActionReplay({
      ...baseInput,
      at: plusSeconds(60),
    })).resolves.toMatchObject({
      result: { outcome: "already_applied", action: "approve" },
      sourceGroupId: groupId,
    });
    await expect(repository.inspectApprovalActionReplay({
      ...baseInput,
      actorOpenId: `ou_conflicting_${suffix}`,
    })).rejects.toBeInstanceOf(ActionProposalOperationConflictError);
    await expect(repository.inspectApprovalActionReplay({
      ...baseInput,
      expectedTargetPolicyVersion: baseInput.expectedTargetPolicyVersion + 1,
    })).rejects.toBeInstanceOf(ActionProposalOperationConflictError);
    await expect(repository.applyApprovalAction(baseInput)).resolves.toMatchObject({
      outcome: "already_applied",
      proposal: { status: "approved", version: 3 },
      draftVersion: 3,
    });
    const committed = await repository.getProposal(proposal.id);
    expect(committed).toMatchObject({
      requirements: expect.arrayContaining([
        expect.objectContaining({
          id: requirement!.id,
          state: "satisfied",
          satisfiedActorOpenId: ownerOpenId,
          satisfiedSourceType: "action_approval",
          satisfiedSourceId: expect.any(String),
        }),
      ]),
      approvals: [expect.objectContaining({
        requirementId: requirement!.id,
        actorOpenId: ownerOpenId,
        callbackEventId: baseInput.callbackEventId,
      })],
    });
    const approval = committed?.approvals[0];
    const satisfiedRequirement = committed?.requirements.find((item) => item.id === requirement!.id);
    expect(approval?.sourcePresentationId).toBe(presentationId);
    expect(satisfiedRequirement?.satisfiedSourceId).toBe(approval?.id);
    await expect(repository.listEvents(proposal.id)).resolves.toEqual([
      expect.objectContaining({ eventType: "created", toVersion: 1 }),
      expect.objectContaining({ eventType: "approval_recorded", fromVersion: 1, toVersion: 2 }),
      expect.objectContaining({ eventType: "requirements_satisfied", fromVersion: 2, toVersion: 3 }),
    ]);
  });

  it("rechecks a high-risk owner's current grant at approval time", async () => {
    const label = "proposal-high-current-grant";
    const ownerOpenId = `ou_high_current_${suffix}`;
    const policy = await createEnabledPolicy(label, ["high"]);
    const draft = await createConfirmedDraft(label, "high", ownerOpenId);
    const repository = actionRepository();
    const proposal = (await repository.createProposal({
      proposalId: `proposal-high-current-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: 2,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${suffix}:high-current`,
      at,
    })).proposal;
    const requirement = (await repository.getProposal(proposal.id))?.requirements.find(
      (item) => item.kind === "iris_admin_or_authorized_owner",
    );
    expect(requirement).toBeDefined();
    const presentationId = await createActiveActionPresentation({
      proposalId: proposal.id,
      proposalVersion: proposal.version,
      requirementId: requirement!.id,
      recipientOpenId: ownerOpenId,
      label,
    });
    const grant = {
      roleType: "authorized_high_risk_owner" as const,
      actorOpenId: ownerOpenId,
      enabled: true,
      expectedVersion: 0,
      operationKey: `grant:${label}:${suffix}:enable`,
      operator: "acceptance",
      at,
    };
    await repository.upsertRoleGrant(grant);
    await repository.upsertRoleGrant({
      ...grant,
      enabled: false,
      expectedVersion: 1,
      operationKey: `grant:${label}:${suffix}:revoke`,
      at: plusSeconds(1),
    });
    const approvalInput = {
      proposalId: proposal.id,
      requirementId: requirement!.id,
      expectedProposalVersion: proposal.version,
      expectedSubjectRevision: proposal.subjectRevision,
      expectedSubjectVersion: proposal.subjectVersion,
      expectedTargetPolicyVersion: proposal.targetPolicyVersion,
      sourcePresentationId: presentationId,
      callbackEventId: `callback-action-${label}-${suffix}`,
      actorOpenId: ownerOpenId,
      action: "approve" as const,
      requireReviewAttestation: false,
      operationKey: `action-approval:${label}:${suffix}`,
      at: plusSeconds(2),
    };

    await expect(repository.preflightApprovalAction({
      proposalId: proposal.id,
      requirementId: requirement!.id,
      expectedProposalVersion: proposal.version,
      expectedSubjectRevision: proposal.subjectRevision,
      expectedSubjectVersion: proposal.subjectVersion,
      expectedTargetPolicyVersion: proposal.targetPolicyVersion,
      sourcePresentationId: presentationId,
      actorOpenId: ownerOpenId,
      action: "approve",
      requireReviewAttestation: false,
    })).rejects.toBeInstanceOf(ActionProposalAuthorizationError);
    await expect(repository.applyApprovalAction(approvalInput))
      .rejects.toBeInstanceOf(ActionProposalAuthorizationError);
    await repository.upsertRoleGrant({
      ...grant,
      expectedVersion: 2,
      operationKey: `grant:${label}:${suffix}:restore`,
      at: plusSeconds(3),
    });
    await expect(repository.preflightApprovalAction({
      proposalId: proposal.id,
      requirementId: requirement!.id,
      expectedProposalVersion: proposal.version,
      expectedSubjectRevision: proposal.subjectRevision,
      expectedSubjectVersion: proposal.subjectVersion,
      expectedTargetPolicyVersion: proposal.targetPolicyVersion,
      sourcePresentationId: presentationId,
      actorOpenId: ownerOpenId,
      action: "approve",
      requireReviewAttestation: false,
    })).resolves.toEqual({ sourceGroupId: groupId });
    await expect(repository.applyApprovalAction({
      ...approvalInput,
      at: plusSeconds(4),
    })).resolves.toMatchObject({
      outcome: "applied",
      proposal: { status: "approved" },
    });
  });

  it("requests revision without fabricating an approval fact", async () => {
    const acceptance = await createPendingOwnerApprovalCase("proposal-request-revision");
    const input = {
      proposalId: acceptance.proposal.id,
      requirementId: acceptance.requirement.id,
      expectedProposalVersion: acceptance.proposal.version,
      expectedSubjectRevision: acceptance.proposal.subjectRevision,
      expectedSubjectVersion: acceptance.proposal.subjectVersion,
      expectedTargetPolicyVersion: acceptance.proposal.targetPolicyVersion,
      sourcePresentationId: acceptance.presentationId,
      callbackEventId: `callback-action-request-revision-${suffix}`,
      actorOpenId: acceptance.ownerOpenId,
      action: "request_revision" as const,
      requireReviewAttestation: false,
      reason: "Clarify the rollback owner.",
      operationKey: `action-request-revision:${suffix}`,
      at: plusSeconds(1),
    };

    await expect(acceptance.repository.applyApprovalAction(input)).resolves.toMatchObject({
      outcome: "applied",
      action: "request_revision",
      proposal: { status: "cancelled", version: 2 },
      draftStatus: "needs_revision",
      draftVersion: 3,
    });
    await expect(acceptance.repository.inspectApprovalActionReplay(input)).resolves.toMatchObject({
      result: {
        outcome: "already_applied",
        action: "request_revision",
        proposal: { status: "cancelled" },
        draftStatus: "needs_revision",
        draftVersion: 3,
      },
      sourceGroupId: groupId,
    });
    await expect(acceptance.repository.inspectApprovalActionReplay({
      ...input,
      at: plusSeconds(60),
    })).resolves.toMatchObject({
      result: { outcome: "already_applied", action: "request_revision" },
      sourceGroupId: groupId,
    });
    await expect(acceptance.repository.inspectApprovalActionReplay({
      ...input,
      reason: "Conflicting revision reason.",
    })).rejects.toBeInstanceOf(ActionProposalOperationConflictError);
    await expect(acceptance.repository.inspectApprovalActionReplay({
      ...input,
      expectedTargetPolicyVersion: input.expectedTargetPolicyVersion + 1,
    })).rejects.toBeInstanceOf(ActionProposalOperationConflictError);
    await expect(acceptance.repository.applyApprovalAction(input)).resolves.toMatchObject({
      outcome: "already_applied",
      proposal: { status: "cancelled", version: 2 },
      draftStatus: "needs_revision",
    });
    await expect(acceptance.repository.getProposal(acceptance.proposal.id)).resolves.toMatchObject({
      requirements: expect.arrayContaining([
        expect.objectContaining({ id: acceptance.requirement.id, state: "invalidated" }),
      ]),
      approvals: [],
    });
    await expect(acceptance.repository.listEvents(acceptance.proposal.id)).resolves.toEqual([
      expect.objectContaining({ eventType: "created", toVersion: 1 }),
      expect.objectContaining({ eventType: "revision_requested", fromVersion: 1, toVersion: 2 }),
    ]);
  });

  it("applies an operator governance disposition without fabricating a human approval", async () => {
    const acceptance = await createPendingOwnerApprovalCase("proposal-governance-revision");
    const input = {
      proposalId: acceptance.proposal.id,
      expectedProposalVersion: acceptance.proposal.version,
      expectedSubjectRevision: acceptance.proposal.subjectRevision,
      expectedSubjectVersion: acceptance.proposal.subjectVersion,
      action: "request_revision" as const,
      reason: "Clarify the rollback owner.",
      operationKey: `governance-revision:${suffix}`,
      operator: "operator@example.com",
      at: plusSeconds(1),
    };

    await expect(acceptance.repository.applyGovernanceDisposition(input)).resolves.toMatchObject({
      outcome: "applied",
      action: "request_revision",
      proposal: { status: "cancelled", version: 2 },
      draftStatus: "needs_revision",
      draftVersion: 3,
    });
    await expect(acceptance.repository.applyGovernanceDisposition({
      ...input,
      at: plusSeconds(60),
    })).resolves.toMatchObject({
      outcome: "already_applied",
      action: "request_revision",
      proposal: { status: "cancelled" },
    });
    await expect(acceptance.repository.applyGovernanceDisposition({
      ...input,
      operator: "conflicting-operator@example.com",
    })).rejects.toBeInstanceOf(ActionProposalOperationConflictError);

    const approvalCount = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM action_approvals WHERE proposal_id = $1",
      [acceptance.proposal.id],
    );
    expect(approvalCount.rows[0]?.count).toBe(0);
    const governedOutbox = await pool.query<{ state: string; error_code: string | null }>(
      `SELECT outbox.state, outbox.error_code
       FROM action_approval_presentation_outbox outbox
       JOIN action_approval_presentations presentation
         ON presentation.id = outbox.presentation_id
       WHERE presentation.proposal_id = $1`,
      [acceptance.proposal.id],
    );
    expect(governedOutbox.rows.length).toBeGreaterThan(0);
    expect(governedOutbox.rows.every((row) =>
      row.state === "failed" && row.error_code === "governance_disposition")).toBe(true);
    const terminalFailures = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM action_approval_presentation_outbox
       WHERE state = 'failed'
         AND error_code IS DISTINCT FROM 'governance_disposition'
         AND error_code IS DISTINCT FROM 'presentation_superseded'`,
    );
    await expect(acceptance.repository.getApprovalOutboxStatusCounts()).resolves.toMatchObject({
      terminalFailed: terminalFailures.rows[0]?.count,
    });
    await expect(acceptance.repository.listEvents(acceptance.proposal.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "revision_requested",
          actorOpenId: "operator@example.com",
          reasonCode: "operator_requested_revision",
        }),
      ]),
    );
  });

  it("requires explicit rejection confirmation and rejects without an approval fact", async () => {
    const acceptance = await createPendingOwnerApprovalCase("proposal-reject");
    const input = {
      proposalId: acceptance.proposal.id,
      requirementId: acceptance.requirement.id,
      expectedProposalVersion: acceptance.proposal.version,
      expectedSubjectRevision: acceptance.proposal.subjectRevision,
      expectedSubjectVersion: acceptance.proposal.subjectVersion,
      expectedTargetPolicyVersion: acceptance.proposal.targetPolicyVersion,
      sourcePresentationId: acceptance.presentationId,
      callbackEventId: `callback-action-reject-${suffix}`,
      actorOpenId: acceptance.ownerOpenId,
      action: "reject" as const,
      requireReviewAttestation: false,
      reason: "This content should not be published.",
      operationKey: `action-reject:${suffix}`,
      at: plusSeconds(1),
    };

    await expect(acceptance.repository.applyApprovalAction(input)).rejects.toThrow(
      /rejection confirmation is required/iu,
    );
    await expect(acceptance.repository.applyApprovalAction({
      ...input,
      rejectionConfirmed: true,
    })).resolves.toMatchObject({
      outcome: "applied",
      action: "reject",
      proposal: { status: "cancelled", version: 2 },
      draftStatus: "rejected",
      draftVersion: 3,
    });
    const draftRepository = createPostgresKnowledgeDraftRepository({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
    });
    await expect(draftRepository.getDraft(acceptance.proposal.subjectId)).resolves.toMatchObject({
      status: "rejected",
      rejectedBy: acceptance.ownerOpenId,
      rejectionReason: input.reason,
    });
    await expect(acceptance.repository.getProposal(acceptance.proposal.id)).resolves.toMatchObject({
      approvals: [],
    });
  });

  it("deduplicates concurrent identical approval callbacks", async () => {
    const acceptance = await createPendingOwnerApprovalCase("proposal-concurrent-approval");
    const input = {
      proposalId: acceptance.proposal.id,
      requirementId: acceptance.requirement.id,
      expectedProposalVersion: acceptance.proposal.version,
      expectedSubjectRevision: acceptance.proposal.subjectRevision,
      expectedSubjectVersion: acceptance.proposal.subjectVersion,
      expectedTargetPolicyVersion: acceptance.proposal.targetPolicyVersion,
      sourcePresentationId: acceptance.presentationId,
      callbackEventId: `callback-action-concurrent-${suffix}`,
      actorOpenId: acceptance.ownerOpenId,
      action: "approve" as const,
      requireReviewAttestation: false,
      operationKey: `action-concurrent:${suffix}`,
      at: plusSeconds(1),
    };

    const results = await Promise.all([
      acceptance.repository.applyApprovalAction(input),
      acceptance.repository.applyApprovalAction(input),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "already_applied",
      "applied",
    ]);
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM action_approvals WHERE proposal_id = $1",
      [acceptance.proposal.id],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("lists bounded content-free planner candidates with current evidence state", async () => {
    const label = "planner-invalid-evidence";
    const draft = await createConfirmedDraft(label, "low");
    const providerMessageId = `om-${label}-${suffix}`;
    await pool.query(
      `INSERT INTO conversation_message_deletion_tombstones (
        provider, provider_message_id, conversation_message_id, chat_id, deleted_at
      ) VALUES ('feishu', $1, $2, $3, $4)`,
      [
        providerMessageId,
        `feishu:${providerMessageId}`,
        groupId,
        plusSeconds(10),
      ],
    );
    const repository = actionRepository();

    const candidates = await repository.listEligibleDrafts({
      groupIds: [groupId],
      limit: 100,
    });

    expect(candidates).toEqual([...candidates].sort((left, right) =>
      left.updatedAt.getTime() - right.updatedAt.getTime() || left.id.localeCompare(right.id)));
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: draft.id,
        sourceGroupId: groupId,
        hasCurrentGroupConfirmation: true,
        evidenceState: { status: "invalidated", reason: "message_deleted" },
      }),
    ]));
    expect(candidates.every((candidate) => candidate.sourceGroupId === groupId)).toBe(true);
    expect(JSON.stringify(candidates)).not.toMatch(/Title |Content |approval evidence/iu);
    await expect(repository.listEligibleDrafts({
      groupIds: [`oc_not_allowed_${suffix}`],
      limit: 100,
    })).resolves.toEqual([]);
  });

  it("skips a presentation locked by governance instead of reversing the lock order", async () => {
    const acceptance = await createPendingOwnerApprovalCase("proposal-claim-lock-order");
    const blocker = await pool.connect();
    let claim: Promise<Awaited<ReturnType<typeof acceptance.repository.claimApprovalPresentationSend>>> | undefined;
    try {
      await blocker.query("BEGIN");
      const locked = await blocker.query<{ id: string; proposal_id: string }>(
        `SELECT presentation.id, presentation.proposal_id
         FROM action_approval_presentations presentation
         JOIN action_approval_presentation_outbox outbox
           ON outbox.presentation_id = presentation.id
         WHERE presentation.state = 'pending_send'
           AND (
             (outbox.state = 'pending' AND (outbox.retry_at IS NULL OR outbox.retry_at <= $1))
             OR (outbox.state = 'processing' AND outbox.lease_until <= $1)
           )
         FOR UPDATE OF presentation`,
        [plusSeconds(1)],
      );
      expect(locked.rows.some((row) => row.proposal_id === acceptance.proposal.id)).toBe(true);
      claim = acceptance.repository.claimApprovalPresentationSend({
        workerId: `lock-order-worker-${suffix}`,
        at: plusSeconds(1),
        leaseUntil: plusSeconds(31),
      });
      const result = await Promise.race([
        claim,
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
      ]);
      expect(result).toBeUndefined();
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await claim;
    }
  });

  it("locks the proposal before the presentation when beginning an external attempt", async () => {
    const acceptance = await createPendingOwnerApprovalCase("proposal-begin-lock-order");
    const pendingPresentation = await pool.query<{ id: string }>(
      `SELECT id FROM action_approval_presentations
       WHERE proposal_id = $1 AND state = 'pending_send'`,
      [acceptance.proposal.id],
    );
    const presentationId = pendingPresentation.rows[0]?.id;
    expect(presentationId).toBeDefined();
    const workerId = `begin-lock-order-worker-${suffix}`;
    await pool.query(
      `UPDATE action_approval_presentation_outbox
       SET state = 'processing', worker_id = $2, lease_until = $3, updated_at = $4
       WHERE presentation_id = $1`,
      [presentationId, workerId, plusSeconds(30), at],
    );

    const blocker = await pool.connect();
    let begin: Promise<void> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SET LOCAL lock_timeout = '500ms'");
      await blocker.query("SELECT id FROM action_proposals WHERE id = $1 FOR UPDATE", [acceptance.proposal.id]);
      begin = acceptance.repository.beginApprovalExternalAttempt({
        presentationId: presentationId!,
        workerId,
        at: plusSeconds(1),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await blocker.query(
        "SELECT id FROM action_approval_presentations WHERE id = $1 FOR UPDATE",
        [presentationId],
      );
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await begin;
    }

    await expect(pool.query(
      "SELECT state FROM action_approval_presentation_outbox WHERE presentation_id = $1",
      [presentationId],
    )).resolves.toMatchObject({ rows: [{ state: "external_attempting" }] });
  });

  function actionRepository() {
    return createPostgresActionProposalRepository({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
    });
  }

  async function createEnabledPolicy(label: string, risks: Array<"low" | "medium" | "high">) {
    const result = await actionRepository().upsertTargetPolicy(policyInput(label, {
      enabled: true,
      expectedVersion: 0,
      allowedRiskLevels: risks,
    }));
    return result.policy;
  }

  async function createConfirmedDraft(
    label: string,
    riskLevel: "low" | "medium" | "high",
    reviewerOpenId?: string,
  ) {
    const providerMessageId = `om-${label}-${suffix}`;
    const messageId = `feishu:${providerMessageId}`;
    await pool.query(
      `INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id, message_type,
        text, sent_at, raw_event_idempotency_key, created_at
      ) VALUES ($1, 'feishu', $2, $3, 'ou_author', 'text', 'approval evidence', $4, $5, $4)`,
      [messageId, providerMessageId, groupId, at, `event-${label}-${suffix}`],
    );
    const draftRepository = createPostgresKnowledgeDraftRepository({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
    });
    const draft = (await draftRepository.createDraft({
      id: `draft-${label}-${suffix}`,
      operationKey: `draft:${label}:${suffix}`,
      originKind: "user_requested",
      createdBy: "acceptance",
      revision: {
        sourceGroupId: groupId,
        title: `Title ${label}`,
        content: `Content ${label}`,
        riskLevel,
        ...(reviewerOpenId === undefined
          ? {}
          : { reviewer: { type: "feishu_user" as const, ref: reviewerOpenId } }),
        suggestedPublication: { spaceId: `space-${label}-${suffix}` },
        evidence: [{ type: "conversation_message", id: messageId, groupId }],
      },
      at,
    })).draft;
    const cardRepository = createPostgresKnowledgeCardRepository({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
    });
    const presentationId = `presentation-${label}-${suffix}`;
    await cardRepository.createPresentation({
      id: presentationId,
      draftId: draft.id,
      expectedDraftVersion: 1,
      expectedRevisionNumber: 1,
      chatId: groupId,
      contentHash: "a".repeat(64),
      operationKey: `presentation:${label}:${suffix}`,
      at,
    });
    const workerId = `worker-${label}`;
    await cardRepository.claimPresentationSend({ workerId, leaseUntil: plusSeconds(30), at });
    await cardRepository.beginExternalAttempt({ presentationId, workerId, at });
    await cardRepository.completePresentationSend({
      presentationId,
      workerId,
      messageId: `om-card-${label}-${suffix}`,
      at,
    });
    const interaction = await cardRepository.applyInteraction({
      presentationId,
      draftId: draft.id,
      revisionNumber: 1,
      draftVersion: 1,
      chatId: groupId,
      eventId: `callback-${label}-${suffix}`,
      actorOpenId: `ou_member_${suffix}`,
      membershipCheckedAt: at,
      at,
      action: "confirm",
    });
    const updateClaim = await cardRepository.claimPresentationSend({
      workerId,
      leaseUntil: plusSeconds(30),
      at,
    });
    expect(updateClaim?.presentation.id).toBe(presentationId);
    await cardRepository.beginExternalAttempt({ presentationId, workerId, at });
    await cardRepository.completePresentationSend({
      presentationId,
      workerId,
      messageId: `om-card-${label}-${suffix}`,
      at,
    });
    return interaction.draft;
  }

  async function createCompanyDraft(
    label: string,
    riskLevel: "low" | "medium" | "high",
    reviewerOpenId?: string,
  ) {
    const documentSourceId = `company-source-${label}-${suffix}`;
    await pool.query(
      `INSERT INTO document_sources (
        id, source_type, source_uri, title, origin_group_id, origin_message_id,
        permission_state, sync_state, can_use_for_answering,
        can_use_for_knowledge_drafts, created_at, updated_at
      ) VALUES ($1, 'authorized_wiki_document', $2, 'Company source', NULL, NULL,
        'readable', 'synced', TRUE, TRUE, $3, $3)`,
      [documentSourceId, `https://example.com/wiki/${documentSourceId}`, at],
    );
    const draftRepository = createPostgresKnowledgeDraftRepository({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
    });
    return (await draftRepository.createDraft({
      id: `draft-${label}-${suffix}`,
      operationKey: `draft:${label}:${suffix}`,
      originKind: "user_requested",
      createdBy: "acceptance",
      revision: {
        title: `Title ${label}`,
        content: `Content ${label}`,
        riskLevel,
        ...(reviewerOpenId === undefined
          ? {}
          : { reviewer: { type: "feishu_user" as const, ref: reviewerOpenId } }),
        suggestedPublication: { spaceId: `space-${label}-${suffix}` },
        evidence: [{
          type: "document_source" as const,
          id: documentSourceId,
          expectedUpdatedAt: at,
        }],
      },
      at,
    })).draft;
  }

  async function createActiveActionPresentation(input: {
    proposalId: string;
    proposalVersion: number;
    requirementId: string;
    recipientOpenId: string;
    label: string;
  }) {
    const id = `action-presentation-${input.label}-${suffix}`;
    await pool.query(
      `INSERT INTO action_approval_presentations (
        id, proposal_id, requirement_id, proposal_version, recipient_open_id,
        state, message_id, operation_key, operation_fingerprint,
        version, created_at, activated_at
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, 1, $9, $9)`,
      [
        id,
        input.proposalId,
        input.requirementId,
        input.proposalVersion,
        input.recipientOpenId,
        `om-action-${input.label}-${suffix}`,
        `action-presentation:${input.label}:${suffix}`,
        "b".repeat(64),
        at,
      ],
    );
    return id;
  }

  async function createPendingOwnerApprovalCase(label: string) {
    const ownerOpenId = `ou_${label}_${suffix}`;
    const policy = await createEnabledPolicy(label, ["medium"]);
    const draft = await createConfirmedDraft(label, "medium", ownerOpenId);
    const repository = actionRepository();
    const proposal = (await repository.createProposal({
      proposalId: `${label}-${suffix}`,
      draftId: draft.id,
      expectedRevision: 1,
      expectedDraftVersion: 2,
      targetPolicyId: policy.id,
      expectedTargetPolicyVersion: policy.version,
      operationKey: `proposal:${label}:${suffix}`,
      at,
    })).proposal;
    const requirement = (await repository.getProposal(proposal.id))?.requirements.find(
      (item) => item.kind === "designated_owner",
    );
    expect(requirement).toBeDefined();
    const presentationId = await createActiveActionPresentation({
      proposalId: proposal.id,
      proposalVersion: proposal.version,
      requirementId: requirement!.id,
      recipientOpenId: ownerOpenId,
      label,
    });
    return {
      ownerOpenId,
      proposal,
      requirement: requirement!,
      presentationId,
      repository,
    };
  }
});

function draftCandidateRow(
  id: string,
  updateTargetId: string | null,
  eligibleUpdateTargetId: string | null,
  hasAnyUpdateTarget = updateTargetId !== null,
) {
  return {
    id,
    source_group_id: null,
    status: "pending_review",
    current_revision_number: 1,
    version: 2,
    title: "not returned",
    content: "not returned",
    risk_level: "low",
    reviewer_type: "feishu_user",
    reviewer_ref: "ou-owner",
    suggested_space_id: "space-main",
    suggested_parent_node_token: null,
    has_current_group_confirmation: true,
    has_any_update_target: hasAnyUpdateTarget,
    update_target_id: updateTargetId,
    eligible_update_target_id: eligibleUpdateTargetId,
    updated_at: at,
  };
}

function proposalCreationInput(
  actionType: "publish_knowledge_draft" | "update_knowledge_publication",
  operationKey: string,
) {
  return {
    proposalId: `proposal-${operationKey}`,
    actionType,
    draftId: "draft-1",
    expectedRevision: 1,
    expectedDraftVersion: 2,
    targetPolicyId: "policy-1",
    expectedTargetPolicyVersion: 3,
    operationKey,
    at,
  };
}

function proposalCreationDataSource(input: {
  hasManagedTarget: boolean;
  targetCurrent?: boolean;
  targetRevision?: number;
  draftRevision?: number;
  draftVersion?: number;
}) {
  let proposalRow: Record<string, unknown> | undefined;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql) || sql.includes("pg_advisory_xact_lock")) {
      return { rows: [] };
    }
    if (sql.includes("FROM action_proposals") && sql.includes("WHERE operation_key = $1")) {
      return {
        rows: proposalRow?.operation_key === params[0] ? [proposalRow] : [],
      };
    }
    if (sql.includes("FROM knowledge_drafts draft") && sql.includes("FOR UPDATE OF draft")) {
      return { rows: [{
        id: "draft-1",
        source_group_id: "group-1",
        status: "pending_review",
        current_revision_number: input.draftRevision ?? 1,
        version: input.draftVersion ?? 2,
        title: "Proposal title",
        content: "Proposal body",
        risk_level: "low",
        reviewer_type: input.hasManagedTarget ? "feishu_user" : null,
        reviewer_ref: input.hasManagedTarget ? "ou-reviewer" : null,
        suggested_space_id: "space-main",
        suggested_parent_node_token: null,
      }] };
    }
    if (sql.includes("FROM knowledge_draft_revision_evidence")) return { rows: [] };
    if (sql.includes("FROM knowledge_publication_target_policies") && sql.includes("FOR UPDATE")) {
      return { rows: [{
        id: "policy-1",
        space_id: "space-main",
        parent_node_token: null,
        display_name: "Main wiki",
        allowed_group_ids: ["group-1"],
        allowed_risk_levels: ["low"],
        enabled: true,
        version: 3,
        created_at: at,
        updated_at: at,
      }] };
    }
    if (sql.includes("FROM knowledge_draft_group_confirmations")) {
      return { rows: [{ actor_open_id: "ou-member", presentation_id: "presentation-1" }] };
    }
    if (sql.includes("FROM knowledge_publication_update_targets") &&
      sql.includes("WHERE draft_id = $1")) {
      return { rows: input.hasManagedTarget ? [{
        id: "target-1",
        draft_revision: input.targetRevision ?? 1,
        conflict_candidate_id: "candidate-1",
        conflict_candidate_version: 3,
        managed_page_id: "managed-1",
        managed_page_version: 4,
        linked_document_source_id: "source-1",
        target_snapshot_id: "snapshot-1",
        target_snapshot_hash: "a".repeat(64),
        target_source_version: "v7",
        remote_document_token: "doc-managed-1",
        managed_body_block_id: "block-managed-1",
        expected_remote_revision_id: "12",
        current_body_content_hash: "b".repeat(64),
        proposed_body_content_hash: "c".repeat(64),
        authorization_group_id: "group-1",
        target_policy_id: "policy-1",
        target_policy_version: 3,
      }] : [] };
    }
    if (sql.includes("FROM knowledge_publication_update_targets target") &&
      sql.includes("WHERE target.id = $1")) {
      return { rows: input.targetCurrent === false ? [] : [{ id: "target-1" }] };
    }
    if (sql.includes("INSERT INTO action_proposals")) {
      const parameterizedAction = !sql.includes("'publish_knowledge_draft'");
      const offset = parameterizedAction ? 1 : 0;
      const actionType = parameterizedAction ? String(params[1]) : "publish_knowledge_draft";
      proposalRow = {
        id: params[0],
        action_type: actionType,
        subject_type: "knowledge_draft",
        subject_id: params[1 + offset],
        subject_revision: params[2 + offset],
        subject_version: params[3 + offset],
        target_policy_id: params[4 + offset],
        target_policy_version: params[5 + offset],
        risk_level: params[6 + offset],
        status: params[7 + offset],
        operation_key: params[8 + offset],
        operation_fingerprint: params[9 + offset],
        version: 1,
        created_at: params[10 + offset],
        updated_at: params[10 + offset],
      };
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO action_approval_presentation_outbox") ||
      sql.includes("INSERT INTO action_approval_presentation_events") ||
      sql.includes("INSERT INTO action_approval_presentations") ||
      sql.includes("INSERT INTO action_approval_requirements") ||
      sql.includes("INSERT INTO action_events")) return { rows: [] };
    if (sql.includes("FROM action_proposals") && sql.includes("WHERE id = $1")) {
      return { rows: proposalRow === undefined ? [] : [proposalRow] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const client = { query, release() {} };
  return {
    dataSource: {
      query,
      async connect() { return client; },
    } as unknown as PostgresKnowledgeDraftDataSource,
    setStoredFingerprint(value: string) {
      if (proposalRow === undefined) throw new Error("proposal was not created");
      proposalRow.operation_fingerprint = value;
    },
  };
}

function publicationClaimReplayDataSource(input: { requestFingerprint?: string } = {}) {
  const publishProposal = {
    id: "proposal-publish",
    action_type: "publish_knowledge_draft",
    subject_type: "knowledge_draft",
    subject_id: "draft-publish",
    subject_revision: 1,
    subject_version: 3,
    target_policy_id: "policy-1",
    target_policy_version: 2,
    risk_level: "low",
    status: "executing",
    operation_key: "proposal-publish-operation",
    operation_fingerprint: "a".repeat(64),
    version: 3,
    created_at: at,
    updated_at: at,
  };
  const updateProposal = {
    ...publishProposal,
    id: "proposal-update",
    action_type: "update_knowledge_publication",
    subject_id: "draft-update",
    status: "approved",
    operation_key: "proposal-update-operation",
    version: 2,
  };
  const expectedFingerprint = createHash("sha256")
    .update(JSON.stringify({
      operation: "feishu_wiki_publish_request",
      proposalId: publishProposal.id,
      draftId: publishProposal.subject_id,
      revisionNumber: publishProposal.subject_revision,
      draftVersion: publishProposal.subject_version,
      targetPolicyId: publishProposal.target_policy_id,
      targetPolicyVersion: publishProposal.target_policy_version,
    }))
    .digest("hex");
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql) || sql.includes("pg_advisory_xact_lock")) {
      return { rows: [] };
    }
    if (sql.includes("JOIN action_execution_events event") && sql.includes("event.operation_key = $1")) {
      return { rows: [{
        id: "execution-existing",
        proposal_id: "proposal-publish",
        attempt_number: 1,
        state: "executing",
        request_fingerprint: input.requestFingerprint ?? expectedFingerprint,
        provider: "feishu_wiki",
        response_classification: null,
        remote_node_token: null,
        remote_document_token: null,
        version: 1,
        retry_at: null,
        created_at: at,
        updated_at: at,
      }] };
    }
    if (sql.includes("FROM action_proposals") && sql.includes("WHERE id = $1")) {
      return { rows: [params[0] === "proposal-update" ? updateProposal : publishProposal] };
    }
    if (sql.includes("FROM knowledge_drafts draft") && sql.includes("FOR UPDATE OF draft")) {
      return { rows: [{
        id: "draft-publish",
        source_group_id: "group-1",
        status: "pending_review",
        current_revision_number: 1,
        version: 3,
        title: "Published draft title",
        content: "Published draft body",
        risk_level: "low",
        reviewer_type: null,
        reviewer_ref: null,
        suggested_space_id: "space-1",
        suggested_parent_node_token: null,
      }] };
    }
    if (sql.includes("FROM knowledge_publication_target_policies") && sql.includes("WHERE id = $1")) {
      return { rows: [{
        id: "policy-1",
        space_id: "space-1",
        parent_node_token: null,
        display_name: "Main wiki",
        allowed_group_ids: ["group-1"],
        allowed_risk_levels: ["low"],
        enabled: true,
        version: 2,
        created_at: at,
        updated_at: at,
      }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const client = { query, release() {} };
  return {
    dataSource: {
      query,
      async connect() { return client; },
    } as unknown as PostgresKnowledgeDraftDataSource,
  };
}

function legacyActionProposalFingerprint(
  input: ReturnType<typeof proposalCreationInput>,
): string {
  const { actionType: _actionType, ...legacyInput } = input;
  return createHash("sha256")
    .update(JSON.stringify({
      operation: "create_proposal",
      ...legacyInput,
    }, (_key, value) => value instanceof Date ? value.toISOString() : value))
    .digest("hex");
}

function policyInput(
  label: string,
  overrides: Partial<{
    enabled: boolean;
    expectedVersion: number;
    operationKey: string;
    allowedRiskLevels: Array<"low" | "medium" | "high">;
    allowedGroupIds: string[];
  }> = {},
) {
  return {
    id: `policy-${label}-${suffix}`,
    spaceId: `space-${label}-${suffix}`,
    displayName: `Policy ${label}`,
    allowedGroupIds: overrides.allowedGroupIds ?? [groupId],
    allowedRiskLevels: overrides.allowedRiskLevels ?? ["low", "medium", "high"],
    enabled: overrides.enabled ?? false,
    expectedVersion: overrides.expectedVersion ?? 0,
    operationKey: overrides.operationKey ?? `policy:${label}:${suffix}`,
    operator: "acceptance",
    at,
  };
}

function plusSeconds(seconds: number): Date {
  return new Date(at.getTime() + seconds * 1_000);
}
