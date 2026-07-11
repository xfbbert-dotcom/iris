import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { EnvLike } from "../src/config/env.js";
import { isolateEnvVar } from "./test-env.js";

let restoreInternalApiToken: () => void = () => undefined;

beforeEach(() => {
  restoreInternalApiToken = isolateEnvVar("IRIS_INTERNAL_API_TOKEN");
});

afterEach(() => {
  restoreInternalApiToken();
});

describe("GET /internal/readiness", () => {
  it("returns the internal rollout readiness report for the configured environment", async () => {
    const app = buildApp({
      readinessEnv: readyRolloutEnv(),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/readiness",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      status: "ready",
      schemaVersion: 1,
      summary: {
        failCount: 0,
        warnCount: 0,
      },
    });
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
