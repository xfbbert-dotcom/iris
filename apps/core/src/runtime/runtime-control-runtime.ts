import type pg from "pg";

import type { EnvLike } from "../config/env.js";
import { createDefaultRuntimeConfig } from "../config/runtime-config.js";
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import { RuntimeController } from "../admin/runtime-controller.js";
import { createPostgresRuntimeControlStore } from "../admin/postgres-runtime-control-store.js";
import {
  PostgresAuditLog,
  createPostgresAuditEventStore,
} from "../audit/postgres-audit-log.js";
import type { InMemoryAuditLog } from "../audit/audit-log.js";

export type RuntimeControlRuntime = {
  controller: RuntimeController;
  auditLog: InMemoryAuditLog;
  close(): Promise<void>;
};

export type RuntimeControlRuntimeDependencies = {
  createPostgresPool?: (
    config: DatabaseConfig,
  ) => Pick<pg.Pool, "query" | "connect" | "end">;
};

export async function createRuntimeControlRuntime({
  env = process.env,
  dependencies = {},
}: {
  env?: EnvLike;
  dependencies?: RuntimeControlRuntimeDependencies;
} = {}): Promise<RuntimeControlRuntime> {
  const pool = (dependencies.createPostgresPool ?? createPostgresPool)(
    readDatabaseConfig(env),
  );
  const controller = new RuntimeController(
    createDefaultRuntimeConfig(),
    createPostgresRuntimeControlStore(pool),
  );

  try {
    await controller.hydrate();
    const auditLog = await PostgresAuditLog.create(
      createPostgresAuditEventStore(pool),
    );
    return {
      controller,
      auditLog,
      close() {
        return pool.end();
      },
    };
  } catch (error) {
    try {
      await pool.end();
    } catch {
      // Preserve the hydration failure.
    }
    throw error;
  }
}
