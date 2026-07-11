import { createHash, timingSafeEqual } from "node:crypto";

export type FeishuAuthConfig = {
  verificationToken?: string;
  encryptKey?: string;
};

export type FeishuRequestVerifier = (request: FeishuAuthRequest) => boolean;

type FeishuAuthRequest = {
  headers: Record<string, string | undefined>;
  body: unknown;
  rawBody?: string;
};

type FeishuSignatureInput = {
  headers: Record<string, string | undefined>;
  rawBody: string;
  encryptKey: string;
};

export function isFeishuUrlVerificationPayload(body: unknown): boolean {
  return isRecord(body) && body.type === "url_verification" && typeof body.challenge === "string";
}

export function verifyFeishuVerificationToken(body: unknown, verificationToken: string): boolean {
  const token = resolveVerificationToken(body);
  if (!token) {
    return false;
  }

  return safeEqual(token, verificationToken);
}

export function verifyFeishuSignature(input: FeishuSignatureInput): boolean {
  const timestamp = getHeader(input.headers, "x-lark-request-timestamp");
  const nonce = getHeader(input.headers, "x-lark-request-nonce");
  const signature = getHeader(input.headers, "x-lark-signature");

  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const expectedSignature = createHash("sha256")
    .update(timestamp + nonce + input.encryptKey + input.rawBody)
    .digest("hex");

  return safeEqual(signature, expectedSignature);
}

export function createFeishuRequestVerifier(config: FeishuAuthConfig): FeishuRequestVerifier {
  return (request) => {
    if (
      config.verificationToken &&
      verifyFeishuVerificationToken(request.body, config.verificationToken)
    ) {
      return true;
    }

    if (config.encryptKey && request.rawBody) {
      return verifyFeishuSignature({
        headers: request.headers,
        rawBody: request.rawBody,
        encryptKey: config.encryptKey
      });
    }

    return false;
  };
}

function resolveVerificationToken(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  if (isRecord(body.header) && typeof body.header.token === "string") {
    return body.header.token;
  }

  return typeof body.token === "string" ? body.token : undefined;
}

function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  return headers[name] ?? headers[name.toLowerCase()];
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
