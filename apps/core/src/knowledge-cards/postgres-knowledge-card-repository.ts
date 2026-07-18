import { createHash, randomUUID } from "node:crypto";

import {
  KNOWLEDGE_CARD_PRESENTATION_STATES,
  KNOWLEDGE_CARD_REASON_MAX_CHARS,
  type KnowledgeCardAction,
  type KnowledgeCardPresentationState,
} from "./knowledge-card.js";
import type {
  ApplyKnowledgeCardInteractionInput,
  CreateKnowledgeCardPresentationInput,
  KnowledgeCardInteractionResult,
  KnowledgeCardMutationResult,
  KnowledgeCardRepository,
  KnowledgeCardSendClaim,
  KnowledgeCardStatusCounts,
  KnowledgeCardPresentationContext,
  KnowledgeDraftPresentation,
} from "./knowledge-card-repository.js";
import type { KnowledgeDraftEvidenceReference } from "../knowledge-governance/knowledge-draft.js";
import {
  createPostgresKnowledgeDraftRepository,
  type KnowledgeDraftTransactionClient,
  type PostgresKnowledgeDraftDataSource,
} from "../knowledge-governance/postgres-knowledge-draft-repository.js";
import { validateCurrentKnowledgeDraftEvidence } from "../knowledge-governance/postgres-knowledge-draft-evidence.js";
import { validateKnowledgeDraftTransition } from "../knowledge-governance/knowledge-draft-state-machine.js";

type PresentationRow = {
  id: string;
  draft_id: string;
  revision_number: string | number;
  draft_version: string | number;
  chat_id: string;
  content_hash: string;
  state: KnowledgeCardPresentationState;
  message_id: string | null;
  created_at: Date;
  activated_at: Date | null;
  closed_at: Date | null;
  version: string | number;
};

type DraftHeaderRow = {
  id: string;
  source_group_id: string | null;
  status: string;
  current_revision_number: string | number;
  version: string | number;
};

type EvidenceRow = {
  evidence_type: "conversation_message" | "discussion_thread" | "action_item" | "document_source";
  reference_id: string;
  source_group_id: string | null;
  entity_version: string | number | null;
  source_updated_at: Date | null;
};

type OutboxRow = {
  id: string;
  presentation_id: string;
  idempotency_key: string;
  state: "pending" | "processing" | "external_attempting" | "sent" | "failed" | "outcome_unknown";
  attempts: string | number;
  worker_id: string | null;
  lease_until: Date | null;
};

type PresentationOutboxJoinRow = PresentationRow & {
  outbox_id: string;
  outbox_state: OutboxRow["state"];
  presentation_id: string;
  idempotency_key: string;
  attempts: string | number;
  worker_id: string | null;
  lease_until: Date | null;
};

type CountRow = { state: KnowledgeCardPresentationState; count: string | number };

type InteractionReplayRow = {
  presentation_id: string;
  event_type: "confirmed" | "revision_requested" | "rejected";
  actor_open_id: string | null;
  operation_key: string;
  draft_id: string | null;
  operation_fingerprint: string | null;
};

type KnowledgeCardActionEventTypes = {
  draft: "group_confirmed" | "revision_requested" | "rejected";
  presentation: "confirmed" | "revision_requested" | "rejected";
};

const MAX_PRESENTATION_EXTERNAL_ATTEMPTS = 5;

const KNOWLEDGE_CARD_ACTION_EVENT_TYPES: Record<KnowledgeCardAction, KnowledgeCardActionEventTypes> = {
  confirm: { draft: "group_confirmed", presentation: "confirmed" },
  request_revision: { draft: "revision_requested", presentation: "revision_requested" },
  reject: { draft: "rejected", presentation: "rejected" },
};

export class KnowledgeCardOperationConflictError extends Error {
  constructor() {
    super("knowledge card operation conflict");
    this.name = "KnowledgeCardOperationConflictError";
  }
}

export class KnowledgeCardPersistenceConflictError extends Error {
  constructor() {
    super("knowledge card persistence conflict");
    this.name = "KnowledgeCardPersistenceConflictError";
  }
}

export class KnowledgeCardPresentationNotFoundError extends Error {
  constructor() {
    super("knowledge card presentation not found");
    this.name = "KnowledgeCardPresentationNotFoundError";
  }
}

export class KnowledgeCardMembershipProofError extends Error {
  constructor() {
    super("knowledge card membership proof is stale");
    this.name = "KnowledgeCardMembershipProofError";
  }
}

