import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";
import type { FormalTaskDraftView, FeishuTaskTargetPolicy } from
  "../src/formal-tasks/formal-task-repository.js";
import {
  FormalTaskCardMembershipProofError,
  FormalTaskCardOperationConflictError,
  FormalTaskCardPersistenceConflictError,
  createPostgresFormalTaskCardRepository,
} from "../src/formal-tasks/postgres-formal-task-card-repository.js";
import {
  FormalTaskPolicyConflictError,
  createPostgresFormalTaskRepository,
} from "../src/formal-tasks/postgres-formal-task-repository.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;
const at = new Date("2026-08-22T06:00:00.000Z");

runIfDatabase("PostgresFormalTaskCardRepository with Postgres", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await runMigrations({
      client: pool as unknown as MigrationClient,
      migrationsDir: defaultMigrationsDir(),
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates, replays, claims, and activates one durable task confirmation card", async () => {
    const seeded = await seedDraft(pool, "delivery");
    const repository = createPostgresFormalTaskCardRepository({ dataSource: pool });
    const input = presentationInput(seeded, "delivery");

    await expect(repository.createPresentation(input)).resolves.toMatchObject({
      outcome: "applied",
      presentation: {
        id: input.id,
        draftId: seeded.draft.id,
        state: "pending_send",
        version: 1,
      },
    });
    await expect(repository.createPresentation(input)).resolves.toMatchObject({
      outcome: "already_applied",
      presentation: { id: input.id, version: 1 },
    });
    await expect(repository.createPresentation({
      ...input,
      taskSpecHash: "f".repeat(64),
    })).rejects.toBeInstanceOf(FormalTaskCardOperationConflictError);

    const claim = await repository.claimPresentationSend({
      workerId: "task-card-worker",
      leaseUntil: new Date(at.getTime() + 30_000),
      at,
    });
    expect(claim).toMatchObject({
      presentation: { id: input.id, state: "pending_send" },
      workerId: "task-card-worker",
      attempts: 1,
    });
    await repository.beginExternalAttempt({
      presentationId: input.id,
      workerId: "task-card-worker",
      at: new Date(at.getTime() + 1_000),
    });
    await repository.completePresentationSend({
      presentationId: input.id,
      workerId: "task-card-worker",
      messageId: "om_task_card",
      at: new Date(at.getTime() + 2_000),
    });

    await expect(repository.getPresentation(input.id)).resolves.toMatchObject({
      state: "active",
      messageId: "om_task_card",
      version: 2,
    });
    expect((await repository.getOutboxStatusCounts()).sent).toBeGreaterThanOrEqual(1);
  });

  it("terminalizes an expired external attempt as outcome unknown without retrying the remote send", async () => {
    const seeded = await seedDraft(pool, "expired-attempt");
    const repository = createPostgresFormalTaskCardRepository({ dataSource: pool });
    const input = presentationInput(seeded, "expired-attempt");
    await repository.createPresentation(input);
    const leaseUntil = new Date(at.getTime() + 30_000);
    const claim = await repository.claimPresentationSend({
      workerId: "expired-task-card-worker",
      leaseUntil,
      at,
    });
    expect(claim?.presentation.id).toBe(input.id);
    await repository.beginExternalAttempt({
      presentationId: input.id,
      workerId: "expired-task-card-worker",
      at,
    });

    await expect(repository.claimPresentationSend({
      workerId: "replacement-task-card-worker",
      leaseUntil: new Date(at.getTime() + 61_000),
      at: new Date(at.getTime() + 31_000),
    })).resolves.toBeUndefined();
    await expect(repository.getPresentation(input.id)).resolves.toMatchObject({
      state: "send_failed",
    });
    await expect(pool.query(
      `SELECT state, error_code FROM formal_task_draft_presentation_outbox
       WHERE presentation_id = $1`,
      [input.id],
    )).resolves.toMatchObject({
      rows: [{ state: "outcome_unknown", error_code: "external_attempt_lease_expired" }],
    });
  });

  it("terminalizes an exhausted retry budget instead of leaving an invisible retryable row", async () => {
    const seeded = await seedDraft(pool, "attempts-exhausted");
    const repository = createPostgresFormalTaskCardRepository({ dataSource: pool });
    const input = presentationInput(seeded, "attempts-exhausted");
    await repository.createPresentation(input);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const attemptAt = new Date(at.getTime() + attempt * 1_000);
      const workerId = `exhausted-task-card-worker-${attempt}`;
      const claim = await repository.claimPresentationSend({
        workerId,
        leaseUntil: new Date(attemptAt.getTime() + 30_000),
        at: attemptAt,
      });
      expect(claim?.presentation.id).toBe(input.id);
      await repository.beginExternalAttempt({ presentationId: input.id, workerId, at: attemptAt });
      await repository.failPresentationSend({
        presentationId: input.id,
        workerId,
        classification: "retryable",
        errorCode: "remote_unavailable",
        retryAt: attemptAt,
        at: attemptAt,
      });
    }

    await expect(repository.claimPresentationSend({
      workerId: "sixth-task-card-worker",
      leaseUntil: new Date(at.getTime() + 40_000),
      at: new Date(at.getTime() + 10_000),
    })).resolves.toBeUndefined();
    await expect(repository.getPresentation(input.id)).resolves.toMatchObject({ state: "send_failed" });
    await expect(pool.query(
      `SELECT state, error_code FROM formal_task_draft_presentation_outbox
       WHERE presentation_id = $1`,
      [input.id],
    )).resolves.toMatchObject({
      rows: [{ state: "failed", error_code: "max_attempts_exhausted" }],
    });
  });

  it("atomically confirms an active exact card and replays the callback", async () => {
    const seeded = await seedDraft(pool, "confirm");
    const repository = createPostgresFormalTaskCardRepository({ dataSource: pool });
    const input = presentationInput(seeded, "confirm");
    await activatePresentation(repository, input);
    const interaction = interactionInput(seeded, input.id, {
      eventId: `task-card-confirm:${randomUUID()}`,
      action: "confirm" as const,
    });

    await expect(repository.applyInteraction(interaction)).resolves.toMatchObject({
      outcome: "applied",
      presentation: { state: "closed", version: 3 },
      draft: { status: "pending_review", version: 2 },
      committedResult: {
        action: "confirm",
        actorOpenId: "ou_member",
        nextGate: "pending_review",
      },
    });
    await expect(repository.applyInteraction(interaction)).resolves.toMatchObject({
      outcome: "already_applied",
      presentation: { state: "closed", version: 3 },
      draft: { status: "pending_review", version: 2 },
    });
    const events = await seeded.taskRepository.listEvents(seeded.draft.id);
    expect(events).toContainEqual(expect.objectContaining({
      eventType: "group_confirmed",
      actor: "ou_member",
      fromVersion: 1,
      toVersion: 2,
    }));
    await expect(repository.getPresentationContext(input.id)).resolves.toMatchObject({
      committedResult: { action: "confirm", actorOpenId: "ou_member" },
    });

    const updateWorkerId = `task-card-update-worker-${randomUUID()}`;
    const updateClaim = await repository.claimPresentationSend({
      workerId: updateWorkerId,
      leaseUntil: new Date(at.getTime() + 30_000),
      at,
    });
    expect(updateClaim).toMatchObject({
      presentation: { id: input.id, state: "closed", version: 3 },
      attempts: 1,
    });
    await repository.beginExternalAttempt({
      presentationId: input.id,
      workerId: updateWorkerId,
      at,
    });
    await repository.completePresentationSend({
      presentationId: input.id,
      workerId: updateWorkerId,
      messageId: updateClaim!.presentation.messageId!,
      at,
    });
    await expect(repository.getPresentation(input.id)).resolves.toMatchObject({
      state: "closed",
      version: 4,
    });
  });

  it.each([
    ["request_revision", "needs_revision", "Clarify the due time."],
    ["reject", "rejected", "The task is no longer required."],
  ] as const)("atomically applies %s with its immutable reason", async (action, status, reason) => {
    const seeded = await seedDraft(pool, action);
    const repository = createPostgresFormalTaskCardRepository({ dataSource: pool });
    const input = presentationInput(seeded, action);
    await activatePresentation(repository, input);

    const eventId = `task-card-${action}:${randomUUID()}`;
    const result = action === "reject"
      ? await repository.applyInteraction({
          ...interactionInput(seeded, input.id, { eventId, action: "reject" }),
          reason,
          rejectionConfirmed: true,
        })
      : await repository.applyInteraction({
          ...interactionInput(seeded, input.id, { eventId, action: "request_revision" }),
          reason,
        });

    expect(result).toMatchObject({
      outcome: "applied",
      presentation: { state: "closed" },
      draft: { status },
      committedResult: { action, state: status, reason },
    });
    await completeCommittedCardUpdate(repository, input.id);
  });

  it("fails closed for stale membership, stale versions, changed policy, and invalidated evidence", async () => {
    const staleMembership = await seedDraft(pool, "stale-membership");
    const repository = createPostgresFormalTaskCardRepository({ dataSource: pool });
    const membershipPresentation = presentationInput(staleMembership, "stale-membership");
    await activatePresentation(repository, membershipPresentation);
    await expect(repository.applyInteraction({
      ...interactionInput(staleMembership, membershipPresentation.id, {
        eventId: `stale-membership:${randomUUID()}`,
        action: "confirm" as const,
      }),
      membershipCheckedAt: new Date(at.getTime() - 30_001),
    })).rejects.toBeInstanceOf(FormalTaskCardMembershipProofError);

    const staleVersion = await seedDraft(pool, "stale-version");
    const versionPresentation = presentationInput(staleVersion, "stale-version");
    await activatePresentation(repository, versionPresentation);
    await expect(repository.applyInteraction({
      ...interactionInput(staleVersion, versionPresentation.id, {
        eventId: `stale-version:${randomUUID()}`,
        action: "confirm" as const,
      }),
      draftVersion: 2,
    })).rejects.toBeInstanceOf(FormalTaskCardPersistenceConflictError);

    const changedPolicy = await seedDraft(pool, "changed-policy");
    const policyPresentation = presentationInput(changedPolicy, "changed-policy");
    await activatePresentation(repository, policyPresentation);
    await changedPolicy.taskRepository.upsertTargetPolicy({
      id: changedPolicy.policy.id,
      sourceGroupId: changedPolicy.policy.sourceGroupId,
      displayName: changedPolicy.policy.displayName,
      allowedAssigneeOpenIds: changedPolicy.policy.allowedAssigneeOpenIds,
      maxDueHorizonDays: changedPolicy.policy.maxDueHorizonDays,
      enabled: false,
      expectedVersion: changedPolicy.policy.version,
      operationKey: `disable-policy:${randomUUID()}`,
      operator: "operator",
      at,
    });
    await expect(repository.applyInteraction(interactionInput(changedPolicy, policyPresentation.id, {
      eventId: `changed-policy:${randomUUID()}`,
      action: "confirm" as const,
    }))).rejects.toBeInstanceOf(FormalTaskPolicyConflictError);

    const invalidEvidence = await seedDraft(pool, "invalid-evidence");
    const evidencePresentation = presentationInput(invalidEvidence, "invalid-evidence");
    await activatePresentation(repository, evidencePresentation);
    await pool.query(
      `INSERT INTO conversation_message_deletion_tombstones (
         provider, provider_message_id, conversation_message_id, chat_id, deleted_at
       ) VALUES ('feishu', $1, $2, $3, $4)`,
      [
        invalidEvidence.providerMessageId,
        `feishu:${invalidEvidence.providerMessageId}`,
        invalidEvidence.groupId,
        at,
      ],
    );
    await expect(repository.applyInteraction(interactionInput(invalidEvidence, evidencePresentation.id, {
      eventId: `invalid-evidence:${randomUUID()}`,
      action: "confirm" as const,
    }))).rejects.toThrow("formal task evidence is not current");
  });
});

