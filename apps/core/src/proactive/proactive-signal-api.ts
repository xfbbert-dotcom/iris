import type { FastifyInstance, FastifyReply } from "fastify";

import {
  PROACTIVE_SIGNAL_CANDIDATE_STATUSES,
  type ProactiveSignalCandidateStatus,
} from "./proactive-signal-candidate.js";
import type { ProactiveSignalRuntime } from "../runtime/proactive-signal-runtime.js";

const MAX_IDENTIFIER_CHARS = 512;
const MAX_LIST_LIMIT = 100;

export function registerProactiveSignalApi(
  app: FastifyInstance,
  runtime: ProactiveSignalRuntime | undefined,
  {
    authenticationConfigured,
    now = () => new Date(),
  }: {
    authenticationConfigured: boolean;
    now?: () => Date;
  },
): void {
  app.get("/internal/proactive/status", async (_request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      return { ok: true, ...(await runtime.getStatus()) };
    } catch {
      return operationFailed(reply);
    }
  });

  app.get("/internal/proactive/candidates", async (request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    const parsed = parseListQuery(request.query);
    if (parsed === undefined) return invalidRequest(reply);
    try {
      return {
        ok: true,
        groupId: parsed.groupId,
        candidates: await runtime.repository.listCandidates(parsed),
      };
    } catch {
      return operationFailed(reply);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/internal/proactive/candidates/:id",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      const id = readBoundedString(request.params.id);
      const groupId = readQueryGroupId(request.query);
      if (id === undefined || groupId === undefined) return invalidRequest(reply);
      try {
        const candidate = await runtime.repository.getCandidate({ id, groupId });
        if (candidate === undefined) {
          return reply.code(404).send({ ok: false, error: "proactive_candidate_not_found" });
        }
        return { ok: true, candidate };
      } catch {
        return operationFailed(reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/internal/proactive/candidates/:id/dismiss",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      const id = readBoundedString(request.params.id);
      const parsed = parseDismissBody(unwrapBody(request.body));
      if (id === undefined || parsed === undefined) return invalidRequest(reply);
      let at: Date;
      try {
        at = requireDate(now());
      } catch {
        return operationFailed(reply);
      }
      try {
        const candidate = await runtime.repository.dismissCandidate({ id, ...parsed, at });
        if (candidate === "conflict") {
          return reply.code(409).send({ ok: false, error: "proactive_candidate_conflict" });
        }
        return { ok: true, candidate };
      } catch {
        return operationFailed(reply);
      }
    },
  );

  app.post("/internal/proactive/scans", async (_request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      return { ok: true, result: await runtime.scanNow() };
    } catch {
      return operationFailed(reply);
    }
  });
}

function parseListQuery(value: unknown): {
  groupId: string;
  statuses?: ProactiveSignalCandidateStatus[];
  limit: number;
} | undefined {
  if (!isRecord(value)) return undefined;
  const groupId = readBoundedString(value.groupId);
  const limit = readLimit(value.limit, 20);
  const statuses = readStatuses(value.status);
  if (groupId === undefined || limit === undefined || statuses === false) return undefined;
  return {
    groupId,
    ...(statuses === undefined ? {} : { statuses }),
    limit,
  };
}

function readQueryGroupId(value: unknown): string | undefined {
  return isRecord(value) ? readBoundedString(value.groupId) : undefined;
}

function parseDismissBody(value: unknown): {
  groupId: string;
  expectedVersion: number;
  dismissedBy: string;
  dismissalReason?: string;
} | undefined {
  if (!isRecord(value)) return undefined;
  const groupId = readBoundedString(value.groupId);
  const dismissedBy = readBoundedString(value.dismissedBy);
  const dismissalReason = value.dismissalReason === undefined
    ? undefined
    : readBoundedString(value.dismissalReason);
  if (
    groupId === undefined ||
    dismissedBy === undefined ||
    !Number.isSafeInteger(value.expectedVersion) ||
    Number(value.expectedVersion) < 1 ||
    (value.dismissalReason !== undefined && dismissalReason === undefined)
  ) return undefined;
  return {
    groupId,
    expectedVersion: Number(value.expectedVersion),
    dismissedBy,
    ...(dismissalReason === undefined ? {} : { dismissalReason }),
  };
}

function readStatuses(
  value: unknown,
): ProactiveSignalCandidateStatus[] | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return false;
  const statuses = value.split(",").map((status) => status.trim());
  if (
    statuses.length < 1 ||
    statuses.length > PROACTIVE_SIGNAL_CANDIDATE_STATUSES.length ||
    new Set(statuses).size !== statuses.length ||
    statuses.some((status) =>
      !PROACTIVE_SIGNAL_CANDIDATE_STATUSES.includes(status as ProactiveSignalCandidateStatus))
  ) return false;
  return statuses as ProactiveSignalCandidateStatus[];
}

function readLimit(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_LIST_LIMIT ? parsed : undefined;
}

function readBoundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_IDENTIFIER_CHARS
    ? normalized
    : undefined;
}

function unwrapBody(value: unknown): unknown {
  return isRecord(value) && Object.hasOwn(value, "parsedBody") ? value.parsedBody : value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("proactive API time is invalid");
  }
  return new Date(value);
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({ ok: false, error: "invalid_request" });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "proactive_signal_runtime_unavailable" });
}

function authenticationUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: "proactive_signal_api_auth_unavailable",
  });
}

function operationFailed(reply: FastifyReply) {
  return reply.code(500).send({ ok: false, error: "proactive_signal_operation_failed" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
