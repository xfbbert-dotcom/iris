import Fastify from "fastify";
import { pathToFileURL } from "node:url";
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
import { readFeishuAuthConfig } from "./config/env.js";
import {
  RuntimeController,
  type RuntimeCapabilityName
} from "./admin/runtime-controller.js";
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
import type { DocumentSourceType } from "./documents/document-source-registry.js";
import type { DocumentSnapshot } from "./documents/document-snapshot-repository.js";
import {
  parseFeishuDocxDocumentId,
  parseFeishuWikiNodeToken,
} from "./documents/feishu-document-body-fetcher.js";
import { buildInternalStatusSnapshot } from "./admin/internal-status-snapshot.js";

export type BuildAppDependencies = {
  queue?: EventQueue;
  rawEventQueue?: Pick<RawEventQueue, "enqueue">;
  verifyFeishuRequest?: (request: FeishuCallbackRequest) => Promise<boolean> | boolean;
  onFeishuGatewayEnqueueError?: (error: unknown) => void;
  answerDraftOrchestrator?: Pick<AnswerDraftOrchestrator, "generateDraft">;
  auditLog?: InMemoryAuditLog;
  now?: () => Date;
  createAnswerDraftRuntime?: (
    input?: Parameters<typeof createDefaultAnswerDraftRuntime>[0],
  ) => AnswerDraftRuntime | undefined;
  createEventWorkerRuntime?: (input?: { runtimeController?: RuntimeController }) => EventWorkerRuntime | undefined;
  createReindexWorkerRuntime?: () => ReindexWorkerRuntime | undefined;
  createDocumentSyncRuntime?: () => DocumentSyncRuntime | undefined;
  runtimeController?: RuntimeController;
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
  usableForAnswering?: true;
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

export function buildApp(dependencies: BuildAppDependencies = {}) {
  const queue = dependencies.queue ?? new InMemoryEventQueue();
  const auditLog = dependencies.auditLog ?? new InMemoryAuditLog();
  const now = dependencies.now ?? (() => new Date());
  const runtimeController =
    dependencies.runtimeController ?? new RuntimeController(createDefaultRuntimeConfig());
  const answerDraftRuntime =
    dependencies.answerDraftOrchestrator === undefined
      ? (dependencies.createAnswerDraftRuntime ?? createDefaultAnswerDraftRuntime)({
          dependencies: { auditLog },
          runtimeController,
        })
      : undefined;
  const answerDraftOrchestrator =
    dependencies.answerDraftOrchestrator ?? answerDraftRuntime?.answerDraftOrchestrator;
  const reindexWorkerRuntime =
    (dependencies.createReindexWorkerRuntime ?? createReindexWorkerRuntime)();
  reindexWorkerRuntime?.start();
  const eventWorkerRuntime =
    (dependencies.createEventWorkerRuntime ?? createEventWorkerRuntime)({ runtimeController });
  eventWorkerRuntime?.start();
  const documentSyncRuntime =
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
        message: error instanceof Error ? error.message : String(error),
        recordedAt: now().toISOString(),
      };
      dependencies.onFeishuGatewayEnqueueError?.(error);
    },
    runtimeController,
  });
  const app = Fastify({ logger: false });

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
    const components = {
      audit: {
        ok: true,
        enabled: true,
        storage: "in_memory",
        retention: auditLog.retention,
      },
      answerDraft: {
        ok: true,
        enabled: answerDraftOrchestrator !== undefined,
      },
      feishuGateway: getFeishuGatewayStatus(feishuGatewayStatus),
      eventWorker: await getEventWorkerStatus(eventWorkerRuntime),
      documentSync: await getDocumentSyncStatus(documentSyncRuntime),
      reindex: await getReindexStatus(reindexWorkerRuntime),
    };

    return buildInternalStatusSnapshot({ components, generatedAt: now() });
  });

  app.get("/internal/runtime-control/status", async () => ({
    ok: true,
    ...runtimeController.getSnapshot(),
  }));

  app.post("/internal/runtime-control/global", async (request, reply) => {
    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseRuntimeEnabledRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    if (parsedRequest.enabled) {
      runtimeController.enableGlobal();
    } else {
      runtimeController.disableGlobal();
    }

    return {
      ok: true,
      ...runtimeController.getSnapshot(),
    };
  });

  app.post("/internal/runtime-control/groups/:groupId", async (request, reply) => {
    const groupId = readNonBlankId((request.params as { groupId?: unknown }).groupId);
    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseRuntimeEnabledRequest(body);
    if (groupId === undefined || parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    if (parsedRequest.enabled) {
      runtimeController.enableGroup(groupId);
    } else {
      runtimeController.disableGroup(groupId);
    }

    return {
      ok: true,
      ...runtimeController.getSnapshot(),
    };
  });

  app.patch("/internal/runtime-control/capabilities", async (request, reply) => {
    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseRuntimeCapabilityUpdateRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    for (const [capability, enabled] of Object.entries(parsedRequest) as Array<
      [RuntimeCapabilityName, boolean]
    >) {
      runtimeController.setCapability(capability, enabled);
    }

    return {
      ok: true,
      ...runtimeController.getSnapshot(),
    };
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
          observedAt: new Date(),
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
          observedAt: new Date(),
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

  app.addHook("onClose", async () => {
    await documentSyncRuntime?.close();
    await eventWorkerRuntime?.close();
    await reindexWorkerRuntime?.close();
    await answerDraftRuntime?.close();
  });

  return app;
}

function getFeishuGatewayStatus(state: FeishuGatewayStatusState) {
  return {
    ok: state.latestEnqueueError === undefined,
    enabled: true,
    enqueueFailureCount: state.enqueueFailureCount,
    ...(state.latestEnqueueError === undefined
      ? {}
      : { latestEnqueueError: state.latestEnqueueError }),
  };
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

  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (question.length === 0 || !Array.isArray(value.liveChatMessages)) {
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

  if (!isFiniteNumberOrUndefined(value.fragmentLimit) || !isFiniteNumberOrUndefined(value.liveChatLimit)) {
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

async function getEventWorkerStatus(runtime: EventWorkerRuntime | undefined) {
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
      error: "event_worker_status_failed",
    };
  }
}

async function getDocumentSyncStatus(runtime: DocumentSyncRuntime | undefined) {
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
      error: "document_sync_status_failed",
    };
  }
}

async function getReindexStatus(runtime: ReindexWorkerRuntime | undefined) {
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
      error: "reindex_status_failed",
    };
  }
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
  if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit <= 0) {
    return undefined;
  }

  return { embeddingProfileId, limit: value.limit };
}

function parseDeadLetterLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return 20;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
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
  if (
    limit === undefined ||
    (documentId === undefined && value.documentId !== undefined) ||
    type === false
  ) {
    return undefined;
  }

  return {
    limit,
    ...(documentId === undefined ? {} : { documentId }),
    ...(type === undefined ? {} : { type }),
  };
}

function matchesAuditEventQuery(
  event: RecordedAuditEvent,
  query: Pick<AuditEventSummaryQuery, "documentId" | "type">,
): boolean {
  return (
    (query.documentId === undefined || event.documentId === query.documentId) &&
    (query.type === undefined || event.type === query.type)
  );
}

function getAuditEventDiagnostics(auditLog: InMemoryAuditLog, query: AuditEventSummaryQuery) {
  const inspectedEvents = query.limit <= 0 ? [] : auditLog.events.slice(-query.limit);
  const matchingEvents = inspectedEvents.filter((event) => matchesAuditEventQuery(event, query));

  return {
    matchingEvents,
    meta: {
      limit: query.limit,
      maxEventCount: auditLog.retention.maxEventCount,
      retainedEventCount: auditLog.retention.retainedEventCount,
      droppedEventCount: auditLog.retention.droppedEventCount,
      inspectedEventCount: inspectedEvents.length,
      matchingEventCount: matchingEvents.length,
      filters: {
        ...(query.documentId === undefined ? {} : { documentId: query.documentId }),
        ...(query.type === undefined ? {} : { type: query.type }),
      },
    },
  };
}

function parseAuditEventType(value: unknown): AuditEvent["type"] | false | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return false;
  }

  const type = value.trim();
  return type === "permission_guard_denied" || type === "permission_guard_error" ? type : false;
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
    usableForAnswering === false ||
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

function parseUsableForAnswering(value: unknown): true | false | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value === "true" ? true : false;
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

  return { ids: ids as string[] };
}

function parseRegisterAuthorizedWikiDocumentRequest(
  value: unknown,
): RegisterAuthorizedWikiDocumentRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sourceUri = readNonBlankId(value.sourceUri);
  const authorizedSpaceId = readNonBlankId(value.authorizedSpaceId);
  const title = value.title === undefined ? undefined : readNonBlankId(value.title);
  if (
    sourceUri === undefined ||
    !isSupportedFeishuDocumentSourceUri(sourceUri) ||
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

  const sourceUri = readNonBlankId(value.sourceUri);
  const submittedByUserId = readNonBlankId(value.submittedByUserId);
  const title = value.title === undefined ? undefined : readNonBlankId(value.title);
  if (
    sourceUri === undefined ||
    !isSupportedFeishuDocumentSourceUri(sourceUri) ||
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isSupportedFeishuDocumentSourceUri(sourceUri: string): boolean {
  return (
    parseFeishuDocxDocumentId(sourceUri) !== undefined ||
    parseFeishuWikiNodeToken(sourceUri) !== undefined
  );
}

function parseLiveChatMessage(value: unknown): LiveChatMessage | undefined {
  if (!isRecord(value) || typeof value.speaker !== "string" || typeof value.text !== "string") {
    return undefined;
  }

  const speaker = value.speaker.trim();
  const text = value.text.trim();
  if (speaker.length === 0 || text.length === 0) {
    return undefined;
  }

  return { speaker, text };
}

function isFiniteNumberOrUndefined(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function createBadJsonError(): Error & { statusCode: number } {
  const error = new Error("Invalid JSON");
  return Object.assign(error, { statusCode: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
}
