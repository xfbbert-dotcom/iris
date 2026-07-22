import { describe, expect, it } from "vitest";

import { parseFeishuCardAction } from "../src/feishu/feishu-card-action.js";

describe("parseFeishuCardAction", () => {
  it("parses an exact Feishu schema 2 card action fixture", () => {
    expect(parseFeishuCardAction(cardAction())).toEqual({
      kind: "knowledge_draft_confirmation",
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

  it("parses an exact action proposal approval without draft fields", () => {
    expect(parseFeishuCardAction(cardAction({
      event: {
        action: {
          name: "approve",
          value: proposalActionValue({ action: "approve" }),
          form_value: { reason: "" },
        },
      },
    }))).toEqual({
      kind: "action_proposal_approval",
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
          form_value: { reason: "" },
        },
      },
    }))).toMatchObject({ action: "confirm" });

    expect(parseFeishuCardAction(cardAction({
      event: {
        action: {
          name: "request_revision",
          value: actionValue({ action: "request_revision" }),
          form_value: { reason: "  Add rollback steps.  " },
        },
      },
    }))).toMatchObject({ action: "request_revision", reason: "Add rollback steps." });
  });

  it.each([
    ["an unknown callback-value field", cardAction({ event: { action: { value: { ...actionValue(), unexpected: true } } } })],
    ["a legacy callback without kind", cardAction({ event: { action: { value: { ...actionValue(), kind: undefined } } } })],
    ["mixed draft and proposal fields", cardAction({ event: { action: { value: { ...actionValue(), proposalId: "proposal-1" } } } })],
    ["an unknown form field", cardAction({ event: { action: { form_value: { reason: "Unsafe rollout plan.", unexpected: "value" } } } })],
    ["a legacy checkbox field", cardAction({ event: { action: { form_value: { reason: "Unsafe rollout plan.", rejectionConfirmed: ["true"] } } } })],
    ["a wrong callback-value type", cardAction({ event: { action: { value: { ...actionValue(), revisionNumber: 7 } } } })],
    ["a non-canonical revision number", cardAction({ event: { action: { value: { ...actionValue(), revisionNumber: "07" } } } })],
    ["an unsafe draft version", cardAction({ event: { action: { value: { ...actionValue(), draftVersion: "9007199254740992" } } } })],
    ["a missing callback-value field", cardAction({ event: { action: { value: { ...actionValue(), draftVersion: undefined } } } })],
    ["a mismatched action name", cardAction({ event: { action: { name: "confirm" } } })],
    ["a non-string action timezone", cardAction({ event: { action: { timezone: 8 } } })],
    ["a missing revision reason", cardAction({ event: { action: { name: "request_revision", value: actionValue({ action: "request_revision" }), form_value: { reason: "" } } } })],
    ["a missing rejection reason", cardAction({ event: { action: { form_value: { reason: "" } } } })],
    ["an approval reason", cardAction({ event: { action: { name: "approve", value: proposalActionValue({ action: "approve" }), form_value: { reason: "not allowed" } } } })],
    ["a non-canonical proposal version", cardAction({ event: { action: { name: "approve", value: proposalActionValue({ action: "approve", proposalVersion: "04" }), form_value: { reason: "" } } } })],
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
        timezone: "Asia/Shanghai",
        form_value: {
          reason: "  Unsafe rollout plan.  ",
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
    kind: "knowledge_draft_confirmation",
    action: "reject",
    presentationId: "presentation-1",
    draftId: "draft-1",
    revisionNumber: "7",
    draftVersion: "11",
    ...overrides,
  };
}

function proposalActionValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    draftId: undefined,
    revisionNumber: undefined,
    draftVersion: undefined,
    kind: "action_proposal_approval",
    action: "approve",
    presentationId: "proposal-presentation-1",
    proposalId: "proposal-1",
    requirementId: "requirement-1",
    proposalVersion: "4",
    subjectRevision: "2",
    subjectVersion: "7",
    targetPolicyVersion: "3",
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
