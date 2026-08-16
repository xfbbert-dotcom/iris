import { ClientClosedError, createClient } from "redis";

import type { RuntimeController } from "../admin/runtime-controller.js";
import {
  readFeishuAuthConfig,
  readFeishuOpenApiConfig,
  readKnowledgeCardRuntimeConfig,
  readProactiveFeedbackConfig,
  type EnvLike,
} from "../config/env.js";
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import {
  createFeishuRequestVerifier,
  decodeFeishuPayload,
  diagnoseFeishuCallbackAuthentication,
  type FeishuCallbackAuthenticationDiagnostic,
  isFeishuUrlVerificationPayload,
  verifyFreshFeishuCallbackPayload,
  verifyFeishuVerificationToken,
} from "../feishu/feishu-auth.js";
import {
  createFeishuCardActionGateway,
  type FeishuCardActionCallbackDiagnostic,
  type FeishuCardActionCallbackRequest,
} from "../feishu/feishu-card-action-gateway.js";
import { createFeishuGroupMembershipChecker } from "../feishu/feishu-group-membership-checker.js";
import type { FeishuGroupMembershipChecker } from "../feishu/feishu-group-membership-checker.js";
import {
  createFeishuInteractiveCardClient,
  type FeishuInteractiveCardClient,
} from "../feishu/feishu-interactive-card-client.js";
import { createFeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";
import type { KnowledgeDraftRepository } from "../knowledge-governance/knowledge-draft-repository.js";
import {
  createPostgresKnowledgeDraftRepository,
  type PostgresKnowledgeDraftDataSource,
} from "../knowledge-governance/postgres-knowledge-draft-repository.js";
import type { ApprovalInteractionQueue } from "../knowledge-cards/approval-interaction-queue.js";
import {
  createApprovalInteractionWorker,
  type ApprovalInteractionWorkerDependencies,
} from "../knowledge-cards/approval-interaction-worker.js";
import {
  createPostgresApprovalInteractionIntentStore,
} from "../knowledge-cards/postgres-approval-interaction-intent-store.js";
import { createPostgresKnowledgeConflictCallbackIdentityStore } from
  "../knowledge-conflicts/postgres-knowledge-conflict-callback-identity-store.js";
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
  createProactiveSignalFeedbackWorker,
} from "../proactive-signals/proactive-signal-feedback-worker.js";
import type {
  ProactiveSignalRepository,
} from "../proactive-signals/proactive-signal-repository.js";
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
// Node Redis 6.1 defaults its first reconnect to 50 ms plus at most 199 ms of jitter.
const STATUS_REDIS_INITIAL_RECONNECT_BOUND_MS = 300;
export const KNOWLEDGE_CARD_TARGET_DISPLAY_NAME = "Unapproved suggested publication location";

type KnowledgeCardPool = PostgresKnowledgeDraftDataSource & { end(): Promise<void> };
type KnowledgeCardRedisClient = RedisApprovalInteractionQueueClient & {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
};
type KnowledgeCardStatusRedisClient = RedisApprovalInteractionQueueClient & {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
  destroy(): void;
  on?(event: "error", listener: (error: Error) => void): unknown;
  on?(event: "connect" | "reconnecting", listener: () => void): unknown;
};
type KnowledgeCardRuntimeGate = Pick<
  RuntimeController,
  "canGenerateKnowledgeDrafts" | "canProactivelySpeak"
>;

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

export type KnowledgeCardStatusReaderStatus = {
  enabled: false;
  running: false;
  enabledGroupCount: 0;
  queue: {
    pending: number;
    processing: number;
    delayed: number;
    deadLetter: number;
  };
  presentations: KnowledgeCardStatusCounts;
  outbox: KnowledgeCardOutboxStatusCounts;
};

