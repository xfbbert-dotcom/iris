import type { RuntimeController } from "../admin/runtime-controller.js";
import { readDatabaseConfig, type DatabaseConfig, type DatabaseEnv } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import type {
  KnowledgeDraftRepository,
  KnowledgeDraftStatusCounts,
} from "../knowledge-governance/knowledge-draft-repository.js";
import {
  createPostgresKnowledgeDraftRepository,
  type PostgresKnowledgeDraftDataSource,
} from "../knowledge-governance/postgres-knowledge-draft-repository.js";

type KnowledgeDraftPool = PostgresKnowledgeDraftDataSource & { end(): Promise<void> };

export type KnowledgeDraftRuntime = {
  repository: KnowledgeDraftRepository;
  canCreateDraft(input: { sourceGroupId?: string }): boolean;
  getStatus(): Promise<{
    enabled: true;
    companyCreationEnabled: boolean;
    counts: KnowledgeDraftStatusCounts;
  }>;
  close(): Promise<void>;
};

export type KnowledgeDraftRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => KnowledgeDraftPool;
  createRepository?: (input: {
    dataSource: PostgresKnowledgeDraftDataSource;
  }) => KnowledgeDraftRepository;
};

export function createKnowledgeDraftRuntime({
  env = process.env,
  runtimeController,
  dependencies = {},
}: {
  env?: DatabaseEnv;
  runtimeController?: Pick<RuntimeController, "canGenerateKnowledgeDrafts">;
  dependencies?: KnowledgeDraftRuntimeDependencies;
} = {}): KnowledgeDraftRuntime | undefined {
  if (!env.DATABASE_URL?.trim()) {
    return undefined;
  }
  if (runtimeController === undefined) {
    throw new Error("runtimeController is required for knowledge draft governance");
  }

  const pool = (dependencies.createPostgresPool ?? createPostgresPool)(
    readDatabaseConfig(env),
  ) as KnowledgeDraftPool;
  const repository = (dependencies.createRepository ?? createPostgresKnowledgeDraftRepository)({
    dataSource: pool,
  });
  let closePromise: Promise<void> | undefined;

  return {
    repository,
    canCreateDraft(input) {
      return runtimeController.canGenerateKnowledgeDrafts(input);
    },
    async getStatus() {
      return {
        enabled: true,
        companyCreationEnabled: runtimeController.canGenerateKnowledgeDrafts(),
        counts: await repository.getStatusCounts(),
      };
    },
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
