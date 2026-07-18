import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { installGracefulShutdown } from "./runtime/graceful-shutdown.js";
import {
  InMemoryAuditLog,
  type AuditEvent,
  type AuditEventSummary,
  type AuditEventSummaryQuery,
  type RecordedAuditEvent,
} from "./audit/audit-log.js";
import {
  createFeishuGateway,
  type FeishuCallbackRequest
} from "./feishu/feishu-gateway.js";
import { readFeishuAuthConfig, readServerPort, type EnvLike } from "./config/env.js";
import {
  RuntimeController,
  type RuntimeCapabilityName
} from "./admin/runtime-controller.js";
import {
  createInMemoryRuntimeControlService,
  RuntimeControlInputError,
  type RuntimeControlMutationResult,
  type RuntimeControlService,
  type RuntimeControlStatus,
} from "./admin/runtime-control-service.js";
import { normalizeInternalStatusErrorMessage } from "./admin/internal-status-error-message.js";
import { createDefaultRuntimeConfig } from "./config/runtime-config.js";
import { createFeishuRequestVerifier } from "./feishu/feishu-auth.js";
import type { EventQueue } from "./queues/event-queue.js";
import { InMemoryEventQueue } from "./queues/in-memory-event-queue.js";
import type { RawEventQueue } from "./events/raw-event-queue.js";
import type { AnswerDraftOrchestrator } from "./agent/answer-draft-orchestrator.js";
import type { LiveChatMessage } from "./memory/context-assembly.js";
import {
  createAnswerDraftRuntime as createDefaultAnswerDraftRuntime,
  type AnswerDraftRuntime
} from "./runtime/answer-draft-runtime.js";
import {
  createEventWorkerRuntime,
  type EventWorkerRuntime
} from "./runtime/event-worker-runtime.js";
import {
  createReindexWorkerRuntime,
  type ReindexWorkerRuntime
} from "./runtime/reindex-worker-runtime.js";
import {
  createDocumentSyncRuntime,
  type DocumentSyncRuntime
} from "./runtime/document-sync-runtime.js";
import {
  createMemoryExtractionRuntime,
  type MemoryExtractionRuntime,
  type MemoryExtractionRuntimeStatus,
} from "./runtime/memory-extraction-runtime.js";
import type {
  MemoryExtractionDeadLetter,
} from "./memory-extraction/memory-extraction-queue.js";
import {
  createRuntimeControlRuntime as createDefaultRuntimeControlRuntime,
  type RuntimeControlRuntime,
} from "./runtime/runtime-control-runtime.js";
import {
  DOCUMENT_SOURCE_URI_MAX_CHARS,
  type DocumentSourceType,
} from "./documents/document-source-registry.js";
import type { DocumentSnapshot } from "./documents/document-snapshot-repository.js";
import {
  normalizeFeishuDocumentSourceUri,
} from "./documents/feishu-document-body-fetcher.js";
import { buildInternalStatusSnapshot } from "./admin/internal-status-snapshot.js";
import { buildInternalRolloutReadinessReport } from "./admin/internal-rollout-readiness.js";
import { registerGroupMemoryApi } from "./memory/group-memory-api.js";
import type { GroupMemoryService } from "./memory/group-memory-service.js";
import {
  createConversationStateInspectionRuntime,
  registerConversationStateApi,
  type ConversationStateInspectionRuntime,
  type ConversationStateInspectionStore,
} from "./conversation-state/conversation-state-api.js";
import { registerProactiveSignalApi } from "./proactive/proactive-signal-api.js";
import {
  createProactiveSignalRuntime,
  type ProactiveSignalRuntime,
} from "./runtime/proactive-signal-runtime.js";

type EventWorkerRuntimeFactoryInput = {
  runtimeController?: RuntimeController;
  answerDraftOrchestrator?: Pick<AnswerDraftOrchestrator, "generateDraft">;
  memoryExtractionPlanner?: MemoryExtractionRuntime["planner"];
};

type MemoryExtractionRuntimeFactoryInput = {
  runtimeController: RuntimeController;
  auditLog: InMemoryAuditLog;
};

type ProactiveSignalRuntimeFactoryInput = {
  runtimeController: RuntimeController;
};

export type RuntimeControlDependency = {
  controller: RuntimeController;
  service: RuntimeControlService;
};

export type BuildAppDependencies = {
  queue?: EventQueue;
  rawEventQueue?: Pick<RawEventQueue, "enqueue"> &
    Partial<Pick<RawEventQueue, "getPendingCount">>;
  verifyFeishuRequest?: (request: FeishuCallbackRequest) => Promise<boolean> | boolean;
  onFeishuGatewayEnqueueError?: (error: unknown) => void;
  answerDraftOrchestrator?: Pick<AnswerDraftOrchestrator, "generateDraft">;
  auditLog?: InMemoryAuditLog;
  now?: () => Date;
  createAnswerDraftRuntime?: (
    input?: Parameters<typeof createDefaultAnswerDraftRuntime>[0],
  ) => AnswerDraftRuntime | undefined;
  createEventWorkerRuntime?: (input?: EventWorkerRuntimeFactoryInput) => EventWorkerRuntime | undefined;
  createMemoryExtractionRuntime?: (
    input?: MemoryExtractionRuntimeFactoryInput,
  ) => MemoryExtractionRuntime | undefined;
  createReindexWorkerRuntime?: () => ReindexWorkerRuntime | undefined;
  createDocumentSyncRuntime?: () => DocumentSyncRuntime | undefined;
  runtimeController?: RuntimeController;
  runtimeControl?: RuntimeControlDependency;
  closeRuntimeControl?: () => Promise<void>;
  onRuntimeStartupCleanup?: (cleanup: Promise<void>) => void;
  onBeforeRuntimeCloseOwnership?: (app: FastifyInstance) => void;
  internalApiToken?: string;
  ingressHealthToken?: string;
  readinessEnv?: EnvLike;
  groupMemoryService?: GroupMemoryService;
  conversationStateInspectionStore?: ConversationStateInspectionStore;
  createConversationStateInspectionRuntime?: () => ConversationStateInspectionRuntime | undefined;
  createProactiveSignalRuntime?: (
    input: ProactiveSignalRuntimeFactoryInput,
  ) => ProactiveSignalRuntime | undefined;
};

export type StartServerOptions = {
  appDependencies?: Omit<
    BuildAppDependencies,
    | "internalApiToken"
    | "readinessEnv"
    | "runtimeController"
    | "runtimeControl"
    | "closeRuntimeControl"
    | "onRuntimeStartupCleanup"
  >;
  createRuntimeControlRuntime?: () => Promise<RuntimeControlRuntime>;
};

type ParsedJsonBody = {
  parsedBody: unknown;
  rawBody: string;
};

type AnswerDraftRequest = {
  question: string;
  chatId?: string;
  liveChatMessages: LiveChatMessage[];
  fragmentLimit?: number;
  liveChatLimit?: number;
};

type ReindexDocumentProfileRequest = {
  embeddingProfileId: string;
  limit: number;
};

type DeadLetterBatchReplayRequest = {
  ids: string[];
};

type RegisterAuthorizedWikiDocumentRequest = {
  sourceUri: string;
  title?: string;
  authorizedSpaceId: string;
};

type RegisterUserSubmittedDocumentRequest = {
  sourceUri: string;
  title?: string;
  submittedByUserId: string;
};

type DocumentSourceListQuery = {
  limit: number;
  sourceType?: DocumentSourceType;
  groupId?: string;
  authorizedSpaceId?: string;
  submittedByUserId?: string;
  usableForAnswering?: boolean;
  includeLatestSnapshot?: true;
};

type DocumentSourcePolicyUpdateRequest = {
  canUseForAnswering?: boolean;
  canUseForKnowledgeDrafts?: boolean;
};
type RuntimeCapabilityUpdateRequest = Partial<Record<RuntimeCapabilityName, boolean>>;
type FeishuGatewayEnqueueErrorSnapshot = {
  message: string;
  recordedAt: string;
};
type FeishuGatewayStatusState = {
  enqueueFailureCount: number;
  latestEnqueueError?: FeishuGatewayEnqueueErrorSnapshot;
};

const runtimeCapabilityNames = new Set<RuntimeCapabilityName>([
  "readGroupContext",
  "replyWhenMentioned",
  "readGroupDocuments",
  "retrieveKnowledgeBase",
  "proactiveSpeech",
  "generateKnowledgeDrafts",
  "writeKnowledgeBase",
  "callExternalTools",
]);
const deadLettersPresentReason = "dead_letters_present" as const;
const enqueueFailuresPresentReason = "enqueue_failures_present" as const;
const latestBatchFailedReason = "latest_batch_failed" as const;
const latestBatchItemsFailedReason = "latest_batch_items_failed" as const;
const mentionRepliesUnavailableReason = "mention_replies_unavailable" as const;
const aiWorkerUnavailableReason = "ai_worker_unavailable" as const;
const maxInternalStringLength = 512;
const maxInternalSourceUriLength = DOCUMENT_SOURCE_URI_MAX_CHARS;
const maxInternalRawSourceUriLength = 8192;
const maxReindexDocumentProfileLimit = 100;
const maxAnswerDraftQuestionLength = 4000;
const maxAnswerDraftLiveChatMessageInputCount = 50;
const maxAnswerDraftLiveChatSpeakerLength = 256;
const maxAnswerDraftLiveChatTextLength = 2000;
const maxJsonBodyBytes = 256 * 1024;
const internalTruncationMarker = " ... [truncated]";
const memoryExtractionFailureClassifications = new Set([
  "provider_timeout",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_unauthorized",
  "invalid_model_response",
  "invalid_queue_payload",
  "corrupt_routing",
  "invalid_dead_letter_payload",
  "invalid_dead_letter_json",
  "internal_error",
]);

