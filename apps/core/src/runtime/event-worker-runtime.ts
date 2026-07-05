import { createClient } from "redis";
import type pg from "pg";

import {
  readEventWorkerRuntimeConfig,
  readOptionalFeishuBotOpenId,
  readOptionalFeishuOpenApiConfig,
  type EnvLike,
  type EventWorkerRuntimeConfig,
} from "../config/env.js";
import type { AnswerDraftOrchestrator } from "../agent/answer-draft-orchestrator.js";
import {
  createFeishuMentionAnswerResponder,
  type FeishuMentionAnswerResponder,
} from "../conversation/feishu-mention-answer-responder.js";
import { createFeishuMessageEventProcessor } from "../conversation/feishu-message-event-processor.js";
import {
  createPostgresConversationMessageRepository,
  type Queryable,
} from "../conversation/postgres-conversation-message-repository.js";
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import { createDiscoveredDocumentSyncPlanner } from "../documents/discovered-document-sync-planner.js";
import type { DocumentSyncQueue } from "../documents/document-sync-queue.js";
import { createFeishuDocumentLinkExtractor } from "../documents/feishu-document-link-extractor.js";
import {
  createFeishuMessageReplier,
  type FeishuMessageReplier,
} from "../feishu/feishu-message-replier.js";
import {
  createFeishuTenantAccessTokenProvider,
  type FeishuTenantAccessTokenProvider,
} from "../feishu/feishu-tenant-access-token-provider.js";
import { createGroupVisibleDocumentRegistrar } from "../documents/group-visible-document-registrar.js";
import {
  createPostgresDocumentSourceRegistry,
  type AsyncDocumentSourceRegistry,
} from "../documents/postgres-document-source-registry.js";
import {
  createRedisDocumentSyncQueue,
  type RedisDocumentSyncQueueClient,
} from "../documents/redis-document-sync-queue.js";
import {
  createRedisRawEventQueue,
  type RedisRawEventQueueClient,
} from "../events/redis-raw-event-queue.js";
import type {
  RawEventDeadLetter,
  RawEventQueue,
  ReplayRawEventDeadLettersResult,
} from "../events/raw-event-queue.js";
import { createRawEventWorker } from "../events/raw-event-worker.js";
import {
  createRawEventWorkerLoop,
  type RawEventWorkerBatchSnapshot,
  type RawEventWorkerLoop,
} from "../events/raw-event-worker-loop.js";
import { closeRuntimeResources } from "./runtime-close.js";
import { observeStartupPromise } from "./startup-promise.js";

