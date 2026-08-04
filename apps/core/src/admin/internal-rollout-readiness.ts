import {
  readAnswerDraftRuntimeConfig,
  readActionApprovalRuntimeConfig,
  readActionReviewRuntimeConfig,
  readDocumentSyncWorkerRuntimeConfig,
  readEmbeddingProviderConfig,
  readEventWorkerRuntimeConfig,
  readFeishuAuthConfig,
  readFeishuOpenApiConfig,
  readKnowledgeCardRuntimeConfig,
  readModelProviderConfig,
  readOptionalFeishuBotOpenId,
  readReindexWorkerRuntimeConfig,
  readServerPort,
  type EnvLike,
} from "../config/env.js";
import { readDatabaseConfig } from "../database/database-config.js";
import { assertSupportedRuntimeEmbeddingDimension } from "../model/embedding-profile-id.js";

export type InternalRolloutReadinessCheckStatus = "pass" | "warn" | "fail";
export type InternalRolloutReadinessReportStatus = "ready" | "ready_with_warnings" | "blocked";

export type InternalRolloutReadinessCheck = {
  id: string;
  title: string;
  status: InternalRolloutReadinessCheckStatus;
  detail: string;
  envVars: string[];
};

export type InternalRolloutReadinessReport = {
  ok: boolean;
  status: InternalRolloutReadinessReportStatus;
  schemaVersion: 1;
  checks: InternalRolloutReadinessCheck[];
  summary: {
    checkCount: number;
    passCount: number;
    warnCount: number;
    failCount: number;
    highestSeverity: InternalRolloutReadinessCheckStatus;
  };
};

type CheckResult = Pick<InternalRolloutReadinessCheck, "status" | "detail">;
type KnowledgeCardOutboxReadinessStatus = {
  pending: number;
  processing: number;
  external_attempting: number;
  sent: number;
  failed: number;
  outcome_unknown: number;
  terminalFailed: number;
};
type ActionApprovalOutboxReadinessStatus = {
  pending: number;
  processing: number;
  external_attempting: number;
  sent: number;
  failed: number;
  outcome_unknown: number;
  terminalFailed: number;
};
export type InternalRolloutReadinessContext = {
  knowledgeCardStatus?: {
    ok: boolean;
    enabled: boolean;
    running: boolean;
    dispatcher?: { running: boolean };
    worker?: { running: boolean };
    outbox?: KnowledgeCardOutboxReadinessStatus;
    degradedReason?: string;
  };
  actionApprovalStatus?: {
    ok: boolean;
    enabled: boolean;
    running: boolean;
    planner?: { running: boolean; latestBatch?: { status: "succeeded" | "failed" } };
    dispatcher?: { running: boolean; latestBatch?: { status: "succeeded" | "failed" } };
    outbox?: ActionApprovalOutboxReadinessStatus;
    degradedReason?: string;
  };
  actionReviewStatus?: {
    configured: boolean;
    running: boolean;
    migration0034Applied: boolean;
  };
};
type CheckDefinition = Pick<InternalRolloutReadinessCheck, "id" | "title" | "envVars"> & {
  evaluate(env: EnvLike, context: InternalRolloutReadinessContext): CheckResult;
};

