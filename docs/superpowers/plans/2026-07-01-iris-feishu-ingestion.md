# Iris Feishu Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2A of Iris: secure Feishu callback verification and normalized internal event contracts on top of the Iris v1 foundation.

**Architecture:** The Feishu Gateway remains ack-first: it performs only minimal authenticity verification, idempotency-key resolution, raw event enqueueing, and HTTP response construction before returning. Event callback signatures use Feishu/Lark's Events & Callbacks Encrypt Key, not the application App Secret. Event normalization is a separate pure module that turns Feishu-shaped payloads into Iris internal events for downstream workers.

**Tech Stack:** TypeScript, Fastify, Vitest, Zod, Node.js crypto primitives.

---

## Scope

This plan intentionally does not implement full Feishu OAuth installation, token refresh, Postgres persistence, or a production Redis/BullMQ queue. It creates the safe ingestion boundary required before Iris can receive real Feishu callbacks.

This plan builds:

- Feishu verification-token validation for URL verification and callback events.
- Feishu signature validation for timestamp/nonce/body callbacks using the configured Feishu Encrypt Key.
- Environment-driven verifier factory.
- Internal Iris event normalization contracts.
- Route tests proving invalid Feishu callbacks are rejected before enqueue.

## File Structure

Create or modify:

```text
apps/core/src/feishu/
  feishu-auth.ts
  feishu-event-normalizer.ts
  feishu-gateway.ts
apps/core/src/app.ts
apps/core/src/config/env.ts
apps/core/tests/
  feishu-auth.test.ts
  feishu-event-normalizer.test.ts
  feishu-gateway.test.ts
```

Responsibilities:

- `feishu-auth.ts`: small, testable authenticity helpers and verifier factory.
- `feishu-event-normalizer.ts`: pure conversion from raw Feishu payloads into Iris internal event objects.
- `env.ts`: reads required Feishu configuration from environment variables without coupling tests to process.env.
- `feishu-gateway.ts`: keeps existing ack-first behavior and uses injectable verifier.
- `app.ts`: wires configured verifier into `buildApp`.

## Task 1: Feishu Auth Primitives

**Files:**
- Create: `apps/core/src/feishu/feishu-auth.ts`
- Create: `apps/core/tests/feishu-auth.test.ts`

- [ ] **Step 1: Write failing auth tests**

Create `apps/core/tests/feishu-auth.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createFeishuRequestVerifier,
  isFeishuUrlVerificationPayload,
  verifyFeishuSignature,
  verifyFeishuVerificationToken
} from "../src/feishu/feishu-auth.js";

describe("Feishu auth primitives", () => {
  it("detects Feishu URL verification payloads", () => {
    expect(isFeishuUrlVerificationPayload({ type: "url_verification", challenge: "abc", token: "token-a" })).toBe(true);
    expect(isFeishuUrlVerificationPayload({ event: {} })).toBe(false);
  });

  it("verifies token-bearing payloads", () => {
    expect(verifyFeishuVerificationToken({ body: { header: { token: "token-a" } }, verificationToken: "token-a" })).toBe(true);
    expect(verifyFeishuVerificationToken({ body: { token: "token-a" }, verificationToken: "token-a" })).toBe(true);
    expect(verifyFeishuVerificationToken({ body: { header: { token: "wrong" } }, verificationToken: "token-a" })).toBe(false);
  });

  it("verifies Feishu request signatures", () => {
    const timestamp = "1710000000";
    const nonce = "nonce-a";
    const bodyText = "{\"event_id\":\"event-a\"}";
    const encryptKey = "encrypt-key-a";
    const signature = createHash("sha256").update(timestamp + nonce + encryptKey + bodyText).digest("hex");

    expect(verifyFeishuSignature({
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signature
      },
      rawBody: bodyText,
      encryptKey
    })).toBe(true);
  });

  it("rejects invalid signatures", () => {
    expect(verifyFeishuSignature({
      headers: {
        "x-lark-request-timestamp": "1710000000",
        "x-lark-request-nonce": "nonce-a",
        "x-lark-signature": "bad-signature"
      },
      rawBody: "{\"event_id\":\"event-a\"}",
      encryptKey: "encrypt-key-a"
    })).toBe(false);
  });

  it("creates a verifier that accepts valid token or signature", async () => {
    const verifier = createFeishuRequestVerifier({
      verificationToken: "token-a",
      encryptKey: "encrypt-key-a"
    });

    expect(await verifier({
      headers: {},
      body: { header: { token: "token-a" } },
      rawBody: "{\"header\":{\"token\":\"token-a\"}}"
    })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- feishu-auth.test.ts
```

