import type { EnvLike } from "../config/env.js";
import { createDefaultRuntimeConfig } from "../config/runtime-config.js";
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import { RuntimeController } from "../admin/runtime-controller.js";
import { createPostgresRuntimeControlStore } from "../admin/postgres-runtime-control-store.js";

export type RuntimeControlRuntime = {
  controller: RuntimeController;
  close(): Promise<void>;
};

export type RuntimeControlRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => {
    query: ReturnType<typeof createPostgresPool>["query"];
    end(): Promise<void>;
  };
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
  } catch (error) {
    try {
      await pool.end();
    } catch {
      // Preserve the hydration failure.
    }
    throw error;
  }

  return {
    controller,
    close() {
      return pool.end();
    },
  };
}