export function buildApp(dependencies: BuildAppDependencies = {}) {
  const internalApiToken =
    readInternalApiToken(dependencies.internalApiToken) ??
    readInternalApiToken(process.env.IRIS_INTERNAL_API_TOKEN);
  const ingressHealthToken = readBearerToken(
    dependencies.ingressHealthToken ?? process.env.IRIS_INGRESS_HEALTH_TOKEN,
    "IRIS_INGRESS_HEALTH_TOKEN",
  );
  const queue = dependencies.queue ?? new InMemoryEventQueue();
  const auditLog = dependencies.auditLog ?? new InMemoryAuditLog();
  const now = dependencies.now ?? (() => new Date());
  if (
    dependencies.runtimeControl !== undefined &&
    dependencies.runtimeController !== undefined
  ) {
    throw new Error("runtimeControl cannot be combined with runtimeController");
  }
  const runtimeController =
    dependencies.runtimeControl?.controller ??
    dependencies.runtimeController ??
    new RuntimeController(createDefaultRuntimeConfig());
  const runtimeControlService =
    dependencies.runtimeControl?.service ??
    createInMemoryRuntimeControlService(runtimeController, now);
  let answerDraftRuntime: AnswerDraftRuntime | undefined;
  let answerDraftOrchestrator = dependencies.answerDraftOrchestrator;
  let reindexWorkerRuntime: ReindexWorkerRuntime | undefined;
  let memoryExtractionRuntime: MemoryExtractionRuntime | undefined;
  let eventWorkerRuntime: EventWorkerRuntime | undefined;
  let documentSyncRuntime: DocumentSyncRuntime | undefined;
  let conversationStateInspectionRuntime: ConversationStateInspectionRuntime | undefined;
  let proactiveSignalRuntime: ProactiveSignalRuntime | undefined;
  let startupGateway: Pick<ReturnType<typeof createFeishuGateway>, "close"> | undefined;
  let startupApp: FastifyInstance | undefined;
  let appOwnsRuntimeResources = false;
  try {
    answerDraftRuntime =
      answerDraftOrchestrator === undefined
        ? (dependencies.createAnswerDraftRuntime ?? createDefaultAnswerDraftRuntime)({
            dependencies: { auditLog },
            runtimeController,
          })
        : undefined;
    answerDraftOrchestrator ??= answerDraftRuntime?.answerDraftOrchestrator;
    const groupMemoryService =
      dependencies.groupMemoryService ?? answerDraftRuntime?.groupMemoryService;
    reindexWorkerRuntime =
      (dependencies.createReindexWorkerRuntime ?? createReindexWorkerRuntime)();
    reindexWorkerRuntime?.start();
    memoryExtractionRuntime =
      (dependencies.createMemoryExtractionRuntime ?? createMemoryExtractionRuntime)({
        runtimeController,
        auditLog,
      });
    memoryExtractionRuntime?.start();
    conversationStateInspectionRuntime = dependencies.conversationStateInspectionStore === undefined
      ? (dependencies.createConversationStateInspectionRuntime ?? createConversationStateInspectionRuntime)()
      : undefined;
    proactiveSignalRuntime = (
      dependencies.createProactiveSignalRuntime ?? createProactiveSignalRuntime
    )({ runtimeController });
    proactiveSignalRuntime?.start();
    eventWorkerRuntime =
      (dependencies.createEventWorkerRuntime ?? createEventWorkerRuntime)({
        runtimeController,
        ...(answerDraftOrchestrator === undefined
          ? {}
          : { answerDraftOrchestrator }),
        ...(memoryExtractionRuntime === undefined
          ? {}
          : { memoryExtractionPlanner: memoryExtractionRuntime.planner }),
      });
    eventWorkerRuntime?.start();
    documentSyncRuntime =
      (dependencies.createDocumentSyncRuntime ?? createDocumentSyncRuntime)();
    documentSyncRuntime?.start();
  const feishuAuthConfig = readFeishuAuthConfig();
  const verifyFeishuRequest =
    dependencies.verifyFeishuRequest ??
    (feishuAuthConfig.verificationToken || feishuAuthConfig.encryptKey
      ? createFeishuRequestVerifier(feishuAuthConfig)
      : undefined);
  const feishuGatewayStatus: FeishuGatewayStatusState = {
    enqueueFailureCount: 0,
  };
  const gateway = createFeishuGateway({
    queue,
    rawEventQueue: dependencies.rawEventQueue ?? eventWorkerRuntime?.rawEventQueue,
    verifyRequest: verifyFeishuRequest,
    onEnqueueError(error) {
      feishuGatewayStatus.enqueueFailureCount += 1;
      feishuGatewayStatus.latestEnqueueError = {
        message: normalizeInternalStatusErrorMessage(error),
        recordedAt: now().toISOString(),
      };
      dependencies.onFeishuGatewayEnqueueError?.(error);
    },
    runtimeController,
  });
  startupGateway = gateway;
  const app = Fastify({ logger: false, bodyLimit: maxJsonBodyBytes });
  startupApp = app;

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, payload, done) => {
    const rawBody = typeof payload === "string" ? payload : payload.toString("utf8");
    try {
      done(null, {
        parsedBody: JSON.parse(rawBody),
        rawBody
      });
    } catch (error) {
      done(createBadJsonError());
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!isInternalApiRequest(request.url)) {
      return;
    }

    if (internalApiToken === undefined && ingressHealthToken === undefined) {
      return;
    }

    const operatorAuthorized =
      internalApiToken !== undefined &&
      isInternalApiAuthorized(request.headers.authorization, internalApiToken);
    const ingressHealthAuthorized =
      isExactApiRequest(request.url, "/internal/ingress-readiness") &&
      ingressHealthToken !== undefined &&
      isInternalApiAuthorized(request.headers.authorization, ingressHealthToken);
    if (!operatorAuthorized && !ingressHealthAuthorized) {
      return reply.code(401).send({
        ok: false,
        error: "internal_api_unauthorized",
      });
    }
  });

  registerGroupMemoryApi(app, groupMemoryService, {
    authenticationConfigured: internalApiToken !== undefined,
  });
  registerConversationStateApi(
    app,
    dependencies.conversationStateInspectionStore ?? conversationStateInspectionRuntime?.store,
    { authenticationConfigured: internalApiToken !== undefined },
  );
  registerProactiveSignalApi(app, proactiveSignalRuntime, {
    authenticationConfigured: internalApiToken !== undefined,
    now,
  });

  app.post("/feishu/events", async (request, reply) => {
    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const rawBody = isParsedJsonBody(request.body) ? request.body.rawBody : undefined;
    const response = await gateway.handleCallback({
      headers: normalizeHeaders(request.headers),
      body,
      rawBody
    });

    return reply.code(response.statusCode).send(response.body);
  });

  app.post("/internal/answer-drafts", async (request, reply) => {
    if (answerDraftOrchestrator === undefined) {
      return reply.code(503).send({
        ok: false,
        error: "answer_draft_orchestrator_unavailable"
      });
    }

    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseAnswerDraftRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }
    if (
      !runtimeController.canGenerateAnswerDraft({
        ...(parsedRequest.chatId === undefined ? {} : { groupId: parsedRequest.chatId }),
      })
    ) {
      return reply.code(403).send({ ok: false, error: "iris_runtime_disabled" });
    }

    try {
      return await answerDraftOrchestrator.generateDraft(parsedRequest);
    } catch {
      return reply.code(500).send({ ok: false, error: "answer_draft_failed" });
    }
  });

  app.get("/internal/audit/status", async () => ({
    ok: true,
    enabled: true,
    storage: "in_memory",
    retention: auditLog.retention,
  }));

  app.get("/internal/status", async () => {
    const runtimeControlStatus = await readRuntimeControlStatus({
      controller: runtimeController,
      service: runtimeControlService,
    });
    const components = {
      audit: {
        ok: true,
        enabled: true,
        storage: "in_memory",
        retention: auditLog.retention,
      },
      runtimeControl: {
        ok: runtimeControlStatus.persistence.ok,
        enabled: runtimeControlStatus.globalEnabled,
        globalEnabled: runtimeControlStatus.globalEnabled,
        desiredGlobalEnabled: runtimeControlStatus.desiredGlobalEnabled,
        activationRequired: runtimeControlStatus.activationRequired,
        disabledGroupIds: runtimeControlStatus.disabledGroupIds,
        disabledGroupCount: runtimeControlStatus.disabledGroupIds.length,
        capabilities: runtimeControlStatus.capabilities,
        revision: runtimeControlStatus.revision,
        updatedAt: runtimeControlStatus.updatedAt,
        ...(runtimeControlStatus.updatedBy === undefined
          ? {}
          : { updatedBy: runtimeControlStatus.updatedBy }),
        persistence: runtimeControlStatus.persistence,
        ...(runtimeControlStatus.persistence.ok
          ? {}
          : { degradedReason: "runtime_control_persistence_failed" as const }),
      },
      answerDraft: {
        ok: true,
        enabled: answerDraftOrchestrator !== undefined,
      },
      feishuGateway: getFeishuGatewayStatus(feishuGatewayStatus),
      memoryExtraction:
        memoryExtractionRuntime === undefined
          ? { ok: true, enabled: false, running: false }
          : await getMemoryExtractionStatus(memoryExtractionRuntime),
      proactiveSignals: await getProactiveSignalStatus(proactiveSignalRuntime),
      eventWorker: await getEventWorkerStatus(eventWorkerRuntime),
      documentSync: await getDocumentSyncStatus(documentSyncRuntime),
      reindex: await getReindexStatus(reindexWorkerRuntime),
    };

    return buildInternalStatusSnapshot({ components, generatedAt: now() });
  });

  app.get("/internal/readiness", async () =>
    buildInternalRolloutReadinessReport(dependencies.readinessEnv ?? process.env),
  );

  app.get("/internal/runtime-control/status", async () => ({
    ...await readRuntimeControlStatus({
      controller: runtimeController,
      service: runtimeControlService,
    }),
    ok: true,
  }));

  app.post("/internal/runtime-control/global", async (request, reply) => {
    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseRuntimeEnabledRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    const parsedOperatorHint = parseOperatorHint(request.headers["x-iris-operator"]);
    if (!parsedOperatorHint.ok) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }
    const operatorHint = parsedOperatorHint.value;
    let result: RuntimeControlMutationResult;
    try {
      result = await runtimeControlService.setGlobal({
        enabled: parsedRequest.enabled,
        ...(operatorHint === undefined ? {} : { updatedBy: operatorHint }),
      });
    } catch (error) {
      if (error instanceof RuntimeControlInputError) {
        return reply.code(400).send({ ok: false, error: "invalid_request" });
      }
      return sendRuntimeControlPersistenceFailure(reply);
    }

    if (
      result.kind === "success" &&
      result.status.persistence.storage !== runtimeControlService.persistenceStorage
    ) {
      return sendFailClosedRuntimeControlStorageMismatch({
        auditLog,
        controller: runtimeController,
        operatorHint,
        reply,
        response: parsedRequest.enabled
          ? "persistence_failed"
          : "disable_not_persisted",
      });
    }

    if (result.kind === "success" || result.kind === "disable_not_persisted") {
      await recordRuntimeControlAuditEvent({
        auditLog,
        scope: "global",
        enabled: parsedRequest.enabled,
        previousEnabled: result.previousSnapshot.globalEnabled,
        operatorHint,
      });
    }

    return sendRuntimeControlMutationResult(reply, result);
  });

  app.post("/internal/runtime-control/groups/:groupId", async (request, reply) => {
    const groupId = readNonBlankId((request.params as { groupId?: unknown }).groupId);
    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseRuntimeEnabledRequest(body);
    if (groupId === undefined || parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    const parsedOperatorHint = parseOperatorHint(request.headers["x-iris-operator"]);
    if (!parsedOperatorHint.ok) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }
    const operatorHint = parsedOperatorHint.value;
    let result: RuntimeControlMutationResult;
    try {
      result = await runtimeControlService.setGroup({
        groupId,
        enabled: parsedRequest.enabled,
        ...(operatorHint === undefined ? {} : { updatedBy: operatorHint }),
      });
    } catch (error) {
      if (error instanceof RuntimeControlInputError) {
        return reply.code(400).send({ ok: false, error: "invalid_request" });
      }
      return sendRuntimeControlPersistenceFailure(reply);
    }

    if (
      result.kind === "success" &&
      result.status.persistence.storage !== runtimeControlService.persistenceStorage
    ) {
      return sendFailClosedRuntimeControlStorageMismatch({
        auditLog,
        controller: runtimeController,
        operatorHint,
        reply,
        response: "persistence_failed",
      });
    }

    if (result.kind === "success") {
      await recordRuntimeControlAuditEvent({
        auditLog,
        scope: "group",
        targetId: groupId,
        enabled: parsedRequest.enabled,
        previousEnabled: !result.previousSnapshot.disabledGroupIds.includes(groupId),
        operatorHint,
      });
    }

    return sendRuntimeControlMutationResult(reply, result);
  });

  app.patch("/internal/runtime-control/capabilities", async (request, reply) => {
    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseRuntimeCapabilityUpdateRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    const parsedOperatorHint = parseOperatorHint(request.headers["x-iris-operator"]);
    if (!parsedOperatorHint.ok) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }
    const operatorHint = parsedOperatorHint.value;
    let result: RuntimeControlMutationResult;
    try {
      result = await runtimeControlService.setCapabilities({
        updates: parsedRequest,
        ...(operatorHint === undefined ? {} : { updatedBy: operatorHint }),
      });
    } catch (error) {
      if (error instanceof RuntimeControlInputError) {
        return reply.code(400).send({ ok: false, error: "invalid_request" });
      }
      return sendRuntimeControlPersistenceFailure(reply);
    }

    if (
      result.kind === "success" &&
      result.status.persistence.storage !== runtimeControlService.persistenceStorage
    ) {
      return sendFailClosedRuntimeControlStorageMismatch({
        auditLog,
        controller: runtimeController,
        operatorHint,
        reply,
        response: "persistence_failed",
      });
    }

    if (result.kind === "success") {
      for (const capability of Object.keys(parsedRequest) as RuntimeCapabilityName[]) {
        const enabled = parsedRequest[capability];
        if (enabled === undefined) {
          continue;
        }
        await recordRuntimeControlAuditEvent({
          auditLog,
          scope: "capability",
          targetId: capability,
          enabled,
          previousEnabled: result.previousSnapshot.capabilities[capability],
          operatorHint,
        });
      }
    }

    return sendRuntimeControlMutationResult(reply, result);
  });

  app.get("/internal/audit/events", async (request, reply) => {
    const parsedQuery = parseAuditEventQuery(request.query);
    if (parsedQuery === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }
    const diagnostics = getAuditEventDiagnostics(auditLog, parsedQuery);

    return {
      ok: true,
      meta: diagnostics.meta,
      events: diagnostics.matchingEvents.reverse().map(toAuditEventResponse),
    };
  });

  app.get("/internal/audit/events/summary", async (request, reply) => {
    const parsedQuery = parseAuditEventSummaryQuery(request.query);
    if (parsedQuery === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }
    const diagnostics = getAuditEventDiagnostics(auditLog, parsedQuery);

    return {
      ok: true,
      meta: diagnostics.meta,
      summaries: auditLog.summarizeRecent(parsedQuery).map(toAuditEventSummaryResponse),
    };
  });

  app.post("/internal/reindex/document-profile", async (request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "reindex_worker_unavailable" });
    }

    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseReindexDocumentProfileRequest(
      body,
      reindexWorkerRuntime.activeEmbeddingProfileId,
    );
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const result = await reindexWorkerRuntime.planner.planDocumentProfileReindex(parsedRequest);
      return { ok: true, ...result };
    } catch {
      return reply.code(500).send({ ok: false, error: "reindex_plan_failed" });
    }
  });

  app.get("/internal/reindex/status", async (_request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return { ok: true, enabled: false, running: false };
    }

    try {
      return { ok: true, ...(await reindexWorkerRuntime.getStatus()) };
    } catch {
      return reply.code(500).send({ ok: false, error: "reindex_status_failed" });
    }
  });

  app.get("/internal/events/status", async (_request, reply) => {
    if (eventWorkerRuntime === undefined) {
      return { ok: true, enabled: false, running: false };
    }

    try {
      return { ok: true, ...(await eventWorkerRuntime.getStatus()) };
    } catch {
      return reply.code(500).send({ ok: false, error: "event_worker_status_failed" });
    }
  });

  app.get("/internal/memory-extraction/status", async (_request, reply) => {
    if (memoryExtractionRuntime === undefined) {
      return { ok: true, enabled: false, running: false };
    }

    try {
      return {
        ok: true,
        ...toContentFreeMemoryExtractionStatus(await memoryExtractionRuntime.getStatus()),
      };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "memory_extraction_status_failed",
      });
    }
  });

  app.get("/internal/memory-extraction/dead-letters", async (request, reply) => {
    if (memoryExtractionRuntime === undefined) {
      return reply.code(503).send({
        ok: false,
        error: "memory_extraction_runtime_unavailable",
      });
    }

    const limit = parseMemoryExtractionDeadLetterLimit(request.query);
    if (limit === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const deadLetters = await memoryExtractionRuntime.deadLetters.list({ limit });
      return {
        ok: true,
        deadLetters: deadLetters.map(toMemoryExtractionDeadLetterResponse),
      };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "memory_extraction_dead_letter_operation_failed",
      });
    }
  });

  app.post("/internal/memory-extraction/dead-letters/replay", async (request, reply) => {
    if (memoryExtractionRuntime === undefined) {
      return reply.code(503).send({
        ok: false,
        error: "memory_extraction_runtime_unavailable",
      });
    }

    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseMemoryExtractionDeadLetterBatchReplayRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const result = {
        replayedCount: 0,
        notFoundIds: [] as string[],
        unsupportedLegacyIds: [] as string[],
      };
      for (const id of parsedRequest.ids) {
        const status = await memoryExtractionRuntime.deadLetters.replay(id);
        if (status === "replayed") {
          result.replayedCount += 1;
          await recordMemoryExtractionRecoveryAuditEvent({
            auditLog,
            type: "memory_extraction_dlq_replayed",
            id,
          });
        } else if (status === "not_found") {
          result.notFoundIds.push(id);
        } else {
          result.unsupportedLegacyIds.push(id);
        }
      }
      return { ok: true, ...result };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "memory_extraction_dead_letter_operation_failed",
      });
    }
  });

  app.post("/internal/memory-extraction/dead-letters/:id/replay", async (request, reply) => {
    if (memoryExtractionRuntime === undefined) {
      return reply.code(503).send({
        ok: false,
        error: "memory_extraction_runtime_unavailable",
      });
    }

    const id = readNonBlankId((request.params as { id?: unknown }).id);
    if (id === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const status = await memoryExtractionRuntime.deadLetters.replay(id);
      if (status === "replayed") {
        await recordMemoryExtractionRecoveryAuditEvent({
          auditLog,
          type: "memory_extraction_dlq_replayed",
          id,
        });
      }
      return { ok: true, status };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "memory_extraction_dead_letter_operation_failed",
      });
    }
  });

  app.delete("/internal/memory-extraction/dead-letters/:id", async (request, reply) => {
    if (memoryExtractionRuntime === undefined) {
      return reply.code(503).send({
        ok: false,
        error: "memory_extraction_runtime_unavailable",
      });
    }

    const id = readNonBlankId((request.params as { id?: unknown }).id);
    if (id === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const status = await memoryExtractionRuntime.deadLetters.delete(id);
      if (status === "deleted") {
        await recordMemoryExtractionRecoveryAuditEvent({
          auditLog,
          type: "memory_extraction_dlq_deleted",
          id,
        });
      }
      return { ok: true, status };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "memory_extraction_dead_letter_operation_failed",
      });
    }
  });

  app.get("/internal/events/dead-letters", async (request, reply) => {
    if (eventWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "event_worker_unavailable" });
    }

    const limit = parseDeadLetterLimit((request.query as { limit?: unknown }).limit);
    if (limit === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, deadLetters: await eventWorkerRuntime.deadLetters.list({ limit }) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "event_dead_letter_operation_failed"
      });
    }
  });

  app.post("/internal/events/dead-letters/replay", async (request, reply) => {
    if (eventWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "event_worker_unavailable" });
    }

    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseDeadLetterBatchReplayRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, ...(await eventWorkerRuntime.deadLetters.replayBatch(parsedRequest)) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "event_dead_letter_operation_failed"
      });
    }
  });

  app.post("/internal/events/dead-letters/:id/replay", async (request, reply) => {
    if (eventWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "event_worker_unavailable" });
    }

    const id = readNonBlankId((request.params as { id?: unknown }).id);
    if (id === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, status: await eventWorkerRuntime.deadLetters.replay(id) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "event_dead_letter_operation_failed"
      });
    }
  });

  app.delete("/internal/events/dead-letters/:id", async (request, reply) => {
    if (eventWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "event_worker_unavailable" });
    }

    const id = readNonBlankId((request.params as { id?: unknown }).id);
    if (id === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, status: await eventWorkerRuntime.deadLetters.delete(id) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "event_dead_letter_operation_failed"
      });
    }
  });

  app.get("/internal/document-sync/status", async (_request, reply) => {
    if (documentSyncRuntime === undefined) {
      return { ok: true, enabled: false, running: false };
    }

    try {
      return { ok: true, ...(await documentSyncRuntime.getStatus()) };
    } catch {
      return reply.code(500).send({ ok: false, error: "document_sync_status_failed" });
    }
  });

  app.get("/internal/document-sync/sources", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const parsedQuery = parseDocumentSourceListQuery(request.query);
    if (parsedQuery === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const sources = await documentSyncRuntime.sources.list(parsedQuery);
      if (parsedQuery.includeLatestSnapshot !== true) {
        return {
          ok: true,
          sources,
        };
      }
      if (sources.length === 0) {
        return {
          ok: true,
          sources: [],
        };
      }

      const latestSnapshotsBySourceId = await documentSyncRuntime.sources.getLatestSnapshots({
        sourceIds: sources.map((source) => source.id),
      });
      return {
        ok: true,
        sources: sources.map((source) => {
          const latestSnapshot = latestSnapshotsBySourceId.get(source.id);
          return {
            ...source,
            syncHealth: toDocumentSourceSyncHealth(latestSnapshot),
            ...(latestSnapshot === undefined
              ? {}
              : { latestSnapshot: toDocumentSnapshotSummary(latestSnapshot) }),
          };
        }),
      };
    } catch {
      return reply.code(500).send({ ok: false, error: "document_source_lookup_failed" });
    }
  });

  app.get("/internal/document-sync/sources/:id/snapshots/latest", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const sourceId = readNonBlankId((request.params as { id?: unknown }).id);
    const previewLength = parseSnapshotPreviewLength(
      (request.query as { previewLength?: unknown }).previewLength,
    );
    if (sourceId === undefined || previewLength === false) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const snapshot = await documentSyncRuntime.sources.getLatestSnapshot({ sourceId });
      if (snapshot === undefined) {
        return reply.code(404).send({
          ok: false,
          error: "document_source_snapshot_not_found",
        });
      }

      return {
        ok: true,
        snapshot: toDocumentSnapshotSummary(snapshot, {
          ...(previewLength === undefined ? {} : { previewLength }),
        }),
      };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "document_source_snapshot_lookup_failed"
      });
    }
  });

  app.get("/internal/document-sync/sources/:sourceId/snapshots/:snapshotId", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const sourceId = readNonBlankId((request.params as { sourceId?: unknown }).sourceId);
    const snapshotId = readNonBlankId((request.params as { snapshotId?: unknown }).snapshotId);
    const previewLength = parseSnapshotPreviewLength(
      (request.query as { previewLength?: unknown }).previewLength,
    );
    if (sourceId === undefined || snapshotId === undefined || previewLength === false) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const snapshot = await documentSyncRuntime.sources.getSnapshot({
        sourceId,
        snapshotId,
      });
      if (snapshot === undefined) {
        return reply.code(404).send({
          ok: false,
          error: "document_source_snapshot_not_found",
        });
      }

      return {
        ok: true,
        snapshot: toDocumentSnapshotSummary(snapshot, {
          ...(previewLength === undefined ? {} : { previewLength }),
        }),
      };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "document_source_snapshot_lookup_failed"
      });
    }
  });

  app.get("/internal/document-sync/sources/:id/snapshots", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const documentSourceId = readNonBlankId((request.params as { id?: unknown }).id);
    const limit = parseDeadLetterLimit((request.query as { limit?: unknown }).limit);
    if (documentSourceId === undefined || limit === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const snapshots = await documentSyncRuntime.sources.listSnapshots({
        id: documentSourceId,
        limit,
      });
      if (snapshots === undefined) {
        return reply.code(404).send({ ok: false, error: "document_source_not_found" });
      }

      return {
        ok: true,
        snapshots: snapshots.map((snapshot) => toDocumentSnapshotSummary(snapshot)),
      };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "document_source_snapshot_lookup_failed"
      });
    }
  });

  app.get("/internal/document-sync/sources/:id", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const documentSourceId = readNonBlankId((request.params as { id?: unknown }).id);
    const includeLatestSnapshot = parseIncludeLatestSnapshot(
      (request.query as { includeLatestSnapshot?: unknown }).includeLatestSnapshot,
    );
    if (documentSourceId === undefined || includeLatestSnapshot === false) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const source = await documentSyncRuntime.sources.get(documentSourceId);
      if (source === undefined) {
        return reply.code(404).send({ ok: false, error: "document_source_not_found" });
      }
      if (includeLatestSnapshot !== true) {
        return { ok: true, source };
      }

      const latestSnapshot = await documentSyncRuntime.sources.getLatestSnapshot({
        sourceId: documentSourceId,
      });
      return {
        ok: true,
        source: {
          ...source,
          syncHealth: toDocumentSourceSyncHealth(latestSnapshot),
          ...(latestSnapshot === undefined
            ? {}
            : { latestSnapshot: toDocumentSnapshotSummary(latestSnapshot) }),
        },
      };
    } catch {
      return reply.code(500).send({ ok: false, error: "document_source_lookup_failed" });
    }
  });

  app.patch("/internal/document-sync/sources/:id/policy", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const documentSourceId = readNonBlankId((request.params as { id?: unknown }).id);
    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseDocumentSourcePolicyUpdateRequest(body);
    if (documentSourceId === undefined || parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const source = await documentSyncRuntime.sources.updatePolicy({
        id: documentSourceId,
        ...parsedRequest,
      });
      if (source === undefined) {
        return reply.code(404).send({ ok: false, error: "document_source_not_found" });
      }

      return { ok: true, source };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "document_source_policy_update_failed"
      });
    }
  });

  app.post("/internal/document-sync/sources/:id/enqueue", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const documentSourceId = readNonBlankId((request.params as { id?: unknown }).id);
    if (documentSourceId === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return {
        ok: true,
        ...(await documentSyncRuntime.enqueueSource({ documentSourceId })),
      };
    } catch {
      return reply.code(500).send({ ok: false, error: "document_sync_enqueue_failed" });
    }
  });

  app.post("/internal/document-sync/authorized-wiki-documents", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseRegisterAuthorizedWikiDocumentRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return {
        ok: true,
        ...(await documentSyncRuntime.registerAuthorizedWikiDocument({
          ...parsedRequest,
          observedAt: now(),
        })),
      };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "authorized_wiki_document_registration_failed"
      });
    }
  });

  app.post("/internal/document-sync/user-submitted-documents", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseRegisterUserSubmittedDocumentRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return {
        ok: true,
        ...(await documentSyncRuntime.registerUserSubmittedDocument({
          ...parsedRequest,
          observedAt: now(),
        })),
      };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "user_submitted_document_registration_failed"
      });
    }
  });

  app.get("/internal/document-sync/dead-letters", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const limit = parseDeadLetterLimit((request.query as { limit?: unknown }).limit);
    if (limit === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, deadLetters: await documentSyncRuntime.deadLetters.list({ limit }) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "document_sync_dead_letter_operation_failed"
      });
    }
  });

  app.post("/internal/document-sync/dead-letters/replay", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseDeadLetterBatchReplayRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, ...(await documentSyncRuntime.deadLetters.replayBatch(parsedRequest)) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "document_sync_dead_letter_operation_failed"
      });
    }
  });

  app.post("/internal/document-sync/dead-letters/:id/replay", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const id = readNonBlankId((request.params as { id?: unknown }).id);
    if (id === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, status: await documentSyncRuntime.deadLetters.replay(id) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "document_sync_dead_letter_operation_failed"
      });
    }
  });

  app.delete("/internal/document-sync/dead-letters/:id", async (request, reply) => {
    if (documentSyncRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "document_sync_worker_unavailable" });
    }

    const id = readNonBlankId((request.params as { id?: unknown }).id);
    if (id === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, status: await documentSyncRuntime.deadLetters.delete(id) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "document_sync_dead_letter_operation_failed"
      });
    }
  });

  app.get("/internal/reindex/dead-letters", async (request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "reindex_worker_unavailable" });
    }

    const limit = parseDeadLetterLimit((request.query as { limit?: unknown }).limit);
    if (limit === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, deadLetters: await reindexWorkerRuntime.deadLetters.list({ limit }) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "reindex_dead_letter_operation_failed"
      });
    }
  });

  app.post("/internal/reindex/dead-letters/replay", async (request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "reindex_worker_unavailable" });
    }

    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseDeadLetterBatchReplayRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, ...(await reindexWorkerRuntime.deadLetters.replayBatch(parsedRequest)) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "reindex_dead_letter_operation_failed"
      });
    }
  });

  app.post("/internal/reindex/dead-letters/:id/replay", async (request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "reindex_worker_unavailable" });
    }

    const id = readNonBlankId((request.params as { id?: unknown }).id);
    if (id === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, status: await reindexWorkerRuntime.deadLetters.replay(id) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "reindex_dead_letter_operation_failed"
      });
    }
  });

  app.delete("/internal/reindex/dead-letters/:id", async (request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "reindex_worker_unavailable" });
    }

    const id = readNonBlankId((request.params as { id?: unknown }).id);
    if (id === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, status: await reindexWorkerRuntime.deadLetters.delete(id) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "reindex_dead_letter_operation_failed"
      });
    }
  });

  app.get("/health", async () => ({ ok: true, service: "iris-core" }));

  app.get("/internal/ingress-readiness", async (_request, reply) => {
    if (!(await gateway.isIngressReady())) {
      return reply.code(503).send({ ok: false, error: "ingress_queue_unavailable" });
    }
    return { ok: true, status: "ready" };
  });

  dependencies.onBeforeRuntimeCloseOwnership?.(app);
  app.addHook("onClose", async () => {
    if (!appOwnsRuntimeResources) {
      return;
    }
    await closeRuntimeResources([
      () => gateway.close(),
      () => documentSyncRuntime?.close(),
      () => eventWorkerRuntime?.close(),
      () => memoryExtractionRuntime?.close(),
      () => proactiveSignalRuntime?.close(),
      () => reindexWorkerRuntime?.close(),
      () => answerDraftRuntime?.close(),
      () => conversationStateInspectionRuntime?.close(),
      () => dependencies.closeRuntimeControl?.(),
    ]);
  });
  appOwnsRuntimeResources = true;

  return app;
  } catch (error) {
    const cleanup = scheduleRuntimeStartupCleanup({
      app: startupApp,
      gateway: startupGateway,
      answerDraftRuntime,
      reindexWorkerRuntime,
      memoryExtractionRuntime,
      eventWorkerRuntime,
      documentSyncRuntime,
      conversationStateInspectionRuntime,
      proactiveSignalRuntime,
    });
    dependencies.onRuntimeStartupCleanup?.(cleanup);
    throw error;
  }
}

