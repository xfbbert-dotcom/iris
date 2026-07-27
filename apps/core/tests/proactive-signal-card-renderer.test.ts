import { describe, expect, it } from "vitest";

import { renderProactiveSignalCard } from "../src/proactive-signals/proactive-signal-card-renderer.js";
import type { ProactiveSignalDeliveryContext } from "../src/proactive-signals/proactive-signal-repository.js";

describe("ProactiveSignalCardRenderer", () => {
  it("renders a bounded Feishu group card without raw evidence text", () => {
    const result = renderProactiveSignalCard({
      context: deliveryContext(),
    });

    expect(result.card.header).toMatchObject({
      template: "orange",
      title: { tag: "plain_text", content: "Iris follow-up" },
    });
    expect(result.json).toContain("Thread has been quiet");
    expect(result.json).toContain("2 related messages");
    expect(result.json).not.toContain("message-a");
    expect(result.json).not.toContain("private project detail");
    expect(Buffer.byteLength(result.json, "utf8")).toBeLessThanOrEqual(24 * 1024);
  });

  it("binds compact feedback buttons only to the proactive delivery facts", () => {
    const result = renderProactiveSignalCard({ context: deliveryContext() });
    const elements = (result.card.body as { elements: Array<Record<string, unknown>> }).elements;
    const form = elements.at(-1);

    expect(form).toMatchObject({ tag: "form", name: "proactiveSignalFeedback" });
    const buttons = (form?.elements as Array<Record<string, unknown>>);
    expect(buttons).toEqual([
      {
        tag: "button",
        name: "helpful",
        text: { tag: "plain_text", content: "\u6709\u5e2e\u52a9" },
        type: "primary",
        form_action_type: "submit",
        behaviors: [{
          type: "callback",
          value: {
            kind: "proactive_signal_feedback",
            action: "helpful",
            deliveryId: "proactive-delivery:abc",
            candidateIdempotencyKey: "quiet_open_thread:thread-a:1",
            entityVersion: "1",
          },
        }],
      },
      {
        tag: "button",
        name: "irrelevant",
        text: { tag: "plain_text", content: "\u4e0d\u76f8\u5173" },
        type: "default",
        form_action_type: "submit",
        behaviors: [{
          type: "callback",
          value: {
            kind: "proactive_signal_feedback",
            action: "irrelevant",
            deliveryId: "proactive-delivery:abc",
            candidateIdempotencyKey: "quiet_open_thread:thread-a:1",
            entityVersion: "1",
          },
        }],
      },
    ]);
    expect(result.json).not.toMatch(/actor|message-a|private project detail/iu);
    expect(result.componentCount).toBeLessThanOrEqual(12);
    expect(Buffer.byteLength(result.json, "utf8")).toBeLessThanOrEqual(24 * 1024);
  });

  it("renders high priority overdue actions distinctly", () => {
    const result = renderProactiveSignalCard({
      context: deliveryContext({
        kind: "overdue_action",
        priority: "high",
        reasonCode: "action_due_at_elapsed",
        suggestedMode: "ask_for_status",
      }),
    });

    expect(result.card.header).toMatchObject({
      template: "red",
      title: { tag: "plain_text", content: "Iris follow-up" },
    });
    expect(result.json).toContain("Action appears overdue");
  });
});

function deliveryContext(
  overrides: Partial<ProactiveSignalDeliveryContext["candidate"]> = {},
): ProactiveSignalDeliveryContext {
  const now = new Date("2026-07-23T10:00:00.000Z");
  return {
    delivery: {
      id: "proactive-delivery:abc",
      candidateIdempotencyKey: "quiet_open_thread:thread-a:1",
      groupId: "group-a",
      status: "processing",
      attemptCount: 1,
    },
    candidate: {
      idempotencyKey: "quiet_open_thread:thread-a:1",
      groupId: "group-a",
      kind: "quiet_open_thread",
      priority: "medium",
      entityType: "thread",
      entityId: "thread-a",
      entityVersion: 1,
      reasonCode: "thread_quiet_threshold_elapsed",
      suggestedMode: "ask_for_thread_update",
      status: "pending",
      lastRelevantAt: new Date("2026-07-23T08:00:00.000Z"),
      createdAt: now,
      updatedAt: now,
      evidenceMessageIds: ["message-a", "message-b"],
      ...overrides,
    },
  };
}
