import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

import pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

describe("runMigrations", () => {
  it("reserves one ordered managed knowledge publication update ledger migration", async () => {
    const migrationNames = await readdir(defaultMigrationsDir());
    expect(migrationNames.filter((name) => name.startsWith("0052_"))).toEqual([
      "0052_managed_knowledge_publication_updates.sql",
    ]);
    expect(migrationNames.indexOf("0052_managed_knowledge_publication_updates.sql"))
      .toBeGreaterThan(migrationNames.indexOf("0051_document_source_group_grants.sql"));

    const sql = await readFile(
      join(defaultMigrationsDir(), "0052_managed_knowledge_publication_updates.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
    expect(normalized).toContain("managed_knowledge_updates_one_unresolved_page_idx");
    expect(normalized).toContain("managed_knowledge_page_events_append_only");
    expect(normalized).toContain("knowledge_publication_update_execution_events_append_only");
    expect(normalized).toContain("knowledge_publication_updates_append_only");
    expect(normalized).toContain("references knowledge_conflict_candidates(id) on delete restrict");
    expect(normalized).toContain("references managed_knowledge_pages(id) on delete restrict");
    expect(normalized).toContain("remote_request_dispatched_at is not null");
    expect(normalized).toContain("response_revision_id is not null");
  });

  it("reserves exactly one ordered 0046 knowledge-conflict migration", async () => {
    const migrationNames = await readdir(defaultMigrationsDir());
    expect(migrationNames.filter((name) => name.startsWith("0046_"))).toEqual([
      "0046_knowledge_conflict_candidates.sql",
    ]);
    expect(migrationNames.indexOf("0046_knowledge_conflict_candidates.sql"))
      .toBeGreaterThan(migrationNames.indexOf("0045_answer_source_citations.sql"));
  });

  it("defines attempt-bound attributable reconciliation and append-only scan recovery facts in 0046", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0046_knowledge_conflict_candidates.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain("create table knowledge_conflict_scan_operations");
    expect(normalized).toContain("expected_attempt_count integer not null");
    expect(normalized).toContain("expected_updated_at timestamptz not null");
    expect(normalized).toContain("actor_ref text not null");
    expect(normalized).toContain("knowledge_conflict_scan_operations_append_only");
    expect(normalized).toContain("knowledge_conflict_scan_operations_truncate_guard");
    const reconciliationTable = normalized.match(
      /create table knowledge_conflict_delivery_reconciliations \((.*?)\);/u,
    )?.[1];
    expect(reconciliationTable).toContain("attempt_count integer not null");
    expect(reconciliationTable).toContain("actor_ref text not null");
  });

  it("defines an exact auditable candidate-version backfill without weakening append-only guards", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0049_answer_reply_knowledge_conflict_candidate_version.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain("add column candidate_version bigint");
    expect(normalized).not.toMatch(/candidate_version bigint default/iu);
    expect(normalized).toContain(
      "update answer_reply_knowledge_conflicts binding set candidate_version = candidate.version "
      + "from knowledge_conflict_candidates candidate where candidate.id = binding.candidate_id",
    );
    expect(normalized).toContain("alter column candidate_version set not null");
    expect(normalized).toContain("check (candidate_version >= 1)");
    expect(normalized).toContain("drop trigger answer_reply_knowledge_conflicts_append_only");
    expect(normalized).toContain("create trigger answer_reply_knowledge_conflicts_append_only");
    expect(normalized).not.toContain("drop trigger answer_reply_knowledge_conflicts_truncate_guard");
  });

  it("adds an explicit not-sent reconciliation state and immutable event in 0050", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0050_answer_reply_not_sent_reconciliation.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain("not_sent_reconciled");
    expect(normalized).toContain("answer_reply_deliveries_state_check");
    expect(normalized).toContain("answer_reply_deliveries_content_shape_check");
    expect(normalized).toContain("answer_reply_delivery_events_event_type_check");
    expect(normalized).not.toContain("drop trigger");
    expect(normalized).not.toContain("disable trigger");
  });

  it("defines ordered append-only cross-group document grants and exact receipt bindings in 0051", async () => {
    const migrationNames = await readdir(defaultMigrationsDir());
    expect(migrationNames.filter((name) => name.startsWith("0051_"))).toEqual([
      "0051_document_source_group_grants.sql",
    ]);
    expect(migrationNames.indexOf("0051_document_source_group_grants.sql"))
      .toBeGreaterThan(migrationNames.indexOf("0050_answer_reply_not_sent_reconciliation.sql"));

    const sql = await readFile(
      join(defaultMigrationsDir(), "0051_document_source_group_grants.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
    const grantTable = normalized.match(
      /create table document_source_group_grants \((.*?)\);/u,
    )?.[1];
    const eventTable = normalized.match(
      /create table document_source_group_grant_events \((.*?)\);/u,
    )?.[1];

    expect(grantTable).toContain("document_source_id text not null");
    expect(grantTable).toContain("grantor_group_id text not null");
    expect(grantTable).toContain("grantee_group_id text not null");
    expect(grantTable).toContain("unique (document_source_id, grantee_group_id)");
    expect(eventTable).toContain("operation_key text not null unique");
    expect(eventTable).toContain("operation_fingerprint text not null");
    expect(normalized).toContain("document_source_group_grant_events_append_only");
    expect(normalized).toContain("document_source_group_grant_events_truncate_guard");
    expect(normalized).toContain("add column cross_group_grant_id text");
    expect(normalized).toContain("add column cross_group_grant_version bigint");
    expect(normalized).toContain("add column cross_group_grantor_group_id text");
    expect(normalized).toContain("add column cross_group_grantee_group_id text");
    expect(normalized).toContain("answer_reply_source_traces_cross_group_grant_shape_check");
  });

  it("defines bounded append-only answer source citation receipts", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0045_answer_source_citations.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
    const sourceTraceTable = normalized.match(
      /create table answer_reply_source_traces \((.*?)\);/u,
    )?.[1];
    const deliveryEventTable = normalized.match(
      /create table answer_reply_delivery_events \((.*?)\);/u,
    )?.[1];

    expect(normalized).toContain("create table answer_reply_deliveries");
    expect(normalized).toContain("create table answer_reply_source_traces");
    expect(normalized).toContain("create table answer_reply_delivery_events");
    expect(normalized).toContain("unique (provider, incoming_message_id)");
    expect(normalized).toContain("prepared_reply_text");
    expect(normalized).toContain("rendered_reply_fingerprint");
    expect(normalized).toContain("semantic_fingerprint");
    expect(normalized).toContain("attempt_count");
    expect(normalized).toContain("safe_notice_attempt_count");
    expect(normalized).toContain("version");
    expect(normalized).toContain("answer_reply_source_traces_append_only");
    expect(normalized).toContain("answer_reply_delivery_events_append_only");
    expect(normalized).toContain(
      "create function answer_reply_document_source_ids_valid",
    );
    expect(normalized).toContain(
      "constraint answer_reply_delivery_events_document_source_ids_check check",
    );
    expect(normalized).toContain(
      "answer_reply_document_source_ids_valid(document_source_ids, source_count)",
    );

    expect(sourceTraceTable).toBeDefined();
    expect(sourceTraceTable).not.toMatch(
      /(?:^|,)\s*(?:text|fragment_text|prompt|answer_text)\s+/u,
    );
    expect(deliveryEventTable).toBeDefined();
    expect(deliveryEventTable).not.toMatch(
      /(?:^|,)\s*(?:content|text|fragment_text|prompt|answer_text)\s+/u,
    );
  });

  it("allows ordered durable updates for the same knowledge card presentation", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0044_knowledge_publication_group_result.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain(
      "drop constraint if exists knowledge_draft_presentation_outbox_presentation_id_key",
    );
    expect(normalized).toContain(
      "create index knowledge_draft_presentation_outbox_presentation_order_idx",
    );
    expect(normalized).toContain("delivery_sequence integer not null default 1");
    expect(normalized).toContain("unique (presentation_id, delivery_sequence)");
  });

  it("defines native 768-dimensional fragment storage", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0043_document_fragment_embeddings_768.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain("create table if not exists document_fragment_embeddings_768");
    expect(normalized).toContain("embedding vector(768) not null");
  });

  it("defines native 1024-dimensional fragment storage", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0042_document_fragment_embeddings_1024.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain("create table if not exists document_fragment_embeddings_1024");
    expect(normalized).toContain("embedding vector(1024) not null");
  });

  it("assigns 0032 to action approval facts and keeps 0031 external-attempt state", async () => {
    const migrationNames = await readdir(defaultMigrationsDir());
    expect(migrationNames.filter((name) => name.startsWith("0032_"))).toEqual([
      "0032_action_approval_facts.sql",
    ]);

    const sql = await readFile(
      join(defaultMigrationsDir(), "0031_knowledge_draft_presentations.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
    expect(normalized).toContain("'external_attempting'");
    expect(normalized).toMatch(
      /state text not null check \(state in \( ?'pending', 'processing', 'external_attempting', 'sent', 'failed', 'outcome_unknown' ?\)\)/u,
    );
  });

  it("defines the named action-aware group-memory scope constraint in 0026", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0026_projection_rollout_contracts.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain(
      "add constraint group_memories_scope_thread_key_check check",
    );
    expect(normalized).toContain("memory_scope = 'thread' and thread_key is not null");
    expect(normalized).toContain("memory_scope = 'group' and thread_key is null");
    expect(normalized).toContain("memory_scope = 'action'");
    expect(normalized).toContain(
      "add column thread_operation_rejected_count smallint not null default 0",
    );
    expect(normalized).toContain(
      "check (thread_operation_rejected_count between 0 and 8)",
    );
    expect(normalized).toContain(
      "add column action_operation_rejected_count smallint not null default 0",
    );
    expect(normalized).toContain(
      "check (action_operation_rejected_count between 0 and 8)",
    );
  });

  it("defines durable Feishu mention identities for conversation facts", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0023_conversation_message_mentions.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain("create table conversation_message_mentions");
    expect(normalized).toContain(
      "conversation_message_id text not null references conversation_messages(id) on delete cascade",
    );
    expect(normalized).toContain("primary key (conversation_message_id, mention_key)");
    expect(normalized).toContain("unique (conversation_message_id, mentioned_open_id)");
    expect(normalized).toContain("char_length(mention_key) between 1 and 512");
    expect(normalized).toContain("char_length(mentioned_open_id) between 1 and 512");
    expect(normalized).toContain(
      "create index conversation_message_mentions_open_id_idx on conversation_message_mentions (mentioned_open_id, conversation_message_id)",
    );
  });

  it("defines a forward migration that releases extraction memory references on hard delete", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0021_group_memory_extraction_memory_delete.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain(
      "drop constraint group_memory_extraction_run_memories_pkey",
    );
    expect(normalized).toContain("primary key (run_id, ordinal)");
    expect(normalized).toContain("alter column memory_id drop not null");
    expect(normalized).toContain(
      "foreign key (memory_id) references group_memories(id) on delete set null",
    );
    expect(normalized).toContain("where memory_id is not null");
    expect(normalized).not.toContain("drop table group_memory_extraction_run_memories");
  });

  it("defines durable conflict candidates and evidence without retaining raw model payloads", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0022_group_memory_extraction_conflicts.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain("create table group_memory_extraction_conflict_candidates");
    expect(normalized).toContain("primary key (run_id, ordinal)");
    expect(normalized).toContain("category text not null");
    expect(normalized).toContain("content text not null");
    expect(normalized).toContain("importance smallint not null");
    expect(normalized).toContain("confidence double precision not null");
    expect(normalized).toContain(
      "target_memory_id text references group_memories(id) on delete set null",
    );
    expect(normalized).toContain("create table group_memory_extraction_conflict_evidence");
    expect(normalized).toContain(
      "foreign key (run_id, conflict_ordinal) references group_memory_extraction_conflict_candidates (run_id, ordinal) on delete cascade",
    );
    expect(normalized).not.toMatch(/raw_(payload|response)|model_payload/u);
  });

  it("defines a durable cumulative memory extraction failure counter migration", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0020_group_memory_extraction_failure_count.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain(
      "alter table group_memory_extraction_runs add column failure_count bigint",
    );
    expect(normalized).toContain(
      "set failure_count = case when status = 'failed' then 1 else 0 end",
    );
    expect(normalized).toContain("alter column failure_count set default 0");
    expect(normalized).toContain("alter column failure_count set not null");
    expect(normalized).toContain("check (failure_count >= 0)");
  });

  it("applies pending migrations in lexical order", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "iris-migrations-"));
    await writeFile(join(migrationsDir, "0002_second.sql"), "select 2;");
    await writeFile(join(migrationsDir, "0001_first.sql"), "select 1;");

    const queries: string[] = [];
    const applied = new Set<string>();
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push(sql);

      if (sql.includes("select name from schema_migrations")) {
        return {
          rows: Array.from(applied).map((name) => ({ name })),
        };
      }

      if (sql.includes("insert into schema_migrations")) {
        const migrationName = values?.[0];
        if (typeof migrationName === "string") {
          applied.add(migrationName);
        }
      }

      return { rows: [], values };
    });

    const result = await runMigrations({
      client: { query } as unknown as MigrationClient,
      migrationsDir,
    });

    expect(result).toEqual({
      applied: ["0001_first.sql", "0002_second.sql"],
      skipped: [],
    });
    expect(queries).toContain("select 1;");
    expect(queries).toContain("select 2;");
    expect(Array.from(applied)).toEqual(["0001_first.sql", "0002_second.sql"]);
  });

  it("skips already applied migrations without executing SQL or inserting again", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "iris-migrations-"));
    await writeFile(
      join(migrationsDir, "0001_already_applied.sql"),
      "select should_not_run;",
    );

    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);

      if (sql.includes("select name from schema_migrations")) {
        return {
          rows: [{ name: "0001_already_applied.sql" }],
        };
      }

      return { rows: [] };
    });

    const result = await runMigrations({
      client: { query } as unknown as MigrationClient,
      migrationsDir,
    });

    expect(result).toEqual({
      applied: [],
      skipped: ["0001_already_applied.sql"],
    });
    expect(queries).not.toContain("select should_not_run;");
    expect(
      queries.some((sql) => sql.includes("insert into schema_migrations")),
    ).toBe(false);
  });

  it("rolls back and does not record a migration when migration SQL fails", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "iris-migrations-"));
    await writeFile(join(migrationsDir, "0001_fails.sql"), "select explode;");
    const migrationError = new Error("migration failed");

    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);

      if (sql.includes("select name from schema_migrations")) {
        return { rows: [] };
      }

      if (sql === "select explode;") {
        throw migrationError;
      }

      return { rows: [] };
    });

    await expect(
      runMigrations({
        client: { query } as unknown as MigrationClient,
        migrationsDir,
      }),
    ).rejects.toBe(migrationError);

    expect(queries).toContain("rollback");
    expect(
      queries.some((sql) => sql.includes("insert into schema_migrations")),
    ).toBe(false);
  });

  it("throws the original migration error when rollback also fails", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "iris-migrations-"));
    await writeFile(join(migrationsDir, "0001_fails.sql"), "select explode;");
    const migrationError = new Error("migration failed");
    const rollbackError = new Error("rollback failed");

    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select name from schema_migrations")) {
        return { rows: [] };
      }

      if (sql === "select explode;") {
        throw migrationError;
      }

      if (sql === "rollback") {
        throw rollbackError;
      }

      return { rows: [] };
    });

    await expect(
      runMigrations({
        client: { query } as unknown as MigrationClient,
        migrationsDir,
      }),
    ).rejects.toBe(migrationError);
  });
});

