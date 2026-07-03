import { describe, expect, it } from "vitest";
import {
  readAnswerDraftRuntimeConfig,
  readEmbeddingProviderConfig,
  readEventWorkerRuntimeConfig,
  readFeishuAuthConfig,
  readFeishuOpenApiConfig,
  readDocumentSyncWorkerRuntimeConfig,
  readModelProviderConfig,
  readReindexWorkerRuntimeConfig,
} from "../src/config/env.js";

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
        IRIS_EMBEDDING_TIMEOUT_MS: "0",
      }),
    ).toThrow("IRIS_EMBEDDING_TIMEOUT_MS must be a positive integer");
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
});

describe("readFeishuOpenApiConfig", () => {
  it("reads Feishu OpenAPI config and trims values", () => {
    expect(
      readFeishuOpenApiConfig({
        FEISHU_APP_ID: " app-id ",
        FEISHU_APP_SECRET: " app-secret ",
        FEISHU_OPEN_BASE_URL: " https://open.example.com/ ",
        IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS: " 2500 ",
      }),
    ).toEqual({
      appId: "app-id",
      appSecret: "app-secret",
      baseUrl: "https://open.example.com",
      documentFetchTimeoutMs: 2500,
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
});