function getFeishuGatewayStatus(state: FeishuGatewayStatusState) {
  return {
    ok: state.latestEnqueueError === undefined,
    enabled: true,
    enqueueFailureCount: state.enqueueFailureCount,
    ...(state.latestEnqueueError === undefined
      ? {}
      : {
          degradedReason: enqueueFailuresPresentReason,
          latestEnqueueError: state.latestEnqueueError,
        }),
  };
}

function readInternalApiToken(value: string | undefined): string | undefined {
  return readBearerToken(value, "IRIS_INTERNAL_API_TOKEN");
}

function readBearerToken(value: string | undefined, name: string): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }
  if (!isSingleBearerToken(trimmed)) {
    throw new Error(`${name} must be a single bearer token`);
  }

  return trimmed;
}

export function resolveServerListenHost(
  internalApiToken: string | undefined,
  feishuVerificationToken: string | undefined,
): "127.0.0.1" | "0.0.0.0" {
  const hasInternalApiToken = readInternalApiToken(internalApiToken) !== undefined;
  const hasFeishuVerificationToken = (feishuVerificationToken?.trim().length ?? 0) > 0;
  return hasInternalApiToken && hasFeishuVerificationToken ? "0.0.0.0" : "127.0.0.1";
}

function isInternalApiRequest(url: string): boolean {
  const path = pathBeforeQuery(url);
  if (isInternalApiPath(path)) {
    return true;
  }

  try {
    return isInternalApiPath(pathBeforeQuery(decodeURIComponent(path)));
  } catch {
    return false;
  }
}

