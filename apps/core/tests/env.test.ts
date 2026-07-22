import { describe, expect, it } from "vitest";
import {
  readActionApprovalRuntimeConfig,
  readActionReviewRuntimeConfig,
  readAnswerDraftRuntimeConfig,
  readEmbeddingProviderConfig,
  readEventWorkerRuntimeConfig,
  readFeishuAuthConfig,
  readFeishuOpenApiConfig,
  readOptionalFeishuBotOpenId,
  readOptionalFeishuOpenApiConfig,
  readDocumentSyncWorkerRuntimeConfig,
  readModelProviderConfig,
  readMemoryExtractionRuntimeConfig,
  readKnowledgeCardRuntimeConfig,
  readReindexWorkerRuntimeConfig,
  readServerPort,
} from "../src/config/env.js";

describe("readActionReviewRuntimeConfig", () => {
  const enabledEnv = {
    IRIS_ACTION_REVIEW_ENABLED: "true",
    IRIS_REVIEW_PUBLIC_ORIGIN: "https://iris.example.com",
    IRIS_REVIEW_SESSION_SECRET: "s".repeat(32),
    FEISHU_APP_ID: "cli_review",
    FEISHU_APP_SECRET: "review-secret",
  };

  it("is disabled by default without reading enabled-only secrets", () => {
    expect(readActionReviewRuntimeConfig({})).toEqual({ enabled: false });
    for (const value of ["false", "TRUE", " true ", "1"]) {
      expect(readActionReviewRuntimeConfig({ IRIS_ACTION_REVIEW_ENABLED: value })).toEqual({
        enabled: false,
      });
    }
  });

  it("requires the exact HTTPS review OAuth configuration when enabled", () => {
    expect(() => readActionReviewRuntimeConfig({ IRIS_ACTION_REVIEW_ENABLED: "true" })).toThrow(
      "IRIS_REVIEW_PUBLIC_ORIGIN is required",
    );
    expect(() => readActionReviewRuntimeConfig({
      ...enabledEnv,
      IRIS_REVIEW_PUBLIC_ORIGIN: "http://iris.example.com",
    })).toThrow("IRIS_REVIEW_PUBLIC_ORIGIN must be an exact HTTPS origin");
    expect(() => readActionReviewRuntimeConfig({
      ...enabledEnv,
      IRIS_REVIEW_PUBLIC_ORIGIN: "https://iris.example.com/review",
    })).toThrow("IRIS_REVIEW_PUBLIC_ORIGIN must be an exact HTTPS origin");
    expect(() => readActionReviewRuntimeConfig({
      ...enabledEnv,
      IRIS_REVIEW_SESSION_SECRET: "x".repeat(31),
    })).toThrow("IRIS_REVIEW_SESSION_SECRET must be at least 32 UTF-8 bytes");
    expect(() => readActionReviewRuntimeConfig({
      ...enabledEnv,
      IRIS_FEISHU_OAUTH_AUTHORIZE_URL: "https://accounts.feishu.cn/not-authorize",
    })).toThrow("IRIS_FEISHU_OAUTH_AUTHORIZE_URL must be the official Feishu OAuth authorization endpoint");
  });

  it("normalizes the default official endpoints and enabled credentials", () => {
    expect(readActionReviewRuntimeConfig(enabledEnv)).toMatchObject({
      enabled: true,
      publicOrigin: "https://iris.example.com",
      sessionSecret: "s".repeat(32),
      authorizeUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
      feishuOpenApi: {
        appId: "cli_review",
        appSecret: "review-secret",
        baseUrl: "https://open.feishu.cn",
      },
    });
  });
});

describe("readActionApprovalRuntimeConfig", () => {
  const enabledEnv = {
    IRIS_APPROVAL_ACTIONS_ENABLED: "true",
    IRIS_APPROVAL_ACTION_GROUP_IDS: " oc_pilot ,oc_review ",
    DATABASE_URL: " postgres://iris:secret@postgres:5432/iris ",
  };

  it("is disabled unless explicitly enabled", () => {
    expect(readActionApprovalRuntimeConfig({})).toEqual({ enabled: false });
    for (const value of ["false", "TRUE", " true ", "1"]) {
      expect(readActionApprovalRuntimeConfig({ IRIS_APPROVAL_ACTIONS_ENABLED: value })).toEqual({
        enabled: false,
      });
    }
  });

  it("reads bounded planner and dispatcher configuration", () => {
    expect(readActionApprovalRuntimeConfig({
      ...enabledEnv,
      IRIS_ACTION_PROPOSAL_PLANNER_INTERVAL_MS: "2500",
      IRIS_ACTION_PROPOSAL_PLANNER_BATCH_LIMIT: "12",
      IRIS_ACTION_APPROVAL_DISPATCHER_INTERVAL_MS: "1500",
      IRIS_ACTION_APPROVAL_DISPATCHER_BATCH_LIMIT: "8",
      IRIS_REVIEW_PUBLIC_ORIGIN: " https://iris.example.com/review/ ",
    })).toEqual({
      enabled: true,
      databaseUrl: "postgres://iris:secret@postgres:5432/iris",
      enabledGroupIds: ["oc_pilot", "oc_review"],
      plannerIntervalMs: 2500,
      plannerBatchLimit: 12,
      dispatcherIntervalMs: 1500,
      dispatcherBatchLimit: 8,
      reviewPublicOrigin: "https://iris.example.com/review",
    });
  });

  it("requires an enabled group allowlist and database only when enabled", () => {
    expect(() => readActionApprovalRuntimeConfig({
      ...enabledEnv,
      IRIS_APPROVAL_ACTION_GROUP_IDS: " ",
    })).toThrow("IRIS_APPROVAL_ACTION_GROUP_IDS must contain at least one group");
    expect(() => readActionApprovalRuntimeConfig({
      ...enabledEnv,
      DATABASE_URL: " ",
    })).toThrow("DATABASE_URL is required for database operations");
  });
});

