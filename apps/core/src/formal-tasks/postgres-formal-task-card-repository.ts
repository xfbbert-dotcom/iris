import { createHash, randomUUID } from "node:crypto";

import type { KnowledgeCardPresentationState } from
  "../knowledge-cards/knowledge-card.js";

import type {
  ApplyFormalTaskCardInteractionInput,
  CreateFormalTaskCardPresentationInput,
  FormalTaskCardCommittedResult,
  FormalTaskCardInteractionResult,
  FormalTaskCardMutationResult,
  FormalTaskCardOutboxStatusCounts,
  FormalTaskCardPresentationContext,
  FormalTaskCardPresentationStatusCounts,
  FormalTaskCardRepository,
  FormalTaskDraftPresentation,
} from "./formal-task-card-repository.js";
import type { DisposeFormalTaskDraftInput, TransitionFormalTaskDraftInput } from
  "./formal-task-repository.js";
import {
  FormalTaskEvidenceError,
  FormalTaskOperationConflictError,
  FormalTaskPolicyConflictError,
  FormalTaskTransitionError,
  FormalTaskVersionConflictError,
  applyFormalTaskTransitionInTransaction,
  createPostgresFormalTaskRepository,
  type PostgresFormalTaskDataSource,
} from "./postgres-formal-task-repository.js";

const MAX_EXTERNAL_ATTEMPTS = 5;
const MEMBERSHIP_PROOF_MAX_AGE_MS = 30_000;

type PresentationRow = {
  id: string;
  draft_id: string;
  draft_revision: string | number;
  draft_version: string | number;
  task_spec_hash: string;
  group_id: string;
  state: KnowledgeCardPresentationState;
  message_id: string | null;
  operation_key: string;
  operation_fingerprint: string;
  version: string | number;
  created_at: Date;
  activated_at: Date | null;
  closed_at: Date | null;
};

type PresentationEventRow = {
  presentation_id: string;
  event_type: "confirmed" | "revision_requested" | "rejected";
  actor_open_id: string | null;
  callback_event_id: string | null;
  operation_key: string;
  created_at: Date;
};

type PresentationOutboxJoinRow = PresentationRow & {
  outbox_id: string;
  outbox_state: "pending" | "processing" | "external_attempting" | "sent" | "failed" |
    "outcome_unknown";
  idempotency_key: string;
  attempts: string | number;
  lease_until: Date | null;
};

type DraftEventRow = {
  event_type: "group_confirmed" | "revision_requested" | "rejected";
  actor: string;
  reason: string | null;
  created_at: Date;
};

type CountRow<State extends string> = { state: State; count: string | number };

type FormalTaskCardTransactionClient = Awaited<
  ReturnType<PostgresFormalTaskDataSource["connect"]>
>;

export class FormalTaskCardOperationConflictError extends Error {
  constructor() {
    super("formal task card operation conflicts with an existing operation");
    this.name = "FormalTaskCardOperationConflictError";
  }
}

export class FormalTaskCardPersistenceConflictError extends Error {
  constructor() {
    super("formal task card state or binding is stale");
    this.name = "FormalTaskCardPersistenceConflictError";
  }
}

export class FormalTaskCardMembershipProofError extends Error {
  constructor() {
    super("formal task card membership proof is stale");
    this.name = "FormalTaskCardMembershipProofError";
  }
}

export class FormalTaskCardPresentationNotFoundError extends Error {
  constructor() {
    super("formal task card presentation not found");
    this.name = "FormalTaskCardPresentationNotFoundError";
  }
}

