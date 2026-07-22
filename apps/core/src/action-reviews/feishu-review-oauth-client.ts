import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";

export type FeishuReviewOAuthClient = {
  buildAuthorizationUrl(input: { state: string; codeChallenge: string }): URL;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<{ actorOpenId: string }>;
};

export type FeishuReviewOAuthClientDependencies = {
  baseUrl: string;
  authorizeUrl: string;
  redirectUri: string;
  appId: string;
  appSecret: string;
  fetch?: typeof fetch;
};

const requestTimeoutMs = 5_000;
const maxResponseBytes = 16 * 1024;
const maxValueChars = 4_096;
const maxOpenIdChars = 512;

export function createFeishuReviewOAuthClient({
  baseUrl,
  authorizeUrl,
  redirectUri,
  appId,
  appSecret,
  fetch = globalThis.fetch,
}: FeishuReviewOAuthClientDependencies): FeishuReviewOAuthClient {
  const urls = readUrls({ baseUrl, authorizeUrl, redirectUri });
  const clientId = readRequiredValue(appId, "app ID");
  const clientSecret = readRequiredValue(appSecret, "app secret");

  return {
    buildAuthorizationUrl(input) {
      const state = readRequiredValue(input.state, "state");
      const codeChallenge = readRequiredValue(input.codeChallenge, "code challenge");
      const url = new URL(urls.authorizeUrl);
      url.search = new URLSearchParams([
        ["client_id", clientId],
        ["redirect_uri", urls.redirectUri],
        ["response_type", "code"],
        ["state", state],
        ["code_challenge", codeChallenge],
        ["code_challenge_method", "S256"],
      ]).toString();
      return url;
    },

    async exchangeCode(input) {
      const code = readRequiredValue(input.code, "authorization code");
      const codeVerifier = readRequiredValue(input.codeVerifier, "code verifier");
      const tokenResponse = await requestJson({
        fetch,
        url: `${urls.openBaseUrl}/open-apis/authen/v2/oauth/token`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: urls.redirectUri,
            code_verifier: codeVerifier,
          }),
        },
        requestName: "token",
      });
      const accessToken = readAccessToken(tokenResponse);
      const userInfoResponse = await requestJson({
        fetch,
        url: `${urls.openBaseUrl}/open-apis/authen/v1/user_info`,
        init: { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
        requestName: "user info",
      });
      return { actorOpenId: readActorOpenId(userInfoResponse) };
    },
  };
}

async function requestJson({
  fetch,
  url,
  init,
  requestName,
}: {
  fetch: typeof globalThis.fetch;
  url: string;
  init: RequestInit;
  requestName: "token" | "user info";
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const prefix = `Feishu review OAuth ${requestName}`;

  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`${prefix} request timed out`);
      }
      throw new Error(`${prefix} request failed`);
    }
    if (!response.ok) {
      throw new Error(`${prefix} request failed`);
    }
    try {
      return await readBoundedJsonResponse({
        response,
        invalidJsonErrorMessage: `${prefix} response was not valid JSON`,
        maxResponseBytes,
        responseSizeErrorMessage: `${prefix} response exceeds ${maxResponseBytes} bytes`,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`${prefix} request timed out`);
      }
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

function readAccessToken(response: unknown): string {
  if (!isSuccessfulResponse(response)) {
    throw new Error("Feishu review OAuth token response was rejected");
  }
  const data = response.data;
  if (!isRecord(data) || data.token_type !== "Bearer" || !isToken(data.access_token)) {
    throw new Error("Feishu review OAuth token response was invalid");
  }
  return data.access_token;
}

function readActorOpenId(response: unknown): string {
  if (!isSuccessfulResponse(response)) {
    throw new Error("Feishu review OAuth user info response was rejected");
  }
  const openId = isRecord(response.data) ? response.data.open_id : undefined;
  if (
    typeof openId !== "string" ||
    openId.length === 0 ||
    openId.length > maxOpenIdChars ||
    openId.trim() !== openId
  ) {
    throw new Error("Feishu review OAuth user info response was invalid");
  }
  return openId;
}

function isSuccessfulResponse(value: unknown): value is { code: number; data: unknown } {
  return isRecord(value) && value.code === 0 && Object.hasOwn(value, "data");
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxValueChars && value.trim() === value;
}

function readUrls(input: {
  baseUrl: string;
  authorizeUrl: string;
  redirectUri: string;
}): { openBaseUrl: string; authorizeUrl: string; redirectUri: string } {
  return {
    openBaseUrl: readAbsoluteUrl(input.baseUrl, "open API base URL").replace(/\/+$/u, ""),
    authorizeUrl: readAbsoluteUrl(input.authorizeUrl, "authorization URL"),
    redirectUri: readAbsoluteUrl(input.redirectUri, "redirect URI"),
  };
}

function readAbsoluteUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Feishu review OAuth ${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error(`Feishu review OAuth ${name} must be an absolute HTTPS URL without credentials or fragment`);
  }
  return url.toString();
}

function readRequiredValue(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxValueChars || value.trim() !== value) {
    throw new Error(`Feishu review OAuth ${name} must be a bounded non-empty string`);
  }
  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
