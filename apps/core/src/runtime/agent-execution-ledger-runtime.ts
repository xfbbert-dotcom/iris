import {
  createAgentExecutionObserver,
  type AgentExecutionObserver,
} from "../agent-runtime/agent-execution-observer.js";
import {
  createPostgresAgentExecutionLedgerRepository,
  type AgentExecutionLedgerRepository,
} from "../agent-runtime/agent-execution-ledger-repository.js";
import {
  readAgentExecutionLedgerRuntimeConfig,
  type EnvLike,
} from "../config/env.js";
import type { DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import type {
  PostgresKnowledgeDraftDataSource,
} from "../knowledge-governance/postgres-knowledge-draft-repository.js";

const MAX_WRITE_FAILURE_COUNT = Number.MAX_SAFE_INTEGER;

type AgentExecutionLedgerPool = PostgresKnowledgeDraftDataSource & {
  end(): Promise<void>;
};

export type AgentExecutionLedgerRuntimeStatus = {
  enabled: true;
  writeFailureCount: number;
  lastWriteFailureAt?: Date;
};

export type AgentExecutionLedgerRuntime = {
  observer: AgentExecutionObserver;
  repository: AgentExecutionLedgerRepository;
  getStatus(): AgentExecutionLedgerRuntimeStatus;
  close(): Promise<void>;
};

export type AgentExecutionLedgerRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => AgentExecutionLedgerPool;
  createRepository?: typeof createPostgresAgentExecutionLedgerRepository;
  createObserver?: typeof createAgentExecutionObserver;
  onStartupCleanup?: (cleanup: Promise<void>) => void;
};

export function createAgentExecutionLedgerRuntime({
  env = process.env,
  dependencies = {},
  now = () => new Date(),
  createId,
}: {
  env?: EnvLike;
  dependencies?: AgentExecutionLedgerRuntimeDependencies;
  now?: () => Date;
  createId?: () => string;
} = {}): AgentExecutionLedgerRuntime | undefined {
  const config = readAgentExecutionLedgerRuntimeConfig(env);
  if (!config.enabled) {
    return undefined;
  }

  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createRepository =
    dependencies.createRepository ?? createPostgresAgentExecutionLedgerRepository;
  const createObserver = dependencies.createObserver ?? createAgentExecutionObserver;
  let pool: AgentExecutionLedgerPool | undefined;

  try {
    pool = createPool({ databaseUrl: config.databaseUrl });
    const repository = createRepository({ dataSource: pool });
    let writeFailureCount = 0;
    let lastWriteFailureAt: Date | undefined;
    const observer = createObserver({
      repository,
      now,
      ...(createId === undefined ? {} : { createId }),
      onWriteFailure(failure) {
        writeFailureCount = Math.min(MAX_WRITE_FAILURE_COUNT, writeFailureCount + 1);
        lastWriteFailureAt = new Date(failure.at);
      },
    });
    let closePromise: Promise<void> | undefined;

    return {
      observer,
      repository,
      getStatus() {
        return {
          enabled: true,
          writeFailureCount,
          ...(lastWriteFailureAt === undefined
            ? {}
            : { lastWriteFailureAt: new Date(lastWriteFailureAt) }),
        };
      },
      close() {
        closePromise ??= pool!.end();
        return closePromise;
      },
    };
  } catch (error) {
    if (pool !== undefined) {
      const cleanup = pool.end().catch(() => undefined);
      dependencies.onStartupCleanup?.(cleanup);
    }
    throw error;
  }
}
