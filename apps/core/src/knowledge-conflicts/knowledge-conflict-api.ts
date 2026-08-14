import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  KnowledgeConflictCurrentValidationResult,
  KnowledgeConflictCurrentValidator,
} from "./knowledge-conflict-current-validator.js";

import {
  KNOWLEDGE_CONFLICT_CANDIDATE_STATUSES,
  type KnowledgeConflictCandidate,
  type KnowledgeConflictCandidateStatus,
  type KnowledgeConflictEvidenceReference,
} from "./knowledge-conflict.js";
import {
  KnowledgeConflictDeliveryConflictError,
  KnowledgeConflictLeaseConflictError,
  KnowledgeConflictNotFoundError,
  KnowledgeConflictOperationConflictError,
  KnowledgeConflictStaleEvidenceError,
  KnowledgeConflictVersionConflictError,
  type KnowledgeConflictCandidateEvent,
  type KnowledgeConflictRepository,
  type KnowledgeConflictScan,
} from "./knowledge-conflict-repository.js";

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_REFERENCE_CHARS = 512;
const MAX_REASON_CHARS = 128;
const STALE_REASON_CODES = new Set([
  "scan_identity_mismatch",
  "memory_stale",
  "message_stale",
  "source_stale",
  "snapshot_stale",
  "fragment_stale",
  "permission_stale",
]);
const SCAN_ERROR_CODES = new Set([
  "scan_attempts_exhausted",
  "outcome_already_counted",
  "impossible_evidence_identity",
  "malformed_persisted_facts",
  "operation_conflict",
  "internal_error",
  "permission_check_failed",
  "provider_capacity",
  "provider_unavailable",
  "provider_transport",
  "provider_rejected",
  "provider_invalid_response",
  "scanner_failed",
]);

export type KnowledgeConflictApiRuntime = {
  repository: KnowledgeConflictRepository;
  currentValidator: KnowledgeConflictCurrentValidator;
};

