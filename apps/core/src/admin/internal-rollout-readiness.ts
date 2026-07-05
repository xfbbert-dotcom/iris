import {
  readAnswerDraftRuntimeConfig,
  readDocumentSyncWorkerRuntimeConfig,
  readEmbeddingProviderConfig,
  readEventWorkerRuntimeConfig,
  readFeishuAuthConfig,
  readFeishuOpenApiConfig,
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
type CheckDefinition = Pick<InternalRolloutReadinessCheck, "id" | "title" | "envVars"> & {
  evaluate(env: EnvLike): CheckResult;
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
      if (auth.verificationToken === undefined && auth.encryptKey === undefined) {
        return fail("Set FEISHU_VERIFICATION_TOKEN or FEISHU_ENCRYPT_KEY before exposing callbacks.");
      }
      const templateFailure = findTemplatePlaceholderEnv(env, [
        "FEISHU_VERIFICATION_TOKEN",
        "FEISHU_ENCRYPT_KEY",
      ]);
      if (templateFailure !== undefined) {
        return fail(`${templateFailure} must be replaced with a real rollout value`);
      }

      return pass("Feishu callback verification is configured.");
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
        return warn(
          "IRIS_INTERNAL_API_TOKEN is not set; keep Core on a trusted private network until it is configured.",
        );
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
];

export function buildInternalRolloutReadinessReport(
  env: EnvLike = process.env,
): InternalRolloutReadinessReport {
  const checks = checkDefinitions.map((definition) => runCheck(definition, env));
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

function runCheck(definition: CheckDefinition, env: EnvLike): InternalRolloutReadinessCheck {
  try {
    return {
      id: definition.id,
      title: definition.title,
      envVars: [...definition.envVars],
      ...definition.evaluate(env),
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
  return value.startsWith("replace-with-") || value.includes("api.example.com");
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