const checkDefinitions: CheckDefinition[] = [
  {
    id: "database",
    title: "Postgres database",
    envVars: ["DATABASE_URL"],
    evaluate(env) {
      readDatabaseConfig(env);
      return pass("DATABASE_URL is a valid Postgres URL.");
    },
  },
  {
    id: "serverPort",
    title: "Core HTTP port",
    envVars: ["PORT"],
    evaluate(env) {
      const port = readServerPort(env);
      return pass(`Core HTTP port ${port} is valid.`);
    },
  },
  {
    id: "feishuWebhookAuth",
    title: "Feishu callback authentication",
    envVars: ["FEISHU_VERIFICATION_TOKEN", "FEISHU_ENCRYPT_KEY"],
    evaluate(env) {
      const auth = readFeishuAuthConfig(env);
      if (auth.verificationToken === undefined) {
        return fail(
          "FEISHU_VERIFICATION_TOKEN is required for v1 Feishu URL verification; FEISHU_ENCRYPT_KEY only adds signature verification.",
        );
      }
      const templateFailure = findTemplatePlaceholderEnv(env, [
        "FEISHU_VERIFICATION_TOKEN",
        "FEISHU_ENCRYPT_KEY",
      ]);
      if (templateFailure !== undefined) {
        return fail(`${templateFailure} must be replaced with a real rollout value`);
      }

      return pass("Feishu callback verification token is configured.");
    },
  },
  {
    id: "feishuOpenApi",
    title: "Feishu OpenAPI access",
    envVars: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_OPEN_BASE_URL"],
    evaluate(env) {
      readFeishuOpenApiConfig(env);
      const templateFailure = findTemplatePlaceholderEnv(env, [
        "FEISHU_APP_ID",
        "FEISHU_APP_SECRET",
        "FEISHU_OPEN_BASE_URL",
      ]);
      if (templateFailure !== undefined) {
        return fail(`${templateFailure} must be replaced with a real rollout value`);
      }

      return pass("Feishu OpenAPI credentials are configured for document reads and replies.");
    },
  },
  {
    id: "feishuBotIdentity",
    title: "Iris bot identity",
    envVars: ["IRIS_FEISHU_BOT_OPEN_ID"],
    evaluate(env) {
      const botOpenId = readOptionalFeishuBotOpenId(env);
      if (botOpenId === undefined) {
        return fail("IRIS_FEISHU_BOT_OPEN_ID is required for @Iris mention replies.");
      }
      const templateFailure = findTemplatePlaceholderEnv(env, ["IRIS_FEISHU_BOT_OPEN_ID"]);
      if (templateFailure !== undefined) {
        return fail(`${templateFailure} must be replaced with a real rollout value`);
      }

      return pass("Iris bot open id is configured.");
    },
  },
  {
    id: "eventWorker",
    title: "Feishu event worker",
    envVars: ["IRIS_EVENT_WORKER_ENABLED", "REDIS_URL"],
    evaluate(env) {
      const config = readEventWorkerRuntimeConfig(env);
      if (!config.enabled) {
        return fail("IRIS_EVENT_WORKER_ENABLED=true is required so Iris can learn from Feishu chat.");
      }
      const redisUrl = readRequiredReadinessEnv(env.REDIS_URL);
      if (redisUrl === undefined) {
        return fail("REDIS_URL must be explicitly configured for the rollout event worker.");
      }

      return pass("Feishu event worker is enabled and Redis is configured.");
    },
  },
  {
    id: "documentSyncWorker",
    title: "Document sync worker",
    envVars: ["IRIS_DOCUMENT_SYNC_WORKER_ENABLED", "REDIS_URL"],
    evaluate(env) {
      const config = readDocumentSyncWorkerRuntimeConfig(env);
      if (!config.enabled) {
        return fail(
          "IRIS_DOCUMENT_SYNC_WORKER_ENABLED=true is required so Iris can fetch visible documents.",
        );
      }
      const redisUrl = readRequiredReadinessEnv(env.REDIS_URL);
      if (redisUrl === undefined) {
        return fail("REDIS_URL must be explicitly configured for the rollout document sync worker.");
      }

      return pass("Document sync worker is enabled and Redis is configured.");
    },
  },
  {
    id: "reindexWorker",
    title: "Semantic reindex worker",
    envVars: ["IRIS_REINDEX_WORKER_ENABLED", "REDIS_URL"],
    evaluate(env) {
      const config = readReindexWorkerRuntimeConfig(env);
      if (!config.enabled) {
        return fail(
          "IRIS_REINDEX_WORKER_ENABLED=true is required so synced documents become searchable.",
        );
      }
      const redisUrl = readRequiredReadinessEnv(env.REDIS_URL);
      if (redisUrl === undefined) {
        return fail("REDIS_URL must be explicitly configured for the rollout reindex worker.");
      }

      return pass("Semantic reindex worker is enabled and Redis is configured.");
    },
  },
  {
    id: "answerDraftRuntime",
    title: "Answer draft runtime",
    envVars: ["IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS", "IRIS_INTERNAL_DRAFT_PERMISSION_MODE"],
    evaluate(env) {
      const config = readAnswerDraftRuntimeConfig(env);
      if (!config.enabled) {
        return fail("IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS=true is required for @Iris answers.");
      }

      return pass("Internal answer drafting is enabled.");
    },
  },
  {
    id: "answerDraftModel",
    title: "Answer model provider",
    envVars: [
      "IRIS_MODEL_PROVIDER",
      "IRIS_MODEL_BASE_URL",
      "IRIS_MODEL_API_KEY",
      "IRIS_MODEL_NAME",
    ],
    evaluate(env) {
      const config = readModelProviderConfig(env);
      if (config === undefined) {
        return fail("Configure an OpenAI-compatible model provider for answer drafting.");
      }
      const templateFailure = findTemplatePlaceholderEnv(env, [
        "IRIS_MODEL_BASE_URL",
        "IRIS_MODEL_API_KEY",
        "IRIS_MODEL_NAME",
      ]);
      if (templateFailure !== undefined) {
        return fail(`${templateFailure} must be replaced with a real rollout value`);
      }

      return pass("Answer model provider is configured.");
    },
  },
  {
    id: "documentEmbeddings",
    title: "Document embedding provider",
    envVars: [
      "IRIS_EMBEDDING_PROVIDER",
      "IRIS_EMBEDDING_BASE_URL",
      "IRIS_EMBEDDING_API_KEY",
      "IRIS_EMBEDDING_MODEL",
      "IRIS_EMBEDDING_DIMENSIONS",
    ],
    evaluate(env) {
      const config = readEmbeddingProviderConfig(env);
      if (config === undefined) {
        return fail("Configure an OpenAI-compatible embedding provider for document retrieval.");
      }
      if (config.dimensions === undefined) {
        return fail("IRIS_EMBEDDING_DIMENSIONS is required for document retrieval quality.");
      }
      assertSupportedRuntimeEmbeddingDimension(config.dimensions);
      const templateFailure = findTemplatePlaceholderEnv(env, [
        "IRIS_EMBEDDING_BASE_URL",
        "IRIS_EMBEDDING_API_KEY",
        "IRIS_EMBEDDING_MODEL",
      ]);
      if (templateFailure !== undefined) {
        return fail(`${templateFailure} must be replaced with a real rollout value`);
      }

      return pass("Document embedding provider is configured with a supported dimension.");
    },
  },
  {
    id: "answerDraftPermissionGuard",
    title: "Real-time permission guard",
    envVars: ["IRIS_INTERNAL_DRAFT_PERMISSION_MODE", "FEISHU_APP_ID", "FEISHU_APP_SECRET"],
    evaluate(env) {
      const config = readAnswerDraftRuntimeConfig(env);
      if (!config.enabled) {
        return fail("Enable answer drafts before checking the document permission guard.");
      }
      if (config.permissionMode !== "source-policy") {
        return fail("Use IRIS_INTERNAL_DRAFT_PERMISSION_MODE=source-policy for live Feishu checks.");
      }
      readFeishuOpenApiConfig(env);
      const templateFailure = findTemplatePlaceholderEnv(env, [
        "FEISHU_APP_ID",
        "FEISHU_APP_SECRET",
      ]);
      if (templateFailure !== undefined) {
        return fail(`${templateFailure} must be replaced with a real rollout value`);
      }

      return pass("Answer drafting uses source-policy with Feishu OpenAPI live checks available.");
    },
  },
  {
    id: "internalApiToken",
    title: "Internal operator API token",
    envVars: ["IRIS_INTERNAL_API_TOKEN"],
    evaluate(env) {
      const token = env.IRIS_INTERNAL_API_TOKEN?.trim();
      if (token === undefined || token.length === 0) {
        return fail("IRIS_INTERNAL_API_TOKEN is required before internal rollout.");
      }
      if (!isSingleVisibleAsciiToken(token)) {
        return fail(
          "IRIS_INTERNAL_API_TOKEN must be a single visible ASCII token without whitespace or commas",
        );
      }
      const templateFailure = findTemplatePlaceholderEnv(env, ["IRIS_INTERNAL_API_TOKEN"]);
      if (templateFailure !== undefined) {
        return fail(`${templateFailure} must be replaced with a real rollout value`);
      }

      return pass("Internal operator APIs have a bearer token configured.");
    },
  },
  {
    id: "knowledgeCards",
    title: "Knowledge-card confirmation runtime",
    envVars: [
      "IRIS_KNOWLEDGE_CARD_ENABLED",
      "IRIS_KNOWLEDGE_CARD_GROUP_IDS",
      "IRIS_KNOWLEDGE_CARD_WORKER_INTERVAL_MS",
      "IRIS_KNOWLEDGE_CARD_WORKER_BATCH_LIMIT",
      "DATABASE_URL",
      "REDIS_URL",
      "FEISHU_VERIFICATION_TOKEN",
      "FEISHU_ENCRYPT_KEY",
      "FEISHU_APP_ID",
      "FEISHU_APP_SECRET",
      "IRIS_FEISHU_BOT_OPEN_ID",
    ],
    evaluate(env, context) {
      const config = readKnowledgeCardRuntimeConfig(env);
      if (!config.enabled) {
        return pass("Knowledge cards are safely disabled.");
      }
      const status = context.knowledgeCardStatus;
      if (status === undefined) {
        return fail("Knowledge-card runtime status is unavailable.");
      }
      if (!status.ok) {
        return fail("Knowledge-card runtime status is unreadable.");
      }
      if (!status.enabled) {
        return fail("Knowledge-card runtime is not available while configured enabled.");
      }
      if (
        !status.running ||
        status.dispatcher?.running !== true ||
        status.worker?.running !== true
      ) {
        return fail("Knowledge-card dispatcher and interaction worker must both be running.");
      }
      if (!isValidKnowledgeCardOutboxStatus(status.outbox)) {
        return fail("Knowledge-card outbox status is unavailable.");
      }
      if (status.outbox.outcome_unknown > 0) {
        return fail("Knowledge-card outbox has unresolved outcome-unknown rows.");
      }
      if (status.outbox.terminalFailed > 0) {
        return fail("Knowledge-card outbox has terminal failed rows.");
      }
      return pass("Knowledge-card dispatcher and interaction worker are running.");
    },
  },
  {
    id: "actionApprovals",
    title: "Action proposal approval runtime",
    envVars: [
      "IRIS_APPROVAL_ACTIONS_ENABLED",
      "IRIS_APPROVAL_ACTION_GROUP_IDS",
      "IRIS_ACTION_PROPOSAL_PLANNER_INTERVAL_MS",
      "IRIS_ACTION_PROPOSAL_PLANNER_BATCH_LIMIT",
      "IRIS_ACTION_APPROVAL_DISPATCHER_INTERVAL_MS",
      "IRIS_ACTION_APPROVAL_DISPATCHER_BATCH_LIMIT",
      "IRIS_REVIEW_PUBLIC_ORIGIN",
      "DATABASE_URL",
    ],
    evaluate(env, context) {
      const config = readActionApprovalRuntimeConfig(env);
      if (!config.enabled) return pass("Action approvals are safely disabled.");
      const status = context.actionApprovalStatus;
      if (status === undefined) return fail("Action-approval runtime status is unavailable.");
      if (!status.ok) return fail("Action-approval runtime status is unreadable.");
      if (!status.enabled) {
        return fail("Action-approval runtime is not available while configured enabled.");
      }
      if (
        !status.running ||
        status.planner?.running !== true ||
        status.dispatcher?.running !== true
      ) return fail("Action-proposal planner and approval dispatcher must both be running.");
      if (status.planner.latestBatch?.status === "failed") {
        return fail("Action-proposal planner latest batch failed.");
      }
      if (status.dispatcher.latestBatch?.status === "failed") {
        return fail("Action-approval dispatcher latest batch failed.");
      }
      if (!isValidActionApprovalOutboxStatus(status.outbox)) {
        return fail("Action-approval outbox status is unavailable.");
      }
      if (status.outbox.outcome_unknown > 0) {
        return fail("Action-approval outbox has unresolved outcome-unknown rows.");
      }
      if (status.outbox.terminalFailed > 0) {
        return fail("Action-approval outbox has terminal failed rows.");
      }
      return pass("Action-proposal planner and approval dispatcher are running.");
    },
  },
  {
    id: "actionReviews",
    title: "Public action-review runtime",
    envVars: [
      "IRIS_ACTION_REVIEW_ENABLED",
      "IRIS_REVIEW_PUBLIC_ORIGIN",
      "IRIS_REVIEW_SESSION_SECRET",
      "IRIS_APPROVAL_ACTIONS_ENABLED",
      "IRIS_KNOWLEDGE_CARD_ENABLED",
      "FEISHU_APP_ID",
      "FEISHU_APP_SECRET",
      "FEISHU_OPEN_BASE_URL",
    ],
    evaluate(env, context) {
      const reviewConfig = readActionReviewRuntimeConfig(env);
      if (!reviewConfig.enabled) return pass("Action reviews are safely disabled.");

      if (!readActionApprovalRuntimeConfig(env).enabled) {
        return fail("IRIS_APPROVAL_ACTIONS_ENABLED=true is required for action reviews.");
      }
      if (!readKnowledgeCardRuntimeConfig(env).enabled) {
        return fail("IRIS_KNOWLEDGE_CARD_ENABLED=true is required for action reviews.");
      }

      const status = context.actionReviewStatus;
      if (status === undefined) return fail("Action-review runtime status is unavailable.");
      if (!status.configured) return fail("Action-review runtime is not configured.");
      if (!status.running) return fail("Action-review runtime is not running.");
      if (!status.migration0034Applied) {
        return fail("Action-review migration 0034 is not applied.");
      }

      return pass("Action-review runtime is configured and running with migration 0034 applied.");
    },
  },
];