function isExactApiRequest(url: string, expectedPath: string): boolean {
  const path = pathBeforeQuery(url);
  if (path === expectedPath) {
    return true;
  }
  try {
    return pathBeforeQuery(decodeURIComponent(path)) === expectedPath;
  } catch {
    return false;
  }
}

function pathBeforeQuery(url: string): string {
  return url.split("?", 1)[0];
}

function isInternalApiPath(path: string): boolean {
  return path === "/internal" || path.startsWith("/internal/");
}

function isInternalApiAuthorized(
  authorization: string | undefined,
  token: string,
): boolean {
  const match = /^Bearer +([!-~]+)$/i.exec(authorization ?? "");
  const presentedToken = match?.[1];
  if (presentedToken === undefined || !isSingleBearerToken(presentedToken)) {
    return false;
  }

  return safeTokenEqual(presentedToken, token);
}

function isSingleBearerToken(value: string): boolean {
  return /^[!-~]+$/u.test(value) && !value.includes(",");
}

function safeTokenEqual(presentedToken: string, configuredToken: string): boolean {
  const presentedTokenBytes = Buffer.from(presentedToken);
  const configuredTokenBytes = Buffer.from(configuredToken);
  return (
    presentedTokenBytes.length === configuredTokenBytes.length &&
    timingSafeEqual(presentedTokenBytes, configuredTokenBytes)
  );
}

