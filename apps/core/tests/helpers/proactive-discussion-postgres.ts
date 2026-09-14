import { randomUUID } from "node:crypto";
import pg from "pg";
import { defaultMigrationsDir, runMigrations } from "../../src/database/migrate.js";
import type { PdFoundationRepository } from "../../src/proactive-discussion/repository.js";

export async function openPdDatabase(): Promise<{
  pool: pg.Pool; repository: PdFoundationRepository; close(): Promise<void>;
}> {
  const connectionString = process.env.IRIS_TEST_DATABASE_URL?.trim();
  if (!connectionString) throw new Error("IRIS_TEST_DATABASE_URL must name an isolated test database");
  const { createPostgresProactiveDiscussionRepository } = await import("../../src/proactive-discussion/postgres-repository.js");
  const schema = `pd_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString });
  const pool = new pg.Pool({ connectionString,
    options: `-c search_path=${schema},public -c statement_timeout=3000`, max: 12 });
  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try { await pool.end(); }
    finally {
      try {
        if (!/^pd_[a-f0-9]{32}$/u.test(schema)) throw new Error("invalid disposable schema");
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally { await admin.end(); }
    }
  }
  try {
    const client = await admin.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally { client.release(); }
    return { pool, repository: createPostgresProactiveDiscussionRepository({ dataSource: pool }), close };
  } catch (error) { await close(); throw error; }
}
