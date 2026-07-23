import type { FeishuAuthConfig } from "../feishu/feishu-auth.js";
import { readDatabaseConfig } from "../database/database-config.js";

export type EnvLike = Record<string, string | undefined>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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

export type MemoryExtractionRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      databaseUrl: string;
      redisUrl: string;
      aiWorkerBaseUrl: string;
      aiWorkerToken: string;
      irisBotOpenId: string;
      intervalMs: number;
      batchLimit: number;
      minConfidence: number;
      threadEnabledGroupIds: string[];
      actionEnabledGroupIds: string[];
      candidateConfidenceFloor: number;
      applyConfidence: number;
    };

export type KnowledgeCardRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      databaseUrl: string;
      redisUrl: string;
      enabledGroupIds: string[];
      intervalMs: number;
      batchLimit: number;
      botOpenId: string;
    };

export type ActionApprovalRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      databaseUrl: string;
      enabledGroupIds: string[];
      plannerIntervalMs: number;
      plannerBatchLimit: number;
      dispatcherIntervalMs: number;
      dispatcherBatchLimit: number;
      publicationExecutorIntervalMs: number;
      publicationExecutorBatchLimit: number;
      reviewPublicOrigin?: string;
    };

export type ProactiveSignalDeliveryRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      databaseUrl: string;
      enabledGroupIds: string[];
      intervalMs: number;
      batchLimit: number;
    };

export type ActionReviewRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      publicOrigin: string;
      sessionSecret: string;
      authorizeUrl: string;
      feishuOpenApi: {
        appId: string;
        appSecret: string;
        baseUrl: string;
      };
    };

export type FeishuOpenApiConfig = {
  appId: string;
  appSecret: string;
  baseUrl: string;
  documentFetchTimeoutMs: number;
  documentMaxContentChars: number;
};

const MAX_FEISHU_BOT_OPEN_ID_CHARS = 512;
const MAX_FEISHU_ENCRYPT_KEY_CHARS = 512;

export function readFeishuAuthConfig(env: EnvLike = process.env): FeishuAuthConfig {
  return {
    verificationToken: readOptionalEnv(env.FEISHU_VERIFICATION_TOKEN),
    encryptKey: readOptionalEnv(env.FEISHU_ENCRYPT_KEY)
  };
}

export function readOptionalFeishuBotOpenId(env: EnvLike = process.env): string | undefined {
  const botOpenId = env.IRIS_FEISHU_BOT_OPEN_ID;
  if (botOpenId === undefined || botOpenId.trim().length === 0) {
    return undefined;
  }
  if (botOpenId.length > MAX_FEISHU_BOT_OPEN_ID_CHARS) {
    throw new Error(
      `IRIS_FEISHU_BOT_OPEN_ID must be at most ${MAX_FEISHU_BOT_OPEN_ID_CHARS} characters`,
    );
  }
  if (!/^ou_[A-Za-z0-9]+$/u.test(botOpenId)) {
    throw new Error("IRIS_FEISHU_BOT_OPEN_ID must match the Feishu open ID format");
  }

  return botOpenId;
}

