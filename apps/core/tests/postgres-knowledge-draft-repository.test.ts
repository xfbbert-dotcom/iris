import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  KnowledgeDraftEvidenceError,
  KnowledgeDraftOperationConflictError,
  KnowledgeDraftVersionConflictError,
  createPostgresKnowledgeDraftRepository,
} from "../src/knowledge-governance/postgres-knowledge-draft-repository.js";
import type { KnowledgeDraftStatusCounts } from "../src/knowledge-governance/knowledge-draft-repository.js";
import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;
const suffix = randomUUID();
const groupId = `draft-group-${suffix}`;
const otherGroupId = `draft-other-${suffix}`;
const messageId = `feishu:om-draft-${suffix}`;
const otherMessageId = `feishu:om-draft-other-${suffix}`;
const threadId = `draft-thread-${suffix}`;
const actionId = `draft-action-${suffix}`;
const documentSourceId = `draft-document-${suffix}`;
const companyDocumentSourceId = `draft-wiki-${suffix}`;
const documentUpdatedAt = new Date("2026-07-18T04:00:00.000Z");
const at = new Date("2026-07-18T05:00:00.000Z");

describe("knowledge draft migration contract", () => {
  const migration = readFileSync(
    new URL("../migrations/0030_knowledge_draft_facts.sql", import.meta.url),
    "utf8",
  );

  it("defines independent immutable draft facts without retrieval or publication tables", () => {
    for (const table of [
      "knowledge_drafts",
      "knowledge_draft_revisions",
      "knowledge_draft_revision_evidence",
      "knowledge_draft_events",
    ]) expect(migration).toMatch(new RegExp(`create table ${table}`, "iu"));

    expect(migration).toMatch(/knowledge_draft_revisions_append_only/iu);
    expect(migration).toMatch(/knowledge_draft_revision_evidence_append_only/iu);
    expect(migration).toMatch(/knowledge_draft_events_append_only/iu);
    expect(migration).toMatch(/operation_fingerprint/iu);
    expect(migration).not.toMatch(/document_fragments|group_memories|embedding|feishu_document_id/iu);
  });
});