Expected: FAIL because `feishu-auth.ts` does not exist.

- [ ] **Step 3: Implement auth primitives**

Create `apps/core/src/feishu/feishu-auth.ts`:

```ts
import { createHash, timingSafeEqual } from "node:crypto";
import type { FeishuCallbackRequest } from "./feishu-gateway.js";

export type FeishuAuthConfig = {
  verificationToken?: string;
  encryptKey?: string;
};

export type FeishuRequestVerifier = (request: FeishuCallbackRequest) => Promise<boolean> | boolean;

export function isFeishuUrlVerificationPayload(body: unknown): body is {
  type: "url_verification";
  challenge: string;
  token?: string;
} {
  return isRecord(body) && body.type === "url_verification" && typeof body.challenge === "string";
}

export function verifyFeishuVerificationToken(input: {
  body: unknown;
  verificationToken: string;
}): boolean {
  const token = readString(input.body, ["header", "token"]) ?? readString(input.body, ["token"]);
  if (!token) {
    return false;
  }

  return safeEqual(token, input.verificationToken);
}

export function verifyFeishuSignature(input: {
  headers: Record<string, string | undefined>;
  rawBody: string | undefined;
  encryptKey: string;
}): boolean {
  const timestamp = input.headers["x-lark-request-timestamp"];
  const nonce = input.headers["x-lark-request-nonce"];
  const signature = input.headers["x-lark-signature"];

  if (!timestamp || !nonce || !signature || input.rawBody === undefined) {
    return false;
  }

  const expected = createHash("sha256")
    .update(timestamp + nonce + input.encryptKey + input.rawBody)
    .digest("hex");

  return safeEqual(signature, expected);
}

export function createFeishuRequestVerifier(config: FeishuAuthConfig): FeishuRequestVerifier {
  return (request) => {
    if (config.verificationToken && verifyFeishuVerificationToken({
      body: request.body,
      verificationToken: config.verificationToken
    })) {
      return true;
    }

    if (config.encryptKey && verifyFeishuSignature({
      headers: request.headers,
      rawBody: request.rawBody,
      encryptKey: config.encryptKey
    })) {
      return true;
    }

    return false;
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  return typeof current === "string" ? current : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm --workspace apps/core test -- feishu-auth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/core/src/feishu/feishu-auth.ts apps/core/tests/feishu-auth.test.ts
git commit -m "feat: add Feishu auth primitives"
```

## Task 2: Preserve Raw Body Through Fastify Route

**Files:**
- Modify: `apps/core/src/feishu/feishu-gateway.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/feishu-gateway.test.ts`

- [ ] **Step 1: Add failing rawBody route test**

Append to `apps/core/tests/feishu-gateway.test.ts`:

```ts
describe("Core App raw body forwarding", () => {
  it("passes the raw request body to the Feishu verifier", async () => {
    let observedRawBody: string | undefined;
    const queue = new InMemoryEventQueue();
    const app = buildApp({
      queue,
      verifyFeishuRequest: (request) => {
        observedRawBody = request.rawBody;
        return true;
      }
    });

    await app.inject({
      method: "POST",
      url: "/feishu/events",
      headers: { "content-type": "application/json", "x-iris-event-id": "raw-body-1" },
      payload: { event_id: "raw-body-1" }
    });

    expect(observedRawBody).toBe(JSON.stringify({ event_id: "raw-body-1" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- feishu-gateway.test.ts
```

Expected: FAIL because `FeishuCallbackRequest` has no `rawBody`.

- [ ] **Step 3: Add rawBody to gateway request type**

Modify `apps/core/src/feishu/feishu-gateway.ts`:

```ts
export type FeishuCallbackRequest = {
  headers: Record<string, string | undefined>;
  body: unknown;
  rawBody?: string;
};
```

- [ ] **Step 4: Capture rawBody in app route**

Modify `apps/core/src/app.ts` by adding a JSON body parser that stores raw text:

```ts
const app = Fastify({ logger: false });

app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
  try {
    const rawBody = typeof body === "string" ? body : body.toString("utf8");
    done(null, {
      parsedBody: JSON.parse(rawBody),
      rawBody
    });
  } catch (error) {
    done(error as Error);
  }
});
```

Then in the route:

```ts
const parsedRequestBody = isParsedBody(request.body) ? request.body.parsedBody : request.body;
const rawBody = isParsedBody(request.body) ? request.body.rawBody : undefined;

const response = await gateway.handleCallback({
  headers: normalizeHeaders(request.headers),
  body: parsedRequestBody,
  rawBody
});
```

