import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPostgresRuntimeControlStore } from "../src/admin/postgres-runtime-control-store.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { RuntimeController } from "../src/admin/runtime-controller.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";

describe("createPostgresRuntimeControlStore", () => {
  it("initializes missing defaults and restores persisted controls", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { scope: "global", target_id: "global", enabled: false },
          { scope: "group", target_id: "chat-b", enabled: false },
          { scope: "group", target_id: "chat-a", enabled: false },
          { scope: "capability", target_id: "proactiveSpeech", enabled: false },
        ],
      });
    const store = createPostgresRuntimeControlStore({ query } as never);
    const defaults = new RuntimeController(createDefaultRuntimeConfig()).getSnapshot();

    const snapshot = await store.load(defaults);

    expect(normalizeSql(query.mock.calls[0]?.[0])).toContain(
      "insert into runtime_controls (scope, target_id, enabled)",
    );
    expect(query.mock.calls[0]?.[1]).toHaveLength(27);
    expect(normalizeSql(query.mock.calls[1]?.[0])).toContain(
      "select scope, target_id, enabled from runtime_controls",
    );
    expect(snapshot).toMatchObject({
      globalEnabled: false,
      disabledGroupIds: ["chat-a", "chat-b"],
      capabilities: {
        proactiveSpeech: false,
        readGroupContext: true,
      },
    });
  });

  it("upserts global and capability controls and removes re-enabled groups", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
    const store = createPostgresRuntimeControlStore({ query } as never);

    await store.setGlobalEnabled(false);
    await store.setCapabilities({
      callExternalTools: true,
      proactiveSpeech: false,
    });
    await store.setGroupEnabled("chat-a", false);
    await store.setGroupEnabled("chat-a", true);

    expect(query.mock.calls.map(([sql]) => normalizeSql(sql))).toEqual([
      expect.stringContaining("on conflict (scope, target_id) do update"),
      expect.stringContaining("on conflict (scope, target_id) do update"),
      expect.stringContaining("on conflict (scope, target_id) do update"),
      "delete from runtime_controls where scope = 'group' and target_id = $1",
    ]);
    expect(query.mock.calls.map((call) => call[1])).toEqual([
      ["global", "global", false],
      [
        "capability",
        "callExternalTools",
        true,
        "capability",
        "proactiveSpeech",
        false,
      ],
      ["group", "chat-a", false],
      ["chat-a"],
    ]);
  });
});

function normalizeSql(value: unknown): string {
  return String(value).replace(/\s+/g, " ").trim().toLowerCase();
}

const databaseUrl = process.env.DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

runIfDatabase("Postgres runtime control recovery", () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    client = await pool.connect();
    await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    await client.query("begin");
    await client.query("delete from runtime_controls");
  });

  afterAll(async () => {
    await client.query("rollback");
    client.release();
    await pool.end();
  });

  it("restores global, group, and capability controls across controller instances", async () => {
    const first = new RuntimeController(
      createDefaultRuntimeConfig(),
      createPostgresRuntimeControlStore(client as never),
    );
    await first.hydrate();
    await first.disableGlobal();
    await first.disableGroup("chat-persisted");
    await first.setCapability("callExternalTools", true);

    const restarted = new RuntimeController(
      createDefaultRuntimeConfig(),
      createPostgresRuntimeControlStore(client as never),
    );
    await restarted.hydrate();

    expect(restarted.getSnapshot()).toMatchObject({
      globalEnabled: false,
      disabledGroupIds: ["chat-persisted"],
      capabilities: {
        callExternalTools: true,
      },
    });
  });
});