describe("defaultMigrationsDir", () => {
  it("orders 0041 after the existing migrations and defines durable wiki-space authorization constraints", async () => {
    const migrationNames = await readdir(defaultMigrationsDir());
    const priorMigrationIndex = migrationNames.indexOf("0040_proactive_signal_feedback.sql");
    const migrationIndex = migrationNames.indexOf("0041_wiki_space_authorizations.sql");
    expect(migrationIndex).toBeGreaterThan(priorMigrationIndex);

    const migration = await readFile(
      join(defaultMigrationsDir(), "0041_wiki_space_authorizations.sql"),
      "utf8",
    );
    const normalized = migration.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain("create table wiki_space_authorizations");
    expect(normalized).toContain("unique (root_source_uri)");
    expect(normalized).toContain("scan_state in ('pending', 'scanning', 'synced', 'retry_wait', 'dead_letter', 'disabled')");
    expect(normalized).toContain("check (attempt_count >= 0)");
    expect(normalized).toContain("check (discovered_node_count >= 0)");
    expect(normalized).toContain("check (registered_document_count >= 0)");
    expect(normalized).toContain("check (skipped_node_count >= 0)");
    expect(normalized).toContain("check (revision >= 1)");
    expect(normalized).toContain("create index wiki_space_authorizations_due_scan_idx");
    expect(normalized).toContain(
      "where enabled and scan_state in ('pending', 'retry_wait', 'synced')",
    );
    expect(normalized).toContain("create index wiki_space_authorizations_expired_lease_idx");
  });

  it("defines bounded durable conversation-state snapshots and content-free completion diagnostics", async () => {
    const migration = await readFile(
      join(defaultMigrationsDir(), "0025_conversation_state_extraction.sql"),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim().toLowerCase();

    expect(normalized).toContain("create table group_memory_extraction_run_threads");
    expect(normalized).toContain("ordinal smallint not null check (ordinal between 0 and 11)");
    expect(normalized).toContain("thread_version bigint not null check (thread_version >= 1)");
    expect(normalized).toContain("thread_updated_at timestamptz not null");
    expect(normalized).toContain("thread_evidence_count bigint not null check (thread_evidence_count >= 0)");
    expect(normalized).toContain("create table group_memory_extraction_run_actions");
    expect(normalized).toContain("action_version bigint not null check (action_version >= 1)");
    expect(normalized).toContain("action_updated_at timestamptz not null");
    expect(normalized).toContain("create table group_memory_extraction_run_mentions");
    expect(normalized).toContain(
      "alter table discussion_thread_events drop constraint discussion_thread_events_event_type_check",
    );
    expect(normalized).toContain(
      "add constraint discussion_thread_events_event_type_check check (event_type in ( 'created', 'promoted', 'summary_updated', 'resolved', 'reopened', 'merged', 'corrected', 'evidence_attached' ))",
    );
    expect(normalized).toContain("thread_operation_count smallint not null default 0");
    expect(normalized).toContain("action_operation_count smallint not null default 0");
    expect(normalized).toContain("conversation_state_rejected_count smallint not null default 0");
    expect(normalized).toContain("conversation_state_rejection_codes text[] not null default array[]::text[]");
  });

  it("defines authoritative semantic state, operation claim, and projection repair tables", async () => {
    const migration = await readFile(
      join(defaultMigrationsDir(), "0024_semantic_thread_action_memory.sql"),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim().toLowerCase();

    expect(normalized).toContain("create table discussion_threads");
    expect(normalized).toContain("status in ('candidate', 'open', 'resolved', 'merged')");
    expect(normalized).toContain("foreign key (merged_into_thread_id, group_id)");
    expect(normalized.match(/unique \(id, group_id\)/g)).toHaveLength(5);
    expect(normalized.match(/version bigint not null default 1 check \(version >= 1\)/g)).toHaveLength(
      2,
    );
    expect(normalized.match(/from_version bigint check \(from_version is null or from_version >= 1\)/g)).toHaveLength(
      2,
    );
    expect(normalized.match(/to_version bigint not null check \(to_version >= 1\)/g)).toHaveLength(
      2,
    );
    expect(normalized).toContain(
      "alter table conversation_messages add constraint conversation_messages_id_chat_id_key unique (id, chat_id)",
    );
    expect(normalized).toContain(
      "alter table group_memories add constraint group_memories_id_group_id_key unique (id, group_id)",
    );
    expect(normalized).toContain("create table discussion_thread_evidence");
    expect(normalized).toContain("primary key (thread_id, conversation_message_id)");
    expect(normalized).toContain("foreign key (thread_id, group_id)");
    expect(
      normalized.match(
        /foreign key \(conversation_message_id, group_id\) references conversation_messages\(id, chat_id\) on delete restrict/g,
      ),
    ).toHaveLength(3);
    expect(normalized).toContain("create table discussion_thread_events");
    expect(normalized).not.toContain("'evidence_attached'");
    expect(normalized.match(/unique \(group_id, operation_key\)/g)).toHaveLength(2);
    expect(normalized).toContain("unique (id, group_id)");
    expect(normalized).toContain("create table discussion_thread_event_evidence");
    expect(normalized.match(/primary key \(event_id, conversation_message_id\)/g)).toHaveLength(2);
    expect(normalized).toContain(
      "foreign key (event_id, group_id) references discussion_thread_events(id, group_id) on delete cascade",
    );
    expect(normalized).toContain("create table action_items");
    expect(normalized).toContain("owner_ref_type in ('feishu_user', 'text_label')");
    expect(normalized).toContain("status in ('open', 'completed', 'cancelled')");
    expect(normalized).toContain("foreign key (thread_id, group_id)");
    expect(normalized).toContain("create table action_item_events");
    expect(normalized).toContain(
      "foreign key (action_item_id, group_id) references action_items(id, group_id) on delete cascade",
    );
    expect(normalized).toContain("create table action_item_event_evidence");
    expect(normalized).toContain(
      "foreign key (event_id, group_id) references action_item_events(id, group_id) on delete cascade",
    );
    expect(normalized).toContain("create table conversation_state_operation_claims");
    expect(normalized).toContain("primary key (group_id, operation_key)");
    expect(normalized).toContain("entity_type text not null check (entity_type in ('thread', 'action'))");
    expect(normalized).toContain(
      "operation_fingerprint text not null check (operation_fingerprint ~ '^[0-9a-f]{64}$')",
    );
    expect(normalized).toContain(
      "entity_id text not null check (char_length(entity_id) between 1 and 512)",
    );
    expect(normalized).toContain(
      "operation_key text not null check (char_length(operation_key) between 1 and 512)",
    );
    expect(normalized).toContain("create table conversation_state_memory_projections");
    expect(normalized).toContain("primary key (entity_type, entity_id)");
    expect(normalized).toContain(
      "projected_version bigint not null check (projected_version >= 1)",
    );
    expect(normalized).toContain(
      "foreign key (memory_id, group_id) references group_memories(id, group_id) on delete set null (memory_id)",
    );
    expect(normalized).toContain("create table conversation_state_projection_repairs");
    expect(normalized).toContain("unique (entity_type, entity_id, entity_version)");
    expect(normalized).toContain(
      "entity_version bigint not null check (entity_version >= 1)",
    );
    expect(normalized).toContain("status in ('pending', 'processing', 'completed', 'failed')");
    expect(normalized).toContain(
      "create index conversation_state_projection_repairs_pending_idx",
    );
    expect(normalized).toContain(
      "create or replace function conversation_state_event_append_only_guard()",
    );
    expect(normalized).not.toContain("iris.allow_conversation_state_event_delete");
    expect(normalized.match(/before update or delete on/g)).toHaveLength(5);
    expect(normalized.match(/before truncate on/g)).toHaveLength(5);
    expect(normalized.match(/for each statement execute function conversation_state_event_append_only_guard\(\)/g)).toHaveLength(
      5,
    );
    expect(normalized).toContain("create trigger discussion_thread_events_append_only");
    expect(normalized).toContain(
      "create trigger discussion_thread_event_evidence_append_only",
    );
    expect(normalized).toContain("create trigger action_item_events_append_only");
    expect(normalized).toContain(
      "create trigger action_item_event_evidence_append_only",
    );
    expect(normalized).toContain("create trigger conversation_state_operation_claims_append_only");
    expect(normalized).toContain(
      "create trigger discussion_thread_events_truncate_guard",
    );
    expect(normalized).toContain(
      "create trigger discussion_thread_event_evidence_truncate_guard",
    );
    expect(normalized).toContain("create trigger action_item_events_truncate_guard");
    expect(normalized).toContain(
      "create trigger action_item_event_evidence_truncate_guard",
    );
    expect(normalized).toContain(
      "create trigger conversation_state_operation_claims_truncate_guard",
    );
  });

  it("points at the migrations directory", () => {
    expect(defaultMigrationsDir()).toMatch(/[\\/]migrations$/);
  });

  it("includes embedding profile migration after document fragments", async () => {
    await expect(readdir(defaultMigrationsDir())).resolves.toEqual(
      expect.arrayContaining(["0003_document_fragments.sql", "0004_embedding_profiles.sql"]),
    );
  });

  it("includes dimension-sharded vector storage migration after embedding profiles", async () => {
    await expect(readdir(defaultMigrationsDir())).resolves.toEqual(
      expect.arrayContaining([
        "0004_embedding_profiles.sql",
        "0005_dimension_sharded_vector_storage.sql",
      ]),
    );
  });

  it("includes migration to scope document fragment uniqueness by embedding profile", async () => {
    const migration = await readFile(
      join(defaultMigrationsDir(), "0013_document_fragment_profile_uniqueness.sql"),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim().toLowerCase();

    expect(normalized).toContain(
      "drop constraint if exists document_fragments_document_snapshot_id_chunk_index_key",
    );
    expect(normalized).toContain(
      "unique (document_snapshot_id, embedding_profile_id, chunk_index)",
    );
  });

  it("includes migration to lock denied document source capabilities", async () => {
    const migration = await readFile(
      join(defaultMigrationsDir(), "0014_denied_document_source_capability_lock.sql"),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim().toLowerCase();

    expect(normalized).toContain("where permission_state = 'denied'");
    expect(normalized).toContain("can_use_for_answering = false");
    expect(normalized).toContain("can_use_for_knowledge_drafts = false");
    expect(normalized).toContain(
      "add constraint document_sources_denied_capabilities_disabled",
    );
  });

  it("includes migration to persist document source policy overrides", async () => {
    const migration = await readFile(
      join(defaultMigrationsDir(), "0015_document_source_policy_overrides.sql"),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim().toLowerCase();

    expect(normalized).toContain(
      "add column knowledge_drafts_policy_overridden boolean not null default false",
    );
  });

  it("includes the conservative singleton runtime-control state", async () => {
    const migration = await readFile(
      join(defaultMigrationsDir(), "0016_runtime_control_state.sql"),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim().toLowerCase();

    expect(normalized).toContain("create table runtime_control_state");
    expect(normalized).toContain("primary key check (singleton_id = 1)");
    expect(normalized).toContain("revision bigint not null check (revision >= 0)");
    expect(normalized).toContain("desired_global_enabled boolean not null");
    expect(normalized).toContain("disabled_group_ids text[] not null");
    expect(normalized).toContain("capabilities jsonb not null");
    expect(normalized).toContain("values (1, 0, false, array[]::text[]");

    const capabilitiesJson = migration.match(/'({[^']+})'::jsonb/)?.[1];
    expect(capabilitiesJson).toBeDefined();
    expect(JSON.parse(capabilitiesJson!)).toEqual({
      readGroupContext: true,
      replyWhenMentioned: true,
      readGroupDocuments: true,
      retrieveKnowledgeBase: true,
      proactiveSpeech: true,
      generateKnowledgeDrafts: true,
      writeKnowledgeBase: false,
      callExternalTools: false,
    });
  });

  it("includes durable group memories with same-group idempotency and message evidence", async () => {
    const migration = await readFile(
      join(defaultMigrationsDir(), "0017_group_memories.sql"),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim().toLowerCase();

    expect(normalized).toContain("create table if not exists group_memories");
    expect(normalized).toContain("unique (group_id, idempotency_key)");
    expect(normalized).toContain(
      "conversation_message_id text not null references conversation_messages(id) on delete restrict",
    );
    expect(normalized).toContain("primary key (memory_id, conversation_message_id)");
    expect(normalized).toContain("memory_scope in ('group', 'thread', 'action')");
    expect(normalized).toContain("status in ('active', 'superseded')");
  });

  it("adds a fail-closed request fingerprint to group-memory idempotency records", async () => {
    const migration = await readFile(
      join(defaultMigrationsDir(), "0018_group_memory_request_fingerprints.sql"),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim().toLowerCase();

    expect(normalized).toContain(
      "add column if not exists request_fingerprint text",
    );
    expect(normalized).toContain(
      "set request_fingerprint = repeat('0', 64)",
    );
    expect(normalized).toContain("alter column request_fingerprint set not null");
    expect(normalized).toContain("request_fingerprint ~ '^[0-9a-f]{64}$'");
  });

  it("includes durable group-memory extraction requests and runs after request fingerprints", async () => {
    const migrationNames = (await readdir(defaultMigrationsDir())).sort((left, right) =>
      left.localeCompare(right),
    );
    const fingerprintIndex = migrationNames.indexOf(
      "0018_group_memory_request_fingerprints.sql",
    );
    const extractionIndex = migrationNames.indexOf("0019_group_memory_extraction.sql");

    expect(fingerprintIndex).toBeGreaterThanOrEqual(0);
    expect(extractionIndex).toBeGreaterThan(fingerprintIndex);

    const migration = await readFile(
      join(defaultMigrationsDir(), "0019_group_memory_extraction.sql"),
      "utf8",
    );
    const normalized = migration.replace(/\s+/g, " ").trim().toLowerCase();

    expect(normalized).toContain("create table group_memory_extraction_requests");
    expect(normalized).toContain("create table group_memory_extraction_runs");
    expect(normalized).toContain("unique (conversation_message_id)");
    expect(normalized).toContain("unique (input_fingerprint)");
    expect(normalized).toContain("status in ('pending', 'processing', 'completed', 'skipped')");
    expect(normalized).toContain("status in ('processing', 'completed', 'failed')");
    expect(normalized).toContain(
      "conversation_message_id text not null references conversation_messages(id) on delete restrict",
    );
    expect(normalized).toContain(
      "request_id text not null references group_memory_extraction_requests(id) on delete restrict",
    );
    expect(normalized).toContain("content_hash ~ '^[0-9a-f]{64}$'");
  });
});

runIfDatabase("conversation-state extraction migration upgrade with Postgres", () => {
  it("upgrades the anonymous 0025 group-memory constraint to the named 0026 contract", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const schema = `task7_upgrade_${randomUUID().replaceAll("-", "")}`;
    const migrationsDir = await mkdtemp(join(tmpdir(), "iris-task7-upgrade-"));
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(`
        CREATE TABLE schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        INSERT INTO schema_migrations (name) VALUES ('0025_conversation_state_extraction.sql');
        CREATE TABLE group_memories (
          id TEXT PRIMARY KEY,
          memory_scope TEXT NOT NULL,
          thread_key TEXT,
          CHECK (
            (memory_scope = 'thread' AND thread_key IS NOT NULL)
            OR (memory_scope <> 'thread' AND thread_key IS NULL)
          ),
          CONSTRAINT group_memories_business_thread_key_check CHECK (
            memory_scope <> 'action' OR thread_key IS NULL OR thread_key <> 'blocked'
          )
        );
        CREATE TABLE group_memory_extraction_runs (id TEXT PRIMARY KEY);
        INSERT INTO group_memories (id, memory_scope, thread_key)
        VALUES ('existing-action', 'action', NULL);
      `);
      await writeFile(
        join(migrationsDir, "0026_projection_rollout_contracts.sql"),
        await readFile(
          join(defaultMigrationsDir(), "0026_projection_rollout_contracts.sql"),
          "utf8",
        ),
      );

      await expect(runMigrations({ client, migrationsDir })).resolves.toMatchObject({
        applied: ["0026_projection_rollout_contracts.sql"],
      });
      await expect(client.query(`
        INSERT INTO group_memories (id, memory_scope, thread_key)
        VALUES ('threaded-action', 'action', 'thread-7')
      `)).resolves.toMatchObject({ rows: [] });
      await expect(client.query(`
        INSERT INTO group_memories (id, memory_scope, thread_key)
        VALUES ('invalid-group', 'group', 'thread-7')
      `)).rejects.toMatchObject({ constraint: "group_memories_scope_thread_key_check" });
      await expect(client.query(`
        INSERT INTO group_memories (id, memory_scope, thread_key)
        VALUES ('blocked-action', 'action', 'blocked')
      `)).rejects.toMatchObject({ constraint: "group_memories_business_thread_key_check" });
      await expect(client.query<{ conname: string }>(`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'group_memories'::regclass AND contype = 'c'
        ORDER BY conname
      `)).resolves.toMatchObject({
        rows: [
          { conname: "group_memories_business_thread_key_check" },
          { conname: "group_memories_scope_thread_key_check" },
        ],
      });
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  });

  it.each([
    ["zero", ""],
    ["multiple", `
      ALTER TABLE group_memories ADD CONSTRAINT duplicate_legacy_scope_check CHECK (
        (memory_scope = 'thread' AND thread_key IS NOT NULL)
        OR (memory_scope <> 'thread' AND thread_key IS NULL)
      );
    `],
  ])("fails closed when the legacy 0017 constraint match count is %s", async (_label, extraSql) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const schema = `task7_constraint_count_${randomUUID().replaceAll("-", "")}`;
    const migrationsDir = await mkdtemp(join(tmpdir(), "iris-task7-constraint-count-"));
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(`
        CREATE TABLE schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        INSERT INTO schema_migrations (name) VALUES ('0025_conversation_state_extraction.sql');
        CREATE TABLE group_memories (
          id TEXT PRIMARY KEY,
          memory_scope TEXT NOT NULL,
          thread_key TEXT
        );
        CREATE TABLE group_memory_extraction_runs (id TEXT PRIMARY KEY);
        ${_label === "multiple" ? `
          ALTER TABLE group_memories ADD CONSTRAINT first_legacy_scope_check CHECK (
            (memory_scope = 'thread' AND thread_key IS NOT NULL)
            OR (memory_scope <> 'thread' AND thread_key IS NULL)
          );
        ` : ""}
        ${extraSql}
      `);
      await writeFile(
        join(migrationsDir, "0026_projection_rollout_contracts.sql"),
        await readFile(
          join(defaultMigrationsDir(), "0026_projection_rollout_contracts.sql"),
          "utf8",
        ),
      );

      await expect(runMigrations({ client, migrationsDir })).rejects.toThrow();
      await expect(client.query(
        "SELECT name FROM schema_migrations WHERE name = '0026_projection_rollout_contracts.sql'",
      )).resolves.toMatchObject({ rows: [] });
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  });

  it("upgrades an already-applied 0024 event constraint without rerunning 0024", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const schema = `task6_upgrade_${randomUUID().replaceAll("-", "")}`;
    const migrationsDir = await mkdtemp(join(tmpdir(), "iris-task6-upgrade-"));
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(`
        CREATE TABLE schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        INSERT INTO schema_migrations (name) VALUES ('0024_semantic_thread_action_memory.sql');
        CREATE TABLE group_memory_extraction_runs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'processing'
        );
        CREATE TABLE conversation_messages (id TEXT PRIMARY KEY);
        CREATE TABLE discussion_threads (id TEXT PRIMARY KEY);
        CREATE TABLE action_items (id TEXT PRIMARY KEY);
        CREATE TABLE discussion_thread_events (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES discussion_threads(id),
          event_type TEXT NOT NULL CHECK (event_type IN (
            'created', 'promoted', 'summary_updated', 'resolved', 'reopened',
            'merged', 'corrected'
          ))
        );
        INSERT INTO discussion_threads (id) VALUES ('thread-1');
        INSERT INTO discussion_thread_events (id, thread_id, event_type)
        VALUES ('event-before-0025', 'thread-1', 'corrected');
      `);
      await writeFile(
        join(migrationsDir, "0025_conversation_state_extraction.sql"),
        await readFile(join(defaultMigrationsDir(), "0025_conversation_state_extraction.sql"), "utf8"),
      );

      await expect(runMigrations({ client, migrationsDir })).resolves.toMatchObject({
        applied: ["0025_conversation_state_extraction.sql"],
      });
      await expect(client.query(`
        INSERT INTO discussion_thread_events (id, thread_id, event_type)
        VALUES ('event-after-0025', 'thread-1', 'evidence_attached')
      `)).resolves.toMatchObject({ rows: [] });
      await expect(client.query(
        "SELECT event_type FROM discussion_thread_events ORDER BY id",
      )).resolves.toMatchObject({
        rows: [{ event_type: "evidence_attached" }, { event_type: "corrected" }],
      });
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  });

  it("applies the full migration set to a fresh schema", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const schema = `task6_fresh_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await expect(runMigrations({ client, migrationsDir: defaultMigrationsDir() })).resolves.toMatchObject({
        applied: expect.arrayContaining([
          "0024_semantic_thread_action_memory.sql",
          "0025_conversation_state_extraction.sql",
          "0026_projection_rollout_contracts.sql",
          "0030_knowledge_draft_facts.sql",
          "0031_knowledge_draft_presentations.sql",
        ]),
      });
      await expect(client.query<{ definition: string }>(`
        SELECT pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint constraint_row
        JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
        WHERE table_row.oid = 'knowledge_draft_presentation_outbox'::regclass
          AND constraint_row.conname = 'knowledge_draft_presentation_outbox_state_check'
      `)).resolves.toMatchObject({
        rows: [{ definition: expect.stringContaining("external_attempting") }],
      });
      await expect(client.query(`
        INSERT INTO group_memories (
          id, group_id, memory_scope, category, thread_key, content,
          importance, confidence, status, idempotency_key, origin,
          created_by, request_fingerprint
        ) VALUES (
          'fresh-threaded-action', 'fresh-group', 'action', 'action', 'thread-7',
          'Ship the repair projector.', 4, 0.9, 'active', 'fresh-action-key',
          'system', 'conversation-state-projector', repeat('a', 64)
        )
      `)).resolves.toMatchObject({ rows: [] });
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  });

  it("applies 0046 with enforceable knowledge-conflict facts and append-only receipts", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const schema = `knowledge_conflict_0046_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });

      await expect(client.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
        ORDER BY table_name
      `, [[
        "answer_reply_knowledge_conflicts",
        "knowledge_conflict_candidate_events",
        "knowledge_conflict_candidates",
        "knowledge_conflict_delivery_outbox",
        "knowledge_conflict_evidence",
        "knowledge_conflict_interactions",
        "knowledge_conflict_scan_operations",
        "knowledge_conflict_scan_inbox",
      ]])).resolves.toMatchObject({ rows: [
        { table_name: "answer_reply_knowledge_conflicts" },
        { table_name: "knowledge_conflict_candidate_events" },
        { table_name: "knowledge_conflict_candidates" },
        { table_name: "knowledge_conflict_delivery_outbox" },
        { table_name: "knowledge_conflict_evidence" },
        { table_name: "knowledge_conflict_interactions" },
        { table_name: "knowledge_conflict_scan_inbox" },
        { table_name: "knowledge_conflict_scan_operations" },
      ] });

      const catalog = await client.query<{
        constraints: string[];
        indexes: string[];
        triggers: string[];
        foreign_keys: number;
      }>(`
        SELECT
          ARRAY(
            SELECT constraint_row.conname
            FROM pg_constraint constraint_row
            JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
            JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
            WHERE namespace_row.nspname = current_schema()
              AND table_row.relname LIKE 'knowledge_conflict%'
            ORDER BY constraint_row.conname
          )::text[] AS constraints,
          ARRAY(
            SELECT index_row.relname
            FROM pg_class index_row
            JOIN pg_namespace namespace_row ON namespace_row.oid = index_row.relnamespace
            WHERE namespace_row.nspname = current_schema()
              AND index_row.relkind = 'i'
              AND index_row.relname LIKE 'knowledge_conflict%'
            ORDER BY index_row.relname
          )::text[] AS indexes,
          ARRAY(
            SELECT trigger_row.tgname
            FROM pg_trigger trigger_row
            JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
            JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
            WHERE namespace_row.nspname = current_schema()
              AND NOT trigger_row.tgisinternal
              AND (table_row.relname LIKE 'knowledge_conflict%'
                OR table_row.relname = 'answer_reply_knowledge_conflicts')
            ORDER BY trigger_row.tgname
          )::text[] AS triggers,
          (
            SELECT COUNT(*)::int
            FROM pg_constraint constraint_row
            JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
            JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
            WHERE namespace_row.nspname = current_schema()
              AND constraint_row.contype = 'f'
              AND (table_row.relname LIKE 'knowledge_conflict%'
                OR table_row.relname = 'answer_reply_knowledge_conflicts')
          ) AS foreign_keys
      `);
      expect(catalog.rows[0]).toMatchObject({
        constraints: expect.arrayContaining([
          "knowledge_conflict_candidates_status_check",
          "knowledge_conflict_delivery_outbox_status_check",
          "knowledge_conflict_evidence_evidence_type_check",
          "knowledge_conflict_scan_inbox_status_check",
        ]),
        indexes: expect.arrayContaining([
          "knowledge_conflict_one_delivery_idx",
          "knowledge_conflict_one_live_evidence_idx",
          "knowledge_conflict_evidence_reference_key",
          "knowledge_conflict_scan_memory_version_key",
        ]),
        triggers: expect.arrayContaining([
          "answer_reply_knowledge_conflicts_append_only",
          "answer_reply_knowledge_conflicts_truncate_guard",
          "knowledge_conflict_candidate_events_append_only",
          "knowledge_conflict_delivery_reconciliations_append_only",
          "knowledge_conflict_delivery_reconciliations_truncate_guard",
          "knowledge_conflict_evidence_append_only",
          "knowledge_conflict_interactions_append_only",
          "knowledge_conflict_scan_operations_append_only",
          "knowledge_conflict_scan_operations_truncate_guard",
        ]),
      });
      expect(catalog.rows[0]?.foreign_keys).toBeGreaterThanOrEqual(10);

      const definitions = await client.query<{ conname: string; definition: string }>(`
        SELECT constraint_row.conname, pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint constraint_row
        JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
        WHERE table_row.oid IN (
          'knowledge_conflict_scan_inbox'::regclass,
          'knowledge_conflict_candidates'::regclass,
          'knowledge_conflict_delivery_outbox'::regclass,
          'knowledge_conflict_delivery_reconciliations'::regclass,
          'knowledge_draft_revision_evidence'::regclass
        ) AND constraint_row.contype = 'c'
        ORDER BY constraint_row.conname
      `);
      expect(definitions.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          conname: "knowledge_conflict_scan_inbox_status_check",
          definition: expect.stringContaining("dead_lettered"),
        }),
        expect.objectContaining({
          conname: "knowledge_conflict_candidates_status_check",
          definition: expect.stringContaining("approved_for_delivery"),
        }),
        expect.objectContaining({
          conname: "knowledge_conflict_delivery_outbox_status_check",
          definition: expect.stringContaining("external_attempting"),
        }),
        expect.objectContaining({
          conname: "knowledge_draft_revision_evidence_shape_check",
          definition: expect.stringContaining("group_memory"),
        }),
      ]));
      const scanOutcomeDefinition = definitions.rows.find((row) =>
        row.conname === "knowledge_conflict_scan_inbox_terminal_outcome_check");
      expect(scanOutcomeDefinition?.definition).toContain("superseded");
      expect(scanOutcomeDefinition?.definition).toContain("permission_blocked");

      await expect(client.query<{ column_name: string; is_nullable: string }>(`
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'knowledge_conflict_candidates'
          AND column_name IN ('target_source_updated_at', 'target_source_version')
        ORDER BY column_name
      `)).resolves.toMatchObject({ rows: [
        { column_name: "target_source_updated_at", is_nullable: "NO" },
        { column_name: "target_source_version", is_nullable: "YES" },
      ] });

      await client.query(`
        INSERT INTO conversation_messages (
          id, provider, provider_message_id, chat_id, message_type,
          sent_at, raw_event_idempotency_key, created_at
        ) VALUES (
          'message-1', 'feishu', 'provider-message-1', 'group-1', 'text',
          NOW(), 'raw-event-1', NOW()
        );
        INSERT INTO group_memories (
          id, group_id, memory_scope, category, content, importance, confidence,
          status, idempotency_key, origin, created_by, request_fingerprint
        ) VALUES (
          'memory-1', 'group-1', 'group', 'decision', 'CNY 10,000', 5, 0.95,
          'active', 'memory-key-1', 'system', 'iris', repeat('b', 64)
        );
        INSERT INTO document_sources (
          id, source_type, source_uri, permission_state, sync_state,
          can_use_for_answering, can_use_for_knowledge_drafts, created_at, updated_at
        ) VALUES
        (
          'document-1', 'authorized_wiki_document', 'https://example.com/document-1',
          'readable', 'synced', TRUE, TRUE, NOW(), NOW()
        ),
        (
          'document-2', 'authorized_wiki_document', 'https://example.com/document-2',
          'readable', 'synced', TRUE, TRUE, NOW(), NOW()
        );
        INSERT INTO document_snapshots (
          id, document_source_id, source_uri, fetch_status, body_text,
          content_hash, fetched_at, created_at
        ) VALUES
        (
          'snapshot-1', 'document-1', 'https://example.com/document-1', 'succeeded',
          'CNY 5,000', repeat('a', 64), NOW(), NOW()
        ),
        (
          'snapshot-2', 'document-2', 'https://example.com/document-2', 'succeeded',
          'CNY 20,000', repeat('d', 64), NOW(), NOW()
        );
        INSERT INTO document_fragments (
          id, document_source_id, document_snapshot_id, source_uri,
          chunk_index, text, content_hash, embedding, embedding_profile_id, created_at
        ) VALUES
        (
          'fragment-1', 'document-1', 'snapshot-1', 'https://example.com/document-1',
          0, 'CNY 5,000', repeat('c', 64), '[0,0,0,0,0,0]', 'static-dev-6d', NOW()
        ),
        (
          'fragment-2', 'document-2', 'snapshot-2', 'https://example.com/document-2',
          0, 'CNY 20,000', repeat('e', 64), '[0,0,0,0,0,0]', 'static-dev-6d', NOW()
        );
        INSERT INTO knowledge_drafts (
          id, source_group_id, origin_kind, status, current_revision_number,
          version, created_by, created_at, updated_at
        ) VALUES (
          'draft-1', 'group-1', 'knowledge_conflict', 'pending_confirmation',
          1, 1, 'iris', NOW(), NOW()
        );
        INSERT INTO knowledge_draft_revisions (
          draft_id, revision_number, title, content, risk_level, author, created_at
        ) VALUES (
          'draft-1', 1, 'Expense threshold', 'Review the conflict', 'medium', 'iris', NOW()
        );
        INSERT INTO knowledge_draft_revision_evidence (
          draft_id, revision_number, evidence_type, reference_id,
          source_group_id, source_updated_at, created_at
        ) VALUES (
          'draft-1', 1, 'group_memory', 'memory-1', 'group-1', NOW(), NOW()
        );
        INSERT INTO knowledge_conflict_scan_inbox (
          id, group_id, group_memory_id, memory_updated_at, status
        ) VALUES ('scan-1', 'group-1', 'memory-1', NOW(), 'pending');
        INSERT INTO knowledge_conflict_candidates (
          id, idempotency_key, group_id, group_memory_id, memory_updated_at,
          source_message_id, target_document_source_id, target_source_updated_at,
          target_source_version, target_snapshot_id,
          target_content_hash, detector_contract_version, status, subject,
          knowledge_base_statement, group_conclusion_statement, difference,
          suggested_update, target_document_ref, confidence
        ) VALUES (
          'candidate-1', 'candidate-key-1', 'group-1', 'memory-1', NOW(),
          'message-1', 'document-1', NOW(), 'revision-7',
          'snapshot-1', repeat('a', 64), 'v1',
          'pending_review', 'Expense threshold', 'CNY 5,000', 'CNY 10,000',
          'Threshold differs', 'Use CNY 10,000', 'D1', 'high'
        );
        INSERT INTO knowledge_conflict_delivery_outbox (
          id, candidate_id, group_id, status, attempt_count, next_attempt_at
        ) VALUES ('delivery-1', 'candidate-1', 'group-1', 'pending', 1, NOW());
        INSERT INTO knowledge_conflict_delivery_reconciliations (
          operation_key, delivery_id, attempt_count, outcome, actor_ref, created_at
        ) VALUES ('reconcile-1', 'delivery-1', 1, 'not_sent', 'knowledge-admin', NOW());
        INSERT INTO knowledge_conflict_evidence (
          candidate_id, evidence_type, reference_id, group_id,
          conversation_message_id, created_at
        ) VALUES (
          'candidate-1', 'conversation_message', 'C1', 'group-1', 'message-1', NOW()
        );
        INSERT INTO knowledge_conflict_evidence (
          candidate_id, evidence_type, reference_id, group_id,
          group_memory_id, source_updated_at, created_at
        ) VALUES (
          'candidate-1', 'group_memory', 'M1', 'group-1', 'memory-1', NOW(), NOW()
        );
        INSERT INTO knowledge_conflict_evidence (
          candidate_id, evidence_type, reference_id, document_source_id,
          document_snapshot_id, snapshot_content_hash, content_hash, created_at
        ) VALUES (
          'candidate-1', 'document_snapshot', 'D1', 'document-1',
          'snapshot-1', repeat('a', 64), repeat('a', 64), NOW()
        );
        INSERT INTO knowledge_conflict_evidence (
          candidate_id, evidence_type, reference_id, document_source_id,
          document_snapshot_id, document_fragment_id, snapshot_content_hash,
          content_hash, created_at
        ) VALUES (
          'candidate-1', 'document_fragment', 'D2', 'document-1',
          'snapshot-1', 'fragment-1', repeat('a', 64), repeat('c', 64), NOW()
        );
      `);
      await expect(client.query(
        "UPDATE knowledge_conflict_evidence SET reference_id = 'C2' WHERE candidate_id = 'candidate-1' AND reference_id = 'C1'",
      )).rejects.toThrow(/append-only/iu);
      await expect(client.query(
        "DELETE FROM knowledge_conflict_evidence WHERE candidate_id = 'candidate-1'",
      )).rejects.toThrow(/append-only/iu);
      await expect(client.query(
        "SELECT actor_ref FROM knowledge_conflict_delivery_reconciliations WHERE operation_key = 'reconcile-1'",
      )).resolves.toMatchObject({ rows: [{ actor_ref: "knowledge-admin" }] });
      await expect(client.query(`
        INSERT INTO knowledge_conflict_delivery_reconciliations (
          operation_key, delivery_id, attempt_count, outcome, created_at
        ) VALUES ('reconcile-missing-actor', 'delivery-1', 1, 'not_sent', NOW())
      `)).rejects.toMatchObject({ code: "23502", column: "actor_ref" });
      await expect(client.query(
        "UPDATE knowledge_conflict_delivery_reconciliations SET outcome = 'sent' WHERE operation_key = 'reconcile-1'",
      )).rejects.toThrow(/append-only/iu);
      await expect(client.query(`
        INSERT INTO knowledge_draft_revision_evidence (
          draft_id, revision_number, evidence_type, reference_id,
          source_group_id, source_updated_at, created_at
        ) VALUES (
          'draft-1', 1, 'group_memory', 'missing-memory-time',
          'group-1', NULL, NOW()
        )
      `)).rejects.toMatchObject({
        constraint: "knowledge_draft_revision_evidence_shape_check",
      });
      for (const invalidReferenceInsert of [
        `INSERT INTO knowledge_conflict_evidence (
          candidate_id, evidence_type, reference_id, group_id,
          conversation_message_id, created_at
        ) VALUES ('candidate-1', 'conversation_message', 'M1', 'group-1', 'message-1', NOW())`,
        `INSERT INTO knowledge_conflict_evidence (
          candidate_id, evidence_type, reference_id, group_id,
          group_memory_id, source_updated_at, created_at
        ) VALUES ('candidate-1', 'group_memory', 'C2', 'group-1', 'memory-1', NOW(), NOW())`,
        `INSERT INTO knowledge_conflict_evidence (
          candidate_id, evidence_type, reference_id, document_source_id,
          source_updated_at, created_at
        ) VALUES ('candidate-1', 'document_source', 'C3', 'document-1', NOW(), NOW())`,
      ]) {
        await expect(client.query(invalidReferenceInsert)).rejects.toMatchObject({
          constraint: "knowledge_conflict_evidence_reference_kind_check",
        });
      }

      for (const candidateInsert of [
        `INSERT INTO knowledge_conflict_candidates (
          id, idempotency_key, group_id, group_memory_id, memory_updated_at,
          source_message_id, target_document_source_id, target_source_updated_at,
          target_snapshot_id,
          target_content_hash, detector_contract_version, status, subject,
          knowledge_base_statement, group_conclusion_statement, difference,
          suggested_update, target_document_ref, confidence
        ) VALUES (
          'candidate-cross-source', 'candidate-cross-source-key', 'group-1',
          'memory-1', NOW(), 'message-1', 'document-1', NOW(), 'snapshot-2',
          repeat('d', 64), 'v1', 'pending_review', 'Subject', 'Prior',
          'Current', 'Difference', 'Update', 'D1', 'high'
        )`,
        `INSERT INTO knowledge_conflict_candidates (
          id, idempotency_key, group_id, group_memory_id, memory_updated_at,
          source_message_id, target_document_source_id, target_source_updated_at,
          target_snapshot_id,
          target_content_hash, detector_contract_version, status, subject,
          knowledge_base_statement, group_conclusion_statement, difference,
          suggested_update, target_document_ref, confidence
        ) VALUES (
          'candidate-wrong-hash', 'candidate-wrong-hash-key', 'group-1',
          'memory-1', NOW(), 'message-1', 'document-1', NOW(), 'snapshot-1',
          repeat('f', 64), 'v1', 'pending_review', 'Subject', 'Prior',
          'Current', 'Difference', 'Update', 'D1', 'high'
        )`,
      ]) {
        await expect(client.query(candidateInsert)).rejects.toMatchObject({
          constraint: "knowledge_conflict_candidates_target_snapshot_fkey",
        });
      }

      await expect(client.query(`
        INSERT INTO knowledge_conflict_evidence (
          candidate_id, evidence_type, reference_id, document_source_id,
          document_snapshot_id, snapshot_content_hash, content_hash, created_at
        ) VALUES (
          'candidate-1', 'document_snapshot', 'D3', 'document-2',
          'snapshot-1', repeat('a', 64), repeat('a', 64), NOW()
        )
      `)).rejects.toMatchObject({
        constraint: "knowledge_conflict_evidence_snapshot_identity_fkey",
      });
      for (const fragmentInsert of [
        `INSERT INTO knowledge_conflict_evidence (
          candidate_id, evidence_type, reference_id, document_source_id,
          document_snapshot_id, document_fragment_id, snapshot_content_hash,
          content_hash, created_at
        ) VALUES (
          'candidate-1', 'document_fragment', 'D4', 'document-1',
          'snapshot-1', 'fragment-2', repeat('a', 64), repeat('e', 64), NOW()
        )`,
        `INSERT INTO knowledge_conflict_evidence (
          candidate_id, evidence_type, reference_id, document_source_id,
          document_snapshot_id, document_fragment_id, snapshot_content_hash,
          content_hash, created_at
        ) VALUES (
          'candidate-1', 'document_fragment', 'D5', 'document-1',
          'snapshot-1', 'fragment-1', repeat('a', 64), repeat('f', 64), NOW()
        )`,
      ]) {
        await expect(client.query(fragmentInsert)).rejects.toMatchObject({
          constraint: "knowledge_conflict_evidence_fragment_identity_fkey",
        });
      }
      await expect(client.query(`
        INSERT INTO knowledge_conflict_evidence (
          candidate_id, evidence_type, reference_id, document_source_id,
          document_snapshot_id, document_fragment_id, snapshot_content_hash,
          content_hash, created_at
        ) VALUES (
          'candidate-1', 'document_fragment', 'D6', 'document-1',
          'snapshot-2', 'fragment-1', repeat('d', 64), repeat('c', 64), NOW()
        )
      `)).rejects.toMatchObject({
        constraint: "knowledge_conflict_evidence_snapshot_identity_fkey",
      });
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  });

  it("backfills exact candidate versions and restores append-only binding guards in 0049", async () => {
    const stagedMigrations = await mkdtemp(join(tmpdir(), "iris-candidate-version-migrations-"));
    const migrationNames = await readdir(defaultMigrationsDir());
    for (const migrationName of migrationNames.filter((name) => name < "0049_")) {
      await copyFile(
        join(defaultMigrationsDir(), migrationName),
        join(stagedMigrations, migrationName),
      );
    }
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const schema = `answer_candidate_version_0049_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await runMigrations({ client, migrationsDir: stagedMigrations });
      await client.query(`
        INSERT INTO conversation_messages (
          id, provider, provider_message_id, chat_id, message_type,
          sent_at, raw_event_idempotency_key, created_at
        ) VALUES ('binding-message', 'feishu', 'binding-provider-message', 'binding-group',
          'text', NOW(), 'binding-raw-event', NOW());
        INSERT INTO group_memories (
          id, group_id, memory_scope, category, content, importance, confidence,
          status, idempotency_key, origin, created_by, request_fingerprint
        ) VALUES ('binding-memory', 'binding-group', 'group', 'decision', 'Current', 5, 0.95,
          'active', 'binding-memory-key', 'system', 'iris', repeat('b', 64));
        INSERT INTO document_sources (
          id, source_type, source_uri, permission_state, sync_state,
          can_use_for_answering, can_use_for_knowledge_drafts, created_at, updated_at
        ) VALUES ('binding-source', 'authorized_wiki_document',
          'https://example.com/binding-source', 'readable', 'synced', TRUE, TRUE, NOW(), NOW());
        INSERT INTO document_snapshots (
          id, document_source_id, source_uri, fetch_status, body_text,
          content_hash, fetched_at, created_at
        ) VALUES ('binding-snapshot', 'binding-source', 'https://example.com/binding-source',
          'succeeded', 'Prior', repeat('a', 64), NOW(), NOW());
        INSERT INTO knowledge_conflict_candidates (
          id, idempotency_key, group_id, group_memory_id, memory_updated_at,
          source_message_id, target_document_source_id, target_source_updated_at,
          target_snapshot_id, target_content_hash, detector_contract_version, status, subject,
          knowledge_base_statement, group_conclusion_statement, difference,
          suggested_update, target_document_ref, confidence, version
        ) VALUES ('binding-candidate', 'binding-candidate-key', 'binding-group',
          'binding-memory', (SELECT updated_at FROM group_memories WHERE id = 'binding-memory'),
          'binding-message', 'binding-source',
          (SELECT updated_at FROM document_sources WHERE id = 'binding-source'),
          'binding-snapshot', repeat('a', 64), 'v1', 'pending_review', 'Subject',
          'Prior', 'Current', 'Difference', 'Update', 'D1', 'high', 7);
        INSERT INTO answer_reply_deliveries (
          id, provider, incoming_message_id, chat_id, reply_uuid, safe_notice_uuid,
          state, prepared_reply_text, rendered_reply_fingerprint, semantic_fingerprint,
          knowledge_conflict_candidate_id, created_at, updated_at
        ) VALUES ('binding-answer', 'feishu', 'binding-incoming', 'binding-group',
          'binding-reply', 'binding-safe', 'prepared', 'Answer', repeat('c', 64),
          repeat('d', 64), 'binding-candidate', NOW(), NOW());
        INSERT INTO answer_reply_knowledge_conflicts (delivery_id, candidate_id, created_at)
        VALUES ('binding-answer', 'binding-candidate', NOW());
      `);

      const migration0049 = "0049_answer_reply_knowledge_conflict_candidate_version.sql";
      await copyFile(
        join(defaultMigrationsDir(), migration0049),
        join(stagedMigrations, migration0049),
      );
      await expect(runMigrations({ client, migrationsDir: stagedMigrations })).resolves.toMatchObject({
        applied: [migration0049],
      });
      await expect(client.query(
        "SELECT candidate_version FROM answer_reply_knowledge_conflicts WHERE delivery_id = 'binding-answer'",
      )).resolves.toMatchObject({ rows: [{ candidate_version: "7" }] });
      await expect(client.query<{ is_nullable: string }>(`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'answer_reply_knowledge_conflicts'
          AND column_name = 'candidate_version'
      `)).resolves.toMatchObject({ rows: [{ is_nullable: "NO" }] });
      await expect(client.query(
        "UPDATE answer_reply_knowledge_conflicts SET candidate_version = 8 WHERE delivery_id = 'binding-answer'",
      )).rejects.toThrow(/append-only/iu);
      await expect(client.query(
        "DELETE FROM answer_reply_knowledge_conflicts WHERE delivery_id = 'binding-answer'",
      )).rejects.toThrow(/append-only/iu);
      await expect(client.query(
        "TRUNCATE answer_reply_knowledge_conflicts",
      )).rejects.toThrow(/append-only/iu);
      const triggerCatalog = await client.query<{ tgname: string; definition: string }>(`
        SELECT tgname, pg_get_triggerdef(oid) AS definition
        FROM pg_trigger
        WHERE tgrelid = 'answer_reply_knowledge_conflicts'::regclass
          AND NOT tgisinternal
        ORDER BY tgname
      `);
      expect(triggerCatalog.rows.map(({ tgname }) => tgname)).toEqual([
        "answer_reply_knowledge_conflicts_append_only",
        "answer_reply_knowledge_conflicts_truncate_guard",
      ]);
      expect(triggerCatalog.rows.find(({ tgname }) => tgname.endsWith("append_only"))?.definition)
        .toMatch(/before (?:update or delete|delete or update)/iu);
      expect(triggerCatalog.rows.find(({ tgname }) => tgname.endsWith("truncate_guard"))?.definition)
        .toMatch(/before truncate/iu);
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  });
});