export type KnowledgeCardStatusReader = {
  getStatus(): Promise<KnowledgeCardStatusReaderStatus>;
  close(): Promise<void>;
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
  approvalInteractions: {
    cardClient: Pick<FeishuInteractiveCardClient, "sendCardToUser" | "updateCard">;
    membershipChecker: FeishuGroupMembershipChecker;
    botOpenId: string;
  };
  bindActionApprovalWorker(
    worker: NonNullable<ApprovalInteractionWorkerDependencies["actionApprovalWorker"]>,
  ): void;
  bindKnowledgeConflictInteractionWorker(
    worker: NonNullable<
      ApprovalInteractionWorkerDependencies["knowledgeConflictInteractionWorker"]
    >,
  ): void;
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
  createApprovalInteractionIntentStore?: typeof createPostgresApprovalInteractionIntentStore;
  createKnowledgeConflictCallbackIdentityStore?:
    typeof createPostgresKnowledgeConflictCallbackIdentityStore;
  createInteractionWorker?: typeof createApprovalInteractionWorker;
  createFeishuTenantAccessTokenProvider?: typeof createFeishuTenantAccessTokenProvider;
  createFeishuInteractiveCardClient?: typeof createFeishuInteractiveCardClient;
  createFeishuGroupMembershipChecker?: typeof createFeishuGroupMembershipChecker;
  createDispatcherLoop?: typeof createKnowledgeCardDispatcherLoop;
  createInteractionLoop?: typeof createApprovalInteractionWorkerLoop;
  onCardCallbackDiagnostic?: (diagnostic: FeishuCardActionCallbackDiagnostic) => void;
  onCardAuthenticationDiagnostic?: (diagnostic: FeishuCallbackAuthenticationDiagnostic) => void;
  onStartupCleanup?: (cleanup: Promise<void>) => void;
};

export type KnowledgeCardStatusReaderDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => KnowledgeCardPool;
  createRedisClient?: (url: string) => KnowledgeCardStatusRedisClient;
  createKnowledgeCardRepository?: (input: {
    dataSource: PostgresKnowledgeDraftDataSource;
  }) => Pick<KnowledgeCardRepository, "getStatusCounts" | "getOutboxStatusCounts">;
  createApprovalInteractionQueue?: (input: {
    client: RedisApprovalInteractionQueueClient;
  }) => Pick<ApprovalInteractionQueue, "getCounts">;
  onStartupCleanup?: (cleanup: Promise<void>) => void;
};

