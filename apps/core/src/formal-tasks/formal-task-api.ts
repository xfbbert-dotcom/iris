import type { FastifyInstance, FastifyReply } from "fastify";

import type { FormalTaskRuntime } from "../runtime/formal-task-runtime.js";
import type { FormalTaskActionRuntime } from "../runtime/formal-task-action-runtime.js";
import { FORMAL_TASK_DRAFT_STATUSES } from "./formal-task-draft.js";
import {
  FORMAL_TASK_RISK_LEVELS,
  type FeishuTaskTargetPolicy,
  type FormalTaskDraftView,
} from
  "./formal-task-repository.js";
import type {
  FeishuTaskCreationExecutionState,
  FormalTaskExecutionMetadata,
} from "./formal-task-execution-repository.js";
import {
  FormalTaskEvidenceError,
  FormalTaskNotFoundError,
  FormalTaskOperationConflictError,
  FormalTaskPolicyConflictError,
  FormalTaskTransitionError,
  FormalTaskVersionConflictError,
} from "./postgres-formal-task-repository.js";
import {
  FormalTaskExecutionOperationConflictError,
  FormalTaskExecutionPersistenceConflictError,
} from "./postgres-formal-task-execution-repository.js";

const MAX_LIST_LIMIT = 100;
const MAX_REFERENCE_CHARS = 512;
const MAX_REASON_CHARS = 2_000;
const EXECUTION_STATES: readonly FeishuTaskCreationExecutionState[] = [
  "claimed", "external_attempting", "succeeded", "failed", "outcome_unknown",
  "reconciliation_required",
];

