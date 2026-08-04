import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type ReviewSession = {
  sessionId: string;
  proposalId: string;
  actorOpenId: string;
  csrfToken: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

export type OAuthTransaction = {
  state: string;
  proposalId: string;
  codeVerifier: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

export type ActionReviewSessionCodec = {
  createOAuthTransaction(proposalId: string): OAuthTransaction & {
    codeChallenge: string;
    cookieValue: string;
  };
  readOAuthTransaction(
    cookieValue: string,
    expectedState: string,
    expectedProposalId?: string,
  ): OAuthTransaction | undefined;
  createReviewSession(input: { proposalId: string; actorOpenId: string }): ReviewSession & {
    cookieValue: string;
  };
  readReviewSession(cookieValue: string, expectedProposalId: string): ReviewSession | undefined;
  serializeOAuthTransactionCookie(cookieValue: string): string;
  clearOAuthTransactionCookie(): string;
  serializeReviewSessionCookie(cookieValue: string): string;
  clearReviewSessionCookie(): string;
};

export type ActionReviewSessionCodecDependencies = {
  secret: string;
  now?: () => Date;
};

export const ACTION_REVIEW_OAUTH_COOKIE_NAME = "__Host-iris_review_oauth";
export const ACTION_REVIEW_SESSION_COOKIE_NAME = "__Host-iris_review_session";

const oauthLifetimeSeconds = 300;
const sessionLifetimeSeconds = 900;
const randomTokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const codeVerifierPattern = /^[A-Za-z0-9_-]{64}$/u;
const maxIdentifierChars = 512;

export function createActionReviewSessionCodec({
  secret,
  now = () => new Date(),
}: ActionReviewSessionCodecDependencies): ActionReviewSessionCodec {
  const secretBytes = Buffer.from(secret, "utf8");
  if (secretBytes.byteLength < 32) {
    throw new Error("Action review session secret must be at least 32 UTF-8 bytes");
  }

  return {
    createOAuthTransaction(proposalId) {
      const safeProposalId = readIdentifier(proposalId);
      const issuedAtMs = readNowMs(now);
      const transaction: OAuthTransaction = {
        state: randomBase64Url(32),
        proposalId: safeProposalId,
        codeVerifier: randomBase64Url(48),
        issuedAtMs,
        expiresAtMs: issuedAtMs + oauthLifetimeSeconds * 1000,
      };
      const cookieValue = signPayload(secretBytes, oauthPayload(transaction));
      return {
        ...transaction,
        codeChallenge: createHash("sha256").update(transaction.codeVerifier).digest("base64url"),
        cookieValue,
      };
    },

    readOAuthTransaction(cookieValue, expectedState, expectedProposalId) {
      const transaction = readOAuthPayload(secretBytes, cookieValue, now);
      if (
        transaction === undefined ||
        !sameString(transaction.state, expectedState) ||
        (expectedProposalId !== undefined && !sameString(transaction.proposalId, expectedProposalId))
      ) {
        return undefined;
      }
      return transaction;
    },

    createReviewSession(input) {
      const issuedAtMs = readNowMs(now);
      const session: ReviewSession = {
        sessionId: randomBase64Url(32),
        proposalId: readIdentifier(input.proposalId),
        actorOpenId: readIdentifier(input.actorOpenId),
        csrfToken: randomBase64Url(32),
        issuedAtMs,
        expiresAtMs: issuedAtMs + sessionLifetimeSeconds * 1000,
      };
      return { ...session, cookieValue: signPayload(secretBytes, sessionPayload(session)) };
    },

    readReviewSession(cookieValue, expectedProposalId) {
      const session = readSessionPayload(secretBytes, cookieValue, now);
      if (session === undefined || !sameString(session.proposalId, expectedProposalId)) {
        return undefined;
      }
      return session;
    },

    serializeOAuthTransactionCookie(cookieValue) {
      return serializeCookie(ACTION_REVIEW_OAUTH_COOKIE_NAME, cookieValue, oauthLifetimeSeconds);
    },
    clearOAuthTransactionCookie() {
      return serializeCookie(ACTION_REVIEW_OAUTH_COOKIE_NAME, "", 0);
    },
    serializeReviewSessionCookie(cookieValue) {
      return serializeCookie(ACTION_REVIEW_SESSION_COOKIE_NAME, cookieValue, sessionLifetimeSeconds);
    },
    clearReviewSessionCookie() {
      return serializeCookie(ACTION_REVIEW_SESSION_COOKIE_NAME, "", 0);
    },
  };
}

function readOAuthPayload(
  secret: Buffer,
  cookieValue: string,
  now: () => Date,
): OAuthTransaction | undefined {
  const payload = readSignedPayload(secret, cookieValue);
  if (!isRecord(payload) || payload.type !== "oauth") {
    return undefined;
  }
  const transaction = {
    state: payload.state,
    proposalId: payload.proposalId,
    codeVerifier: payload.codeVerifier,
    issuedAtMs: payload.issuedAtMs,
    expiresAtMs: payload.expiresAtMs,
  };
  if (
    !isOAuthTransaction(transaction) ||
    transaction.expiresAtMs !== transaction.issuedAtMs + oauthLifetimeSeconds * 1000 ||
    readNowMs(now) >= transaction.expiresAtMs
  ) {
    return undefined;
  }
  return transaction;
}

function readSessionPayload(
  secret: Buffer,
  cookieValue: string,
  now: () => Date,
): ReviewSession | undefined {
  const payload = readSignedPayload(secret, cookieValue);
  if (!isRecord(payload) || payload.type !== "session") {
    return undefined;
  }
  const session = {
    sessionId: payload.sessionId,
    proposalId: payload.proposalId,
    actorOpenId: payload.actorOpenId,
    csrfToken: payload.csrfToken,
    issuedAtMs: payload.issuedAtMs,
    expiresAtMs: payload.expiresAtMs,
  };
  if (
    !isReviewSession(session) ||
    session.expiresAtMs !== session.issuedAtMs + sessionLifetimeSeconds * 1000 ||
    readNowMs(now) >= session.expiresAtMs
  ) {
    return undefined;
  }
  return session;
}

function readSignedPayload(secret: Buffer, cookieValue: string): unknown {
  const parts = cookieValue.split(".");
  if (parts.length !== 2 || !isBase64Url(parts[0]) || !isBase64Url(parts[1])) {
    return undefined;
  }
  const [encodedPayload, presentedSignature] = parts;
  const expectedSignature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  if (!sameString(expectedSignature, presentedSignature)) {
    return undefined;
  }

  let rawPayload: string;
  let payload: unknown;
  try {
    rawPayload = Buffer.from(encodedPayload, "base64url").toString("utf8");
    if (Buffer.from(rawPayload, "utf8").toString("base64url") !== encodedPayload) {
      return undefined;
    }
    payload = JSON.parse(rawPayload);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) {
    return undefined;
  }

  const canonicalPayload = payload.type === "oauth"
    ? oauthPayload({
      state: payload.state,
      proposalId: payload.proposalId,
      codeVerifier: payload.codeVerifier,
      issuedAtMs: payload.issuedAtMs,
      expiresAtMs: payload.expiresAtMs,
    })
    : payload.type === "session"
      ? sessionPayload({
        sessionId: payload.sessionId,
        proposalId: payload.proposalId,
        actorOpenId: payload.actorOpenId,
        csrfToken: payload.csrfToken,
        issuedAtMs: payload.issuedAtMs,
        expiresAtMs: payload.expiresAtMs,
      })
      : undefined;
  return canonicalPayload === rawPayload ? payload : undefined;
}

function oauthPayload(transaction: {
  state: unknown;
  proposalId: unknown;
  codeVerifier: unknown;
  issuedAtMs: unknown;
  expiresAtMs: unknown;
}): string {
  return JSON.stringify({
    type: "oauth",
    state: transaction.state,
    proposalId: transaction.proposalId,
    codeVerifier: transaction.codeVerifier,
    issuedAtMs: transaction.issuedAtMs,
    expiresAtMs: transaction.expiresAtMs,
  });
}

function sessionPayload(session: {
  sessionId: unknown;
  proposalId: unknown;
  actorOpenId: unknown;
  csrfToken: unknown;
  issuedAtMs: unknown;
  expiresAtMs: unknown;
}): string {
  return JSON.stringify({
    type: "session",
    sessionId: session.sessionId,
    proposalId: session.proposalId,
    actorOpenId: session.actorOpenId,
    csrfToken: session.csrfToken,
    issuedAtMs: session.issuedAtMs,
    expiresAtMs: session.expiresAtMs,
  });
}

function isOAuthTransaction(value: Record<string, unknown>): value is OAuthTransaction {
  return (
    hasExactKeys(value, ["state", "proposalId", "codeVerifier", "issuedAtMs", "expiresAtMs"]) &&
    isRandomToken(value.state) &&
    isIdentifier(value.proposalId) &&
    typeof value.codeVerifier === "string" &&
    codeVerifierPattern.test(value.codeVerifier) &&
    isTimestamp(value.issuedAtMs) &&
    isTimestamp(value.expiresAtMs)
  );
}

function isReviewSession(value: Record<string, unknown>): value is ReviewSession {
  return (
    hasExactKeys(value, ["sessionId", "proposalId", "actorOpenId", "csrfToken", "issuedAtMs", "expiresAtMs"]) &&
    isRandomToken(value.sessionId) &&
    isIdentifier(value.proposalId) &&
    isIdentifier(value.actorOpenId) &&
    isRandomToken(value.csrfToken) &&
    isTimestamp(value.issuedAtMs) &&
    isTimestamp(value.expiresAtMs)
  );
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxIdentifierChars && value.trim() === value;
}

function readIdentifier(value: string): string {
  if (!isIdentifier(value)) {
    throw new Error("Action review session identifier must be a bounded non-empty string");
  }
  return value;
}

function isRandomToken(value: unknown): value is string {
  return typeof value === "string" && randomTokenPattern.test(value);
}

function readNowMs(now: () => Date): number {
  const value = now().getTime();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Action review session clock returned an invalid timestamp");
  }
  return value;
}

function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function signPayload(secret: Buffer, payload: string): string {
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function sameString(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") {
    return false;
  }
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.byteLength === actualBytes.byteLength && timingSafeEqual(expectedBytes, actualBytes);
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
