import { describe, expect, it } from "vitest";

import {
  FeishuTaskResultCardBindingError,
  renderFeishuTaskResultCard,
} from "../src/formal-tasks/feishu-task-result-card.js";

describe("Feishu task result card", () => {
  it("renders one bounded source-group success card from the immutable creation fact", () => {
    const rendered = renderFeishuTaskResultCard(context);

    expect(rendered.componentCount).toBe(1);
    expect(Buffer.byteLength(rendered.json, "utf8")).toBeLessThanOrEqual(30_000);
    expect(rendered.card).toMatchObject({
      schema: "2.0",
      header: {
        template: "green",
        title: { tag: "plain_text", content: "Formal task created" },
      },
    });
    expect(rendered.json).toContain("Archive pilot evidence");
    expect(rendered.json).toContain("<at id=ou_assignee></at>");
    expect(rendered.json).toContain("2026-08-24T06:00:00.123Z");
    expect(rendered.json).toContain("30 minutes before due time");
    expect(rendered.json).toContain(context.creation.remoteTaskUrl);
    expect(rendered.json).toContain("aaaaaaaaaaaa");
  });

  it("renders explicit none values when due time and reminder were omitted", () => {
    const rendered = renderFeishuTaskResultCard({
      ...context,
      creation: { ...context.creation, dueAt: undefined, reminderMinutes: undefined },
    });
    expect(rendered.json).toContain("Due: none");
    expect(rendered.json).toContain("Reminder: none");
  });

  it("rejects a presentation that is not bound to the exact creation and group", () => {
    expect(() => renderFeishuTaskResultCard({
      ...context,
      presentation: { ...context.presentation, creationId: "creation-other" },
    })).toThrow(FeishuTaskResultCardBindingError);
    expect(() => renderFeishuTaskResultCard({
      ...context,
      presentation: { ...context.presentation, groupId: "oc_other" },
    })).toThrow(FeishuTaskResultCardBindingError);
  });

  it("rejects non-Feishu task links and control characters", () => {
    expect(() => renderFeishuTaskResultCard({
      ...context,
      creation: { ...context.creation, remoteTaskUrl: "https://evil.example/task" },
    })).toThrow(/URL/iu);
    expect(() => renderFeishuTaskResultCard({
      ...context,
      creation: { ...context.creation, title: "unsafe\u0000title" },
    })).toThrow(/title/iu);
  });
});

const context = {
  presentation: {
    id: "result-presentation-1",
    creationId: "creation-1",
    proposalId: "proposal-1",
    groupId: "oc_pilot",
    state: "pending_send" as const,
    version: 1,
    createdAt: new Date("2026-08-22T12:00:02.000Z"),
  },
  creation: {
    id: "creation-1",
    proposalId: "proposal-1",
    executionId: "execution-1",
    draftId: "draft-1",
    draftRevision: 1,
    draftVersion: 2,
    sourceGroupId: "oc_pilot",
    title: "Archive pilot evidence",
    assigneeOpenId: "ou_assignee",
    dueAt: new Date("2026-08-24T06:00:00.123Z"),
    reminderMinutes: 30 as const,
    remoteTaskGuid: "task-guid-1",
    remoteTaskId: "t123456",
    remoteTaskUrl: "https://applink.feishu.cn/client/todo/detail?guid=task-guid-1",
    taskSpecHash: "a".repeat(64),
    completedAt: new Date("2026-08-22T12:00:02.000Z"),
  },
};
