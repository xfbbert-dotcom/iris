import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createActionReviewSessionCodec } from "../src/action-reviews/action-review-session.js";

describe("ActionReviewSessionCodec", () => {
  const now = () => new Date("2026-07-22T08:00:00.000Z");

  it("creates a signed OAuth transaction with S256 PKCE and reads it back", () => {
    const codec = createActionReviewSessionCodec({ secret: "x".repeat(32), now });

    const transaction = codec.createOAuthTransaction("proposal-1");

    expect(transaction.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(transaction.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(transaction.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(codec.readOAuthTransaction(transaction.cookieValue, transaction.state)?.proposalId).toBe(
      "proposal-1",
    );
  });

  it("rejects tampered, malformed, non-canonical, expired, and mismatched OAuth transactions", () => {
    let current = new Date("2026-07-22T08:00:00.000Z");
    const codec = createActionReviewSessionCodec({ secret: "x".repeat(32), now: () => current });
    const transaction = codec.createOAuthTransaction("proposal-1");

    expect(codec.readOAuthTransaction(tamper(transaction.cookieValue), transaction.state)).toBeUndefined();
    expect(codec.readOAuthTransaction("not.base64url", transaction.state)).toBeUndefined();
    expect(codec.readOAuthTransaction(transaction.cookieValue, "wrong-state")).toBeUndefined();
    expect(
      codec.readOAuthTransaction(transaction.cookieValue, transaction.state, "proposal-2"),
    ).toBeUndefined();
    expect(codec.readOAuthTransaction(nonCanonicalTransaction(transaction.cookieValue), transaction.state)).toBeUndefined();

    current = new Date("2026-07-22T08:05:00.000Z");
    expect(codec.readOAuthTransaction(transaction.cookieValue, transaction.state)).toBeUndefined();
  });

  it("accepts OAuth transactions until their exact expiry boundary", () => {
    let current = new Date("2026-07-22T08:00:00.000Z");
    const codec = createActionReviewSessionCodec({ secret: "x".repeat(32), now: () => current });
    const transaction = codec.createOAuthTransaction("proposal-1");

    current = new Date("2026-07-22T08:04:59.999Z");
    expect(codec.readOAuthTransaction(transaction.cookieValue, transaction.state)).toBeDefined();
    current = new Date("2026-07-22T08:05:00.000Z");
    expect(codec.readOAuthTransaction(transaction.cookieValue, transaction.state)).toBeUndefined();
  });

  it("creates proposal-bound sessions and rejects tampered, non-canonical, expired, or mismatched ones", () => {
    let current = new Date("2026-07-22T08:00:00.000Z");
    const codec = createActionReviewSessionCodec({ secret: "x".repeat(32), now: () => current });
    const created = codec.createReviewSession({ proposalId: "proposal-1", actorOpenId: "ou_owner" });

    expect(codec.readReviewSession(created.cookieValue, "proposal-1")).toMatchObject({
      proposalId: "proposal-1",
      actorOpenId: "ou_owner",
      sessionId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(codec.readReviewSession(created.cookieValue, "proposal-2")).toBeUndefined();
    expect(codec.readReviewSession(tamper(created.cookieValue), "proposal-1")).toBeUndefined();
    expect(codec.readReviewSession(nonCanonicalSession(created.cookieValue), "proposal-1")).toBeUndefined();

    current = new Date("2026-07-22T08:15:00.000Z");
    expect(codec.readReviewSession(created.cookieValue, "proposal-1")).toBeUndefined();
  });

  it("serializes and clears the exact host-only OAuth and session cookies", () => {
    const codec = createActionReviewSessionCodec({ secret: "x".repeat(32), now });

    expect(codec.serializeOAuthTransactionCookie("signed-value")).toBe(
      "__Host-iris_review_oauth=signed-value; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=300",
    );
    expect(codec.clearOAuthTransactionCookie()).toBe(
      "__Host-iris_review_oauth=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    expect(codec.serializeReviewSessionCookie("signed-value")).toBe(
      "__Host-iris_review_session=signed-value; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=900",
    );
    expect(codec.clearReviewSessionCookie()).toBe(
      "__Host-iris_review_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
  });

  it("rejects secrets shorter than 32 UTF-8 bytes", () => {
    expect(() => createActionReviewSessionCodec({ secret: "x".repeat(31), now })).toThrow(
      "Action review session secret must be at least 32 UTF-8 bytes",
    );
  });
});

function tamper(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
}

function nonCanonicalTransaction(cookieValue: string): string {
  const [encodedPayload] = cookieValue.split(".");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
  const rawPayload = JSON.stringify(payload).replace(/"issuedAtMs":\d+/u, "\"issuedAtMs\":1e3");
  return signedCookie(rawPayload);
}

function nonCanonicalSession(cookieValue: string): string {
  const [encodedPayload] = cookieValue.split(".");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
  const rawPayload = JSON.stringify(payload).replace(/"issuedAtMs":\d+/u, "\"issuedAtMs\":1e3");
  return signedCookie(rawPayload);
}

function signedCookie(rawPayload: string): string {
  const encodedPayload = Buffer.from(rawPayload).toString("base64url");
  const signature = createHmac("sha256", "x".repeat(32)).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}