export function createPostgresFormalTaskCardRepository({
  dataSource,
}: {
  dataSource: PostgresFormalTaskDataSource;
}): FormalTaskCardRepository {
  const taskRepository = createPostgresFormalTaskRepository({ dataSource });
  return {
    async createPresentation(input) {
      const normalized = normalizeCreatePresentation(input);
      const fingerprint = operationFingerprint({
        operation: "create_formal_task_card_presentation",
        ...normalized,
      });
      const stored = await withTransaction(dataSource, async (client) => {
        const replay = await client.query<PresentationRow>(
          `${presentationSelect()} WHERE operation_key = $1 FOR UPDATE`,
          [normalized.operationKey],
        );
        if (replay.rows[0] !== undefined) {
          if (replay.rows[0].operation_fingerprint !== fingerprint) {
            throw new FormalTaskCardOperationConflictError();
          }
          return { outcome: "already_applied" as const, presentation: mapPresentation(replay.rows[0]) };
        }
        const draft = await client.query<{
          source_group_id: string;
          status: string;
          current_revision_number: string | number;
          current_task_spec_hash: string;
          version: string | number;
        }>(
          `SELECT source_group_id, status, current_revision_number,
                  current_task_spec_hash, version
           FROM formal_task_drafts WHERE id = $1 FOR UPDATE`,
          [normalized.draftId],
        );
        const current = draft.rows[0];
        if (
          current === undefined ||
          current.status !== "pending_confirmation" ||
          current.source_group_id !== normalized.groupId ||
          Number(current.current_revision_number) !== normalized.expectedDraftRevision ||
          Number(current.version) !== normalized.expectedDraftVersion ||
          current.current_task_spec_hash !== normalized.taskSpecHash
        ) throw new FormalTaskCardPersistenceConflictError();
        const revision = await client.query<{ task_spec_hash: string }>(
          `SELECT task_spec_hash FROM formal_task_draft_revisions
           WHERE draft_id = $1 AND revision_number = $2`,
          [normalized.draftId, normalized.expectedDraftRevision],
        );
        if (revision.rows[0]?.task_spec_hash !== normalized.taskSpecHash) {
          throw new FormalTaskCardPersistenceConflictError();
        }
        try {
          const inserted = await client.query<PresentationRow>(
            `INSERT INTO formal_task_draft_presentations (
               id, draft_id, draft_revision, draft_version, task_spec_hash, group_id,
               state, operation_key, operation_fingerprint, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, 'pending_send', $7, $8, $9)
             RETURNING *`,
            [
              normalized.id,
              normalized.draftId,
              normalized.expectedDraftRevision,
              normalized.expectedDraftVersion,
              normalized.taskSpecHash,
              normalized.groupId,
              normalized.operationKey,
              fingerprint,
              normalized.at,
            ],
          );
          await client.query(
            `INSERT INTO formal_task_draft_presentation_events (
               id, presentation_id, event_type, operation_key,
               from_version, to_version, created_at
             ) VALUES ($1, $2, 'created', $3, NULL, 1, $4)`,
            [randomUUID(), normalized.id, normalized.operationKey, normalized.at],
          );
          const digest = createHash("sha256").update(normalized.id).digest("hex");
          await client.query(
            `INSERT INTO formal_task_draft_presentation_outbox (
               id, presentation_id, idempotency_key, state, created_at, updated_at
             ) VALUES ($1, $2, $3, 'pending', $4, $4)`,
            [
              `formal-task-card-outbox-${digest.slice(0, 40)}`,
              normalized.id,
              `formal-task-card:${digest}`,
              normalized.at,
            ],
          );
          return {
            outcome: "applied" as const,
            presentation: mapPresentation(requireRow(inserted.rows[0])),
          };
        } catch (error) {
          if (isConstraintConflict(error)) throw new FormalTaskCardPersistenceConflictError();
          throw error;
        }
      });
      const draft = await taskRepository.getDraft(stored.presentation.draftId);
      if (draft === undefined) throw new FormalTaskCardPersistenceConflictError();
      return { ...stored, draft } satisfies FormalTaskCardMutationResult;
    },

    async claimPresentationSend(input) {
      const workerId = requireReference("workerId", input.workerId);
      const leaseUntil = requireDate(input.leaseUntil);
      const at = requireDate(input.at);
      if (leaseUntil.getTime() <= at.getTime()) throw new Error("leaseUntil must be after at");
      return withTransaction(dataSource, async (client) => {
        await terminalizeExpiredExternalAttempt(client, at);
        await terminalizeExhaustedAttempt(client, at);
        const claimed = await client.query<PresentationRow & { attempts: string | number }>(
          `WITH candidate AS (
             SELECT outbox.id
             FROM formal_task_draft_presentation_outbox outbox
             JOIN formal_task_draft_presentations presentation
               ON presentation.id = outbox.presentation_id
             WHERE presentation.state IN ('pending_send', 'closed')
               AND outbox.attempts < $1
               AND (
                 outbox.state = 'pending'
                 OR (outbox.state = 'failed' AND outbox.retry_at <= $2)
                 OR (outbox.state = 'processing' AND outbox.lease_until <= $2)
               )
             ORDER BY outbox.created_at ASC, outbox.id ASC
             FOR UPDATE OF outbox SKIP LOCKED
             LIMIT 1
           ), updated AS (
             UPDATE formal_task_draft_presentation_outbox outbox
             SET state = 'processing', attempts = attempts + 1, worker_id = $3,
                 lease_until = $4, retry_at = NULL, error_code = NULL, updated_at = $2
             FROM candidate
             WHERE outbox.id = candidate.id
             RETURNING outbox.presentation_id, outbox.attempts
           )
           SELECT presentation.*, updated.attempts
           FROM updated
           JOIN formal_task_draft_presentations presentation
             ON presentation.id = updated.presentation_id`,
          [MAX_EXTERNAL_ATTEMPTS, at, workerId, leaseUntil],
        );
        const row = claimed.rows[0];
        return row === undefined
          ? undefined
          : {
              presentation: mapPresentation(row),
              workerId,
              leaseUntil,
              attempts: Number(row.attempts),
            };
      });
    },

    async beginExternalAttempt(input) {
      const result = await dataSource.query(
        `UPDATE formal_task_draft_presentation_outbox
         SET state = 'external_attempting', updated_at = $3
         WHERE presentation_id = $1 AND worker_id = $2 AND state = 'processing'
           AND lease_until > $3
         RETURNING presentation_id`,
        [
          requireReference("presentationId", input.presentationId),
          requireReference("workerId", input.workerId),
          requireDate(input.at),
        ],
      );
      requireOneRow(result.rows.length);
    },

    failPresentationPreparation(input) {
      return finishFailedSend(dataSource, {
        ...input,
        expectedOutboxState: "processing",
        classification: "permanent",
      });
    },

    async completePresentationSend(input) {
      const normalized = {
        presentationId: requireReference("presentationId", input.presentationId),
        workerId: requireReference("workerId", input.workerId),
        messageId: requireReference("messageId", input.messageId),
        at: requireDate(input.at),
      };
      await withTransaction(dataSource, async (client) => {
        const presentation = await lockPresentation(client, normalized.presentationId);
        if (
          presentation.state !== "pending_send" &&
          presentation.state !== "closed"
        ) throw new FormalTaskCardPersistenceConflictError();
        if (
          presentation.state === "closed" &&
          presentation.message_id !== normalized.messageId
        ) throw new FormalTaskCardPersistenceConflictError();
        const outbox = await client.query(
          `UPDATE formal_task_draft_presentation_outbox
           SET state = 'sent', worker_id = NULL, lease_until = NULL, retry_at = NULL,
               error_code = NULL, updated_at = $3
           WHERE presentation_id = $1 AND worker_id = $2 AND state = 'external_attempting'
           RETURNING presentation_id`,
          [normalized.presentationId, normalized.workerId, normalized.at],
        );
        requireOneRow(outbox.rows.length);
        const nextVersion = Number(presentation.version) + 1;
        const updated = presentation.state === "pending_send"
          ? await client.query(
              `UPDATE formal_task_draft_presentations
               SET state = 'active', message_id = $2, activated_at = $3, version = $4
               WHERE id = $1 AND state = 'pending_send' AND version = $5
               RETURNING id`,
              [
                normalized.presentationId,
                normalized.messageId,
                normalized.at,
                nextVersion,
                Number(presentation.version),
              ],
            )
          : await client.query(
              `UPDATE formal_task_draft_presentations
               SET version = $2
               WHERE id = $1 AND state = 'closed' AND version = $3
               RETURNING id`,
              [normalized.presentationId, nextVersion, Number(presentation.version)],
            );
        requireOneRow(updated.rows.length);
        await insertPresentationEvent(client, {
          presentationId: normalized.presentationId,
          eventType: presentation.state === "pending_send"
            ? "send_succeeded"
            : "card_update_succeeded",
          operationKey: randomOperationKey(
            presentation.state === "pending_send"
              ? "formal-task-card-send-succeeded"
              : "formal-task-card-update-succeeded",
          ),
          fromVersion: Number(presentation.version),
          toVersion: nextVersion,
          at: normalized.at,
        });
      });
    },

    failPresentationSend(input) {
      return finishFailedSend(dataSource, {
        ...input,
        expectedOutboxState: "external_attempting",
      });
    },

    applyInteraction(input) {
      return applyInteraction(dataSource, input);
    },

    async getPresentation(id) {
      const result = await dataSource.query<PresentationRow>(
        `${presentationSelect()} WHERE id = $1`,
        [requireReference("id", id)],
      );
      return result.rows[0] === undefined ? undefined : mapPresentation(result.rows[0]);
    },

    async getPresentationContext(id) {
      const presentationResult = await dataSource.query<PresentationRow>(
        `${presentationSelect()} WHERE id = $1`,
        [requireReference("id", id)],
      );
      const row = presentationResult.rows[0];
      if (row === undefined) return undefined;
      const presentation = mapPresentation(row);
      const draft = await taskRepository.getDraft(presentation.draftId);
      if (draft === undefined) throw new FormalTaskCardPersistenceConflictError();
      if (!("taskSpec" in draft.currentRevision)) {
        throw new FormalTaskCardPersistenceConflictError();
      }
      const targetPolicy = await taskRepository.getTargetPolicy(
        draft.currentRevision.taskSpec.targetPolicyId,
      );
      if (targetPolicy === undefined) throw new FormalTaskCardPersistenceConflictError();
      const committedResult = presentation.state === "closed"
        ? await loadCommittedResult(dataSource, presentation)
        : undefined;
      return {
        presentation,
        draft,
        targetPolicy,
        ...(committedResult === undefined ? {} : { committedResult }),
      } satisfies FormalTaskCardPresentationContext;
    },

    async getPresentationStatusCounts() {
      const result = await dataSource.query<CountRow<KnowledgeCardPresentationState>>(
        "SELECT state, count(*) AS count FROM formal_task_draft_presentations GROUP BY state",
      );
      return fillCounts(
        ["pending_send", "active", "superseded", "closed", "send_failed"] as const,
        result.rows,
      ) as FormalTaskCardPresentationStatusCounts;
    },

    async getOutboxStatusCounts() {
      const [counts, terminal] = await Promise.all([
        dataSource.query<CountRow<keyof Omit<FormalTaskCardOutboxStatusCounts, "terminalFailed">>>(
          `SELECT state, count(*) AS count
           FROM formal_task_draft_presentation_outbox GROUP BY state`,
        ),
        dataSource.query<{ count: string | number }>(
          `SELECT count(*) AS count FROM formal_task_draft_presentation_outbox
           WHERE state = 'failed' AND retry_at IS NULL`,
        ),
      ]);
      return {
        ...fillCounts(
          ["pending", "processing", "external_attempting", "sent", "failed", "outcome_unknown"] as const,
          counts.rows,
        ),
        terminalFailed: Number(terminal.rows[0]?.count ?? 0),
      };
    },
  };
}

