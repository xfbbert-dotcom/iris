import type { RuntimeController } from "../admin/runtime-controller.js";
import {
  readDatabaseConfig,
  type DatabaseConfig,
  type DatabaseEnv,
} from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import type {
  FormalTaskDraftStatusCounts,
  FormalTaskRepository,
} from "../formal-tasks/formal-task-repository.js";
import {
  createPostgresFormalTaskRepository,
  type PostgresFormalTaskDataSource,
} from "../formal-tasks/postgres-formal-task-repository.js";

type FormalTaskPool = PostgresFormalTaskDataSource & { end(): Promise<void> };

export type FormalTaskRuntime = {
  repository: FormalTaskRepository;
  canCreateDraft(input: { sourceGroupId: string }): boolean;
  getStatus(): Promise<{
    enabled: true;
    companyCreationEnabled: boolean;
    counts: FormalTaskDraftStatusCounts;
  }>;
  close(): Promise<void>;
};

export type FormalTaskRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => FormalTaskPool;
  createRepository?: (input: {
    dataSource: PostgresFormalTaskDataSource;
  }) => FormalTaskRepository;
};

export function createFormalTaskRuntime({
  env = process.env,
  runtimeController,
  dependencies = {},
}: {
  env?: DatabaseEnv;
  runtimeController?: Pick<RuntimeController, "canGenerateTaskDrafts">;
  dependencies?: FormalTaskRuntimeDependencies;
} = {}): FormalTaskRuntime | undefined {
  if (!env.DATABASE_URL?.trim()) return undefined;
  if (runtimeController === undefined) {
    throw new Error("runtimeController is required for formal task governance");
  }

  const pool = (dependencies.createPostgresPool ?? createPostgresPool)(
    readDatabaseConfig(env),
  ) as FormalTaskPool;
  const repository = (dependencies.createRepository ?? createPostgresFormalTaskRepository)({
    dataSource: pool,
  });
  let closePromise: Promise<void> | undefined;
  return {
    repository,
    canCreateDraft(input) {
      return runtimeController.canGenerateTaskDrafts(input);
    },
    async getStatus() {
      return {
        enabled: true,
        companyCreationEnabled: runtimeController.canGenerateTaskDrafts(),
        counts: await repository.getStatusCounts(),
      };
    },
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