describe("readKnowledgeCardRuntimeConfig", () => {
  const enabledEnv = {
    IRIS_KNOWLEDGE_CARD_ENABLED: "true",
    IRIS_KNOWLEDGE_CARD_GROUP_IDS: " oc_pilot ,oc_review ",
    DATABASE_URL: " postgres://iris:secret@postgres:5432/iris ",
    REDIS_URL: " redis://redis:6379 ",
    FEISHU_VERIFICATION_TOKEN: " verification-token ",
    FEISHU_ENCRYPT_KEY: " encrypt-key ",
    FEISHU_APP_ID: " app-id ",
    FEISHU_APP_SECRET: " app-secret ",
    IRIS_FEISHU_BOT_OPEN_ID: "ou_irisbot",
  };

  it("is disabled unless the feature value is exactly true", () => {
    expect(readKnowledgeCardRuntimeConfig({})).toEqual({ enabled: false });
    for (const value of ["false", "TRUE", " true ", "1"]) {
      expect(readKnowledgeCardRuntimeConfig({ IRIS_KNOWLEDGE_CARD_ENABLED: value })).toEqual({
        enabled: false,
      });
    }
  });

  it("reads normalized enabled config with exact defaults", () => {
    expect(readKnowledgeCardRuntimeConfig(enabledEnv)).toEqual({
      enabled: true,
      databaseUrl: "postgres://iris:secret@postgres:5432/iris",
      redisUrl: "redis://redis:6379",
      enabledGroupIds: ["oc_pilot", "oc_review"],
      intervalMs: 1000,
      batchLimit: 10,
      botOpenId: "ou_irisbot",
    });
  });

  it("requires every enabled runtime authority and adapter input", () => {
    const required = [
      ["IRIS_KNOWLEDGE_CARD_GROUP_IDS", "IRIS_KNOWLEDGE_CARD_GROUP_IDS must contain at least one group"],
      ["DATABASE_URL", "DATABASE_URL is required for database operations"],
      ["REDIS_URL", "REDIS_URL is required"],
      ["FEISHU_VERIFICATION_TOKEN", "FEISHU_VERIFICATION_TOKEN is required"],
      ["FEISHU_ENCRYPT_KEY", "FEISHU_ENCRYPT_KEY is required when knowledge cards are enabled"],
      ["FEISHU_APP_ID", "FEISHU_APP_ID is required"],
      ["FEISHU_APP_SECRET", "FEISHU_APP_SECRET is required"],
      ["IRIS_FEISHU_BOT_OPEN_ID", "IRIS_FEISHU_BOT_OPEN_ID is required when knowledge cards are enabled"],
    ] as const;

    for (const [name, message] of required) {
      expect(() => readKnowledgeCardRuntimeConfig({ ...enabledEnv, [name]: " " })).toThrow(message);
    }
  });

  it("rejects an oversized Feishu encrypt key when knowledge cards are enabled", () => {
    expect(() => readKnowledgeCardRuntimeConfig({
      ...enabledEnv,
      FEISHU_ENCRYPT_KEY: "k".repeat(513),
    })).toThrow("FEISHU_ENCRYPT_KEY must be at most 512 characters");
  });

  it("rejects blank, duplicate, overlong, and oversized group allowlists", () => {
    for (const value of ["oc_one,,oc_two", "oc_one,  ,oc_two"]) {
      expect(() => readKnowledgeCardRuntimeConfig({
        ...enabledEnv,
        IRIS_KNOWLEDGE_CARD_GROUP_IDS: value,
      })).toThrow("IRIS_KNOWLEDGE_CARD_GROUP_IDS must not contain blank group IDs");
    }
    expect(() => readKnowledgeCardRuntimeConfig({
      ...enabledEnv,
      IRIS_KNOWLEDGE_CARD_GROUP_IDS: "oc_one, oc_one",
    })).toThrow("IRIS_KNOWLEDGE_CARD_GROUP_IDS must contain unique group IDs");
    expect(() => readKnowledgeCardRuntimeConfig({
      ...enabledEnv,
      IRIS_KNOWLEDGE_CARD_GROUP_IDS: `oc_${"a".repeat(510)}`,
    })).toThrow("IRIS_KNOWLEDGE_CARD_GROUP_IDS group IDs must be at most 512 characters");
    expect(() => readKnowledgeCardRuntimeConfig({
      ...enabledEnv,
      IRIS_KNOWLEDGE_CARD_GROUP_IDS: Array.from({ length: 101 }, (_, index) => `oc_${index}`).join(","),
    })).toThrow("IRIS_KNOWLEDGE_CARD_GROUP_IDS must contain at most 100 groups");
  });

  it("enforces timer and batch bounds", () => {
    expect(readKnowledgeCardRuntimeConfig({
      ...enabledEnv,
      IRIS_KNOWLEDGE_CARD_WORKER_INTERVAL_MS: "2500",
      IRIS_KNOWLEDGE_CARD_WORKER_BATCH_LIMIT: "100",
    })).toMatchObject({ intervalMs: 2500, batchLimit: 100 });
    expect(() => readKnowledgeCardRuntimeConfig({
      ...enabledEnv,
      IRIS_KNOWLEDGE_CARD_WORKER_INTERVAL_MS: "2147483648",
    })).toThrow("IRIS_KNOWLEDGE_CARD_WORKER_INTERVAL_MS must not exceed 2147483647");
    expect(() => readKnowledgeCardRuntimeConfig({
      ...enabledEnv,
      IRIS_KNOWLEDGE_CARD_WORKER_BATCH_LIMIT: "101",
    })).toThrow("IRIS_KNOWLEDGE_CARD_WORKER_BATCH_LIMIT must not exceed 100");
  });
});

