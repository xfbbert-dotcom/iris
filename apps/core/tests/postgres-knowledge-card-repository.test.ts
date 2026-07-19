import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApprovalInteractionWorker } from "../src/knowledge-cards/approval-interaction-worker.js";
import { createKnowledgeCardDispatcher } from "../src/knowledge-cards/knowledge-card-dispatcher.js";
import type { ApprovalInteractionJob } from "../src/knowledge-cards/knowledge-card.js";
import {
  KnowledgeCardMembershipProofError,
  KnowledgeCardOperationConflictError,
  KnowledgeCardPersistenceConflictError,
  KnowledgeCardPresentationConflictError,
  createPostgresKnowledgeCardRepository,
} from "../src/knowledge-cards/postgres-knowledge-card-repository.js";
import type { KnowledgeCardStatusCounts } from "../src/knowledge-cards/knowledge-card-repository.js";
import {
  createPostgresKnowledgeDraftRepository,
  type PostgresKnowledgeDraftDataSource,
} from "../src/knowledge-governance/postgres-knowledge-draft-repository.js";
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
    expect(migration).toMatch(
      /state text not null check \(state in \(\s*'pending', 'processing', 'external_attempting', 'sent', 'failed', 'outcome_unknown'\s*\)\)/iu,
    );
  });

  it("maps content-free outbox state and terminal-failure counts", async () => {
    const dataSource = {
      query: vi.fn(async () => ({
        rows: [{
          pending: "1",
          processing: "2",
          external_attempting: "3",
          sent: "4",
          failed: "5",
          outcome_unknown: "6",
          terminal_failed: "2",
        }],
      })),
    } as unknown as PostgresKnowledgeDraftDataSource;

    await expect(
      createPostgresKnowledgeCardRepository({ dataSource }).getOutboxStatusCounts(),
    ).resolves.toEqual({
      pending: 1,
      processing: 2,
      external_attempting: 3,
      sent: 4,
      failed: 5,
      outcome_unknown: 6,
      terminalFailed: 2,
    });
    expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining(
      "count(*) FILTER (WHERE state = 'external_attempting')",
    ));
  });

  it("locks supersession presentations before outboxes and rejects external attempts", async () => {
    const queries: string[] = [];
    const draftId = id("draft-scripted-supersession-lock");
    const originalPresentationId = id("presentation-scripted-supersession-original");
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replaceAll(/\s+/gu, " ").trim();
        queries.push(normalized);
        if (normalized.includes("FROM knowledge_drafts WHERE id = $1 FOR UPDATE")) {
          return {
            rows: [{
              id: draftId,
              source_group_id: sourceGroupId,
              status: "pending_confirmation",
              current_revision_number: 1,
              version: 1,
            }],
          };
        }
        if (normalized.includes("FROM knowledge_draft_presentations presentation")) {
          return { rows: [{ id: originalPresentationId, version: 1 }] };
        }
        if (normalized.includes("FROM knowledge_draft_presentation_outbox outbox")) {
          return {
            rows: [{
              id: id("outbox-scripted-supersession"),
              presentation_id: originalPresentationId,
              idempotency_key: id("idempotency-scripted-supersession"),
              state: "external_attempting",
              attempts: 1,
              worker_id: "worker-scripted-supersession",
              lease_until: plusSeconds(30),
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const dataSource = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PostgresKnowledgeDraftDataSource;

    await expect(createPostgresKnowledgeCardRepository({ dataSource }).createPresentation({
      ...presentationInput("scripted-supersession-replacement", draftId),
      id: id("presentation-scripted-supersession-replacement"),
    })).rejects.toBeInstanceOf(KnowledgeCardPresentationConflictError);

    const presentationLock = queries.findIndex((sql) => sql.includes("FOR UPDATE OF presentation"));
    const outboxLock = queries.findIndex((sql) => sql.includes("FOR UPDATE OF outbox"));
    expect(presentationLock).toBeGreaterThan(-1);
    expect(outboxLock).toBeGreaterThan(presentationLock);
    expect(queries.some((sql) => sql.includes("SET state = 'superseded'"))).toBe(false);
    expect(queries.some((sql) => sql.includes("INSERT INTO knowledge_draft_presentations"))).toBe(false);
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("discovers presentation identity before locking draft then presentation", async () => {
    const queries: string[] = [];
    const draftId = id("draft-scripted-interaction-lock-order");
    const presentationId = id("presentation-scripted-interaction-lock-order");
    const stopAfterLocks = new Error("stop after interaction row locks");
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replaceAll(/\s+/gu, " ").trim();
        queries.push(normalized);
        if (
          normalized === "SELECT draft_id FROM knowledge_draft_presentations WHERE id = $1"
        ) return { rows: [{ draft_id: draftId }] };
        if (normalized.includes("FROM knowledge_drafts WHERE id = $1 FOR UPDATE")) {
          return {
            rows: [{
              id: draftId,
              source_group_id: sourceGroupId,
              status: "pending_confirmation",
              current_revision_number: 1,
              version: 1,
            }],
          };
        }
        if (normalized.includes("FROM knowledge_draft_presentations WHERE id = $1 FOR UPDATE")) {
          return {
            rows: [{
              id: presentationId,
              draft_id: draftId,
              revision_number: 1,
              draft_version: 1,
              chat_id: sourceGroupId,
              content_hash: "a".repeat(64),
              state: "active",
              message_id: "om_scripted_lock_order",
              created_at: at,
              activated_at: at,
              closed_at: null,
              version: 2,
            }],
          };
        }
        if (normalized.startsWith("UPDATE knowledge_drafts")) throw stopAfterLocks;
        return { rows: [] };
      }),
    };
    const dataSource = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PostgresKnowledgeDraftDataSource;

    await expect(createPostgresKnowledgeCardRepository({ dataSource }).applyInteraction(
      interactionInput("scripted-interaction-lock-order", draftId, presentationId, {
        action: "confirm",
      }),
    )).rejects.toBe(stopAfterLocks);

    const identityLookup = queries.findIndex((sql) =>
      sql === "SELECT draft_id FROM knowledge_draft_presentations WHERE id = $1"
    );
    const draftLock = queries.findIndex((sql) =>
      sql.includes("FROM knowledge_drafts WHERE id = $1 FOR UPDATE")
    );
    const presentationLock = queries.findIndex((sql) =>
      sql.includes("FROM knowledge_draft_presentations WHERE id = $1 FOR UPDATE")
    );
    expect(identityLookup).toBeGreaterThan(-1);
    expect(draftLock).toBeGreaterThan(identityLookup);
    expect(presentationLock).toBeGreaterThan(draftLock);
    expect(queries.at(-1)).toBe("ROLLBACK");
  });
});

runIfDatabase("PostgresKnowledgeCardRepository with Postgres", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let isolatedDatabaseUrl: string;
  let baselineCounts: KnowledgeCardStatusCounts;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    isolatedDatabaseUrl = isolatedUrl.toString();
    pool = new pg.Pool({ connectionString: isolatedDatabaseUrl });
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

  it("reports outbox state counts while excluding superseded rows from terminal failures", async () => {
    const repository = cardRepository();
    const before = await repository.getOutboxStatusCounts();
    const draft = await createDraft("outbox-status");
    const created = await repository.createPresentation(
      presentationInput("outbox-status", draft.id),
    );

    await expect(repository.getOutboxStatusCounts()).resolves.toEqual({
      ...before,
      pending: before.pending + 1,
    });
    await pool.query(
      `UPDATE knowledge_draft_presentation_outbox
       SET state = 'failed', error_code = 'superseded', updated_at = $2
       WHERE presentation_id = $1`,
      [created.presentation.id, at],
    );
    await expect(repository.getOutboxStatusCounts()).resolves.toEqual({
      ...before,
      failed: before.failed + 1,
    });
    await pool.query(
      `UPDATE knowledge_draft_presentation_outbox
       SET error_code = 'max_attempts_exhausted', updated_at = $2
       WHERE presentation_id = $1`,
      [created.presentation.id, plusSeconds(1)],
    );
    await expect(repository.getOutboxStatusCounts()).resolves.toEqual({
      ...before,
      failed: before.failed + 1,
      terminalFailed: before.terminalFailed + 1,
    });
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
    await repository.beginExternalAttempt({
      presentationId: first.presentation.id,
      workerId: "worker-1",
      at: plusSeconds(1),
    });
    await repository.completePresentationSend({
      presentationId: first.presentation.id,
      workerId: "worker-1",
      messageId: "om-card-sent",
      at: plusSeconds(2),
    });
    await expect(repository.getPresentation(first.presentation.id)).resolves.toMatchObject({
      state: "active",
      messageId: "om-card-sent",
      activatedAt: plusSeconds(2),
      version: 2,
    });

    const retryDraft = await createDraft("send-retry");
    const retry = await repository.createPresentation(presentationInput("send-retry", retryDraft.id));
    await repository.claimPresentationSend({ workerId: "worker-1", leaseUntil, at });
    await repository.beginExternalAttempt({
      presentationId: retry.presentation.id,
      workerId: "worker-1",
      at: plusSeconds(1),
    });
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
    await repository.beginExternalAttempt({
      presentationId: retry.presentation.id,
      workerId: "worker-2",
      at: plusSeconds(61),
    });
    await repository.failPresentationSend({
      presentationId: retry.presentation.id,
      workerId: "worker-2",
      classification: "permanent",
      errorCode: "forbidden",
      at: plusSeconds(62),
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
    await repository.beginExternalAttempt({
      presentationId: created.presentation.id,
      workerId: "worker-1",
      at: plusSeconds(1),
    });
    await repository.failPresentationSend({
      presentationId: created.presentation.id,
      workerId: "worker-1",
      classification: "outcome_unknown",
      errorCode: "timeout",
      at: plusSeconds(2),
    });

    await expect(repository.claimPresentationSend({
      workerId: "worker-2",
      leaseUntil: plusSeconds(120),
      at: plusSeconds(90),
    })).resolves.toBeUndefined();
    await expect(repository.getPresentation(created.presentation.id)).resolves.toMatchObject({
      state: "send_failed",
      version: 2,
    });
  });

  it("requires a lease-owned durable external attempt before completing a send", async () => {
    const repository = cardRepository() as ReturnType<typeof cardRepository> & {
      beginExternalAttempt(input: {
        presentationId: string;
        workerId: string;
        at: Date;
      }): Promise<void>;
    };
    const draft = await createDraft("durable-external-boundary");
    const created = await repository.createPresentation(
      presentationInput("durable-external-boundary", draft.id),
    );

    await expect(repository.claimPresentationSend({
      workerId: "worker-boundary",
      leaseUntil: plusSeconds(30),
      at,
    })).resolves.toMatchObject({ attempts: 1 });
    await expect(repository.completePresentationSend({
      presentationId: created.presentation.id,
      workerId: "worker-boundary",
      messageId: "om_must_not_complete_before_attempt",
      at: plusSeconds(1),
    })).rejects.toBeInstanceOf(KnowledgeCardPersistenceConflictError);

    await repository.beginExternalAttempt({
      presentationId: created.presentation.id,
      workerId: "worker-boundary",
      at: plusSeconds(1),
    });
    await expect(repository.beginExternalAttempt({
      presentationId: created.presentation.id,
      workerId: "worker-other",
      at: plusSeconds(2),
    })).rejects.toBeInstanceOf(KnowledgeCardPersistenceConflictError);
    await repository.completePresentationSend({
      presentationId: created.presentation.id,
      workerId: "worker-boundary",
      messageId: "om_after_durable_attempt",
      at: plusSeconds(2),
    });
    await expect(repository.getPresentation(created.presentation.id)).resolves.toMatchObject({
      state: "active",
      messageId: "om_after_durable_attempt",
    });
  });

  it("requires a lease-owned durable external attempt before recording post-call failure", async () => {
    const repository = cardRepository();
    const draft = await createDraft("durable-external-failure");
    const created = await repository.createPresentation(
      presentationInput("durable-external-failure", draft.id),
    );
    await repository.claimPresentationSend({
      workerId: "worker-failure-boundary",
      leaseUntil: plusSeconds(30),
      at,
    });

    await expect(repository.failPresentationSend({
      presentationId: created.presentation.id,
      workerId: "worker-failure-boundary",
      classification: "retryable",
      errorCode: "request_not_sent",
      retryAt: plusSeconds(60),
      at: plusSeconds(1),
    })).rejects.toBeInstanceOf(KnowledgeCardPersistenceConflictError);

    await repository.beginExternalAttempt({
      presentationId: created.presentation.id,
      workerId: "worker-failure-boundary",
      at: plusSeconds(1),
    });
    await repository.failPresentationSend({
      presentationId: created.presentation.id,
      workerId: "worker-failure-boundary",
      classification: "retryable",
      errorCode: "request_not_sent",
      retryAt: plusSeconds(60),
      at: plusSeconds(2),
    });
    await expect(repository.claimPresentationSend({
      workerId: "worker-retry",
      leaseUntil: plusSeconds(90),
      at: plusSeconds(60),
    })).resolves.toMatchObject({ attempts: 2, workerId: "worker-retry" });
  });

  it("terminalizes an expired original external attempt without reclaiming it", async () => {
    const repository = cardRepository();
    const draft = await createDraft("expired-external-send");
    const created = await repository.createPresentation(
      presentationInput("expired-external-send", draft.id),
    );
    await repository.claimPresentationSend({
      workerId: "worker-external-send",
      leaseUntil: plusSeconds(30),
      at,
    });
    await repository.beginExternalAttempt({
      presentationId: created.presentation.id,
      workerId: "worker-external-send",
      at: plusSeconds(1),
    });

    await expect(repository.claimPresentationSend({
      workerId: "worker-must-not-reclaim",
      leaseUntil: plusSeconds(60),
      at: plusSeconds(30),
    })).resolves.toBeUndefined();
    await expect(repository.getPresentation(created.presentation.id)).resolves.toMatchObject({
      state: "send_failed",
      version: 2,
    });
    await expect(pool.query(
      `SELECT state, worker_id, lease_until, retry_at, error_code
       FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1`,
      [created.presentation.id],
    )).resolves.toMatchObject({
      rows: [{
        state: "outcome_unknown",
        worker_id: null,
        lease_until: null,
        retry_at: null,
        error_code: "external_attempt_lease_expired",
      }],
    });
  });

  it("terminalizes a stable preparation failure without beginning an external attempt", async () => {
    const repository = cardRepository() as ReturnType<typeof cardRepository> & {
      failPresentationPreparation(input: {
        presentationId: string;
        workerId: string;
        errorCode: string;
        at: Date;
      }): Promise<void>;
    };
    const draft = await createDraft("preparation-failure");
    const created = await repository.createPresentation(
      presentationInput("preparation-failure", draft.id),
    );
    await repository.claimPresentationSend({
      workerId: "worker-preparation",
      leaseUntil: plusSeconds(30),
      at,
    });

    await repository.failPresentationPreparation({
      presentationId: created.presentation.id,
      workerId: "worker-preparation",
      errorCode: "evidence_invalidated",
      at: plusSeconds(1),
    });

    await expect(repository.getPresentation(created.presentation.id)).resolves.toMatchObject({
      state: "send_failed",
      version: 2,
    });
    await expect(pool.query(
      "SELECT state, error_code FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1",
      [created.presentation.id],
    )).resolves.toMatchObject({
      rows: [{ state: "failed", error_code: "evidence_invalidated" }],
    });
  });

  it("terminalizes an expired fifth processing attempt instead of creating attempt six", async () => {
    const repository = cardRepository();
    const draft = await createDraft("max-attempt-recovery");
    const created = await repository.createPresentation(
      presentationInput("max-attempt-recovery", draft.id),
    );

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const offset = (attempt - 1) * 10;
      await expect(repository.claimPresentationSend({
        workerId: `worker-attempt-${attempt}`,
        leaseUntil: plusSeconds(offset + 5),
        at: plusSeconds(offset),
      })).resolves.toMatchObject({ attempts: attempt });
      await repository.beginExternalAttempt({
        presentationId: created.presentation.id,
        workerId: `worker-attempt-${attempt}`,
        at: plusSeconds(offset + 1),
      });
      await repository.failPresentationSend({
        presentationId: created.presentation.id,
        workerId: `worker-attempt-${attempt}`,
        classification: "retryable",
        errorCode: "request_not_sent",
        retryAt: plusSeconds(offset + 3),
        at: plusSeconds(offset + 2),
      });
    }

    await expect(repository.claimPresentationSend({
      workerId: "worker-attempt-5",
      leaseUntil: plusSeconds(45),
      at: plusSeconds(40),
    })).resolves.toMatchObject({ attempts: 5 });
    await expect(repository.claimPresentationSend({
      workerId: "worker-attempt-6-must-not-exist",
      leaseUntil: plusSeconds(60),
      at: plusSeconds(45),
    })).resolves.toBeUndefined();

    await expect(repository.getPresentation(created.presentation.id)).resolves.toMatchObject({
      state: "send_failed",
    });
    await expect(pool.query(
      "SELECT state, attempts, retry_at, error_code FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1",
      [created.presentation.id],
    )).resolves.toMatchObject({
      rows: [{
        state: "failed",
        attempts: 5,
        retry_at: null,
        error_code: "max_attempts_exhausted",
      }],
    });
  });

  it("never sends again after completion and fallback writes both fail", async () => {
    const repository = cardRepository();
    const draft = await createDraft("send-write-loss-recovery");
    const created = await repository.createPresentation(
      presentationInput("send-write-loss-recovery", draft.id),
    );
    let currentTime = at;
    const sendCard = vi.fn(async () => ({ messageId: "om_write_loss" }));
    const dispatcher = createKnowledgeCardDispatcher({
      repository: {
        ...repository,
        completePresentationSend: vi.fn(async () => {
          throw new Error("completion write unavailable");
        }),
        failPresentationSend: vi.fn(async () => {
          throw new Error("fallback write unavailable");
        }),
      },
      cardClient: { sendCard, updateCard: vi.fn(async () => undefined) },
      renderer: () => ({
        status: "rendered",
        card: {},
        json: "{}",
        contentHash: "a".repeat(64),
        componentCount: 0,
      }),
      canUseKnowledgeCards: () => true,
      targetDisplayName: "Knowledge Base",
      workerId: "dispatcher-write-loss",
      leaseMs: 30_000,
      retryDelayMs: 30_000,
      now: () => new Date(currentTime),
    });

    await expect(dispatcher.processBatch({ limit: 1 })).rejects.toThrow("fallback write unavailable");
    expect(sendCard).toHaveBeenCalledOnce();

    currentTime = plusSeconds(30);
    await expect(repository.claimPresentationSend({
      workerId: "recovery-after-write-loss",
      leaseUntil: plusSeconds(60),
      at: currentTime,
    })).resolves.toBeUndefined();
    currentTime = plusSeconds(31);
    await expect(dispatcher.processBatch({ limit: 1 })).resolves.toEqual([]);
    expect(sendCard).toHaveBeenCalledOnce();
    await expect(repository.getPresentation(created.presentation.id)).resolves.toMatchObject({
      state: "send_failed",
    });
    await expect(pool.query(
      "SELECT state, error_code FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1",
      [created.presentation.id],
    )).resolves.toMatchObject({
      rows: [{ state: "outcome_unknown", error_code: "external_attempt_lease_expired" }],
    });
  });

  it("never updates again and keeps a closed presentation closed after both writes fail", async () => {
    const repository = cardRepository();
    const { draft, presentation, messageId } = await createActivePresentation(
      "update-write-loss-recovery",
    );
    await repository.applyInteraction(interactionInput(
      "update-write-loss-recovery",
      draft.id,
      presentation.id,
      { action: "confirm" },
    ));
    let currentTime = plusSeconds(11);
    const updateCard = vi.fn(async () => undefined);
    const dispatcher = createKnowledgeCardDispatcher({
      repository: {
        ...repository,
        completePresentationSend: vi.fn(async () => {
          throw new Error("update completion unavailable");
        }),
        failPresentationSend: vi.fn(async () => {
          throw new Error("update fallback unavailable");
        }),
      },
      cardClient: { sendCard: vi.fn(async () => ({ messageId: "unused" })), updateCard },
      canUseKnowledgeCards: () => true,
      targetDisplayName: "Knowledge Base",
      workerId: "dispatcher-update-write-loss",
      leaseMs: 30_000,
      retryDelayMs: 30_000,
      now: () => new Date(currentTime),
    });

    await expect(dispatcher.processBatch({ limit: 1 })).rejects.toThrow("update fallback unavailable");
    expect(updateCard).toHaveBeenCalledOnce();
    expect(updateCard).toHaveBeenCalledWith(expect.objectContaining({ messageId }));

    currentTime = plusSeconds(41);
    await expect(repository.claimPresentationSend({
      workerId: "recovery-after-update-write-loss",
      leaseUntil: plusSeconds(70),
      at: currentTime,
    })).resolves.toBeUndefined();
    currentTime = plusSeconds(42);
    await expect(dispatcher.processBatch({ limit: 1 })).resolves.toEqual([]);
    expect(updateCard).toHaveBeenCalledOnce();
    await expect(repository.getPresentation(presentation.id)).resolves.toMatchObject({
      state: "closed",
      version: 3,
    });
    await expect(pool.query(
      "SELECT state, error_code FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1",
      [presentation.id],
    )).resolves.toMatchObject({
      rows: [{ state: "outcome_unknown", error_code: "external_attempt_lease_expired" }],
    });
  });

  it("marks an original send failed when runtime disables during begin", async () => {
    const repository = cardRepository();
    const draft = await createDraft("send-disabled-during-begin");
    const created = await repository.createPresentation(
      presentationInput("send-disabled-during-begin", draft.id),
    );
    let enabled = true;
    const sendCard = vi.fn(async () => ({ messageId: "must-not-send" }));
    const dispatcher = createKnowledgeCardDispatcher({
      repository: {
        ...repository,
        beginExternalAttempt: async (input) => {
          await repository.beginExternalAttempt(input);
          enabled = false;
        },
      },
      cardClient: { sendCard, updateCard: vi.fn(async () => undefined) },
      renderer: () => ({
        status: "rendered",
        card: {},
        json: "{}",
        contentHash: "a".repeat(64),
        componentCount: 0,
      }),
      canUseKnowledgeCards: () => enabled,
      targetDisplayName: "Knowledge Base",
      workerId: "dispatcher-send-disabled-during-begin",
      leaseMs: 30_000,
      retryDelayMs: 30_000,
      now: () => plusSeconds(5),
    });

    await expect(dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      presentationId: created.presentation.id,
      code: "runtime_disabled",
    }]);
    expect(sendCard).not.toHaveBeenCalled();
    await expect(repository.getPresentation(created.presentation.id)).resolves.toMatchObject({
      state: "send_failed",
    });
    await expect(pool.query(
      "SELECT state, error_code FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1",
      [created.presentation.id],
    )).resolves.toMatchObject({
      rows: [{ state: "failed", error_code: "runtime_disabled" }],
    });
  });

  it("recovers disabled-after-begin write loss as outcome unknown without sending", async () => {
    const repository = cardRepository();
    const draft = await createDraft("send-disabled-write-loss");
    const created = await repository.createPresentation(
      presentationInput("send-disabled-write-loss", draft.id),
    );
    let enabled = true;
    const sendCard = vi.fn(async () => ({ messageId: "must-not-send" }));
    const dispatcher = createKnowledgeCardDispatcher({
      repository: {
        ...repository,
        beginExternalAttempt: async (input) => {
          await repository.beginExternalAttempt(input);
          enabled = false;
        },
        failPresentationSend: async () => {
          throw new Error("runtime-disabled terminal write unavailable");
        },
      },
      cardClient: { sendCard, updateCard: vi.fn(async () => undefined) },
      renderer: () => ({
        status: "rendered",
        card: {},
        json: "{}",
        contentHash: "a".repeat(64),
        componentCount: 0,
      }),
      canUseKnowledgeCards: () => enabled,
      targetDisplayName: "Knowledge Base",
      workerId: "dispatcher-send-disabled-write-loss",
      leaseMs: 30_000,
      retryDelayMs: 30_000,
      now: () => plusSeconds(5),
    });

    await expect(dispatcher.processBatch({ limit: 1 })).rejects.toThrow(
      "runtime-disabled terminal write unavailable",
    );
    expect(sendCard).not.toHaveBeenCalled();
    await expect(pool.query(
      "SELECT state FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1",
      [created.presentation.id],
    )).resolves.toMatchObject({ rows: [{ state: "external_attempting" }] });

    await expect(repository.claimPresentationSend({
      workerId: "recovery-send-disabled-write-loss",
      leaseUntil: plusSeconds(65),
      at: plusSeconds(35),
    })).resolves.toBeUndefined();
    expect(sendCard).not.toHaveBeenCalled();
    await expect(repository.getPresentation(created.presentation.id)).resolves.toMatchObject({
      state: "send_failed",
    });
    await expect(pool.query(
      "SELECT state, error_code FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1",
      [created.presentation.id],
    )).resolves.toMatchObject({
      rows: [{ state: "outcome_unknown", error_code: "external_attempt_lease_expired" }],
    });
  });

  it("keeps a result presentation closed when runtime disables during begin", async () => {
    const repository = cardRepository();
    const { draft, presentation } = await createActivePresentation("update-disabled-during-begin");
    await repository.applyInteraction(interactionInput(
      "update-disabled-during-begin",
      draft.id,
      presentation.id,
      { action: "confirm" },
    ));
    let enabled = true;
    const updateCard = vi.fn(async () => undefined);
    const dispatcher = createKnowledgeCardDispatcher({
      repository: {
        ...repository,
        beginExternalAttempt: async (input) => {
          await repository.beginExternalAttempt(input);
          enabled = false;
        },
      },
      cardClient: { sendCard: vi.fn(async () => ({ messageId: "unused" })), updateCard },
      canUseKnowledgeCards: () => enabled,
      targetDisplayName: "Knowledge Base",
      workerId: "dispatcher-update-disabled-during-begin",
      leaseMs: 30_000,
      retryDelayMs: 30_000,
      now: () => plusSeconds(11),
    });

    await expect(dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      presentationId: presentation.id,
      code: "runtime_disabled",
    }]);
    expect(updateCard).not.toHaveBeenCalled();
    await expect(repository.getPresentation(presentation.id)).resolves.toMatchObject({
      state: "closed",
      version: 3,
    });
    await expect(pool.query(
      "SELECT state, error_code FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1",
      [presentation.id],
    )).resolves.toMatchObject({
      rows: [{ state: "failed", error_code: "runtime_disabled" }],
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
    await repository.beginExternalAttempt({
      presentationId: created.presentation.id,
      workerId: "worker-reclaim-complete",
      at: plusSeconds(31),
    });
    await repository.completePresentationSend({
      presentationId: created.presentation.id,
      workerId: "worker-reclaim-complete",
      messageId: "om-reclaimed-complete",
      at: plusSeconds(32),
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

    await expect(repository.failPresentationPreparation({
      presentationId: created.presentation.id,
      workerId: "worker-expiring-fail",
      errorCode: "expired_owner",
      at: plusSeconds(30),
    })).rejects.toBeInstanceOf(KnowledgeCardPersistenceConflictError);
    await expect(repository.claimPresentationSend({
      workerId: "worker-reclaim-fail",
      leaseUntil: plusSeconds(60),
      at: plusSeconds(30),
    })).resolves.toMatchObject({ presentation: { id: created.presentation.id } });
    await repository.failPresentationPreparation({
      presentationId: created.presentation.id,
      workerId: "worker-reclaim-fail",
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
    await repository.beginExternalAttempt({
      presentationId: active.presentation.id,
      workerId: "worker-supersede",
      at: plusSeconds(2),
    });
    await repository.completePresentationSend({
      presentationId: active.presentation.id,
      workerId: "worker-supersede",
      messageId: "om-active-before-supersede",
      at: plusSeconds(3),
    });
    const replacement = await repository.createPresentation(presentationInput("supersede-replacement", draft.id, {
      at: plusSeconds(4),
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

  it("lets committed supersession make a concurrent begin fail before any external call", async () => {
    const draft = await createDraft("supersession-wins-race");
    const repository = cardRepository();
    const original = await repository.createPresentation(
      presentationInput("supersession-wins-race-original", draft.id),
    );
    const workerId = id("worker-supersession-wins-race");
    await expect(repository.claimPresentationSend({
      workerId,
      leaseUntil: plusSeconds(30),
      at,
    })).resolves.toMatchObject({ presentation: { id: original.presentation.id } });

    const blocker = await pool.connect();
    const createPool = new pg.Pool({ connectionString: isolatedDatabaseUrl, max: 1 });
    const beginPool = new pg.Pool({ connectionString: isolatedDatabaseUrl, max: 1 });
    let externalCalls = 0;
    try {
      await blocker.query("BEGIN");
      const blockerPid = await backendPid(blocker);
      await blocker.query(
        "SELECT id FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1 FOR UPDATE",
        [original.presentation.id],
      );
      const createPid = await backendPid(createPool);
      const beginPid = await backendPid(beginPool);
      const replacementInput = presentationInput("supersession-wins-race-replacement", draft.id, {
        at: plusSeconds(1),
      });
      const replacementPromise = createPostgresKnowledgeCardRepository({
        dataSource: createPool,
      }).createPresentation(replacementInput);
      void replacementPromise.catch(() => undefined);
      await waitUntilBlocked(createPid, blockerPid);

      const externalPath = (async () => {
        const beginRepository = createPostgresKnowledgeCardRepository({ dataSource: beginPool });
        await beginRepository.beginExternalAttempt({
          presentationId: original.presentation.id,
          workerId,
          at: plusSeconds(2),
        });
        externalCalls += 1;
      })();
      void externalPath.catch(() => undefined);
      await waitUntilBlocked(beginPid, createPid);
      await blocker.query("COMMIT");

      await expect(replacementPromise).resolves.toMatchObject({
        outcome: "applied",
        presentation: { id: replacementInput.id },
      });
      await expect(externalPath).rejects.toBeInstanceOf(KnowledgeCardPersistenceConflictError);
      expect(externalCalls).toBe(0);
      await expect(repository.getPresentation(original.presentation.id)).resolves.toMatchObject({
        state: "superseded",
      });
      await expect(pool.query(
        "SELECT state FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1",
        [original.presentation.id],
      )).resolves.toMatchObject({ rows: [{ state: "failed" }] });
      await retireOutbox(replacementInput.id);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await createPool.end();
      await beginPool.end();
    }
  });

  it("rejects concurrent supersession after begin commits and lets the old attempt complete", async () => {
    const draft = await createDraft("begin-wins-race");
    const repository = cardRepository();
    const original = await repository.createPresentation(
      presentationInput("begin-wins-race-original", draft.id),
    );
    const workerId = id("worker-begin-wins-race");
    await expect(repository.claimPresentationSend({
      workerId,
      leaseUntil: plusSeconds(30),
      at,
    })).resolves.toMatchObject({ presentation: { id: original.presentation.id } });

    const blocker = await pool.connect();
    const createPool = new pg.Pool({ connectionString: isolatedDatabaseUrl, max: 1 });
    const beginPool = new pg.Pool({ connectionString: isolatedDatabaseUrl, max: 1 });
    let externalCalls = 0;
    try {
      await blocker.query("BEGIN");
      const blockerPid = await backendPid(blocker);
      await blocker.query("SELECT id FROM knowledge_drafts WHERE id = $1 FOR UPDATE", [draft.id]);
      const createPid = await backendPid(createPool);
      const replacementInput = presentationInput("begin-wins-race-replacement", draft.id, {
        at: plusSeconds(1),
      });
      const replacementPromise = createPostgresKnowledgeCardRepository({
        dataSource: createPool,
      }).createPresentation(replacementInput);
      void replacementPromise.catch(() => undefined);
      await waitUntilBlocked(createPid, blockerPid);

      const beginRepository = createPostgresKnowledgeCardRepository({ dataSource: beginPool });
      await beginRepository.beginExternalAttempt({
        presentationId: original.presentation.id,
        workerId,
        at: plusSeconds(2),
      });
      externalCalls += 1;
      await blocker.query("COMMIT");

      await expect(replacementPromise).rejects.toBeInstanceOf(KnowledgeCardPresentationConflictError);
      await beginRepository.completePresentationSend({
        presentationId: original.presentation.id,
        workerId,
        messageId: id("om-begin-wins-race"),
        at: plusSeconds(3),
      });
      expect(externalCalls).toBe(1);
      await expect(repository.getPresentation(original.presentation.id)).resolves.toMatchObject({
        state: "active",
      });
      await expect(repository.getPresentation(replacementInput.id)).resolves.toBeUndefined();
      await expect(pool.query(
        "SELECT state FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1",
        [original.presentation.id],
      )).resolves.toMatchObject({ rows: [{ state: "sent" }] });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await createPool.end();
      await beginPool.end();
    }
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
      committedResult: {
        action: "confirm",
        actorOpenId: input.actorOpenId,
        confirmedAt: input.at,
        nextGate: "pending_review",
      },
    });
    await expect(repository.getPresentationContext(presentation.id)).resolves.toMatchObject({
      committedResult: {
        action: "confirm",
        actorOpenId: input.actorOpenId,
        confirmedAt: input.at,
        nextGate: "pending_review",
      },
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
    await repository.beginExternalAttempt({
      presentationId: presentation.id,
      workerId: "worker-card-update",
      at: plusSeconds(12),
    });
    await repository.completePresentationSend({
      presentationId: presentation.id,
      workerId: "worker-card-update",
      messageId,
      at: plusSeconds(13),
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
      committedResult: {
        action: "request_revision",
        state: "needs_revision",
        reason: "Add rollback ownership.",
      },
    });
    await expect(repository.getPresentationContext(presentation.id)).resolves.toMatchObject({
      committedResult: {
        action: "request_revision",
        state: "needs_revision",
        reason: "Add rollback ownership.",
      },
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
      committedResult: {
        action: "reject",
        state: "rejected",
        reason: "Evidence is too weak.",
      },
    });
    await expect(repository.getPresentationContext(presentation.id)).resolves.toMatchObject({
      committedResult: {
        action: "reject",
        state: "rejected",
        reason: "Evidence is too weak.",
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

  it("replays a committed worker redelivery with fresh timestamps and immutable intent", async () => {
    const { draft, presentation, messageId } = await createActivePresentation("worker-redelivery");
    const repository = cardRepository();
    const reason = "Clarify durable retry ownership.";
    const callbackJob: ApprovalInteractionJob = {
      idempotencyKey: id("worker-redelivery-idempotency"),
      eventId: id("callback-worker-redelivery"),
      appId: "cli_test_app",
      actorOpenId: "ou_group_member",
      chatId: sourceGroupId,
      messageId,
      presentationId: presentation.id,
      draftId: draft.id,
      revisionNumber: 1,
      draftVersion: 1,
      action: "request_revision",
      reason,
      receivedAt: plusSeconds(5),
      attempts: 0,
    };
    const canUseKnowledgeCards = vi.fn((groupId: string) => groupId === sourceGroupId);
    const isCurrentMember = vi.fn(async (input: { chatId: string; openId: string }) =>
      input.chatId === sourceGroupId && input.openId === callbackJob.actorOpenId
    );
    const cardClient = {
      updateCard: vi.fn(async (_input: { messageId: string; cardJson: string }) => undefined),
    };

    const runAttempt = async (attemptAt: Date, attempts: number, failAcknowledge: boolean) => {
      const attemptJob = { ...callbackJob, attempts };
      const queue = {
        claimBatch: vi.fn(async () => [attemptJob]),
        acknowledge: vi.fn(async () => {
          if (failAcknowledge) throw new Error("simulated post-commit acknowledgement failure");
        }),
        handleFailure: vi.fn(async () => ({ action: "delayed" as const })),
      };
      const worker = createApprovalInteractionWorker({
        queue,
        repository,
        membershipChecker: { isCurrentMember },
        cardClient,
        canUseKnowledgeCards,
        botOpenId: "ou_iris_bot",
        workerId: id(`worker-redelivery-${attempts}`),
        leaseMs: 30_000,
        now: () => new Date(attemptAt),
      });
      return { result: await worker.processBatch({ limit: 1 }), queue };
    };

    try {
      const first = await runAttempt(plusSeconds(10), 0, true);
      expect(first.result).toEqual([{
        status: "retrying",
        idempotencyKey: callbackJob.idempotencyKey,
        code: "redis_unavailable",
      }]);
      expect(first.queue.handleFailure).toHaveBeenCalledOnce();

      const redelivery = await runAttempt(plusSeconds(40), 1, false);
      expect(redelivery.result).toEqual([{
        status: "already_applied",
        idempotencyKey: callbackJob.idempotencyKey,
        code: "duplicate_callback",
      }]);
      expect(redelivery.queue.handleFailure).not.toHaveBeenCalled();
      expect(canUseKnowledgeCards).toHaveBeenCalledTimes(4);
      expect(isCurrentMember).toHaveBeenCalledTimes(2);

      expect(cardClient.updateCard).toHaveBeenCalledTimes(2);
      const firstCardJson = cardClient.updateCard.mock.calls[0]?.[0].cardJson;
      const replayCardJson = cardClient.updateCard.mock.calls[1]?.[0].cardJson;
      expect(replayCardJson).toBe(firstCardJson);
      expect(replayCardJson).toContain("Iris / revision_requested");
      expect(replayCardJson).toContain(`Reason: ${reason}`);
      expect(replayCardJson).not.toContain("This action was already processed.");

      const replayInput = {
        presentationId: presentation.id,
        draftId: draft.id,
        revisionNumber: 1,
        draftVersion: 1,
        chatId: sourceGroupId,
        eventId: callbackJob.eventId,
        actorOpenId: callbackJob.actorOpenId,
        membershipCheckedAt: plusSeconds(49),
        at: plusSeconds(50),
        action: "request_revision" as const,
        reason,
      };
      await expect(repository.applyInteraction({
        ...replayInput,
        membershipCheckedAt: plusSeconds(19),
      })).rejects.toBeInstanceOf(KnowledgeCardMembershipProofError);
      for (const immutableChange of [
        { actorOpenId: "ou_changed_actor" },
        { reason: "Changed immutable reason." },
        { presentationId: id("changed-presentation-binding") },
        { draftId: id("changed-draft-binding") },
        { revisionNumber: 2 },
        { draftVersion: 2 },
      ]) {
        await expect(repository.applyInteraction({
          ...replayInput,
          ...immutableChange,
        })).rejects.toBeInstanceOf(KnowledgeCardOperationConflictError);
      }
      await expect(repository.applyInteraction({
        ...replayInput,
        action: "confirm",
        reason: undefined,
      })).rejects.toBeInstanceOf(KnowledgeCardOperationConflictError);

      await expect(pool.query(
        `SELECT count(*)::int AS count
         FROM knowledge_draft_presentation_events
         WHERE callback_event_id = $1`,
        [callbackJob.eventId],
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await expect(pool.query(
        `SELECT count(*)::int AS count
         FROM knowledge_draft_events draft_event
         JOIN knowledge_draft_presentation_events presentation_event
           ON presentation_event.operation_key = draft_event.operation_key
         WHERE presentation_event.callback_event_id = $1`,
        [callbackJob.eventId],
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await expect(pool.query(
        "SELECT count(*)::int AS count FROM knowledge_draft_presentation_outbox WHERE presentation_id = $1",
        [presentation.id],
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      await retireOutbox(presentation.id);
    }
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

  it("completes createPresentation versus applyInteraction without a lock-order deadlock", async () => {
    const { draft, presentation } = await createActivePresentation("create-apply-lock-race");
    const applyFirstRowLock = deferred<void>();
    const createDraftLock = deferred<void>();
    let applyFirstRowLockSeen = false;

    const coordinatedDataSource = (role: "apply" | "create") => ({
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: async (sql: string, params?: unknown[]) => {
            const normalized = sql.replaceAll(/\s+/gu, " ").trim();
            const draftLock = normalized.includes("FROM knowledge_drafts WHERE id = $1 FOR UPDATE");
            const presentationLock = normalized.includes(
              "FROM knowledge_draft_presentations WHERE id = $1 FOR UPDATE",
            );
            if (role === "create" && draftLock) await applyFirstRowLock.promise;
            const result = await client.query(sql, params);
            if (role === "apply" && !applyFirstRowLockSeen && (draftLock || presentationLock)) {
              applyFirstRowLockSeen = true;
              applyFirstRowLock.resolve();
              if (presentationLock) await createDraftLock.promise;
            }
            if (role === "create" && draftLock) createDraftLock.resolve();
            return result;
          },
        };
      },
    }) as unknown as PostgresKnowledgeDraftDataSource;

    const replacement = presentationInput("create-apply-lock-race-replacement", draft.id);
    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled([
        createPostgresKnowledgeCardRepository({
          dataSource: coordinatedDataSource("apply"),
        }).applyInteraction(interactionInput(
          "create-apply-lock-race-confirm",
          draft.id,
          presentation.id,
          { action: "confirm" },
        )),
        createPostgresKnowledgeCardRepository({
          dataSource: coordinatedDataSource("create"),
        }).createPresentation(replacement),
      ]);

      expect(results.map((result) =>
        result.status === "rejected" ? errorCode(result.reason) : undefined
      )).not.toContain("40P01");
      expect(results[0]).toMatchObject({
        status: "fulfilled",
        value: { outcome: "applied", draft: { status: "pending_review" } },
      });
      expect(results[1]).toMatchObject({
        status: "rejected",
        reason: { name: "KnowledgeCardPersistenceConflictError" },
      });
      await expect(cardRepository().getPresentation(presentation.id)).resolves.toMatchObject({
        state: "closed",
      });
      await expect(cardRepository().getPresentation(replacement.id)).resolves.toBeUndefined();
      await expect(pool.query(
        `SELECT count(*)::int AS count FROM knowledge_draft_presentation_events
         WHERE presentation_id = $1 AND callback_event_id IS NOT NULL`,
        [presentation.id],
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      await pool.query(
        `UPDATE knowledge_draft_presentation_outbox
         SET state = 'failed', error_code = 'test_retired', updated_at = $2
         WHERE presentation_id IN (
           SELECT id FROM knowledge_draft_presentations WHERE draft_id = $1
         )`,
        [draft.id, at],
      );
    }
  }, 10_000);

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
    await repository.beginExternalAttempt({
      presentationId: created.presentation.id,
      workerId,
      at: plusSeconds(1),
    });
    await repository.completePresentationSend({
      presentationId: created.presentation.id,
      workerId,
      messageId,
      at: plusSeconds(2),
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

  async function backendPid(queryable: { query<T>(sql: string): Promise<{ rows: T[] }> }) {
    const result = await queryable.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    return result.rows[0]!.pid;
  }

  async function waitUntilBlocked(blockedPid: number, blockerPid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ blocked: boolean }>(
        "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked",
        [blockedPid, blockerPid],
      );
      if (result.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`backend ${blockedPid} was not blocked by ${blockerPid}`);
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function errorCode(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
    ? value.code
    : undefined;
}
