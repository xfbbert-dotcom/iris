import { createClient } from "redis";

import type { RuntimeController } from "../admin/runtime-controller.js";
import {
  readFeishuAuthConfig,
  readFeishuOpenApiConfig,
  readKnowledgeCardRuntimeConfig,
  type EnvLike,
} from "../config/env.js";
import type { DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import {
  createFeishuRequestVerifier,
  decodeFeishuPayload,
  isFeishuUrlVerificationPayload,
  verifyFeishuVerificationToken,
} from "../feishu/feishu-auth.js";
import {
  createFeishuCardActionGateway,
  type FeishuCardActionCallbackRequest,
} from "../feishu/feishu-card-action-gateway.js";
import { createFeishuGroupMembershipChecker } from "../feishu/feishu-group-membership-checker.js";
import { createFeishuInteractiveCardClient } from "../feishu/feishu-interactive-card-client.js";
import { createFeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";
import type { KnowledgeDraftRepository } from "../knowledge-governance/knowledge-draft-repository.js";
import {
  createPostgresKnowledgeDraftRepository,
  type PostgresKnowledgeDraftDataSource,
} from "../knowledge-governance/postgres-knowledge-draft-repository.js";
import type { ApprovalInteractionQueue } from "../knowledge-cards/approval-interaction-queue.js";
import { createApprovalInteractionWorker } from "../knowledge-cards/approval-interaction-worker.js";
import {
  createApprovalInteractionWorkerLoop,
  type ApprovalInteractionWorkerLoop,
  type ApprovalInteractionWorkerLoopSnapshot,
} from "../knowledge-cards/approval-interaction-worker-loop.js";
import { createKnowledgeCardDispatcher } from "../knowledge-cards/knowledge-card-dispatcher.js";
import {
  createKnowledgeCardDispatcherLoop,
  type KnowledgeCardDispatcherLoop,
  type KnowledgeCardDispatcherLoopSnapshot,
} from "../knowledge-cards/knowledge-card-dispatcher-loop.js";
import type {
  KnowledgeCardRepository,
  KnowledgeCardOutboxStatusCounts,
  KnowledgeCardStatusCounts,
} from "../knowledge-cards/knowledge-card-repository.js";
import { createPostgresKnowledgeCardRepository } from "../knowledge-cards/postgres-knowledge-card-repository.js";
import {
  createRedisApprovalInteractionQueue,
  type RedisApprovalInteractionQueueClient,
} from "../knowledge-cards/redis-approval-interaction-queue.js";
import { closeRuntimeResources } from "./runtime-close.js";
import { observeStartupPromise } from "./startup-promise.js";

const DISPATCHER_WORKER_ID = "knowledge-card-dispatcher";
const INTERACTION_WORKER_ID = "approval-interaction-worker";
const EXTERNAL_LEASE_MS = 30_000;
const SEND_RETRY_DELAY_MS = 1_000;
export const KNOWLEDGE_CARD_TARGET_DISPLAY_NAME = "Unapproved suggested publication location";

type KnowledgeCardPool = PostgresKnowledgeDraftDataSource & { end(): Promise<void> };
type KnowledgeCardRedisClient = RedisApprovalInteractionQueueClient & {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
};
type KnowledgeCardRuntimeGate = Pick<RuntimeController, "canGenerateKnowledgeDrafts">;

export type KnowledgeCardRuntimeRepository = KnowledgeCardRepository &
  Pick<KnowledgeDraftRepository, "getDraft">;

export type KnowledgeCardRuntimeStatus = {
  enabled: true;
  running: boolean;
  enabledGroupCount: number;
  dispatcher: KnowledgeCardDispatcherLoopSnapshot;
  worker: ApprovalInteractionWorkerLoopSnapshot;
  queue: {
    pending: number;
    processing: number;
    delayed: number;
    deadLetter: number;
  };
  presentations: KnowledgeCardStatusCounts;
  outbox: KnowledgeCardOutboxStatusCounts;
};

export type KnowledgeCardRuntime = {
  gateway: ReturnType<typeof createFeishuCardActionGateway>;
  repository: KnowledgeCardRuntimeRepository;
  deadLetters: {
    list(input: { limit: number }): ReturnType<ApprovalInteractionQueue["listDeadLetters"]>;
    replay(id: string): ReturnType<ApprovalInteractionQueue["replayDeadLetter"]>;
    delete(id: string): ReturnType<ApprovalInteractionQueue["deleteDeadLetter"]>;
  };
  canUseKnowledgeCards(groupId: string): boolean;
  start(): Promise<void>;
  getStatus(): Promise<KnowledgeCardRuntimeStatus>;
  close(): Promise<void>;
};

export type KnowledgeCardRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => KnowledgeCardPool;
  createRedisClient?: (url: string) => KnowledgeCardRedisClient;
  createKnowledgeDraftRepository?: (input: {
    dataSource: PostgresKnowledgeDraftDataSource;
  }) => Pick<KnowledgeDraftRepository, "getDraft">;
  createKnowledgeCardRepository?: (input: {
    dataSource: PostgresKnowledgeDraftDataSource;
  }) => KnowledgeCardRepository;
  createApprovalInteractionQueue?: (input: {
    client: RedisApprovalInteractionQueueClient;
  }) => ApprovalInteractionQueue;
  createFeishuTenantAccessTokenProvider?: typeof createFeishuTenantAccessTokenProvider;
  createFeishuInteractiveCardClient?: typeof createFeishuInteractiveCardClient;
  createFeishuGroupMembershipChecker?: typeof createFeishuGroupMembershipChecker;
  createDispatcherLoop?: typeof createKnowledgeCardDispatcherLoop;
  createInteractionLoop?: typeof createApprovalInteractionWorkerLoop;
  onStartupCleanup?: (cleanup: Promise<void>) => void;
};

export function createKnowledgeCardRuntime({
  env = process.env,
  runtimeController,
  dependencies = {},
}: {
  env?: EnvLike;
  runtimeController?: KnowledgeCardRuntimeGate;
  dependencies?: KnowledgeCardRuntimeDependencies;
} = {}): KnowledgeCardRuntime | undefined {
  const config = readKnowledgeCardRuntimeConfig(env);
  if (!config.enabled) return undefined;
  if (runtimeController === undefined) {
    throw new Error("runtimeController is required when knowledge cards are enabled");
  }

  const feishuConfig = readFeishuOpenApiConfig(env);
  const feishuAuthConfig = readFeishuAuthConfig(env);
  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createRedis = dependencies.createRedisClient ??
    ((url: string) => createClient({ url }) as unknown as KnowledgeCardRedisClient);
  const createDrafts = dependencies.createKnowledgeDraftRepository ??
    createPostgresKnowledgeDraftRepository;
  const createRepository = dependencies.createKnowledgeCardRepository ??
    createPostgresKnowledgeCardRepository;
  const createQueue = dependencies.createApprovalInteractionQueue ??
    createRedisApprovalInteractionQueue;
  const createTokenProvider = dependencies.createFeishuTenantAccessTokenProvider ??
    createFeishuTenantAccessTokenProvider;
  const createCardClient = dependencies.createFeishuInteractiveCardClient ??
    createFeishuInteractiveCardClient;
  const createMembershipChecker = dependencies.createFeishuGroupMembershipChecker ??
    createFeishuGroupMembershipChecker;
  const createDispatcherPollingLoop = dependencies.createDispatcherLoop ??
    createKnowledgeCardDispatcherLoop;
  const createInteractionPollingLoop = dependencies.createInteractionLoop ??
    createApprovalInteractionWorkerLoop;

  let pool: KnowledgeCardPool | undefined;
  let redisClient: KnowledgeCardRedisClient | undefined;
  let redisConnection: Promise<KnowledgeCardRedisClient> | undefined;
  let dispatcherLoop: KnowledgeCardDispatcherLoop | undefined;
  let interactionLoop: ApprovalInteractionWorkerLoop | undefined;
  try {
    pool = createPool({ databaseUrl: config.databaseUrl });
    redisClient = createRedis(config.redisUrl);
    redisConnection = observeStartupPromise(Promise.resolve().then(async () => {
      await redisClient!.connect();
      return redisClient!;
    }));
    const queue = createQueue({ client: createLazyRedisQueueClient(redisConnection) });
    const cardRepository = createRepository({ dataSource: pool });
    const drafts = createDrafts({ dataSource: pool });
    const repository: KnowledgeCardRuntimeRepository = {
      ...cardRepository,
      getDraft(id) {
        return drafts.getDraft(id);
      },
    };
    const tokenProvider = createTokenProvider({
      baseUrl: feishuConfig.baseUrl,
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
    });
    const cardClient = createCardClient({
      baseUrl: feishuConfig.baseUrl,
      tokenProvider,
    });
    const membershipChecker = createMembershipChecker({
      baseUrl: feishuConfig.baseUrl,
      tokenProvider,
    });
    const enabledGroups = new Set(config.enabledGroupIds);
    const canUseKnowledgeCards = (groupId: string): boolean => {
      const normalized = groupId.trim();
      return normalized.length > 0 &&
        enabledGroups.has(normalized) &&
        runtimeController.canGenerateKnowledgeDrafts({ sourceGroupId: normalized });
    };
    const dispatcher = createKnowledgeCardDispatcher({
      repository,
      cardClient,
      canUseKnowledgeCards,
      targetDisplayName: KNOWLEDGE_CARD_TARGET_DISPLAY_NAME,
      workerId: DISPATCHER_WORKER_ID,
      leaseMs: EXTERNAL_LEASE_MS,
      retryDelayMs: SEND_RETRY_DELAY_MS,
    });
    const interactionWorker = createApprovalInteractionWorker({
      queue,
      repository,
      membershipChecker,
      cardClient,
      canUseKnowledgeCards,
      botOpenId: config.botOpenId,
      workerId: INTERACTION_WORKER_ID,
      leaseMs: EXTERNAL_LEASE_MS,
    });
    dispatcherLoop = createDispatcherPollingLoop({
      worker: dispatcher,
      intervalMs: config.intervalMs,
      batchLimit: config.batchLimit,
      onError: () => undefined,
    });
    interactionLoop = createInteractionPollingLoop({
      worker: interactionWorker,
      intervalMs: config.intervalMs,
      batchLimit: config.batchLimit,
      onError: () => undefined,
    });
    const verifyFeishuEnvelope = createFeishuRequestVerifier({
      encryptKey: feishuAuthConfig.encryptKey,
    }, {
      requireSignature: true,
    });
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: verifyFeishuEnvelope,
      decodeRequest(request) {
        const body = decodeFeishuPayload(request.body, feishuAuthConfig.encryptKey);
        return body === undefined ? undefined : { ...request, body };
      },
      verifyDecodedRequest(request) {
        return feishuAuthConfig.verificationToken !== undefined &&
          verifyFeishuVerificationToken(request.body, feishuAuthConfig.verificationToken) &&
          (isFeishuUrlVerificationPayload(request.body) ||
            readCallbackAppId(request) === feishuConfig.appId);
      },
    });
    let lifecycle: "idle" | "starting" | "started" | "failed" | "closed" = "idle";
    let startupPromise: Promise<void> | undefined;
    let closedStartPromise: Promise<void> | undefined;
    let closePromise: Promise<void> | undefined;
    const closeOwnedResources = (): Promise<void> => {
      if (lifecycle !== "failed") lifecycle = "closed";
      closePromise ??= observeStartupPromise(closeRuntimeResources([
        () => dispatcherLoop!.stop(),
        () => interactionLoop!.stop(),
        () => closeRedisClient(redisClient!, redisConnection!),
        () => pool!.end(),
      ]));
      return closePromise;
    };

    return {
      gateway,
      repository,
      deadLetters: {
        list: (input) => queue.listDeadLetters(input),
        replay: (id) => queue.replayDeadLetter(id),
        delete: (id) => queue.deleteDeadLetter(id),
      },
      canUseKnowledgeCards,
      start() {
        if (lifecycle === "closed") {
          closedStartPromise ??= observeStartupPromise(Promise.reject(
            new Error("knowledge-card runtime is closed"),
          ));
          return closedStartPromise;
        }
        if (startupPromise !== undefined) return startupPromise;

        let resolveStartup!: () => void;
        let rejectStartup!: (error: unknown) => void;
        startupPromise = observeStartupPromise(new Promise<void>((resolve, reject) => {
          resolveStartup = resolve;
          rejectStartup = reject;
        }));
        lifecycle = "starting";
        try {
          dispatcherLoop!.start();
          interactionLoop!.start();
          lifecycle = "started";
          resolveStartup();
        } catch (error) {
          lifecycle = "failed";
          void closeOwnedResources().then(
            () => rejectStartup(error),
            (cleanupError) => rejectStartup(startupCleanupFailure(error, cleanupError)),
          );
        }
        return startupPromise;
      },
      async getStatus() {
        const dispatcher = dispatcherLoop!.getSnapshot();
        const worker = interactionLoop!.getSnapshot();
        const [queueCounts, presentations, outbox] = await Promise.all([
          queue.getCounts(),
          repository.getStatusCounts(),
          repository.getOutboxStatusCounts(),
        ]);
        return {
          enabled: true,
          running: dispatcher.running && worker.running,
          enabledGroupCount: enabledGroups.size,
          dispatcher,
          worker,
          queue: queueCounts,
          presentations,
          outbox,
        };
      },
      close() {
        return closeOwnedResources();
      },
    };
  } catch (error) {
    const cleanup = observeStartupPromise(closeRuntimeResources([
      ...(dispatcherLoop === undefined ? [] : [() => dispatcherLoop!.stop()]),
      ...(interactionLoop === undefined ? [] : [() => interactionLoop!.stop()]),
      ...(redisClient === undefined || redisConnection === undefined
        ? []
        : [() => closeRedisClient(redisClient!, redisConnection!)]),
      ...(pool === undefined ? [] : [() => pool!.end()]),
    ]));
    dependencies.onStartupCleanup?.(cleanup);
    throw error;
  }
}

