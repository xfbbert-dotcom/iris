import { describe, expect, it } from "vitest";

import { buildInternalRolloutReadinessReport } from "../src/admin/internal-rollout-readiness.js";
import type { EnvLike } from "../src/config/env.js";

describe("buildInternalRolloutReadinessReport", () => {
  it("marks the internal rollout profile ready when core chat, document, and answer dependencies are configured", () => {
    const report = buildInternalRolloutReadinessReport(readyRolloutEnv());

    expect(report.ok).toBe(true);
    expect(report.status).toBe("ready");
    expect(report.summary).toEqual({
      checkCount: report.checks.length,
      passCount: report.checks.length,
      warnCount: 0,
      failCount: 0,
      highestSeverity: "pass",
    });
    expect(report.checks.map((check) => check.status)).toEqual(
      Array.from({ length: report.checks.length }, () => "pass"),
    );
  });

  it("reports actionable failures and warnings without throwing when rollout-critical config is missing", () => {
    const report = buildInternalRolloutReadinessReport({
      IRIS_EVENT_WORKER_ENABLED: "true",
      IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
      IRIS_REINDEX_WORKER_ENABLED: "true",
      IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
      IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "allow-indexed",
    });

    expect(report.ok).toBe(false);
    expect(report.status).toBe("blocked");
    expect(checksById(report)).toMatchObject({
      database: {
        status: "fail",
        envVars: ["DATABASE_URL"],
      },
      feishuWebhookAuth: {
        status: "fail",
        envVars: ["FEISHU_VERIFICATION_TOKEN", "FEISHU_ENCRYPT_KEY"],
      },
      feishuOpenApi: {
        status: "fail",
        envVars: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_OPEN_BASE_URL"],
      },
      feishuBotIdentity: {
        status: "fail",
        envVars: ["IRIS_FEISHU_BOT_OPEN_ID"],
      },
      eventWorker: {
        status: "fail",
        envVars: ["IRIS_EVENT_WORKER_ENABLED", "REDIS_URL"],
      },
      documentSyncWorker: {
        status: "fail",
        envVars: ["IRIS_DOCUMENT_SYNC_WORKER_ENABLED", "REDIS_URL"],
      },
      reindexWorker: {
        status: "fail",
        envVars: ["IRIS_REINDEX_WORKER_ENABLED", "REDIS_URL"],
      },
      answerDraftModel: {
        status: "fail",
        envVars: [
          "IRIS_MODEL_PROVIDER",
          "IRIS_MODEL_BASE_URL",
          "IRIS_MODEL_API_KEY",
          "IRIS_MODEL_NAME",
        ],
      },
      documentEmbeddings: {
        status: "fail",
        envVars: [
          "IRIS_EMBEDDING_PROVIDER",
          "IRIS_EMBEDDING_BASE_URL",
          "IRIS_EMBEDDING_API_KEY",
          "IRIS_EMBEDDING_MODEL",
          "IRIS_EMBEDDING_DIMENSIONS",
        ],
      },
      answerDraftPermissionGuard: {
        status: "fail",
        envVars: ["IRIS_INTERNAL_DRAFT_PERMISSION_MODE", "FEISHU_APP_ID", "FEISHU_APP_SECRET"],
      },
      internalApiToken: {
        status: "warn",
        envVars: ["IRIS_INTERNAL_API_TOKEN"],
      },
    });
  });

  it("keeps the report structured when configured values are invalid", () => {
    const report = buildInternalRolloutReadinessReport(
      readyRolloutEnv({
        PORT: "65536",
        DATABASE_URL: "mysql://iris:iris@localhost:3306/iris",
        REDIS_URL: "https://redis.example.com",
        IRIS_INTERNAL_API_TOKEN: "bad token",
        IRIS_EMBEDDING_DIMENSIONS: "42",
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.status).toBe("blocked");
    expect(checksById(report)).toMatchObject({
      database: {
        status: "fail",
        detail: "DATABASE_URL must be a postgres URL",
      },
      serverPort: {
        status: "fail",
        detail: "PORT must be between 1 and 65535",
        envVars: ["PORT"],
      },
      eventWorker: {
        status: "fail",
        detail: "REDIS_URL must be a redis URL",
      },
      documentSyncWorker: {
        status: "fail",
        detail: "REDIS_URL must be a redis URL",
      },
      reindexWorker: {
        status: "fail",
        detail: "REDIS_URL must be a redis URL",
      },
      documentEmbeddings: {
        status: "fail",
        detail: "Unsupported embedding dimension: 42",
      },
      internalApiToken: {
        status: "fail",
        detail: "IRIS_INTERNAL_API_TOKEN must be a single visible ASCII token without whitespace or commas",
      },
    });
  });
});

function readyRolloutEnv(overrides: EnvLike = {}): EnvLike {
  return {
    DATABASE_URL: "postgres://iris:iris@localhost:5432/iris",
    REDIS_URL: "redis://localhost:6379",
    IRIS_INTERNAL_API_TOKEN: "operator_shared_secret-1",
    FEISHU_VERIFICATION_TOKEN: "verification-token",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
    FEISHU_OPEN_BASE_URL: "https://open.feishu.cn",
    IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
    IRIS_EVENT_WORKER_ENABLED: "true",
    IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
    IRIS_REINDEX_WORKER_ENABLED: "true",
    IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
    IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
    IRIS_MODEL_PROVIDER: "openai-compatible",
    IRIS_MODEL_BASE_URL: "https://model.example.com/v1",
    IRIS_MODEL_API_KEY: "model-key",
    IRIS_MODEL_NAME: "model-name",
    IRIS_EMBEDDING_PROVIDER: "openai-compatible",
    IRIS_EMBEDDING_BASE_URL: "https://embedding.example.com/v1",
    IRIS_EMBEDDING_API_KEY: "embedding-key",
    IRIS_EMBEDDING_MODEL: "embedding-model",
    IRIS_EMBEDDING_DIMENSIONS: "1536",
    ...overrides,
  };
}

function checksById(report: ReturnType<typeof buildInternalRolloutReadinessReport>) {
  return Object.fromEntries(report.checks.map((check) => [check.id, check]));
}
