import { readPositiveSafeInteger } from "../config/numeric-guards.js";

export type FeishuTenantAccessTokenProvider = {
  getTenantAccessToken(): Promise<string>;
};

export type FeishuTenantAccessTokenProviderDependencies = {
  baseUrl: string;
  appId: string;
  appSecret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
};

type CachedToken = {
  token: string;
  expiresAtMs: number;
};

const tokenRefreshSkewMs = 60_000;
const defaultTokenRequestTimeoutMs = 10_000;

export function createFeishuTenantAccessTokenProvider({
  baseUrl,
  appId,
  appSecret,
  fetch = globalThis.fetch,
  timeoutMs = defaultTokenRequestTimeoutMs,
  now = () => new Date(),
}: FeishuTenantAccessTokenProviderDependencies): FeishuTenantAccessTokenProvider {
  const safeTimeoutMs = readPositiveSafeInteger(
    timeoutMs,
    "Feishu tenant access token timeoutMs",
  );
  let cachedToken: CachedToken | undefined;
  let inFlightTokenRequest: Promise<string> | undefined;

  return {
    async getTenantAccessToken() {
      const nowMs = now().getTime();
      if (cachedToken !== undefined && cachedToken.expiresAtMs > nowMs) {
        return cachedToken.token;
      }
      if (inFlightTokenRequest !== undefined) {
        return inFlightTokenRequest;
      }

      inFlightTokenRequest = refreshTenantAccessToken({
        baseUrl,
        appId,
        appSecret,
        fetch,
        timeoutMs: safeTimeoutMs,
        cacheToken(token, expiresInSeconds) {
          cachedToken = {
            token,
            expiresAtMs: nowMs + Math.max(0, expiresInSeconds * 1000 - tokenRefreshSkewMs),
          };
        },
      });
      try {
        return await inFlightTokenRequest;
      } finally {
        inFlightTokenRequest = undefined;
      }
    },
  };
}

async function refreshTenantAccessToken({
  baseUrl,
  appId,
  appSecret,
  fetch,
  timeoutMs,
  cacheToken,
}: {
  baseUrl: string;
  appId: string;
  appSecret: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  cacheToken(token: string, expiresInSeconds: number): void;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `${trimTrailingSlash(baseUrl)}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: controller.signal,
      },
    );
    const responseBody = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(
        `Feishu tenant access token HTTP request failed with status ${
          response.status
        }: ${readErrorMessage(responseBody)}`,
      );
    }

    const token = readTenantAccessToken(responseBody);
    const expiresInSeconds = readExpireSeconds(responseBody);
    cacheToken(token, expiresInSeconds);

    return token;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("Feishu tenant access token request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error("Feishu tenant access token response was not valid JSON");
  }
}

function readTenantAccessToken(responseBody: unknown): string {
  if (!isRecord(responseBody)) {
    throw new Error("Feishu tenant access token response did not include tenant_access_token");
  }

  const code = responseBody.code;
  if (typeof code === "number" && code !== 0) {
    throw new Error(`Feishu tenant access token request failed: ${readErrorMessage(responseBody)}`);
  }

  const token = responseBody.tenant_access_token;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Feishu tenant access token response did not include tenant_access_token");
  }

  return token.trim();
}

function readExpireSeconds(responseBody: unknown): number {
  if (!isRecord(responseBody) || typeof responseBody.expire !== "number") {
    return 0;
  }

  return Number.isFinite(responseBody.expire) ? responseBody.expire : 0;
}

function readErrorMessage(responseBody: unknown): string {
  if (isRecord(responseBody)) {
    const message = responseBody.msg ?? responseBody.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }

  return "unknown error";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