describe("readFeishuAuthConfig", () => {
  it("reads Feishu verification token and encrypt key from the environment", () => {
    expect(
      readFeishuAuthConfig({
        FEISHU_VERIFICATION_TOKEN: "token-a",
        FEISHU_ENCRYPT_KEY: "encrypt-a"
      })
    ).toEqual({
      verificationToken: "token-a",
      encryptKey: "encrypt-a"
    });
  });

  it("treats blank strings as missing values", () => {
    expect(
      readFeishuAuthConfig({
        FEISHU_VERIFICATION_TOKEN: "   ",
        FEISHU_ENCRYPT_KEY: ""
      })
    ).toEqual({});
  });
});

describe("readOptionalFeishuBotOpenId", () => {
  it("returns undefined when the Iris Feishu bot open ID is absent or blank", () => {
    expect(readOptionalFeishuBotOpenId({})).toBeUndefined();
    expect(readOptionalFeishuBotOpenId({ IRIS_FEISHU_BOT_OPEN_ID: "   " })).toBeUndefined();
  });

  it("reads an exact ASCII Iris Feishu bot open ID", () => {
    expect(readOptionalFeishuBotOpenId({ IRIS_FEISHU_BOT_OPEN_ID: "ou_AbC123" })).toBe(
      "ou_AbC123",
    );
  });

  it("rejects oversized Iris Feishu bot open IDs", () => {
    expect(() =>
      readOptionalFeishuBotOpenId({ IRIS_FEISHU_BOT_OPEN_ID: "o".repeat(513) }),
    ).toThrow("IRIS_FEISHU_BOT_OPEN_ID must be at most 512 characters");
  });

  it.each([
    " ou_iris ",
    "ou_iris bot",
    "ou_iris\u0000hidden",
    "ou_iris\u007f",
    "ou_caf\u00e9",
    "on_iris",
    "ou_",
    "ou_iris-1",
  ])("rejects an unsafe Iris Feishu bot open ID without echoing it: %j", (value) => {
    let error: unknown;
    try {
      readOptionalFeishuBotOpenId({ IRIS_FEISHU_BOT_OPEN_ID: value });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "IRIS_FEISHU_BOT_OPEN_ID must match the Feishu open ID format",
    );
    expect((error as Error).message).not.toContain(value);
  });
});

describe("readServerPort", () => {
  it("defaults to port 3000", () => {
    expect(readServerPort({})).toBe(3000);
    expect(readServerPort({ PORT: "   " })).toBe(3000);
  });

  it("reads trimmed decimal port values", () => {
    expect(readServerPort({ PORT: " 62761 " })).toBe(62761);
  });

  it("rejects invalid server port values", () => {
    expect(() => readServerPort({ PORT: "0" })).toThrow(
      "PORT must be a positive integer",
    );
    expect(() => readServerPort({ PORT: "65536" })).toThrow(
      "PORT must be between 1 and 65535",
    );
    expect(() => readServerPort({ PORT: "1e3" })).toThrow(
      "PORT must be a positive integer",
    );
  });
});

