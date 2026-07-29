import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type pg from "pg";

import { readDatabaseConfig } from "./database-config.js";
import { closePostgresPool, createPostgresPool } from "./postgres.js";

export type MigrationResult = { applied: string[]; skipped: string[] };
export type MigrationClient = pg.PoolClient;
export type RunMigrationsInput = {
  client: MigrationClient;
  migrationsDir: string;
};

type QueryRowsResult = {
  rows?: Array<{ name?: unknown }>;
};

export function defaultMigrationsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
}

export async function runMigrations(input: RunMigrationsInput): Promise<MigrationResult> {
  const { client, migrationsDir } = input;
  const result: MigrationResult = { applied: [], skipped: [] };

  await client.query("begin");

  try {
    await client.query(
      "select pg_advisory_xact_lock(hashtext('iris_schema_migrations'))",
    );
    await client.query(`
create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
)
`);

    const appliedResult = await client.query(
      "select name from schema_migrations order by name asc",
    );
    const appliedNames = new Set(readAppliedMigrationNames(appliedResult));
    const migrationNames = (await readdir(migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));

    for (const migrationName of migrationNames) {
      if (appliedNames.has(migrationName)) {
        result.skipped.push(migrationName);
        continue;
      }

      const sql = await readFile(join(migrationsDir, migrationName), "utf8");
      await client.query(sql);
      await client.query("insert into schema_migrations(name) values ($1)", [
        migrationName,
      ]);
      result.applied.push(migrationName);
    }

    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

function readAppliedMigrationNames(queryResult: unknown): string[] {
  const rows = (queryResult as QueryRowsResult).rows;
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
}

async function main(): Promise<void> {
  const config = readDatabaseConfig();
  const pool = createPostgresPool(config);
  const client = await pool.connect();

  try {
    const result = await runMigrations({
      client,
      migrationsDir: defaultMigrationsDir(),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    client.release();
    await closePostgresPool(pool);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
