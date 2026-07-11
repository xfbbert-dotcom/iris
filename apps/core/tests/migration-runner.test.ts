import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
});