function startupCleanupFailure(startupError: unknown, cleanupError: unknown): AggregateError {
  const cleanupErrors = cleanupError instanceof AggregateError
    ? cleanupError.errors
    : [cleanupError];
  return new AggregateError(
    [startupError, ...cleanupErrors],
    "Knowledge-card runtime startup and cleanup failed",
  );
}

async function closeRedisClient(
  redisClient: KnowledgeCardRedisClient,
  redisConnection: Promise<KnowledgeCardRedisClient>,
): Promise<void> {
  let connectionFailed = false;
  let connectionError: unknown;
  try {
    await redisConnection;
  } catch (error) {
    connectionFailed = true;
    connectionError = error;
  }

  try {
    await redisClient.quit();
  } catch (error) {
    if (!connectionFailed) throw error;
  }
  if (connectionFailed) throw connectionError;
}

function createLazyRedisQueueClient(
  redisConnection: Promise<KnowledgeCardRedisClient>,
): RedisApprovalInteractionQueueClient {
  return {
    async eval(script, options) {
      const redis = await redisConnection;
      return redis.eval(script, options);
    },
  };
}

function readCallbackAppId(request: FeishuCardActionCallbackRequest): string | undefined {
  if (!isRecord(request.body) || !isRecord(request.body.header)) return undefined;
  const appId = request.body.header.app_id;
  return typeof appId === "string" ? appId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
