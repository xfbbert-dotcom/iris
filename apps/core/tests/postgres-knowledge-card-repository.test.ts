import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  KnowledgeCardMembershipProofError,
  KnowledgeCardOperationConflictError,
  KnowledgeCardPersistenceConflictError,
  createPostgresKnowledgeCardRepository,
} from "../src/knowledge-cards/postgres-knowledge-card-repository.js";
import type { KnowledgeCardStatusCounts } from "../src/knowledge-cards/knowledge-card-repository.js";
import { createPostgresKnowledgeDraftRepository } from "../src/knowledge-governance/postgres-knowledge-draft-repository.js";
import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID();
const schema = `knowledge_cards_${suffix.replaceAll("-", "")}`;
const sourceGroupId = `card-group-${suffix}`;
const otherGroupId = `card-other-group-${suffix}`;
const sourceMessageId = `feishu:om-card-${suffix}`;
const sourceMessageProviderId = `om-card-${suffix}`;
const at = new Date("2026-07-19T04:00:00.000Z");

describe("knowledge card migration contract", () => {
  const migration = readFileSync(
    new URL("../migrations/0031_knowledge_draft_presentations.sql", import.meta.url),
    "utf8",
  );

  it("defines immutable presentation and confirmation facts", () => {
    for (const table of [
      "knowledge_draft_presentations",
      "knowledge_draft_presentation_events",
      "knowledge_draft_group_confirmations",
      "knowledge_draft_presentation_outbox",
    ]) expect(migration).toMatch(new RegExp(`create table ${table}`, "iu"));

    expect(migration).toMatch(/knowledge_draft_presentation_events_append_only/iu);
    expect(migration).toMatch(/knowledge_draft_group_confirmations_append_only/iu);
    expect(migration).toMatch(/knowledge_draft_presentations_one_active_idx/iu);
    expect(migration).toMatch(/where state = 'active'/iu);
    expect(migration).toMatch(/unique \(id, draft_id, revision_number\)/iu);
    expect(migration).toMatch(/foreign key \(presentation_id, draft_id, revision_number\)\s+references knowledge_draft_presentations \(id, draft_id, revision_number\)/iu);
    expect(migration).toMatch(/callback_event_id text not null unique/iu);
    expect(migration).toMatch(/drop constraint knowledge_draft_events_event_type_check/iu);
    expect(migration).toMatch(/group_confirmed/iu);
  });
});

