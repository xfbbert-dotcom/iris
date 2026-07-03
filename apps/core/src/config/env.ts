import type { FeishuAuthConfig } from "../feishu/feishu-auth.js";

export type EnvLike = Record<string, string | undefined>;

export type ModelProviderConfig = {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export type EmbeddingProviderConfig = {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
  timeoutMs: number;
};

export type AnswerDraftPermissionMode = "allow-indexed" | "source-policy";

export type AnswerDraftRuntimeConfig =
  | { enabled: false }
  | { enabled: true; permissionMode: AnswerDraftPermissionMode };

export type ReindexWorkerRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      redisUrl: string;
      intervalMs: number;
      batchLimit: number;
    };

export type EventWorkerRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      redisUrl: string;
      intervalMs: number;
      batchLimit: number;
    };

export type DocumentSyncWorkerRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      redisUrl: string;
      intervalMs: number;
      batchLimit: number;
    };

export type FeishuOpenApiConfig = {
  appId: string;
  appSecret: string;
  baseUrl: string;
};

export function readFeishuAuthConfig(env: EnvLike = process.env): FeishuAuthConfig {
  return {
    verificationToken: readOptionalEnv(env.FEISHU_VERIFICATION_TOKEN),
    encryptKey: readOptionalEnv(env.FEISHU_ENCRYPT_KEY)
  };
}

export function readModelProviderConfig(env: EnvLike = process.env): ModelProviderConfig | undefined {
  const provider = readOptionalEnv(env.IRIS_MODEL_PROVIDER);
  if (provider === undefined) {
    return undefined;
  }
  if (provider !== "openai-compatible") {
    throw new Error(`Unsupported IRIS_MODEL_PROVIDER: ${provider}`);
  }

  return {
    provider,
    baseUrl: trimTrailingSlash(readRequiredEnv("IRIS_MODEL_BASE_URL", env.IRIS_MODEL_BASE_URL)),
    apiKey: readRequiredEnv("IRIS_MODEL_API_KEY", env.IRIS_MODEL_API_KEY),
    model: readRequiredEnv("IRIS_MODEL_NAME", env.IRIS_MODEL_NAME),
    timeoutMs: readPositiveIntegerEnv("IRIS_MODEL_TIMEOUT_MS", env.IRIS_MODEL_TIMEOUT_MS, 30000)
  };
}

export function readEmbeddingProviderConfig(
  env: EnvLike = process.env
): EmbeddingProviderConfig | undefined {
  const provider = readOptionalEnv(env.IRIS_EMBEDDING_PROVIDER);
  if (provider === undefined) {
    return undefined;
  }
  if (provider !== "openai-compatible") {
    throw new Error(`Unsupported IRIS_EMBEDDING_PROVIDER: ${provider}`);
  }

  const dimensions = readOptionalPositiveIntegerEnv(
    "IRIS_EMBEDDING_DIMENSIONS",
    env.IRIS_EMBEDDING_DIMENSIONS
  );

  return {
    provider,
    baseUrl: trimTrailingSlash(
      readRequiredEnv("IRIS_EMBEDDING_BASE_URL", env.IRIS_EMBEDDING_BASE_URL)
    ),
    apiKey: readRequiredEnv("IRIS_EMBEDDING_API_KEY", env.IRIS_EMBEDDING_API_KEY),
    model: readRequiredEnv("IRIS_EMBEDDING_MODEL", env.IRIS_EMBEDDING_MODEL),
    ...(dimensions === undefined ? {} : { dimensions }),
    timeoutMs: readPositiveIntegerEnv(
      "IRIS_EMBEDDING_TIMEOUT_MS",
      env.IRIS_EMBEDDING_TIMEOUT_MS,
      30000
    )
  };
}

export function readAnswerDraftRuntimeConfig(
  env: EnvLike = process.env,
): AnswerDraftRuntimeConfig {
  const enabled = readOptionalEnv(env.IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS);
  if (enabled !== "true") {
    return { enabled: false };
  }

  const permissionMode = readRequiredEnv(
    "IRIS_INTERNAL_DRAFT_PERMISSION_MODE",
    env.IRIS_INTERNAL_DRAFT_PERMISSION_MODE,
  );
  if (permissionMode !== "allow-indexed" && permissionMode !== "source-policy") {
    throw new Error(`Unsupported IRIS_INTERNAL_DRAFT_PERMISSION_MODE: ${permissionMode}`);
  }

  return { enabled: true, permissionMode };
}

