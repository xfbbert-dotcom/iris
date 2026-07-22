import type { FastifyInstance, FastifyReply } from "fastify";

import type { ActionApprovalRuntime } from "../runtime/action-approval-runtime.js";
import {
  KNOWLEDGE_DRAFT_REASON_MAX_CHARS,
  KNOWLEDGE_DRAFT_RISK_LEVELS,
} from "../knowledge-governance/knowledge-draft.js";
import {
  ACTION_PROPOSAL_STATUSES,
  ACTION_ROLE_GRANT_TYPES,
  type ActionProposalStatus,
  type ActionRoleGrantType,
} from "./action-proposal.js";
import {
  ActionProposalAuthorizationError,
  ActionProposalIneligibleError,
  ActionProposalOperationConflictError,
  ActionProposalPersistenceConflictError,
  ActionProposalVersionConflictError,
} from "./postgres-action-proposal-repository.js";

const MAX_LIST_LIMIT = 100;
const MAX_REFERENCE_CHARS = 512;

export function registerActionProposalApi(
  app: FastifyInstance,
  runtime: ActionApprovalRuntime | undefined,
  {
    authenticationConfigured,
    now = () => new Date(),
  }: {
    authenticationConfigured: boolean;
    now?: () => Date;
  },
): void {
  app.get("/internal/action-approvals/status", async (_request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      return { ok: true, ...(await runtime.getStatus()) };
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get("/internal/action-proposals", async (request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      const input = parseProposalQuery(request.query);
      return { ok: true, proposals: await runtime.repository.listProposals(input) };
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/internal/action-proposals/:id", async (request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      const proposal = await runtime.repository.getProposal(requireReference("id", request.params.id));
      if (proposal === undefined) {
        return reply.code(404).send({ ok: false, error: "action_proposal_not_found" });
      }
      return { ok: true, proposal };
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/internal/action-proposals/:id/events",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const id = requireReference("id", request.params.id);
        if (await runtime.repository.getProposal(id) === undefined) {
          return reply.code(404).send({ ok: false, error: "action_proposal_not_found" });
        }
        return { ok: true, events: await runtime.repository.listEvents(id) };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  for (const action of ["request_revision", "reject"] as const) {
    const path = action === "request_revision" ? "request-revision" : "reject";
    app.post<{ Params: { id: string } }>(
      `/internal/action-proposals/:id/${path}`,
      async (request, reply) => {
        if (!authenticationConfigured) return authenticationUnavailable(reply);
        if (runtime === undefined) return unavailable(reply);
        try {
          const operator = requireOperator(request.headers["x-iris-operator"]);
          const body = parseDispositionBody(unwrapBody(request.body));
          const result = await runtime.repository.applyGovernanceDisposition({
            proposalId: requireReference("id", request.params.id),
            ...body,
            action,
            operator,
            at: requireDate(now()),
          });
          return { ok: true, ...result };
        } catch (error) {
          return handleError(reply, error);
        }
      },
    );
  }

  app.get("/internal/action-policies", async (request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      const query = requireRecord(request.query, "query");
      assertOnlyKeys(query, ["enabled", "limit"]);
      return {
        ok: true,
        policies: await runtime.repository.listTargetPolicies({
          ...(query.enabled === undefined ? {} : { enabled: parseBooleanQuery("enabled", query.enabled) }),
          limit: query.limit === undefined ? 20 : parseLimit(query.limit),
        }),
      };
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>("/internal/action-policies/:id", async (request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      const operator = requireOperator(request.headers["x-iris-operator"]);
      const body = parsePolicyBody(unwrapBody(request.body));
      const result = await runtime.repository.upsertTargetPolicy({
        id: requireReference("id", request.params.id),
        ...body,
        operator,
        at: requireDate(now()),
      });
      return { ok: true, ...result };
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get("/internal/action-role-grants", async (request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (runtime === undefined) return unavailable(reply);
    try {
      const query = requireRecord(request.query, "query");
      assertOnlyKeys(query, ["roleType", "enabled", "limit"]);
      return {
        ok: true,
        grants: await runtime.repository.listRoleGrants({
          ...(query.roleType === undefined ? {} : { roleType: requireRole(query.roleType) }),
          ...(query.enabled === undefined ? {} : { enabled: parseBooleanQuery("enabled", query.enabled) }),
          limit: query.limit === undefined ? 20 : parseLimit(query.limit),
        }),
      };
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.put<{ Params: { role: string; actorOpenId: string } }>(
    "/internal/action-role-grants/:role/:actorOpenId",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (runtime === undefined) return unavailable(reply);
      try {
        const operator = requireOperator(request.headers["x-iris-operator"]);
        const body = parseGrantBody(unwrapBody(request.body));
        const result = await runtime.repository.upsertRoleGrant({
          roleType: requireRole(request.params.role),
          actorOpenId: requireReference("actorOpenId", request.params.actorOpenId),
          ...body,
          operator,
          at: requireDate(now()),
        });
        return { ok: true, ...result };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );
}

function parseProposalQuery(value: unknown): {
  statuses?: ActionProposalStatus[];
  subjectId?: string;
  limit: number;
} {
  const query = requireRecord(value, "query");
  assertOnlyKeys(query, ["status", "subjectId", "limit"]);
  const statuses = query.status === undefined
    ? undefined
    : parseEnumList("status", query.status, ACTION_PROPOSAL_STATUSES);
  return {
    ...(statuses === undefined ? {} : { statuses }),
    ...(query.subjectId === undefined ? {} : { subjectId: requireReference("subjectId", query.subjectId) }),
    limit: query.limit === undefined ? 20 : parseLimit(query.limit),
  };
}

function parseDispositionBody(value: unknown) {
  const body = requireRecord(value, "request");
  assertOnlyKeys(body, [
    "expectedProposalVersion",
    "expectedSubjectRevision",
    "expectedSubjectVersion",
    "reason",
    "operationKey",
  ]);
  return {
    expectedProposalVersion: requirePositiveInteger("expectedProposalVersion", body.expectedProposalVersion),
    expectedSubjectRevision: requirePositiveInteger("expectedSubjectRevision", body.expectedSubjectRevision),
    expectedSubjectVersion: requirePositiveInteger("expectedSubjectVersion", body.expectedSubjectVersion),
    reason: requireString("reason", body.reason, KNOWLEDGE_DRAFT_REASON_MAX_CHARS),
    operationKey: requireReference("operationKey", body.operationKey),
  };
}

function parsePolicyBody(value: unknown) {
  const body = requireRecord(value, "request");
  assertOnlyKeys(body, [
    "spaceId",
    "parentNodeToken",
    "displayName",
    "allowedGroupIds",
    "allowedRiskLevels",
    "enabled",
    "expectedVersion",
    "operationKey",
  ]);
  return {
    spaceId: requireReference("spaceId", body.spaceId),
    ...(body.parentNodeToken === undefined
      ? {}
      : { parentNodeToken: requireReference("parentNodeToken", body.parentNodeToken) }),
    displayName: requireString("displayName", body.displayName, MAX_REFERENCE_CHARS),
    allowedGroupIds: requireUniqueReferences("allowedGroupIds", body.allowedGroupIds),
    allowedRiskLevels: requireEnumArray("allowedRiskLevels", body.allowedRiskLevels, KNOWLEDGE_DRAFT_RISK_LEVELS),
    enabled: requireBoolean("enabled", body.enabled),
    expectedVersion: requireNonNegativeInteger("expectedVersion", body.expectedVersion),
    operationKey: requireReference("operationKey", body.operationKey),
  };
}

function parseGrantBody(value: unknown) {
  const body = requireRecord(value, "request");
  assertOnlyKeys(body, ["enabled", "expectedVersion", "operationKey"]);
  return {
    enabled: requireBoolean("enabled", body.enabled),
    expectedVersion: requireNonNegativeInteger("expectedVersion", body.expectedVersion),
    operationKey: requireReference("operationKey", body.operationKey),
  };
}

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof ActionProposalAuthorizationError) {
    return reply.code(403).send({ ok: false, error: "action_proposal_not_authorized" });
  }
  if (error instanceof ActionProposalVersionConflictError) {
    return reply.code(409).send({ ok: false, error: "action_proposal_version_conflict" });
  }
  if (error instanceof ActionProposalOperationConflictError) {
    return reply.code(409).send({ ok: false, error: "action_proposal_operation_conflict" });
  }
  if (error instanceof ActionProposalIneligibleError) {
    return reply.code(409).send({ ok: false, error: "action_proposal_ineligible" });
  }
  if (error instanceof ActionProposalPersistenceConflictError) {
    return reply.code(409).send({ ok: false, error: "action_proposal_persistence_conflict" });
  }
  if (error instanceof ApiValidationError) {
    return reply.code(400).send({ ok: false, error: "invalid_request" });
  }
  return reply.code(503).send({ ok: false, error: "action_approval_unavailable" });
}

function authenticationUnavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "internal_authentication_unavailable" });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "action_approval_runtime_unavailable" });
}

function unwrapBody(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.hasOwn(value, "parsedBody") ? value.parsedBody : value;
}

function requireOperator(value: string | string[] | undefined): string {
  if (Array.isArray(value) || typeof value !== "string") throw validationError("operator is invalid");
  return requireReference("operator", value);
}

function requireRole(value: unknown): ActionRoleGrantType {
  if (typeof value !== "string" || !ACTION_ROLE_GRANT_TYPES.includes(value as ActionRoleGrantType)) {
    throw validationError("role is invalid");
  }
  return value as ActionRoleGrantType;
}

function parseEnumList<T extends string>(name: string, value: unknown, allowed: readonly T[]): T[] {
  if (typeof value !== "string") throw validationError(`${name} is invalid`);
  const items = value.split(",");
  if (items.length === 0 || new Set(items).size !== items.length ||
      items.some((item) => !allowed.includes(item as T))) throw validationError(`${name} is invalid`);
  return items as T[];
}

function requireEnumArray<T extends string>(name: string, value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100 ||
      value.some((item) => typeof item !== "string" || !allowed.includes(item as T))) {
    throw validationError(`${name} is invalid`);
  }
  const items = value as T[];
  if (new Set(items).size !== items.length) throw validationError(`${name} is invalid`);
  return [...items];
}

function requireUniqueReferences(name: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw validationError(`${name} is invalid`);
  }
  const items = value.map((item) => requireReference(name, item));
  if (new Set(items).size !== items.length) throw validationError(`${name} is invalid`);
  return items;
}

function parseBooleanQuery(name: string, value: unknown): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw validationError(`${name} is invalid`);
}

function parseLimit(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) throw validationError("limit is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_LIST_LIMIT) throw validationError("limit is invalid");
  return parsed;
}

function requireReference(name: string, value: unknown): string {
  return requireString(name, value, MAX_REFERENCE_CHARS);
}

function requireString(name: string, value: unknown, maximum: number): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > maximum ||
      /[\u0000-\u001f\u007f]/u.test(value)) throw validationError(`${name} is invalid`);
  return value;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw validationError(`${name} is invalid`);
  return value as number;
}

function requireNonNegativeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw validationError(`${name} is invalid`);
  return value as number;
}

function requireBoolean(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw validationError(`${name} is invalid`);
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw validationError("time is invalid");
  return new Date(value);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw validationError(`${name} must be an object`);
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw validationError("unknown field");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ApiValidationError extends Error {}

function validationError(message: string): ApiValidationError {
  return new ApiValidationError(message);
}
