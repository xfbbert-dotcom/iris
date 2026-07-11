import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  checkDatabaseHealth,
  closePostgresPool,
  createPostgresPool,
} from "../src/database/postgres.js";

describe("createPostgresPool", () => {
  it("creates a pool configured with the database URL", () => {
    const databaseUrl = "postgres://age:secret@localhost:5432/age";

    const pool = createPostgresPool({ databaseUrl });

    expect(pool.options.connectionString).toBe(databaseUrl);
    void pool.end();
  });
});

describe("closePostgresPool", () => {
  it("ends the pool", async () => {
    const pool = {
      end: vi.fn().mockResolvedValue(undefined),
    };

    await closePostgresPool(pool as unknown as pg.Pool);

    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});

describe("checkDatabaseHealth", () => {
  it("queries the database and returns ok", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] });

    const health = await checkDatabaseHealth({ query });

    expect(query).toHaveBeenCalledWith("select 1 as ok");
    expect(health).toEqual({ ok: true });
  });
});