type SeededDraft = {
  groupId: string;
  providerMessageId: string;
  policy: FeishuTaskTargetPolicy;
  draft: FormalTaskDraftView;
  taskRepository: ReturnType<typeof createPostgresFormalTaskRepository>;
};

async function seedDraft(pool: pg.Pool, label: string): Promise<SeededDraft> {
  const id = randomUUID();
  const groupId = `task-card-group-${label}-${id}`;
  const providerMessageId = `om-task-card-${label}-${id}`;
  const messageId = `feishu:${providerMessageId}`;
  await pool.query(
    `INSERT INTO conversation_messages (
       id, provider, provider_message_id, chat_id, sender_id, message_type,
       text, sent_at, raw_event_idempotency_key, created_at
     ) VALUES ($1, 'feishu', $2, $3, 'ou_member', 'text', 'task evidence', $4, $5, $4)`,
    [messageId, providerMessageId, groupId, at, `event-${id}`],
  );
  const taskRepository = createPostgresFormalTaskRepository({ dataSource: pool });
  const policy = (await taskRepository.upsertTargetPolicy({
    id: `task-card-policy-${label}-${id}`,
    sourceGroupId: groupId,
    displayName: "Pilot task policy",
    allowedAssigneeOpenIds: ["ou_assignee"],
    maxDueHorizonDays: 30,
    enabled: true,
    expectedVersion: 0,
    operationKey: `create-policy:${id}`,
    operator: "operator",
    at,
  })).policy;
  const draft = (await taskRepository.createDraft({
    id: `task-card-draft-${label}-${id}`,
    operationKey: `create-draft:${id}`,
    createdBy: "iris",
    revision: {
      taskSpec: {
        title: "Prepare acceptance report",
        description: "Collect the governed pilot evidence.",
        assigneeOpenId: "ou_assignee",
        dueAtUtc: "2026-08-24T09:30:00.000Z",
        reminderMinutes: 30,
        sourceGroupId: groupId,
        targetPolicyId: policy.id,
        targetPolicyVersion: policy.version,
      },
      riskLevel: "high",
      author: "iris",
      evidence: [{ type: "conversation_message", id: messageId }],
    },
    at,
  })).draft;
  return { groupId, providerMessageId, policy, draft, taskRepository };
}

