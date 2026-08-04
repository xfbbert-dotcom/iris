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
      title: { tag: "plain_text", content: "Iris 主动提醒" },
    });
    expect(result.json).toContain("这个讨论已有一段时间没有更新");
    expect(result.json).toContain("Iris PR\\\\#22 验收讨论");
    expect(result.json).toContain("2 条相关群消息");
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
      title: { tag: "plain_text", content: "Iris 主动提醒" },
    });
    expect(result.json).toContain("这个行动项已超过截止时间");
    expect(result.json).toContain("完成客户反馈看板验收");
  });

  it("refuses to render an ambiguous reminder without a current subject", () => {
    expect(() => renderProactiveSignalCard({
      context: deliveryContext({}, null),
    })).toThrow("proactive signal subject is unavailable");
  });

  it("bounds and escapes the visible subject without exposing evidence text", () => {
    const result = renderProactiveSignalCard({
      context: deliveryContext({}, `**urgent** [open](https://example.com)\n${"x".repeat(300)}`),
    });
    const elements = (result.card.body as { elements: Array<Record<string, unknown>> }).elements;
    const content = String(elements[0]?.content);

    expect(content).not.toContain("**urgent**");
    expect(content).not.toContain("[open](https://example.com)");
    expect(Array.from(content).length).toBeLessThan(260);
    expect(result.json).not.toContain("message-a");
  });
});

function deliveryContext(
  overrides: Partial<ProactiveSignalDeliveryContext["candidate"]> = {},
  subjectLabel: string | null = overrides.kind === "overdue_action"
    ? "完成客户反馈看板验收"
    : "Iris PR#22 验收讨论",
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
    ...(subjectLabel === null ? {} : { subjectLabel }),
  };
}
