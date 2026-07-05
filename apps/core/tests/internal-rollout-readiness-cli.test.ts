import { describe, expect, it } from "vitest";

import {
  buildInternalRolloutReadinessEnv,
  formatInternalRolloutReadinessReport,
  getInternalRolloutReadinessExitCode,
  parseEnvFileContents,
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

  it("parses dotenv-style env files used by rollout operators", () => {
    expect(
      parseEnvFileContents(`
# comment
DATABASE_URL = postgres://iris:iris@localhost:5432/iris
export REDIS_URL="redis://localhost:6379"
IRIS_MODEL_NAME='gpt-4.1-mini'
EMPTY_VALUE=
      `),
    ).toEqual({
      DATABASE_URL: "postgres://iris:iris@localhost:5432/iris",
      REDIS_URL: "redis://localhost:6379",
      IRIS_MODEL_NAME: "gpt-4.1-mini",
      EMPTY_VALUE: "",
    });
  });

  it("allows operator comments after env file values", () => {
    expect(
      parseEnvFileContents(`
PORT=3000 # local dev port
IRIS_MODEL_NAME="gpt-4.1-mini" # answer model
IRIS_MODEL_API_KEY='sk-test # not a comment' # secret note
FEISHU_OPEN_BASE_URL=https://open.feishu.cn#keep-fragment-like-text
EMPTY_VALUE= # empty on purpose
      `),
    ).toEqual({
      PORT: "3000",
      IRIS_MODEL_NAME: "gpt-4.1-mini",
      IRIS_MODEL_API_KEY: "sk-test # not a comment",
      FEISHU_OPEN_BASE_URL: "https://open.feishu.cn#keep-fragment-like-text",
      EMPTY_VALUE: "",
    });
  });

  it("rejects non-comment trailing content after quoted env file values", () => {
    expect(() => parseEnvFileContents('PORT="3000" trailing')).toThrow(
      "Invalid env file line 1",
    );
  });

  it("loads an explicit env file over the base process environment", () => {
    const env = buildInternalRolloutReadinessEnv({
      args: ["--env-file", ".env.rollout"],
      env: readyRolloutEnv({ PORT: "65536" }),
      readTextFile: (path) => {
        expect(path).toBe(".env.rollout");
        return "PORT=3000\n";
      },
    });

    expect(buildInternalRolloutReadinessReport(env)).toMatchObject({
      ok: true,
      status: "ready",
    });
  });

  it("rejects invalid env file lines with the line number", () => {
    expect(() => parseEnvFileContents("DATABASE_URL=postgres://example\nnot valid")).toThrow(
      "Invalid env file line 2",
    );
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