Add helper:

```ts
function isParsedBody(value: unknown): value is { parsedBody: unknown; rawBody: string } {
  return typeof value === "object" && value !== null && "parsedBody" in value && "rawBody" in value;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```powershell
npm --workspace apps/core test -- feishu-gateway.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run typecheck and commit**

```powershell
npm run typecheck
git add apps/core/src/feishu/feishu-gateway.ts apps/core/src/app.ts apps/core/tests/feishu-gateway.test.ts
git commit -m "feat: preserve Feishu raw callback body"
```

## Task 3: Wire Configured Feishu Verifier

**Files:**
- Create: `apps/core/src/config/env.ts`
- Modify: `apps/core/src/app.ts`
- Create: `apps/core/tests/env.test.ts`
- Modify: `apps/core/tests/feishu-gateway.test.ts`

- [ ] **Step 1: Write failing env tests**

Create `apps/core/tests/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFeishuAuthConfig } from "../src/config/env.js";

describe("readFeishuAuthConfig", () => {
  it("reads Feishu auth config from an env-like object", () => {
    expect(readFeishuAuthConfig({
      FEISHU_VERIFICATION_TOKEN: "token-a",
      FEISHU_ENCRYPT_KEY: "encrypt-key-a"
    })).toEqual({
      verificationToken: "token-a",
      encryptKey: "encrypt-key-a"
    });
  });

  it("treats blank values as undefined", () => {
    expect(readFeishuAuthConfig({
      FEISHU_VERIFICATION_TOKEN: " ",
      FEISHU_ENCRYPT_KEY: ""
    })).toEqual({});
  });
});
```

- [ ] **Step 2: Run env test to verify it fails**

```powershell
npm --workspace apps/core test -- env.test.ts
```

Expected: FAIL because env.ts does not exist.

- [ ] **Step 3: Implement env config**

Create `apps/core/src/config/env.ts`:

```ts
import type { FeishuAuthConfig } from "../feishu/feishu-auth.js";

export type EnvLike = Record<string, string | undefined>;

export function readFeishuAuthConfig(env: EnvLike = process.env): FeishuAuthConfig {
  return {
    verificationToken: nonBlank(env.FEISHU_VERIFICATION_TOKEN),
    encryptKey: nonBlank(env.FEISHU_ENCRYPT_KEY)
  };
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
```

- [ ] **Step 4: Wire verifier into default app**

Modify `apps/core/src/app.ts`:

```ts
import { readFeishuAuthConfig } from "./config/env.js";
import { createFeishuRequestVerifier } from "./feishu/feishu-auth.js";
```

In `buildApp`, set verifier:

```ts
const verifyFeishuRequest = dependencies.verifyFeishuRequest
  ?? createOptionalVerifierFromEnv();
```

Pass `verifyFeishuRequest` to gateway.

Add helper:

```ts
function createOptionalVerifierFromEnv() {
  const config = readFeishuAuthConfig();
  if (!config.verificationToken && !config.encryptKey) {
    return undefined;
  }

  return createFeishuRequestVerifier(config);
}
```

- [ ] **Step 5: Add route test for env verifier behavior**

Append to `apps/core/tests/feishu-gateway.test.ts`:

```ts
describe("Core App Feishu auth", () => {
  it("does not enqueue when verifier rejects", async () => {
    const queue = new InMemoryEventQueue();
    const app = buildApp({
      queue,
      verifyFeishuRequest: () => false
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/events",
      headers: { "x-iris-event-id": "reject-route-1" },
      payload: { event_id: "reject-route-1" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false });
    expect(queue.events).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run tests and typecheck**

```powershell
npm --workspace apps/core test -- env.test.ts feishu-gateway.test.ts feishu-auth.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/core/src/config/env.ts apps/core/src/app.ts apps/core/tests/env.test.ts apps/core/tests/feishu-gateway.test.ts
git commit -m "feat: wire Feishu verifier config"
```

## Task 4: Iris Event Normalization

**Files:**
- Create: `apps/core/src/feishu/feishu-event-normalizer.ts`
- Create: `apps/core/tests/feishu-event-normalizer.test.ts`

- [ ] **Step 1: Write failing normalizer tests**

Create `apps/core/tests/feishu-event-normalizer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeFeishuEvent } from "../src/feishu/feishu-event-normalizer.js";

