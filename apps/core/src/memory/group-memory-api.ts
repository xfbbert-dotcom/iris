import type { FastifyInstance, FastifyReply } from "fastify";

import {
  GROUP_MEMORY_CATEGORIES,
  GroupMemoryIdempotencyConflictError,
  GROUP_MEMORY_SCOPES,
  type GroupMemoryCategory,
  type GroupMemoryScope,
} from "./group-memory-repository.js";
import {
  GroupMemoryInputError,
  type GroupMemoryService,
} from "./group-memory-service.js";

const MAX_OPERATOR_CHARS = 512;
const MAX_LIST_LIMIT = 100;

export function registerGroupMemoryApi(
  app: FastifyInstance,
  service: GroupMemoryService | undefined,
  { authenticationConfigured }: { authenticationConfigured: boolean },
): void {
  app.get("/internal/group-memories", async (request, reply) => {
    if (!authenticationConfigured) {
      return authenticationUnavailable(reply);
    }
    if (service === undefined) {
      return unavailable(reply);
    }
    const input = parseListQuery(request.query);
    if (input === undefined) {
      return invalidRequest(reply);
    }
    try {
      return { ok: true, memories: await service.list(input) };
    } catch (error) {
      return handleOperationError(error, reply);
    }
  });

  app.post("/internal/group-memories", async (request, reply) => {
    if (!authenticationConfigured) {
      return authenticationUnavailable(reply);
    }
    if (service === undefined) {
      return unavailable(reply);
    }
    const operator = readOperator(request.headers["x-iris-operator"]);
    const input = parseCreateBody(unwrapJsonBody(request.body));
    if (operator === undefined || input === undefined) {
      return invalidRequest(reply);
    }
    try {
      const result = await service.create({
        ...input,
        origin: "operator",
        createdBy: operator,
        operatorHint: operator,
      });
      return { ok: true, ...result };
    } catch (error) {
      return handleOperationError(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/internal/group-memories/:id/corrections",
    async (request, reply) => {
      if (!authenticationConfigured) {
        return authenticationUnavailable(reply);
      }
      if (service === undefined) {
        return unavailable(reply);
      }
      const operator = readOperator(request.headers["x-iris-operator"]);
      const input = parseCorrectionBody(unwrapJsonBody(request.body));
      if (operator === undefined || input === undefined) {
        return invalidRequest(reply);
      }
      try {
        const result = await service.correct({
          memoryId: request.params.id,
          ...input,
          origin: "operator",
          createdBy: operator,
          operatorHint: operator,
        });
        return { ok: true, ...result };
      } catch (error) {
        return handleOperationError(error, reply);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/internal/group-memories/:id",
    async (request, reply) => {
      if (!authenticationConfigured) {
        return authenticationUnavailable(reply);
      }
      if (service === undefined) {
        return unavailable(reply);
      }
      const operator = readOperator(request.headers["x-iris-operator"]);
      if (operator === undefined) {
        return invalidRequest(reply);
      }
      try {
        const status = await service.delete({
          memoryId: request.params.id,
          operatorHint: operator,
        });
        if (status === "not_found") {
          return reply.code(404).send({ ok: false, error: "group_memory_not_found" });
        }
        return { ok: true, status };
      } catch (error) {
        return handleOperationError(error, reply);
      }
    },
  );
}

function parseListQuery(value: unknown): {
  groupId: string;
  limit: number;
  activeOnly: boolean;
} | undefined {
  if (!isRecord(value) || typeof value.groupId !== "string") {
    return undefined;
  }
  const limit = value.limit === undefined ? 50 : parseIntegerString(value.limit);
  const activeOnly = value.activeOnly === undefined
    ? true
    : parseBooleanString(value.activeOnly);
  if (
    limit === undefined ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT ||
    activeOnly === undefined
  ) {
    return undefined;
  }
  return { groupId: value.groupId, limit, activeOnly };
}

function parseCreateBody(value: unknown): {
  groupId: string;
  scope: GroupMemoryScope;
  category: GroupMemoryCategory;
  threadKey?: string;
  content: string;
  importance: number;
  confidence: number;
  idempotencyKey: string;
  evidenceMessageIds: string[];
} | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const scope = readEnum(value.scope, GROUP_MEMORY_SCOPES);
  const category = readEnum(value.category, GROUP_MEMORY_CATEGORIES);
  const evidenceMessageIds = readStringArray(value.evidenceMessageIds);
  if (
    typeof value.groupId !== "string" ||
    scope === undefined ||
    category === undefined ||
    (value.threadKey !== undefined && typeof value.threadKey !== "string") ||
    typeof value.content !== "string" ||
    typeof value.importance !== "number" ||
    typeof value.confidence !== "number" ||
    typeof value.idempotencyKey !== "string" ||
    evidenceMessageIds === undefined
  ) {
    return undefined;
  }
  return {
    groupId: value.groupId,
    scope,
    category,
    ...(value.threadKey === undefined ? {} : { threadKey: value.threadKey }),
    content: value.content,
    importance: value.importance,
    confidence: value.confidence,
    idempotencyKey: value.idempotencyKey,
    evidenceMessageIds,
  };
}

function parseCorrectionBody(value: unknown): {
  content: string;
  importance?: number;
  confidence?: number;
  idempotencyKey: string;
  evidenceMessageIds?: string[];
} | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const evidenceMessageIds = value.evidenceMessageIds === undefined
    ? undefined
    : readStringArray(value.evidenceMessageIds);
  if (
    typeof value.content !== "string" ||
    (value.importance !== undefined && typeof value.importance !== "number") ||
    (value.confidence !== undefined && typeof value.confidence !== "number") ||
    typeof value.idempotencyKey !== "string" ||
    (value.evidenceMessageIds !== undefined && evidenceMessageIds === undefined)
  ) {
    return undefined;
  }
  return {
    content: value.content,
    ...(value.importance === undefined ? {} : { importance: value.importance }),
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
    idempotencyKey: value.idempotencyKey,
    ...(evidenceMessageIds === undefined ? {} : { evidenceMessageIds }),
  };
}

function readOperator(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 || normalized.length > MAX_OPERATOR_CHARS
    ? undefined
    : normalized;
}

function unwrapJsonBody(value: unknown): unknown {
  if (
    isRecord(value) &&
    Object.hasOwn(value, "parsedBody") &&
    typeof value.rawBody === "string"
  ) {
    return value.parsedBody;
  }
  return value;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T)
    ? value as T
    : undefined;
}

function parseIntegerString(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseBooleanString(value: unknown): boolean | undefined {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function handleOperationError(error: unknown, reply: FastifyReply) {
  if (error instanceof GroupMemoryInputError) {
    return invalidRequest(reply);
  }
  if (error instanceof GroupMemoryIdempotencyConflictError) {
    return reply.code(409).send({
      ok: false,
      error: "group_memory_idempotency_conflict",
    });
  }
  if (error instanceof Error && error.message === "group memory not found") {
    return reply.code(404).send({ ok: false, error: "group_memory_not_found" });
  }
  if (error instanceof Error && error.message === "group memory is not active") {
    return reply.code(409).send({ ok: false, error: "group_memory_not_active" });
  }
  return reply.code(500).send({ ok: false, error: "group_memory_operation_failed" });
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({ ok: false, error: "invalid_request" });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "group_memory_service_unavailable" });
}

function authenticationUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: "group_memory_api_auth_unavailable",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
