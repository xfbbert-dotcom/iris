import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
});
