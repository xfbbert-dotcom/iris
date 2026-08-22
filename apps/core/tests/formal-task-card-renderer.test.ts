import { describe, expect, it } from "vitest";

import type { FormalTaskDraftView } from
  "../src/formal-tasks/formal-task-repository.js";
import {
  FormalTaskCardPresentationBindingError,
  renderFormalTaskCardCommittedResult,
  renderFormalTaskDraftCard,
} from "../src/formal-tasks/formal-task-card-renderer.js";
import type {
  FormalTaskCardCommittedResult,
  FormalTaskDraftPresentation,
} from "../src/formal-tasks/formal-task-card-repository.js";

describe("formal task confirmation card renderer", () => {
  it("renders bounded task details and exact callback bindings", () => {
    const rendered = renderFormalTaskDraftCard({
      draft: draft(),
      presentation: presentation(),
      targetDisplayName: "Pilot task policy",
    });

    expect(rendered.status).toBe("rendered");
    if (rendered.status !== "rendered") throw new Error("expected rendered card");
    expect(rendered.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(rendered.json).toContain("Prepare acceptance report");
    expect(rendered.json).toContain("Collect the governed pilot evidence.");
    expect(rendered.json).toContain("<at id=ou_assignee></at>");
    expect(rendered.json).toContain("2026-08-24T09:30:00.000Z");
    expect(rendered.json).toContain("30 minutes before due time");
    expect(rendered.json).toContain("Evidence items: 2");
    expect(rendered.json).toContain("Risk: high");
    expect(rendered.json).toContain("Task-spec fingerprint: 0123456789ab");

    const body = rendered.card.body as { elements: Array<Record<string, unknown>> };
    const form = body.elements.find((element) => element.tag === "form") as {
      elements: Array<{ name: string; behaviors?: Array<{ value: Record<string, string> }> }>;
    };
    expect(form.elements.filter((element) => element.behaviors !== undefined).map((element) => ({
      name: element.name,
      value: element.behaviors?.[0]?.value,
    }))).toEqual([
      {
        name: "confirm",
        value: {
          kind: "formal_task_draft_confirmation",
          action: "confirm",
          presentationId: "task-presentation-1",
          draftId: "task-draft-1",
          revisionNumber: "1",
          draftVersion: "1",
          taskSpecHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          targetPolicyId: "task-policy-1",
          targetPolicyVersion: "3",
        },
      },
      expect.objectContaining({ name: "request_revision" }),
      expect.objectContaining({ name: "reject" }),
    ]);
  });

  it("shows an explicit absent due/reminder pair", () => {
    const withoutDue = draft();
    if (!("taskSpec" in withoutDue.currentRevision)) throw new Error("expected current revision");
    delete withoutDue.currentRevision.taskSpec.dueAtUtc;
    delete withoutDue.currentRevision.taskSpec.reminderMinutes;

    const rendered = renderFormalTaskDraftCard({
      draft: withoutDue,
      presentation: presentation(),
      targetDisplayName: "Pilot task policy",
    });

    expect(rendered.status).toBe("rendered");
    if (rendered.status !== "rendered") throw new Error("expected rendered card");
    expect(rendered.json).toContain("Due: none");
    expect(rendered.json).toContain("Reminder: none");
  });

  it("fails closed when presentation, revision, hash, or policy binding differs", () => {
    for (const mismatch of [
      { draftId: "other-draft" },
      { draftRevision: 2 },
      { draftVersion: 2 },
      { taskSpecHash: "f".repeat(64) },
    ] satisfies Array<Partial<FormalTaskDraftPresentation>>) {
      expect(() => renderFormalTaskDraftCard({
        draft: draft(),
        presentation: presentation(mismatch),
        targetDisplayName: "Pilot task policy",
      })).toThrow(FormalTaskCardPresentationBindingError);
    }
  });

  it.each([
    [
      { action: "confirm", actorOpenId: "ou_member", confirmedAt: new Date("2026-08-22T06:10:00.000Z"), nextGate: "pending_review" },
      "Formal task draft confirmed",
      "Result: confirmed",
    ],
    [
      { action: "request_revision", state: "needs_revision", reason: "Clarify the due time." },
      "Formal task draft revision requested",
      "Clarify the due time.",
    ],
    [
      { action: "reject", state: "rejected", reason: "This task is no longer required." },
      "Formal task draft rejected",
      "This task is no longer required.",
    ],
  ] as Array<[FormalTaskCardCommittedResult, string, string]>)(
    "renders a bounded closed-card result for %s",
    (result, title, marker) => {
      const json = renderFormalTaskCardCommittedResult({
        draft: draft({ status: result.action === "confirm" ? "pending_review" : result.state }),
        presentation: presentation({
          state: "closed",
          messageId: "om_task_card",
          closedAt: new Date("2026-08-22T06:10:00.000Z"),
        }),
        result,
      });

      expect(json).toContain(title);
      expect(json).toContain(marker);
    },
  );
});

function draft(overrides: Partial<FormalTaskDraftView> = {}): FormalTaskDraftView {
  return {
    id: "task-draft-1",
    sourceGroupId: "oc_pilot",
    status: "pending_confirmation",
    currentRevisionNumber: 1,
    version: 1,
    createdBy: "iris",
    currentTaskSpecHash:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    createdAt: new Date("2026-08-22T06:00:00.000Z"),
    updatedAt: new Date("2026-08-22T06:00:00.000Z"),
    currentRevision: {
      revisionNumber: 1,
      riskLevel: "high",
      author: "iris",
      taskSpecHash:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      createdAt: new Date("2026-08-22T06:00:00.000Z"),
      evidenceState: { status: "current" },
      taskSpec: {
        title: "Prepare acceptance report",
        description: "Collect the governed pilot evidence.",
        assigneeOpenId: "ou_assignee",
        dueAtUtc: "2026-08-24T09:30:00.000Z",
        reminderMinutes: 30,
        sourceGroupId: "oc_pilot",
        targetPolicyId: "task-policy-1",
        targetPolicyVersion: 3,
      },
      evidence: [
        { type: "conversation_message", id: "feishu:om_1" },
        { type: "conversation_message", id: "feishu:om_2" },
      ],
    },
    ...overrides,
  };
}

function presentation(
  overrides: Partial<FormalTaskDraftPresentation> = {},
): FormalTaskDraftPresentation {
  return {
    id: "task-presentation-1",
    draftId: "task-draft-1",
    draftRevision: 1,
    draftVersion: 1,
    taskSpecHash:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    groupId: "oc_pilot",
    state: "pending_send",
    createdAt: new Date("2026-08-22T06:00:00.000Z"),
    version: 1,
    ...overrides,
  };
}
