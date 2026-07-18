import type { FastifyInstance, FastifyReply } from "fastify";

import {
  KNOWLEDGE_DRAFT_ORIGIN_KINDS,
  KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS,
  KNOWLEDGE_DRAFT_REASON_MAX_CHARS,
  KNOWLEDGE_DRAFT_RISK_LEVELS,
  KNOWLEDGE_DRAFT_STATUSES,
  KnowledgeDraftValidationError,
  normalizeKnowledgeDraftRevisionInput,
  type KnowledgeDraftEvidenceReference,
  type KnowledgeDraftOriginKind,
  type KnowledgeDraftRevisionInput,
  type KnowledgeDraftRiskLevel,
  type KnowledgeDraftStatus,
} from "./knowledge-draft.js";
import {
  KnowledgeDraftEvidenceError,
  KnowledgeDraftNotFoundError,
  KnowledgeDraftOperationConflictError,
  KnowledgeDraftTransitionError,
  KnowledgeDraftVersionConflictError,
} from "./postgres-knowledge-draft-repository.js";
import type { KnowledgeDraftRuntime } from "../runtime/knowledge-draft-runtime.js";

const MAX_LIST_LIMIT = 100;

export function registerKnowledgeDraftApi(
  app: FastifyInstance,
  runtime: KnowledgeDraftRuntime | undefined,
  {
    authenticationConfigured,
    now = () => new Date(),
  }: {
    authenticationConfigured: boolean;
    now?: () => Date;
  },
): void {
  app.get("/internal/knowledge-drafts/status", async (_request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      return { ok: true, ...(await runtime.getStatus()) };
    } catch (error) {
      return handleKnowledgeDraftError(reply, error);
    }
  });

  app.post("/internal/knowledge-drafts", async (request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      const input = parseCreateRequest(unwrapBody(request.body), now());
      if (!runtime.canCreateDraft({
        ...(input.revision.sourceGroupId === undefined
          ? {}
          : { sourceGroupId: input.revision.sourceGroupId }),
      })) {
        return reply.code(409).send({
          ok: false,
          error: "knowledge_draft_generation_disabled",
        });
      }
      const result = await runtime.repository.createDraft(input);
      return { ok: true, ...result };
    } catch (error) {
      return handleKnowledgeDraftError(reply, error);
    }
  });

  app.get("/internal/knowledge-drafts", async (request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      const input = parseListQuery(request.query);
      return { ok: true, drafts: await runtime.repository.listDrafts(input) };
    } catch (error) {
      return handleKnowledgeDraftError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/internal/knowledge-drafts/:id",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const id = requireReference("id", request.params.id);
        const draft = await runtime.repository.getDraft(id);
        if (draft === undefined) throw new KnowledgeDraftNotFoundError();
        return { ok: true, draft };
      } catch (error) {
        return handleKnowledgeDraftError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/internal/knowledge-drafts/:id/events",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const id = requireReference("id", request.params.id);
        return { ok: true, events: await runtime.repository.listEvents(id) };
      } catch (error) {
        return handleKnowledgeDraftError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/internal/knowledge-drafts/:id/revisions",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const result = await runtime.repository.reviseDraft(
          parseReviseRequest(request.params.id, unwrapBody(request.body), now()),
        );
        return { ok: true, ...result };
      } catch (error) {
        return handleKnowledgeDraftError(reply, error);
      }
    },
  );

  for (const [path, operation] of [
    ["request-revision", "requestRevision"],
    ["reject", "rejectDraft"],
  ] as const) {
    app.post<{ Params: { id: string } }>(
      `/internal/knowledge-drafts/:id/${path}`,
      async (request, reply) => {
        if (!authenticationConfigured) return authenticationUnavailable(reply);
        if (runtime === undefined) return unavailable(reply);
        try {
          const result = await runtime.repository[operation](
            parseTransitionRequest(request.params.id, unwrapBody(request.body), now()),
          );
          return { ok: true, ...result };
        } catch (error) {
          return handleKnowledgeDraftError(reply, error);
        }
      },
    );
  }
}

function parseCreateRequest(value: unknown, at: Date) {
  const input = requireRecord(value, "request");
  return {
    id: requireReference("id", input.id),
    operationKey: requireReference("operationKey", input.operationKey),
    originKind: requireEnum("originKind", input.originKind, KNOWLEDGE_DRAFT_ORIGIN_KINDS),
    createdBy: requireReference("createdBy", input.createdBy),
    revision: parseRevision(input.revision),
    at: requireDate(at),
  };
}

function parseReviseRequest(idValue: unknown, value: unknown, at: Date) {
  const input = requireRecord(value, "request");
  return {
    id: requireReference("id", idValue),
    expectedVersion: requireVersion(input.expectedVersion),
    operationKey: requireReference("operationKey", input.operationKey),
    actor: requireReference("actor", input.actor),
    revision: parseRevision(input.revision),
    at: requireDate(at),
  };
}