export type EventWorkerRuntime = {
  rawEventQueue?: Pick<RawEventQueue, "enqueue">;
  deadLetters: {
    list(input: { limit: number }): Promise<RawEventDeadLetter[]>;
    replay(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item">;
    delete(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item">;
    replayBatch(input: { ids: string[] }): Promise<ReplayRawEventDeadLettersResult>;
  };
  getStatus(): Promise<EventWorkerRuntimeStatus>;
  start(): void;
  close(): Promise<void>;
};

export type EventWorkerRuntimeStatus = {
  enabled: true;
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  mentionRepliesEnabled: boolean;
  mentionRepliesUnavailableReason?: MentionReplyUnavailableReason;
  pendingEventCount: number;
  deadLetterEventCount: number;
  latestBatch?: RawEventWorkerBatchSnapshot;
};
export type MentionReplyUnavailableReason =
  | "missing_bot_open_id"
  | "missing_feishu_openapi_config"
  | "missing_answer_draft_orchestrator";

type RedisClient = RedisRawEventQueueClient & RedisDocumentSyncQueueClient & {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
};
type PostgresPool = Queryable & { end(): Promise<void> };
type RuntimeGate = {
  canProcessIncomingEvent(input: { groupId?: string }): boolean;
  canReadGroupContext(groupId: string): boolean;
  canReadDocuments(): boolean;
  canReplyWhenMentioned?(groupId: string): boolean;
};
type GroupVisibleDocumentRegistry = Pick<
  AsyncDocumentSourceRegistry,
  "registerGroupVisibleDocument"
>;

export type EventWorkerRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => PostgresPool;
  createRedisClient?: (url: string) => RedisClient;
  createConversationMessageRepository?: typeof createPostgresConversationMessageRepository;
  createDocumentSourceRegistry?: (pool: PostgresPool) => GroupVisibleDocumentRegistry;
  createDocumentLinkExtractor?: typeof createFeishuDocumentLinkExtractor;
  createDocumentSyncQueue?: (
    client: RedisDocumentSyncQueueClient,
  ) => Pick<DocumentSyncQueue, "enqueue">;
  createDiscoveredDocumentSyncPlanner?: typeof createDiscoveredDocumentSyncPlanner;
  createGroupVisibleDocumentRegistrar?: typeof createGroupVisibleDocumentRegistrar;
  createFeishuTenantAccessTokenProvider?: typeof createFeishuTenantAccessTokenProvider;
  createFeishuMessageReplier?: typeof createFeishuMessageReplier;
  createMentionAnswerResponder?: typeof createFeishuMentionAnswerResponder;
  createProcessor?: typeof createFeishuMessageEventProcessor;
  createWorkerLoop?: typeof createRawEventWorkerLoop;
};

export function createEventWorkerRuntime({
  env = process.env,
  dependencies = {},
  runtimeController,
  answerDraftOrchestrator,
}: {
  env?: EnvLike;
  dependencies?: EventWorkerRuntimeDependencies;
  runtimeController?: RuntimeGate;
  answerDraftOrchestrator?: Pick<AnswerDraftOrchestrator, "generateDraft">;
} = {}): EventWorkerRuntime | undefined {
  const runtimeConfig = readEventWorkerRuntimeConfig(env);
  if (!runtimeConfig.enabled) {
    return undefined;
  }

  return createEnabledEventWorkerRuntime({
    env,
    runtimeConfig,
    dependencies,
    runtimeController,
    answerDraftOrchestrator,
  });
}

function createEnabledEventWorkerRuntime({
  env,
  runtimeConfig,
  dependencies,
  runtimeController,
  answerDraftOrchestrator,
}: {
  env: EnvLike;
  runtimeConfig: Extract<EventWorkerRuntimeConfig, { enabled: true }>;
  dependencies: EventWorkerRuntimeDependencies;
  runtimeController: RuntimeGate | undefined;
  answerDraftOrchestrator: Pick<AnswerDraftOrchestrator, "generateDraft"> | undefined;
}): EventWorkerRuntime {
  const createRedis =
    dependencies.createRedisClient ??
    ((url: string) => createClient({ url }) as unknown as RedisClient);
  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createMessages =
    dependencies.createConversationMessageRepository ??
    createPostgresConversationMessageRepository;
  const createDocumentSources =
    dependencies.createDocumentSourceRegistry ?? createDefaultDocumentSourceRegistry;
  const createDocumentLinkExtractor =
    dependencies.createDocumentLinkExtractor ?? createFeishuDocumentLinkExtractor;
  const createDocumentSyncQueue =
    dependencies.createDocumentSyncQueue ??
    ((client: RedisDocumentSyncQueueClient) => createRedisDocumentSyncQueue({ client }));
  const createDiscoveredSyncPlanner =
    dependencies.createDiscoveredDocumentSyncPlanner ?? createDiscoveredDocumentSyncPlanner;
  const createGroupVisibleRegistrar =
    dependencies.createGroupVisibleDocumentRegistrar ?? createGroupVisibleDocumentRegistrar;
  const createTokenProvider =
    dependencies.createFeishuTenantAccessTokenProvider ?? createFeishuTenantAccessTokenProvider;
  const createMessageReplier =
    dependencies.createFeishuMessageReplier ?? createFeishuMessageReplier;
  const createMentionResponder =
    dependencies.createMentionAnswerResponder ?? createFeishuMentionAnswerResponder;
  const createProcessor = dependencies.createProcessor ?? createFeishuMessageEventProcessor;
  const createLoop = dependencies.createWorkerLoop ?? createRawEventWorkerLoop;

  const pool = createPool(readDatabaseConfig(env));
  const redis = createRedis(runtimeConfig.redisUrl);
  const redisConnection = observeStartupPromise(redis.connect().then(() => redis));
  const messages = createMessages({ queryable: pool });
  const documentSources = createDocumentSources(pool);
  const documentLinkExtractor = createDocumentLinkExtractor();
  const documentSyncQueue = createDocumentSyncQueue(
    createLazyRedisDocumentSyncQueueClient(redisConnection),
  );
  const syncPlanner = createDiscoveredSyncPlanner({ queue: documentSyncQueue });
  const groupVisibleDocumentRegistrar = createGroupVisibleRegistrar({
    registry: documentSources,
    syncPlanner,
  });
  const mentionAnswerReadiness = createOptionalMentionAnswerResponder({
    env,
    answerDraftOrchestrator,
    runtimeController,
    createTokenProvider,
    createMessageReplier,
    createMentionResponder,
  });
  const mentionAnswerResponder = mentionAnswerReadiness.responder;
  const processor = createProcessor({
    messages,
    documentLinkExtractor,
    groupVisibleDocumentRegistrar,
    ...(mentionAnswerResponder === undefined ? {} : { mentionAnswerResponder }),
    ...(runtimeController === undefined ? {} : { runtimeController }),
  });
  const queue = createRedisRawEventQueue({
    client: createLazyRedisQueueClient(redisConnection),
  });
  const worker = createRawEventWorker({
    queue,
    processor,
  });
  const loop: RawEventWorkerLoop = createLoop({
    worker,
    intervalMs: runtimeConfig.intervalMs,
    batchLimit: runtimeConfig.batchLimit,
    onError: () => undefined,
  });

  return {
    rawEventQueue: queue,
    deadLetters: {
      list(input) {
        return queue.listDeadLetters(input);
      },
      replay(id) {
        return queue.replayDeadLetter(id);
      },
      delete(id) {
        return queue.deleteDeadLetter(id);
      },
      replayBatch(input) {
        return queue.replayDeadLetters(input);
      },
    },
    start() {
      loop.start();
    },
    async getStatus() {
      const loopSnapshot = loop.getSnapshot();
      const pendingEventCount = await queue.getPendingCount();
      const deadLetterEventCount = await queue.getDeadLetterCount();

      return {
        enabled: true,
        running: loopSnapshot.running,
        intervalMs: loopSnapshot.intervalMs,
        batchLimit: loopSnapshot.batchLimit,
        mentionRepliesEnabled: mentionAnswerResponder !== undefined,
        ...(mentionAnswerReadiness.unavailableReason === undefined
          ? {}
          : { mentionRepliesUnavailableReason: mentionAnswerReadiness.unavailableReason }),
        pendingEventCount,
        deadLetterEventCount,
        ...(loopSnapshot.latestBatch === undefined
          ? {}
          : { latestBatch: loopSnapshot.latestBatch }),
      };
    },
    async close() {
      await closeRuntimeResources([
        () => loop.stop(),
        async () => {
          const client = await redisConnection;
          await client.quit();
        },
        () => pool.end(),
      ]);
    },
  };
}

function createOptionalMentionAnswerResponder({
  env,
  answerDraftOrchestrator,
  runtimeController,
  createTokenProvider,
  createMessageReplier,
  createMentionResponder,
}: {
  env: EnvLike;
  answerDraftOrchestrator: Pick<AnswerDraftOrchestrator, "generateDraft"> | undefined;
  runtimeController: RuntimeGate | undefined;
  createTokenProvider: typeof createFeishuTenantAccessTokenProvider;
  createMessageReplier: typeof createFeishuMessageReplier;
  createMentionResponder: typeof createFeishuMentionAnswerResponder;
}): {
  responder?: Pick<FeishuMentionAnswerResponder, "maybeRespond">;
  unavailableReason?: MentionReplyUnavailableReason;
} {
  const botOpenId = readOptionalFeishuBotOpenId(env);
  if (botOpenId === undefined) {
    return { unavailableReason: "missing_bot_open_id" };
  }

  const feishuConfig = readOptionalFeishuOpenApiConfig(env);
  if (feishuConfig === undefined) {
    return { unavailableReason: "missing_feishu_openapi_config" };
  }
  if (answerDraftOrchestrator === undefined) {
    return { unavailableReason: "missing_answer_draft_orchestrator" };
  }

  const tokenProvider: FeishuTenantAccessTokenProvider = createTokenProvider({
    baseUrl: feishuConfig.baseUrl,
    appId: feishuConfig.appId,
    appSecret: feishuConfig.appSecret,
    timeoutMs: feishuConfig.documentFetchTimeoutMs,
  });
  const replier: FeishuMessageReplier = createMessageReplier({
    baseUrl: feishuConfig.baseUrl,
    tokenProvider,
    timeoutMs: feishuConfig.documentFetchTimeoutMs,
  });

  return {
    responder: createMentionResponder({
      botOpenId,
      answerDraftOrchestrator,
      replier,
      ...(runtimeController?.canReplyWhenMentioned === undefined
        ? {}
        : { canReplyWhenMentioned: runtimeController.canReplyWhenMentioned.bind(runtimeController) }),
    }),
  };
}

function createDefaultDocumentSourceRegistry(pool: PostgresPool): GroupVisibleDocumentRegistry {
  return createPostgresDocumentSourceRegistry(pool as unknown as pg.Pool);
}

function createLazyRedisDocumentSyncQueueClient(
  redisConnection: Promise<RedisClient>,
): RedisDocumentSyncQueueClient {
  return {
    async eval(script, options) {
      const client = await redisConnection;
      return client.eval(script, options);
    },
    async rPush(key, value) {
      const client = await redisConnection;
      return client.rPush(key, value);
    },
    async lPop(key) {
      const client = await redisConnection;
      return client.lPop(key);
    },
    async lLen(key) {
      const client = await redisConnection;
      return client.lLen(key);
    },
    async lRange(key, start, stop) {
      const client = await redisConnection;
      return client.lRange(key, start, stop);
    },
    async lRem(key, count, value) {
      const client = await redisConnection;
      return client.lRem(key, count, value);
    },
    async sRem(key, member) {
      const client = await redisConnection;
      return client.sRem(key, member);
    },
  };
}

function createLazyRedisQueueClient(
  redisConnection: Promise<RedisClient>,
): RedisRawEventQueueClient {
  return {
    async eval(script, options) {
      const client = await redisConnection;
      return client.eval(script, options);
    },
    async rPush(key, value) {
      const client = await redisConnection;
      return client.rPush(key, value);
    },
    async lPop(key) {
      const client = await redisConnection;
      return client.lPop(key);
    },
    async lLen(key) {
      const client = await redisConnection;
      return client.lLen(key);
    },
    async lRange(key, start, stop) {
      const client = await redisConnection;
      return client.lRange(key, start, stop);
    },
    async lRem(key, count, value) {
      const client = await redisConnection;
      return client.lRem(key, count, value);
    },
    async sRem(key, member) {
      const client = await redisConnection;
      return client.sRem(key, member);
    },
  };
}
