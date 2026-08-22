import { describe, expect, it } from "vitest";

import {
  canonicalFormalTaskSpec,
  canonicalFormalTaskSpecHash,
  normalizeFormalTaskDraft,
  normalizeFormalTaskSpec,
} from "../src/formal-tasks/formal-task-draft.js";

const validSpec = {
  title: " Follow up on the pilot ",
  description: " Confirm the evidence.\r\nPublish the result. ",
  assigneeOpenId: " ou_assignee ",
  dueAt: new Date("2026-08-25T09:30:00.123Z"),
  reminderMinutes: 30,
  sourceGroupId: " group-pilot ",
  targetPolicyId: " task-policy-1 ",
  targetPolicyVersion: 2,
} as const;

describe("formal task draft domain", () => {
  it("canonicalizes the exact reviewed and executed task specification", () => {
    expect(canonicalFormalTaskSpec(validSpec)).toBe(
      '{"title":"Follow up on the pilot","description":"Confirm the evidence.\\nPublish the result.","assigneeOpenId":"ou_assignee","dueAtUtc":"2026-08-25T09:30:00.123Z","reminderMinutes":30,"sourceGroupId":"group-pilot","targetPolicyId":"task-policy-1","targetPolicyVersion":2}',
    );
    expect(canonicalFormalTaskSpecHash(validSpec)).toBe(
      "7bf7f75e8b22a4b51363886dc7469833d323802d8e6d8a007a178a7ef96d6516",
    );
  });

  it("omits due and reminder together when the approved draft has no due time", () => {
    const normalized = normalizeFormalTaskSpec({
      ...validSpec,
      dueAt: undefined,
      reminderMinutes: undefined,
    });

    expect(normalized).not.toHaveProperty("dueAtUtc");
    expect(normalized).not.toHaveProperty("reminderMinutes");
    expect(canonicalFormalTaskSpec(normalized)).toContain('"assigneeOpenId":"ou_assignee"');
  });

  it.each([
    [{ ...validSpec, reminderMinutes: 15 }, /reminderMinutes/u],
    [{ ...validSpec, dueAt: undefined }, /reminderMinutes requires dueAt/u],
    [{ ...validSpec, dueAt: new Date("invalid") }, /dueAt/u],
    [{ ...validSpec, title: "bad\nline" }, /title/u],
    [{ ...validSpec, description: "bad\u0000text" }, /description/u],
    [{ ...validSpec, unexpected: true }, /unknown field/u],
  ])("rejects a task specification outside the exact boundary", (input, pattern) => {
    expect(() => normalizeFormalTaskSpec(input)).toThrow(pattern);
  });

  it("rejects a current draft whose revision or content hash is not exact", () => {
    const draft = {
      id: "formal-task-1",
      sourceGroupId: "group-pilot",
      status: "pending_confirmation",
      currentRevisionNumber: 1,
      version: 1,
      createdBy: "ou_requester",
      currentTaskSpecHash: "a".repeat(64),
      createdAt: new Date("2026-08-22T00:00:00.000Z"),
      updatedAt: new Date("2026-08-22T00:00:00.000Z"),
    } as const;

    expect(normalizeFormalTaskDraft(draft)).toMatchObject(draft);
    expect(() => normalizeFormalTaskDraft({
      ...draft,
      currentRevisionNumber: 0,
    })).toThrow(/currentRevisionNumber/u);
    expect(() => normalizeFormalTaskDraft({
      ...draft,
      currentTaskSpecHash: "not-a-hash",
    })).toThrow(/currentTaskSpecHash/u);
  });
});