export function createKnowledgeCardStatusReader({
  env = process.env,
  dependencies = {},
}: {
  env?: EnvLike;
  dependencies?: KnowledgeCardStatusReaderDependencies;
} = {}): KnowledgeCardStatusReader | undefined {
  const config = readKnowledgeCardStatusResourceConfig(env);
  if (config === undefined) return undefined;
  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createRedis = dependencies.createRedisClient ??
    ((url: string) => createClient({ url }) as unknown as KnowledgeCardStatusRedisClient);
  const createRepository = dependencies.createKnowledgeCardRepository ??
    createPostgresKnowledgeCardRepository;
  const createQueue = dependencies.createApprovalInteractionQueue ??
    createRedisApprovalInteractionQueue;

  let pool: KnowledgeCardPool | undefined;
  let redisClient: KnowledgeCardStatusRedisClient | undefined;
  let closeRedis: (() => Promise<void>) | undefined;
  try {
    pool = createPool({ databaseUrl: config.databaseUrl });
    redisClient = createRedis(config.redisUrl);
    let lifecycle: "idle" | "connecting" | "ready" | "failed" | "closing" | "closed" =
      "idle";
    let transportAttemptPending = false;
    let redisConnection: Promise<KnowledgeCardStatusRedisClient> | undefined;
    let redisConnectOutcomeSettlement: Promise<void> | undefined;
    let rejectClosedConnection!: (error: Error) => void;
    const closedConnection = observeStartupPromise(new Promise<never>((_resolve, reject) => {
      rejectClosedConnection = reject;
    }));
    let destroyAttempted = false;
    let destroyError: unknown;
    let awaitConnectSettlementAfterDestroy = false;
    let resolveDestroyed!: () => void;
    const destroyed = new Promise<void>((resolve) => {
      resolveDestroyed = resolve;
    });
    let resolveReconnectObserved!: () => void;
    const reconnectObserved = new Promise<void>((resolve) => {
      resolveReconnectObserved = resolve;
    });
    const destroyIfOpen = () => {
      if (!redisClient!.isOpen) return;
      if (destroyAttempted) {
        throw new Error("knowledge-card status Redis client remained open after destroy");
      }
      destroyAttempted = true;
      try {
        redisClient!.destroy();
      } catch (error) {
        if (error instanceof ClientClosedError && !redisClient!.isOpen) {
          resolveDestroyed();
          return;
        }
        throw error;
      }
      if (redisClient!.isOpen) {
        throw new Error("knowledge-card status Redis client remained open after destroy");
      }
      resolveDestroyed();
    };
    redisClient.on?.("error", () => {
      transportAttemptPending = false;
      if (lifecycle !== "closing" && lifecycle !== "closed") return;
      awaitConnectSettlementAfterDestroy = true;
      try {
        destroyIfOpen();
      } catch (error) {
        destroyError = error;
      }
    });
    redisClient.on?.("reconnecting", () => {
      resolveReconnectObserved();
      if (lifecycle === "closing" || lifecycle === "closed") return;
      transportAttemptPending = true;
    });
    redisClient.on?.("connect", () => {
      transportAttemptPending = false;
      if (lifecycle !== "closing" && lifecycle !== "closed") return;
      // node-redis emits `connect` immediately before it queues protocol startup
      // commands. Let that stack finish so destroy() can reject those commands too.
      queueMicrotask(() => {
        if (lifecycle !== "closing" && lifecycle !== "closed") return;
        try {
          destroyIfOpen();
        } catch (error) {
          destroyError = error;
        }
      });
    });
    const getRedisClient = (): Promise<KnowledgeCardStatusRedisClient> => {
      if (lifecycle === "closing" || lifecycle === "closed") {
        return observeStartupPromise(Promise.reject(
          new Error("knowledge-card status Redis client is closed"),
        ));
      }
      if (redisConnection !== undefined) return redisConnection;
      lifecycle = "connecting";
      transportAttemptPending = true;
      let connectResult: Promise<unknown>;
      try {
        connectResult = redisClient!.connect();
      } catch (error) {
        connectResult = Promise.reject(error);
      }
      const connectOutcome = observeStartupPromise(Promise.resolve(connectResult).then(
        () => {
          if (lifecycle === "closing" || lifecycle === "closed") {
            throw new Error("knowledge-card status Redis client closed during connect");
          }
          lifecycle = "ready";
          return redisClient!;
        },
        (error: unknown) => {
          if (lifecycle !== "closing" && lifecycle !== "closed") lifecycle = "failed";
          throw error;
        },
      ));
      redisConnectOutcomeSettlement = connectOutcome.then(
        () => undefined,
        () => undefined,
      );
      redisConnection = observeStartupPromise(Promise.race([connectOutcome, closedConnection]));
      return redisConnection;
    };
    closeRedis = async () => {
      const connectionWasStarting = lifecycle === "connecting";
      const connectionWasInRetryBackoff = connectionWasStarting && !transportAttemptPending;
      const transportTerminalPending = connectionWasStarting && transportAttemptPending;
      lifecycle = "closing";
      rejectClosedConnection(new Error("knowledge-card status Redis client is closed"));
      if (connectionWasInRetryBackoff) awaitConnectSettlementAfterDestroy = true;
      if (!transportTerminalPending) destroyIfOpen();
      if (redisConnectOutcomeSettlement !== undefined && !destroyAttempted) {
        await Promise.race([redisConnectOutcomeSettlement, destroyed]);
      }
      if (redisConnectOutcomeSettlement !== undefined && transportTerminalPending &&
        destroyAttempted && !awaitConnectSettlementAfterDestroy) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const reconnectBound = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STATUS_REDIS_INITIAL_RECONNECT_BOUND_MS);
          timer.unref();
        });
        try {
          await Promise.race([
            redisConnectOutcomeSettlement,
            reconnectObserved,
            reconnectBound,
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      if (redisConnectOutcomeSettlement !== undefined &&
        awaitConnectSettlementAfterDestroy) {
        await redisConnectOutcomeSettlement;
      }
      if (destroyError !== undefined) throw destroyError;
      destroyIfOpen();
      lifecycle = "closed";
    };
    const queue = createQueue({ client: createDeferredRedisQueueClient(getRedisClient) });
    const repository = createRepository({ dataSource: pool });
    let closePromise: Promise<void> | undefined;
    return {
      async getStatus() {
        const [queueCounts, presentations, outbox] = await Promise.all([
          queue.getCounts(),
          repository.getStatusCounts(),
          repository.getOutboxStatusCounts(),
        ]);
        return {
          enabled: false,
          running: false,
          enabledGroupCount: 0,
          queue: queueCounts,
          presentations,
          outbox,
        };
      },
      close() {
        closePromise ??= observeStartupPromise(closeRuntimeResources([
          () => closeRedis!(),
          () => pool!.end(),
        ]));
        return closePromise;
      },
    };
  } catch (error) {
    const cleanup = observeStartupPromise(closeRuntimeResources([
      ...(closeRedis === undefined
        ? []
        : [() => closeRedis!()]),
      ...(pool === undefined ? [] : [() => pool!.end()]),
    ]));
    dependencies.onStartupCleanup?.(cleanup);
    throw error;
  }
}

