import pg from "pg";

import type { DatabaseConfig } from "./database-config.js";

export type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
};

export type DatabaseHealth = {
  ok: boolean;
};

export type PostgresPoolConfig = DatabaseConfig & {
  connectionTimeoutMillis?: number;
  queryTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  lockTimeoutMillis?: number;
};

export function createPostgresPool(config: PostgresPoolConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    query_timeout: config.queryTimeoutMillis,
    statement_timeout: config.statementTimeoutMillis,
    lock_timeout: config.lockTimeoutMillis,
  });
}

export async function closePostgresPool(pool: pg.Pool): Promise<void> {
  await pool.end();
}

export async function checkDatabaseHealth(
  queryable: Queryable,
): Promise<DatabaseHealth> {
  await queryable.query("select 1 as ok");
  return { ok: true };
}