export function readServerPort(env: EnvLike = process.env): number {
  const port = readPositiveIntegerEnv("PORT", env.PORT, 3000);
  if (port > 65535) {
    throw new Error("PORT must be between 1 and 65535");
  }

  return port;
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
    baseUrl: readHttpBaseUrlEnv("IRIS_MODEL_BASE_URL", env.IRIS_MODEL_BASE_URL),
    apiKey: readRequiredEnv("IRIS_MODEL_API_KEY", env.IRIS_MODEL_API_KEY),
    model: readRequiredEnv("IRIS_MODEL_NAME", env.IRIS_MODEL_NAME),
    timeoutMs: readTimerDelayEnv("IRIS_MODEL_TIMEOUT_MS", env.IRIS_MODEL_TIMEOUT_MS, 30000)
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
    baseUrl: readHttpBaseUrlEnv("IRIS_EMBEDDING_BASE_URL", env.IRIS_EMBEDDING_BASE_URL),
    apiKey: readRequiredEnv("IRIS_EMBEDDING_API_KEY", env.IRIS_EMBEDDING_API_KEY),
    model: readRequiredEnv("IRIS_EMBEDDING_MODEL", env.IRIS_EMBEDDING_MODEL),
    ...(dimensions === undefined ? {} : { dimensions }),
    timeoutMs: readTimerDelayEnv(
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
    redisUrl: readRedisUrlEnv(env.REDIS_URL),
    intervalMs: readTimerDelayEnv(
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
    redisUrl: readRedisUrlEnv(env.REDIS_URL),
    intervalMs: readTimerDelayEnv(
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
    redisUrl: readRedisUrlEnv(env.REDIS_URL),
    intervalMs: readTimerDelayEnv(
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

export function readMemoryExtractionRuntimeConfig(
  env: EnvLike = process.env,
): MemoryExtractionRuntimeConfig {
  const enabled = readOptionalEnv(env.IRIS_MEMORY_EXTRACTION_ENABLED);
  if (enabled !== "true") {
    return { enabled: false };
  }

  const { databaseUrl } = readDatabaseConfig(env);
  const redisUrl = readRedisUrlEnv(readRequiredEnv("REDIS_URL", env.REDIS_URL));
  const irisBotOpenId = readOptionalFeishuBotOpenId(env);
  if (irisBotOpenId === undefined) {
    throw new Error("IRIS_FEISHU_BOT_OPEN_ID is required when memory extraction is enabled");
  }
  const threadEnabledGroupIds = readGroupIdListEnv(
    "IRIS_THREAD_EXTRACTION_GROUP_IDS",
    env.IRIS_THREAD_EXTRACTION_GROUP_IDS,
  );
  const actionEnabledGroupIds = readGroupIdListEnv(
    "IRIS_ACTION_EXTRACTION_GROUP_IDS",
    env.IRIS_ACTION_EXTRACTION_GROUP_IDS,
  );
  if (actionEnabledGroupIds.some((groupId) => !threadEnabledGroupIds.includes(groupId))) {
    throw new Error(
      "IRIS_ACTION_EXTRACTION_GROUP_IDS must be a subset of IRIS_THREAD_EXTRACTION_GROUP_IDS",
    );
  }
  const candidateConfidenceFloor = readConfidenceEnv(
    "IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR",
    env.IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR,
    0.65,
  );
  const applyConfidence = readConfidenceEnv(
    "IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE",
    env.IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE,
    0.85,
  );
  if (candidateConfidenceFloor >= applyConfidence) {
    throw new Error(
      "IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR must be less than IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE",
    );
  }

  return {
    enabled: true,
    databaseUrl,
    redisUrl,
    aiWorkerBaseUrl: readHttpBaseUrlEnv(
      "IRIS_AI_WORKER_BASE_URL",
      env.IRIS_AI_WORKER_BASE_URL,
    ),
    aiWorkerToken: readVisibleBearerTokenEnv(
      "IRIS_AI_WORKER_TOKEN",
      env.IRIS_AI_WORKER_TOKEN,
    ),
    irisBotOpenId,
    intervalMs: readTimerDelayEnv(
      "IRIS_MEMORY_EXTRACTION_INTERVAL_MS",
      env.IRIS_MEMORY_EXTRACTION_INTERVAL_MS,
      1000,
    ),
    batchLimit: readBoundedPositiveIntegerEnv(
      "IRIS_MEMORY_EXTRACTION_BATCH_LIMIT",
      env.IRIS_MEMORY_EXTRACTION_BATCH_LIMIT,
      20,
      100,
    ),
    minConfidence: applyConfidence,
    threadEnabledGroupIds,
    actionEnabledGroupIds,
    candidateConfidenceFloor,
    applyConfidence,
  };
}

export function readKnowledgeCardRuntimeConfig(
  env: EnvLike = process.env,
): KnowledgeCardRuntimeConfig {
  if (env.IRIS_KNOWLEDGE_CARD_ENABLED !== "true") {
    return { enabled: false };
  }

  const enabledGroupIds = readRequiredUniqueGroupIdListEnv(
    "IRIS_KNOWLEDGE_CARD_GROUP_IDS",
    env.IRIS_KNOWLEDGE_CARD_GROUP_IDS,
  );
  const { databaseUrl } = readDatabaseConfig(env);
  const redisUrl = readRedisUrlEnv(readRequiredEnv("REDIS_URL", env.REDIS_URL));
  const auth = readFeishuAuthConfig(env);
  if (auth.verificationToken === undefined) {
    throw new Error("FEISHU_VERIFICATION_TOKEN is required when knowledge cards are enabled");
  }
  if (auth.encryptKey === undefined) {
    throw new Error("FEISHU_ENCRYPT_KEY is required when knowledge cards are enabled");
  }
  if (auth.encryptKey.length > MAX_FEISHU_ENCRYPT_KEY_CHARS) {
    throw new Error(
      `FEISHU_ENCRYPT_KEY must be at most ${MAX_FEISHU_ENCRYPT_KEY_CHARS} characters`,
    );
  }
  readFeishuOpenApiConfig(env);
  const botOpenId = readOptionalFeishuBotOpenId(env);
  if (botOpenId === undefined) {
    throw new Error("IRIS_FEISHU_BOT_OPEN_ID is required when knowledge cards are enabled");
  }

  return {
    enabled: true,
    databaseUrl,
    redisUrl,
    enabledGroupIds,
    intervalMs: readTimerDelayEnv(
      "IRIS_KNOWLEDGE_CARD_WORKER_INTERVAL_MS",
      env.IRIS_KNOWLEDGE_CARD_WORKER_INTERVAL_MS,
      1000,
    ),
    batchLimit: readBoundedPositiveIntegerEnv(
      "IRIS_KNOWLEDGE_CARD_WORKER_BATCH_LIMIT",
      env.IRIS_KNOWLEDGE_CARD_WORKER_BATCH_LIMIT,
      10,
      100,
    ),
    botOpenId,
  };
}

export function readActionApprovalRuntimeConfig(
  env: EnvLike = process.env,
): ActionApprovalRuntimeConfig {
  if (env.IRIS_APPROVAL_ACTIONS_ENABLED !== "true") return { enabled: false };

  const enabledGroupIds = readRequiredUniqueGroupIdListEnv(
    "IRIS_APPROVAL_ACTION_GROUP_IDS",
    env.IRIS_APPROVAL_ACTION_GROUP_IDS,
  );
  const { databaseUrl } = readDatabaseConfig(env);
  const reviewPublicOrigin = readOptionalEnv(env.IRIS_REVIEW_PUBLIC_ORIGIN);
  return {
    enabled: true,
    databaseUrl,
    enabledGroupIds,
    plannerIntervalMs: readTimerDelayEnv(
      "IRIS_ACTION_PROPOSAL_PLANNER_INTERVAL_MS",
      env.IRIS_ACTION_PROPOSAL_PLANNER_INTERVAL_MS,
      1000,
    ),
    plannerBatchLimit: readBoundedPositiveIntegerEnv(
      "IRIS_ACTION_PROPOSAL_PLANNER_BATCH_LIMIT",
      env.IRIS_ACTION_PROPOSAL_PLANNER_BATCH_LIMIT,
      10,
      100,
    ),
    dispatcherIntervalMs: readTimerDelayEnv(
      "IRIS_ACTION_APPROVAL_DISPATCHER_INTERVAL_MS",
      env.IRIS_ACTION_APPROVAL_DISPATCHER_INTERVAL_MS,
      1000,
    ),
    dispatcherBatchLimit: readBoundedPositiveIntegerEnv(
      "IRIS_ACTION_APPROVAL_DISPATCHER_BATCH_LIMIT",
      env.IRIS_ACTION_APPROVAL_DISPATCHER_BATCH_LIMIT,
      10,
      100,
    ),
    publicationExecutorIntervalMs: readTimerDelayEnv(
      "IRIS_KNOWLEDGE_PUBLICATION_EXECUTOR_INTERVAL_MS",
      env.IRIS_KNOWLEDGE_PUBLICATION_EXECUTOR_INTERVAL_MS,
      1000,
    ),
    publicationExecutorBatchLimit: readBoundedPositiveIntegerEnv(
      "IRIS_KNOWLEDGE_PUBLICATION_EXECUTOR_BATCH_LIMIT",
      env.IRIS_KNOWLEDGE_PUBLICATION_EXECUTOR_BATCH_LIMIT,
      10,
      100,
    ),
    ...(reviewPublicOrigin === undefined
      ? {}
      : { reviewPublicOrigin: readHttpBaseUrlEnv("IRIS_REVIEW_PUBLIC_ORIGIN", reviewPublicOrigin) }),
  };
}

export function readProactiveSignalDeliveryRuntimeConfig(
  env: EnvLike = process.env,
): ProactiveSignalDeliveryRuntimeConfig {
  if (env.IRIS_PROACTIVE_SIGNAL_DELIVERY_ENABLED !== "true") return { enabled: false };

  const enabledGroupIds = readRequiredUniqueGroupIdListEnv(
    "IRIS_PROACTIVE_SIGNAL_DELIVERY_GROUP_IDS",
    env.IRIS_PROACTIVE_SIGNAL_DELIVERY_GROUP_IDS,
  );
  const { databaseUrl } = readDatabaseConfig(env);
  readFeishuOpenApiConfig(env);
  return {
    enabled: true,
    databaseUrl,
    enabledGroupIds,
    intervalMs: readTimerDelayEnv(
      "IRIS_PROACTIVE_SIGNAL_DELIVERY_INTERVAL_MS",
      env.IRIS_PROACTIVE_SIGNAL_DELIVERY_INTERVAL_MS,
      1000,
    ),
    batchLimit: readBoundedPositiveIntegerEnv(
      "IRIS_PROACTIVE_SIGNAL_DELIVERY_BATCH_LIMIT",
      env.IRIS_PROACTIVE_SIGNAL_DELIVERY_BATCH_LIMIT,
      10,
      100,
    ),
  };
}

export function readActionReviewRuntimeConfig(
  env: EnvLike = process.env,
): ActionReviewRuntimeConfig {
  if (env.IRIS_ACTION_REVIEW_ENABLED !== "true") return { enabled: false };

  const publicOrigin = readExactHttpsOriginEnv(
    "IRIS_REVIEW_PUBLIC_ORIGIN",
    env.IRIS_REVIEW_PUBLIC_ORIGIN,
  );
  const sessionSecret = readRequiredEnv(
    "IRIS_REVIEW_SESSION_SECRET",
    env.IRIS_REVIEW_SESSION_SECRET,
  );
  if (Buffer.byteLength(sessionSecret, "utf8") < 32) {
    throw new Error("IRIS_REVIEW_SESSION_SECRET must be at least 32 UTF-8 bytes");
  }
  if (Buffer.byteLength(sessionSecret, "utf8") > 4096) {
    throw new Error("IRIS_REVIEW_SESSION_SECRET must be at most 4096 UTF-8 bytes");
  }

  const appId = readRequiredEnv("FEISHU_APP_ID", env.FEISHU_APP_ID);
  const appSecret = readRequiredEnv("FEISHU_APP_SECRET", env.FEISHU_APP_SECRET);
  const baseUrl = readOfficialFeishuOpenApiOrigin(env.FEISHU_OPEN_BASE_URL);
  const defaultAuthorizeUrl = baseUrl === "https://open.larksuite.com"
    ? "https://accounts.larksuite.com/open-apis/authen/v1/authorize"
    : "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
  const authorizeUrl = readOfficialFeishuAuthorizeUrl(
    env.IRIS_FEISHU_OAUTH_AUTHORIZE_URL ?? defaultAuthorizeUrl,
  );

  return {
    enabled: true,
    publicOrigin,
    sessionSecret,
    authorizeUrl,
    feishuOpenApi: { appId, appSecret, baseUrl },
  };
}

export function readFeishuOpenApiConfig(env: EnvLike = process.env): FeishuOpenApiConfig {
  return {
    appId: readRequiredEnv("FEISHU_APP_ID", env.FEISHU_APP_ID),
    appSecret: readRequiredEnv("FEISHU_APP_SECRET", env.FEISHU_APP_SECRET),
    baseUrl: readHttpBaseUrlEnv(
      "FEISHU_OPEN_BASE_URL",
      readOptionalEnv(env.FEISHU_OPEN_BASE_URL) ?? "https://open.feishu.cn",
    ),
    documentFetchTimeoutMs: readTimerDelayEnv(
      "IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS",
      env.IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS,
      10000,
    ),
    documentMaxContentChars: readPositiveIntegerEnv(
      "IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS",
      env.IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS,
      2000000,
    ),
  };
}

export function readOptionalFeishuOpenApiConfig(
  env: EnvLike = process.env,
): FeishuOpenApiConfig | undefined {
  const appId = readOptionalEnv(env.FEISHU_APP_ID);
  const appSecret = readOptionalEnv(env.FEISHU_APP_SECRET);
  if (appId === undefined && appSecret === undefined) {
    return undefined;
  }

  return readFeishuOpenApiConfig(env);
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

function readHttpBaseUrlEnv(name: string, value: string | undefined): string {
  if (value !== undefined && /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must not include control characters`);
  }
  const trimmed = readRequiredEnv(name, value);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${name} must be an http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(`${name} must not include embedded credentials`);
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(`${name} must not include query or fragment`);
  }

  return trimTrailingSlash(trimmed);
}

function readVisibleBearerTokenEnv(name: string, value: string | undefined): string {
  const token = readRequiredEnv(name, value);
  if (token.length > 4096 || !/^[!-~]+$/u.test(token) || token.includes(",")) {
    throw new Error(`${name} must be a visible safe bearer token`);
  }

  return token;
}

function readRedisUrlEnv(value: string | undefined): string {
  const trimmed = readOptionalEnv(value) ?? "redis://localhost:6379";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("REDIS_URL must be a redis URL");
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("REDIS_URL must be a redis URL");
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
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return parsed;
}

function readTimerDelayEnv(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  const parsed = readPositiveIntegerEnv(name, value, defaultValue);
  if (parsed > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must not exceed ${MAX_TIMER_DELAY_MS}`);
  }

  return parsed;
}

function readBoundedPositiveIntegerEnv(
  name: string,
  value: string | undefined,
  defaultValue: number,
  maximum: number,
): number {
  const parsed = readPositiveIntegerEnv(name, value, defaultValue);
  if (parsed > maximum) {
    throw new Error(`${name} must not exceed ${maximum}`);
  }

  return parsed;
}

function readConfidenceEnv(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  const trimmed = readOptionalEnv(value);
  if (trimmed === undefined) {
    return defaultValue;
  }
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(trimmed)) {
    throw new Error(`${name} must be between 0 and 1`);
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return parsed;
}

function readGroupIdListEnv(name: string, value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  const groupIds = [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
  if (groupIds.length > 100) {
    throw new Error(`${name} must contain at most 100 groups`);
  }
  if (groupIds.some((groupId) => groupId.length > 512)) {
    throw new Error(`${name} group IDs must be at most 512 characters`);
  }
  return groupIds;
}

function readExactHttpsOriginEnv(name: string, value: string | undefined): string {
  const raw = readRequiredEnv(name, value);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  return parsed.origin;
}

function readOfficialFeishuOpenApiOrigin(value: string | undefined): string {
  const origin = readExactHttpsOriginEnv(
    "FEISHU_OPEN_BASE_URL",
    readOptionalEnv(value) ?? "https://open.feishu.cn",
  );
  if (origin !== "https://open.feishu.cn" && origin !== "https://open.larksuite.com") {
    throw new Error("FEISHU_OPEN_BASE_URL must be an official Feishu Open API origin");
  }
  return origin;
}

function readOfficialFeishuAuthorizeUrl(value: string): string {
  const raw = readRequiredEnv("IRIS_FEISHU_OAUTH_AUTHORIZE_URL", value);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "IRIS_FEISHU_OAUTH_AUTHORIZE_URL must be the official Feishu OAuth authorization endpoint",
    );
  }
  const validOrigin = parsed.origin === "https://accounts.feishu.cn" ||
    parsed.origin === "https://accounts.larksuite.com";
  if (
    !validOrigin ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/open-apis/authen/v1/authorize" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "IRIS_FEISHU_OAUTH_AUTHORIZE_URL must be the official Feishu OAuth authorization endpoint",
    );
  }
  return parsed.toString();
}

function readRequiredUniqueGroupIdListEnv(name: string, value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must contain at least one group`);
  }
  const parts = value.split(",");
  const groupIds = parts.map((part) => part.trim());
  if (groupIds.some((groupId) => groupId.length === 0)) {
    throw new Error(`${name} must not contain blank group IDs`);
  }
  if (groupIds.length > 100) {
    throw new Error(`${name} must contain at most 100 groups`);
  }
  if (groupIds.some((groupId) => groupId.length > 512)) {
    throw new Error(`${name} group IDs must be at most 512 characters`);
  }
  if (new Set(groupIds).size !== groupIds.length) {
    throw new Error(`${name} must contain unique group IDs`);
  }

  return groupIds;
}

function readOptionalPositiveIntegerEnv(
  name: string,
  value: string | undefined
): number | undefined {
  const trimmed = readOptionalEnv(value);
  if (trimmed === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return parsed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
