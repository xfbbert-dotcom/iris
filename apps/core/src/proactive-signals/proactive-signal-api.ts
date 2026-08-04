import type { FastifyInstance, FastifyReply } from "fastify";

import type { RuntimeController } from "../admin/runtime-controller.js";
import type { ConversationStateInspectionStore } from "../conversation-state/conversation-state-api.js";
import {
  planProactiveSignals,
  type ProactiveSignalCandidate,
} from "./proactive-signal-planner.js";
import type { ProactiveSignalRepository } from "./proactive-signal-repository.js";

const MAX_IDENTIFIER_CHARS = 512;
const DEFAULT_ENTITY_LIMIT = 20;
const MAX_ENTITY_LIMIT = 100;
const DEFAULT_SIGNAL_LIMIT = 10;
const DEFAULT_QUIET_THREAD_MINUTES = 24 * 60;
const DEFAULT_OVERDUE_ACTION_GRACE_MINUTES = 15;

type PreviewRequest = {
  quietThreadAfterMinutes?: number;
  overdueActionGraceMinutes?: number;
  limit?: number;
};

export function registerProactiveSignalApi(
  app: FastifyInstance,
  store: ConversationStateInspectionStore | undefined,
  repository: ProactiveSignalRepository | undefined,
  runtimeController: RuntimeController,
  {
    authenticationConfigured,
    now,
  }: {
    authenticationConfigured: boolean;
    now: () => Date;
  },
): void {
  app.post<{ Params: { groupId: string } }>(
    "/internal/proactive-signals/groups/:groupId/preview",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (store === undefined) return unavailable(reply);
      const groupId = readBoundedId(request.params.groupId);
      const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
      const parsedRequest = parsePreviewRequest(body);
      if (groupId === undefined || parsedRequest === undefined) return invalidRequest(reply);
      if (!runtimeController.canProactivelySpeak(groupId)) {
        return reply.code(403).send({ ok: false, error: "proactive_speech_disabled" });
      }

      try {
        const generatedAt = now();
        const [threads, actions] = await Promise.all([
          store.listThreads({ groupId, limit: DEFAULT_ENTITY_LIMIT }),
          store.listActions({ groupId, limit: DEFAULT_ENTITY_LIMIT }),
        ]);
        const signals = planProactiveSignals({
          groupId,
          now: generatedAt,
          threads,
          actions,
          quietThreadAfterMs: parsedRequest.quietThreadAfterMinutes * 60 * 1000,
          overdueActionGraceMs: parsedRequest.overdueActionGraceMinutes * 60 * 1000,
          limit: parsedRequest.limit,
        });

        return {
          ok: true,
          groupId,
          generatedAt: generatedAt.toISOString(),
          signals: signals.map(toResponseSignal),
        };
      } catch {
        return reply.code(500).send({ ok: false, error: "proactive_signal_preview_failed" });
      }
    },
  );

  app.post<{ Params: { groupId: string } }>(
    "/internal/proactive-signals/groups/:groupId/scan",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (store === undefined) return unavailable(reply);
      if (repository === undefined) {
        return reply.code(503).send({ ok: false, error: "proactive_signal_repository_unavailable" });
      }
      const groupId = readBoundedId(request.params.groupId);
      const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
      const parsedRequest = parsePreviewRequest(body);
      if (groupId === undefined || parsedRequest === undefined) return invalidRequest(reply);
      if (!runtimeController.canProactivelySpeak(groupId)) {
        return reply.code(403).send({ ok: false, error: "proactive_speech_disabled" });
      }

      try {
        const generatedAt = now();
        const [threads, actions] = await Promise.all([
          store.listThreads({ groupId, limit: DEFAULT_ENTITY_LIMIT }),
          store.listActions({ groupId, limit: DEFAULT_ENTITY_LIMIT }),
        ]);
        const signals = planProactiveSignals({
          groupId,
          now: generatedAt,
          threads,
          actions,
          quietThreadAfterMs: parsedRequest.quietThreadAfterMinutes * 60 * 1000,
          overdueActionGraceMs: parsedRequest.overdueActionGraceMinutes * 60 * 1000,
          limit: parsedRequest.limit,
        });
        const recorded = await repository.recordCandidates({ signals, now: generatedAt });

        return {
          ok: true,
          groupId,
          generatedAt: generatedAt.toISOString(),
          ...recorded,
          signals: signals.map(toResponseSignal),
        };
      } catch {
        return reply.code(500).send({ ok: false, error: "proactive_signal_scan_failed" });
      }
    },
  );

  app.get<{ Params: { groupId: string } }>(
    "/internal/proactive-signals/groups/:groupId/candidates",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (repository === undefined) {
        return reply.code(503).send({ ok: false, error: "proactive_signal_repository_unavailable" });
      }
      const groupId = readBoundedId(request.params.groupId);
      const limit = readLimitFromQuery(request.query, DEFAULT_SIGNAL_LIMIT);
      if (groupId === undefined || limit === undefined) return invalidRequest(reply);
      try {
        const candidates = await repository.listPendingCandidates({ groupId, limit });
        return {
          ok: true,
          groupId,
          candidates: candidates.map(toResponseCandidate),
        };
      } catch {
        return reply.code(500).send({ ok: false, error: "proactive_signal_candidate_list_failed" });
      }
    },
  );

  app.get<{ Params: { groupId: string } }>(
    "/internal/proactive-signals/groups/:groupId/feedback-summary",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (repository === undefined) {
        return reply.code(503).send({ ok: false, error: "proactive_signal_repository_unavailable" });
      }
      const groupId = readBoundedId(request.params.groupId);
      if (groupId === undefined) return invalidRequest(reply);
      try {
        const summary = await repository.getFeedbackSummary({ groupId, at: now() });
        return {
          ok: true,
          groupId,
          totalCount: summary.totalCount,
          helpfulCount: summary.helpfulCount,
          irrelevantCount: summary.irrelevantCount,
          helpfulRate: summary.helpfulRate,
          activeSuppressionCount: summary.activeSuppressionCount,
          ...(summary.lastFeedbackAt === undefined
            ? {}
            : { lastFeedbackAt: summary.lastFeedbackAt.toISOString() }),
        };
      } catch {
        return reply.code(500).send({ ok: false, error: "proactive_signal_feedback_summary_failed" });
      }
    },
  );

  app.post<{ Params: { groupId: string; idempotencyKey: string } }>(
    "/internal/proactive-signals/groups/:groupId/candidates/:idempotencyKey/dismiss",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (repository === undefined) {
        return reply.code(503).send({ ok: false, error: "proactive_signal_repository_unavailable" });
      }
      const groupId = readBoundedId(request.params.groupId);
      const idempotencyKey = readBoundedId(request.params.idempotencyKey);
      const operatorHint = readBoundedId(request.headers["x-iris-operator"]);
      if (groupId === undefined || idempotencyKey === undefined || operatorHint === undefined) {
        return invalidRequest(reply);
      }
      try {
        const result = await repository.dismissCandidate({
          idempotencyKey,
          groupId,
          operatorHint,
          now: now(),
        });
        if (result.status === "not_found") {
          return reply.code(404).send({ ok: false, error: "proactive_signal_candidate_not_found" });
        }
        return { ok: true, status: result.status };
      } catch {
        return reply.code(500).send({ ok: false, error: "proactive_signal_candidate_dismiss_failed" });
      }
    },
  );

  app.post<{ Params: { groupId: string; idempotencyKey: string } }>(
    "/internal/proactive-signals/groups/:groupId/candidates/:idempotencyKey/approve-delivery",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (repository === undefined) {
        return reply.code(503).send({ ok: false, error: "proactive_signal_repository_unavailable" });
      }
      const groupId = readBoundedId(request.params.groupId);
      const idempotencyKey = readBoundedId(request.params.idempotencyKey);
      const operatorHint = readBoundedId(request.headers["x-iris-operator"]);
      if (groupId === undefined || idempotencyKey === undefined || operatorHint === undefined) {
        return invalidRequest(reply);
      }
      try {
        const result = await repository.approveCandidateForDelivery({
          idempotencyKey,
          groupId,
          operatorHint,
          now: now(),
        });
        if (result.status === "not_found") {
          return reply.code(404).send({ ok: false, error: "proactive_signal_candidate_not_found" });
        }
        if (result.status === "stale") {
          return reply.code(409).send({ ok: false, error: "proactive_signal_candidate_stale" });
        }
        return { ok: true, ...result };
      } catch {
        return reply.code(500).send({ ok: false, error: "proactive_signal_delivery_approval_failed" });
      }
    },
  );
}

