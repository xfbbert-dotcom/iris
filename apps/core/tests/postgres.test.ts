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

  it("passes bounded operation timeouts to node-postgres", () => {
    const databaseUrl = "postgres://age:secret@localhost:5432/age";

    const pool = createPostgresPool({
      databaseUrl,
      connectionTimeoutMillis: 10_000,
      queryTimeoutMillis: 10_000,
      statementTimeoutMillis: 10_000,
      lockTimeoutMillis: 10_000,
    });

    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.query_timeout).toBe(10_000);
    expect(pool.options.statement_timeout).toBe(10_000);
    expect(pool.options.lock_timeout).toBe(10_000);
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