describe("readEventWorkerRuntimeConfig", () => {
  it("returns disabled config by default", () => {
    expect(readEventWorkerRuntimeConfig({})).toEqual({ enabled: false });
    expect(readEventWorkerRuntimeConfig({ IRIS_EVENT_WORKER_ENABLED: "false" })).toEqual({
      enabled: false,
    });
  });

  it("reads enabled Redis event worker config", () => {
    expect(
      readEventWorkerRuntimeConfig({
        IRIS_EVENT_WORKER_ENABLED: " true ",
        REDIS_URL: " redis://localhost:6379 ",
        IRIS_EVENT_WORKER_INTERVAL_MS: " 2000 ",
        IRIS_EVENT_WORKER_BATCH_LIMIT: " 25 ",
      }),
    ).toEqual({
      enabled: true,
      redisUrl: "redis://localhost:6379",
      intervalMs: 2000,
      batchLimit: 25,
    });
  });

  it("accepts secure Redis URLs with credentials and database paths", () => {
    expect(
      readEventWorkerRuntimeConfig({
        IRIS_EVENT_WORKER_ENABLED: "true",
        REDIS_URL: " rediss://:secret@redis.example.com:6380/1 ",
      }),
    ).toMatchObject({
      enabled: true,
      redisUrl: "rediss://:secret@redis.example.com:6380/1",
    });
  });

  it("defaults enabled event worker interval, batch limit, and Redis URL", () => {
    expect(
      readEventWorkerRuntimeConfig({
        IRIS_EVENT_WORKER_ENABLED: "true",
      }),
    ).toEqual({
      enabled: true,
      redisUrl: "redis://localhost:6379",
      intervalMs: 1000,
      batchLimit: 50,
    });
  });

  it("rejects non-decimal event worker numeric config values", () => {
    expect(() =>
      readEventWorkerRuntimeConfig({
        IRIS_EVENT_WORKER_ENABLED: "true",
        IRIS_EVENT_WORKER_BATCH_LIMIT: "10.0",
      }),
    ).toThrow("IRIS_EVENT_WORKER_BATCH_LIMIT must be a positive integer");
  });

  it("rejects invalid Redis URLs when the event worker is enabled", () => {
    expect(() =>
      readEventWorkerRuntimeConfig({
        IRIS_EVENT_WORKER_ENABLED: "true",
        REDIS_URL: "not a url",
      }),
    ).toThrow("REDIS_URL must be a redis URL");
    expect(() =>
      readEventWorkerRuntimeConfig({
        IRIS_EVENT_WORKER_ENABLED: "true",
        REDIS_URL: "https://redis.example.com",
      }),
    ).toThrow("REDIS_URL must be a redis URL");
  });

  it("rejects intervals above Node's maximum timer delay", () => {
    expect(() =>
      readEventWorkerRuntimeConfig({
        IRIS_EVENT_WORKER_ENABLED: "true",
        IRIS_EVENT_WORKER_INTERVAL_MS: "2147483648",
      }),
    ).toThrow("IRIS_EVENT_WORKER_INTERVAL_MS must not exceed 2147483647");
  });
});

