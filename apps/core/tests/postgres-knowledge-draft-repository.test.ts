import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalManagedBodyHash } from
  "../src/action-approvals/managed-knowledge-page.js";
import { createPostgresManagedKnowledgePageRepository } from
  "../src/action-approvals/postgres-managed-knowledge-page-repository.js";

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
const memoryId = `draft-memory-${suffix}`;
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

  it("keeps conflict permission reattestations append-only for semantic creation replay", () => {
    const migrationUrl = new URL(
      "../migrations/0048_knowledge_conflict_draft_reattestations.sql",
      import.meta.url,
    );
    expect(existsSync(migrationUrl)).toBe(true);
    if (!existsSync(migrationUrl)) return;
    const migration = readFileSync(migrationUrl, "utf8");
    expect(migration).toMatch(/drop constraint knowledge_conflict_draft_governance_attestations_pkey/iu);
    expect(migration).toMatch(
      /primary key \(\s*draft_id,\s*revision_number,\s*document_source_id,\s*permission_attested_at\s*\)/iu,
    );
  });
});

describe("PostgresKnowledgeDraftRepository semantic conflict replay", () => {
  it("creates the exact immutable managed update target inside conflict draft creation", async () => {
    const fixture = semanticConflictDraftDataSource();
    const repository = createPostgresKnowledgeDraftRepository({ dataSource: fixture.dataSource });
    const managedPages = createPostgresManagedKnowledgePageRepository({
      dataSource: fixture.dataSource,
    });
    const input = semanticConflictCreateInput(new Date("2026-08-13T04:00:00.000Z"));

    const creation = await repository.createDraft({
      ...input,
      managedUpdateTarget: {
        conflictCandidateId: "candidate-1",
        conflictCandidateVersion: 3,
        managedPageId: "managed-1",
        managedPageVersion: 4,
        linkedDocumentSourceId: "source-1",
        targetSnapshotId: "snapshot-1",
        targetSnapshotHash: "a".repeat(64),
        targetSourceVersion: "source-v7",
        remoteDocumentToken: "doc-managed-1",
        managedBodyBlockId: "block-managed-1",
        expectedRemoteRevisionId: "12",
        currentBodyContentHash: "b".repeat(64),
        authorizationGroupId: "group-1",
        targetPolicyId: "policy-1",
        targetPolicyVersion: 7,
      },
    });

    await expect(managedPages.getTargetForDraft({
      draftId: creation.draft.id,
      revision: creation.draft.currentRevisionNumber,
    })).resolves.toMatchObject({
      draftId: "semantic-conflict-draft-1",
      draftRevision: 1,
      draftVersion: 1,
      conflictCandidateId: "candidate-1",
      conflictCandidateVersion: 3,
      managedPageId: "managed-1",
      managedPageVersion: 4,
      linkedDocumentSourceId: "source-1",
      targetSnapshotId: "snapshot-1",
      targetSnapshotHash: "a".repeat(64),
      targetSourceVersion: "source-v7",
      expectedRemoteRevisionId: "12",
      currentBodyContentHash: "b".repeat(64),
      proposedBodyContentHash: canonicalManagedBodyHash(input.revision.content),
      authorizationGroupId: "group-1",
      targetPolicyId: "policy-1",
      targetPolicyVersion: 7,
    });
  });

  it("accepts a later fresh attestation for the same draft intent and rejects altered intent", async () => {
    const fixture = semanticConflictDraftDataSource();
    const repository = createPostgresKnowledgeDraftRepository({
      dataSource: fixture.dataSource,
      knowledgeConflictPermissionAttestationMaxAgeMs: 60_000,
    });
    const firstAt = new Date("2026-08-13T04:00:00.000Z");
    const laterAt = new Date("2026-08-13T04:02:00.000Z");
    const input = semanticConflictCreateInput(firstAt);

    await expect(repository.createDraft(input)).resolves.toMatchObject({ outcome: "applied" });
    await expect(repository.createDraft({
      ...input,
      at: laterAt,
      knowledgeConflictGovernance: {
        ...input.knowledgeConflictGovernance,
        permission: { documentSourceIds: ["source-1"], attestedAt: laterAt },
      },
    })).resolves.toMatchObject({
      outcome: "already_applied",
      draft: { currentRevision: { evidenceState: { status: "current" } } },
    });
    expect(fixture.attestations).toEqual([firstAt, laterAt]);
    await expect(repository.createDraft({
      ...input,
      at: laterAt,
      knowledgeConflictGovernance: {
        ...input.knowledgeConflictGovernance,
        permission: { documentSourceIds: ["source-1"], attestedAt: laterAt },
      },
      revision: { ...input.revision, title: "Altered intent" },
    })).rejects.toBeInstanceOf(KnowledgeDraftOperationConflictError);
  });

  it("recovers an exact legacy conflict creation but rejects changed intent or a revised draft", async () => {
    const fixture = semanticConflictDraftDataSource();
    const repository = createPostgresKnowledgeDraftRepository({
      dataSource: fixture.dataSource,
      knowledgeConflictPermissionAttestationMaxAgeMs: 60_000,
    });
    const firstAt = new Date("2026-08-13T04:00:00.000Z");
    const laterAt = new Date("2026-08-13T04:02:00.000Z");
    const input = semanticConflictCreateInput(firstAt);

    await repository.createDraft(input);
    fixture.useLegacyFingerprint(input);
    await expect(repository.createDraft({
      ...input,
      at: laterAt,
      knowledgeConflictGovernance: {
        ...input.knowledgeConflictGovernance,
        permission: { documentSourceIds: ["source-1"], attestedAt: laterAt },
      },
      revision: { ...input.revision, title: "Changed legacy intent" },
    })).rejects.toBeInstanceOf(KnowledgeDraftOperationConflictError);
    await expect(repository.createDraft({
      ...input,
      at: laterAt,
      knowledgeConflictGovernance: {
        ...input.knowledgeConflictGovernance,
        permission: { documentSourceIds: ["source-1"], attestedAt: laterAt },
      },
    })).resolves.toMatchObject({ outcome: "already_applied" });
    expect(fixture.attestations).toEqual([firstAt, laterAt]);

    fixture.setDraftVersion(2);
    await expect(repository.createDraft({
      ...input,
      at: new Date(laterAt.getTime() + 1_000),
      knowledgeConflictGovernance: {
        ...input.knowledgeConflictGovernance,
        permission: {
          documentSourceIds: ["source-1"],
          attestedAt: new Date(laterAt.getTime() + 1_000),
        },
      },
    })).rejects.toBeInstanceOf(KnowledgeDraftOperationConflictError);
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
      INSERT INTO group_memories (
        id, group_id, memory_scope, category, content, importance, confidence,
        status, idempotency_key, origin, created_by, created_at, updated_at,
        request_fingerprint
      ) VALUES ($1, $2, 'group', 'decision', 'Director approval starts at CNY 10,000.',
        5, 0.95, 'active', $3, 'system', 'iris', $4, $4, $5)
      `,
      [memoryId, groupId, `draft-memory-key-${suffix}`, documentUpdatedAt, "b".repeat(64)],
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
      expect.objectContaining({
        type: "group_memory",
        id: memoryId,
        groupId,
        expectedUpdatedAt: documentUpdatedAt,
      }),
      expect.objectContaining({ type: "document_source", id: documentSourceId }),
    ]));
    await expect(repository.listEvents(id("draft-main"))).resolves.toEqual([
      expect.objectContaining({ eventType: "created", toVersion: 1, operationKey: id("create-main") }),
    ]);
  });

  it.each([
    ["missing", "memory_missing"],
    ["superseded", "memory_superseded"],
    ["timestamp", "memory_timestamp_changed"],
  ] as const)("redacts content when group memory evidence becomes %s", async (change, reason) => {
    const repository = createPostgresKnowledgeDraftRepository({ dataSource: pool });
    const isolatedMemoryId = `${memoryId}-${change}`;
    await pool.query(
      `INSERT INTO group_memories (
        id, group_id, memory_scope, category, content, importance, confidence,
        status, idempotency_key, origin, created_by, created_at, updated_at,
        request_fingerprint
      ) VALUES ($1, $2, 'group', 'decision', 'Current memory', 4, 0.9, 'active',
        $3, 'system', 'iris', $4, $4, $5)`,
      [isolatedMemoryId, groupId, `memory-${change}-${suffix}`, documentUpdatedAt, "c".repeat(64)],
    );
    await repository.createDraft({
      id: id(`draft-memory-${change}`),
      operationKey: id(`create-memory-${change}`),
      originKind: "knowledge_conflict",
      createdBy: "iris",
      at,
      revision: {
        sourceGroupId: groupId,
        title: "Knowledge conflict",
        content: "Review the conflict.",
        riskLevel: "medium",
        evidence: [{
          type: "group_memory",
          id: isolatedMemoryId,
          groupId,
          expectedUpdatedAt: documentUpdatedAt,
        }],
      },
    });

    if (change === "missing") {
      await pool.query("DELETE FROM group_memories WHERE id = $1", [isolatedMemoryId]);
    } else if (change === "superseded") {
      await pool.query("UPDATE group_memories SET status = 'superseded' WHERE id = $1", [isolatedMemoryId]);
    } else {
      await pool.query("UPDATE group_memories SET updated_at = $2 WHERE id = $1", [
        isolatedMemoryId,
        new Date(documentUpdatedAt.getTime() + 1_000),
      ]);
    }

    const draft = await repository.getDraft(id(`draft-memory-${change}`));
    expect(draft?.currentRevision).toMatchObject({
      evidenceState: { status: "invalidated", reason },
    });
    expect(draft?.currentRevision).not.toHaveProperty("content");
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

  it("keeps local unknown fail-closed generally but accepts an exact fresh conflict attestation", async () => {
    const repository = createPostgresKnowledgeDraftRepository({ dataSource: pool });
    const unknownSourceId = id("draft-unknown-source");
    const policyId = id("draft-conflict-policy");
    await pool.query(
      `INSERT INTO document_sources (
        id, source_type, source_uri, title, permission_state, sync_state,
        can_use_for_answering, can_use_for_knowledge_drafts, created_at, updated_at
      ) VALUES ($1, 'authorized_wiki_document', $2, 'Unknown local permission',
        'unknown', 'synced', TRUE, TRUE, $3, $3)`,
      [unknownSourceId, `https://example.com/wiki/unknown/${suffix}`, documentUpdatedAt],
    );
    await pool.query(
      `INSERT INTO knowledge_publication_target_policies (
        id, space_id, parent_node_token, display_name, allowed_group_ids,
        allowed_risk_levels, enabled, version, operation_key, operation_fingerprint,
        created_by, updated_by, created_at, updated_at
      ) VALUES ($1, $2, $3, 'Conflict target', $4, ARRAY['medium'], TRUE, 7,
        $5, $6, 'test', 'test', $7, $7)`,
      [policyId, id("space-conflict"), id("parent-conflict"), [groupId],
        id("policy-operation"), "d".repeat(64), at],
    );
    const revision = {
      sourceGroupId: groupId,
      title: "Knowledge conflict",
      content: "Review exact current evidence.",
      riskLevel: "medium" as const,
      suggestedPublication: { spaceId: id("space-conflict"), parentNodeToken: id("parent-conflict") },
      evidence: [{
        type: "document_source" as const,
        id: unknownSourceId,
        expectedUpdatedAt: documentUpdatedAt,
      }],
    };

    await expect(repository.createDraft({
      id: id("draft-unknown-general"),
      operationKey: id("create-unknown-general"),
      originKind: "user_requested",
      createdBy: "operator",
      revision,
      at,
    })).rejects.toMatchObject({
      name: KnowledgeDraftEvidenceError.name,
      reason: "document_permission_unavailable",
    });

    const conflictInput = {
      id: id("draft-unknown-conflict"),
      operationKey: id("create-unknown-conflict"),
      originKind: "knowledge_conflict" as const,
      createdBy: "iris",
      knowledgeConflictGovernance: {
        permission: { documentSourceIds: [unknownSourceId], attestedAt: at },
        publicationTarget: { id: policyId, version: 7 },
      },
      revision,
      at,
    };
    await expect(repository.createDraft(conflictInput)).resolves.toMatchObject({
      outcome: "applied",
      draft: { originKind: "knowledge_conflict", status: "pending_confirmation" },
    });
    const laterAt = new Date(at.getTime() + 120_000);
    await expect(repository.createDraft({
      ...conflictInput,
      at: laterAt,
      knowledgeConflictGovernance: {
        ...conflictInput.knowledgeConflictGovernance,
        permission: { documentSourceIds: [unknownSourceId], attestedAt: laterAt },
      },
    })).resolves.toMatchObject({
      outcome: "already_applied",
      draft: { currentRevision: { evidenceState: { status: "current" } } },
    });
    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM knowledge_conflict_draft_governance_attestations
       WHERE draft_id = $1`,
      [conflictInput.id],
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    await expect(repository.createDraft({
      ...conflictInput,
      at: laterAt,
      knowledgeConflictGovernance: {
        ...conflictInput.knowledgeConflictGovernance,
        permission: { documentSourceIds: [unknownSourceId], attestedAt: laterAt },
      },
      revision: { ...revision, title: "Altered conflict intent" },
    })).rejects.toBeInstanceOf(KnowledgeDraftOperationConflictError);
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
      {
        type: "group_memory" as const,
        id: memoryId,
        groupId,
        expectedUpdatedAt: documentUpdatedAt,
      },
      { type: "document_source" as const, id: documentSourceId, expectedUpdatedAt: documentUpdatedAt },
    ],
  };
}

function id(value: string): string {
  return `${value}-${suffix}`;
}

function semanticConflictCreateInput(atValue: Date) {
  return {
    id: "semantic-conflict-draft-1",
    operationKey: "semantic-conflict-create-1",
    originKind: "knowledge_conflict" as const,
    createdBy: "iris",
    knowledgeConflictGovernance: {
      permission: { documentSourceIds: ["source-1"], attestedAt: atValue },
      publicationTarget: { id: "policy-1", version: 7 },
    },
    revision: {
      sourceGroupId: "group-1",
      title: "Knowledge update: deployment window",
      content: "Current and newer conclusions.",
      riskLevel: "medium" as const,
      reviewer: { type: "feishu_user" as const, ref: "ou-member" },
      suggestedPublication: { spaceId: "space-main", parentNodeToken: "parent-main" },
      evidence: [{
        type: "document_source" as const,
        id: "source-1",
        expectedUpdatedAt: new Date("2026-08-13T03:00:00.000Z"),
      }],
    },
    at: atValue,
  };
}

function semanticConflictDraftDataSource() {
  const attestations: Date[] = [];
  let updateTarget: Record<string, unknown> | undefined;
  let created = false;
  let operationFingerprint: string | undefined;
  let draftVersion = 1;
  const createdAt = new Date("2026-08-13T04:00:00.000Z");
  const sourceUpdatedAt = new Date("2026-08-13T03:00:00.000Z");
  const query = async (sql: string, params: unknown[] = []): Promise<{ rows: any[] }> => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql) || sql.includes("pg_advisory_xact_lock")) {
      return { rows: [] };
    }
    if (sql.includes("FROM knowledge_draft_events WHERE operation_key")) {
      return { rows: operationFingerprint === undefined ? [] : [{
        draft_id: "semantic-conflict-draft-1",
        operation_fingerprint: operationFingerprint,
        revision_number: 1,
        event_type: "created",
        to_version: 1,
        actor: "iris",
        created_at: createdAt,
      }] };
    }
    if (sql.includes("SELECT 1 FROM knowledge_drafts")) {
      return { rows: created ? [{ exists: 1 }] : [] };
    }
    if (sql.includes("FROM document_sources")) {
      return { rows: [{
        source_type: "authorized_wiki_document",
        permission_state: "unknown",
        sync_state: "synced",
        can_use_for_knowledge_drafts: true,
        updated_at: sourceUpdatedAt,
        exact_group_evidence: false,
      }] };
    }
    if (sql.includes("FROM knowledge_publication_target_policies")) {
      return { rows: [{
        id: "policy-1",
        space_id: "space-main",
        parent_node_token: "parent-main",
        allowed_group_ids: ["group-1"],
        allowed_risk_levels: ["medium"],
        enabled: true,
        version: 7,
      }] };
    }
    if (sql.includes("FROM managed_knowledge_pages") && sql.includes("WHERE id = $1")) {
      return { rows: [{
        id: "managed-1",
        origin_knowledge_publication_id: "publication-1",
        target_policy_id: "policy-1",
        target_policy_version: 7,
        authorization_group_id: "group-1",
        remote_node_token: "wiki-managed-1",
        remote_document_token: "doc-managed-1",
        managed_body_block_id: "block-managed-1",
        linked_document_source_id: "source-1",
        current_remote_revision_id: "12",
        current_body_content_hash: "b".repeat(64),
        expected_resync_content_hash: null,
        state: "active",
        version: 4,
        created_at: createdAt,
        updated_at: createdAt,
      }] };
    }
    if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("FOR UPDATE")) {
      return { rows: [{
        version: 3,
        group_id: "group-1",
        target_document_source_id: "source-1",
        target_snapshot_id: "snapshot-1",
        target_content_hash: "a".repeat(64),
        target_source_version: "source-v7",
      }] };
    }
    if (sql.includes("INSERT INTO knowledge_drafts")) {
      created = true;
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO knowledge_conflict_draft_governance_attestations")) {
      const attestedAt = params[3];
      if (attestedAt instanceof Date &&
        !attestations.some((existing) => existing.getTime() === attestedAt.getTime())) {
        attestations.push(new Date(attestedAt));
      }
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO knowledge_publication_update_targets")) {
      updateTarget = {
        id: params[0],
        draft_id: params[1],
        draft_revision: params[2],
        draft_version: params[3],
        conflict_candidate_id: params[4],
        conflict_candidate_version: params[5],
        managed_page_id: params[6],
        managed_page_version: params[7],
        linked_document_source_id: params[8],
        target_snapshot_id: params[9],
        target_snapshot_hash: params[10],
        target_source_version: params[11],
        remote_document_token: params[12],
        managed_body_block_id: params[13],
        expected_remote_revision_id: params[14],
        current_body_content_hash: params[15],
        proposed_body_content_hash: params[16],
        authorization_group_id: params[17],
        target_policy_id: params[18],
        target_policy_version: params[19],
        operation_key: params[20],
        operation_fingerprint: params[21],
        created_at: params[22],
      };
      return { rows: [] };
    }
    if (sql.includes("FROM knowledge_publication_update_targets")) {
      return { rows: updateTarget === undefined ? [] : [updateTarget] };
    }
    if (sql.includes("INSERT INTO knowledge_draft_events")) {
      operationFingerprint = String(params[6]);
      return { rows: [] };
    }
    if (sql.includes("FROM knowledge_drafts draft")) {
      return { rows: created ? [{
        id: "semantic-conflict-draft-1",
        source_group_id: "group-1",
        origin_kind: "knowledge_conflict",
        status: "pending_confirmation",
        current_revision_number: 1,
        version: draftVersion,
        created_by: "iris",
        rejected_at: null,
        rejected_by: null,
        rejection_reason: null,
        created_at: createdAt,
        updated_at: createdAt,
        title: "Knowledge update: deployment window",
        content: "Current and newer conclusions.",
        risk_level: "medium",
        reviewer_type: "feishu_user",
        reviewer_ref: "ou-member",
        suggested_space_id: "space-main",
        suggested_parent_node_token: "parent-main",
        revision_author: "iris",
        revision_created_at: createdAt,
      }] : [] };
    }
    if (sql.includes("FROM knowledge_draft_revision_evidence")) {
      return { rows: [{
        evidence_type: "document_source",
        reference_id: "source-1",
        source_group_id: null,
        entity_version: null,
        source_updated_at: sourceUpdatedAt,
      }] };
    }
    if (sql.includes("DISTINCT ON (document_source_id)")) {
      const earliest = attestations[0];
      return { rows: earliest === undefined ? [] : [{
        document_source_id: "source-1",
        permission_attested_at: earliest,
        target_policy_id: "policy-1",
        target_policy_version: 7,
      }] };
    }
    if (sql.includes("FROM knowledge_conflict_draft_governance_attestations")) {
      const latest = attestations.at(-1);
      return { rows: latest === undefined ? [] : [{ permission_attested_at: latest }] };
    }
    return { rows: [] };
  };
  const client = { query, release() {} };
  return {
    attestations,
    useLegacyFingerprint(input: ReturnType<typeof semanticConflictCreateInput>) {
      operationFingerprint = createHash("sha256")
        .update(JSON.stringify({
          operation: "create",
          id: input.id,
          operationKey: input.operationKey,
          originKind: input.originKind,
          createdBy: input.createdBy,
          at: input.at,
          revision: input.revision,
          knowledgeConflictGovernance: input.knowledgeConflictGovernance,
        }, (_key, value) => value instanceof Date ? value.toISOString() : value))
        .digest("hex");
    },
    setDraftVersion(version: number) { draftVersion = version; },
    dataSource: {
      query,
      async connect() { return client; },
    },
  };
}