async function terminalizeExpiredExternalAttempt(
  client: FormalTaskCardTransactionClient,
  at: Date,
): Promise<void> {
  const result = await client.query<PresentationOutboxJoinRow>(
    `SELECT outbox.id AS outbox_id, outbox.state AS outbox_state,
            outbox.idempotency_key, outbox.attempts, outbox.lease_until,
            presentation.*
     FROM formal_task_draft_presentation_outbox outbox
     JOIN formal_task_draft_presentations presentation
       ON presentation.id = outbox.presentation_id
     WHERE outbox.state = 'external_attempting'
       AND outbox.lease_until <= $1
       AND presentation.state IN ('pending_send', 'closed')
     ORDER BY outbox.lease_until ASC, outbox.created_at ASC, outbox.id ASC
     FOR UPDATE OF outbox, presentation SKIP LOCKED
     LIMIT 1`,
    [at],
  );
  const row = result.rows[0];
  if (row === undefined) return;
  await terminalizeOutboxRow(client, row, {
    outboxState: "outcome_unknown",
    errorCode: "external_attempt_lease_expired",
    operationPrefix: "external-attempt-expired",
    at,
  });
}

async function terminalizeExhaustedAttempt(
  client: FormalTaskCardTransactionClient,
  at: Date,
): Promise<void> {
  const result = await client.query<PresentationOutboxJoinRow>(
    `SELECT outbox.id AS outbox_id, outbox.state AS outbox_state,
            outbox.idempotency_key, outbox.attempts, outbox.lease_until,
            presentation.*
     FROM formal_task_draft_presentation_outbox outbox
     JOIN formal_task_draft_presentations presentation
       ON presentation.id = outbox.presentation_id
     WHERE outbox.attempts >= $2
       AND presentation.state IN ('pending_send', 'closed')
       AND (
         (outbox.state = 'failed' AND outbox.retry_at <= $1)
         OR (outbox.state = 'processing' AND outbox.lease_until <= $1)
       )
     ORDER BY outbox.updated_at ASC, outbox.id ASC
     FOR UPDATE OF outbox, presentation SKIP LOCKED
     LIMIT 1`,
    [at, MAX_EXTERNAL_ATTEMPTS],
  );
  const row = result.rows[0];
  if (row === undefined) return;
  await terminalizeOutboxRow(client, row, {
    outboxState: "failed",
    errorCode: "max_attempts_exhausted",
    operationPrefix: "attempts-exhausted",
    at,
  });
}

