import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createFeishuRequestVerifier } from "../src/feishu/feishu-auth.js";
import { createFeishuCardActionGateway } from "../src/feishu/feishu-card-action-gateway.js";

describe("FeishuCardActionGateway", () => {
  it("reports a content-free envelope rejection before decoding", async () => {
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const decodeRequest = vi.fn((request) => request);
    const onDiagnostic = vi.fn();
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: () => false,
      decodeRequest,
      onDiagnostic,
    });
    const request = {
      headers: {
        "x-lark-request-timestamp": "sensitive-timestamp",
        "x-lark-request-nonce": "sensitive-nonce",
        "x-lark-signature": "sensitive-signature",
      },
      body: { encrypt: "sensitive-encrypted-body" },
      rawBody: "sensitive-raw-body",
    };

    await expect(gateway.handleCallback(request)).resolves.toMatchObject({ statusCode: 401 });

    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith({
      stage: "envelope_rejected",
      statusCode: 401,
      hasTimestamp: true,
      hasNonce: true,
      hasSignature: true,
      encrypted: true,
    });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(
      /sensitive-(?:timestamp|nonce|signature|encrypted-body|raw-body)/u,
    );
    expect(decodeRequest).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("reports a content-free decode rejection", async () => {
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const onDiagnostic = vi.fn();
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: () => true,
      decodeRequest: () => undefined,
      onDiagnostic,
    });

    await expect(gateway.handleCallback({
      headers: {},
      body: { encrypt: "sensitive-encrypted-body" },
    })).resolves.toMatchObject({ statusCode: 401 });

    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith({
      stage: "decode_rejected",
      statusCode: 401,
      hasTimestamp: false,
      hasNonce: false,
      hasSignature: false,
      encrypted: true,
    });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("sensitive-encrypted-body");
  });

  it("reports a content-free decoded identity rejection", async () => {
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const onDiagnostic = vi.fn();
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: () => true,
      decodeRequest: (request) => ({
        ...request,
        body: { token: "sensitive-token", challenge: "sensitive-challenge" },
      }),
      verifyDecodedRequest: () => false,
      onDiagnostic,
    });

    await expect(gateway.handleCallback({ headers: {}, body: { encrypt: "ciphertext" } }))
      .resolves.toMatchObject({ statusCode: 401 });

    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith({
      stage: "decoded_identity_rejected",
      statusCode: 401,
      hasTimestamp: false,
      hasNonce: false,
      hasSignature: false,
      encrypted: true,
    });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/sensitive-(?:token|challenge)/u);
  });

  it("reports a content-free accepted URL challenge", async () => {
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const onDiagnostic = vi.fn();
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: () => true,
      verifyDecodedRequest: () => true,
      onDiagnostic,
    });

    await expect(gateway.handleCallback({
      headers: {},
      body: {
        type: "url_verification",
        challenge: "sensitive-challenge",
        token: "sensitive-token",
      },
    })).resolves.toEqual({
      statusCode: 200,
      body: { challenge: "sensitive-challenge" },
    });

    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith({
      stage: "challenge_accepted",
      statusCode: 200,
      hasTimestamp: false,
      hasNonce: false,
      hasSignature: false,
      encrypted: false,
    });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/sensitive-(?:token|challenge)/u);
  });

  it("verifies before parsing and returns 401 without enqueueing", async () => {
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const decodeRequest = vi.fn((request) => request);
    const verifyDecodedRequest = vi.fn(() => true);
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: () => false,
      decodeRequest,
      verifyDecodedRequest,
    });

    await expect(gateway.handleCallback({ headers: {}, body: { invalid: true } })).resolves.toEqual({
      statusCode: 401,
      body: { ok: false },
    });
    expect(decodeRequest).not.toHaveBeenCalled();
    expect(verifyDecodedRequest).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("returns 400 without enqueueing when a verified callback is not an exact card action", async () => {
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const onDiagnostic = vi.fn();
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: () => true,
      onDiagnostic,
    });

    const body = {
      schema: "1.0",
      header: { event_id: "sensitive-event-id" },
      event: {
        host: "sensitive-host",
        operator: { open_id: "sensitive-open-id" },
        context: { open_chat_id: "sensitive-chat-id" },
        action: {
          name: "sensitive-action-name",
          timezone: "sensitive-timezone",
          value: { presentationId: "sensitive-presentation-id" },
          form_value: {},
        },
      },
    };

    await expect(gateway.handleCallback({ headers: {}, body })).resolves.toEqual({
      statusCode: 400,
      body: { ok: false },
    });
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith({
      stage: "action_rejected",
      statusCode: 400,
      hasTimestamp: false,
      hasNonce: false,
      hasSignature: false,
      encrypted: false,
      actionShape: {
        bodyRecord: true,
        bodyKeyCount: 3,
        headerRecord: true,
        headerKeyCount: 1,
        eventRecord: true,
        eventKeyCount: 4,
        operatorRecord: true,
        operatorKeyCount: 1,
        contextRecord: true,
        contextKeyCount: 1,
        actionRecord: true,
        actionKeyCount: 4,
        callbackValueRecord: true,
        callbackValueKeyCount: 1,
        callbackValueType: "object",
        formValueRecord: true,
        formValueKeyCount: 0,
        hasReason: false,
        reasonType: "undefined",
        hasName: true,
        nameType: "string",
        hasTimezone: true,
        timezoneType: "string",
      },
    });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(
      /sensitive-(?:event-id|host|open-id|chat-id|action-name|timezone|presentation-id)/u,
    );
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("keeps action rejection diagnostics from changing the callback response", async () => {
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const onDiagnostic = vi.fn();
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: () => true,
      onDiagnostic,
    });
    const body = {
      schema: "1.0",
      get header(): never {
        throw new Error("sensitive-getter-error");
      },
    };

    await expect(gateway.handleCallback({ headers: {}, body })).resolves.toEqual({
      statusCode: 400,
      body: { ok: false },
    });
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("sensitive-getter-error");
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("returns a verified URL challenge without parsing or enqueueing a card action", async () => {
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const gateway = createFeishuCardActionGateway({ queue, verifyRequest: () => true });

    await expect(gateway.handleCallback({
      headers: {},
      body: {
        type: "url_verification",
        challenge: "card-callback-challenge",
        token: "verification-token",
      },
    })).resolves.toEqual({
      statusCode: 200,
      body: { challenge: "card-callback-challenge" },
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("rejects a token-only card callback when a signature is required", async () => {
    const now = new Date("2026-07-19T00:00:00.000Z");
    const body = cardAction();
    const rawBody = JSON.stringify(body);
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: createFeishuRequestVerifier({
        verificationToken: "verification-token",
      }, {
        now: () => now,
        requireSignature: true,
      }),
    });

    await expect(gateway.handleCallback({ headers: {}, body, rawBody })).resolves.toMatchObject({
      statusCode: 401,
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("rejects unsigned, missing-body, and stale signed card callbacks", async () => {
    const now = new Date("2026-07-19T00:00:00.000Z");
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const encryptKey = "card-action-encrypt-key";
    const body = cardAction();
    const rawBody = JSON.stringify(body);
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: createFeishuRequestVerifier({
        verificationToken: "verification-token",
        encryptKey,
      }, {
        now: () => now,
        requireSignature: true,
      }),
    });
    const signedHeaders = (timestamp: string) => ({
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": "nonce-1",
      "x-lark-signature": createHash("sha256")
        .update(timestamp + "nonce-1" + encryptKey + rawBody)
        .digest("hex"),
    });

    await expect(gateway.handleCallback({
      headers: {
        "x-lark-request-timestamp": String(nowSeconds),
        "x-lark-request-nonce": "nonce-1",
      },
      body,
      rawBody,
    })).resolves.toMatchObject({ statusCode: 401 });
    await expect(gateway.handleCallback({
      headers: signedHeaders(String(nowSeconds)),
      body,
    })).resolves.toMatchObject({ statusCode: 401 });
    await expect(gateway.handleCallback({
      headers: signedHeaders(String(nowSeconds - 301)),
      body,
      rawBody,
    })).resolves.toMatchObject({ statusCode: 401 });
    await expect(gateway.handleCallback({
      headers: signedHeaders(String(nowSeconds)),
      body,
      rawBody,
    })).resolves.toMatchObject({ statusCode: 200 });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("enqueues the normalized job once and acknowledges a fast enqueue", async () => {
    const now = new Date("2026-07-19T00:00:00.000Z");
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: () => true,
      now: () => now,
    });

    await expect(gateway.handleCallback({ headers: {}, body: cardAction() })).resolves.toEqual({
      statusCode: 200,
      body: { toast: { type: "info", content: "\u5df2\u6536\u5230\uff0c\u6b63\u5728\u6838\u9a8c" } },
    });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith({
      kind: "knowledge_draft_confirmation",
      idempotencyKey: "feishu-card:cli_approval:event-1",
      eventId: "event-1",
      appId: "cli_approval",
      actorOpenId: "ou_reviewer",
      chatId: "oc_approval",
      messageId: "om_approval",
      presentationId: "presentation-1",
      draftId: "draft-1",
      revisionNumber: 7,
      draftVersion: 11,
      action: "confirm",
      receivedAt: now,
      attempts: 0,
    });
  });

  it("enqueues a content-free action proposal approval job", async () => {
    const now = new Date("2026-07-19T00:00:00.000Z");
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: () => true,
      now: () => now,
    });
    const body = cardAction();
    const event = body.event as Record<string, unknown>;
    const action = event.action as Record<string, unknown>;
    action.name = "approve";
    action.form_value = { reason: "" };
    action.value = {
      kind: "action_proposal_approval",
      action: "approve",
      presentationId: "proposal-presentation-1",
      proposalId: "proposal-1",
      requirementId: "requirement-1",
      proposalVersion: "4",
      subjectRevision: "2",
      subjectVersion: "7",
      targetPolicyVersion: "3",
    };

    await expect(gateway.handleCallback({ headers: {}, body })).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      kind: "action_proposal_approval",
      idempotencyKey: "feishu-card:cli_approval:event-1",
      eventId: "event-1",
      appId: "cli_approval",
      actorOpenId: "ou_reviewer",
      chatId: "oc_approval",
      messageId: "om_approval",
      presentationId: "proposal-presentation-1",
      proposalId: "proposal-1",
      requirementId: "requirement-1",
      proposalVersion: 4,
      subjectRevision: 2,
      subjectVersion: 7,
      targetPolicyVersion: 3,
      action: "approve",
      receivedAt: now,
      attempts: 0,
    });
  });

  it("persists a normalized sensitive intent before enqueueing only its opaque id", async () => {
    const now = new Date("2026-07-19T00:00:00.000Z");
    const sampleReason = "Keep  internal spacing exactly.";
    const order: string[] = [];
    const intentStore = {
      persistIntent: vi.fn(async () => {
        order.push("persist");
        return { id: "2d3c5f18-61d4-4dc7-9d87-35f076d54c4e" };
      }),
    };
    const queue = {
      enqueue: vi.fn(async () => {
        order.push("enqueue");
        return "enqueued" as const;
      }),
    };
    const gateway = createFeishuCardActionGateway({
      queue,
      intentStore,
      verifyRequest: () => true,
      now: () => now,
    });
    const body = cardAction();
    const event = body.event as Record<string, unknown>;
    const action = event.action as Record<string, unknown>;
    action.name = "request_revision";
    action.form_value = { reason: `  ${sampleReason}  ` };
    action.value = {
      kind: "action_proposal_approval",
      action: "request_revision",
      presentationId: "proposal-presentation-1",
      proposalId: "proposal-1",
      requirementId: "requirement-1",
      proposalVersion: "4",
      subjectRevision: "2",
      subjectVersion: "7",
      targetPolicyVersion: "3",
    };

    await expect(gateway.handleCallback({ headers: {}, body })).resolves.toMatchObject({
      statusCode: 200,
    });

    expect(order).toEqual(["persist", "enqueue"]);
    expect(intentStore.persistIntent).toHaveBeenCalledWith({
      interaction: expect.objectContaining({
        kind: "action_proposal_approval",
        idempotencyKey: "feishu-card:cli_approval:event-1",
        eventId: "event-1",
        action: "request_revision",
        presentationId: "proposal-presentation-1",
        proposalId: "proposal-1",
      }),
      reason: sampleReason,
      at: now,
    });
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      action: "request_revision",
      intentId: "2d3c5f18-61d4-4dc7-9d87-35f076d54c4e",
    }));
    const serializedQueueCall = JSON.stringify(queue.enqueue.mock.calls);
    expect(serializedQueueCall).not.toContain(sampleReason);
    expect(serializedQueueCall).not.toContain("rejectionConfirmed");
  });

  it("returns an uncertainty toast after one second when enqueue does not settle", async () => {
    vi.useFakeTimers();
    try {
      const queue = { enqueue: vi.fn(() => new Promise<"enqueued" | "duplicate">(() => undefined)) };
      const gateway = createFeishuCardActionGateway({ queue, verifyRequest: () => true });
      const response = gateway.handleCallback({ headers: {}, body: cardAction() });

      await vi.advanceTimersByTimeAsync(999);
      expect(queue.enqueue).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);

      await expect(response).resolves.toEqual({
        statusCode: 200,
        body: { toast: { type: "error", content: "\u63d0\u4ea4\u72b6\u6001\u672a\u786e\u8ba4\uff0c\u8bf7\u52ff\u91cd\u590d\u70b9\u51fb\uff1b\u8bf7\u4ee5\u5361\u7247\u6700\u7ec8\u72b6\u6001\u4e3a\u51c6" } },
      });
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds sensitive intent persistence and enqueue in the same one-second deadline", async () => {
    vi.useFakeTimers();
    try {
      const intentStore = {
        persistIntent: vi.fn(() => new Promise<{ id: string }>(() => undefined)),
      };
      const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
      const gateway = createFeishuCardActionGateway({
        queue,
        intentStore,
        verifyRequest: () => true,
      });
      const body = cardAction();
      const event = body.event as Record<string, unknown>;
      const action = event.action as Record<string, unknown>;
      action.name = "request_revision";
      action.form_value = { reason: "Clarify the deployment owner." };
      action.value = {
        kind: "action_proposal_approval",
        action: "request_revision",
        presentationId: "proposal-presentation-1",
        proposalId: "proposal-1",
        requirementId: "requirement-1",
        proposalVersion: "4",
        subjectRevision: "2",
        subjectVersion: "7",
        targetPolicyVersion: "3",
      };

      const response = gateway.handleCallback({ headers: {}, body });
      await vi.advanceTimersByTimeAsync(999);
      expect(intentStore.persistIntent).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);

      await expect(response).resolves.toEqual({
        statusCode: 200,
        body: { toast: { type: "error", content: "\u63d0\u4ea4\u72b6\u6001\u672a\u786e\u8ba4\uff0c\u8bf7\u52ff\u91cd\u590d\u70b9\u51fb\uff1b\u8bf7\u4ee5\u5361\u7247\u6700\u7ec8\u72b6\u6001\u4e3a\u51c6" } },
      });
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains a late enqueue rejection after the one-second timeout", async () => {
    vi.useFakeTimers();
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    try {
      const deferred = createDeferred<"enqueued" | "duplicate">();
      const queue = { enqueue: vi.fn(() => deferred.promise) };
      const gateway = createFeishuCardActionGateway({ queue, verifyRequest: () => true });
      const response = gateway.handleCallback({ headers: {}, body: cardAction() });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(response).resolves.toEqual({
        statusCode: 200,
        body: { toast: { type: "error", content: "\u63d0\u4ea4\u72b6\u6001\u672a\u786e\u8ba4\uff0c\u8bf7\u52ff\u91cd\u590d\u70b9\u51fb\uff1b\u8bf7\u4ee5\u5361\u7247\u6700\u7ec8\u72b6\u6001\u4e3a\u51c6" } },
      });
      expect(vi.getTimerCount()).toBe(0);

      deferred.reject(new Error("late queue rejection"));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off("unhandledRejection", unhandledRejection);
      vi.useRealTimers();
    }
  });

  it("does not enqueue again when the single Redis write succeeds after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const deferred = createDeferred<"enqueued" | "duplicate">();
      const queue = { enqueue: vi.fn(() => deferred.promise) };
      const gateway = createFeishuCardActionGateway({ queue, verifyRequest: () => true });
      const response = gateway.handleCallback({ headers: {}, body: cardAction() });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(response).resolves.toEqual({
        statusCode: 200,
        body: { toast: { type: "error", content: "\u63d0\u4ea4\u72b6\u6001\u672a\u786e\u8ba4\uff0c\u8bf7\u52ff\u91cd\u590d\u70b9\u51fb\uff1b\u8bf7\u4ee5\u5361\u7247\u6700\u7ec8\u72b6\u6001\u4e3a\u51c6" } },
      });

      deferred.resolve("enqueued");
      await Promise.resolve();

      expect(queue.enqueue).toHaveBeenCalledOnce();
      expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        idempotencyKey: "feishu-card:cli_approval:event-1",
      }));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an error toast when its one enqueue attempt rejects", async () => {
    const queue = { enqueue: vi.fn(async () => { throw new Error("queue unavailable"); }) };
    const gateway = createFeishuCardActionGateway({ queue, verifyRequest: () => true });

    await expect(gateway.handleCallback({ headers: {}, body: cardAction() })).resolves.toEqual({
      statusCode: 200,
      body: { toast: { type: "error", content: "\u64cd\u4f5c\u672a\u63d0\u4ea4\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5" } },
    });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });
});

function cardAction(): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: "event-1",
      token: "verification-token",
      create_time: "1784419200000000",
      event_type: "card.action.trigger",
      tenant_key: "tenant-1",
      app_id: "cli_approval",
    },
    event: {
      operator: { tenant_key: "tenant-1", open_id: "ou_reviewer" },
      token: "card-token",
      action: {
        value: {
          kind: "knowledge_draft_confirmation",
          action: "confirm",
          presentationId: "presentation-1",
          draftId: "draft-1",
          revisionNumber: "7",
          draftVersion: "11",
        },
        tag: "button",
        name: "confirm",
        form_value: { reason: "" },
      },
      host: "im_message",
      context: { open_message_id: "om_approval", open_chat_id: "oc_approval" },
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