export function createKnowledgeCardRuntime({
  env = process.env,
  runtimeController,
  proactiveSignalRepository,
  dependencies = {},
}: {
  env?: EnvLike;
  runtimeController?: KnowledgeCardRuntimeGate;
  proactiveSignalRepository?: ProactiveSignalRepository;
  dependencies?: KnowledgeCardRuntimeDependencies;
} = {}): KnowledgeCardRuntime | undefined {
  const config = readKnowledgeCardRuntimeConfig(env);
  if (!config.enabled) return undefined;
  if (runtimeController === undefined) {
    throw new Error("runtimeController is required when knowledge cards are enabled");
  }

  const feishuConfig = readFeishuOpenApiConfig(env);
  const feishuAuthConfig = readFeishuAuthConfig(env);
  const proactiveFeedbackConfig = readProactiveFeedbackConfig(env);
  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createRedis = dependencies.createRedisClient ??
    ((url: string) => createClient({ url }) as unknown as KnowledgeCardRedisClient);
  const createDrafts = dependencies.createKnowledgeDraftRepository ??
    createPostgresKnowledgeDraftRepository;
  const createRepository = dependencies.createKnowledgeCardRepository ??
    createPostgresKnowledgeCardRepository;
  const createQueue = dependencies.createApprovalInteractionQueue ??
    createRedisApprovalInteractionQueue;
  const createIntentStore = dependencies.createApprovalInteractionIntentStore ??
    createPostgresApprovalInteractionIntentStore;
  const createCallbackIdentityStore = dependencies.createKnowledgeConflictCallbackIdentityStore ??
    createPostgresKnowledgeConflictCallbackIdentityStore;
  const createInteractionWorker = dependencies.createInteractionWorker ??
    createApprovalInteractionWorker;
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
    const intentStore = createIntentStore({ dataSource: pool });
    const callbackIdentityStore = createCallbackIdentityStore({ dataSource: pool });
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
    const proactiveSignalFeedbackWorker = proactiveSignalRepository === undefined
      ? undefined
      : createProactiveSignalFeedbackWorker({
          repository: proactiveSignalRepository,
          membershipChecker,
          canProactivelySpeak: (groupId) => runtimeController.canProactivelySpeak(groupId),
          botOpenId: config.botOpenId,
          suppressionDays: proactiveFeedbackConfig.suppressionDays,
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
    let boundActionApprovalWorker:
      | NonNullable<ApprovalInteractionWorkerDependencies["actionApprovalWorker"]>
      | undefined;
    let boundKnowledgeConflictInteractionWorker:
      | NonNullable<ApprovalInteractionWorkerDependencies["knowledgeConflictInteractionWorker"]>
      | undefined;
    const actionApprovalWorker: NonNullable<
      ApprovalInteractionWorkerDependencies["actionApprovalWorker"]
    > = {
      processActionApproval(job, intent) {
        return boundActionApprovalWorker?.processActionApproval(job, intent) ?? Promise.resolve({
          status: "denied" as const,
          code: "runtime_disabled" as const,
        });
      },
    };
    const knowledgeConflictInteractionWorker: NonNullable<
      ApprovalInteractionWorkerDependencies["knowledgeConflictInteractionWorker"]
    > = {
      processInteraction(job) {
        return boundKnowledgeConflictInteractionWorker?.processInteraction(job) ?? Promise.resolve({
          status: "denied" as const,
          code: "runtime_disabled" as const,
        });
      },
    };
    const interactionWorker = createInteractionWorker({
      queue,
      repository,
      membershipChecker,
      cardClient,
      canUseKnowledgeCards,
      botOpenId: config.botOpenId,
      workerId: INTERACTION_WORKER_ID,
      leaseMs: EXTERNAL_LEASE_MS,
      intentStore,
      callbackIdentityStore,
      actionApprovalWorker,
      proactiveSignalFeedbackWorker,
      knowledgeConflictInteractionWorker,
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
      requireFreshTimestamp: false,
    });
    const verifyFeishuEnvelopeWithDiagnostics = (request: FeishuCardActionCallbackRequest): boolean => {
      const verified = verifyFeishuEnvelope(request);
      if (!verified) {
        const diagnostic = diagnoseFeishuCallbackAuthentication({
          request,
          verificationToken: feishuAuthConfig.verificationToken,
          encryptKey: feishuAuthConfig.encryptKey,
          now: new Date(),
        });
        (dependencies.onCardAuthenticationDiagnostic ?? reportCardAuthenticationDiagnostic)(diagnostic);
      }
      return verified;
    };
    const gateway = createFeishuCardActionGateway({
      queue,
      intentStore,
      callbackIdentityStore,
      verifyRequest: verifyFeishuEnvelopeWithDiagnostics,
      allowUnsignedEncryptedUrlVerification: feishuAuthConfig.encryptKey !== undefined,
      onDiagnostic: dependencies.onCardCallbackDiagnostic ?? reportCardCallbackDiagnostic,
      decodeRequest(request) {
        const body = decodeFeishuPayload(request.body, feishuAuthConfig.encryptKey);
        return body === undefined ? undefined : { ...request, body };
      },
      verifyDecodedRequest(request) {
        return feishuAuthConfig.verificationToken !== undefined &&
          verifyFeishuVerificationToken(request.body, feishuAuthConfig.verificationToken) &&
          (isFeishuUrlVerificationPayload(request.body) ||
            (readCallbackAppId(request) === feishuConfig.appId &&
              verifyFreshFeishuCallbackPayload(request.body, new Date())));
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
      approvalInteractions: { cardClient, membershipChecker, botOpenId: config.botOpenId },
      bindActionApprovalWorker(worker) {
        if (boundActionApprovalWorker !== undefined) {
          throw new Error("action approval worker is already bound");
        }
        if (lifecycle !== "idle") {
          throw new Error("action approval worker must be bound before runtime start");
        }
        boundActionApprovalWorker = worker;
      },
      bindKnowledgeConflictInteractionWorker(worker) {
        if (boundKnowledgeConflictInteractionWorker !== undefined) {
          throw new Error("knowledge conflict interaction worker is already bound");
        }
        if (lifecycle !== "idle") {
          throw new Error("knowledge conflict interaction worker must be bound before runtime start");
        }
        boundKnowledgeConflictInteractionWorker = worker;
      },
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

function reportCardCallbackDiagnostic(diagnostic: FeishuCardActionCallbackDiagnostic): void {
  console.info(JSON.stringify({
    event: "feishu_card_callback",
    ...diagnostic,
  }));
}

function reportCardAuthenticationDiagnostic(
  diagnostic: FeishuCallbackAuthenticationDiagnostic,
): void {
  console.info(JSON.stringify({
    event: "feishu_card_authentication",
    ...diagnostic,
  }));
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

function createDeferredRedisQueueClient(
  getRedisClient: () => Promise<KnowledgeCardStatusRedisClient>,
): RedisApprovalInteractionQueueClient {
  return {
    async eval(script, options) {
      const redis = await getRedisClient();
      return redis.eval(script, options);
    },
  };
}

function readKnowledgeCardStatusResourceConfig(
  env: EnvLike,
): { databaseUrl: string; redisUrl: string } | undefined {
  const databaseUrl = env.DATABASE_URL?.trim();
  const redisUrl = env.REDIS_URL?.trim();
  if (!databaseUrl || !redisUrl) return undefined;
  let parsedRedisUrl: URL;
  const databaseConfig = readDatabaseConfig(env);
  try {
    parsedRedisUrl = new URL(redisUrl);
  } catch {
    throw new Error("REDIS_URL must be a redis URL");
  }
  if (parsedRedisUrl.protocol !== "redis:" && parsedRedisUrl.protocol !== "rediss:") {
    throw new Error("REDIS_URL must be a redis URL");
  }
  return { databaseUrl: databaseConfig.databaseUrl, redisUrl };
}

function readCallbackAppId(request: FeishuCardActionCallbackRequest): string | undefined {
  if (!isRecord(request.body) || !isRecord(request.body.header)) return undefined;
  const appId = request.body.header.app_id;
  return typeof appId === "string" ? appId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
