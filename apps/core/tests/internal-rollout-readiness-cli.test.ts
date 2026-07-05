import { describe, expect, it } from "vitest";

import {
  formatInternalRolloutReadinessReport,
  getInternalRolloutReadinessExitCode,
} from "../src/admin/internal-rollout-readiness-cli.js";
import { buildInternalRolloutReadinessReport } from "../src/admin/internal-rollout-readiness.js";
import type { EnvLike } from "../src/config/env.js";

describe("internal rollout readiness CLI helpers", () => {
  it("formats the readiness report as stable pretty JSON", () => {
    const report = buildInternalRolloutReadinessReport(readyRolloutEnv());

    expect(JSON.parse(formatInternalRolloutReadinessReport(report))).toMatchObject({
      ok: true,
      status: "ready",
      schemaVersion: 1,
      summary: {
        failCount: 0,
        warnCount: 0,
      },
    });
  });

  it("uses a failing process exit code only when rollout checks are blocked", () => {
    expect(
      getInternalRolloutReadinessExitCode(
        buildInternalRolloutReadinessReport(readyRolloutEnv()),
      ),
    ).toBe(0);
    expect(getInternalRolloutReadinessExitCode(buildInternalRolloutReadinessReport({}))).toBe(1);
  });
});

function readyRolloutEnv(): EnvLike {
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
  };
}
