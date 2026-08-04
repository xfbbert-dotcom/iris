import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

const MAX_ENCRYPTED_PAYLOAD_CHARS = 1_048_576;
const MIN_SUPPORTED_FEISHU_EPOCH_SECONDS = 946_684_800n;
const MAX_SUPPORTED_FEISHU_EPOCH_SECONDS = 4_102_444_800n;
const FEISHU_TIMESTAMP_SCALES = [1n, 1_000n, 1_000_000n, 1_000_000_000n] as const;

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
  requireFreshTimestamp?: boolean;
};

export type FeishuCallbackAuthenticationDiagnostic = {
  timestamp: "missing" | "invalid" | "stale" | "fresh";
  rawBodyPresent: boolean;
  rawEqualsCanonical: boolean;
  sha256EncryptKeyRaw: boolean;
  sha256EncryptKeyCanonical: boolean;
  sha1VerificationTokenRaw: boolean;
  sha1VerificationTokenCanonical: boolean;
};

type FeishuSignatureInput = {
  headers: Record<string, string | undefined>;
  rawBody: string;
  encryptKey: string;
};

type FeishuCardSignatureInput = {
  headers: Record<string, string | undefined>;
  rawBody: string;
  verificationToken: string;
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

export function verifyFreshFeishuCallbackPayload(
  body: unknown,
  now: Date,
  maxTimestampSkewSeconds?: number,
): boolean {
  const maxSkewSeconds = resolveMaxTimestampSkewSeconds(maxTimestampSkewSeconds);
  if (
    maxSkewSeconds === undefined ||
    !Number.isFinite(now.getTime()) ||
    !isRecord(body) ||
    !isRecord(body.header) ||
    typeof body.header.create_time !== "string" ||
    !/^\d{16}$/u.test(body.header.create_time)
  ) {
    return false;
  }

  const createTimeMicros = BigInt(body.header.create_time);
  const createTimeSeconds = createTimeMicros / 1_000_000n;
  if (
    createTimeSeconds < MIN_SUPPORTED_FEISHU_EPOCH_SECONDS ||
    createTimeSeconds > MAX_SUPPORTED_FEISHU_EPOCH_SECONDS
  ) {
    return false;
  }

  const nowMicros = BigInt(now.getTime()) * 1_000n;
  const skewMicros = createTimeMicros >= nowMicros
    ? createTimeMicros - nowMicros
    : nowMicros - createTimeMicros;
  return skewMicros <= BigInt(maxSkewSeconds) * 1_000_000n;
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

export function verifyFeishuCardSignature(input: FeishuCardSignatureInput): boolean {
  const timestamp = getHeader(input.headers, "x-lark-request-timestamp");
  const nonce = getHeader(input.headers, "x-lark-request-nonce");
  const signature = getHeader(input.headers, "x-lark-signature");

  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const expectedSignature = createHash("sha1")
    .update(timestamp + nonce + input.verificationToken + input.rawBody)
    .digest("hex");

  return safeEqual(signature, expectedSignature);
}

export function diagnoseFeishuCallbackAuthentication(input: {
  request: FeishuAuthRequest;
  verificationToken?: string;
  encryptKey?: string;
  now: Date;
}): FeishuCallbackAuthenticationDiagnostic {
  const rawBody = input.request.rawBody;
  let canonicalBody: string | undefined;
  try {
    canonicalBody = JSON.stringify(input.request.body);
  } catch {
    canonicalBody = undefined;
  }

  return {
    timestamp: classifyFeishuTimestamp(input.request.headers, input.now),
    rawBodyPresent: rawBody !== undefined,
    rawEqualsCanonical: rawBody !== undefined && canonicalBody !== undefined && rawBody === canonicalBody,
    sha256EncryptKeyRaw: rawBody !== undefined && input.encryptKey !== undefined &&
      verifyFeishuSignature({ headers: input.request.headers, rawBody, encryptKey: input.encryptKey }),
    sha256EncryptKeyCanonical: canonicalBody !== undefined && input.encryptKey !== undefined &&
      verifyFeishuSignature({
        headers: input.request.headers,
        rawBody: canonicalBody,
        encryptKey: input.encryptKey,
      }),
    sha1VerificationTokenRaw: rawBody !== undefined && input.verificationToken !== undefined &&
      verifyFeishuCardSignature({
        headers: input.request.headers,
        rawBody,
        verificationToken: input.verificationToken,
      }),
    sha1VerificationTokenCanonical: canonicalBody !== undefined && input.verificationToken !== undefined &&
      verifyFeishuCardSignature({
        headers: input.request.headers,
        rawBody: canonicalBody,
        verificationToken: input.verificationToken,
      }),
  };
}

export function createFeishuCardRequestVerifier(
  config: Pick<FeishuAuthConfig, "verificationToken">,
  options: Pick<FeishuRequestVerifierOptions, "now" | "maxTimestampSkewSeconds"> = {},
): FeishuRequestVerifier {
  const now = options.now ?? (() => new Date());
  const maxTimestampSkewSeconds = resolveMaxTimestampSkewSeconds(options.maxTimestampSkewSeconds);

  return (request) => {
    const verificationToken = config.verificationToken;
    return verificationToken !== undefined &&
      verificationToken.length > 0 &&
      request.rawBody !== undefined &&
      maxTimestampSkewSeconds !== undefined &&
      hasValidFeishuTimestamp({
        headers: request.headers,
        now: now(),
        maxTimestampSkewSeconds,
      }) &&
      verifyFeishuCardSignature({
        headers: request.headers,
        rawBody: request.rawBody,
        verificationToken,
      });
  };
}

export function createFeishuRequestVerifier(
  config: FeishuAuthConfig,
  options: FeishuRequestVerifierOptions = {},
): FeishuRequestVerifier {
  const now = options.now ?? (() => new Date());
  const maxTimestampSkewSeconds = resolveMaxTimestampSkewSeconds(options.maxTimestampSkewSeconds);
  const requireSignature = options.requireSignature === true;
  const requireFreshTimestamp = options.requireFreshTimestamp !== false;

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
        (!requireFreshTimestamp ||
          (maxTimestampSkewSeconds !== undefined &&
            hasValidFeishuTimestamp({
              headers: request.headers,
              now: now(),
              maxTimestampSkewSeconds,
            }))) &&
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

function classifyFeishuTimestamp(
  headers: Record<string, string | undefined>,
  now: Date,
): FeishuCallbackAuthenticationDiagnostic["timestamp"] {
  const value = getHeader(headers, "x-lark-request-timestamp");
  if (value === undefined || value.length === 0) return "missing";
  const skewSeconds = resolveFeishuTimestampSkewSeconds(value, now);
  if (skewSeconds === undefined) return "invalid";
  return skewSeconds <= 300n ? "fresh" : "stale";
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

  const skewSeconds = resolveFeishuTimestampSkewSeconds(timestamp, input.now);
  return skewSeconds !== undefined && skewSeconds <= BigInt(input.maxTimestampSkewSeconds);
}

function resolveFeishuTimestampSkewSeconds(value: string, now: Date): bigint | undefined {
  if (!/^\d{1,20}$/u.test(value) || !Number.isFinite(now.getTime())) return undefined;

  const rawTimestamp = BigInt(value);
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1_000));
  let closestSkew: bigint | undefined;
  for (const scale of FEISHU_TIMESTAMP_SCALES) {
    const timestampSeconds = rawTimestamp / scale;
    if (
      timestampSeconds < MIN_SUPPORTED_FEISHU_EPOCH_SECONDS ||
      timestampSeconds > MAX_SUPPORTED_FEISHU_EPOCH_SECONDS
    ) {
      continue;
    }
    const skew = timestampSeconds >= nowSeconds
      ? timestampSeconds - nowSeconds
      : nowSeconds - timestampSeconds;
    if (closestSkew === undefined || skew < closestSkew) closestSkew = skew;
  }
  return closestSkew;
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
