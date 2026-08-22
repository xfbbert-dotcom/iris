import type { RuntimeController } from "../admin/runtime-controller.js";
import { readFeishuTaskCreationDeploymentConfig } from "../config/env.js";
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
import type { FormalTaskCardRepository } from
  "../formal-tasks/formal-task-card-repository.js";
import { createPostgresFormalTaskCardRepository } from
  "../formal-tasks/postgres-formal-task-card-repository.js";
import type { FormalTaskExecutionRepository } from
  "../formal-tasks/formal-task-execution-repository.js";
import { createPostgresFormalTaskExecutionRepository } from
  "../formal-tasks/postgres-formal-task-execution-repository.js";
import { presentFormalTaskDraft } from
  "../formal-tasks/formal-task-draft-presentation-service.js";

type FormalTaskPool = PostgresFormalTaskDataSource & { end(): Promise<void> };

export type FormalTaskRuntime = {
  repository: FormalTaskRepository;
  cardRepository: FormalTaskCardRepository;
  executionRepository: FormalTaskExecutionRepository;
  canCreateDraft(input: { sourceGroupId: string }): boolean;
  canUseFormalTaskCards(groupId: string): boolean;
  presentDraft(input: Omit<Parameters<typeof presentFormalTaskDraft>[0], "runtime">):
    ReturnType<typeof presentFormalTaskDraft>;
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
  createCardRepository?: (input: {
    dataSource: PostgresFormalTaskDataSource;
  }) => FormalTaskCardRepository;
  createExecutionRepository?: (input: {
    dataSource: PostgresFormalTaskDataSource;
  }) => FormalTaskExecutionRepository;
};

export function createFormalTaskRuntime({
  env = process.env,
  runtimeController,
  dependencies = {},
}: {
  env?: DatabaseEnv;
  runtimeController?: Pick<
    RuntimeController,
    "canGenerateTaskDrafts" | "canCreateFeishuTasks" | "getSnapshot"
  >;
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
  const cardRepository = (dependencies.createCardRepository ?? createPostgresFormalTaskCardRepository)({
    dataSource: pool,
  });
  const executionRepository = (
    dependencies.createExecutionRepository ?? createPostgresFormalTaskExecutionRepository
  )({ dataSource: pool });
  const taskCreationDeployment = readFeishuTaskCreationDeploymentConfig(env);
  const canUseFormalTaskCards = (groupId: string): boolean => {
    const normalized = groupId.trim();
    if (
      normalized !== groupId || normalized.length < 1 ||
      !taskCreationDeployment.enabled ||
      !taskCreationDeployment.groupAllowlist.includes(normalized)
    ) return false;
    try {
      const snapshot = runtimeController.getSnapshot();
      return runtimeController.canCreateFeishuTasks({ sourceGroupId: normalized }) &&
        snapshot.capabilities.callExternalTools;
    } catch {
      return false;
    }
  };
  let closePromise: Promise<void> | undefined;
  return {
    repository,
    cardRepository,
    executionRepository,
    canCreateDraft(input) {
      return runtimeController.canGenerateTaskDrafts(input);
    },
    canUseFormalTaskCards(groupId) {
      return canUseFormalTaskCards(groupId);
    },
    presentDraft(input) {
      return presentFormalTaskDraft({
        ...input,
        runtime: {
          repository,
          cardRepository,
          canUseFormalTaskCards,
        },
      });
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