export function readReindexWorkerRuntimeConfig(
  env: EnvLike = process.env,
): ReindexWorkerRuntimeConfig {
  const enabled = readOptionalEnv(env.IRIS_REINDEX_WORKER_ENABLED);
  if (enabled !== "true") {
    return { enabled: false };
  }

  return {
    enabled: true,
    redisUrl: readOptionalEnv(env.REDIS_URL) ?? "redis://localhost:6379",
    intervalMs: readPositiveIntegerEnv(
      "IRIS_REINDEX_WORKER_INTERVAL_MS",
      env.IRIS_REINDEX_WORKER_INTERVAL_MS,
      1000,
    ),
    batchLimit: readPositiveIntegerEnv(
      "IRIS_REINDEX_WORKER_BATCH_LIMIT",
      env.IRIS_REINDEX_WORKER_BATCH_LIMIT,
      25,
    ),
  };
}

export function readEventWorkerRuntimeConfig(
  env: EnvLike = process.env,
): EventWorkerRuntimeConfig {
  const enabled = readOptionalEnv(env.IRIS_EVENT_WORKER_ENABLED);
  if (enabled !== "true") {
    return { enabled: false };
  }

  return {
    enabled: true,
    redisUrl: readOptionalEnv(env.REDIS_URL) ?? "redis://localhost:6379",
    intervalMs: readPositiveIntegerEnv(
      "IRIS_EVENT_WORKER_INTERVAL_MS",
      env.IRIS_EVENT_WORKER_INTERVAL_MS,
      1000,
    ),
    batchLimit: readPositiveIntegerEnv(
      "IRIS_EVENT_WORKER_BATCH_LIMIT",
      env.IRIS_EVENT_WORKER_BATCH_LIMIT,
      50,
    ),
  };
}

export function readDocumentSyncWorkerRuntimeConfig(
  env: EnvLike = process.env,
): DocumentSyncWorkerRuntimeConfig {
  const enabled = readOptionalEnv(env.IRIS_DOCUMENT_SYNC_WORKER_ENABLED);
  if (enabled !== "true") {
    return { enabled: false };
  }

  return {
    enabled: true,
    redisUrl: readOptionalEnv(env.REDIS_URL) ?? "redis://localhost:6379",
    intervalMs: readPositiveIntegerEnv(
      "IRIS_DOCUMENT_SYNC_WORKER_INTERVAL_MS",
      env.IRIS_DOCUMENT_SYNC_WORKER_INTERVAL_MS,
      1000,
    ),
    batchLimit: readPositiveIntegerEnv(
      "IRIS_DOCUMENT_SYNC_WORKER_BATCH_LIMIT",
      env.IRIS_DOCUMENT_SYNC_WORKER_BATCH_LIMIT,
      10,
    ),
  };
}

export function readFeishuOpenApiConfig(env: EnvLike = process.env): FeishuOpenApiConfig {
  return {
    appId: readRequiredEnv("FEISHU_APP_ID", env.FEISHU_APP_ID),
    appSecret: readRequiredEnv("FEISHU_APP_SECRET", env.FEISHU_APP_SECRET),
    baseUrl: trimTrailingSlash(readOptionalEnv(env.FEISHU_OPEN_BASE_URL) ?? "https://open.feishu.cn"),
  };
}

function readOptionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readRequiredEnv(name: string, value: string | undefined): string {
  const trimmed = readOptionalEnv(value);
  if (trimmed === undefined) {
    throw new Error(`${name} is required`);
  }

  return trimmed;
}

function readPositiveIntegerEnv(
  name: string,
  value: string | undefined,
  defaultValue: number
): number {
  const trimmed = readOptionalEnv(value);
  if (trimmed === undefined) {
    return defaultValue;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readOptionalPositiveIntegerEnv(
  name: string,
  value: string | undefined
): number | undefined {
  const trimmed = readOptionalEnv(value);
  if (trimmed === undefined) {
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
