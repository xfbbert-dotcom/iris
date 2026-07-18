import { describe, expect, it } from "vitest";

import { parseFeishuCardAction } from "../src/feishu/feishu-card-action.js";

describe("parseFeishuCardAction", () => {
  it("parses an exact Feishu schema 2 card action fixture", () => {
    expect(parseFeishuCardAction(cardAction())).toEqual({
      eventId: "event-1",
      appId: "cli_approval",
      actorOpenId: "ou_reviewer",
      chatId: "oc_approval",
      messageId: "om_approval",
      presentationId: "presentation-1",
      draftId: "draft-1",
      revisionNumber: 7,
      draftVersion: 11,
      action: "reject",
      reason: "Unsafe rollout plan.",
      rejectionConfirmed: true,
    });
  });

  it("requires the exact callback event and bounded identifiers", () => {
    expect(parseFeishuCardAction(cardAction({ header: { event_type: "im.message.receive_v1" } }))).toBeUndefined();
    expect(parseFeishuCardAction(cardAction({ header: { event_id: " " } }))).toBeUndefined();
    expect(parseFeishuCardAction(cardAction({ header: { app_id: "x".repeat(513) } }))).toBeUndefined();
    expect(parseFeishuCardAction(cardAction({ event: { operator: { open_id: " " } } }))).toBeUndefined();
    expect(parseFeishuCardAction(cardAction({ event: { context: { open_chat_id: " " } } }))).toBeUndefined();
  });

  it("parses form values according to the selected action", () => {
    expect(parseFeishuCardAction(cardAction({
      event: {
        action: {
          name: "confirm",
          value: actionValue({ action: "confirm" }),
          form_value: { reason: "", rejectionConfirmed: [] },
        },
      },
    }))).toMatchObject({ action: "confirm" });

    expect(parseFeishuCardAction(cardAction({
      event: {
        action: {
          name: "request_revision",
          value: actionValue({ action: "request_revision" }),
          form_value: { reason: "  Add rollback steps.  ", rejectionConfirmed: [] },
        },
      },
    }))).toMatchObject({ action: "request_revision", reason: "Add rollback steps." });
  });

  it.each([
    ["an unknown callback-value field", cardAction({ event: { action: { value: { ...actionValue(), unexpected: true } } } })],
    ["an unknown form field", cardAction({ event: { action: { form_value: { reason: "Unsafe rollout plan.", rejectionConfirmed: ["true"], unexpected: "value" } } } })],
    ["a wrong callback-value type", cardAction({ event: { action: { value: { ...actionValue(), revisionNumber: "7" } } } })],
    ["a missing callback-value field", cardAction({ event: { action: { value: { ...actionValue(), draftVersion: undefined } } } })],
    ["a mismatched action name", cardAction({ event: { action: { name: "confirm" } } })],
    ["a missing revision reason", cardAction({ event: { action: { name: "request_revision", value: actionValue({ action: "request_revision" }), form_value: { reason: "", rejectionConfirmed: [] } } } })],
    ["an unconfirmed rejection", cardAction({ event: { action: { form_value: { reason: "Unsafe rollout plan.", rejectionConfirmed: [] } } } })],
    ["a wrong rejection confirmation type", cardAction({ event: { action: { form_value: { reason: "Unsafe rollout plan.", rejectionConfirmed: "true" } } } })],
  ])("rejects %s", (_label, body) => {
    expect(parseFeishuCardAction(body)).toBeUndefined();
  });
});

function cardAction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return merge({
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
      operator: {
        tenant_key: "tenant-1",
        open_id: "ou_reviewer",
      },
      token: "card-token",
      action: {
        value: actionValue(),
        tag: "button",
        name: "reject",
        form_value: {
          reason: "  Unsafe rollout plan.  ",
          rejectionConfirmed: ["true"],
        },
      },
      host: "im_message",
      context: {
        open_message_id: "om_approval",
        open_chat_id: "oc_approval",
      },
    },
  }, overrides);
}

function actionValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "reject",
    presentationId: "presentation-1",
    draftId: "draft-1",
    revisionNumber: 7,
    draftVersion: 11,
    ...overrides,
  };
}

function merge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete result[key];
      continue;
    }
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = merge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
