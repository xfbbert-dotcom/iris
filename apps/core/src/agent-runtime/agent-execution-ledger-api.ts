import type { FastifyInstance, FastifyReply } from "fastify";

import {
  AGENT_EXECUTION_LEDGER_SUBJECT_TYPES,
  type AgentExecutionLedgerRepository,
  type AgentExecutionLedgerSubjectType,
  type ListAgentExecutionLedgerEventsInput,
} from "./agent-execution-ledger-repository.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_FILTER_CHARS = 512;

export function registerAgentExecutionLedgerApi(
  app: FastifyInstance,
  runtime: {
    repository: Pick<AgentExecutionLedgerRepository, "listEvents">;
  } | undefined,
): void {
  app.get("/internal/agent-executions", async (request, reply) => {
    if (runtime === undefined) {
      return unavailable(reply);
    }
    const input = parseListQuery(request.query);
    if (input === undefined) {
      return invalidRequest(reply);
    }

    try {
      return {
        ok: true,
        events: await runtime.repository.listEvents(input),
      };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "agent_execution_ledger_query_failed",
      });
    }
  });
}

function parseListQuery(value: unknown): ListAgentExecutionLedgerEventsInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const limit = value.limit === undefined
    ? DEFAULT_LIST_LIMIT
    : parseIntegerString(value.limit);
  const groupId = readOptionalFilter(value.groupId);
  const subjectId = readOptionalFilter(value.subjectId);
  const toolCallId = readOptionalFilter(value.toolCallId);
  const subjectType = readSubjectType(value.subjectType);

  if (
    limit === undefined ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT ||
    groupId === null ||
    subjectId === null ||
    toolCallId === null ||
    subjectType === null ||
    (subjectType === undefined) !== (subjectId === undefined)
  ) {
    return undefined;
  }

  return {
    limit,
    ...(groupId === undefined ? {} : { groupId }),
    ...(subjectType === undefined ? {} : { subjectType, subjectId: subjectId! }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

function readSubjectType(
  value: unknown,
): AgentExecutionLedgerSubjectType | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" &&
    AGENT_EXECUTION_LEDGER_SUBJECT_TYPES.includes(value as AgentExecutionLedgerSubjectType)
    ? value as AgentExecutionLedgerSubjectType
    : null;
}

function readOptionalFilter(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && [...normalized].length <= MAX_FILTER_CHARS
    ? normalized
    : null;
}

function parseIntegerString(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({ ok: false, error: "invalid_request" });
}

function unavailable(reply: FastifyReply) {
  return reply.code(404).send({
    ok: false,
    error: "agent_execution_ledger_unavailable",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