function presentationInput(seeded: SeededDraft, label: string) {
  return {
    id: `task-card-presentation-${label}-${randomUUID()}`,
    draftId: seeded.draft.id,
    expectedDraftVersion: seeded.draft.version,
    expectedDraftRevision: seeded.draft.currentRevisionNumber,
    taskSpecHash: seeded.draft.currentTaskSpecHash,
    groupId: seeded.groupId,
    operationKey: `create-presentation:${label}:${randomUUID()}`,
    at,
  };
}

async function activatePresentation(
  repository: ReturnType<typeof createPostgresFormalTaskCardRepository>,
  input: ReturnType<typeof presentationInput>,
): Promise<void> {
  await repository.createPresentation(input);
  const workerId = `task-card-worker-${randomUUID()}`;
  const claim = await repository.claimPresentationSend({
    workerId,
    leaseUntil: new Date(at.getTime() + 30_000),
    at,
  });
  expect(claim?.presentation.id).toBe(input.id);
  await repository.beginExternalAttempt({ presentationId: input.id, workerId, at });
  await repository.completePresentationSend({
    presentationId: input.id,
    workerId,
    messageId: `om-card-${randomUUID()}`,
    at,
  });
}

async function completeCommittedCardUpdate(
  repository: ReturnType<typeof createPostgresFormalTaskCardRepository>,
  expectedPresentationId: string,
): Promise<void> {
  const workerId = `task-card-result-worker-${randomUUID()}`;
  const claim = await repository.claimPresentationSend({
    workerId,
    leaseUntil: new Date(at.getTime() + 30_000),
    at,
  });
  expect(claim?.presentation.id).toBe(expectedPresentationId);
  expect(claim?.presentation.state).toBe("closed");
  await repository.beginExternalAttempt({ presentationId: expectedPresentationId, workerId, at });
  await repository.completePresentationSend({
    presentationId: expectedPresentationId,
    workerId,
    messageId: claim!.presentation.messageId!,
    at,
  });
}

function interactionInput<Action extends "confirm" | "request_revision" | "reject">(
  seeded: SeededDraft,
  presentationId: string,
  input: { eventId: string; action: Action },
) {
  return {
    presentationId,
    draftId: seeded.draft.id,
    draftRevision: seeded.draft.currentRevisionNumber,
    draftVersion: seeded.draft.version,
    taskSpecHash: seeded.draft.currentTaskSpecHash,
    targetPolicyId: seeded.policy.id,
    targetPolicyVersion: seeded.policy.version,
    groupId: seeded.groupId,
    eventId: input.eventId,
    actorOpenId: "ou_member",
    membershipCheckedAt: at,
    at,
    action: input.action,
  };
}
