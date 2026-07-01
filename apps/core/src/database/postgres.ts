import pg from "pg";

import type { DatabaseConfig } from "./database-config.js";

export type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
};

export type DatabaseHealth = {
  ok: boolean;
};

export function createPostgresPool(config: DatabaseConfig): pg.Pool {
  return new pg.Pool({ connectionString: config.databaseUrl });
}

export async function checkDatabaseHealth(
  queryable: Queryable,
): Promise<DatabaseHealth> {
  await queryable.query("select 1 as ok");
  return { ok: true };
}
