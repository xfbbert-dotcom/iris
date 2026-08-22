import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FormalTaskOperationConflictError,
  FormalTaskPolicyConflictError,
  FormalTaskTransitionError,
  FormalTaskVersionConflictError,
  createPostgresFormalTaskRepository,
} from "../src/formal-tasks/postgres-formal-task-repository.js";
import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;
const suffix = randomUUID();
const groupId = `formal-task-group-${suffix}`;
const policyOnlyGroupId = `formal-task-policy-group-${suffix}`;
const guardGroupId = `formal-task-guard-group-${suffix}`;
const revisionGroupId = `formal-task-revision-group-${suffix}`;
const transitionGroupId = `formal-task-transition-group-${suffix}`;
const dispositionGroupId = `formal-task-disposition-group-${suffix}`;
const otherGroupId = `formal-task-other-${suffix}`;
const sourceMessageId = `formal-task-message-${suffix}`;
const revisionMessageId = `formal-task-revision-message-${suffix}`;
const transitionMessageId = `formal-task-transition-message-${suffix}`;
const dispositionMessageId = `formal-task-disposition-message-${suffix}`;
const at = new Date("2026-08-22T06:00:00.000Z");

runIfDatabase("PostgresFormalTaskRepository with Postgres", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await runMigrations({
      client: pool as unknown as MigrationClient,
      migrationsDir: defaultMigrationsDir(),
    });
    await pool.query(
      `INSERT INTO conversation_messages (
         id, provider, provider_message_id, chat_id, sender_id, message_type,
         text, sent_at, raw_event_idempotency_key, created_at
       ) VALUES
         ($1, 'feishu', $2, $3, 'ou_requester', 'text', 'task evidence', $4, $5, $4),
         ($6, 'feishu', $7, $8, 'ou_requester', 'text', 'revision evidence', $4, $9, $4),
         ($10, 'feishu', $11, $12, 'ou_requester', 'text', 'transition evidence', $4, $13, $4),
         ($14, 'feishu', $15, $16, 'ou_requester', 'text', 'disposition evidence', $4, $17, $4)`,
      [
        sourceMessageId,
        `om-formal-task-${suffix}`,
        groupId,
        at,
        `formal-task-event-${suffix}`,
        revisionMessageId,
        `om-formal-task-revision-${suffix}`,
        revisionGroupId,
        `formal-task-revision-event-${suffix}`,
        transitionMessageId,
        `om-formal-task-transition-${suffix}`,
        transitionGroupId,
        `formal-task-transition-event-${suffix}`,
        dispositionMessageId,
        `om-formal-task-disposition-${suffix}`,
        dispositionGroupId,
        `formal-task-disposition-event-${suffix}`,
      ],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("versions a group task policy with exact replay semantics", async () => {
    const repository = createPostgresFormalTaskRepository({ dataSource: pool });
    const create = policyInput("policy", {
      sourceGroupId: policyOnlyGroupId,
      expectedVersion: 0,
      enabled: false,
    });

    await expect(repository.upsertTargetPolicy(create)).resolves.toMatchObject({
      outcome: "applied",
      policy: {
        id: create.id,
        sourceGroupId: policyOnlyGroupId,
        allowedAssigneeOpenIds: ["ou_assignee", "ou_backup"],
        maxDueHorizonDays: 30,
        enabled: false,
        version: 1,
      },
    });
    await expect(repository.upsertTargetPolicy(create)).resolves.toMatchObject({
      outcome: "already_applied",
      policy: { version: 1 },
    });
    await expect(repository.upsertTargetPolicy({
      ...create,
      displayName: "changed replay",
    })).rejects.toBeInstanceOf(FormalTaskOperationConflictError);

    const update = policyInput("policy", {
      sourceGroupId: policyOnlyGroupId,
      expectedVersion: 1,
      operationKey: `formal-task-policy:${suffix}:enable`,
      enabled: true,
    });
    await expect(repository.upsertTargetPolicy(update)).resolves.toMatchObject({
      outcome: "applied",
      policy: { enabled: true, version: 2 },
    });
    await expect(repository.getTargetPolicyForGroup(policyOnlyGroupId)).resolves.toMatchObject({
      id: create.id,
      version: 2,
    });
    await expect(repository.upsertTargetPolicy({
      ...update,
      expectedVersion: 1,
      operationKey: `formal-task-policy:${suffix}:stale`,
    })).rejects.toBeInstanceOf(FormalTaskVersionConflictError);
  });

  it("creates one exact versioned draft with current same-group evidence", async () => {
    const repository = createPostgresFormalTaskRepository({ dataSource: pool });
    const policy = (await repository.upsertTargetPolicy(policyInput("draft", {
      expectedVersion: 0,
      enabled: true,
    }))).policy;
    const input = draftInput(policy.id, policy.version);

    await expect(repository.createDraft(input)).resolves.toMatchObject({
      outcome: "applied",
      draft: {
        id: input.id,
        sourceGroupId: groupId,
        status: "pending_confirmation",
        currentRevisionNumber: 1,
        version: 1,
        createdBy: "ou_requester",
        currentRevision: {
          riskLevel: "medium",
          taskSpec: {
            title: "Confirm pilot evidence",
            description: "Review and publish the acceptance result.",
            assigneeOpenId: "ou_assignee",
            dueAtUtc: "2026-08-24T06:00:00.000Z",
            reminderMinutes: 30,
            sourceGroupId: groupId,
            targetPolicyId: policy.id,
            targetPolicyVersion: policy.version,
          },
          evidenceState: { status: "current" },
          evidence: [{ type: "conversation_message", id: sourceMessageId }],
        },
      },
    });
    await expect(repository.createDraft(input)).resolves.toMatchObject({
      outcome: "already_applied",
      draft: { id: input.id, version: 1 },
    });
    await expect(repository.createDraft({
      ...input,
      revision: {
        ...input.revision,
        taskSpec: { ...input.revision.taskSpec, title: "Changed replay" },
      },
    })).rejects.toBeInstanceOf(FormalTaskOperationConflictError);

    await expect(repository.getDraft(input.id)).resolves.toMatchObject({ id: input.id });
    await expect(repository.listDrafts({ sourceGroupId: groupId, limit: 10 }))
      .resolves.toEqual([expect.objectContaining({ id: input.id })]);
    const events = await repository.listEvents(input.id);
    expect(events).toMatchObject([
      { eventType: "created", toVersion: 1, revisionNumber: 1 },
    ]);
    expect(events[0]).not.toHaveProperty("fromVersion");
    await expect(repository.getStatusCounts()).resolves.toMatchObject({
      pending_confirmation: expect.any(Number),
      pending_review: expect.any(Number),
      needs_revision: expect.any(Number),
      rejected: expect.any(Number),
      created: expect.any(Number),
    });
  });

  it("fails closed for a disabled, wrong-group, disallowed, stale, or out-of-horizon policy", async () => {
    const repository = createPostgresFormalTaskRepository({ dataSource: pool });
    const disabled = (await repository.upsertTargetPolicy(policyInput("disabled", {
      sourceGroupId: guardGroupId,
      expectedVersion: 0,
      enabled: false,
    }))).policy;
    await expect(repository.createDraft(
      draftInput(disabled.id, disabled.version, "disabled", guardGroupId),
    ))
      .rejects.toBeInstanceOf(FormalTaskPolicyConflictError);

    const enabled = (await repository.upsertTargetPolicy(policyInput("disabled", {
      sourceGroupId: guardGroupId,
      expectedVersion: 1,
      operationKey: `formal-task-policy:${suffix}:enable-guards`,
      enabled: true,
    }))).policy;
    await expect(repository.createDraft({
      ...draftInput(enabled.id, enabled.version, "wrong-group"),
      revision: {
        ...draftInput(enabled.id, enabled.version, "wrong-group").revision,
        taskSpec: {
          ...draftInput(enabled.id, enabled.version, "wrong-group").revision.taskSpec,
          sourceGroupId: otherGroupId,
        },
      },
    })).rejects.toBeInstanceOf(FormalTaskPolicyConflictError);
    await expect(repository.createDraft({
      ...draftInput(enabled.id, enabled.version, "disallowed", guardGroupId),
      revision: {
        ...draftInput(enabled.id, enabled.version, "disallowed", guardGroupId).revision,
        taskSpec: {
          ...draftInput(enabled.id, enabled.version, "disallowed", guardGroupId).revision.taskSpec,
          assigneeOpenId: "ou_not_allowed",
        },
      },
    })).rejects.toBeInstanceOf(FormalTaskPolicyConflictError);
    await expect(repository.createDraft(
      draftInput(enabled.id, enabled.version + 1, "stale", guardGroupId),
    ))
      .rejects.toBeInstanceOf(FormalTaskPolicyConflictError);
    await expect(repository.createDraft({
      ...draftInput(enabled.id, enabled.version, "horizon", guardGroupId),
      revision: {
        ...draftInput(enabled.id, enabled.version, "horizon", guardGroupId).revision,
        taskSpec: {
          ...draftInput(enabled.id, enabled.version, "horizon", guardGroupId).revision.taskSpec,
          dueAt: new Date("2026-10-22T06:00:00.000Z"),
        },
      },
    })).rejects.toBeInstanceOf(FormalTaskPolicyConflictError);
  });

  it("revises an eligible draft as a new immutable revision with exact replay", async () => {
    const repository = createPostgresFormalTaskRepository({ dataSource: pool });
    const policy = (await repository.upsertTargetPolicy(policyInput("revision", {
      sourceGroupId: revisionGroupId,
      expectedVersion: 0,
      enabled: true,
    }))).policy;
    const created = (await repository.createDraft(
      draftInput(policy.id, policy.version, "revision", revisionGroupId, revisionMessageId),
    )).draft;
    const revision = {
      id: created.id,
      expectedVersion: created.version,
      operationKey: `formal-task-revise:${suffix}`,
      actor: "ou_requester",
      revision: {
        taskSpec: {
          ...draftInput(
            policy.id,
            policy.version,
            "revision",
            revisionGroupId,
            revisionMessageId,
          ).revision.taskSpec,
          title: "Confirm revised pilot evidence",
        },
        riskLevel: "high" as const,
        author: "ou_requester",
        evidence: [{ type: "conversation_message" as const, id: revisionMessageId }],
      },
      at: new Date(at.getTime() + 1_000),
    };

    await expect(repository.reviseDraft(revision)).resolves.toMatchObject({
      outcome: "applied",
      draft: {
        status: "pending_confirmation",
        currentRevisionNumber: 2,
        version: 2,
        currentRevision: {
          riskLevel: "high",
          taskSpec: { title: "Confirm revised pilot evidence" },
        },
      },
    });
    await expect(repository.reviseDraft(revision)).resolves.toMatchObject({
      outcome: "already_applied",
      draft: { currentRevisionNumber: 2, version: 2 },
    });
    await expect(repository.reviseDraft({
      ...revision,
      operationKey: `${revision.operationKey}:stale`,
    })).rejects.toBeInstanceOf(FormalTaskVersionConflictError);
  });

  it("binds confirmation and remote creation to the exact current revision and hash", async () => {
    const repository = createPostgresFormalTaskRepository({ dataSource: pool });
    const policy = (await repository.upsertTargetPolicy(policyInput("transition", {
      sourceGroupId: transitionGroupId,
      expectedVersion: 0,
      enabled: true,
    }))).policy;
    const created = (await repository.createDraft(
      draftInput(
        policy.id,
        policy.version,
        "transition",
        transitionGroupId,
        transitionMessageId,
      ),
    )).draft;
    const confirmation = {
      id: created.id,
      expectedVersion: created.version,
      expectedRevision: created.currentRevisionNumber,
      expectedTaskSpecHash: created.currentTaskSpecHash,
      operationKey: `formal-task-confirm:${suffix}`,
      actor: "ou_group_member",
      at: new Date(at.getTime() + 1_000),
    };

    await expect(repository.confirmDraft({
      ...confirmation,
      expectedTaskSpecHash: "f".repeat(64),
      operationKey: `${confirmation.operationKey}:wrong-hash`,
    })).rejects.toBeInstanceOf(FormalTaskTransitionError);
    const confirmed = (await repository.confirmDraft(confirmation)).draft;
    expect(confirmed).toMatchObject({ status: "pending_review", version: 2 });
    await expect(repository.confirmDraft(confirmation)).resolves.toMatchObject({
      outcome: "already_applied",
      draft: { status: "pending_review", version: 2 },
    });

    const completed = await repository.markTaskCreated({
      id: confirmed.id,
      expectedVersion: confirmed.version,
      expectedRevision: confirmed.currentRevisionNumber,
      expectedTaskSpecHash: confirmed.currentTaskSpecHash,
      operationKey: `formal-task-created:${suffix}`,
      actor: "task-executor",
      at: new Date(at.getTime() + 2_000),
    });
    expect(completed.draft).toMatchObject({ status: "created", version: 3 });
    await expect(repository.requestRevision({
      id: completed.draft.id,
      expectedVersion: completed.draft.version,
      expectedRevision: completed.draft.currentRevisionNumber,
      expectedTaskSpecHash: completed.draft.currentTaskSpecHash,
      operationKey: `formal-task-late-revision:${suffix}`,
      actor: "ou_assignee",
      reason: "too late",
      at: new Date(at.getTime() + 3_000),
    })).rejects.toBeInstanceOf(FormalTaskTransitionError);
  });

  it("records revision requests and terminal rejection without mutating revision facts", async () => {
    const repository = createPostgresFormalTaskRepository({ dataSource: pool });
    const policy = (await repository.upsertTargetPolicy(policyInput("disposition", {
      sourceGroupId: dispositionGroupId,
      expectedVersion: 0,
      enabled: true,
    }))).policy;
    const created = (await repository.createDraft(
      draftInput(
        policy.id,
        policy.version,
        "disposition",
        dispositionGroupId,
        dispositionMessageId,
      ),
    )).draft;
    const requested = (await repository.requestRevision({
      id: created.id,
      expectedVersion: created.version,
      expectedRevision: created.currentRevisionNumber,
      expectedTaskSpecHash: created.currentTaskSpecHash,
      operationKey: `formal-task-request-revision:${suffix}`,
      actor: "ou_group_member",
      reason: "Clarify the due time",
      at: new Date(at.getTime() + 1_000),
    })).draft;
    expect(requested).toMatchObject({
      status: "needs_revision",
      version: 2,
      currentRevisionNumber: 1,
    });

    const rejected = (await repository.rejectDraft({
      id: requested.id,
      expectedVersion: requested.version,
      expectedRevision: requested.currentRevisionNumber,
      expectedTaskSpecHash: requested.currentTaskSpecHash,
      operationKey: `formal-task-reject:${suffix}`,
      actor: "ou_requester",
      reason: "No longer required",
      at: new Date(at.getTime() + 2_000),
    })).draft;
    expect(rejected).toMatchObject({
      status: "rejected",
      version: 3,
      currentRevisionNumber: 1,
      rejectedBy: "ou_requester",
      rejectionReason: "No longer required",
    });
  });

  function policyInput(label: string, overrides: Record<string, unknown> = {}) {
    return {
      id: `formal-task-policy-${label}-${suffix}`,
      sourceGroupId: groupId,
      displayName: "Pilot task target",
      allowedAssigneeOpenIds: ["ou_backup", "ou_assignee"],
      maxDueHorizonDays: 30,
      enabled: true,
      expectedVersion: 0,
      operationKey: `formal-task-policy:${label}:${suffix}`,
      operator: "iris-operator",
      at,
      ...overrides,
    };
  }

  function draftInput(
    policyId: string,
    policyVersion: number,
    label = "draft",
    sourceGroupId = groupId,
    evidenceMessageId = sourceMessageId,
  ) {
    return {
      id: `formal-task-draft-${label}-${suffix}`,
      operationKey: `formal-task-draft:${label}:${suffix}`,
      createdBy: "ou_requester",
      revision: {
        taskSpec: {
          title: "Confirm pilot evidence",
          description: "Review and publish the acceptance result.",
          assigneeOpenId: "ou_assignee",
          dueAt: new Date("2026-08-24T06:00:00.000Z"),
          reminderMinutes: 30 as const,
          sourceGroupId,
          targetPolicyId: policyId,
          targetPolicyVersion: policyVersion,
        },
        riskLevel: "medium" as const,
        author: "iris",
        evidence: [{ type: "conversation_message" as const, id: evidenceMessageId }],
      },
      at,
    };
  }
});