export function registerFormalTaskApi(
  app: FastifyInstance,
  draftRuntime: Pick<FormalTaskRuntime, "repository"> | undefined,
  actionRuntime: Pick<FormalTaskActionRuntime, "repository"> | undefined,
  {
    authenticationConfigured,
    now = () => new Date(),
  }: {
    authenticationConfigured: boolean;
    now?: () => Date;
  },
): void {
  app.get<{ Params: { id: string } }>(
    "/internal/formal-task-policies/:id",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (draftRuntime === undefined) return draftUnavailable(reply);
      try {
        const policy = await draftRuntime.repository.getTargetPolicy(
          requireReference("id", request.params.id),
        );
        if (policy === undefined) {
          return reply.code(404).send({ ok: false, error: "formal_task_policy_not_found" });
        }
        return { ok: true, policy: projectTargetPolicyMetadata(policy) };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  app.put<{ Params: { id: string } }>(
    "/internal/formal-task-policies/:id",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (draftRuntime === undefined) return draftUnavailable(reply);
      try {
        const operator = requireOperator(request.headers["x-iris-operator"]);
        const body = parseTargetPolicy(unwrapBody(request.body));
        const result = await draftRuntime.repository.upsertTargetPolicy({
          id: requireReference("id", request.params.id),
          ...body,
          operator,
          at: requireDate(now()),
        });
        return {
          ok: true,
          outcome: result.outcome,
          policy: projectTargetPolicyMetadata(result.policy),
        };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  app.get("/internal/formal-task-drafts", async (request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (draftRuntime === undefined) return draftUnavailable(reply);
    try {
      const input = parseDraftListQuery(request.query);
      const drafts = await draftRuntime.repository.listDrafts(input);
      return { ok: true, drafts: drafts.map(projectDraftMetadata) };
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/internal/formal-task-drafts/:id",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (draftRuntime === undefined) return draftUnavailable(reply);
      try {
        const draft = await draftRuntime.repository.getDraft(
          requireReference("id", request.params.id),
        );
        if (draft === undefined) throw new FormalTaskNotFoundError();
        return { ok: true, draft: projectDraftMetadata(draft) };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  for (const [path, operation] of [
    ["request-revision", "requestRevision"],
    ["reject", "rejectDraft"],
  ] as const) {
    app.post<{ Params: { id: string } }>(
      `/internal/formal-task-drafts/:id/${path}`,
      async (request, reply) => {
        if (!authenticationConfigured) return authenticationUnavailable(reply);
        if (draftRuntime === undefined) return draftUnavailable(reply);
        try {
          const operator = requireOperator(request.headers["x-iris-operator"]);
          const body = parseDraftDisposition(unwrapBody(request.body));
          const result = await draftRuntime.repository[operation]({
            id: requireReference("id", request.params.id),
            ...body,
            actor: operator,
            at: requireDate(now()),
          });
          return {
            ok: true,
            outcome: result.outcome,
            draft: projectDraftMetadata(result.draft),
          };
        } catch (error) {
          return handleError(reply, error);
        }
      },
    );
  }

  app.get("/internal/formal-task-executions", async (request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (actionRuntime === undefined) return actionUnavailable(reply);
    try {
      const input = parseExecutionListQuery(request.query);
      const executions = await actionRuntime.repository.listExecutionMetadata(input);
      return { ok: true, executions: executions.map(projectExecutionMetadata) };
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/internal/formal-task-executions/:id/reconcile",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (actionRuntime === undefined) return actionUnavailable(reply);
      try {
        const operator = requireOperator(request.headers["x-iris-operator"]);
        const body = parseReconciliation(unwrapBody(request.body));
        const result = await actionRuntime.repository.requestReconciliation({
          executionId: requireReference("id", request.params.id),
          ...body,
          operator,
          at: requireDate(now()),
        });
        return { ok: true, execution: result };
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );
}

function projectTargetPolicyMetadata(policy: FeishuTaskTargetPolicy) {
  return {
    id: policy.id,
    sourceGroupId: policy.sourceGroupId,
    displayName: policy.displayName,
    allowedAssigneeCount: policy.allowedAssigneeOpenIds.length,
    maxDueHorizonDays: policy.maxDueHorizonDays,
    enabled: policy.enabled,
    version: policy.version,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

function projectDraftMetadata(draft: FormalTaskDraftView) {
  return {
    id: draft.id,
    sourceGroupId: draft.sourceGroupId,
    status: draft.status,
    currentRevisionNumber: draft.currentRevisionNumber,
    version: draft.version,
    currentTaskSpecHash: draft.currentTaskSpecHash,
    riskLevel: draft.currentRevision.riskLevel,
    evidenceStatus: draft.currentRevision.evidenceState.status,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

function parseTargetPolicy(value: unknown) {
  const body = requireRecord(value, "request");
  assertOnlyKeys(body, [
    "sourceGroupId",
    "displayName",
    "allowedAssigneeOpenIds",
    "maxDueHorizonDays",
    "enabled",
    "expectedVersion",
    "operationKey",
  ]);
  return {
    sourceGroupId: requireReference("sourceGroupId", body.sourceGroupId),
    displayName: requireString("displayName", body.displayName, 256),
    allowedAssigneeOpenIds: requireUniqueReferences(
      "allowedAssigneeOpenIds",
      body.allowedAssigneeOpenIds,
      100,
    ),
    maxDueHorizonDays: requireIntegerBetween(
      "maxDueHorizonDays",
      body.maxDueHorizonDays,
      1,
      365,
    ),
    enabled: requireBoolean("enabled", body.enabled),
    expectedVersion: requireIntegerBetween(
      "expectedVersion",
      body.expectedVersion,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    operationKey: requireReference("operationKey", body.operationKey),
  };
}

function projectExecutionMetadata(execution: FormalTaskExecutionMetadata) {
  return {
    id: execution.id,
    proposalId: execution.proposalId,
    draftId: execution.draftId,
    draftRevision: execution.draftRevision,
    draftVersion: execution.draftVersion,
    targetPolicyId: execution.targetPolicyId,
    targetPolicyVersion: execution.targetPolicyVersion,
    attemptNumber: execution.attemptNumber,
    state: execution.state,
    requestFingerprint: execution.requestFingerprint,
    clientTokenHash: execution.clientTokenHash,
    ...(execution.responseClassification === undefined
      ? {}
      : { responseClassification: execution.responseClassification }),
    version: execution.version,
    ...(execution.leaseUntil === undefined ? {} : { leaseUntil: execution.leaseUntil }),
    ...(execution.retryAt === undefined ? {} : { retryAt: execution.retryAt }),
    ...(execution.dispatchedAt === undefined ? {} : { dispatchedAt: execution.dispatchedAt }),
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
  };
}

function parseDraftListQuery(value: unknown) {
  const query = requireRecord(value, "query");
  assertOnlyKeys(query, ["groupId", "status", "riskLevel", "limit"]);
  const sourceGroupId = query.groupId === undefined
    ? undefined
    : requireReference("groupId", query.groupId);
  const statuses = parseEnumList("status", query.status, FORMAL_TASK_DRAFT_STATUSES);
  const riskLevels = parseEnumList("riskLevel", query.riskLevel, FORMAL_TASK_RISK_LEVELS);
  return {
    ...(sourceGroupId === undefined ? {} : { sourceGroupId }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(riskLevels === undefined ? {} : { riskLevels }),
    limit: query.limit === undefined ? 20 : parseLimit(query.limit),
  };
}

function parseExecutionListQuery(value: unknown) {
  const query = requireRecord(value, "query");
  assertOnlyKeys(query, ["state", "proposalId", "limit"]);
  const states = parseEnumList("state", query.state, EXECUTION_STATES);
  return {
    ...(states === undefined ? {} : { states }),
    ...(query.proposalId === undefined
      ? {}
      : { proposalId: requireReference("proposalId", query.proposalId) }),
    limit: query.limit === undefined ? 20 : parseLimit(query.limit),
  };
}

function parseDraftDisposition(value: unknown) {
  const body = requireRecord(value, "request");
  assertOnlyKeys(body, [
    "expectedVersion", "expectedRevision", "expectedTaskSpecHash", "reason", "operationKey",
  ]);
  return {
    expectedVersion: requirePositiveInteger("expectedVersion", body.expectedVersion),
    expectedRevision: requirePositiveInteger("expectedRevision", body.expectedRevision),
    expectedTaskSpecHash: requireHash("expectedTaskSpecHash", body.expectedTaskSpecHash),
    reason: requireString("reason", body.reason, MAX_REASON_CHARS),
    operationKey: requireReference("operationKey", body.operationKey),
  };
}

function parseReconciliation(value: unknown) {
  const body = requireRecord(value, "request");
  assertOnlyKeys(body, ["expectedExecutionVersion", "operationKey"]);
  return {
    expectedExecutionVersion: requirePositiveInteger(
      "expectedExecutionVersion",
      body.expectedExecutionVersion,
    ),
    operationKey: requireReference("operationKey", body.operationKey),
  };
}

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof FormalTaskNotFoundError) {
    return reply.code(404).send({ ok: false, error: "formal_task_not_found" });
  }
  if (
    error instanceof FormalTaskVersionConflictError ||
    error instanceof FormalTaskTransitionError ||
    error instanceof FormalTaskPolicyConflictError ||
    error instanceof FormalTaskEvidenceError ||
    error instanceof FormalTaskExecutionPersistenceConflictError
  ) return reply.code(409).send({ ok: false, error: "formal_task_state_conflict" });
  if (
    error instanceof FormalTaskOperationConflictError ||
    error instanceof FormalTaskExecutionOperationConflictError
  ) return reply.code(409).send({ ok: false, error: "formal_task_operation_conflict" });
  if (error instanceof ApiValidationError) {
    return reply.code(400).send({ ok: false, error: "invalid_request" });
  }
  return reply.code(503).send({ ok: false, error: "formal_task_runtime_unavailable" });
}

function authenticationUnavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "internal_authentication_unavailable" });
}

function draftUnavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "formal_task_draft_runtime_unavailable" });
}

function actionUnavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "formal_task_action_runtime_unavailable" });
}

function unwrapBody(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.hasOwn(value, "parsedBody") ? value.parsedBody : value;
}

function requireOperator(value: string | string[] | undefined): string {
  if (Array.isArray(value)) throw validationError("operator is invalid");
  return requireReference("operator", value);
}

function parseEnumList<T extends string>(
  name: string,
  value: unknown,
  allowed: readonly T[],
): T[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw validationError(`${name} is invalid`);
  const items = value.split(",");
  if (
    items.length < 1 || items.length > allowed.length || new Set(items).size !== items.length ||
    items.some((item) => !allowed.includes(item as T))
  ) throw validationError(`${name} is invalid`);
  return items as T[];
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

function requireHash(name: string, value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw validationError(`${name} is invalid`);
  }
  return value;
}

function requireReference(name: string, value: unknown): string {
  return requireString(name, value, MAX_REFERENCE_CHARS);
}

function requireString(name: string, value: unknown, maximum: number): string {
  if (
    typeof value !== "string" || value !== value.trim() || value.length < 1 ||
    value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw validationError(`${name} is invalid`);
  return value;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw validationError(`${name} is invalid`);
  }
  return Number(value);
}

function requireIntegerBetween(
  name: string,
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw validationError(`${name} is invalid`);
  }
  return Number(value);
}

function requireBoolean(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw validationError(`${name} is invalid`);
  return value;
}

function requireUniqueReferences(name: string, value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw validationError(`${name} is invalid`);
  }
  const references = value.map((item) => requireReference(name, item));
  if (new Set(references).size !== references.length) {
    throw validationError(`${name} is invalid`);
  }
  return references;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw validationError("time is invalid");
  }
  return new Date(value);
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

class ApiValidationError extends Error {}

function validationError(message: string): ApiValidationError {
  return new ApiValidationError(message);
}
