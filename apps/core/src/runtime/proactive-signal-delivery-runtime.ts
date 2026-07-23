import type { RuntimeController } from "../admin/runtime-controller.js";
import {
  readFeishuOpenApiConfig,
  readProactiveSignalDeliveryRuntimeConfig,
  type EnvLike,
} from "../config/env.js";
import type { DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import { createFeishuInteractiveCardClient } from "../feishu/feishu-interactive-card-client.js";
import { createFeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";
import { createProactiveSignalDispatcher } from "../proactive-signals/proactive-signal-dispatcher.js";
import {
  createProactiveSignalDispatcherLoop,
  type ProactiveSignalDispatcherLoopSnapshot,
} from "../proactive-signals/proactive-signal-dispatcher-loop.js";
import {
  createPostgresProactiveSignalRepository,
  type ProactiveSignalDataSource,
  type ProactiveSignalRepository,
} from "../proactive-signals/proactive-signal-repository.js";
import { closeRuntimeResources } from "./runtime-close.js";
import { observeStartupPromise } from "./startup-promise.js";

const DISPATCHER_WORKER_ID = "proactive-signal-dispatcher";
const EXTERNAL_LEASE_MS = 30_000;
const SEND_RETRY_DELAY_MS = 1_000;

type ProactiveSignalPool = ProactiveSignalDataSource & { end(): Promise<void> };
type ProactiveSignalRuntimeGate = Pick<RuntimeController, "canProactivelySpeak">;

export type ProactiveSignalDeliveryRuntimeStatus = {
  enabled: true;
  running: boolean;
  enabledGroupCount: number;
  dispatcher: ProactiveSignalDispatcherLoopSnapshot;
};

export type ProactiveSignalDeliveryRuntime = {
  repository: ProactiveSignalRepository;
  canUseProactiveSignalDelivery(groupId: string): boolean;
  start(): Promise<void>;
  getStatus(): Promise<ProactiveSignalDeliveryRuntimeStatus>;
  close(): Promise<void>;
};

export type ProactiveSignalDeliveryRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => ProactiveSignalPool;
  createRepository?: typeof createPostgresProactiveSignalRepository;
  createDispatcher?: typeof createProactiveSignalDispatcher;
  createFeishuTenantAccessTokenProvider?: typeof createFeishuTenantAccessTokenProvider;
  createFeishuInteractiveCardClient?: typeof createFeishuInteractiveCardClient;
  createDispatcherLoop?: typeof createProactiveSignalDispatcherLoop;
  onStartupCleanup?: (cleanup: Promise<void>) => void;
};

export function createProactiveSignalDeliveryRuntime({
  env = process.env,
  runtimeController,
  dependencies = {},
}: {
  env?: EnvLike;
  runtimeController?: ProactiveSignalRuntimeGate;
  dependencies?: ProactiveSignalDeliveryRuntimeDependencies;
} = {}): ProactiveSignalDeliveryRuntime | undefined {
  const config = readProactiveSignalDeliveryRuntimeConfig(env);
  if (!config.enabled) return undefined;
  if (runtimeController === undefined) {
    throw new Error("runtimeController is required when proactive signal delivery is enabled");
  }

  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createRepository = dependencies.createRepository ?? createPostgresProactiveSignalRepository;
  const createDispatcher = dependencies.createDispatcher ?? createProactiveSignalDispatcher;
  const createTokenProvider = dependencies.createFeishuTenantAccessTokenProvider ??
    createFeishuTenantAccessTokenProvider;
  const createCardClient = dependencies.createFeishuInteractiveCardClient ??
    createFeishuInteractiveCardClient;
  const createDispatcherPollingLoop = dependencies.createDispatcherLoop ??
    createProactiveSignalDispatcherLoop;
  const enabledGroups = new Set(config.enabledGroupIds);
  let pool: ProactiveSignalPool | undefined;
  let dispatcherLoop: ReturnType<typeof createProactiveSignalDispatcherLoop> | undefined;
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
    const feishuConfig = readFeishuOpenApiConfig(env);
    const tokenProvider = createTokenProvider({
      baseUrl: feishuConfig.baseUrl,
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
    });
    const cardClient = createCardClient({
      baseUrl: feishuConfig.baseUrl,
      tokenProvider,
    });
    const dispatcher = createDispatcher({
      repository,
      cardClient,
      canDeliverProactiveSignals: canUseGroup,
      workerId: DISPATCHER_WORKER_ID,
      leaseMs: EXTERNAL_LEASE_MS,
      retryDelayMs: SEND_RETRY_DELAY_MS,
    });
    dispatcherLoop = createDispatcherPollingLoop({
      worker: dispatcher,
      intervalMs: config.intervalMs,
      batchLimit: config.batchLimit,
      onError: () => undefined,
    });

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      lifecycle = "closed";
      closePromise ??= observeStartupPromise(closeRuntimeResources([
        () => dispatcherLoop!.stop(),
        () => pool!.end(),
      ]));
      return closePromise;
    };

    return {
      repository,
      canUseProactiveSignalDelivery: canUseGroup,
      async start() {
        if (lifecycle === "closed") throw new Error("proactive signal delivery runtime is closed");
        if (lifecycle === "started") return;
        lifecycle = "started";
        try {
          dispatcherLoop!.start();
        } catch (error) {
          await close();
          throw error;
        }
      },
      async getStatus() {
        return {
          enabled: true,
          running: dispatcherLoop!.getSnapshot().running,
          enabledGroupCount: enabledGroups.size,
          dispatcher: dispatcherLoop!.getSnapshot(),
        };
      },
      close,
    };
  } catch (error) {
    const cleanup = observeStartupPromise(closeRuntimeResources([
      ...(dispatcherLoop === undefined ? [] : [() => dispatcherLoop!.stop()]),
      ...(pool === undefined ? [] : [() => pool!.end()]),
    ]));
    dependencies.onStartupCleanup?.(cleanup);
    throw error;
  }
}
