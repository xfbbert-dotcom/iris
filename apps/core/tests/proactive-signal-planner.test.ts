import { describe, expect, it } from "vitest";

import { planProactiveSignals } from "../src/proactive-signals/proactive-signal-planner.js";

describe("proactive signal planner", () => {
  it("surfaces quiet open threads and overdue actions without selecting resolved work", () => {
    const now = new Date("2026-07-23T10:00:00.000Z");

    const signals = planProactiveSignals({
      groupId: "group-a",
      now,
      quietThreadAfterMs: 60 * 60 * 1000,
      overdueActionGraceMs: 5 * 60 * 1000,
      threads: [
        thread({
          id: "thread-quiet",
          status: "open",
          lastActivityAt: new Date("2026-07-23T08:30:00.000Z"),
        }),
        thread({
          id: "thread-recent",
          status: "open",
          lastActivityAt: new Date("2026-07-23T09:30:00.000Z"),
        }),
        thread({
          id: "thread-resolved",
          status: "resolved",
          lastActivityAt: new Date("2026-07-23T07:00:00.000Z"),
        }),
      ],
      actions: [
        action({
          id: "action-overdue",
          dueAt: new Date("2026-07-23T09:45:00.000Z"),
        }),
        action({
          id: "action-not-due",
          dueAt: new Date("2026-07-23T10:10:00.000Z"),
        }),
      ],
      limit: 10,
    });

    expect(signals.map((signal) => [signal.kind, signal.entityId])).toEqual([
      ["overdue_action", "action-overdue"],
      ["quiet_open_thread", "thread-quiet"],
    ]);
    expect(signals[0]).toMatchObject({
      groupId: "group-a",
      priority: "high",
      reasonCode: "action_due_at_elapsed",
      suggestedMode: "ask_for_status",
      evidenceMessageIds: ["message-action-overdue"],
    });
    expect(JSON.stringify(signals)).not.toContain("thread-resolved");
  });

  it("dedupes already surfaced entity versions and respects the bounded limit", () => {
    const signals = planProactiveSignals({
      groupId: "group-a",
      now: new Date("2026-07-23T10:00:00.000Z"),
      quietThreadAfterMs: 1,
      overdueActionGraceMs: 0,
      alreadySurfacedKeys: new Set(["quiet_open_thread:thread-a:1"]),
      threads: [
        thread({ id: "thread-a", version: 1 }),
        thread({ id: "thread-b", version: 2 }),
      ],
      actions: [
        action({ id: "action-a", dueAt: new Date("2026-07-23T09:00:00.000Z") }),
      ],
      limit: 1,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "overdue_action",
      entityId: "action-a",
      idempotencyKey: "overdue_action:action-a:1",
    });
  });
});

function thread(overrides: Partial<Parameters<typeof planProactiveSignals>[0]["threads"][number]> = {}) {
  return {
    id: "thread-a",
    groupId: "group-a",
    title: "Launch decision",
    summary: "Waiting for someone to choose the launch path.",
    status: "open" as const,
    confidence: 0.9,
    version: 1,
    firstEvidenceAt: new Date("2026-07-23T07:00:00.000Z"),
    lastActivityAt: new Date("2026-07-23T07:00:00.000Z"),
    createdAt: new Date("2026-07-23T07:00:00.000Z"),
    updatedAt: new Date("2026-07-23T07:00:00.000Z"),
    evidenceMessageIds: [`message-${overrides.id ?? "thread-a"}`],
    ...overrides,
  };
}

function action(overrides: Partial<Parameters<typeof planProactiveSignals>[0]["actions"][number]> = {}) {
  return {
    id: "action-a",
    groupId: "group-a",
    description: "Alice confirms the launch window.",
    ownerRefType: "text_label" as const,
    ownerRef: "Alice",
    status: "open" as const,
    confidence: 0.9,
    version: 1,
    createdAt: new Date("2026-07-23T07:00:00.000Z"),
    updatedAt: new Date("2026-07-23T07:00:00.000Z"),
    evidenceMessageIds: [`message-${overrides.id ?? "action-a"}`],
    ...overrides,
  };
}
