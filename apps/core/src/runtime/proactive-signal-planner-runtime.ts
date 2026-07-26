import type { RuntimeController } from "../admin/runtime-controller.js";
import {
  readProactiveSignalPlannerRuntimeConfig,
  type EnvLike,
} from "../config/env.js";
import type { ConversationStateInspectionStore } from "../conversation-state/conversation-state-api.js";
import type { DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import {
  createPostgresProactiveSignalRepository,
  type ProactiveSignalDataSource,
  type ProactiveSignalRepository,
} from "../proactive-signals/proactive-signal-repository.js";
import {
  createProactiveSignalScanner,
  type ProactiveSignalScanner,
} from "../proactive-signals/proactive-signal-scanner.js";
import {
  createProactiveSignalScannerLoop,
  type ProactiveSignalScannerLoop,
  type ProactiveSignalScannerLoopSnapshot,
} from "../proactive-signals/proactive-signal-scanner-loop.js";
import { closeRuntimeResources } from "./runtime-close.js";
import { observeStartupPromise } from "./startup-promise.js";

type ProactiveSignalPool = ProactiveSignalDataSource & { end(): Promise<void> };
type ProactiveSignalPlannerRuntimeGate = Pick<RuntimeController, "canProactivelySpeak">;

export type ProactiveSignalPlannerRuntimeStatus = {
  enabled: true;
  running: boolean;
  enabledGroupCount: number;
  scanner: ProactiveSignalScannerLoopSnapshot;
};

export type ProactiveSignalPlannerRuntime = {
  repository: ProactiveSignalRepository;
  canUseProactiveSignalPlanning(groupId: string): boolean;
  start(): Promise<void>;
  getStatus(): Promise<ProactiveSignalPlannerRuntimeStatus>;
  close(): Promise<void>;
};

export type ProactiveSignalPlannerRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => ProactiveSignalPool;
  createRepository?: typeof createPostgresProactiveSignalRepository;
  createScanner?: typeof createProactiveSignalScanner;
  createScannerLoop?: typeof createProactiveSignalScannerLoop;
  onStartupCleanup?: (cleanup: Promise<void>) => void;
};

export function createProactiveSignalPlannerRuntime({
  env = process.env,
  runtimeController,
  store,
  dependencies = {},
  now = () => new Date(),
}: {
  env?: EnvLike;
  runtimeController?: ProactiveSignalPlannerRuntimeGate;
  store?: Pick<ConversationStateInspectionStore, "listThreads" | "listActions">;
  dependencies?: ProactiveSignalPlannerRuntimeDependencies;
  now?: () => Date;
} = {}): ProactiveSignalPlannerRuntime | undefined {
  const config = readProactiveSignalPlannerRuntimeConfig(env);
  if (!config.enabled) return undefined;
  if (runtimeController === undefined) {
    throw new Error("runtimeController is required when proactive signal planning is enabled");
  }
  if (store === undefined) {
    throw new Error("conversation state store is required when proactive signal planning is enabled");
  }

  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createRepository = dependencies.createRepository ?? createPostgresProactiveSignalRepository;
  const createScanner = dependencies.createScanner ?? createProactiveSignalScanner;
  const createLoop = dependencies.createScannerLoop ?? createProactiveSignalScannerLoop;
  const enabledGroups = new Set(config.enabledGroupIds);
  let pool: ProactiveSignalPool | undefined;
  let scannerLoop: ProactiveSignalScannerLoop | undefined;
  let lifecycle: "idle" | "started" | "closed" = "idle";

  const canUseGroup = (groupId: string): boolean => {
    if (lifecycle !== "started") return false;
    const normalized = groupId.trim();
    if (normalized.length === 0 || !enabledGroups.has(normalized)) return false;
    try {
      return runtimeController.canProactivelySpeak(normalized);
    } catch {
      return false;
    }
  };

  try {
    pool = createPool({ databaseUrl: config.databaseUrl });
    const repository = createRepository({ dataSource: pool });
    const scanner: ProactiveSignalScanner = createScanner({
      store,
      repository,
      canPlanProactiveSignals: canUseGroup,
      now,
      quietThreadAfterMinutes: config.quietThreadAfterMinutes,
      overdueActionGraceMinutes: config.overdueActionGraceMinutes,
    });
    scannerLoop = createLoop({
      scanner,
      groupIds: config.enabledGroupIds,
      intervalMs: config.intervalMs,
      batchLimit: config.batchLimit,
      onError: () => undefined,
    });

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      lifecycle = "closed";
      closePromise ??= observeStartupPromise(closeRuntimeResources([
        () => scannerLoop!.stop(),
        () => pool!.end(),
      ]));
      return closePromise;
    };

    return {
      repository,
      canUseProactiveSignalPlanning: canUseGroup,
      async start() {
        if (lifecycle === "closed") throw new Error("proactive signal planner runtime is closed");
        if (lifecycle === "started") return;
        lifecycle = "started";
        try {
          scannerLoop!.start();
        } catch (error) {
          await close();
          throw error;
        }
      },
      async getStatus() {
        return {
          enabled: true,
          running: scannerLoop!.getSnapshot().running,
          enabledGroupCount: enabledGroups.size,
          scanner: scannerLoop!.getSnapshot(),
        };
      },
      close,
    };
  } catch (error) {
    const cleanup = observeStartupPromise(closeRuntimeResources([
      ...(scannerLoop === undefined ? [] : [() => scannerLoop!.stop()]),
      ...(pool === undefined ? [] : [() => pool!.end()]),
    ]));
    dependencies.onStartupCleanup?.(cleanup);
    throw error;
  }
}
