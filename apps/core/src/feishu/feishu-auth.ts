import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

const MAX_ENCRYPTED_PAYLOAD_CHARS = 1_048_576;

export type FeishuAuthConfig = {
  verificationToken?: string;
  encryptKey?: string;
};

export type FeishuRequestVerifier = (request: FeishuAuthRequest) => boolean;

export type FeishuAuthRequest = {
  headers: Record<string, string | undefined>;
  body: unknown;
  rawBody?: string;
};

export type FeishuRequestVerifierOptions = {
  now?: () => Date;
  maxTimestampSkewSeconds?: number;
  requireSignature?: boolean;
};

type FeishuSignatureInput = {
  headers: Record<string, string | undefined>;
  rawBody: string;
  encryptKey: string;
};

export function isFeishuUrlVerificationPayload(
  body: unknown,
): body is { type: "url_verification"; challenge: string } {
  return isRecord(body) && body.type === "url_verification" && typeof body.challenge === "string";
}

export function decodeFeishuPayload(body: unknown, encryptKey: string | undefined): unknown | undefined {
  if (!isRecord(body) || !("encrypt" in body)) return body;
  if (
    Object.keys(body).length !== 1 ||
    typeof body.encrypt !== "string" ||
    body.encrypt.length === 0 ||
    body.encrypt.length > MAX_ENCRYPTED_PAYLOAD_CHARS ||
    body.encrypt.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(body.encrypt) ||
    encryptKey === undefined ||
    encryptKey.length === 0
  ) {
    return undefined;
  }

  try {
    const encrypted = Buffer.from(body.encrypt, "base64");
    if (encrypted.length < 32 || (encrypted.length - 16) % 16 !== 0) return undefined;
    const key = createHash("sha256").update(encryptKey).digest();
    const decipher = createDecipheriv("aes-256-cbc", key, encrypted.subarray(0, 16));
    const decrypted = Buffer.concat([
      decipher.update(encrypted.subarray(16)),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(decrypted) as unknown;
  } catch {
    return undefined;
  }
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

export function createFeishuRequestVerifier(
  config: FeishuAuthConfig,
  options: FeishuRequestVerifierOptions = {},
): FeishuRequestVerifier {
  const now = options.now ?? (() => new Date());
  const maxTimestampSkewSeconds = resolveMaxTimestampSkewSeconds(options.maxTimestampSkewSeconds);
  const requireSignature = options.requireSignature === true;

  return (request) => {
    const verificationToken = config.verificationToken;
    const encryptKey = config.encryptKey;
    if (
      (verificationToken === undefined && encryptKey === undefined) ||
      (requireSignature && encryptKey === undefined)
    ) {
      return false;
    }

    const tokenVerified =
      verificationToken === undefined ||
      verifyFeishuVerificationToken(request.body, verificationToken);
    const signatureVerified =
      encryptKey === undefined ||
      (request.rawBody !== undefined &&
        maxTimestampSkewSeconds !== undefined &&
        hasValidFeishuTimestamp({
          headers: request.headers,
          now: now(),
          maxTimestampSkewSeconds,
        }) &&
        verifyFeishuSignature({
          headers: request.headers,
          rawBody: request.rawBody,
          encryptKey,
        }));

    return tokenVerified && signatureVerified;
  };
}

function resolveMaxTimestampSkewSeconds(value: number | undefined): number | undefined {
  if (value === undefined) return 300;
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  return Math.min(value, 300);
}

function hasValidFeishuTimestamp(input: {
  headers: Record<string, string | undefined>;
  now: Date;
  maxTimestampSkewSeconds: number;
}): boolean {
  const timestamp = getHeader(input.headers, "x-lark-request-timestamp");
  if (timestamp === undefined || !/^\d+$/u.test(timestamp)) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(input.now.getTime() / 1_000);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    !Number.isFinite(nowSeconds) ||
    !Number.isFinite(input.maxTimestampSkewSeconds) ||
    input.maxTimestampSkewSeconds < 0
  ) {
    return false;
  }

  return Math.abs(nowSeconds - timestampSeconds) <= input.maxTimestampSkewSeconds;
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
  const normalizedName = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === normalizedName) {
      return value;
    }
  }

  return undefined;
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
