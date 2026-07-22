import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
      sourcePresentationId: presentationId,
      callbackEventId: `callback-action-${label}-${suffix}`,
      actorOpenId: ownerOpenId,
      action: "approve" as const,
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
      sourcePresentationId: presentationId,
      callbackEventId: `callback-action-${label}-${suffix}`,
      actorOpenId: ownerOpenId,
      action: "approve" as const,
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
      sourcePresentationId: acceptance.presentationId,
      callbackEventId: `callback-action-request-revision-${suffix}`,
      actorOpenId: acceptance.ownerOpenId,
      action: "request_revision" as const,
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

  it("requires explicit rejection confirmation and rejects without an approval fact", async () => {
    const acceptance = await createPendingOwnerApprovalCase("proposal-reject");
    const input = {
      proposalId: acceptance.proposal.id,
      requirementId: acceptance.requirement.id,
      expectedProposalVersion: acceptance.proposal.version,
      expectedSubjectRevision: acceptance.proposal.subjectRevision,
      expectedSubjectVersion: acceptance.proposal.subjectVersion,
      sourcePresentationId: acceptance.presentationId,
      callbackEventId: `callback-action-reject-${suffix}`,
      actorOpenId: acceptance.ownerOpenId,
      action: "reject" as const,
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
      sourcePresentationId: acceptance.presentationId,
      callbackEventId: `callback-action-concurrent-${suffix}`,
      actorOpenId: acceptance.ownerOpenId,
      action: "approve" as const,
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
      expect.objectContaining({
        id: `draft-proposal-company-${suffix}`,
        hasCurrentGroupConfirmation: false,
        evidenceState: { status: "current" },
      }),
    ]));
    expect(JSON.stringify(candidates)).not.toMatch(/Title |Content |approval evidence/iu);
    await expect(repository.listEligibleDrafts({
      groupIds: [`oc_not_allowed_${suffix}`],
      limit: 100,
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `draft-proposal-company-${suffix}` }),
    ]));
    expect((await repository.listEligibleDrafts({
      groupIds: [`oc_not_allowed_${suffix}`],
      limit: 100,
    })).some((candidate) => candidate.sourceGroupId !== undefined)).toBe(false);
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