function isValidActionApprovalOutboxStatus(
  value: ActionApprovalOutboxReadinessStatus | undefined,
): value is ActionApprovalOutboxReadinessStatus {
  if (value === undefined) return false;
  const counts = [
    value.pending,
    value.processing,
    value.external_attempting,
    value.sent,
    value.failed,
    value.outcome_unknown,
    value.terminalFailed,
  ];
  return counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    value.terminalFailed <= value.failed;
}

function isValidKnowledgeCardOutboxStatus(
  value: KnowledgeCardOutboxReadinessStatus | undefined,
): value is KnowledgeCardOutboxReadinessStatus {
  if (value === undefined) return false;
  const counts = [
    value.pending,
    value.processing,
    value.external_attempting,
    value.sent,
    value.failed,
    value.outcome_unknown,
    value.terminalFailed,
  ];
  return counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    value.terminalFailed <= value.failed;
}

export function buildInternalRolloutReadinessReport(
  env: EnvLike = process.env,
  context: InternalRolloutReadinessContext = {},
): InternalRolloutReadinessReport {
  const checks = checkDefinitions.map((definition) => runCheck(definition, env, context));
  const passCount = checks.filter((check) => check.status === "pass").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const failCount = checks.filter((check) => check.status === "fail").length;
  const highestSeverity = getHighestSeverity({ warnCount, failCount });
  const ok = failCount === 0;

  return {
    ok,
    status: failCount > 0 ? "blocked" : warnCount > 0 ? "ready_with_warnings" : "ready",
    schemaVersion: 1,
    checks,
    summary: {
      checkCount: checks.length,
      passCount,
      warnCount,
      failCount,
      highestSeverity,
    },
  };
}

