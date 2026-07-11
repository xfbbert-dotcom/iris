import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createFeishuRequestVerifier,
  isFeishuUrlVerificationPayload,
  verifyFeishuSignature,
  verifyFeishuVerificationToken
} from "../src/feishu/feishu-auth.js";

const encryptKey = "test-encrypt-key";
const verificationToken = "test-verification-token";

describe("Feishu auth primitives", () => {
  it("detects URL verification payloads", () => {
    expect(
      isFeishuUrlVerificationPayload({
        type: "url_verification",
        challenge: "challenge-value"
      })
    ).toBe(true);

    expect(
      isFeishuUrlVerificationPayload({
        type: "event_callback",
        challenge: "challenge-value"
      })
    ).toBe(false);
  });

  it("verifies tokens from body.header.token and body.token", () => {
    expect(
      verifyFeishuVerificationToken(
        {
          header: { token: verificationToken }
        },
        verificationToken
      )
    ).toBe(true);

    expect(
      verifyFeishuVerificationToken(
        {
          token: verificationToken
        },
        verificationToken
      )
    ).toBe(true);

    expect(
      verifyFeishuVerificationToken(
        {
          header: { token: "wrong-token" }
        },
        verificationToken
      )
    ).toBe(false);
  });

  it("verifies signatures generated with the encrypt key", () => {
    const rawBody = JSON.stringify({ event: { message: "hello" } });
    const timestamp = "1782864000";
    const nonce = "nonce-1";
    const signature = sign(timestamp, nonce, rawBody);

    expect(
      verifyFeishuSignature({
        headers: {
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": signature
        },
        rawBody,
        encryptKey
      })
    ).toBe(true);
  });

  it("verifies signatures with mixed-case Feishu signature headers", () => {
    const rawBody = JSON.stringify({ event: { message: "hello" } });
    const timestamp = "1782864000";
    const nonce = "nonce-1";

    expect(
      verifyFeishuSignature({
        headers: {
          "X-Lark-Request-Timestamp": timestamp,
          "X-Lark-Request-Nonce": nonce,
          "X-Lark-Signature": sign(timestamp, nonce, rawBody)
        },
        rawBody,
        encryptKey
      })
    ).toBe(true);
  });

  it("rejects invalid signatures without throwing", () => {
    expect(
      verifyFeishuSignature({
        headers: {
          "x-lark-request-timestamp": "1782864000",
          "x-lark-request-nonce": "nonce-1",
          "x-lark-signature": "short"
        },
        rawBody: JSON.stringify({ event: { message: "hello" } }),
        encryptKey
      })
    ).toBe(false);
  });

  it("accepts verification-token-only requests when no encrypt key is configured", () => {
    const verifier = createFeishuRequestVerifier({
      verificationToken
    });

    expect(
      verifier({
        headers: {},
        body: { token: verificationToken },
        rawBody: JSON.stringify({ token: verificationToken })
      })
    ).toBe(true);

    expect(
      verifier({
        headers: {},
        body: { token: "wrong-token" },
        rawBody: JSON.stringify({ token: "wrong-token" })
      })
    ).toBe(false);
  });

  it("accepts signature-only requests when no verification token is configured", () => {
    const rawBody = JSON.stringify({ event: { message: "hello" } });
    const timestamp = "1782864000";
    const nonce = "nonce-1";
    const verifier = createFeishuRequestVerifier({
      encryptKey
    });

    expect(
      verifier({
        headers: {
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": sign(timestamp, nonce, rawBody)
        },
        body: { event: { message: "hello" } },
        rawBody
      })
    ).toBe(true);

    expect(
      verifier({
        headers: {
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": "bad-signature"
        },
        body: { token: "wrong-token" },
        rawBody
      })
    ).toBe(false);
  });

  it("requires both verification token and signature when both are configured", () => {
    const rawBody = JSON.stringify({ header: { token: verificationToken } });
    const timestamp = "1782864000";
    const nonce = "nonce-1";
    const verifier = createFeishuRequestVerifier({
      verificationToken,
      encryptKey
    });

    expect(
      verifier({
        headers: {},
        body: { header: { token: verificationToken } },
        rawBody
      })
    ).toBe(false);

    expect(
      verifier({
        headers: {
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": sign(timestamp, nonce, rawBody)
        },
        body: { header: { token: "wrong-token" } },
        rawBody
      })
    ).toBe(false);

    expect(
      verifier({
        headers: {
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": "bad-signature"
        },
        body: { header: { token: verificationToken } },
        rawBody
      })
    ).toBe(false);

    expect(
      verifier({
        headers: {
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": sign(timestamp, nonce, rawBody)
        },
        body: { header: { token: verificationToken } },
        rawBody
      })
    ).toBe(true);
  });
});

function sign(timestamp: string, nonce: string, rawBody: string): string {
  return createHash("sha256").update(timestamp + nonce + encryptKey + rawBody).digest("hex");
}
