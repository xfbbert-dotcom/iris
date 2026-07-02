import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import { createPostgresDocumentSourceRegistry } from "../src/documents/postgres-document-source-registry.js";

const databaseUrl = process.env.DATABASE_URL;
const runIfDatabase = databaseUrl ? describe : describe.skip;

runIfDatabase("createPostgresDocumentSourceRegistry", () => {
  let pool: pg.Pool;
  const runId = randomUUID();
  const testSourcePrefix = `https://example.com/postgres-registry/${runId}/`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();

    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    await pool.query("delete from document_sources where source_uri like $1", [
      `${testSourcePrefix}%`,
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists group visible sources and deduplicates retried message evidence", async () => {
    const registry = createPostgresDocumentSourceRegistry(pool, {
      createId: () => `${runId}-group-source`,
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const sourceUri = `${testSourcePrefix}group-doc`;

    const first = await registry.registerGroupVisibleDocument({
      sourceUri,
      title: "First Title",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    const retried = await registry.registerGroupVisibleDocument({
      sourceUri,
      title: "Retried Title",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(retried.id).toBe(first.id);
    expect(retried.title).toBe("First Title");
    expect(retried.evidence).toHaveLength(1);
    expect(retried.evidence[0]).toMatchObject({
      kind: "group_message",
      sourceUri,
      groupId: "group-1",
      messageId: "message-1",
    });
    expect(retried.evidence[0]?.observedAt).toEqual(new Date("2026-07-01T04:01:00.000Z"));
  });

  it("keeps existing source id and disabled answering across registry instances", async () => {
    const sourceUri = `${testSourcePrefix}wiki-doc`;
    const firstRegistry = createPostgresDocumentSourceRegistry(pool, {
      createId: () => `${runId}-wiki-source`,
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const secondRegistry = createPostgresDocumentSourceRegistry(pool, {
      createId: () => `${runId}-unused-wiki-source`,
      now: () => new Date("2026-07-01T04:05:00.000Z"),
    });

    const first = await firstRegistry.registerAuthorizedWikiDocument({
      sourceUri,
      title: "Wiki Space",
      authorizedSpaceId: "space-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    await firstRegistry.setAnsweringEnabled(first.id, false);

    const reregistered = await secondRegistry.registerAuthorizedWikiDocument({
      sourceUri,
      title: "Wiki Space Again",
      authorizedSpaceId: "space-1",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(reregistered.id).toBe(first.id);
    expect(reregistered.canUseForAnswering).toBe(false);
  });
});