export function registerKnowledgeConflictApi(
  app: FastifyInstance,
  runtime: KnowledgeConflictApiRuntime | undefined,
  {
    authenticationConfigured,
    now = () => new Date(),
  }: {
    authenticationConfigured: boolean;
    now?: () => Date;
  },
): void {
  app.get("/internal/knowledge-conflicts/status", async (_request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      const [scans, candidates, deliveries, interactions] = await Promise.all([
        runtime.repository.getScanStatusCounts(),
        runtime.repository.getCandidateStatusCounts(),
        runtime.repository.getDeliveryStatusCounts(),
        runtime.repository.getInteractionResultCounts(),
      ]);
      return { ok: true, scans, candidates, deliveries, interactions };
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { groupId: string } }>(
    "/internal/knowledge-conflicts/groups/:groupId/candidates",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const groupId = requireReference("groupId", request.params.groupId);
        const query = requireRecord(request.query, "query");
        assertOnlyKeys(query, ["status", "limit"]);
        const statuses = query.status === undefined ? undefined : parseStatuses(query.status);
        const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : parseLimit(query.limit);
        const candidates = await runtime.repository.listCandidates({
          groupId,
          ...(statuses === undefined ? {} : { statuses }),
          limit,
        });
        return {
          ok: true,
          groupId,
          candidates: candidates
            .filter((candidate) => candidate.groupId === groupId)
            .map(toCandidateSummary),
        };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  app.get<{ Params: { groupId: string; candidateId: string } }>(
    "/internal/knowledge-conflicts/groups/:groupId/candidates/:candidateId",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const groupId = requireReference("groupId", request.params.groupId);
        const candidate = await loadScopedCandidate(
          runtime.repository,
          groupId,
          requireReference("candidateId", request.params.candidateId),
        );
        if (candidate === undefined) return candidateNotFound(reply);
        const validation = candidate.status === "superseded"
          ? { status: "superseded" as const, candidate, reason: "evidence_stale" }
          : await runtime.currentValidator.validate({
              candidate,
              expectedVersion: candidate.version,
            });
        const validatedCandidate = validation.candidate;
        const delivery = await runtime.repository.getDeliveryForCandidate(validatedCandidate.id);
        return {
          ok: true,
          candidate: toCandidateDetail(validatedCandidate, validation),
          ...(delivery === undefined ? {} : {
            delivery: {
              deliveryId: delivery.id,
              status: delivery.status,
              attemptCount: delivery.attemptCount,
              ...(delivery.reconciliationDueAt === undefined
                ? {}
                : { reconciliationDueAt: delivery.reconciliationDueAt.toISOString() }),
            },
          }),
        };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  app.get<{ Params: { groupId: string; candidateId: string } }>(
    "/internal/knowledge-conflicts/groups/:groupId/candidates/:candidateId/events",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const groupId = requireReference("groupId", request.params.groupId);
        const candidateId = requireReference("candidateId", request.params.candidateId);
        const query = requireRecord(request.query, "query");
        assertOnlyKeys(query, ["limit"]);
        const candidate = await loadScopedCandidate(runtime.repository, groupId, candidateId);
        if (candidate === undefined) return candidateNotFound(reply);
        const limit = query.limit === undefined ? DEFAULT_EVENT_LIMIT : parseLimit(query.limit);
        return {
          ok: true,
          candidateId,
          events: (await runtime.repository.listCandidateEvents({ candidateId, limit })).map(toEvent),
        };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  app.post<{ Params: { groupId: string; candidateId: string } }>(
    "/internal/knowledge-conflicts/groups/:groupId/candidates/:candidateId/dismiss",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const groupId = requireReference("groupId", request.params.groupId);
        const candidateId = requireReference("candidateId", request.params.candidateId);
        const body = parseGovernanceBody(unwrapBody(request.body));
        const actorRef = requireOperator(request.headers["x-iris-operator"]);
        if (await loadScopedCandidate(runtime.repository, groupId, candidateId) === undefined) {
          return candidateNotFound(reply);
        }
        const result = await runtime.repository.dismissCandidate({
          candidateId,
          expectedVersion: body.expectedVersion,
          operationKey: body.operationKey,
          actorType: "admin_role",
          actorRef,
          reasonCode: body.reason,
          at: requireDate(now()),
        });
        return toMutationResponse(result);
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  app.post<{ Params: { groupId: string; candidateId: string } }>(
    "/internal/knowledge-conflicts/groups/:groupId/candidates/:candidateId/approve-delivery",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const groupId = requireReference("groupId", request.params.groupId);
        const candidateId = requireReference("candidateId", request.params.candidateId);
        const body = parseGovernanceBody(unwrapBody(request.body));
        const actorRef = requireOperator(request.headers["x-iris-operator"]);
        const candidate = await loadScopedCandidate(runtime.repository, groupId, candidateId);
        if (candidate === undefined) {
          return candidateNotFound(reply);
        }
        if (candidate.version !== body.expectedVersion) {
          throw new KnowledgeConflictVersionConflictError();
        }
        const validation = await runtime.currentValidator.validate({
          candidate,
          expectedVersion: body.expectedVersion,
        });
        if (validation.status === "validation_unavailable") {
          return reply.code(503).send({
            ok: false,
            error: "knowledge_conflict_validation_unavailable",
          });
        }
        if (validation.status !== "current") {
          return reply.code(409).send({
            ok: false,
            error: "knowledge_conflict_validation_required",
            currentValidation: toCurrentValidation(validation),
          });
        }
        const result = await runtime.repository.approveForDelivery({
          candidateId,
          expectedVersion: body.expectedVersion,
          operationKey: body.operationKey,
          actorType: "admin_role",
          actorRef,
          reasonCode: body.reason,
          at: requireDate(now()),
        });
        return {
          ...toMutationResponse(result),
          deliveryId: result.delivery.id,
        };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  app.get("/internal/knowledge-conflicts/scans/dead-letters", async (request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      const query = requireRecord(request.query, "query");
      assertOnlyKeys(query, ["limit"]);
      const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : parseLimit(query.limit);
      return {
        ok: true,
        deadLetters: (await runtime.repository.listDeadLetterScans({ limit })).map(toDeadLetter),
      };
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { scanId: string } }>(
    "/internal/knowledge-conflicts/scans/dead-letters/:scanId/replay",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const actorRef = requireOperator(request.headers["x-iris-operator"]);
        const body = parseScanOperationBody(unwrapBody(request.body));
        const scanId = requireReference("scanId", request.params.scanId);
        const result = await runtime.repository.replayDeadLetterScan({
          scanId,
          expectedAttemptCount: body.expectedAttemptCount,
          expectedUpdatedAt: body.expectedUpdatedAt,
          operationKey: body.operationKey,
          actorRef,
          at: requireDate(now()),
        });
        return { ok: true, outcome: "replayed", scanId, status: result.status };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  app.delete<{ Params: { scanId: string } }>(
    "/internal/knowledge-conflicts/scans/dead-letters/:scanId",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const actorRef = requireOperator(request.headers["x-iris-operator"]);
        const body = parseScanOperationBody(unwrapBody(request.body));
        const scanId = requireReference("scanId", request.params.scanId);
        await runtime.repository.deleteDeadLetterScan({
          scanId,
          expectedAttemptCount: body.expectedAttemptCount,
          expectedUpdatedAt: body.expectedUpdatedAt,
          operationKey: body.operationKey,
          actorRef,
          at: requireDate(now()),
        });
        return { ok: true, outcome: "deleted", scanId };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  app.post<{ Params: { deliveryId: string } }>(
    "/internal/knowledge-conflicts/deliveries/:deliveryId/reconcile",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const actorRef = requireOperator(request.headers["x-iris-operator"]);
        const deliveryId = requireReference("deliveryId", request.params.deliveryId);
        const body = parseReconciliationBody(unwrapBody(request.body));
        const delivery = await runtime.repository.reconcileDelivery({
          deliveryId,
          expectedAttemptCount: body.expectedAttemptCount,
          outcome: body.outcome,
          operationKey: body.operationKey,
          actorRef,
          ...(body.messageId === undefined ? {} : { messageId: body.messageId }),
          at: requireDate(now()),
        });
        return { ok: true, outcome: "reconciled", deliveryId, status: delivery.status };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );
}

async function loadScopedCandidate(
  repository: KnowledgeConflictRepository,
  groupId: string,
  candidateId: string,
): Promise<KnowledgeConflictCandidate | undefined> {
  const candidate = await repository.getCandidate(candidateId);
  return candidate?.groupId === groupId ? candidate : undefined;
}

function toCandidateSummary(candidate: KnowledgeConflictCandidate) {
  return {
    candidateId: candidate.id,
    groupId: candidate.groupId,
    status: candidate.status,
    candidateVersion: candidate.version,
    subject: candidate.plan.subject,
    knowledgeBaseStatement: candidate.plan.knowledgeBaseStatement,
    groupConclusionStatement: candidate.plan.groupConclusionStatement,
    difference: candidate.plan.difference,
    suggestedUpdate: candidate.plan.suggestedUpdate,
    confidence: candidate.plan.confidence,
    target: {
      documentSourceId: candidate.targetDocumentSourceId,
      snapshotId: candidate.targetSnapshotId,
      ...(candidate.targetSourceVersion === undefined
        ? {}
        : { sourceVersion: candidate.targetSourceVersion }),
      sourceUpdatedAt: candidate.targetSourceUpdatedAt.toISOString(),
      snapshotContentHash: candidate.targetContentHash,
    },
    currentValidation: candidate.status === "superseded"
      ? { status: "superseded" }
      : { status: "requires_revalidation" },
    createdAt: candidate.createdAt.toISOString(),
    updatedAt: candidate.updatedAt.toISOString(),
  };
}

function toCandidateDetail(
  candidate: KnowledgeConflictCandidate,
  validation: KnowledgeConflictCurrentValidationResult,
) {
  return {
    ...toCandidateSummary(candidate),
    currentValidation: toCurrentValidation(validation),
    evidence: candidate.evidence.map(toEvidenceIdentity),
  };
}

function toCurrentValidation(validation: KnowledgeConflictCurrentValidationResult) {
  if (validation.status === "superseded") {
    return {
      status: validation.status,
      reason: STALE_REASON_CODES.has(validation.reason) ? validation.reason : "evidence_stale",
    };
  }
  return { status: validation.status };
}

function toEvidenceIdentity(evidence: KnowledgeConflictEvidenceReference) {
  switch (evidence.type) {
    case "conversation_message":
      return {
        type: evidence.type,
        referenceId: evidence.referenceId,
        groupId: evidence.groupId,
        conversationMessageId: evidence.conversationMessageId,
      };
    case "group_memory":
      return {
        type: evidence.type,
        referenceId: evidence.referenceId,
        groupId: evidence.groupId,
        groupMemoryId: evidence.groupMemoryId,
        expectedUpdatedAt: evidence.expectedUpdatedAt.toISOString(),
      };
    case "document_source":
      return {
        type: evidence.type,
        referenceId: evidence.referenceId,
        documentSourceId: evidence.documentSourceId,
        expectedUpdatedAt: evidence.expectedUpdatedAt.toISOString(),
      };
    case "document_snapshot":
      return {
        type: evidence.type,
        referenceId: evidence.referenceId,
        documentSourceId: evidence.documentSourceId,
        documentSnapshotId: evidence.documentSnapshotId,
        contentHash: evidence.contentHash,
      };
    case "document_fragment":
      return {
        type: evidence.type,
        referenceId: evidence.referenceId,
        documentSourceId: evidence.documentSourceId,
        documentSnapshotId: evidence.documentSnapshotId,
        documentFragmentId: evidence.documentFragmentId,
        snapshotContentHash: evidence.snapshotContentHash,
        contentHash: evidence.contentHash,
      };
  }
}

function toEvent(event: KnowledgeConflictCandidateEvent) {
  return {
    eventId: event.id,
    actorType: event.actorType,
    ...(event.fromStatus === undefined ? {} : { fromStatus: event.fromStatus }),
    toStatus: event.toStatus,
    ...(event.fromVersion === undefined ? {} : { fromVersion: event.fromVersion }),
    toVersion: event.toVersion,
    reason: event.reasonCode,
    createdAt: event.createdAt.toISOString(),
  };
}

function toDeadLetter(scan: KnowledgeConflictScan) {
  return {
    scanId: scan.id,
    groupId: scan.groupId,
    status: scan.status,
    attemptCount: scan.attemptCount,
    nextAttemptAt: scan.nextAttemptAt.toISOString(),
    ...(scan.lastErrorCode === undefined ? {} : {
      errorCode: SCAN_ERROR_CODES.has(scan.lastErrorCode) ? scan.lastErrorCode : "internal_error",
    }),
    createdAt: scan.createdAt.toISOString(),
    updatedAt: scan.updatedAt.toISOString(),
  };
}

function toMutationResponse(result: {
  outcome: "applied" | "already_applied";
  candidate: KnowledgeConflictCandidate;
}) {
  return {
    ok: true,
    outcome: result.outcome,
    candidateId: result.candidate.id,
    candidateVersion: result.candidate.version,
  };
}

function parseGovernanceBody(value: unknown) {
  const body = requireRecord(value, "request");
  assertOnlyKeys(body, ["expectedVersion", "reason", "operationKey"]);
  return {
    expectedVersion: requirePositiveInteger("expectedVersion", body.expectedVersion),
    reason: requireString("reason", body.reason, MAX_REASON_CHARS),
    operationKey: requireReference("operationKey", body.operationKey),
  };
}

function parseReconciliationBody(value: unknown): {
  expectedAttemptCount: number;
  outcome: "sent" | "not_sent";
  operationKey: string;
  messageId?: string;
} {
  const body = requireRecord(value, "request");
  assertOnlyKeys(body, ["expectedAttemptCount", "outcome", "operationKey", "messageId"]);
  if (body.outcome !== "sent" && body.outcome !== "not_sent") {
    throw validationError("outcome is invalid");
  }
  const operationKey = requireReference("operationKey", body.operationKey);
  const expectedAttemptCount = requirePositiveInteger(
    "expectedAttemptCount",
    body.expectedAttemptCount,
  );
  if (body.outcome === "sent") {
    return {
      outcome: body.outcome,
      expectedAttemptCount,
      operationKey,
      messageId: requireReference("messageId", body.messageId),
    };
  }
  if (body.messageId !== undefined) throw validationError("messageId is invalid");
  return { outcome: body.outcome, expectedAttemptCount, operationKey };
}

function parseScanOperationBody(value: unknown) {
  const body = requireRecord(value, "request");
  assertOnlyKeys(body, ["expectedAttemptCount", "expectedUpdatedAt", "operationKey"]);
  return {
    expectedAttemptCount: requirePositiveInteger("expectedAttemptCount", body.expectedAttemptCount),
    expectedUpdatedAt: requireIsoDate("expectedUpdatedAt", body.expectedUpdatedAt),
    operationKey: requireReference("operationKey", body.operationKey),
  };
}

function requireIsoDate(name: string, value: unknown): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw validationError(`${name} is invalid`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw validationError(`${name} is invalid`);
  }
  return parsed;
}

function parseStatuses(value: unknown): KnowledgeConflictCandidateStatus[] {
  if (typeof value !== "string") throw validationError("status is invalid");
  const statuses = value.split(",");
  if (statuses.length === 0 || new Set(statuses).size !== statuses.length
    || statuses.some((status) => !KNOWLEDGE_CONFLICT_CANDIDATE_STATUSES.includes(
      status as KnowledgeConflictCandidateStatus,
    ))) throw validationError("status is invalid");
  return statuses as KnowledgeConflictCandidateStatus[];
}

function parseLimit(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw validationError("limit is invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_LIST_LIMIT) {
    throw validationError("limit is invalid");
  }
  return parsed;
}

function requireOperator(value: string | string[] | undefined): string {
  if (Array.isArray(value) || typeof value !== "string") {
    throw validationError("operator is invalid");
  }
  return requireReference("operator", value);
}

function requireReference(name: string, value: unknown): string {
  return requireString(name, value, MAX_REFERENCE_CHARS);
}

function requireString(name: string, value: unknown, maximum: number): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw validationError(`${name} is invalid`);
  }
  return value;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw validationError(`${name} is invalid`);
  }
  return value as number;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw validationError("time is invalid");
  }
  return new Date(value);
}

function unwrapBody(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.hasOwn(value, "parsedBody") ? value.parsedBody : value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw validationError(`${name} must be an object`);
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw validationError("unknown field");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof KnowledgeConflictNotFoundError) return candidateNotFound(reply);
  if (error instanceof KnowledgeConflictVersionConflictError) {
    return reply.code(409).send({ ok: false, error: "knowledge_conflict_version_conflict" });
  }
  if (error instanceof KnowledgeConflictOperationConflictError) {
    return reply.code(409).send({ ok: false, error: "knowledge_conflict_operation_conflict" });
  }
  if (error instanceof KnowledgeConflictStaleEvidenceError) {
    return reply.code(409).send({
      ok: false,
      error: "knowledge_conflict_evidence_stale",
      reason: STALE_REASON_CODES.has(error.reasonCode) ? error.reasonCode : "evidence_stale",
    });
  }
  if (error instanceof KnowledgeConflictDeliveryConflictError) {
    return reply.code(409).send({ ok: false, error: "knowledge_conflict_delivery_conflict" });
  }
  if (error instanceof KnowledgeConflictLeaseConflictError) {
    return reply.code(409).send({ ok: false, error: "knowledge_conflict_scan_conflict" });
  }
  if (error instanceof ApiValidationError) {
    return reply.code(400).send({ ok: false, error: "invalid_request" });
  }
  return unavailable(reply);
}

function candidateNotFound(reply: FastifyReply) {
  return reply.code(404).send({ ok: false, error: "knowledge_conflict_candidate_not_found" });
}

function authenticationUnavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "internal_authentication_unavailable" });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "knowledge_conflict_runtime_unavailable" });
}

class ApiValidationError extends Error {}

function validationError(message: string): ApiValidationError {
  return new ApiValidationError(message);
}