function toResponseSignal(signal: ProactiveSignalCandidate) {
  return {
    ...signal,
    lastRelevantAt: signal.lastRelevantAt.toISOString(),
  };
}

function toResponseCandidate(candidate: Awaited<ReturnType<ProactiveSignalRepository["listPendingCandidates"]>>[number]) {
  return {
    ...candidate,
    lastRelevantAt: candidate.lastRelevantAt.toISOString(),
    createdAt: candidate.createdAt.toISOString(),
    updatedAt: candidate.updatedAt.toISOString(),
  };
}

function parsePreviewRequest(value: unknown): Required<PreviewRequest> | undefined {
  if (value === undefined || value === null) {
    return {
      quietThreadAfterMinutes: DEFAULT_QUIET_THREAD_MINUTES,
      overdueActionGraceMinutes: DEFAULT_OVERDUE_ACTION_GRACE_MINUTES,
      limit: DEFAULT_SIGNAL_LIMIT,
    };
  }
  if (!isRecord(value)) return undefined;
  const quietThreadAfterMinutes = readMinuteValue(
    value.quietThreadAfterMinutes,
    DEFAULT_QUIET_THREAD_MINUTES,
  );
  const overdueActionGraceMinutes = readMinuteValue(
    value.overdueActionGraceMinutes,
    DEFAULT_OVERDUE_ACTION_GRACE_MINUTES,
  );
  const limit = readLimit(value.limit, DEFAULT_SIGNAL_LIMIT);
  if (
    quietThreadAfterMinutes === undefined ||
    overdueActionGraceMinutes === undefined ||
    limit === undefined
  ) {
    return undefined;
  }
  return { quietThreadAfterMinutes, overdueActionGraceMinutes, limit };
}

function readMinuteValue(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 60 * 24 * 30) {
    return undefined;
  }
  return value;
}

function readLimit(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_ENTITY_LIMIT
  ) {
    return undefined;
  }
  return value;
}

function readLimitFromQuery(value: unknown, fallback: number): number | undefined {
  if (!isRecord(value) || value.limit === undefined) return fallback;
  if (typeof value.limit !== "string" || !/^[1-9]\d*$/u.test(value.limit)) return undefined;
  const parsed = Number(value.limit);
  return Number.isSafeInteger(parsed) && parsed <= MAX_ENTITY_LIMIT ? parsed : undefined;
}

function readBoundedId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_IDENTIFIER_CHARS
    ? normalized
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isParsedJsonBody(value: unknown): value is { parsedBody: unknown } {
  return isRecord(value) && Object.hasOwn(value, "parsedBody");
}

function authenticationUnavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "proactive_signal_api_auth_unavailable" });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "proactive_signal_store_unavailable" });
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({ ok: false, error: "invalid_request" });
}