async function closeRuntimeResources(
  closeOperations: Array<() => Promise<void> | undefined>,
): Promise<void> {
  const errors: unknown[] = [];

  for (const close of closeOperations) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Iris runtime resource cleanup failed");
  }
}

function scheduleRuntimeStartupCleanup({
  app,
  gateway,
  answerDraftRuntime,
  reindexWorkerRuntime,
  memoryExtractionRuntime,
  eventWorkerRuntime,
  documentSyncRuntime,
  conversationStateInspectionRuntime,
  proactiveSignalRuntime,
}: {
  app: Pick<FastifyInstance, "close"> | undefined;
  gateway: Pick<ReturnType<typeof createFeishuGateway>, "close"> | undefined;
  answerDraftRuntime: AnswerDraftRuntime | undefined;
  reindexWorkerRuntime: ReindexWorkerRuntime | undefined;
  memoryExtractionRuntime: MemoryExtractionRuntime | undefined;
  eventWorkerRuntime: EventWorkerRuntime | undefined;
  documentSyncRuntime: DocumentSyncRuntime | undefined;
  conversationStateInspectionRuntime: ConversationStateInspectionRuntime | undefined;
  proactiveSignalRuntime: ProactiveSignalRuntime | undefined;
}): Promise<void> {
  const cleanup = closeRuntimeResources([
    () => gateway?.close(),
    () => documentSyncRuntime?.close(),
    () => eventWorkerRuntime?.close(),
    () => memoryExtractionRuntime?.close(),
    () => proactiveSignalRuntime?.close(),
    () => reindexWorkerRuntime?.close(),
    () => answerDraftRuntime?.close(),
    () => conversationStateInspectionRuntime?.close(),
    () => app?.close(),
  ]);
  void cleanup.catch(() => undefined);
  return cleanup;
}

function flattenAggregateErrors(error: unknown): unknown[] {
  if (!(error instanceof AggregateError)) {
    return [error];
  }

  return error.errors.flatMap((nestedError) => flattenAggregateErrors(nestedError));
}

function startupCleanupError(
  startupError: unknown,
  cleanupError: unknown,
  message: string,
): AggregateError {
  return new AggregateError(
    [startupError, ...flattenAggregateErrors(cleanupError)],
    message,
  );
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? String(value[0]) : typeof value === "string" ? value : undefined
    ])
  );
}

function isParsedJsonBody(value: unknown): value is ParsedJsonBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "parsedBody" in value &&
    typeof (value as { rawBody?: unknown }).rawBody === "string"
  );
}

function parseAnswerDraftRequest(value: unknown): AnswerDraftRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const question = readNonBlankBoundedString(value.question, maxAnswerDraftQuestionLength);
  if (question === undefined || !Array.isArray(value.liveChatMessages)) {
    return undefined;
  }
  if (value.liveChatMessages.length > maxAnswerDraftLiveChatMessageInputCount) {
    return undefined;
  }
  const chatId = value.chatId === undefined ? undefined : readNonBlankId(value.chatId);
  if (chatId === undefined && value.chatId !== undefined) {
    return undefined;
  }

  const liveChatMessages = value.liveChatMessages.map(parseLiveChatMessage);
  if (liveChatMessages.some((message) => message === undefined)) {
    return undefined;
  }

  if (
    !isFiniteSafeMagnitudeNumberOrUndefined(value.fragmentLimit) ||
    !isFiniteSafeMagnitudeNumberOrUndefined(value.liveChatLimit)
  ) {
    return undefined;
  }

  return {
    question,
    ...(chatId === undefined ? {} : { chatId }),
    liveChatMessages: liveChatMessages as LiveChatMessage[],
    ...(value.fragmentLimit === undefined ? {} : { fragmentLimit: value.fragmentLimit }),
    ...(value.liveChatLimit === undefined ? {} : { liveChatLimit: value.liveChatLimit })
  };
}