describe("readMemoryExtractionRuntimeConfig", () => {
  const enabledEnv = {
    IRIS_MEMORY_EXTRACTION_ENABLED: "true",
    DATABASE_URL: "postgres://iris:secret@db.example.com:5432/iris",
    REDIS_URL: "rediss://:secret@redis.example.com:6380/1",
    IRIS_AI_WORKER_BASE_URL: "http://ai-worker:8000/",
    IRIS_AI_WORKER_TOKEN: "worker-token",
    IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
  };

  it("is disabled by default without reading enabled-only configuration", () => {
    expect(readMemoryExtractionRuntimeConfig({})).toEqual({ enabled: false });
    expect(
      readMemoryExtractionRuntimeConfig({
        IRIS_MEMORY_EXTRACTION_ENABLED: "false",
        DATABASE_URL: "not-a-database-url",
        REDIS_URL: "not-a-redis-url",
        IRIS_AI_WORKER_BASE_URL: "file:///secret",
        IRIS_AI_WORKER_TOKEN: "not safe",
      }),
    ).toEqual({ enabled: false });
  });

  it("reads exact enabled defaults and bounded overrides", () => {
    expect(readMemoryExtractionRuntimeConfig(enabledEnv)).toEqual({
      enabled: true,
      databaseUrl: "postgres://iris:secret@db.example.com:5432/iris",
      redisUrl: "rediss://:secret@redis.example.com:6380/1",
      aiWorkerBaseUrl: "http://ai-worker:8000",
      aiWorkerToken: "worker-token",
      irisBotOpenId: "ou_iris",
      intervalMs: 1000,
      batchLimit: 20,
      minConfidence: 0.85,
      threadEnabledGroupIds: [],
      actionEnabledGroupIds: [],
      candidateConfidenceFloor: 0.65,
      applyConfidence: 0.85,
    });
    expect(
      readMemoryExtractionRuntimeConfig({
        ...enabledEnv,
        IRIS_MEMORY_EXTRACTION_INTERVAL_MS: " 2500 ",
        IRIS_MEMORY_EXTRACTION_BATCH_LIMIT: " 100 ",
        IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE: " 1 ",
      }),
    ).toMatchObject({
      intervalMs: 2500,
      batchLimit: 100,
      minConfidence: 1,
    });
  });

  it("requires strict database, Redis, worker, and bot identity configuration", () => {
    for (const [name, message] of [
      ["DATABASE_URL", "DATABASE_URL is required for database operations"],
      ["REDIS_URL", "REDIS_URL is required"],
      ["IRIS_AI_WORKER_BASE_URL", "IRIS_AI_WORKER_BASE_URL is required"],
      ["IRIS_AI_WORKER_TOKEN", "IRIS_AI_WORKER_TOKEN is required"],
      ["IRIS_FEISHU_BOT_OPEN_ID", "IRIS_FEISHU_BOT_OPEN_ID is required"],
    ] as const) {
      const env = { ...enabledEnv, [name]: undefined };
      expect(() => readMemoryExtractionRuntimeConfig(env)).toThrow(message);
    }

    expect(() =>
      readMemoryExtractionRuntimeConfig({ ...enabledEnv, DATABASE_URL: "https://db.example.com" }),
    ).toThrow("DATABASE_URL must be a postgres URL");
    expect(() =>
      readMemoryExtractionRuntimeConfig({ ...enabledEnv, REDIS_URL: "https://redis.example.com" }),
    ).toThrow("REDIS_URL must be a redis URL");
  });

  it.each([
    ["ftp://ai-worker", "IRIS_AI_WORKER_BASE_URL must be an http(s) URL"],
    ["https://user:secret@ai-worker", "IRIS_AI_WORKER_BASE_URL must not include embedded credentials"],
    ["https://ai-worker/path?token=secret", "IRIS_AI_WORKER_BASE_URL must not include query or fragment"],
    ["https://ai-worker/path#secret", "IRIS_AI_WORKER_BASE_URL must not include query or fragment"],
    ["https://ai-worker/\npath", "IRIS_AI_WORKER_BASE_URL must not include control characters"],
  ])("rejects unsafe AI Worker URL %s", (value, message) => {
    expect(() =>
      readMemoryExtractionRuntimeConfig({ ...enabledEnv, IRIS_AI_WORKER_BASE_URL: value }),
    ).toThrow(message);
  });

  it.each(["", "worker token", "worker,token", "令牌", "worker\ntoken"])(
    "rejects an unsafe AI Worker token without echoing it: %j",
    (value) => {
      let error: unknown;
      try {
        readMemoryExtractionRuntimeConfig({ ...enabledEnv, IRIS_AI_WORKER_TOKEN: value });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/^IRIS_AI_WORKER_TOKEN /);
      if (value.length > 0) {
        expect((error as Error).message).not.toContain(value);
      }
    },
  );

  it.each([
    ["IRIS_MEMORY_EXTRACTION_INTERVAL_MS", "0", "must be a positive integer"],
    ["IRIS_MEMORY_EXTRACTION_INTERVAL_MS", "2147483648", "must not exceed 2147483647"],
    ["IRIS_MEMORY_EXTRACTION_BATCH_LIMIT", "10.0", "must be a positive integer"],
    ["IRIS_MEMORY_EXTRACTION_BATCH_LIMIT", "101", "must not exceed 100"],
    ["IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE", "-0.01", "must be between 0 and 1"],
    ["IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE", "1.01", "must be between 0 and 1"],
    ["IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE", "NaN", "must be between 0 and 1"],
    ["IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE", "Infinity", "must be between 0 and 1"],
  ])("rejects unsafe numeric config %s=%s", (name, value, message) => {
    expect(() =>
      readMemoryExtractionRuntimeConfig({ ...enabledEnv, [name]: value }),
    ).toThrow(`${name} ${message}`);
  });
});

