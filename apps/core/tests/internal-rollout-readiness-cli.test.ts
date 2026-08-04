import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildInternalRolloutReadinessEnv,
  formatInternalRolloutReadinessReport,
  getInternalRolloutReadinessExitCode,
  parseEnvFileContents,
  resolveInternalRolloutReadinessReport,
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

  it("loads root-relative env files when invoked through the root npm workspace script", () => {
    const rootCwd = process.platform === "win32" ? "D:\\work\\AGE-org" : "/work/AGE-org";
    const expectedEnvFilePath = join(rootCwd, ".env");

    const env = buildInternalRolloutReadinessEnv({
      args: ["--env-file", ".env"],
      env: readyRolloutEnv({ INIT_CWD: rootCwd, PORT: "65536" }),
      fileExists: (path) => path === expectedEnvFilePath,
      readTextFile: (path) => {
        expect(path).toBe(expectedEnvFilePath);
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

  it("uses authenticated live readiness facts when an enabled action-review rollout opts in", async () => {
    const liveReport = enabledActionReviewReport(true);
    const requests: Array<{ url: string; authorization: string | null }> = [];

    const report = await resolveInternalRolloutReadinessReport({
      args: ["--live-readiness-url", "http://127.0.0.1:3000/internal/readiness"],
      env: enabledActionReviewEnv(),
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          authorization: headers.get("authorization"),
        });
        return Response.json(liveReport);
      },
    });

    expect(report).toEqual(liveReport);
    expect(getInternalRolloutReadinessExitCode(report)).toBe(0);
    expect(requests).toEqual([{
      url: "http://127.0.0.1:3000/internal/readiness",
      authorization: "Bearer operator_shared_secret-1",
    }]);
  });

  it("keeps the live CLI blocked when migration 0034 is missing", async () => {
    const report = await resolveInternalRolloutReadinessReport({
      args: ["--live-readiness-url=http://localhost:3000/internal/readiness"],
      env: enabledActionReviewEnv(),
      fetchImpl: async () => Response.json(enabledActionReviewReport(false)),
    });

    expect(getInternalRolloutReadinessExitCode(report)).toBe(1);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "actionReviews",
      status: "fail",
      detail: "Action-review migration 0034 is not applied.",
    }));
  });

  it("does not send the internal token to an unsafe live readiness URL", async () => {
    await expect(resolveInternalRolloutReadinessReport({
      args: ["--live-readiness-url", "https://attacker.example/internal/readiness"],
      env: enabledActionReviewEnv(),
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    })).rejects.toThrow("Live readiness URL must use a loopback host");
  });
});

function enabledActionReviewReport(migration0034Applied: boolean) {
  const zeroOutbox = {
    pending: 0,
    processing: 0,
    external_attempting: 0,
    sent: 0,
    failed: 0,
    outcome_unknown: 0,
    terminalFailed: 0,
  };

  return buildInternalRolloutReadinessReport(enabledActionReviewEnv(), {
    knowledgeCardStatus: {
      ok: true,
      enabled: true,
      running: true,
      dispatcher: { running: true },
      worker: { running: true },
      outbox: zeroOutbox,
    },
    actionApprovalStatus: {
      ok: true,
      enabled: true,
      running: true,
      planner: { running: true },
      dispatcher: { running: true },
      outbox: zeroOutbox,
    },
    actionReviewStatus: {
      configured: true,
      running: true,
      migration0034Applied,
    },
  });
}

function enabledActionReviewEnv(): EnvLike {
  return readyRolloutEnv({
    FEISHU_ENCRYPT_KEY: "encrypt-key",
    IRIS_KNOWLEDGE_CARD_ENABLED: "true",
    IRIS_KNOWLEDGE_CARD_GROUP_IDS: "oc_pilot",
    IRIS_APPROVAL_ACTIONS_ENABLED: "true",
    IRIS_APPROVAL_ACTION_GROUP_IDS: "oc_pilot",
    IRIS_ACTION_REVIEW_ENABLED: "true",
    IRIS_REVIEW_PUBLIC_ORIGIN: "https://iris.example.com",
    IRIS_REVIEW_SESSION_SECRET: "s".repeat(32),
  });
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
