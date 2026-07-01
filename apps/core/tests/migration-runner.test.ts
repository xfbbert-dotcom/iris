import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runMigrations } from "../src/database/migrate.js";

describe("runMigrations", () => {
  it("applies pending migrations in lexical order", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "iris-migrations-"));
    await writeFile(join(migrationsDir, "0002_second.sql"), "select 2;");
    await writeFile(join(migrationsDir, "0001_first.sql"), "select 1;");

    const queries: string[] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push(sql);

      if (sql.includes("select name from schema_migrations")) {
        return { rows: [] };
      }

      return { rows: [], values };
    });

    const result = await runMigrations({
      client: { query },
      migrationsDir,
    });

    expect(result).toEqual({
      applied: ["0001_first.sql", "0002_second.sql"],
      skipped: [],
    });
    expect(queries).toContain("select 1;");
    expect(queries).toContain("select 2;");
  });
});