describe("readModelProviderConfig", () => {
  it("returns undefined when no model provider is configured", () => {
    expect(readModelProviderConfig({})).toBeUndefined();
  });

  it("reads openai-compatible model config and trims values", () => {
    expect(
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: " openai-compatible ",
        IRIS_MODEL_BASE_URL: " https://api.example.com/v1/ ",
        IRIS_MODEL_API_KEY: " key-a ",
        IRIS_MODEL_NAME: " model-a ",
        IRIS_MODEL_TIMEOUT_MS: " 1500 ",
      }),
    ).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "key-a",
      model: "model-a",
      timeoutMs: 1500,
    });
  });

  it("rejects incomplete openai-compatible config", () => {
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
      }),
    ).toThrow("IRIS_MODEL_API_KEY is required");
  });

  it("rejects invalid timeout values", () => {
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
        IRIS_MODEL_API_KEY: "key-a",
        IRIS_MODEL_NAME: "model-a",
        IRIS_MODEL_TIMEOUT_MS: "0",
      }),
    ).toThrow("IRIS_MODEL_TIMEOUT_MS must be a positive integer");
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
        IRIS_MODEL_API_KEY: "key-a",
        IRIS_MODEL_NAME: "model-a",
        IRIS_MODEL_TIMEOUT_MS: "1e3",
      }),
    ).toThrow("IRIS_MODEL_TIMEOUT_MS must be a positive integer");
  });

  it("rejects unsafe integer timeout values", () => {
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
        IRIS_MODEL_API_KEY: "key-a",
        IRIS_MODEL_NAME: "model-a",
        IRIS_MODEL_TIMEOUT_MS: "9007199254740992",
      }),
    ).toThrow("IRIS_MODEL_TIMEOUT_MS must be a positive safe integer");
  });

  it("rejects timeout values above Node's maximum timer delay", () => {
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
        IRIS_MODEL_API_KEY: "key-a",
        IRIS_MODEL_NAME: "model-a",
        IRIS_MODEL_TIMEOUT_MS: "2147483648",
      }),
    ).toThrow("IRIS_MODEL_TIMEOUT_MS must not exceed 2147483647");
  });

  it("rejects invalid model provider base URLs", () => {
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "not-a-url",
        IRIS_MODEL_API_KEY: "key-a",
        IRIS_MODEL_NAME: "model-a",
      }),
    ).toThrow("IRIS_MODEL_BASE_URL must be an http(s) URL");
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "ftp://api.example.com/v1",
        IRIS_MODEL_API_KEY: "key-a",
        IRIS_MODEL_NAME: "model-a",
      }),
    ).toThrow("IRIS_MODEL_BASE_URL must be an http(s) URL");
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1?tenant=a",
        IRIS_MODEL_API_KEY: "key-a",
        IRIS_MODEL_NAME: "model-a",
      }),
    ).toThrow("IRIS_MODEL_BASE_URL must not include query or fragment");
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://user:pass@api.example.com/v1",
        IRIS_MODEL_API_KEY: "key-a",
        IRIS_MODEL_NAME: "model-a",
      }),
    ).toThrow("IRIS_MODEL_BASE_URL must not include embedded credentials");
  });
});

describe("readEmbeddingProviderConfig", () => {
  it("returns undefined when no embedding provider is configured", () => {
    expect(readEmbeddingProviderConfig({})).toBeUndefined();
  });

  it("reads openai-compatible embedding config and trims values", () => {
    expect(
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: " openai-compatible ",
        IRIS_EMBEDDING_BASE_URL: " https://api.example.com/v1/ ",
        IRIS_EMBEDDING_API_KEY: " key-a ",
        IRIS_EMBEDDING_MODEL: " embedding-model ",
        IRIS_EMBEDDING_DIMENSIONS: " 1536 ",
        IRIS_EMBEDDING_TIMEOUT_MS: " 2500 ",
      }),
    ).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "key-a",
      model: "embedding-model",
      dimensions: 1536,
      timeoutMs: 2500,
    });
  });

  it("omits dimensions when not configured", () => {
    expect(
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
      }),
    ).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "key-a",
      model: "embedding-model",
      timeoutMs: 30000,
    });
  });

  it("rejects incomplete openai-compatible embedding config", () => {
    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
      }),
    ).toThrow("IRIS_EMBEDDING_API_KEY is required");
  });

  it("rejects invalid dimensions and timeout values", () => {
    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
        IRIS_EMBEDDING_DIMENSIONS: "-1",
      }),
    ).toThrow("IRIS_EMBEDDING_DIMENSIONS must be a positive integer");
    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
        IRIS_EMBEDDING_DIMENSIONS: "0x600",
      }),
    ).toThrow("IRIS_EMBEDDING_DIMENSIONS must be a positive integer");

    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
        IRIS_EMBEDDING_TIMEOUT_MS: "0",
      }),
    ).toThrow("IRIS_EMBEDDING_TIMEOUT_MS must be a positive integer");
  });

  it("rejects unsafe integer dimensions", () => {
    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
        IRIS_EMBEDDING_DIMENSIONS: "9007199254740992",
      }),
    ).toThrow("IRIS_EMBEDDING_DIMENSIONS must be a positive safe integer");
  });

  it("rejects timeout values above Node's maximum timer delay", () => {
    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
        IRIS_EMBEDDING_TIMEOUT_MS: "2147483648",
      }),
    ).toThrow("IRIS_EMBEDDING_TIMEOUT_MS must not exceed 2147483647");
  });

  it("rejects invalid embedding provider base URLs", () => {
    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "not-a-url",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
      }),
    ).toThrow("IRIS_EMBEDDING_BASE_URL must be an http(s) URL");
    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "ftp://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
      }),
    ).toThrow("IRIS_EMBEDDING_BASE_URL must be an http(s) URL");
    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1#fragment",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
      }),
    ).toThrow("IRIS_EMBEDDING_BASE_URL must not include query or fragment");
    expect(() =>
      readEmbeddingProviderConfig({
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://user@api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "key-a",
        IRIS_EMBEDDING_MODEL: "embedding-model",
      }),
    ).toThrow("IRIS_EMBEDDING_BASE_URL must not include embedded credentials");
  });
});

