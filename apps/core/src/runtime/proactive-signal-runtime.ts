import type { RuntimeController } from "../admin/runtime-controller.js";
import type { EnvLike } from "../config/env.js";
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import {
  createPostgresProactiveSignalRepository,
  type PostgresProactiveSignalDataSource,
} from "../proactive/postgres-proactive-signal-repository.js";
import {
  readProactiveSignalRuntimeConfig,
} from "../proactive/proactive-signal-runtime-config.js";
import {
  createProactiveSignalScanner,
  type ProactiveSignalScanner,
  type ProactiveSignalScanResult,
} from "../proactive/proactive-signal-scanner.js";
import type {
  ProactiveSignalRepository,
  ProactiveSignalStatusCounts,
} from "../proactive/proactive-signal-repository.js";
import {
  createProactiveSignalWorkerLoop,
  type ProactiveSignalWorkerLoop,
  type ProactiveSignalWorkerLoopSnapshot,
} from "../proactive/proactive-signal-worker-loop.js";
import { closeRuntimeResources } from "./runtime-close.js";

type ProactivePool = PostgresProactiveSignalDataSource & { end(): Promise<void> };

export type ProactiveSignalRuntimeStatus = {
  enabled: true;
  running: boolean;
  policyVersion: string;
  intervalMs: number;
  batchLimit: number;
  allowlistedGroupCount: number;
  idleReason: "empty_allowlist" | undefined;
  counts: ProactiveSignalStatusCounts;
  latestScan?: ProactiveSignalWorkerLoopSnapshot["latestScan"];
};

export type ProactiveSignalRuntime = {
  repository: ProactiveSignalRepository;
  start(): void;
  scanNow(): Promise<ProactiveSignalScanResult>;
  getStatus(): Promise<ProactiveSignalRuntimeStatus>;
  close(): Promise<void>;
};

export type ProactiveSignalRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => ProactivePool;
  createRepository?: typeof createPostgresProactiveSignalRepository;
  createScanner?: typeof createProactiveSignalScanner;
  createWorkerLoop?: typeof createProactiveSignalWorkerLoop;
};

export function createProactiveSignalRuntime({
  env = process.env,
  runtimeController,
  dependencies = {},
}: {
  env?: EnvLike;
  runtimeController?: RuntimeController;
  dependencies?: ProactiveSignalRuntimeDependencies;
} = {}): ProactiveSignalRuntime | undefined {
  const config = readProactiveSignalRuntimeConfig(env);
  if (!config.enabled) return undefined;
  if (runtimeController === undefined) {
    throw new Error("runtimeController is required when proactive candidate scanning is enabled");
  }

  const createPool = dependencies.createPostgresPool ??
    ((databaseConfig: DatabaseConfig) => createPostgresPool(databaseConfig) as ProactivePool);
  const pool = createPool(readDatabaseConfig(env));
  const repository = (dependencies.createRepository ?? createPostgresProactiveSignalRepository)({
    dataSource: pool,
  });
  const scanner: ProactiveSignalScanner = (dependencies.createScanner ?? createProactiveSignalScanner)({
    repository,
    runtimeGate: runtimeController,
    groupIds: config.groupIds,
    batchLimit: config.batchLimit,
    policy: config.policy,
  });
  const loop: ProactiveSignalWorkerLoop = (
    dependencies.createWorkerLoop ?? createProactiveSignalWorkerLoop
  )({
    scanner,
    intervalMs: config.intervalMs,
    onError: () => undefined,
  });
  let started = false;

  return {
    repository,
    start() {
      if (started) return;
      started = true;
      loop.start();
    },
    scanNow() {
      return scanner.scan();
    },
    async getStatus() {
      const [counts, loopSnapshot] = await Promise.all([
        repository.getStatusCounts(),
        Promise.resolve(loop.getSnapshot()),
      ]);
      return {
        enabled: true,
        running: loopSnapshot.running,
        policyVersion: config.policy.policyVersion,
        intervalMs: config.intervalMs,
        batchLimit: config.batchLimit,
        allowlistedGroupCount: config.groupIds.length,
        idleReason: config.groupIds.length === 0 ? "empty_allowlist" : undefined,
        counts,
        ...(loopSnapshot.latestScan === undefined
          ? {}
          : { latestScan: loopSnapshot.latestScan }),
      };
    },
    close() {
      return closeRuntimeResources([
        () => loop.stop(),
        () => pool.end(),
      ]);
    },
  };
}