export function createPostgresKnowledgeCardRepository({
  dataSource,
}: {
  dataSource: PostgresKnowledgeDraftDataSource;
}): KnowledgeCardRepository {
  return {
    createPresentation(input: CreateKnowledgeCardPresentationInput) {
      return createPresentation(dataSource, input);
    },
    claimPresentationSend(input: { workerId: string; leaseUntil: Date; at: Date }) {
      return claimPresentationSend(dataSource, input);
    },
    beginExternalAttempt(input: { presentationId: string; workerId: string; at: Date }) {
      return beginExternalAttempt(dataSource, input);
    },
    failPresentationPreparation(input: {
      presentationId: string;
      workerId: string;
      errorCode: string;
      at: Date;
    }) {
      return failPresentationPreparation(dataSource, input);
    },
    completePresentationSend(input: {
      presentationId: string;
      workerId: string;
      messageId: string;
      at: Date;
    }) {
      return completePresentationSend(dataSource, input);
    },
    failPresentationSend(input: {
      presentationId: string;
      workerId: string;
      classification: "retryable" | "permanent" | "outcome_unknown";
      errorCode: string;
      retryAt?: Date;
      at: Date;
    }) {
      return failPresentationSend(dataSource, input);
    },
    applyInteraction(input: ApplyKnowledgeCardInteractionInput) {
      return applyInteraction(dataSource, input);
    },
    getPresentation(id: string) {
      return loadPresentation(dataSource, requireReference("id", id));
    },
    getPresentationContext(id: string) {
      return loadPresentationContext(dataSource, requireReference("id", id));
    },
    async listPresentations(input: { draftId: string; limit: number }) {
      const result = await dataSource.query<PresentationRow>(
        `${presentationSelect()}
         WHERE draft_id = $1
         ORDER BY created_at DESC, id ASC
         LIMIT $2`,
        [requireReference("draftId", input.draftId), requireLimit(input.limit)],
      );
      return result.rows.map(mapPresentation);
    },
    async getStatusCounts() {
      const result = await dataSource.query<CountRow>(
        "SELECT state, count(*) AS count FROM knowledge_draft_presentations GROUP BY state",
      );
      const counts = Object.fromEntries(
        KNOWLEDGE_CARD_PRESENTATION_STATES.map((state) => [state, 0]),
      ) as Record<KnowledgeCardPresentationState, number>;
      for (const row of result.rows) counts[row.state] = Number(row.count);
      return { ...counts, pendingSend: counts.pending_send } satisfies KnowledgeCardStatusCounts;
    },
  };
}