runIfDatabase("PostgresKnowledgeDraftRepository with Postgres", () => {
  let pool: pg.Pool;
  let baselineCounts: KnowledgeDraftStatusCounts;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await runMigrations({
      client: pool as unknown as MigrationClient,
      migrationsDir: defaultMigrationsDir(),
    });
    baselineCounts = await createPostgresKnowledgeDraftRepository({
      dataSource: pool,
    }).getStatusCounts();
    await pool.query(
      `
      INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id, message_type,
        text, sent_at, raw_event_idempotency_key, created_at
      ) VALUES
        ($1, 'feishu', $2, $3, 'ou_author', 'text', 'release evidence', $4, $5, $4),
        ($6, 'feishu', $7, $8, 'ou_other', 'text', 'other evidence', $4, $9, $4)
      `,
      [
        messageId,
        `om-draft-${suffix}`,
        groupId,
        at,
        `event-draft-${suffix}`,
        otherMessageId,
        `om-draft-other-${suffix}`,
        otherGroupId,
        `event-draft-other-${suffix}`,
      ],
    );
    await pool.query(
      `
      INSERT INTO discussion_threads (
        id, group_id, title, summary, status, confidence, version,
        first_evidence_at, last_activity_at, resolved_at, created_at, updated_at
      ) VALUES ($1, $2, 'Release', 'Release conclusion', 'resolved', 0.95, 3,
        $3, $3, $3, $3, $3)
      `,
      [threadId, groupId, at],
    );
    await pool.query(
      `
      INSERT INTO action_items (
        id, group_id, thread_id, description, owner_ref_type, owner_ref,
        status, confidence, version, created_at, updated_at
      ) VALUES ($1, $2, $3, 'Archive checklist', 'feishu_user', 'ou_owner',
        'open', 0.9, 2, $4, $4)
      `,
      [actionId, groupId, threadId, at],
    );
    await pool.query(
      `
      INSERT INTO document_sources (
        id, source_type, source_uri, title, origin_group_id, origin_message_id,
        permission_state, sync_state, can_use_for_answering,
        can_use_for_knowledge_drafts, created_at, updated_at
      ) VALUES
        ($1, 'group_visible_document', $2, 'Release doc', $3, $4,
          'readable', 'synced', TRUE, TRUE, $5, $5),
        ($6, 'authorized_wiki_document', $7, 'Company wiki', NULL, NULL,
          'readable', 'synced', TRUE, TRUE, $5, $5)
      `,
      [
        documentSourceId,
        `https://example.com/docs/${suffix}`,
        groupId,
        messageId,
        documentUpdatedAt,
        companyDocumentSourceId,
        `https://example.com/wiki/${suffix}`,
      ],
    );
    await pool.query(
      `
      INSERT INTO document_source_evidence (
        document_source_id, kind, source_uri, group_id, message_id,
        observed_at, created_at
      ) VALUES ($1, 'group_message', $2, $3, $4, $5, $5)
      `,
      [
        documentSourceId,
        `https://example.com/docs/${suffix}`,
        groupId,
        messageId,
        documentUpdatedAt,
      ],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates one group draft with exact current evidence and an append-only event", async () => {
    const repository = createPostgresKnowledgeDraftRepository({ dataSource: pool });
    const result = await repository.createDraft(groupCreateInput("draft-main", "create-main"));

    expect(result.outcome).toBe("applied");
    expect(result.draft).toMatchObject({
      id: id("draft-main"),
      sourceGroupId: groupId,
      originKind: "group_conclusion",
      status: "pending_confirmation",
      currentRevisionNumber: 1,
      version: 1,
      createdBy: "iris",
      currentRevision: {
        revisionNumber: 1,
        riskLevel: "medium",
        evidenceState: { status: "current" },
        title: "Release checklist",
        content: "# Release\n\nRun acceptance.",
        author: "iris",
      },
    });
    expect(result.draft.currentRevision).toHaveProperty("evidence", expect.arrayContaining([
      expect.objectContaining({ type: "conversation_message", id: messageId }),
      expect.objectContaining({ type: "discussion_thread", id: threadId, entityVersion: 3 }),
      expect.objectContaining({ type: "action_item", id: actionId, entityVersion: 2 }),
      expect.objectContaining({ type: "document_source", id: documentSourceId }),
    ]));
    await expect(repository.listEvents(id("draft-main"))).resolves.toEqual([
      expect.objectContaining({ eventType: "created", toVersion: 1, operationKey: id("create-main") }),
    ]);
  });

  it("returns the existing result for an identical operation replay", async () => {
    const repository = createPostgresKnowledgeDraftRepository({ dataSource: pool });
    const result = await repository.createDraft(groupCreateInput("draft-main", "create-main"));

    expect(result.outcome).toBe("already_applied");
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM knowledge_draft_revisions WHERE draft_id = $1",
      [id("draft-main")],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("rejects operation-key reuse with different input", async () => {
    const repository = createPostgresKnowledgeDraftRepository({ dataSource: pool });
    await expect(repository.createDraft({
      ...groupCreateInput("draft-other-operation", "create-main"),
      revision: { ...groupCreateInput("draft-other-operation", "create-main").revision, title: "Different" },
    })).rejects.toBeInstanceOf(KnowledgeDraftOperationConflictError);
  });

  it("creates immutable revisions and enforces versioned lifecycle changes", async () => {
    const repository = createPostgresKnowledgeDraftRepository({ dataSource: pool });
    await expect(repository.requestRevision({
      id: id("draft-main"),
      expectedVersion: 1,
      operationKey: id("request-revision"),
      actor: "reviewer",
      reason: "Add rollback steps",
      at: new Date(at.getTime() + 1_000),
    })).resolves.toMatchObject({
      outcome: "applied",
      draft: { status: "needs_revision", version: 2 },
    });
    await expect(repository.requestRevision({
      id: id("draft-main"),
      expectedVersion: 1,
      operationKey: id("request-revision"),
      actor: "reviewer",
      reason: "Add rollback steps",
      at: new Date(at.getTime() + 1_000),
    })).resolves.toMatchObject({ outcome: "already_applied", draft: { version: 2 } });
    await expect(repository.rejectDraft({
      id: id("draft-main"),
      expectedVersion: 1,
      operationKey: id("stale-reject"),
      actor: "reviewer",
      reason: "stale",
      at: new Date(at.getTime() + 2_000),
    })).rejects.toBeInstanceOf(KnowledgeDraftVersionConflictError);

    const revised = await repository.reviseDraft({
      id: id("draft-main"),
      expectedVersion: 2,
      operationKey: id("revise-main"),
      actor: "iris",
      at: new Date(at.getTime() + 3_000),
      revision: {
        ...groupRevision(),
        title: "Release and rollback checklist",
        content: "# Release\n\nRun acceptance.\n\n# Rollback\n\nDisable first.",
      },
    });
    expect(revised).toMatchObject({
      outcome: "applied",
      draft: {
        status: "pending_confirmation",
        currentRevisionNumber: 2,
        version: 3,
        currentRevision: { title: "Release and rollback checklist", revisionNumber: 2 },
      },
    });
    await expect(pool.query(
      "UPDATE knowledge_draft_revisions SET title = 'tampered' WHERE draft_id = $1 AND revision_number = 1",
      [id("draft-main")],
    )).rejects.toThrow(/append-only/iu);
  });

  it("redacts current content when document evidence loses permission", async () => {
    const repository = createPostgresKnowledgeDraftRepository({ dataSource: pool });
    await pool.query(
      `UPDATE document_sources
       SET permission_state = 'denied', can_use_for_answering = FALSE,
           can_use_for_knowledge_drafts = FALSE, updated_at = $2
       WHERE id = $1`,
      [documentSourceId, new Date(at.getTime() + 10_000)],
    );

    const draft = await repository.getDraft(id("draft-main"));
    expect(draft?.currentRevision).toEqual(expect.objectContaining({
      revisionNumber: 2,
      riskLevel: "medium",
      evidenceState: { status: "invalidated", reason: "document_permission_unavailable" },
    }));
    expect(draft?.currentRevision).not.toHaveProperty("title");
    expect(draft?.currentRevision).not.toHaveProperty("content");
    expect(draft?.currentRevision).not.toHaveProperty("evidence");
  });

  it("rejects cross-group evidence atomically", async () => {
    const repository = createPostgresKnowledgeDraftRepository({ dataSource: pool });
    const input = groupCreateInput("draft-cross-group", "create-cross-group");
    input.revision.evidence = [{
      type: "conversation_message",
      id: otherMessageId,
      groupId,
    }];
    await expect(repository.createDraft(input)).rejects.toMatchObject({
      name: KnowledgeDraftEvidenceError.name,
      reason: "group_scope_mismatch",
    });
    await expect(repository.getDraft(id("draft-cross-group"))).resolves.toBeUndefined();
  });

  it("supports company-scoped authorized wiki drafts and isolated list filters", async () => {
    const repository = createPostgresKnowledgeDraftRepository({ dataSource: pool });
    const result = await repository.createDraft({
      id: id("draft-company"),
      operationKey: id("create-company"),
      originKind: "user_requested",
      createdBy: "operator",
      at,
      revision: {
        title: "Company FAQ",
        content: "Company answer",
        riskLevel: "low",
        evidence: [{
          type: "document_source",
          id: companyDocumentSourceId,
          expectedUpdatedAt: documentUpdatedAt,
        }],
      },
    });
    expect(result.draft).toMatchObject({ status: "pending_review" });
    expect(result.draft.sourceGroupId).toBeUndefined();
    await expect(repository.listDrafts({ sourceGroupId: groupId, limit: 20 }))
      .resolves.toEqual([expect.objectContaining({ id: id("draft-main"), sourceGroupId: groupId })]);
    await expect(repository.getStatusCounts()).resolves.toMatchObject({
      pending_confirmation: baselineCounts.pending_confirmation + 1,
      pending_review: baselineCounts.pending_review + 1,
      needs_revision: baselineCounts.needs_revision,
      rejected: baselineCounts.rejected,
      published: baselineCounts.published,
    });
  });

  it("redacts content after semantic evidence advances to another version", async () => {
    const repository = createPostgresKnowledgeDraftRepository({ dataSource: pool });
    await repository.createDraft({
      id: id("draft-thread-version"),
      operationKey: id("create-thread-version"),
      originKind: "group_conclusion",
      createdBy: "iris",
      at,
      revision: {
        sourceGroupId: groupId,
        title: "Thread summary",
        content: "Current conclusion",
        riskLevel: "low",
        evidence: [{ type: "discussion_thread", id: threadId, groupId, entityVersion: 3 }],
      },
    });
    await pool.query(
      "UPDATE discussion_threads SET version = 4, updated_at = $2 WHERE id = $1",
      [threadId, new Date(at.getTime() + 20_000)],
    );

    await expect(repository.getDraft(id("draft-thread-version"))).resolves.toMatchObject({
      currentRevision: {
        evidenceState: { status: "invalidated", reason: "entity_version_changed" },
      },
    });
    const draft = await repository.getDraft(id("draft-thread-version"));
    expect(draft?.currentRevision).not.toHaveProperty("content");
  });

  it("redacts content after direct message evidence is tombstoned and deleted", async () => {
    const repository = createPostgresKnowledgeDraftRepository({ dataSource: pool });
    const isolatedMessageId = `feishu:om-isolated-${suffix}`;
    const providerMessageId = `om-isolated-${suffix}`;
    await pool.query(
      `INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id, message_type,
        text, sent_at, raw_event_idempotency_key, created_at
      ) VALUES ($1, 'feishu', $2, $3, 'ou_author', 'text', 'temporary evidence', $4, $5, $4)`,
      [isolatedMessageId, providerMessageId, groupId, at, `event-isolated-${suffix}`],
    );
    await repository.createDraft({
      id: id("draft-message-deleted"),
      operationKey: id("create-message-deleted"),
      originKind: "repeated_qa",
      createdBy: "iris",
      at,
      revision: {
        sourceGroupId: groupId,
        title: "Temporary FAQ",
        content: "Temporary answer",
        riskLevel: "low",
        evidence: [{ type: "conversation_message", id: isolatedMessageId, groupId }],
      },
    });
    await pool.query(
      `INSERT INTO conversation_message_deletion_tombstones (
        provider, provider_message_id, conversation_message_id, chat_id, deleted_at
      ) VALUES ('feishu', $1, $2, $3, $4)`,
      [providerMessageId, isolatedMessageId, groupId, new Date(at.getTime() + 30_000)],
    );
    await pool.query("DELETE FROM conversation_messages WHERE id = $1", [isolatedMessageId]);

    const draft = await repository.getDraft(id("draft-message-deleted"));
    expect(draft?.currentRevision).toMatchObject({
      evidenceState: { status: "invalidated", reason: "message_deleted" },
    });
    expect(draft?.currentRevision).not.toHaveProperty("title");
  });

  it("enforces append-only event history in Postgres", async () => {
    await expect(pool.query(
      "DELETE FROM knowledge_draft_events WHERE draft_id = $1",
      [id("draft-main")],
    )).rejects.toThrow(/append-only/iu);
  });
});

function groupCreateInput(draftKey: string, operationKey: string) {
  return {
    id: id(draftKey),
    operationKey: id(operationKey),
    originKind: "group_conclusion" as const,
    createdBy: "iris",
    at,
    revision: groupRevision(),
  };
}

function groupRevision() {
  return {
    sourceGroupId: groupId,
    title: "Release checklist",
    content: "# Release\n\nRun acceptance.",
    riskLevel: "medium" as const,
    reviewer: { type: "feishu_user" as const, ref: "ou_reviewer" },
    suggestedPublication: { spaceId: "spc_company", parentNodeToken: "wikcn_ops" },
    evidence: [
      { type: "conversation_message" as const, id: messageId, groupId },
      { type: "discussion_thread" as const, id: threadId, groupId, entityVersion: 3 },
      { type: "action_item" as const, id: actionId, groupId, entityVersion: 2 },
      { type: "document_source" as const, id: documentSourceId, expectedUpdatedAt: documentUpdatedAt },
    ],
  };
}

function id(value: string): string {
  return `${value}-${suffix}`;
}