function parseTransitionRequest(idValue: unknown, value: unknown, at: Date) {
  const input = requireRecord(value, "request");
  return {
    id: requireReference("id", idValue),
    expectedVersion: requireVersion(input.expectedVersion),
    operationKey: requireReference("operationKey", input.operationKey),
    actor: requireReference("actor", input.actor),
    reason: requireString("reason", input.reason, KNOWLEDGE_DRAFT_REASON_MAX_CHARS),
    at: requireDate(at),
  };
}

function parseRevision(value: unknown): KnowledgeDraftRevisionInput {
  const input = requireRecord(value, "revision");
  const rawEvidence = input.evidence;
  if (!Array.isArray(rawEvidence)) throw validationError("evidence is invalid");
  const evidence = rawEvidence.map(parseEvidenceReference);
  return normalizeKnowledgeDraftRevisionInput({
    ...input,
    evidence,
  } as KnowledgeDraftRevisionInput);
}

function parseEvidenceReference(value: unknown): KnowledgeDraftEvidenceReference {
  const input = requireRecord(value, "evidence");
  if (input.type === "document_source") {
    return {
      type: "document_source",
      id: requireReference("evidence.id", input.id),
      expectedUpdatedAt: requireIsoDate(input.expectedUpdatedAt),
    };
  }
  return input as unknown as KnowledgeDraftEvidenceReference;
}

function parseListQuery(value: unknown): {
  sourceGroupId?: string;
  statuses?: KnowledgeDraftStatus[];
  riskLevels?: KnowledgeDraftRiskLevel[];
  limit: number;
} {
  const query = requireRecord(value, "query");
  const sourceGroupId = query.groupId === undefined
    ? undefined
    : requireReference("groupId", query.groupId);
  const statuses = parseEnumList("status", query.status, KNOWLEDGE_DRAFT_STATUSES);
  const riskLevels = parseEnumList("riskLevel", query.riskLevel, KNOWLEDGE_DRAFT_RISK_LEVELS);
  const limit = query.limit === undefined ? 20 : parseLimit(query.limit);
  return {
    ...(sourceGroupId === undefined ? {} : { sourceGroupId }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(riskLevels === undefined ? {} : { riskLevels }),
    limit,
  };
}

function parseEnumList<T extends string>(
  name: string,
  value: unknown,
  allowed: readonly T[],
): T[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw validationError(`${name} is invalid`);
  const values = value.split(",");
  if (
    values.length < 1 ||
    values.some((item) => item.length < 1 || !allowed.includes(item as T)) ||
    new Set(values).size !== values.length
  ) throw validationError(`${name} is invalid`);
  return values as T[];
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

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireReference(name: string, value: unknown): string {
  return requireString(name, value, KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS);
}

function requireString(name: string, value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw validationError(`${name} is invalid`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    throw validationError(`${name} is invalid`);
  }
  return normalized;
}

function requireEnum<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw validationError(`${name} is invalid`);
  }
  return value as T;
}

function requireVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw validationError("expectedVersion is invalid");
  }
  return Number(value);
}

function requireDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw validationError("timestamp is invalid");
  return new Date(value);
}

function requireIsoDate(value: unknown): Date {
  if (typeof value !== "string") throw validationError("document timestamp is invalid");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw validationError("document timestamp is invalid");
  }
  return parsed;
}

function unwrapBody(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "parsedBody" in value
  ) {
    return (value as { parsedBody: unknown }).parsedBody;
  }
  return value;
}

function handleKnowledgeDraftError(reply: FastifyReply, error: unknown) {
  if (error instanceof KnowledgeDraftValidationError) {
    return reply.code(400).send({ ok: false, error: "invalid_request" });
  }
  if (error instanceof KnowledgeDraftNotFoundError) {
    return reply.code(404).send({ ok: false, error: "knowledge_draft_not_found" });
  }
  if (error instanceof KnowledgeDraftEvidenceError) {
    return reply.code(409).send({
      ok: false,
      error: "knowledge_draft_evidence_invalid",
      reason: error.reason,
    });
  }
  if (
    error instanceof KnowledgeDraftVersionConflictError ||
    error instanceof KnowledgeDraftOperationConflictError ||
    error instanceof KnowledgeDraftTransitionError
  ) {
    return reply.code(409).send({ ok: false, error: "knowledge_draft_conflict" });
  }
  return reply.code(500).send({ ok: false, error: "knowledge_draft_operation_failed" });
}

function authenticationUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: "knowledge_draft_api_auth_unavailable",
  });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: "knowledge_draft_runtime_unavailable",
  });
}

function validationError(message: string): KnowledgeDraftValidationError {
  return new KnowledgeDraftValidationError(message);
}