async function getMemoryExtractionStatus(runtime: MemoryExtractionRuntime) {
  try {
    const status = toContentFreeMemoryExtractionStatus(await runtime.getStatus());
    const workerHealth = withWorkerHealth(status, status.deadLetterJobCount);
    if (!workerHealth.ok) {
      return workerHealth;
    }
    if (!status.workerHealthy) {
      return {
        ok: false,
        ...status,
        degradedReason: aiWorkerUnavailableReason,
      };
    }

    return workerHealth;
  } catch {
    return {
      ok: false,
      enabled: true,
      running: false,
      error: "memory_extraction_status_failed",
    };
  }
}

async function getProactiveSignalStatus(runtime: ProactiveSignalRuntime | undefined) {
  if (runtime === undefined) {
    return { ok: true, enabled: false, running: false };
  }
  try {
    return { ok: true, ...(await runtime.getStatus()) };
  } catch {
    return {
      ok: false,
      enabled: true,
      running: false,
      degradedReason: "proactive_signal_status_failed" as const,
    };
  }
}

function toContentFreeMemoryExtractionStatus(
  status: MemoryExtractionRuntimeStatus,
): MemoryExtractionRuntimeStatus {
  return {
    enabled: true,
    running: status.running,
    workerHealthy: status.workerHealthy,
    intervalMs: status.intervalMs,
    batchLimit: status.batchLimit,
    minConfidence: status.minConfidence,
    candidateConfidenceFloor: status.candidateConfidenceFloor,
    threadEnabledGroupCount: status.threadEnabledGroupCount,
    actionEnabledGroupCount: status.actionEnabledGroupCount,
    pendingProjectionRepairCount: status.pendingProjectionRepairCount,
    failedProjectionRepairCount: status.failedProjectionRepairCount,
    projectionRepairHealthy: status.projectionRepairHealthy,
    pendingJobCount: status.pendingJobCount,
    processingJobCount: status.processingJobCount,
    delayedJobCount: status.delayedJobCount,
    deadLetterJobCount: status.deadLetterJobCount,
    acceptedCandidateCount: status.acceptedCandidateCount,
    rejectedCandidateCount: status.rejectedCandidateCount,
    duplicateCandidateCount: status.duplicateCandidateCount,
    conflictCandidateCount: status.conflictCandidateCount,
    acceptedThreadOperationCount: status.acceptedThreadOperationCount,
    rejectedThreadOperationCount: status.rejectedThreadOperationCount,
    acceptedActionOperationCount: status.acceptedActionOperationCount,
    rejectedActionOperationCount: status.rejectedActionOperationCount,
    skippedRequestCount: status.skippedRequestCount,
    failedRunCount: status.failedRunCount,
    ...(status.providerCooldownUntil === undefined
      ? {}
      : { providerCooldownUntil: new Date(status.providerCooldownUntil) }),
    ...(status.latestBatch === undefined
      ? {}
      : { latestBatch: toContentFreeMemoryExtractionBatchSnapshot(status.latestBatch) }),
  };
}

function toContentFreeMemoryExtractionBatchSnapshot(
  snapshot: NonNullable<MemoryExtractionRuntimeStatus["latestBatch"]>,
): NonNullable<MemoryExtractionRuntimeStatus["latestBatch"]> {
  if (snapshot.status === "failed") {
    return {
      status: "failed" as const,
      startedAt: new Date(snapshot.startedAt),
      finishedAt: new Date(snapshot.finishedAt),
      completedCount: 0,
      skippedCount: 0,
      deferredCount: 0,
      failedCount: 0,
      failed: true as const,
      errorMessage: "memory_extraction_batch_failed",
    };
  }

  return {
    status: "succeeded" as const,
    startedAt: new Date(snapshot.startedAt),
    finishedAt: new Date(snapshot.finishedAt),
    completedCount: snapshot.completedCount,
    skippedCount: snapshot.skippedCount,
    deferredCount: snapshot.deferredCount,
    failedCount: snapshot.failedCount,
    failed: false as const,
  };
}

async function getEventWorkerStatus(runtime: EventWorkerRuntime | undefined) {
  if (runtime === undefined) {
    return { ok: true, enabled: false, running: false };
  }

  try {
    const status = await runtime.getStatus();
    return withEventWorkerHealth(status);
  } catch {
    return {
      ok: false,
      enabled: true,
      running: false,
      error: "event_worker_status_failed",
    };
  }
}

function withEventWorkerHealth(status: Awaited<ReturnType<EventWorkerRuntime["getStatus"]>>) {
  const workerHealth = withWorkerHealth(status, status.deadLetterEventCount);
  if (!workerHealth.ok) {
    return workerHealth;
  }

  if (status.mentionRepliesUnavailableReason !== undefined) {
    return {
      ok: false,
      ...status,
      degradedReason: mentionRepliesUnavailableReason,
    };
  }

  return workerHealth;
}

async function getDocumentSyncStatus(runtime: DocumentSyncRuntime | undefined) {
  if (runtime === undefined) {
    return { ok: true, enabled: false, running: false };
  }

  try {
    const status = await runtime.getStatus();
    return withWorkerHealth(status, status.deadLetterJobCount);
  } catch {
    return {
      ok: false,
      enabled: true,
      running: false,
      error: "document_sync_status_failed",
    };
  }
}

async function getReindexStatus(runtime: ReindexWorkerRuntime | undefined) {
  if (runtime === undefined) {
    return { ok: true, enabled: false, running: false };
  }

  try {
    const status = await runtime.getStatus();
    return withWorkerHealth(status, status.deadLetterJobCount);
  } catch {
    return {
      ok: false,
      enabled: true,
      running: false,
      error: "reindex_status_failed",
    };
  }
}

function withDeadLetterHealth<Status extends object>(
  status: Status,
  deadLetterCount: number,
) {
  if (deadLetterCount > 0) {
    return {
      ok: false,
      ...status,
      degradedReason: deadLettersPresentReason,
    };
  }

  return { ok: true, ...status };
}

function withWorkerHealth<
  Status extends { latestBatch?: { status: string; failedCount: number } },
>(
  status: Status,
  deadLetterCount: number,
) {
  const deadLetterHealth = withDeadLetterHealth(status, deadLetterCount);
  if (!deadLetterHealth.ok) {
    return deadLetterHealth;
  }
  if (status.latestBatch?.status === "failed") {
    return {
      ok: false,
      ...status,
      degradedReason: latestBatchFailedReason,
    };
  }
  if (
    status.latestBatch?.status === "succeeded" &&
    status.latestBatch.failedCount > 0
  ) {
    return {
      ok: false,
      ...status,
      degradedReason: latestBatchItemsFailedReason,
    };
  }

  return deadLetterHealth;
}

function parseReindexDocumentProfileRequest(
  value: unknown,
  activeEmbeddingProfileId: string,
): ReindexDocumentProfileRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const embeddingProfileId =
    typeof value.embeddingProfileId === "string" ? value.embeddingProfileId.trim() : "";
  if (embeddingProfileId.length === 0 || embeddingProfileId !== activeEmbeddingProfileId) {
    return undefined;
  }
  if (
    typeof value.limit !== "number" ||
    !Number.isInteger(value.limit) ||
    !Number.isSafeInteger(value.limit) ||
    value.limit <= 0 ||
    value.limit > maxReindexDocumentProfileLimit
  ) {
    return undefined;
  }

  return { embeddingProfileId, limit: value.limit };
}

function parseMemoryExtractionDeadLetterLimit(value: unknown): number | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "limit")) {
    return undefined;
  }
  return parseDeadLetterLimit(value.limit);
}

function parseDeadLetterLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return 20;
  }

  let parsed: number;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0 || !/^\d+$/u.test(trimmed)) {
      return undefined;
    }
    parsed = Number(trimmed);
  } else if (typeof value === "number") {
    parsed = value;
  } else {
    return undefined;
  }

  if (!Number.isInteger(parsed) || !Number.isSafeInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return Math.min(parsed, 100);
}

function parseAuditEventSummaryQuery(value: unknown): AuditEventSummaryQuery | undefined {
  return parseAuditEventQuery(value);
}

function parseAuditEventQuery(value: unknown): AuditEventSummaryQuery | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const limit = parseDeadLetterLimit(value.limit);
  const documentId = value.documentId === undefined ? undefined : readNonBlankId(value.documentId);
  const type = parseAuditEventType(value.type);
  const operatorHint = parseOperatorHint(value.operatorHint);
  if (
    limit === undefined ||
    (documentId === undefined && value.documentId !== undefined) ||
    type === false ||
    !operatorHint.ok
  ) {
    return undefined;
  }

  return {
    limit,
    ...(documentId === undefined ? {} : { documentId }),
    ...(type === undefined ? {} : { type }),
    ...(operatorHint.value === undefined ? {} : { operatorHint: operatorHint.value }),
  };
}

function matchesAuditEventQuery(
  event: RecordedAuditEvent,
  query: Pick<AuditEventSummaryQuery, "documentId" | "type" | "operatorHint">,
): boolean {
  return (
    (query.documentId === undefined || event.documentId === query.documentId) &&
    (query.type === undefined || event.type === query.type) &&
    (query.operatorHint === undefined || event.operatorHint === query.operatorHint)
  );
}