runIfDatabase("PostgresKnowledgeCardRepository with Postgres", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let baselineCounts: KnowledgeCardStatusCounts;

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
    await pool.query(
      `
      INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id, message_type,
        text, sent_at, raw_event_idempotency_key, created_at
      ) VALUES ($1, 'feishu', $2, $3, 'ou_author', 'text', 'card evidence', $4, $5, $4)
      `,
      [sourceMessageId, sourceMessageProviderId, sourceGroupId, at, `event-card-${suffix}`],
    );
    baselineCounts = await cardRepository().getStatusCounts();
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  it("creates a pending presentation and payload-free send outbox atomically", async () => {
    const draft = await createDraft("create");
    const repository = cardRepository();
    const created = await repository.createPresentation(presentationInput("create", draft.id));

    expect(created).toMatchObject({
      outcome: "applied",
      presentation: {
        id: id("presentation-create"),
        draftId: draft.id,
        revisionNumber: 1,
        draftVersion: 1,
        chatId: sourceGroupId,
        contentHash: "a".repeat(64),
        state: "pending_send",
        version: 1,
      },
      draft: { id: draft.id, version: 1, status: "pending_confirmation" },
    });
    await expect(repository.getStatusCounts()).resolves.toMatchObject({
      pendingSend: baselineCounts.pendingSend + 1,
    });
    await expect(pool.query(
      `SELECT presentation_id, idempotency_key, state, attempts,
              worker_id, lease_until, retry_at, error_code
       FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1`,
      [created.presentation.id],
    )).resolves.toMatchObject({
      rows: [{
        presentation_id: created.presentation.id,
        idempotency_key: expect.stringMatching(/^knowledge-presentation:[0-9a-f]{64}$/u),
        state: "pending",
        attempts: 0,
        worker_id: null,
        lease_until: null,
        retry_at: null,
        error_code: null,
      }],
    });
    await retireOutbox(created.presentation.id);
  });

  it("replays only an exact presentation operation payload", async () => {
    const draft = await createDraft("replay");
    const repository = cardRepository();
    const input = presentationInput("replay", draft.id);

    await expect(repository.createPresentation(input)).resolves.toMatchObject({ outcome: "applied" });
    await expect(repository.createPresentation(input)).resolves.toMatchObject({
      outcome: "already_applied",
      presentation: { id: input.id },
      draft: { id: draft.id },
    });
    await expect(repository.createPresentation({
      ...input,
      contentHash: "b".repeat(64),
    })).rejects.toBeInstanceOf(KnowledgeCardOperationConflictError);
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM knowledge_draft_presentations WHERE operation_key = $1",
      [input.operationKey],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await retireOutbox(input.id);
  });

  it("fails closed with one domain conflict when presentation ids race", async () => {
    const draft = await createDraft("same-id-race");
    const repository = cardRepository();
    const first = presentationInput("same-id-race-first", draft.id);
    const second = {
      ...presentationInput("same-id-race-second", draft.id),
      id: first.id,
    };

    const results = await Promise.allSettled([
      repository.createPresentation(first),
      repository.createPresentation(second),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(KnowledgeCardOperationConflictError) });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM knowledge_draft_presentations WHERE id = $1",
      [first.id],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await retireOutbox(first.id);
  });

  it("fails closed with one domain conflict when a presentation id races across drafts", async () => {
    const firstDraft = await createDraft("cross-draft-id-race-first");
    const secondDraft = await createDraft("cross-draft-id-race-second");
    const repository = cardRepository();
    const presentationId = id("presentation-cross-draft-id-race");
    const first = {
      ...presentationInput("cross-draft-id-race-first", firstDraft.id),
      id: presentationId,
    };
    const second = {
      ...presentationInput("cross-draft-id-race-second", secondDraft.id),
      id: presentationId,
    };

    const results = await Promise.allSettled([
      repository.createPresentation(first),
      repository.createPresentation(second),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    try {
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({ reason: expect.any(KnowledgeCardOperationConflictError) });
      await expect(pool.query(
        "SELECT count(*)::int AS count FROM knowledge_draft_presentations WHERE id = $1",
        [presentationId],
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      await retireOutbox(presentationId);
    }
  });

  it("rejects stale version, stale revision, wrong group, and wrong draft status", async () => {
    const draft = await createDraft("guards");
    const repository = cardRepository();

    for (const [key, override] of [
      ["wrong-version", { expectedDraftVersion: 2 }],
      ["wrong-revision", { expectedRevisionNumber: 2 }],
      ["wrong-group", { chatId: otherGroupId }],
    ] as const) {
      await expect(repository.createPresentation({
        ...presentationInput(key, draft.id),
        ...override,
      })).rejects.toBeInstanceOf(KnowledgeCardPersistenceConflictError);
    }

    await createPostgresKnowledgeDraftRepository({ dataSource: pool }).rejectDraft({
      id: draft.id,
      expectedVersion: 1,
      operationKey: id("reject-guards"),
      actor: "reviewer",
      reason: "No longer suitable",
      at: plusSeconds(1),
    });
    await expect(repository.createPresentation(
      presentationInput("terminal", draft.id, { expectedDraftVersion: 2 }),
    )).rejects.toBeInstanceOf(KnowledgeCardPersistenceConflictError);
  });

  it("checks current evidence before creating any presentation facts", async () => {
    const invalidMessageId = `feishu:om-card-invalid-${suffix}`;
    const invalidProviderMessageId = `om-card-invalid-${suffix}`;
    await pool.query(
      `INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id, message_type,
        text, sent_at, raw_event_idempotency_key, created_at
      ) VALUES ($1, 'feishu', $2, $3, 'ou_author', 'text', 'temporary', $4, $5, $4)`,
      [invalidMessageId, invalidProviderMessageId, sourceGroupId, at, id("invalid-message-event")],
    );
    const draft = await createDraft("invalid-evidence", invalidMessageId);
    await pool.query(
      `INSERT INTO conversation_message_deletion_tombstones (
        provider, provider_message_id, conversation_message_id, chat_id, deleted_at
      ) VALUES ('feishu', $1, $2, $3, $4)`,
      [invalidProviderMessageId, invalidMessageId, sourceGroupId, plusSeconds(1)],
    );
    await pool.query("DELETE FROM conversation_messages WHERE id = $1", [invalidMessageId]);

    const input = presentationInput("invalid-evidence", draft.id);
    await expect(cardRepository().createPresentation(input)).rejects.toMatchObject({
      name: "KnowledgeDraftEvidenceError",
      reason: "message_deleted",
    });
    await expect(cardRepository().getPresentation(input.id)).resolves.toBeUndefined();
  });

  it("claims, completes, retries, and permanently fails sends with exact lease ownership", async () => {
    const repository = cardRepository();
    const firstDraft = await createDraft("send-success");
    const first = await repository.createPresentation(presentationInput("send-success", firstDraft.id));
    const leaseUntil = plusSeconds(30);

    await expect(repository.claimPresentationSend({
      workerId: "worker-1",
      leaseUntil,
      at,
    })).resolves.toMatchObject({
      presentation: { id: first.presentation.id, state: "pending_send" },
      workerId: "worker-1",
      leaseUntil,
    });
    await expect(repository.completePresentationSend({
      presentationId: first.presentation.id,
      workerId: "worker-2",
      messageId: "om-wrong-worker",
      at: plusSeconds(1),
    })).rejects.toBeInstanceOf(KnowledgeCardPersistenceConflictError);
    await repository.completePresentationSend({
      presentationId: first.presentation.id,
      workerId: "worker-1",
      messageId: "om-card-sent",
      at: plusSeconds(1),
    });
    await expect(repository.getPresentation(first.presentation.id)).resolves.toMatchObject({
      state: "active",
      messageId: "om-card-sent",
      activatedAt: plusSeconds(1),
      version: 2,
    });

    const retryDraft = await createDraft("send-retry");
    const retry = await repository.createPresentation(presentationInput("send-retry", retryDraft.id));
    await repository.claimPresentationSend({ workerId: "worker-1", leaseUntil, at });
    await repository.failPresentationSend({
      presentationId: retry.presentation.id,
      workerId: "worker-1",
      classification: "retryable",
      errorCode: "rate_limited",
      retryAt: plusSeconds(60),
      at: plusSeconds(2),
    });
    await expect(repository.claimPresentationSend({
      workerId: "worker-2",
      leaseUntil: plusSeconds(90),
      at: plusSeconds(59),
    })).resolves.toBeUndefined();
    await expect(repository.claimPresentationSend({
      workerId: "worker-2",
      leaseUntil: plusSeconds(120),
      at: plusSeconds(60),
    })).resolves.toMatchObject({ presentation: { id: retry.presentation.id }, workerId: "worker-2" });
    await repository.failPresentationSend({
      presentationId: retry.presentation.id,
      workerId: "worker-2",
      classification: "permanent",
      errorCode: "forbidden",
      at: plusSeconds(61),
    });
    await expect(repository.getPresentation(retry.presentation.id)).resolves.toMatchObject({
      state: "send_failed",
      version: 2,
    });
  });

  it("keeps outcome-unknown sends out of automatic retry", async () => {
    const repository = cardRepository();
    const draft = await createDraft("send-unknown");
    const created = await repository.createPresentation(presentationInput("send-unknown", draft.id));
    await repository.claimPresentationSend({ workerId: "worker-1", leaseUntil: plusSeconds(30), at });
    await repository.failPresentationSend({
      presentationId: created.presentation.id,
      workerId: "worker-1",
      classification: "outcome_unknown",
      errorCode: "timeout",
      at: plusSeconds(1),
    });

    await expect(repository.claimPresentationSend({
      workerId: "worker-2",
      leaseUntil: plusSeconds(120),
      at: plusSeconds(90),
    })).resolves.toBeUndefined();
    await expect(repository.getPresentation(created.presentation.id)).resolves.toMatchObject({
      state: "pending_send",
      version: 1,
    });
  });

  it("expires the old owner before completion at the exact lease boundary", async () => {
    const repository = cardRepository();
    const draft = await createDraft("complete-lease-boundary");
    const created = await repository.createPresentation(
      presentationInput("complete-lease-boundary", draft.id),
    );
    await repository.claimPresentationSend({
      workerId: "worker-expiring-complete",
      leaseUntil: plusSeconds(30),
      at,
    });

    await expect(repository.completePresentationSend({
      presentationId: created.presentation.id,
      workerId: "worker-expiring-complete",
      messageId: "om-expired-complete",
      at: plusSeconds(30),
    })).rejects.toBeInstanceOf(KnowledgeCardPersistenceConflictError);
    await expect(repository.claimPresentationSend({
      workerId: "worker-reclaim-complete",
      leaseUntil: plusSeconds(60),
      at: plusSeconds(30),
    })).resolves.toMatchObject({ presentation: { id: created.presentation.id } });
    await repository.completePresentationSend({
      presentationId: created.presentation.id,
      workerId: "worker-reclaim-complete",
      messageId: "om-reclaimed-complete",
      at: plusSeconds(31),
    });
  });

  it("expires the old owner before failure at the exact lease boundary", async () => {
    const repository = cardRepository();
    const draft = await createDraft("fail-lease-boundary");
    const created = await repository.createPresentation(
      presentationInput("fail-lease-boundary", draft.id),
    );
    await repository.claimPresentationSend({
      workerId: "worker-expiring-fail",
      leaseUntil: plusSeconds(30),
      at,
    });

    await expect(repository.failPresentationSend({
      presentationId: created.presentation.id,
      workerId: "worker-expiring-fail",
      classification: "permanent",
      errorCode: "expired_owner",
      at: plusSeconds(30),
    })).rejects.toBeInstanceOf(KnowledgeCardPersistenceConflictError);
    await expect(repository.claimPresentationSend({
      workerId: "worker-reclaim-fail",
      leaseUntil: plusSeconds(60),
      at: plusSeconds(30),
    })).resolves.toMatchObject({ presentation: { id: created.presentation.id } });
    await repository.failPresentationSend({
      presentationId: created.presentation.id,
      workerId: "worker-reclaim-fail",
      classification: "permanent",
      errorCode: "forbidden",
      at: plusSeconds(31),
    });
  });

  it("supersedes older pending and active presentations before enqueueing the replacement", async () => {
    const repository = cardRepository();
    const draft = await createDraft("supersede");
    const pending = await repository.createPresentation(presentationInput("supersede-pending", draft.id));
    const active = await repository.createPresentation(presentationInput("supersede-active", draft.id, {
      at: plusSeconds(1),
    }));

    await expect(repository.getPresentation(pending.presentation.id)).resolves.toMatchObject({
      state: "superseded",
      version: 2,
    });
    await repository.claimPresentationSend({
      workerId: "worker-supersede",
      leaseUntil: plusSeconds(31),
      at: plusSeconds(1),
    });
    await repository.completePresentationSend({
      presentationId: active.presentation.id,
      workerId: "worker-supersede",
      messageId: "om-active-before-supersede",
      at: plusSeconds(2),
    });
    const replacement = await repository.createPresentation(presentationInput("supersede-replacement", draft.id, {
      at: plusSeconds(3),
    }));

    await expect(repository.getPresentation(active.presentation.id)).resolves.toMatchObject({
      state: "superseded",
      messageId: "om-active-before-supersede",
      version: 3,
    });
    await expect(repository.listPresentations({ draftId: draft.id, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: replacement.presentation.id, state: "pending_send" }),
      expect.objectContaining({ id: active.presentation.id, state: "superseded" }),
      expect.objectContaining({ id: pending.presentation.id, state: "superseded" }),
    ]);
    await retireOutbox(replacement.presentation.id);
  });

  it("confirms one exact active presentation and records all facts atomically", async () => {
    const { draft, presentation, messageId } = await createActivePresentation("confirm");
    const repository = cardRepository();
    const input = interactionInput("confirm", draft.id, presentation.id, { action: "confirm" });

    const result = await repository.applyInteraction(input);

    expect(result).toMatchObject({
      outcome: "applied",
      presentation: {
        id: presentation.id,
        state: "closed",
        messageId,
        closedAt: input.at,
        version: 3,
      },
      draft: { id: draft.id, status: "pending_review", version: 2 },
    });
    await expect(pool.query(
      `SELECT draft_id, revision_number, presentation_id, actor_open_id,
              callback_event_id, membership_checked_at, confirmed_at
       FROM knowledge_draft_group_confirmations WHERE callback_event_id = $1`,
      [input.eventId],
    )).resolves.toMatchObject({
      rows: [{
        draft_id: draft.id,
        revision_number: 1,
        presentation_id: presentation.id,
        actor_open_id: input.actorOpenId,
        callback_event_id: input.eventId,
        membership_checked_at: input.membershipCheckedAt,
        confirmed_at: input.at,
      }],
    });
    await expect(pool.query(
      `SELECT event_type, from_version::int, to_version::int, actor, reason
       FROM knowledge_draft_events WHERE draft_id = $1 ORDER BY created_at, id`,
      [draft.id],
    )).resolves.toMatchObject({
      rows: [
        { event_type: "created", from_version: null, to_version: 1, actor: "iris", reason: null },
        {
          event_type: "group_confirmed",
          from_version: 1,
          to_version: 2,
          actor: input.actorOpenId,
          reason: null,
        },
      ],
    });
    await expect(pool.query(
      `SELECT event_type, callback_event_id, actor_open_id, from_version::int, to_version::int
       FROM knowledge_draft_presentation_events
       WHERE presentation_id = $1 AND callback_event_id IS NOT NULL`,
      [presentation.id],
    )).resolves.toMatchObject({
      rows: [{
        event_type: "confirmed",
        callback_event_id: input.eventId,
        actor_open_id: input.actorOpenId,
        from_version: 2,
        to_version: 3,
      }],
    });
    await expect(pool.query(
      `SELECT state, attempts, worker_id, lease_until, retry_at, error_code, idempotency_key
       FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1`,
      [presentation.id],
    )).resolves.toMatchObject({
      rows: [{
        state: "pending",
        attempts: 0,
        worker_id: null,
        lease_until: null,
        retry_at: null,
        error_code: null,
        idempotency_key: expect.stringMatching(/^knowledge-card-update:[0-9a-f]{64}$/u),
      }],
    });
    await expect(repository.claimPresentationSend({
      workerId: "worker-card-update",
      leaseUntil: plusSeconds(40),
      at: plusSeconds(11),
    })).resolves.toMatchObject({ presentation: { id: presentation.id, state: "closed" } });
    await repository.completePresentationSend({
      presentationId: presentation.id,
      workerId: "worker-card-update",
      messageId,
      at: plusSeconds(12),
    });
    await expect(repository.getPresentation(presentation.id)).resolves.toMatchObject({
      state: "closed",
      version: 3,
    });
    await expect(pool.query(
      `SELECT state FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1`,
      [presentation.id],
    )).resolves.toMatchObject({ rows: [{ state: "sent" }] });
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM knowledge_draft_presentation_events
       WHERE presentation_id = $1 AND event_type = 'card_update_succeeded'`,
      [presentation.id],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("requests revision with a bounded reason and closes the presentation", async () => {
    const { draft, presentation } = await createActivePresentation("request-revision");
    const repository = cardRepository();

    await expect(repository.applyInteraction(interactionInput(
      "request-revision-blank",
      draft.id,
      presentation.id,
      { action: "request_revision", reason: " " },
    ))).rejects.toThrow(/reason/iu);
    const input = interactionInput("request-revision", draft.id, presentation.id, {
      action: "request_revision",
      reason: "  Add rollback ownership.  ",
    });
    await expect(repository.applyInteraction(input)).resolves.toMatchObject({
      outcome: "applied",
      presentation: { state: "closed", version: 3 },
      draft: { status: "needs_revision", version: 2 },
    });
    await expect(pool.query(
      `SELECT event_type, reason FROM knowledge_draft_events
       WHERE draft_id = $1 AND event_type = 'revision_requested'`,
      [draft.id],
    )).resolves.toMatchObject({
      rows: [{ event_type: "revision_requested", reason: "Add rollback ownership." }],
    });
    await retireOutbox(presentation.id);
  });

  it("rejects with explicit confirmation and records the normalized reason", async () => {
    const { draft, presentation } = await createActivePresentation("reject");
    const repository = cardRepository();
    const unconfirmed = {
      ...interactionBase("reject-unconfirmed", draft.id, presentation.id),
      action: "reject",
      reason: "Unsafe",
    };
    await expect(repository.applyInteraction(unconfirmed as never)).rejects.toThrow(/rejectionConfirmed/iu);

    const input = interactionInput("reject", draft.id, presentation.id, {
      action: "reject",
      reason: "  Evidence is too weak.  ",
      rejectionConfirmed: true,
    });
    await expect(repository.applyInteraction(input)).resolves.toMatchObject({
      outcome: "applied",
      presentation: { state: "closed", version: 3 },
      draft: {
        status: "rejected",
        version: 2,
        rejectedAt: input.at,
        rejectedBy: input.actorOpenId,
        rejectionReason: "Evidence is too weak.",
      },
    });
    await retireOutbox(presentation.id);
  });

  it("returns already_applied only for an exact callback replay", async () => {
    const { draft, presentation } = await createActivePresentation("callback-replay");
    const repository = cardRepository();
    const input = interactionInput("callback-replay", draft.id, presentation.id, { action: "confirm" });

    await expect(repository.applyInteraction(input)).resolves.toMatchObject({ outcome: "applied" });
    await expect(repository.applyInteraction(input)).resolves.toMatchObject({
      outcome: "already_applied",
      presentation: { id: presentation.id, state: "closed" },
      draft: { id: draft.id, status: "pending_review" },
    });
    await expect(repository.applyInteraction({
      ...input,
      action: "request_revision",
      reason: "Different action",
    } as never)).rejects.toBeInstanceOf(KnowledgeCardOperationConflictError);
    await expect(repository.applyInteraction({
      ...input,
      actorOpenId: "ou_different_actor",
    })).rejects.toBeInstanceOf(KnowledgeCardOperationConflictError);
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM knowledge_draft_group_confirmations WHERE callback_event_id = $1",
      [input.eventId],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await retireOutbox(presentation.id);
  });

  it("returns already_applied for an exact request-revision callback replay", async () => {
    const { draft, presentation } = await createActivePresentation("request-revision-replay");
    const repository = cardRepository();
    const input = interactionInput(
      "request-revision-replay",
      draft.id,
      presentation.id,
      { action: "request_revision", reason: "Clarify the owner." },
    );

    await expect(repository.applyInteraction(input)).resolves.toMatchObject({ outcome: "applied" });
    try {
      await expect(repository.applyInteraction(input)).resolves.toMatchObject({
        outcome: "already_applied",
        presentation: { id: presentation.id, state: "closed" },
        draft: { id: draft.id, status: "needs_revision" },
      });
    } finally {
      await retireOutbox(presentation.id);
    }
  });

  it("returns already_applied for an exact reject callback replay", async () => {
    const { draft, presentation } = await createActivePresentation("reject-replay");
    const repository = cardRepository();
    const input = interactionInput("reject-replay", draft.id, presentation.id, {
      action: "reject",
      reason: "Evidence is insufficient.",
      rejectionConfirmed: true,
    });

    await expect(repository.applyInteraction(input)).resolves.toMatchObject({ outcome: "applied" });
    try {
      await expect(repository.applyInteraction(input)).resolves.toMatchObject({
        outcome: "already_applied",
        presentation: { id: presentation.id, state: "closed" },
        draft: { id: draft.id, status: "rejected" },
      });
    } finally {
      await retireOutbox(presentation.id);
    }
  });

  it("rejects callbacks bound to stale or mismatched presentation facts", async () => {
    const { draft, presentation } = await createActivePresentation("binding-guards");
    const repository = cardRepository();
    const base = interactionInput("binding-guards", draft.id, presentation.id, { action: "confirm" });
    for (const [key, override] of [
      ["draft", { draftId: id("another-draft") }],
      ["revision", { revisionNumber: 2 }],
      ["version", { draftVersion: 2 }],
      ["chat", { chatId: otherGroupId }],
    ] as const) {
      await expect(repository.applyInteraction({
        ...base,
        eventId: id(`event-binding-${key}`),
        ...override,
      })).rejects.toBeInstanceOf(KnowledgeCardPersistenceConflictError);
    }
  });

  it("makes an old presentation stale when the draft advances to a new revision", async () => {
    const { draft, presentation } = await createActivePresentation("stale-revision");
    const drafts = createPostgresKnowledgeDraftRepository({ dataSource: pool });
    await drafts.requestRevision({
      id: draft.id,
      expectedVersion: 1,
      operationKey: id("stale-revision-request"),
      actor: "reviewer",
      reason: "Revise this",
      at: plusSeconds(5),
    });
    await drafts.reviseDraft({
      id: draft.id,
      expectedVersion: 2,
      operationKey: id("stale-revision-revise"),
      actor: "iris",
      at: plusSeconds(6),
      revision: {
        sourceGroupId,
        title: "Revised card draft",
        content: "A newer revision",
        riskLevel: "medium",
        evidence: [{ type: "conversation_message", id: sourceMessageId, groupId: sourceGroupId }],
      },
    });

    await expect(cardRepository().applyInteraction(interactionInput(
      "stale-revision",
      draft.id,
      presentation.id,
      { action: "confirm" },
    ))).rejects.toBeInstanceOf(KnowledgeCardPersistenceConflictError);
    await expect(cardRepository().getPresentation(presentation.id)).resolves.toMatchObject({ state: "active" });
  });

  it("allows exactly one concurrent confirm or reject transition", async () => {
    const { draft, presentation } = await createActivePresentation("concurrent");
    const repository = cardRepository();
    const results = await Promise.allSettled([
      repository.applyInteraction(interactionInput("concurrent-confirm", draft.id, presentation.id, {
        action: "confirm",
      })),
      repository.applyInteraction(interactionInput("concurrent-reject", draft.id, presentation.id, {
        action: "reject",
        reason: "Reject concurrently",
        rejectionConfirmed: true,
      })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "fulfilled")).toMatchObject({
      value: { outcome: "applied" },
    });
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM knowledge_draft_presentation_events
       WHERE presentation_id = $1 AND callback_event_id IS NOT NULL`,
      [presentation.id],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(cardRepository().getPresentation(presentation.id)).resolves.toMatchObject({ state: "closed" });
    await retireOutbox(presentation.id);
  });

  it("rejects membership proof older than 30 seconds", async () => {
    const { draft, presentation } = await createActivePresentation("stale-membership");
    const input = interactionInput("stale-membership", draft.id, presentation.id, { action: "confirm" });

    await expect(cardRepository().applyInteraction({
      ...input,
      membershipCheckedAt: plusSeconds(9),
      at: plusSeconds(40),
    })).rejects.toBeInstanceOf(KnowledgeCardMembershipProofError);
    await expect(cardRepository().getPresentation(presentation.id)).resolves.toMatchObject({ state: "active" });
  });

  it("checks current evidence inside the interaction transaction", async () => {
    const evidenceMessageId = `feishu:om-card-action-invalid-${suffix}`;
    const providerMessageId = `om-card-action-invalid-${suffix}`;
    await pool.query(
      `INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id, message_type,
        text, sent_at, raw_event_idempotency_key, created_at
      ) VALUES ($1, 'feishu', $2, $3, 'ou_author', 'text', 'temporary action evidence', $4, $5, $4)`,
      [evidenceMessageId, providerMessageId, sourceGroupId, at, id("action-invalid-event")],
    );
    const { draft, presentation } = await createActivePresentation(
      "invalid-action-evidence",
      evidenceMessageId,
    );
    await pool.query(
      `INSERT INTO conversation_message_deletion_tombstones (
        provider, provider_message_id, conversation_message_id, chat_id, deleted_at
      ) VALUES ('feishu', $1, $2, $3, $4)`,
      [providerMessageId, evidenceMessageId, sourceGroupId, plusSeconds(5)],
    );
    await pool.query("DELETE FROM conversation_messages WHERE id = $1", [evidenceMessageId]);

    await expect(cardRepository().applyInteraction(interactionInput(
      "invalid-action-evidence",
      draft.id,
      presentation.id,
      { action: "confirm" },
    ))).rejects.toMatchObject({ name: "KnowledgeDraftEvidenceError", reason: "message_deleted" });
    await expect(createPostgresKnowledgeDraftRepository({ dataSource: pool }).getDraft(draft.id))
      .resolves.toMatchObject({ status: "pending_confirmation", version: 1 });
    await expect(cardRepository().getPresentation(presentation.id)).resolves.toMatchObject({ state: "active" });
  });

  function cardRepository() {
    return createPostgresKnowledgeCardRepository({ dataSource: pool });
  }

  async function createDraft(key: string, messageId = sourceMessageId) {
    const result = await createPostgresKnowledgeDraftRepository({ dataSource: pool }).createDraft({
      id: id(`draft-${key}`),
      operationKey: id(`draft-create-${key}`),
      originKind: "group_conclusion",
      createdBy: "iris",
      at,
      revision: {
        sourceGroupId,
        title: `Card draft ${key}`,
        content: `Current content for ${key}`,
        riskLevel: "medium",
        evidence: [{ type: "conversation_message", id: messageId, groupId: sourceGroupId }],
      },
    });
    return result.draft;
  }

  async function createActivePresentation(key: string, evidenceMessageId = sourceMessageId) {
    const draft = await createDraft(key, evidenceMessageId);
    const repository = cardRepository();
    const created = await repository.createPresentation(presentationInput(key, draft.id));
    const workerId = id(`worker-${key}`);
    await expect(repository.claimPresentationSend({
      workerId,
      leaseUntil: plusSeconds(30),
      at,
    })).resolves.toMatchObject({ presentation: { id: created.presentation.id } });
    const messageId = id(`om-active-${key}`);
    await repository.completePresentationSend({
      presentationId: created.presentation.id,
      workerId,
      messageId,
      at: plusSeconds(1),
    });
    return { draft, presentation: (await repository.getPresentation(created.presentation.id))!, messageId };
  }

  async function retireOutbox(presentationId: string): Promise<void> {
    await pool.query(
      `UPDATE knowledge_draft_presentation_outbox
       SET state = 'failed', error_code = 'test_retired', updated_at = $2
       WHERE presentation_id = $1`,
      [presentationId, at],
    );
  }
});

function presentationInput(
  key: string,
  draftId: string,
  override: Partial<{
    expectedDraftVersion: number;
    expectedRevisionNumber: number;
    chatId: string;
    at: Date;
  }> = {},
) {
  return {
    id: id(`presentation-${key}`),
    draftId,
    expectedDraftVersion: 1,
    expectedRevisionNumber: 1,
    chatId: sourceGroupId,
    contentHash: "a".repeat(64),
    operationKey: id(`presentation-create-${key}`),
    at,
    ...override,
  };
}

function interactionBase(key: string, draftId: string, presentationId: string) {
  return {
    presentationId,
    draftId,
    revisionNumber: 1,
    draftVersion: 1,
    chatId: sourceGroupId,
    eventId: id(`callback-${key}`),
    actorOpenId: "ou_group_member",
    membershipCheckedAt: plusSeconds(9),
    at: plusSeconds(10),
  };
}

function interactionInput(
  key: string,
  draftId: string,
  presentationId: string,
  action:
    | { action: "confirm" }
    | { action: "request_revision"; reason: string }
    | { action: "reject"; reason: string; rejectionConfirmed: true },
) {
  return { ...interactionBase(key, draftId, presentationId), ...action };
}

function plusSeconds(seconds: number): Date {
  return new Date(at.getTime() + seconds * 1_000);
}

function id(value: string): string {
  return `${value}-${suffix}`;
}
