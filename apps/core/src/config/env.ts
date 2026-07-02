import type { FeishuAuthConfig } from "../feishu/feishu-auth.js";

export type EnvLike = Record<string, string | undefined>;

export type ModelProviderConfig = {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export type AnswerDraftRuntimeConfig =
  | { enabled: false }
  | { enabled: true; permissionMode: "allow-indexed" };

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
  if (permissionMode !== "allow-indexed") {
    throw new Error(`Unsupported IRIS_INTERNAL_DRAFT_PERMISSION_MODE: ${permissionMode}`);
  }

  return { enabled: true, permissionMode };
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