function getAuditEventDiagnostics(auditLog: InMemoryAuditLog, query: AuditEventSummaryQuery) {
  const retainedEvents = auditLog.events;
  const hasFilters = hasAuditEventQueryFilters(query);
  const matchingRetainedEvents = hasFilters
    ? retainedEvents.filter((event) => matchesAuditEventQuery(event, query))
    : retainedEvents;
  const inspectedEvents =
    query.limit <= 0 ? [] : hasFilters ? retainedEvents : retainedEvents.slice(-query.limit);
  const matchingEvents =
    query.limit <= 0 ? [] : matchingRetainedEvents.slice(-query.limit);

  return {
    matchingEvents,
    meta: {
      limit: query.limit,
      maxEventCount: auditLog.retention.maxEventCount,
      retainedEventCount: auditLog.retention.retainedEventCount,
      droppedEventCount: auditLog.retention.droppedEventCount,
      inspectedEventCount: inspectedEvents.length,
      matchingEventCount:
        query.limit <= 0
          ? 0
          : hasFilters
            ? matchingRetainedEvents.length
            : matchingEvents.length,
      filters: {
        ...(query.documentId === undefined ? {} : { documentId: query.documentId }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.operatorHint === undefined ? {} : { operatorHint: query.operatorHint }),
      },
    },
  };
}

function hasAuditEventQueryFilters(query: AuditEventSummaryQuery): boolean {
  return (
    query.documentId !== undefined ||
    query.type !== undefined ||
    query.operatorHint !== undefined
  );
}

function parseAuditEventType(value: unknown): AuditEvent["type"] | false | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return false;
  }

  const type = value.trim();
  return type === "permission_guard_denied" ||
    type === "permission_guard_error" ||
    type === "runtime_control_updated" ||
    type === "group_memory_created" ||
    type === "group_memory_corrected" ||
    type === "group_memory_deleted" ||
    type === "memory_extraction_completed" ||
    type === "memory_extraction_skipped" ||
    type === "memory_extraction_failed" ||
    type === "memory_extraction_dlq_replayed" ||
    type === "memory_extraction_dlq_deleted"
    ? type
    : false;
}

function sendRuntimeControlMutationResult(
  reply: FastifyReply,
  result: RuntimeControlMutationResult,
) {
  if (result.kind === "success") {
    return reply.send({ ...result.status, ok: true, durable: true });
  }
  if (result.kind === "conflict") {
    return reply.code(409).send({ ok: false, error: "runtime_control_conflict" });
  }
  if (result.kind === "persistence_failed") {
    return reply.code(503).send({
      ok: false,
      error: "runtime_control_persistence_failed",
    });
  }

  return sendRuntimeControlDisableNotPersisted(reply);
}

function sendRuntimeControlDisableNotPersisted(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: "runtime_control_disable_not_persisted",
    globalEnabled: false,
    durable: false,
  });
}

function sendRuntimeControlPersistenceFailure(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: "runtime_control_persistence_failed",
  });
}

async function sendFailClosedRuntimeControlStorageMismatch(input: {
  auditLog: InMemoryAuditLog;
  controller: RuntimeController;
  operatorHint?: string;
  reply: FastifyReply;
  response: "persistence_failed" | "disable_not_persisted";
}) {
  const previousEnabled = input.controller.getSnapshot().globalEnabled;
  input.controller.disableGlobal();
  await recordRuntimeControlAuditEvent({
    auditLog: input.auditLog,
    scope: "global",
    enabled: false,
    previousEnabled,
    operatorHint: input.operatorHint,
  });

  return input.response === "disable_not_persisted"
    ? sendRuntimeControlDisableNotPersisted(input.reply)
    : sendRuntimeControlPersistenceFailure(input.reply);
}

async function readRuntimeControlStatus(input: {
  controller: RuntimeController;
  service: RuntimeControlService;
}): Promise<RuntimeControlStatus> {
  try {
    const status = await input.service.getStatus();
    return status.persistence.storage === input.service.persistenceStorage
      ? status
      : createDegradedRuntimeControlStatus(input.controller, input.service);
  } catch {
    return createDegradedRuntimeControlStatus(input.controller, input.service);
  }
}

function createDegradedRuntimeControlStatus(
  controller: RuntimeController,
  service: RuntimeControlService,
): RuntimeControlStatus {
  return {
    ...controller.getSnapshot(),
    persistence: {
      storage: service.persistenceStorage,
      ok: false,
      error: "runtime_control_persistence_failed",
    },
  };
}

async function recordRuntimeControlAuditEvent(input: {
  auditLog: InMemoryAuditLog;
  scope: "global" | "group" | "capability";
  enabled: boolean;
  previousEnabled: boolean;
  targetId?: string;
  operatorHint?: string;
}): Promise<void> {
  try {
    await input.auditLog.record({
      type: "runtime_control_updated",
      documentId: "runtime-control",
      fragmentIds: [],
      runtimeControlScope: input.scope,
      enabled: input.enabled,
      previousEnabled: input.previousEnabled,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.operatorHint === undefined ? {} : { operatorHint: input.operatorHint }),
    });
  } catch {
    // Runtime control is an emergency surface; audit failure must not block it.
  }
}

function parseOperatorHint(value: unknown):
  | { ok: true; value?: string }
  | { ok: false } {
  if (value === undefined) {
    return { ok: true };
  }
  if (typeof value !== "string") {
    return { ok: false };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 120 || /[\r\n]/.test(trimmed)) {
    return { ok: false };
  }

  return { ok: true, value: trimmed };
}

function parseDocumentSourceListQuery(value: unknown): DocumentSourceListQuery | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const limit = parseDeadLetterLimit(value.limit);
  if (limit === undefined) {
    return undefined;
  }

  const sourceType = parseDocumentSourceType(value.sourceType);
  const groupId = value.groupId === undefined ? undefined : readNonBlankId(value.groupId);
  const authorizedSpaceId =
    value.authorizedSpaceId === undefined ? undefined : readNonBlankId(value.authorizedSpaceId);
  const submittedByUserId =
    value.submittedByUserId === undefined ? undefined : readNonBlankId(value.submittedByUserId);
  const usableForAnswering = parseUsableForAnswering(value.usableForAnswering);
  const includeLatestSnapshot = parseIncludeLatestSnapshot(value.includeLatestSnapshot);

  if (
    sourceType === false ||
    (groupId === undefined && value.groupId !== undefined) ||
    (authorizedSpaceId === undefined && value.authorizedSpaceId !== undefined) ||
    (submittedByUserId === undefined && value.submittedByUserId !== undefined) ||
    usableForAnswering === "invalid" ||
    includeLatestSnapshot === false
  ) {
    return undefined;
  }

  const filterCount = [
    sourceType,
    groupId,
    authorizedSpaceId,
    submittedByUserId,
    usableForAnswering,
  ].filter((filter) => filter !== undefined).length;
  if (filterCount > 1) {
    return undefined;
  }

  return {
    limit,
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(groupId === undefined ? {} : { groupId }),
    ...(authorizedSpaceId === undefined ? {} : { authorizedSpaceId }),
    ...(submittedByUserId === undefined ? {} : { submittedByUserId }),
    ...(usableForAnswering === undefined ? {} : { usableForAnswering }),
    ...(includeLatestSnapshot === undefined ? {} : { includeLatestSnapshot }),
  };
}

function parseDocumentSourceType(value: unknown): DocumentSourceType | false | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return false;
  }

  const sourceType = value.trim();
  return isDocumentSourceType(sourceType) ? sourceType : false;
}

function parseUsableForAnswering(value: unknown): boolean | "invalid" | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "true" || value === true) {
    return true;
  }

  if (value === "false" || value === false) {
    return false;
  }

  return "invalid";
}

function parseIncludeLatestSnapshot(value: unknown): true | false | undefined {
  if (value === undefined || value === "false" || value === false) {
    return undefined;
  }

  return value === "true" || value === true ? true : false;
}

function isDocumentSourceType(value: string): value is DocumentSourceType {
  return (
    value === "group_visible_document" ||
    value === "authorized_wiki_document" ||
    value === "user_submitted_document"
  );
}

function parseSnapshotPreviewLength(value: unknown): number | false | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return false;
  }

  const previewLength = Number.parseInt(value, 10);
  return previewLength <= 2000 ? previewLength : false;
}

function toDocumentSnapshotSummary(
  snapshot: DocumentSnapshot,
  options: { previewLength?: number } = {},
) {
  return {
    id: snapshot.id,
    documentSourceId: snapshot.documentSourceId,
    sourceUri: snapshot.sourceUri,
    fetchStatus: snapshot.fetchStatus,
    ...(snapshot.contentHash === undefined ? {} : { contentHash: snapshot.contentHash }),
    ...(snapshot.sourceVersion === undefined ? {} : { sourceVersion: snapshot.sourceVersion }),
    fetchedAt: snapshot.fetchedAt,
    ...(snapshot.errorMessage === undefined ? {} : { errorMessage: snapshot.errorMessage }),
    createdAt: snapshot.createdAt,
    ...(snapshot.bodyText === undefined ? {} : { bodyTextLength: snapshot.bodyText.length }),
    ...(snapshot.bodyText === undefined || options.previewLength === undefined
      ? {}
      : { bodyTextPreview: snapshot.bodyText.slice(0, options.previewLength) }),
  };
}

function toDocumentSourceSyncHealth(snapshot: DocumentSnapshot | undefined) {
  if (snapshot === undefined) {
    return { status: "never_synced" as const };
  }

  const base = {
    latestSnapshotId: snapshot.id,
    lastFetchedAt: snapshot.fetchedAt,
  };
  if (snapshot.fetchStatus === "succeeded") {
    return {
      status: "healthy" as const,
      ...base,
    };
  }

  return {
    status: "failing" as const,
    ...base,
    ...(snapshot.errorMessage === undefined ? {} : { errorMessage: snapshot.errorMessage }),
  };
}