async function terminalizeOutboxRow(
  client: FormalTaskCardTransactionClient,
  row: PresentationOutboxJoinRow,
  input: {
    outboxState: "failed" | "outcome_unknown";
    errorCode: string;
    operationPrefix: string;
    at: Date;
  },
): Promise<void> {
  const fromVersion = Number(row.version);
  const toVersion = fromVersion + 1;
  const nextPresentationState = row.state === "closed" ? "closed" : "send_failed";
  const presentation = await client.query(
    `UPDATE formal_task_draft_presentations
     SET state = $2, version = $3
     WHERE id = $1 AND state = $4 AND version = $5
     RETURNING id`,
    [row.id, nextPresentationState, toVersion, row.state, fromVersion],
  );
  requireOneRow(presentation.rows.length);
  const outbox = await client.query(
    `UPDATE formal_task_draft_presentation_outbox
     SET state = $2, worker_id = NULL, lease_until = NULL, retry_at = NULL,
         error_code = $3, updated_at = $4
     WHERE id = $1 AND state = $5
     RETURNING id`,
    [row.outbox_id, input.outboxState, input.errorCode, input.at, row.outbox_state],
  );
  requireOneRow(outbox.rows.length);
  await insertPresentationEvent(client, {
    presentationId: row.id,
    eventType: row.state === "closed" ? "card_update_failed" : "send_failed",
    operationKey: derivedOperationKey(
      input.operationPrefix,
      row.idempotency_key,
      String(row.attempts),
    ),
    fromVersion,
    toVersion,
    at: input.at,
  });
}