function runCheck(
  definition: CheckDefinition,
  env: EnvLike,
  context: InternalRolloutReadinessContext,
): InternalRolloutReadinessCheck {
  try {
    return {
      id: definition.id,
      title: definition.title,
      envVars: [...definition.envVars],
      ...definition.evaluate(env, context),
    };
  } catch (error) {
    return {
      id: definition.id,
      title: definition.title,
      status: "fail",
      detail: normalizeErrorMessage(error),
      envVars: [...definition.envVars],
    };
  }
}

function pass(detail: string): CheckResult {
  return { status: "pass", detail };
}

function warn(detail: string): CheckResult {
  return { status: "warn", detail };
}

function fail(detail: string): CheckResult {
  return { status: "fail", detail };
}

function getHighestSeverity(input: {
  warnCount: number;
  failCount: number;
}): InternalRolloutReadinessCheckStatus {
  if (input.failCount > 0) {
    return "fail";
  }
  if (input.warnCount > 0) {
    return "warn";
  }

  return "pass";
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown readiness check error";
}

function readRequiredReadinessEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  return trimmed;
}

function findTemplatePlaceholderEnv(env: EnvLike, names: string[]): string | undefined {
  return names.find((name) => {
    const value = env[name]?.trim();
    return value !== undefined && value.length > 0 && isTemplatePlaceholderValue(value);
  });
}

function isTemplatePlaceholderValue(value: string): boolean {
  return (
    value.startsWith("replace-with-") ||
    value.includes("api.example.com") ||
    /^<[^<>]+>$/u.test(value)
  );
}

function isSingleVisibleAsciiToken(value: string): boolean {
  if (value.length === 0 || /[\s,]/u.test(value)) {
    return false;
  }

  return [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint >= 0x21 && codePoint <= 0x7e;
  });
}
