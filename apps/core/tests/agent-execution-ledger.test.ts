import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPostgresAgentExecutionLedgerRepository,
  AgentExecutionLedgerOperationConflictError,
  type AgentExecutionLedgerRepository,
} from "../src/agent-runtime/agent-execution-ledger-repository.js";
import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";
import type {
  PostgresKnowledgeDraftDataSource,
} from "../src/knowledge-governance/postgres-knowledge-draft-repository.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID();
const schema = `agent_ledger_${suffix.replaceAll("-", "")}`;
const at = new Date("2026-07-27T10:00:00.000Z");

describe("agent execution ledger migration contract", () => {
  const migration = readFileSync(
    new URL("../migrations/0039_agent_execution_ledger.sql", import.meta.url),
    "utf8",
  );

  it("defines a content-free append-only agent execution event ledger", () => {
    const normalized = migration.replace(/\s+/g, " ").trim().toLowerCase();

    expect(normalized).toContain("create table agent_execution_ledger_events");
    expect(normalized).toContain("operation_key text not null unique");
    expect(normalized).toContain("operation_fingerprint text not null");
    expect(normalized).toContain("metadata jsonb not null default '{}'::jsonb");
    expect(normalized).toContain("content_fingerprint text");
    expect(normalized).not.toContain("raw_content");
    expect(normalized).not.toContain("prompt_context");
    expect(normalized).toContain("agent_execution_ledger_events_append_only");
    expect(normalized).toContain("agent_execution_ledger_events_group_time_idx");
    expect(normalized).toContain("agent_execution_ledger_events_subject_time_idx");
    expect(normalized).toContain("agent_execution_ledger_events_tool_call_idx");
  });

  it("is included after proactive delivery migrations", async () => {
    const migrationNames = (await import("node:fs/promises"))
      .readdir(defaultMigrationsDir())
      .then((names) => names.sort((left, right) => left.localeCompare(right)));

    expect(await migrationNames).toEqual(
      expect.arrayContaining([
        "0038_proactive_signal_delivery_outbox.sql",
        "0039_agent_execution_ledger.sql",
      ]),
    );
  });
});

runIfDatabase("PostgresAgentExecutionLedgerRepository with Postgres", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let repository: AgentExecutionLedgerRepository;

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
    repository = createPostgresAgentExecutionLedgerRepository({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
    });
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  it("records exact replay once and rejects conflicting replay", async () => {
    const input = eventInput("turn-1", {
      operationKey: `ledger:${suffix}:turn`,
      metadata: { status: "sampled", count: 1 },
    });

    await expect(repository.recordEvent(input)).resolves.toMatchObject({
      outcome: "applied",
      event: {
        id: input.id,
        eventType: "turn_started",
        operationKey: input.operationKey,
        metadata: { status: "sampled", count: 1 },
      },
    });
    await expect(repository.recordEvent(input)).resolves.toMatchObject({
      outcome: "already_applied",
      event: { id: input.id },
    });
    await expect(repository.recordEvent({
      ...input,
      metadata: { status: "changed" },
    })).rejects.toBeInstanceOf(AgentExecutionLedgerOperationConflictError);
  });

  it("lists bounded events without sensitive content fields", async () => {
    await repository.recordEvent(eventInput("tool-1", {
      eventType: "tool_call_started",
      operationKey: `ledger:${suffix}:tool-start`,
      toolCallId: `tool-${suffix}`,
      toolName: "iris.feishu.searchWiki",
      metadata: { permission: "allowed" },
    }));
    await repository.recordEvent(eventInput("tool-2", {
      eventType: "tool_call_completed",
      operationKey: `ledger:${suffix}:tool-complete`,
      toolCallId: `tool-${suffix}`,
      toolName: "iris.feishu.searchWiki",
      metadata: { result: "ok" },
    }));

    const events = await repository.listEvents({
      groupId: `oc_${suffix}`,
      subjectType: "tool_call",
      subjectId: `tool-${suffix}`,
      limit: 10,
    });

    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/secret|prompt|rawContent|promptContext/u);
    expect(events.map((event) => event.eventType)).toEqual([
      "tool_call_started",
      "tool_call_completed",
    ]);
  });
});

function eventInput(
  id: string,
  overrides: Partial<Parameters<AgentExecutionLedgerRepository["recordEvent"]>[0]> = {},
) {
  return {
    id: `${id}-${suffix}`,
    tenantKey: "default",
    groupId: `oc_${suffix}`,
    subjectType: "turn" as const,
    subjectId: `turn-${suffix}`,
    eventType: "turn_started" as const,
    operationKey: `ledger:${suffix}:${id}`,
    metadata: {},
    at,
    ...overrides,
  };
}