async function applyInteraction(
  dataSource: PostgresFormalTaskDataSource,
  input: ApplyFormalTaskCardInteractionInput,
): Promise<FormalTaskCardInteractionResult> {
  const normalized = normalizeInteraction(input);
  const operationKey = interactionOperationKey(normalized.eventId, normalized.action);
  return withTransaction(dataSource, async (client) => {
    const draftIdentity = await client.query<{ draft_id: string }>(
      "SELECT draft_id FROM formal_task_draft_presentations WHERE id = $1",
      [normalized.presentationId],
    );
    if (draftIdentity.rows[0] === undefined) throw new FormalTaskCardPresentationNotFoundError();
    await client.query("SELECT id FROM formal_task_drafts WHERE id = $1 FOR UPDATE", [
      draftIdentity.rows[0].draft_id,
    ]);
    const presentation = await lockPresentation(client, normalized.presentationId);
    const replayEvent = await client.query<PresentationEventRow>(
      `SELECT presentation_id, event_type, actor_open_id, callback_event_id,
              operation_key, created_at
       FROM formal_task_draft_presentation_events
       WHERE callback_event_id = $1 FOR UPDATE`,
      [normalized.eventId],
    );
    const expectedPresentationEvent = interactionPresentationEvent(normalized.action);
    if (replayEvent.rows[0] !== undefined) {
      const event = replayEvent.rows[0];
      if (
        event.presentation_id !== normalized.presentationId ||
        event.event_type !== expectedPresentationEvent ||
        event.actor_open_id !== normalized.actorOpenId ||
        event.operation_key !== operationKey
      ) throw new FormalTaskCardOperationConflictError();
      const transition = await applyTransition(client, normalized, operationKey);
      const committedResult = await committedResultForOperation(
        client,
        presentation,
        operationKey,
      );
      return {
        outcome: "already_applied",
        presentation: mapPresentation(presentation),
        draft: transition.draft,
        committedResult,
      };
    }
    if (
      presentation.state !== "active" ||
      presentation.message_id === null ||
      presentation.draft_id !== normalized.draftId ||
      Number(presentation.draft_revision) !== normalized.draftRevision ||
      Number(presentation.draft_version) !== normalized.draftVersion ||
      presentation.task_spec_hash !== normalized.taskSpecHash ||
      presentation.group_id !== normalized.groupId
    ) throw new FormalTaskCardPersistenceConflictError();
    const revision = await client.query<{
      task_spec_hash: string;
      target_policy_id: string;
      target_policy_version: string | number;
    }>(
      `SELECT task_spec_hash, target_policy_id, target_policy_version
       FROM formal_task_draft_revisions
       WHERE draft_id = $1 AND revision_number = $2`,
      [normalized.draftId, normalized.draftRevision],
    );
    const currentRevision = revision.rows[0];
    if (
      currentRevision === undefined ||
      currentRevision.task_spec_hash !== normalized.taskSpecHash ||
      currentRevision.target_policy_id !== normalized.targetPolicyId ||
      Number(currentRevision.target_policy_version) !== normalized.targetPolicyVersion
    ) throw new FormalTaskCardPersistenceConflictError();

    const transition = await applyTransition(client, normalized, operationKey);
    const nextVersion = Number(presentation.version) + 1;
    const closed = await client.query(
      `UPDATE formal_task_draft_presentations
       SET state = 'closed', closed_at = $2, version = $3
       WHERE id = $1 AND state = 'active' AND version = $4
       RETURNING id`,
      [normalized.presentationId, normalized.at, nextVersion, Number(presentation.version)],
    );
    requireOneRow(closed.rows.length);
    await insertPresentationEvent(client, {
      presentationId: normalized.presentationId,
      eventType: expectedPresentationEvent,
      actorOpenId: normalized.actorOpenId,
      callbackEventId: normalized.eventId,
      operationKey,
      fromVersion: Number(presentation.version),
      toVersion: nextVersion,
      at: normalized.at,
    });
    const resetOutbox = await client.query(
      `UPDATE formal_task_draft_presentation_outbox
       SET state = 'pending', attempts = 0, worker_id = NULL, lease_until = NULL,
           retry_at = NULL, error_code = NULL, updated_at = $2
       WHERE presentation_id = $1 AND state = 'sent'
       RETURNING presentation_id`,
      [normalized.presentationId, normalized.at],
    );
    requireOneRow(resetOutbox.rows.length);
    const committedResult = committedResultFromInput(normalized);
    return {
      outcome: transition.outcome,
      presentation: {
        ...mapPresentation(presentation),
        state: "closed",
        closedAt: normalized.at,
        version: nextVersion,
      },
      draft: transition.draft,
      committedResult,
    };
  });
}