describe("normalizeFeishuEvent", () => {
  it("normalizes a Feishu message event into an Iris group message event", () => {
    const normalized = normalizeFeishuEvent({
      event_id: "event-a",
      event: {
        sender: { sender_id: { open_id: "user-a" } },
        message: {
          message_id: "msg-a",
          chat_id: "chat-a",
          create_time: "1710000000000",
          message_type: "text",
          content: "{\"text\":\"hello iris\"}"
        }
      }
    });

    expect(normalized).toEqual({
      kind: "group_message",
      eventId: "event-a",
      messageId: "msg-a",
      chatId: "chat-a",
      senderOpenId: "user-a",
      messageType: "text",
      text: "hello iris",
      timestamp: new Date(1710000000000),
      documentLinks: []
    });
  });

  it("extracts Feishu document links from text content", () => {
    const normalized = normalizeFeishuEvent({
      event_id: "event-a",
      event: {
        sender: { sender_id: { open_id: "user-a" } },
        message: {
          message_id: "msg-a",
          chat_id: "chat-a",
          create_time: "1710000000000",
          message_type: "text",
          content: "{\"text\":\"see https://example.feishu.cn/docx/ABC123\"}"
        }
      }
    });

    expect(normalized.documentLinks).toEqual(["https://example.feishu.cn/docx/ABC123"]);
  });

  it("returns unsupported for unknown payloads", () => {
    expect(normalizeFeishuEvent({ event_id: "event-a" })).toEqual({
      kind: "unsupported",
      eventId: "event-a",
      reason: "missing_message"
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm --workspace apps/core test -- feishu-event-normalizer.test.ts
```

Expected: FAIL because normalizer does not exist.

- [ ] **Step 3: Implement normalizer**

Create `apps/core/src/feishu/feishu-event-normalizer.ts`:

```ts
export type IrisNormalizedEvent =
  | {
      kind: "group_message";
      eventId: string;
      messageId: string;
      chatId: string;
      senderOpenId: string;
      messageType: string;
      text: string;
      timestamp: Date;
      documentLinks: string[];
    }
  | {
      kind: "unsupported";
      eventId: string;
      reason: string;
    };

export function normalizeFeishuEvent(payload: unknown): IrisNormalizedEvent {
  const eventId = readString(payload, ["event_id"]) ?? "unknown";
  const message = readRecord(payload, ["event", "message"]);
  if (!message) {
    return { kind: "unsupported", eventId, reason: "missing_message" };
  }

  const messageId = readString(message, ["message_id"]);
  const chatId = readString(message, ["chat_id"]);
  const createTime = readString(message, ["create_time"]);
  const messageType = readString(message, ["message_type"]) ?? "unknown";
  const senderOpenId = readString(payload, ["event", "sender", "sender_id", "open_id"]);

  if (!messageId || !chatId || !createTime || !senderOpenId) {
    return { kind: "unsupported", eventId, reason: "missing_required_fields" };
  }

  const text = extractText(readString(message, ["content"]));

  return {
    kind: "group_message",
    eventId,
    messageId,
    chatId,
    senderOpenId,
    messageType,
    text,
    timestamp: new Date(Number(createTime)),
    documentLinks: extractDocumentLinks(text)
  };
}

function extractText(content: string | undefined): string {
  if (!content) {
    return "";
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    const text = readString(parsed, ["text"]);
    return text ?? content;
  } catch {
    return content;
  }
}

function extractDocumentLinks(text: string): string[] {
  return [...text.matchAll(/https?:\\/\\/[^\\s]+\\.feishu\\.cn\\/(?:docx|wiki|file|docs)\\/[^\\s)]+/g)]
    .map((match) => match[0]);
}

function readRecord(value: unknown, path: string[]): Record<string, unknown> | undefined {
  const current = readPath(value, path);
  return isRecord(current) ? current : undefined;
}

function readString(value: unknown, path: string[]): string | undefined {
  const current = readPath(value, path);
  return typeof current === "string" ? current : undefined;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
```

- [ ] **Step 4: Run test and typecheck**

```powershell
npm --workspace apps/core test -- feishu-event-normalizer.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/core/src/feishu/feishu-event-normalizer.ts apps/core/tests/feishu-event-normalizer.test.ts
git commit -m "feat: normalize Feishu message events"
```

## Task 5: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run TypeScript typecheck**

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run all TypeScript tests**

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 3: Run Python worker tests**

```powershell
cd workers/ai
python -m pytest
cd ../..
```

Expected: PASS.

- [ ] **Step 4: Check git status**

```powershell
git status --short --branch
```

Expected: clean worktree on `codex/iris-feishu-ingestion`.