function toMemoryExtractionDeadLetterResponse(deadLetter: MemoryExtractionDeadLetter) {
  const base = {
    id: deadLetter.id,
    errorMessage: normalizeMemoryExtractionFailureClassification(deadLetter.errorMessage),
    failedAt: new Date(deadLetter.failedAt),
    replayable: deadLetter.replayable,
  };
  if ("job" in deadLetter) {
    return {
      ...base,
      job: {
        schemaVersion: deadLetter.job.schemaVersion,
        idempotencyKey: deadLetter.job.idempotencyKey,
        requestId: deadLetter.job.requestId,
        groupId: deadLetter.job.groupId,
        enqueuedAt: new Date(deadLetter.job.enqueuedAt),
        notBefore: new Date(deadLetter.job.notBefore),
        attempts: deadLetter.job.attempts,
      },
    };
  }

  return {
    ...base,
    payloadDigest: deadLetter.payloadDigest,
    payloadBytes: deadLetter.payloadBytes,
  };
}

function normalizeMemoryExtractionFailureClassification(value: string): string {
  return memoryExtractionFailureClassifications.has(value) ? value : "internal_error";
}

async function recordMemoryExtractionRecoveryAuditEvent(input: {
  auditLog: InMemoryAuditLog;
  type: "memory_extraction_dlq_replayed" | "memory_extraction_dlq_deleted";
  id: string;
}): Promise<void> {
  try {
    await input.auditLog.record({
      type: input.type,
      documentId: input.id,
      fragmentIds: [],
    });
  } catch {
    // Operator recovery succeeds independently of the bounded audit sink.
  }
}

function toAuditEventResponse(event: RecordedAuditEvent) {
  return {
    ...event,
    fragmentIds: [...event.fragmentIds],
    recordedAt: event.recordedAt.toISOString(),
  };
}

function toAuditEventSummaryResponse(summary: AuditEventSummary) {
  return {
    ...summary,
    firstRecordedAt: summary.firstRecordedAt.toISOString(),
    latestRecordedAt: summary.latestRecordedAt.toISOString(),
  };
}

function parseDocumentSourcePolicyUpdateRequest(
  value: unknown,
): DocumentSourcePolicyUpdateRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const hasAnswering = "canUseForAnswering" in value;
  const hasKnowledgeDrafts = "canUseForKnowledgeDrafts" in value;
  if (!hasAnswering && !hasKnowledgeDrafts) {
    return undefined;
  }
  if (hasAnswering && typeof value.canUseForAnswering !== "boolean") {
    return undefined;
  }
  if (hasKnowledgeDrafts && typeof value.canUseForKnowledgeDrafts !== "boolean") {
    return undefined;
  }

  return {
    ...(hasAnswering ? { canUseForAnswering: value.canUseForAnswering as boolean } : {}),
    ...(hasKnowledgeDrafts
      ? { canUseForKnowledgeDrafts: value.canUseForKnowledgeDrafts as boolean }
      : {}),
  };
}

function parseRuntimeEnabledRequest(value: unknown): { enabled: boolean } | undefined {
  if (!isRecord(value) || typeof value.enabled !== "boolean") {
    return undefined;
  }

  return { enabled: value.enabled };
}

function parseRuntimeCapabilityUpdateRequest(
  value: unknown,
): RuntimeCapabilityUpdateRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return undefined;
  }

  const update: RuntimeCapabilityUpdateRequest = {};
  for (const [capability, enabled] of entries) {
    if (!isRuntimeCapabilityName(capability) || typeof enabled !== "boolean") {
      return undefined;
    }

    update[capability] = enabled;
  }

  return update;
}

function isRuntimeCapabilityName(value: string): value is RuntimeCapabilityName {
  return runtimeCapabilityNames.has(value as RuntimeCapabilityName);
}

function parseDeadLetterBatchReplayRequest(
  value: unknown,
): DeadLetterBatchReplayRequest | undefined {
  if (!isRecord(value) || !Array.isArray(value.ids)) {
    return undefined;
  }
  if (value.ids.length === 0 || value.ids.length > 100) {
    return undefined;
  }

  const ids = value.ids.map(readNonBlankId);
  if (ids.some((id) => id === undefined)) {
    return undefined;
  }

  return { ids: Array.from(new Set(ids as string[])) };
}

function parseMemoryExtractionDeadLetterBatchReplayRequest(
  value: unknown,
): DeadLetterBatchReplayRequest | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !("ids" in value)) {
    return undefined;
  }
  return parseDeadLetterBatchReplayRequest(value);
}

function parseRegisterAuthorizedWikiDocumentRequest(
  value: unknown,
): RegisterAuthorizedWikiDocumentRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawSourceUri = readNonBlankBoundedString(
    value.sourceUri,
    maxInternalRawSourceUriLength,
  );
  const sourceUri =
    rawSourceUri === undefined ? undefined : normalizeSupportedFeishuDocumentSourceUri(rawSourceUri);
  const authorizedSpaceId = readNonBlankId(value.authorizedSpaceId);
  const title = value.title === undefined ? undefined : readNonBlankId(value.title);
  if (
    sourceUri === undefined ||
    authorizedSpaceId === undefined ||
    (title === undefined && value.title !== undefined)
  ) {
    return undefined;
  }

  return {
    sourceUri,
    authorizedSpaceId,
    ...(title === undefined ? {} : { title }),
  };
}

function parseRegisterUserSubmittedDocumentRequest(
  value: unknown,
): RegisterUserSubmittedDocumentRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawSourceUri = readNonBlankBoundedString(
    value.sourceUri,
    maxInternalRawSourceUriLength,
  );
  const sourceUri =
    rawSourceUri === undefined ? undefined : normalizeSupportedFeishuDocumentSourceUri(rawSourceUri);
  const submittedByUserId = readNonBlankId(value.submittedByUserId);
  const title = value.title === undefined ? undefined : readNonBlankId(value.title);
  if (
    sourceUri === undefined ||
    submittedByUserId === undefined ||
    (title === undefined && value.title !== undefined)
  ) {
    return undefined;
  }

  return {
    sourceUri,
    submittedByUserId,
    ...(title === undefined ? {} : { title }),
  };
}

function readNonBlankId(value: unknown): string | undefined {
  return readNonBlankBoundedString(value, maxInternalStringLength);
}

function readNonBlankBoundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

function normalizeSupportedFeishuDocumentSourceUri(sourceUri: string): string | undefined {
  const normalized = normalizeFeishuDocumentSourceUri(sourceUri);
  if (normalized === undefined || normalized.length > maxInternalSourceUriLength) {
    return undefined;
  }

  return normalized;
}

function parseLiveChatMessage(value: unknown): LiveChatMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const speaker = readNonBlankTruncatedString(
    value.speaker,
    maxAnswerDraftLiveChatSpeakerLength,
  );
  const text = readNonBlankTruncatedString(value.text, maxAnswerDraftLiveChatTextLength);
  if (speaker === undefined || text === undefined) {
    return undefined;
  }

  return { speaker, text };
}

function readNonBlankTruncatedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return truncateInternalString(trimmed, maxLength);
}

function truncateInternalString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const prefixChars = maxLength - internalTruncationMarker.length;
  return `${value.slice(0, prefixChars).trimEnd()}${internalTruncationMarker}`;
}

function isFiniteSafeMagnitudeNumberOrUndefined(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  );
}

function createBadJsonError(): Error & { statusCode: number } {
  const error = new Error("Invalid JSON");
  return Object.assign(error, { statusCode: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function startServer({
  appDependencies = {},
  createRuntimeControlRuntime = createDefaultRuntimeControlRuntime,
}: StartServerOptions = {}) {
  const internalApiToken = readInternalApiToken(process.env.IRIS_INTERNAL_API_TOKEN);
  const feishuAuthConfig = readFeishuAuthConfig();
  const host = resolveServerListenHost(
    internalApiToken,
    feishuAuthConfig.verificationToken,
  );
  const port = readServerPort();
  readBearerToken(
    appDependencies.ingressHealthToken ?? process.env.IRIS_INGRESS_HEALTH_TOKEN,
    "IRIS_INGRESS_HEALTH_TOKEN",
  );

  const runtimeControlRuntime = await createRuntimeControlRuntime();
  const {
    runtimeController: _ignoredRuntimeController,
    runtimeControl: _ignoredRuntimeControl,
    closeRuntimeControl: _ignoredCloseRuntimeControl,
    onRuntimeStartupCleanup: _ignoredRuntimeStartupCleanup,
    ...productionAppDependencies
  } = appDependencies as BuildAppDependencies;
  let runtimeStartupCleanup: Promise<void> | undefined;
  let app;
  try {
    app = buildApp({
      ...productionAppDependencies,
      internalApiToken,
      runtimeControl: runtimeControlRuntime.runtimeControl,
      closeRuntimeControl: () => runtimeControlRuntime.close(),
      onRuntimeStartupCleanup: (cleanup) => {
        runtimeStartupCleanup = cleanup;
      },
    });
  } catch (startupError) {
    try {
      await closeRuntimeResources([
        () => runtimeStartupCleanup,
        () => runtimeControlRuntime.close(),
      ]);
    } catch (cleanupError) {
      throw startupCleanupError(
        startupError,
        cleanupError,
        "Iris server composition failed and runtime-control cleanup failed",
      );
    }
    throw startupError;
  }

  try {
    await app.listen({ port, host });
  } catch (startupError) {
    try {
      await app.close();
    } catch (cleanupError) {
      throw startupCleanupError(
        startupError,
        cleanupError,
        "Iris server startup failed and runtime cleanup failed",
      );
    }
    throw startupError;
  }
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startServer();
  installGracefulShutdown(app);
}
