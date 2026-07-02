export type FeishuTenantAccessTokenProvider = {
  getTenantAccessToken(): Promise<string>;
};

export type FeishuTenantAccessTokenProviderDependencies = {
  baseUrl: string;
  appId: string;
  appSecret: string;
  fetch?: typeof fetch;
  now?: () => Date;
};

type CachedToken = {
  token: string;
  expiresAtMs: number;
};

const tokenRefreshSkewMs = 60_000;

export function createFeishuTenantAccessTokenProvider({
  baseUrl,
  appId,
  appSecret,
  fetch = globalThis.fetch,
  now = () => new Date(),
}: FeishuTenantAccessTokenProviderDependencies): FeishuTenantAccessTokenProvider {
  let cachedToken: CachedToken | undefined;

  return {
    async getTenantAccessToken() {
      const nowMs = now().getTime();
      if (cachedToken !== undefined && cachedToken.expiresAtMs > nowMs) {
        return cachedToken.token;
      }

      const response = await fetch(
        `${trimTrailingSlash(baseUrl)}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        },
      );
      const responseBody = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(
          `Feishu tenant access token HTTP request failed with status ${response.status}: ${readErrorMessage(
            responseBody,
          )}`,
        );
      }

      const token = readTenantAccessToken(responseBody);
      const expiresInSeconds = readExpireSeconds(responseBody);
      cachedToken = {
        token,
        expiresAtMs: nowMs + Math.max(0, expiresInSeconds * 1000 - tokenRefreshSkewMs),
      };

      return token;
    },
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