async function applyTransition(
  client: FormalTaskCardTransactionClient,
  input: ReturnType<typeof normalizeInteraction>,
  operationKey: string,
) {
  const common: TransitionFormalTaskDraftInput = {
    id: input.draftId,
    expectedVersion: input.draftVersion,
    expectedRevision: input.draftRevision,
    expectedTaskSpecHash: input.taskSpecHash,
    operationKey,
    actor: input.actorOpenId,
    at: input.at,
  };
  if (input.action === "confirm") {
    return applyFormalTaskTransitionInTransaction(client, common, "group_confirmed");
  }
  const disposal: DisposeFormalTaskDraftInput = { ...common, reason: input.reason };
  return applyFormalTaskTransitionInTransaction(
    client,
    disposal,
    input.action === "request_revision" ? "revision_requested" : "rejected",
  );
}

async function finishFailedSend(
  dataSource: PostgresFormalTaskDataSource,
  rawInput: {
    presentationId: string;
    workerId: string;
    errorCode: string;
    retryAt?: Date;
    at: Date;
    classification: "retryable" | "permanent" | "outcome_unknown";
    expectedOutboxState: "processing" | "external_attempting";
  },
): Promise<void> {
  const input = {
    presentationId: requireReference("presentationId", rawInput.presentationId),
    workerId: requireReference("workerId", rawInput.workerId),
    errorCode: requireReference("errorCode", rawInput.errorCode),
    retryAt: rawInput.retryAt === undefined ? undefined : requireDate(rawInput.retryAt),
    at: requireDate(rawInput.at),
    classification: rawInput.classification,
    expectedOutboxState: rawInput.expectedOutboxState,
  };
  if ((input.classification === "retryable") !== (input.retryAt !== undefined)) {
    throw new Error("retryAt must be supplied only for retryable failures");
  }
  await withTransaction(dataSource, async (client) => {
    const presentation = await lockPresentation(client, input.presentationId);
    if (
      presentation.state !== "pending_send" &&
      presentation.state !== "closed"
    ) throw new FormalTaskCardPersistenceConflictError();
    const nextOutboxState = input.classification === "outcome_unknown" ? "outcome_unknown" : "failed";
    const outbox = await client.query(
      `UPDATE formal_task_draft_presentation_outbox
       SET state = $3, worker_id = NULL, lease_until = NULL, retry_at = $4,
           error_code = $5, updated_at = $6
       WHERE presentation_id = $1 AND worker_id = $2 AND state = $7
       RETURNING presentation_id`,
      [
        input.presentationId,
        input.workerId,
        nextOutboxState,
        input.retryAt ?? null,
        input.errorCode,
        input.at,
        input.expectedOutboxState,
      ],
    );
    requireOneRow(outbox.rows.length);
    const nextVersion = Number(presentation.version) + 1;
    const terminal = input.classification !== "retryable";
    const nextPresentationState = presentation.state === "closed"
      ? "closed"
      : terminal ? "send_failed" : "pending_send";
    const updated = await client.query(
       `UPDATE formal_task_draft_presentations
        SET state = $2, version = $3
        WHERE id = $1 AND state = $5 AND version = $4
        RETURNING id`,
      [
        input.presentationId,
        nextPresentationState,
        nextVersion,
        Number(presentation.version),
        presentation.state,
      ],
    );
    requireOneRow(updated.rows.length);
    await insertPresentationEvent(client, {
      presentationId: input.presentationId,
      eventType: presentation.state === "closed" ? "card_update_failed" : "send_failed",
      operationKey: randomOperationKey(
        presentation.state === "closed"
          ? "formal-task-card-update-failed"
          : "formal-task-card-send-failed",
      ),
      fromVersion: Number(presentation.version),
      toVersion: nextVersion,
      at: input.at,
    });
  });
}

