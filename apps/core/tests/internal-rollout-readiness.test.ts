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
        status: "fail",
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

  it("requires a Feishu verification token for v1 URL verification readiness", () => {
    const report = buildInternalRolloutReadinessReport(
      readyRolloutEnv({
        FEISHU_VERIFICATION_TOKEN: "",
        FEISHU_ENCRYPT_KEY: "encrypt-key-only",
      }),
    );

    expect(report.ok).toBe(false);
    expect(checksById(report)).toMatchObject({
      feishuWebhookAuth: {
        status: "fail",
        detail:
          "FEISHU_VERIFICATION_TOKEN is required for v1 Feishu URL verification; FEISHU_ENCRYPT_KEY only adds signature verification.",
      },
    });
  });

  it("blocks rollout readiness when the internal operator API token is missing", () => {
    const report = buildInternalRolloutReadinessReport(
      readyRolloutEnv({
        IRIS_INTERNAL_API_TOKEN: "",
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.status).toBe("blocked");
    expect(checksById(report)).toMatchObject({
      internalApiToken: {
        status: "fail",
        detail: "IRIS_INTERNAL_API_TOKEN is required before internal rollout.",
      },
    });
  });

  it("rejects template placeholder values copied from the rollout env example", () => {
    const report = buildInternalRolloutReadinessReport(
      readyRolloutEnv({
        IRIS_INTERNAL_API_TOKEN: "replace-with-single-visible-ascii-token",
        FEISHU_APP_ID: "replace-with-feishu-app-id",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "replace-with-embedding-api-key",
      }),
    );

    expect(report.ok).toBe(false);
    expect(checksById(report)).toMatchObject({
      internalApiToken: {
        status: "fail",
        detail: "IRIS_INTERNAL_API_TOKEN must be replaced with a real rollout value",
      },
      feishuOpenApi: {
        status: "fail",
        detail: "FEISHU_APP_ID must be replaced with a real rollout value",
      },
      answerDraftModel: {
        status: "fail",
        detail: "IRIS_MODEL_BASE_URL must be replaced with a real rollout value",
      },
      documentEmbeddings: {
        status: "fail",
        detail: "IRIS_EMBEDDING_API_KEY must be replaced with a real rollout value",
      },
    });
  });

  it("rejects angle-bracket placeholders copied from the rollout runbook", () => {
    const report = buildInternalRolloutReadinessReport(
      readyRolloutEnv({
        IRIS_INTERNAL_API_TOKEN: "<operator-shared-secret>",
        FEISHU_APP_SECRET: "<feishu-app-secret>",
        IRIS_MODEL_API_KEY: "<model-api-key>",
        IRIS_EMBEDDING_MODEL: "<embedding-model>",
      }),
    );

    expect(report.ok).toBe(false);
    expect(checksById(report)).toMatchObject({
      internalApiToken: {
        status: "fail",
        detail: "IRIS_INTERNAL_API_TOKEN must be replaced with a real rollout value",
      },
      feishuOpenApi: {
        status: "fail",
        detail: "FEISHU_APP_SECRET must be replaced with a real rollout value",
      },
      answerDraftModel: {
        status: "fail",
        detail: "IRIS_MODEL_API_KEY must be replaced with a real rollout value",
      },
      documentEmbeddings: {
        status: "fail",
        detail: "IRIS_EMBEDDING_MODEL must be replaced with a real rollout value",
      },
    });
  });

  it("reports the default-off knowledge-card state as safely disabled", () => {
    const report = buildInternalRolloutReadinessReport(readyRolloutEnv());

    expect(checksById(report)).toMatchObject({
      knowledgeCards: {
        status: "pass",
        detail: "Knowledge cards are safely disabled.",
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
      },
    });
  });

  it("passes enabled knowledge cards only while both loops and status are healthy", () => {
    const report = buildInternalRolloutReadinessReport(
      knowledgeCardEnabledEnv(),
      { knowledgeCardStatus: knowledgeCardStatus() },
    );

    expect(checksById(report).knowledgeCards).toMatchObject({
      status: "pass",
      detail: "Knowledge-card dispatcher and interaction worker are running.",
    });
  });

  it("does not block enabled knowledge cards on ordinary in-flight or superseded outbox rows", () => {
    const report = buildInternalRolloutReadinessReport(
      knowledgeCardEnabledEnv(),
      { knowledgeCardStatus: knowledgeCardStatus({
        outbox: {
          pending: 3,
          processing: 2,
          external_attempting: 1,
          sent: 8,
          failed: 4,
          outcome_unknown: 0,
          terminalFailed: 0,
        },
      }) },
    );

    expect(checksById(report).knowledgeCards).toMatchObject({ status: "pass" });
  });

  it.each([
    [
      "missing outbox status",
      undefined,
      "Knowledge-card outbox status is unavailable.",
    ],
    [
      "unresolved outcome-unknown rows",
      {
        pending: 0,
        processing: 0,
        external_attempting: 0,
        sent: 0,
        failed: 0,
        outcome_unknown: 1,
        terminalFailed: 0,
      },
      "Knowledge-card outbox has unresolved outcome-unknown rows.",
    ],
    [
      "terminal failed rows",
      {
        pending: 0,
        processing: 0,
        external_attempting: 0,
        sent: 0,
        failed: 2,
        outcome_unknown: 0,
        terminalFailed: 1,
      },
      "Knowledge-card outbox has terminal failed rows.",
    ],
  ])("fails closed for %s", (_case, outbox, detail) => {
    const report = buildInternalRolloutReadinessReport(
      knowledgeCardEnabledEnv(),
      { knowledgeCardStatus: knowledgeCardStatus({ outbox }) },
    );

    expect(checksById(report).knowledgeCards).toMatchObject({
      status: "fail",
      detail,
    });
  });

  it("fails closed for incomplete config, stopped loops, absent status, and unreadable status", () => {
    const incomplete = buildInternalRolloutReadinessReport(readyRolloutEnv({
      IRIS_KNOWLEDGE_CARD_ENABLED: "true",
      IRIS_KNOWLEDGE_CARD_GROUP_IDS: "",
    }));
    expect(checksById(incomplete).knowledgeCards).toMatchObject({
      status: "fail",
      detail: "IRIS_KNOWLEDGE_CARD_GROUP_IDS must contain at least one group",
    });

    const stopped = buildInternalRolloutReadinessReport(
      knowledgeCardEnabledEnv(),
      { knowledgeCardStatus: knowledgeCardStatus({
        running: false,
        dispatcher: { running: false, intervalMs: 1000, batchLimit: 10 },
      }) },
    );
    expect(checksById(stopped).knowledgeCards).toMatchObject({
      status: "fail",
      detail: "Knowledge-card dispatcher and interaction worker must both be running.",
    });

    const absent = buildInternalRolloutReadinessReport(knowledgeCardEnabledEnv());
    expect(checksById(absent).knowledgeCards).toMatchObject({
      status: "fail",
      detail: "Knowledge-card runtime status is unavailable.",
    });

    const unreadable = buildInternalRolloutReadinessReport(
      knowledgeCardEnabledEnv(),
      { knowledgeCardStatus: {
        ok: false,
        enabled: true,
        running: false,
        degradedReason: "knowledge_card_status_unavailable",
      } },
    );
    expect(checksById(unreadable).knowledgeCards).toMatchObject({
      status: "fail",
      detail: "Knowledge-card runtime status is unreadable.",
    });
  });
});

function knowledgeCardEnabledEnv(): EnvLike {
  return readyRolloutEnv({
    IRIS_KNOWLEDGE_CARD_ENABLED: "true",
    IRIS_KNOWLEDGE_CARD_GROUP_IDS: "oc_pilot",
    FEISHU_ENCRYPT_KEY: "knowledge-card-encrypt-key",
  });
}

function knowledgeCardStatus(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    enabled: true as const,
    running: true,
    enabledGroupCount: 1,
    dispatcher: { running: true, intervalMs: 1000, batchLimit: 10 },
    worker: { running: true, intervalMs: 1000, batchLimit: 10 },
    queue: { pending: 0, processing: 0, delayed: 0, deadLetter: 0 },
    presentations: {
      pending_send: 0,
      active: 0,
      superseded: 0,
      closed: 0,
      send_failed: 0,
      pendingSend: 0,
    },
    outbox: {
      pending: 0,
      processing: 0,
      external_attempting: 0,
      sent: 0,
      failed: 0,
      outcome_unknown: 0,
      terminalFailed: 0,
    },
    ...overrides,
  };
}

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