async function applyInteraction(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: ApplyKnowledgeCardInteractionInput,
): Promise<KnowledgeCardInteractionResult> {
  const normalized = normalizeInteraction(input);
  const fingerprint = operationFingerprint({ operation: "apply_interaction", ...normalized });
  const operationKey = derivedOperationKey("interaction", normalized.eventId, normalized.action);

  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, derivedOperationKey("callback", normalized.eventId));
    const replay = await replayInteraction(client, normalized, operationKey, fingerprint);
    if (replay !== undefined) return replay;

    const presentation = await lockPresentation(client, normalized.presentationId);
    if (
      presentation.state !== "active" ||
      presentation.draft_id !== normalized.draftId ||
      Number(presentation.revision_number) !== normalized.revisionNumber ||
      Number(presentation.draft_version) !== normalized.draftVersion ||
      presentation.chat_id !== normalized.chatId
    ) throw new KnowledgeCardPersistenceConflictError();

    const draft = await lockDraft(client, normalized.draftId);
    if (
      draft.status !== "pending_confirmation" ||
      draft.source_group_id !== normalized.chatId ||
      Number(draft.current_revision_number) !== normalized.revisionNumber ||
      Number(draft.version) !== normalized.draftVersion
    ) throw new KnowledgeCardPersistenceConflictError();
    await validateDraftEvidence(client, draft);

    const eventTypes = KNOWLEDGE_CARD_ACTION_EVENT_TYPES[normalized.action];
    const draftStatus = normalized.action === "confirm"
      ? "pending_review"
      : normalized.action === "request_revision" ? "needs_revision" : "rejected";
    if (!validateKnowledgeDraftTransition({
      from: "pending_confirmation",
      to: draftStatus,
      eventType: eventTypes.draft,
      sourceGroupId: draft.source_group_id ?? undefined,
    }).ok) throw new KnowledgeCardPersistenceConflictError();

    if (normalized.action === "confirm") {
      await client.query(
        `INSERT INTO knowledge_draft_group_confirmations (
          draft_id, revision_number, presentation_id, actor_open_id,
          callback_event_id, membership_checked_at, confirmed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          normalized.draftId,
          normalized.revisionNumber,
          normalized.presentationId,
          normalized.actorOpenId,
          normalized.eventId,
          normalized.membershipCheckedAt,
          normalized.at,
        ],
      );
    }

    const nextDraftVersion = normalized.draftVersion + 1;
    const draftUpdate = normalized.action === "reject"
      ? await client.query(
          `UPDATE knowledge_drafts
           SET status = 'rejected', version = version + 1, rejected_at = $2,
               rejected_by = $3, rejection_reason = $4, updated_at = $2
           WHERE id = $1 AND version = $5 AND status = 'pending_confirmation'`,
          [
            normalized.draftId,
            normalized.at,
            normalized.actorOpenId,
            normalized.reason,
            normalized.draftVersion,
          ],
        )
      : await client.query(
          `UPDATE knowledge_drafts
           SET status = $2, version = version + 1, updated_at = $3
           WHERE id = $1 AND version = $4 AND status = 'pending_confirmation'`,
          [normalized.draftId, draftStatus, normalized.at, normalized.draftVersion],
        );
    requireOneRow(draftUpdate);
    await insertDraftInteractionEvent(client, {
      draftId: normalized.draftId,
      eventType: eventTypes.draft,
      fromVersion: normalized.draftVersion,
      toVersion: nextDraftVersion,
      operationKey,
      fingerprint,
      actor: normalized.actorOpenId,
      reason: normalized.reason,
      revisionNumber: normalized.revisionNumber,
      at: normalized.at,
    });

    const presentationVersion = Number(presentation.version);
    const presentationUpdate = await client.query(
      `UPDATE knowledge_draft_presentations
       SET state = 'closed', closed_at = $2, version = version + 1
       WHERE id = $1 AND version = $3 AND state = 'active'`,
      [normalized.presentationId, normalized.at, presentationVersion],
    );
    requireOneRow(presentationUpdate);
    await insertInteractionPresentationEvent(client, {
      presentationId: normalized.presentationId,
      eventType: eventTypes.presentation,
      actorOpenId: normalized.actorOpenId,
      operationKey,
      callbackEventId: normalized.eventId,
      fromVersion: presentationVersion,
      toVersion: presentationVersion + 1,
      at: normalized.at,
    });

    const outboxUpdate = await client.query(
      `UPDATE knowledge_draft_presentation_outbox
       SET idempotency_key = $2, state = 'pending', attempts = 0,
           worker_id = NULL, lease_until = NULL, retry_at = NULL,
           error_code = NULL, updated_at = $3
       WHERE presentation_id = $1 AND state = 'sent'`,
      [
        normalized.presentationId,
        `knowledge-card-update:${operationFingerprint({
          presentationId: normalized.presentationId,
          callbackEventId: normalized.eventId,
        })}`,
        normalized.at,
      ],
    );
    requireOneRow(outboxUpdate);

    return {
      outcome: "applied",
      presentation: await requirePresentation(client, normalized.presentationId),
      draft: await requireDraftView(client, normalized.draftId),
    };
  });
}

async function createPresentation(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: CreateKnowledgeCardPresentationInput,
): Promise<KnowledgeCardMutationResult> {
  const normalized = {
    id: requireReference("id", input.id),
    draftId: requireReference("draftId", input.draftId),
    expectedDraftVersion: requirePositiveInteger("expectedDraftVersion", input.expectedDraftVersion),
    expectedRevisionNumber: requirePositiveInteger(
      "expectedRevisionNumber",
      input.expectedRevisionNumber,
    ),
    chatId: requireReference("chatId", input.chatId),
    contentHash: requireContentHash(input.contentHash),
    operationKey: requireReference("operationKey", input.operationKey),
    at: requireDate(input.at),
  };
  const fingerprint = operationFingerprint({ operation: "create_presentation", ...normalized });

  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await replayPresentationOperation(client, normalized.operationKey, fingerprint);
    if (replay !== undefined) return replay;
    // Creation lock order: operation key, presentation ID, then draft row.
    await lockPresentationId(client, normalized.id);
    const draft = await lockDraft(client, normalized.draftId);
    const existing = await client.query("SELECT 1 FROM knowledge_draft_presentations WHERE id = $1", [
      normalized.id,
    ]);
    if (existing.rows.length > 0) throw new KnowledgeCardOperationConflictError();
    if (
      draft.status !== "pending_confirmation" ||
      draft.source_group_id !== normalized.chatId ||
      Number(draft.version) !== normalized.expectedDraftVersion ||
      Number(draft.current_revision_number) !== normalized.expectedRevisionNumber
    ) throw new KnowledgeCardPersistenceConflictError();
    await validateDraftEvidence(client, draft);

    const superseded = await client.query<Pick<PresentationRow, "id" | "version">>(
      `UPDATE knowledge_draft_presentations
       SET state = 'superseded', version = version + 1
       WHERE draft_id = $1 AND state IN ('pending_send', 'active')
       RETURNING id, version`,
      [normalized.draftId],
    );
    for (const row of superseded.rows) {
      await insertPresentationEvent(client, {
        presentationId: row.id,
        eventType: "superseded",
        operationKey: derivedOperationKey("superseded", normalized.operationKey, row.id),
        fromVersion: Number(row.version) - 1,
        toVersion: Number(row.version),
        at: normalized.at,
      });
    }
    if (superseded.rows.length > 0) {
      await client.query(
        `UPDATE knowledge_draft_presentation_outbox
         SET state = 'failed', worker_id = NULL, lease_until = NULL,
             retry_at = NULL, error_code = 'superseded', updated_at = $2
         WHERE presentation_id = ANY($1::TEXT[]) AND state IN ('pending', 'processing')`,
        [superseded.rows.map((row) => row.id), normalized.at],
      );
    }

    await client.query(
      `INSERT INTO knowledge_draft_presentations (
        id, draft_id, revision_number, draft_version, chat_id, content_hash,
        state, operation_key, operation_fingerprint, version, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'pending_send', $7, $8, 1, $9)`,
      [
        normalized.id,
        normalized.draftId,
        normalized.expectedRevisionNumber,
        normalized.expectedDraftVersion,
        normalized.chatId,
        normalized.contentHash,
        normalized.operationKey,
        fingerprint,
        normalized.at,
      ],
    );
    await insertPresentationEvent(client, {
      presentationId: normalized.id,
      eventType: "created",
      operationKey: normalized.operationKey,
      toVersion: 1,
      at: normalized.at,
    });
    await client.query(
      `INSERT INTO knowledge_draft_presentation_outbox (
        id, presentation_id, idempotency_key, state, attempts, created_at, updated_at
      ) VALUES ($1, $2, $3, 'pending', 0, $4, $4)`,
      [
        randomUUID(),
        normalized.id,
        `knowledge-presentation:${operationFingerprint({
          presentationId: normalized.id,
        })}`,
        normalized.at,
      ],
    );
    return {
      outcome: "applied",
      presentation: await requirePresentation(client, normalized.id),
      draft: await requireDraftView(client, normalized.draftId),
    };
  });
}

async function claimPresentationSend(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: { workerId: string; leaseUntil: Date; at: Date },
): Promise<KnowledgeCardSendClaim | undefined> {
  const workerId = requireReference("workerId", input.workerId);
  const leaseUntil = requireDate(input.leaseUntil);
  const at = requireDate(input.at);
  if (leaseUntil.getTime() <= at.getTime()) throw new Error("leaseUntil is invalid");

  return withTransaction(dataSource, async (client) => {
    await terminalizeExpiredExternalAttempt(client, at);
    await terminalizeExhaustedPresentationAttempt(client, at);
    const result = await client.query<PresentationOutboxJoinRow>(
      `SELECT outbox.id AS outbox_id, outbox.presentation_id, outbox.idempotency_key,
              outbox.state AS outbox_state, outbox.attempts, outbox.worker_id,
              outbox.lease_until, presentation.*
       FROM knowledge_draft_presentation_outbox outbox
       JOIN knowledge_draft_presentations presentation ON presentation.id = outbox.presentation_id
       WHERE presentation.state IN ('pending_send', 'closed')
         AND outbox.attempts < ${MAX_PRESENTATION_EXTERNAL_ATTEMPTS}
         AND (
           (outbox.state = 'pending' AND (outbox.retry_at IS NULL OR outbox.retry_at <= $1))
           OR (outbox.state = 'processing' AND outbox.lease_until <= $1)
         )
       ORDER BY outbox.retry_at ASC NULLS FIRST, outbox.created_at ASC, outbox.id ASC
       FOR UPDATE OF outbox SKIP LOCKED
       LIMIT 1`,
      [at],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    await client.query(
      `UPDATE knowledge_draft_presentation_outbox
       SET state = 'processing', attempts = attempts + 1, worker_id = $2,
           lease_until = $3, retry_at = NULL, error_code = NULL, updated_at = $4
       WHERE id = $1`,
      [row.outbox_id, workerId, leaseUntil, at],
    );
    return {
      presentation: mapPresentation(row),
      workerId,
      leaseUntil,
      attempts: Number(row.attempts) + 1,
    };
  });
}

async function terminalizeExhaustedPresentationAttempt(
  client: KnowledgeDraftTransactionClient,
  at: Date,
): Promise<void> {
  const result = await client.query<PresentationOutboxJoinRow>(
    `SELECT outbox.id AS outbox_id, outbox.presentation_id, outbox.idempotency_key,
            outbox.state AS outbox_state, outbox.attempts, outbox.worker_id,
            outbox.lease_until, presentation.*
     FROM knowledge_draft_presentation_outbox outbox
     JOIN knowledge_draft_presentations presentation ON presentation.id = outbox.presentation_id
     WHERE outbox.attempts >= $2
       AND presentation.state IN ('pending_send', 'closed')
       AND (
         (outbox.state = 'pending' AND (outbox.retry_at IS NULL OR outbox.retry_at <= $1))
         OR (outbox.state = 'processing' AND outbox.lease_until <= $1)
       )
     ORDER BY outbox.updated_at ASC, outbox.id ASC
     FOR UPDATE OF outbox, presentation SKIP LOCKED
     LIMIT 1`,
    [at, MAX_PRESENTATION_EXTERNAL_ATTEMPTS],
  );
  const row = result.rows[0];
  if (row === undefined) return;

  const fromVersion = Number(row.version);
  let toVersion = fromVersion;
  if (row.state === "pending_send") {
    const presentationUpdate = await client.query(
      `UPDATE knowledge_draft_presentations
       SET state = 'send_failed', version = version + 1
       WHERE id = $1 AND version = $2 AND state = 'pending_send'`,
      [row.presentation_id, fromVersion],
    );
    requireOneRow(presentationUpdate);
    toVersion += 1;
  }
  await client.query(
    `UPDATE knowledge_draft_presentation_outbox
     SET state = 'failed', worker_id = NULL, lease_until = NULL,
         retry_at = NULL, error_code = 'max_attempts_exhausted', updated_at = $2
     WHERE id = $1`,
    [row.outbox_id, at],
  );
  await insertPresentationEvent(client, {
    presentationId: row.presentation_id,
    eventType: row.state === "closed" ? "card_update_failed" : "send_failed",
    operationKey: derivedOperationKey(
      "attempts-exhausted",
      row.idempotency_key,
      String(row.attempts),
    ),
    fromVersion,
    toVersion,
    at,
  });
}

async function terminalizeExpiredExternalAttempt(
  client: KnowledgeDraftTransactionClient,
  at: Date,
): Promise<void> {
  const result = await client.query<PresentationOutboxJoinRow>(
    `SELECT outbox.id AS outbox_id, outbox.presentation_id, outbox.idempotency_key,
            outbox.state AS outbox_state, outbox.attempts, outbox.worker_id,
            outbox.lease_until, presentation.*
     FROM knowledge_draft_presentation_outbox outbox
     JOIN knowledge_draft_presentations presentation ON presentation.id = outbox.presentation_id
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

  const fromVersion = Number(row.version);
  let toVersion = fromVersion;
  if (row.state === "pending_send") {
    const presentationUpdate = await client.query(
      `UPDATE knowledge_draft_presentations
       SET state = 'send_failed', version = version + 1
       WHERE id = $1 AND version = $2 AND state = 'pending_send'`,
      [row.presentation_id, fromVersion],
    );
    requireOneRow(presentationUpdate);
    toVersion += 1;
  }
  await client.query(
    `UPDATE knowledge_draft_presentation_outbox
     SET state = 'outcome_unknown', worker_id = NULL, lease_until = NULL,
         retry_at = NULL, error_code = 'external_attempt_lease_expired', updated_at = $2
     WHERE id = $1`,
    [row.outbox_id, at],
  );
  await insertPresentationEvent(client, {
    presentationId: row.presentation_id,
    eventType: row.state === "closed" ? "card_update_failed" : "send_failed",
    operationKey: derivedOperationKey(
      "external-attempt-expired",
      row.idempotency_key,
      String(row.attempts),
    ),
    fromVersion,
    toVersion,
    at,
  });
}

async function beginExternalAttempt(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: { presentationId: string; workerId: string; at: Date },
): Promise<void> {
  const normalized = {
    presentationId: requireReference("presentationId", input.presentationId),
    workerId: requireReference("workerId", input.workerId),
    at: requireDate(input.at),
  };
  await withTransaction(dataSource, async (client) => {
    const presentation = await lockPresentation(client, normalized.presentationId);
    if (presentation.state !== "pending_send" && presentation.state !== "closed") {
      throw new KnowledgeCardPersistenceConflictError();
    }
    const outbox = await lockOwnedOutbox(
      client,
      normalized.presentationId,
      normalized.workerId,
      normalized.at,
      "processing",
    );
    await client.query(
      `UPDATE knowledge_draft_presentation_outbox
       SET state = 'external_attempting', updated_at = $2
       WHERE id = $1`,
      [outbox.id, normalized.at],
    );
  });
}

async function completePresentationSend(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: { presentationId: string; workerId: string; messageId: string; at: Date },
): Promise<void> {
  const normalized = {
    presentationId: requireReference("presentationId", input.presentationId),
    workerId: requireReference("workerId", input.workerId),
    messageId: requireReference("messageId", input.messageId),
    at: requireDate(input.at),
  };
  await withTransaction(dataSource, async (client) => {
    const presentation = await lockPresentation(client, normalized.presentationId);
    const outbox = await lockOwnedOutbox(
      client,
      normalized.presentationId,
      normalized.workerId,
      normalized.at,
      "external_attempting",
    );
    const fromVersion = Number(presentation.version);
    let eventType: "send_succeeded" | "card_update_succeeded";
    let toVersion = fromVersion;
    if (presentation.state === "pending_send") {
      const result = await client.query(
        `UPDATE knowledge_draft_presentations
         SET state = 'active', message_id = $2, activated_at = $3, version = version + 1
         WHERE id = $1 AND version = $4 AND state = 'pending_send'`,
        [normalized.presentationId, normalized.messageId, normalized.at, fromVersion],
      );
      if ((result as unknown as { rowCount?: number }).rowCount !== 1) {
        throw new KnowledgeCardPersistenceConflictError();
      }
      eventType = "send_succeeded";
      toVersion += 1;
    } else if (presentation.state === "closed" && presentation.message_id === normalized.messageId) {
      eventType = "card_update_succeeded";
    } else {
      throw new KnowledgeCardPersistenceConflictError();
    }
    await client.query(
      `UPDATE knowledge_draft_presentation_outbox
       SET state = 'sent', worker_id = NULL, lease_until = NULL,
           retry_at = NULL, error_code = NULL, updated_at = $2
       WHERE id = $1`,
      [outbox.id, normalized.at],
    );
    await insertPresentationEvent(client, {
      presentationId: normalized.presentationId,
      eventType,
      operationKey: derivedOperationKey(
        "send-complete",
        outbox.idempotency_key,
        String(outbox.attempts),
      ),
      fromVersion,
      toVersion,
      at: normalized.at,
    });
  });
}

async function failPresentationPreparation(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: { presentationId: string; workerId: string; errorCode: string; at: Date },
): Promise<void> {
  const normalized = {
    presentationId: requireReference("presentationId", input.presentationId),
    workerId: requireReference("workerId", input.workerId),
    errorCode: requireReference("errorCode", input.errorCode),
    at: requireDate(input.at),
  };
  await withTransaction(dataSource, async (client) => {
    const presentation = await lockPresentation(client, normalized.presentationId);
    const outbox = await lockOwnedOutbox(
      client,
      normalized.presentationId,
      normalized.workerId,
      normalized.at,
      "processing",
    );
    await persistPresentationFailure(client, {
      presentation,
      outbox,
      presentationId: normalized.presentationId,
      classification: "permanent",
      errorCode: normalized.errorCode,
      at: normalized.at,
      operation: "preparation-fail",
    });
  });
}

async function failPresentationSend(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: {
    presentationId: string;
    workerId: string;
    classification: "retryable" | "permanent" | "outcome_unknown";
    errorCode: string;
    retryAt?: Date;
    at: Date;
  },
): Promise<void> {
  const normalized = {
    presentationId: requireReference("presentationId", input.presentationId),
    workerId: requireReference("workerId", input.workerId),
    classification: input.classification,
    errorCode: requireReference("errorCode", input.errorCode),
    retryAt: input.retryAt === undefined ? undefined : requireDate(input.retryAt),
    at: requireDate(input.at),
  };
  if (!(["retryable", "permanent", "outcome_unknown"] as const).includes(normalized.classification)) {
    throw new Error("classification is invalid");
  }
  if (
    (normalized.classification === "retryable" &&
      (normalized.retryAt === undefined || normalized.retryAt.getTime() <= normalized.at.getTime())) ||
    (normalized.classification !== "retryable" && normalized.retryAt !== undefined)
  ) throw new Error("retryAt is invalid");

  await withTransaction(dataSource, async (client) => {
    const presentation = await lockPresentation(client, normalized.presentationId);
    const outbox = await lockOwnedOutbox(
      client,
      normalized.presentationId,
      normalized.workerId,
      normalized.at,
      "external_attempting",
    );
    await persistPresentationFailure(client, {
      presentation,
      outbox,
      presentationId: normalized.presentationId,
      classification: normalized.classification,
      errorCode: normalized.errorCode,
      retryAt: normalized.retryAt,
      at: normalized.at,
      operation: "send-fail",
    });
  });
}

async function persistPresentationFailure(
  client: KnowledgeDraftTransactionClient,
  input: {
    presentation: PresentationRow;
    outbox: OutboxRow;
    presentationId: string;
    classification: "retryable" | "permanent" | "outcome_unknown";
    errorCode: string;
    retryAt?: Date;
    at: Date;
    operation: "preparation-fail" | "send-fail";
  },
): Promise<void> {
  if (input.presentation.state !== "pending_send" && input.presentation.state !== "closed") {
    throw new KnowledgeCardPersistenceConflictError();
  }
  const fromVersion = Number(input.presentation.version);
  let toVersion = fromVersion;
  if (input.classification !== "retryable" && input.presentation.state === "pending_send") {
    const result = await client.query(
      `UPDATE knowledge_draft_presentations
       SET state = 'send_failed', version = version + 1
       WHERE id = $1 AND version = $2 AND state = 'pending_send'`,
      [input.presentationId, fromVersion],
    );
    requireOneRow(result);
    toVersion += 1;
  }
  const outboxState = input.classification === "retryable"
    ? "pending"
    : input.classification === "permanent" ? "failed" : "outcome_unknown";
  await client.query(
    `UPDATE knowledge_draft_presentation_outbox
     SET state = $2, worker_id = NULL, lease_until = NULL, retry_at = $3,
         error_code = $4, updated_at = $5
     WHERE id = $1`,
    [input.outbox.id, outboxState, input.retryAt ?? null, input.errorCode, input.at],
  );
  await insertPresentationEvent(client, {
    presentationId: input.presentationId,
    eventType: input.presentation.state === "closed" ? "card_update_failed" : "send_failed",
    operationKey: derivedOperationKey(
      input.operation,
      input.outbox.idempotency_key,
      String(input.outbox.attempts),
    ),
    fromVersion,
    toVersion,
    at: input.at,
  });
}

async function replayInteraction(
  client: KnowledgeDraftTransactionClient,
  input: ReturnType<typeof normalizeInteraction>,
  operationKey: string,
  fingerprint: string,
): Promise<KnowledgeCardInteractionResult | undefined> {
  const result = await client.query<InteractionReplayRow>(
    `SELECT presentation_event.presentation_id, presentation_event.event_type,
            presentation_event.actor_open_id, presentation_event.operation_key,
            draft_event.draft_id, draft_event.operation_fingerprint
     FROM knowledge_draft_presentation_events presentation_event
     LEFT JOIN knowledge_draft_events draft_event
       ON draft_event.operation_key = presentation_event.operation_key
     WHERE presentation_event.callback_event_id = $1`,
    [input.eventId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const expectedEventType = KNOWLEDGE_CARD_ACTION_EVENT_TYPES[input.action].presentation;
  if (
    row.presentation_id !== input.presentationId ||
    row.event_type !== expectedEventType ||
    row.actor_open_id !== input.actorOpenId ||
    row.operation_key !== operationKey ||
    row.draft_id !== input.draftId ||
    row.operation_fingerprint !== fingerprint
  ) throw new KnowledgeCardOperationConflictError();
  return {
    outcome: "already_applied",
    presentation: await requirePresentation(client, row.presentation_id),
    draft: await requireDraftView(client, input.draftId),
  };
}

async function replayPresentationOperation(
  client: KnowledgeDraftTransactionClient,
  operationKey: string,
  fingerprint: string,
): Promise<KnowledgeCardMutationResult | undefined> {
  const result = await client.query<Pick<PresentationRow, "id" | "draft_id"> & {
    operation_fingerprint: string;
  }>(
    `SELECT id, draft_id, operation_fingerprint
     FROM knowledge_draft_presentations WHERE operation_key = $1`,
    [operationKey],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  if (row.operation_fingerprint !== fingerprint) throw new KnowledgeCardOperationConflictError();
  return {
    outcome: "already_applied",
    presentation: await requirePresentation(client, row.id),
    draft: await requireDraftView(client, row.draft_id),
  };
}

async function lockOperation(client: KnowledgeDraftTransactionClient, operationKey: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationKey]);
}

async function lockPresentationId(client: KnowledgeDraftTransactionClient, id: string): Promise<void> {
  await lockOperation(client, derivedOperationKey("presentation-id-lock", id));
}

async function lockDraft(client: KnowledgeDraftTransactionClient, id: string): Promise<DraftHeaderRow> {
  const result = await client.query<DraftHeaderRow>(
    `SELECT id, source_group_id, status, current_revision_number, version
     FROM knowledge_drafts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new KnowledgeCardPersistenceConflictError();
  return row;
}

async function lockPresentation(
  client: KnowledgeDraftTransactionClient,
  id: string,
): Promise<PresentationRow> {
  const result = await client.query<PresentationRow>(
    `${presentationSelect()} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new KnowledgeCardPresentationNotFoundError();
  return row;
}

async function lockOwnedOutbox(
  client: KnowledgeDraftTransactionClient,
  presentationId: string,
  workerId: string,
  at: Date,
  expectedState: "processing" | "external_attempting" = "processing",
): Promise<OutboxRow> {
  const result = await client.query<OutboxRow>(
    `SELECT id, presentation_id, idempotency_key, state, attempts, worker_id, lease_until
     FROM knowledge_draft_presentation_outbox
     WHERE presentation_id = $1 FOR UPDATE`,
    [presentationId],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    row.state !== expectedState ||
    row.worker_id !== workerId ||
    row.lease_until === null ||
    leaseIsExpired(requireDate(row.lease_until), at)
  ) throw new KnowledgeCardPersistenceConflictError();
  return row;
}

async function validateDraftEvidence(
  client: KnowledgeDraftTransactionClient,
  draft: DraftHeaderRow,
): Promise<void> {
  const evidence = await loadDraftEvidence(client, draft.id, Number(draft.current_revision_number));
  await validateCurrentKnowledgeDraftEvidence({
    queryable: client,
    sourceGroupId: draft.source_group_id ?? undefined,
    evidence,
  });
}

async function loadDraftEvidence(
  client: KnowledgeDraftTransactionClient,
  draftId: string,
  revisionNumber: number,
): Promise<KnowledgeDraftEvidenceReference[]> {
  const result = await client.query<EvidenceRow>(
    `SELECT evidence_type, reference_id, source_group_id, entity_version, source_updated_at
     FROM knowledge_draft_revision_evidence
     WHERE draft_id = $1 AND revision_number = $2
     ORDER BY evidence_type ASC, reference_id ASC`,
    [draftId, revisionNumber],
  );
  return result.rows.map((row) => {
    if (row.evidence_type === "conversation_message") {
      return {
        type: "conversation_message",
        id: row.reference_id,
        groupId: requireDatabaseValue(row.source_group_id),
      };
    }
    if (row.evidence_type === "discussion_thread" || row.evidence_type === "action_item") {
      return {
        type: row.evidence_type,
        id: row.reference_id,
        groupId: requireDatabaseValue(row.source_group_id),
        entityVersion: Number(requireDatabaseValue(row.entity_version)),
      };
    }
    return {
      type: "document_source",
      id: row.reference_id,
      expectedUpdatedAt: requireDate(requireDatabaseValue(row.source_updated_at)),
    };
  });
}

async function insertPresentationEvent(
  client: KnowledgeDraftTransactionClient,
  input: {
    presentationId: string;
    eventType:
      | "created"
      | "send_succeeded"
      | "send_failed"
      | "superseded"
      | "card_update_succeeded"
      | "card_update_failed";
    operationKey: string;
    fromVersion?: number;
    toVersion: number;
    at: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_draft_presentation_events (
      id, presentation_id, event_type, operation_key, from_version, to_version, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      input.presentationId,
      input.eventType,
      input.operationKey,
      input.fromVersion ?? null,
      input.toVersion,
      input.at,
    ],
  );
}

async function insertDraftInteractionEvent(
  client: KnowledgeDraftTransactionClient,
  input: {
    draftId: string;
    eventType: "group_confirmed" | "revision_requested" | "rejected";
    fromVersion: number;
    toVersion: number;
    operationKey: string;
    fingerprint: string;
    actor: string;
    reason?: string;
    revisionNumber: number;
    at: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_draft_events (
      id, draft_id, event_type, from_version, to_version, operation_key,
      operation_fingerprint, actor, reason, revision_number, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      randomUUID(),
      input.draftId,
      input.eventType,
      input.fromVersion,
      input.toVersion,
      input.operationKey,
      input.fingerprint,
      input.actor,
      input.reason ?? null,
      input.revisionNumber,
      input.at,
    ],
  );
}

async function insertInteractionPresentationEvent(
  client: KnowledgeDraftTransactionClient,
  input: {
    presentationId: string;
    eventType: "confirmed" | "revision_requested" | "rejected";
    actorOpenId: string;
    operationKey: string;
    callbackEventId: string;
    fromVersion: number;
    toVersion: number;
    at: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_draft_presentation_events (
      id, presentation_id, event_type, actor_open_id, operation_key,
      callback_event_id, from_version, to_version, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      input.presentationId,
      input.eventType,
      input.actorOpenId,
      input.operationKey,
      input.callbackEventId,
      input.fromVersion,
      input.toVersion,
      input.at,
    ],
  );
}

async function loadPresentation(
  queryable: Pick<PostgresKnowledgeDraftDataSource, "query">,
  id: string,
): Promise<KnowledgeDraftPresentation | undefined> {
  const result = await queryable.query<PresentationRow>(`${presentationSelect()} WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row === undefined ? undefined : mapPresentation(row);
}

async function loadPresentationContext(
  dataSource: PostgresKnowledgeDraftDataSource,
  id: string,
): Promise<KnowledgeCardPresentationContext | undefined> {
  return withTransaction(dataSource, async (client) => {
    const presentation = await loadPresentation(client, id);
    if (presentation === undefined) return undefined;
    const draft = await requireDraftView(client, presentation.draftId);
    return {
      presentation,
      draft,
      evidenceState: draft.currentRevision.evidenceState,
    };
  });
}

async function requirePresentation(
  queryable: Pick<PostgresKnowledgeDraftDataSource, "query">,
  id: string,
): Promise<KnowledgeDraftPresentation> {
  const presentation = await loadPresentation(queryable, id);
  if (presentation === undefined) throw new KnowledgeCardPresentationNotFoundError();
  return presentation;
}

async function requireDraftView(client: KnowledgeDraftTransactionClient, id: string) {
  const repository = createPostgresKnowledgeDraftRepository({
    dataSource: client as unknown as PostgresKnowledgeDraftDataSource,
  });
  const draft = await repository.getDraft(id);
  if (draft === undefined) throw new KnowledgeCardPersistenceConflictError();
  return draft;
}

function presentationSelect(): string {
  return `SELECT id, draft_id, revision_number, draft_version, chat_id, content_hash,
                 state, message_id, created_at, activated_at, closed_at, version
          FROM knowledge_draft_presentations`;
}

function mapPresentation(row: PresentationRow): KnowledgeDraftPresentation {
  return {
    id: row.id,
    draftId: row.draft_id,
    revisionNumber: Number(row.revision_number),
    draftVersion: Number(row.draft_version),
    chatId: row.chat_id,
    contentHash: row.content_hash,
    state: row.state,
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    createdAt: requireDate(row.created_at),
    ...(row.activated_at === null ? {} : { activatedAt: requireDate(row.activated_at) }),
    ...(row.closed_at === null ? {} : { closedAt: requireDate(row.closed_at) }),
    version: Number(row.version),
  };
}

function normalizeInteraction(input: ApplyKnowledgeCardInteractionInput) {
  const common = {
    presentationId: requireReference("presentationId", input.presentationId),
    draftId: requireReference("draftId", input.draftId),
    revisionNumber: requirePositiveInteger("revisionNumber", input.revisionNumber),
    draftVersion: requirePositiveInteger("draftVersion", input.draftVersion),
    chatId: requireReference("chatId", input.chatId),
    eventId: requireReference("eventId", input.eventId),
    actorOpenId: requireReference("actorOpenId", input.actorOpenId),
    membershipCheckedAt: requireDate(input.membershipCheckedAt),
    at: requireDate(input.at),
  };
  const membershipAge = common.at.getTime() - common.membershipCheckedAt.getTime();
  if (membershipAge < 0 || membershipAge > 30_000) throw new KnowledgeCardMembershipProofError();

  if (input.action === "confirm") {
    if (input.reason !== undefined) throw new Error("reason is invalid for confirmation");
    if (input.rejectionConfirmed !== undefined) {
      throw new Error("rejectionConfirmed is invalid for confirmation");
    }
    return { ...common, action: "confirm" as const, reason: undefined, rejectionConfirmed: undefined };
  }
  if (input.action === "request_revision") {
    if (input.rejectionConfirmed !== undefined) {
      throw new Error("rejectionConfirmed is invalid for revision request");
    }
    return {
      ...common,
      action: "request_revision" as const,
      reason: requireReason(input.reason),
      rejectionConfirmed: undefined,
    };
  }
  if (input.action === "reject") {
    if (input.rejectionConfirmed !== true) throw new Error("rejectionConfirmed must be true");
    return {
      ...common,
      action: "reject" as const,
      reason: requireReason(input.reason),
      rejectionConfirmed: true as const,
    };
  }
  throw new Error("action is invalid");
}

async function withTransaction<T>(
  dataSource: PostgresKnowledgeDraftDataSource,
  operation: (client: KnowledgeDraftTransactionClient) => Promise<T>,
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

function requireReference(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireReason(value: unknown): string {
  if (typeof value !== "string") throw new Error("reason must be a string");
  const normalized = value.trim();
  if ([...normalized].length < 1 || [...normalized].length > KNOWLEDGE_CARD_REASON_MAX_CHARS) {
    throw new Error("reason is invalid");
  }
  return normalized;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} is invalid`);
  return Number(value);
}

function requireLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 100) {
    throw new Error("limit is invalid");
  }
  return Number(value);
}

function requireContentHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("contentHash is invalid");
  }
  return value;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("date is invalid");
  return new Date(value);
}

// A lease owns [claim time, leaseUntil); equality belongs to the next claimant.
function leaseIsExpired(leaseUntil: Date, at: Date): boolean {
  return leaseUntil.getTime() <= at.getTime();
}

function requireOneRow(result: { rows: unknown[] }): void {
  if ((result as unknown as { rowCount?: number }).rowCount !== 1) {
    throw new KnowledgeCardPersistenceConflictError();
  }
}

function operationFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item))
    .digest("hex");
}

function derivedOperationKey(kind: string, ...parts: string[]): string {
  return `knowledge-card:${kind}:${operationFingerprint(parts)}`;
}

function requireDatabaseValue<T>(value: T | null): T {
  if (value === null) throw new Error("knowledge draft database row is invalid");
  return value;
}