async function loadCommittedResult(
  dataSource: PostgresFormalTaskDataSource,
  presentation: FormalTaskDraftPresentation,
): Promise<FormalTaskCardCommittedResult | undefined> {
  const event = await dataSource.query<PresentationEventRow>(
    `SELECT presentation_id, event_type, actor_open_id, callback_event_id,
            operation_key, created_at
     FROM formal_task_draft_presentation_events
     WHERE presentation_id = $1
       AND event_type IN ('confirmed', 'revision_requested', 'rejected')
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [presentation.id],
  );
  return event.rows[0] === undefined
    ? undefined
    : committedResultForOperation(dataSource, presentation, event.rows[0].operation_key);
}

async function committedResultForOperation(
  queryable: Pick<PostgresFormalTaskDataSource, "query">,
  presentation: PresentationRow | FormalTaskDraftPresentation,
  operationKey: string,
): Promise<FormalTaskCardCommittedResult> {
  const draftId = "draft_id" in presentation ? presentation.draft_id : presentation.draftId;
  const event = await queryable.query<DraftEventRow>(
    `SELECT event_type, actor, reason, created_at
     FROM formal_task_draft_events
     WHERE draft_id = $1 AND operation_key = $2`,
    [draftId, operationKey],
  );
  const row = requireRow(event.rows[0]);
  if (row.event_type === "group_confirmed") {
    return {
      action: "confirm",
      actorOpenId: row.actor,
      confirmedAt: requireDate(row.created_at),
      nextGate: "pending_review",
    };
  }
  const reason = requireReason(row.reason);
  return row.event_type === "revision_requested"
    ? { action: "request_revision", state: "needs_revision", reason }
    : { action: "reject", state: "rejected", reason };
}

function committedResultFromInput(
  input: ReturnType<typeof normalizeInteraction>,
): FormalTaskCardCommittedResult {
  if (input.action === "confirm") {
    return {
      action: "confirm",
      actorOpenId: input.actorOpenId,
      confirmedAt: input.at,
      nextGate: "pending_review",
    };
  }
  return input.action === "request_revision"
    ? { action: "request_revision", state: "needs_revision", reason: input.reason }
    : { action: "reject", state: "rejected", reason: input.reason };
}

function normalizeCreatePresentation(input: CreateFormalTaskCardPresentationInput) {
  return {
    id: requireReference("id", input.id),
    draftId: requireReference("draftId", input.draftId),
    expectedDraftVersion: requirePositiveInteger("expectedDraftVersion", input.expectedDraftVersion),
    expectedDraftRevision: requirePositiveInteger(
      "expectedDraftRevision",
      input.expectedDraftRevision,
    ),
    taskSpecHash: requireHash(input.taskSpecHash),
    groupId: requireReference("groupId", input.groupId),
    operationKey: requireReference("operationKey", input.operationKey),
    at: requireDate(input.at),
  };
}

function normalizeInteraction(input: ApplyFormalTaskCardInteractionInput) {
  const common = {
    presentationId: requireReference("presentationId", input.presentationId),
    draftId: requireReference("draftId", input.draftId),
    draftRevision: requirePositiveInteger("draftRevision", input.draftRevision),
    draftVersion: requirePositiveInteger("draftVersion", input.draftVersion),
    taskSpecHash: requireHash(input.taskSpecHash),
    targetPolicyId: requireReference("targetPolicyId", input.targetPolicyId),
    targetPolicyVersion: requirePositiveInteger("targetPolicyVersion", input.targetPolicyVersion),
    groupId: requireReference("groupId", input.groupId),
    eventId: requireReference("eventId", input.eventId),
    actorOpenId: requireReference("actorOpenId", input.actorOpenId),
    membershipCheckedAt: requireDate(input.membershipCheckedAt),
    at: requireDate(input.at),
  };
  const membershipAge = common.at.getTime() - common.membershipCheckedAt.getTime();
  if (membershipAge < 0 || membershipAge > MEMBERSHIP_PROOF_MAX_AGE_MS) {
    throw new FormalTaskCardMembershipProofError();
  }
  if (input.action === "confirm") {
    if (input.reason !== undefined || input.rejectionConfirmed !== undefined) {
      throw new Error("confirmation contains unsupported fields");
    }
    return { ...common, action: "confirm" as const, reason: undefined };
  }
  const reason = requireReason(input.reason);
  if (input.action === "request_revision") {
    if (input.rejectionConfirmed !== undefined) {
      throw new Error("revision request contains unsupported fields");
    }
    return { ...common, action: "request_revision" as const, reason };
  }
  if (input.action !== "reject" || input.rejectionConfirmed !== true) {
    throw new Error("rejection confirmation is required");
  }
  return { ...common, action: "reject" as const, reason };
}

function interactionPresentationEvent(action: "confirm" | "request_revision" | "reject") {
  return action === "confirm"
    ? "confirmed" as const
    : action === "request_revision" ? "revision_requested" as const : "rejected" as const;
}

function interactionOperationKey(
  eventId: string,
  action: "confirm" | "request_revision" | "reject",
): string {
  const digest = createHash("sha256").update(JSON.stringify({ eventId, action })).digest("hex");
  return `formal-task-card-interaction-${digest}`;
}

async function lockPresentation(
  client: FormalTaskCardTransactionClient,
  id: string,
): Promise<PresentationRow> {
  const result = await client.query<PresentationRow>(
    `${presentationSelect()} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (result.rows[0] === undefined) throw new FormalTaskCardPresentationNotFoundError();
  return result.rows[0];
}

async function insertPresentationEvent(
  queryable: Pick<PostgresFormalTaskDataSource, "query">,
  input: {
    presentationId: string;
    eventType:
      | "created"
      | "send_succeeded"
      | "send_failed"
      | "confirmed"
      | "revision_requested"
      | "rejected"
      | "superseded"
      | "card_update_succeeded"
      | "card_update_failed";
    actorOpenId?: string;
    callbackEventId?: string;
    operationKey: string;
    fromVersion: number | null;
    toVersion: number;
    at: Date;
  },
): Promise<void> {
  await queryable.query(
    `INSERT INTO formal_task_draft_presentation_events (
       id, presentation_id, event_type, actor_open_id, callback_event_id,
       operation_key, from_version, to_version, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      input.presentationId,
      input.eventType,
      input.actorOpenId ?? null,
      input.callbackEventId ?? null,
      input.operationKey,
      input.fromVersion,
      input.toVersion,
      input.at,
    ],
  );
}

function presentationSelect(): string {
  return `SELECT id, draft_id, draft_revision, draft_version, task_spec_hash,
                 group_id, state, message_id, operation_key, operation_fingerprint,
                 version, created_at, activated_at, closed_at
          FROM formal_task_draft_presentations`;
}

function mapPresentation(row: PresentationRow): FormalTaskDraftPresentation {
  return {
    id: row.id,
    draftId: row.draft_id,
    draftRevision: Number(row.draft_revision),
    draftVersion: Number(row.draft_version),
    taskSpecHash: row.task_spec_hash,
    groupId: row.group_id,
    state: row.state,
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    createdAt: requireDate(row.created_at),
    ...(row.activated_at === null ? {} : { activatedAt: requireDate(row.activated_at) }),
    ...(row.closed_at === null ? {} : { closedAt: requireDate(row.closed_at) }),
    version: Number(row.version),
  };
}

async function withTransaction<T>(
  dataSource: PostgresFormalTaskDataSource,
  operation: (client: FormalTaskCardTransactionClient) => Promise<T>,
): Promise<T> {
  const client = await dataSource.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function fillCounts<const State extends string>(
  states: readonly State[],
  rows: Array<CountRow<State>>,
): Record<State, number> {
  const counts = Object.fromEntries(states.map((state) => [state, 0])) as Record<State, number>;
  for (const row of rows) counts[row.state] = Number(row.count);
  return counts;
}

function operationFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item))
    .digest("hex");
}

function randomOperationKey(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function derivedOperationKey(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `formal-task-card-${prefix}-${digest}`;
}

function requireOneRow(rowCount: number): void {
  if (rowCount !== 1) throw new FormalTaskCardPersistenceConflictError();
}

function requireRow<Row>(row: Row | undefined): Row {
  if (row === undefined) throw new FormalTaskCardPersistenceConflictError();
  return row;
}

function requireReference(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 512 ||
    /[\u0000-\u001f\u007f\s]/u.test(normalized)
  ) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("taskSpecHash is invalid");
  }
  return value;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} is invalid`);
  return Number(value);
}

function requireReason(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value) throw new Error("reason is invalid");
  if ([...value].length < 1 || [...value].length > 2_000) throw new Error("reason is invalid");
  return value;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("date is invalid");
  return new Date(value);
}

function isConstraintConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "23505";
}

export function isStableFormalTaskCardDenial(error: unknown): boolean {
  return error instanceof FormalTaskCardOperationConflictError ||
    error instanceof FormalTaskCardPersistenceConflictError ||
    error instanceof FormalTaskCardMembershipProofError ||
    error instanceof FormalTaskCardPresentationNotFoundError ||
    error instanceof FormalTaskOperationConflictError ||
    error instanceof FormalTaskVersionConflictError ||
    error instanceof FormalTaskTransitionError ||
    error instanceof FormalTaskPolicyConflictError ||
    error instanceof FormalTaskEvidenceError;
}
