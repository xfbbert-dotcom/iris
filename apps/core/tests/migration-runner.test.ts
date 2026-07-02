import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";

describe("runMigrations", () => {
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
  it("points at the migrations directory", () => {
    expect(defaultMigrationsDir()).toMatch(/[\\/]migrations$/);
  });

  it("includes embedding profile migration after document fragments", async () => {
    await expect(readdir(defaultMigrationsDir())).resolves.toEqual(
      expect.arrayContaining(["0003_document_fragments.sql", "0004_embedding_profiles.sql"]),
    );
  });
});