describe("readAnswerDraftRuntimeConfig", () => {
  it("returns disabled config when internal answer drafts are not enabled", () => {
    expect(readAnswerDraftRuntimeConfig({})).toEqual({ enabled: false });
    expect(readAnswerDraftRuntimeConfig({ IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "false" })).toEqual({
      enabled: false,
    });
  });

  it("reads enabled allow-indexed runtime config", () => {
    expect(
      readAnswerDraftRuntimeConfig({
        IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: " true ",
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: " allow-indexed ",
      }),
    ).toEqual({
      enabled: true,
      permissionMode: "allow-indexed",
    });
  });

  it("reads enabled source-policy runtime config", () => {
    expect(
      readAnswerDraftRuntimeConfig({
        IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: " true ",
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: " source-policy ",
      }),
    ).toEqual({
      enabled: true,
      permissionMode: "source-policy",
    });
  });

  it("requires permission mode when runtime is enabled", () => {
    expect(() =>
      readAnswerDraftRuntimeConfig({ IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true" }),
    ).toThrow("IRIS_INTERNAL_DRAFT_PERMISSION_MODE is required");
  });

  it("rejects unsupported permission modes", () => {
    expect(() =>
      readAnswerDraftRuntimeConfig({
        IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "live-feishu",
      }),
    ).toThrow("Unsupported IRIS_INTERNAL_DRAFT_PERMISSION_MODE: live-feishu");
  });
});

describe("readReindexWorkerRuntimeConfig", () => {
  it("returns disabled config by default", () => {
    expect(readReindexWorkerRuntimeConfig({})).toEqual({ enabled: false });
    expect(readReindexWorkerRuntimeConfig({ IRIS_REINDEX_WORKER_ENABLED: "false" })).toEqual({
      enabled: false,
    });
  });

  it("reads enabled Redis worker config", () => {
    expect(
      readReindexWorkerRuntimeConfig({
        IRIS_REINDEX_WORKER_ENABLED: " true ",
        REDIS_URL: " redis://localhost:6379 ",
        IRIS_REINDEX_WORKER_INTERVAL_MS: " 500 ",
        IRIS_REINDEX_WORKER_BATCH_LIMIT: " 10 ",
      }),
    ).toEqual({
      enabled: true,
      redisUrl: "redis://localhost:6379",
      intervalMs: 500,
      batchLimit: 10,
    });
  });

  it("defaults enabled worker interval, batch limit, and Redis URL", () => {
    expect(
      readReindexWorkerRuntimeConfig({
        IRIS_REINDEX_WORKER_ENABLED: "true",
      }),
    ).toEqual({
      enabled: true,
      redisUrl: "redis://localhost:6379",
      intervalMs: 1000,
      batchLimit: 25,
    });
  });

  it("rejects invalid interval and batch limit values", () => {
    expect(() =>
      readReindexWorkerRuntimeConfig({
        IRIS_REINDEX_WORKER_ENABLED: "true",
        IRIS_REINDEX_WORKER_INTERVAL_MS: "0",
      }),
    ).toThrow("IRIS_REINDEX_WORKER_INTERVAL_MS must be a positive integer");

    expect(() =>
      readReindexWorkerRuntimeConfig({
        IRIS_REINDEX_WORKER_ENABLED: "true",
        IRIS_REINDEX_WORKER_BATCH_LIMIT: "-1",
      }),
    ).toThrow("IRIS_REINDEX_WORKER_BATCH_LIMIT must be a positive integer");
  });

  it("rejects intervals above Node's maximum timer delay", () => {
    expect(() =>
      readReindexWorkerRuntimeConfig({
        IRIS_REINDEX_WORKER_ENABLED: "true",
        IRIS_REINDEX_WORKER_INTERVAL_MS: "2147483648",
      }),
    ).toThrow("IRIS_REINDEX_WORKER_INTERVAL_MS must not exceed 2147483647");
  });
});

describe("readDocumentSyncWorkerRuntimeConfig", () => {
  it("returns disabled config by default", () => {
    expect(readDocumentSyncWorkerRuntimeConfig({})).toEqual({ enabled: false });
    expect(
      readDocumentSyncWorkerRuntimeConfig({ IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "false" }),
    ).toEqual({ enabled: false });
  });

  it("reads enabled worker config with defaults", () => {
    expect(
      readDocumentSyncWorkerRuntimeConfig({
        IRIS_DOCUMENT_SYNC_WORKER_ENABLED: " true ",
      }),
    ).toEqual({
      enabled: true,
      redisUrl: "redis://localhost:6379",
      intervalMs: 1000,
      batchLimit: 10,
    });
  });

  it("reads enabled worker config overrides", () => {
    expect(
      readDocumentSyncWorkerRuntimeConfig({
        IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
        REDIS_URL: " redis://redis.example.com:6379 ",
        IRIS_DOCUMENT_SYNC_WORKER_INTERVAL_MS: " 2500 ",
        IRIS_DOCUMENT_SYNC_WORKER_BATCH_LIMIT: " 4 ",
      }),
    ).toEqual({
      enabled: true,
      redisUrl: "redis://redis.example.com:6379",
      intervalMs: 2500,
      batchLimit: 4,
    });
  });

  it("rejects invalid interval and batch limit values", () => {
    expect(() =>
      readDocumentSyncWorkerRuntimeConfig({
        IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
        IRIS_DOCUMENT_SYNC_WORKER_INTERVAL_MS: "0",
      }),
    ).toThrow("IRIS_DOCUMENT_SYNC_WORKER_INTERVAL_MS must be a positive integer");

    expect(() =>
      readDocumentSyncWorkerRuntimeConfig({
        IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
        IRIS_DOCUMENT_SYNC_WORKER_BATCH_LIMIT: "-1",
      }),
    ).toThrow("IRIS_DOCUMENT_SYNC_WORKER_BATCH_LIMIT must be a positive integer");
  });

  it("rejects intervals above Node's maximum timer delay", () => {
    expect(() =>
      readDocumentSyncWorkerRuntimeConfig({
        IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
        IRIS_DOCUMENT_SYNC_WORKER_INTERVAL_MS: "2147483648",
      }),
    ).toThrow("IRIS_DOCUMENT_SYNC_WORKER_INTERVAL_MS must not exceed 2147483647");
  });
});

describe("readFeishuOpenApiConfig", () => {
  it("returns undefined for optional Feishu OpenAPI config when credentials are absent", () => {
    expect(readOptionalFeishuOpenApiConfig({})).toBeUndefined();
  });

  it("reads optional Feishu OpenAPI config when credentials are present", () => {
    expect(
      readOptionalFeishuOpenApiConfig({
        FEISHU_APP_ID: " app-id ",
        FEISHU_APP_SECRET: " app-secret ",
        FEISHU_OPEN_BASE_URL: " https://open.example.com/ ",
        IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS: " 2500 ",
        IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS: " 12345 ",
      }),
    ).toEqual({
      appId: "app-id",
      appSecret: "app-secret",
      baseUrl: "https://open.example.com",
      documentFetchTimeoutMs: 2500,
      documentMaxContentChars: 12345,
    });
  });

  it("rejects partially configured optional Feishu OpenAPI credentials", () => {
    expect(() => readOptionalFeishuOpenApiConfig({ FEISHU_APP_ID: "app-id" })).toThrow(
      "FEISHU_APP_SECRET is required",
    );
  });

  it("reads Feishu OpenAPI config and trims values", () => {
    expect(
      readFeishuOpenApiConfig({
        FEISHU_APP_ID: " app-id ",
        FEISHU_APP_SECRET: " app-secret ",
        FEISHU_OPEN_BASE_URL: " https://open.example.com/ ",
        IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS: " 2500 ",
        IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS: " 12345 ",
      }),
    ).toEqual({
      appId: "app-id",
      appSecret: "app-secret",
      baseUrl: "https://open.example.com",
      documentFetchTimeoutMs: 2500,
      documentMaxContentChars: 12345,
    });
  });

  it("defaults Feishu OpenAPI base URL and document fetch timeout", () => {
    expect(
      readFeishuOpenApiConfig({
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
      }),
    ).toEqual({
      appId: "app-id",
      appSecret: "app-secret",
      baseUrl: "https://open.feishu.cn",
      documentFetchTimeoutMs: 10000,
      documentMaxContentChars: 2000000,
    });
  });

  it("requires Feishu app credentials", () => {
    expect(() => readFeishuOpenApiConfig({ FEISHU_APP_ID: "app-id" })).toThrow(
      "FEISHU_APP_SECRET is required",
    );
  });

  it("rejects invalid Feishu document fetch timeout values", () => {
    expect(() =>
      readFeishuOpenApiConfig({
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS: "0",
      }),
    ).toThrow("IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS must be a positive integer");
  });

  it("rejects invalid Feishu document content size values", () => {
    expect(() =>
      readFeishuOpenApiConfig({
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS: "0",
      }),
    ).toThrow("IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS must be a positive integer");
  });

  it("rejects Feishu document fetch timeouts above Node's maximum timer delay", () => {
    expect(() =>
      readFeishuOpenApiConfig({
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS: "2147483648",
      }),
    ).toThrow("IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS must not exceed 2147483647");
  });

  it("rejects invalid Feishu OpenAPI base URLs", () => {
    expect(() =>
      readFeishuOpenApiConfig({
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        FEISHU_OPEN_BASE_URL: "not-a-url",
      }),
    ).toThrow("FEISHU_OPEN_BASE_URL must be an http(s) URL");
    expect(() =>
      readFeishuOpenApiConfig({
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        FEISHU_OPEN_BASE_URL: "ftp://open.feishu.cn",
      }),
    ).toThrow("FEISHU_OPEN_BASE_URL must be an http(s) URL");
    expect(() =>
      readFeishuOpenApiConfig({
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        FEISHU_OPEN_BASE_URL: "https://open.feishu.cn?tenant=a",
      }),
    ).toThrow("FEISHU_OPEN_BASE_URL must not include query or fragment");
    expect(() =>
      readFeishuOpenApiConfig({
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        FEISHU_OPEN_BASE_URL: "https://app:secret@open.feishu.cn",
      }),
    ).toThrow("FEISHU_OPEN_BASE_URL must not include embedded credentials");
  });
});
