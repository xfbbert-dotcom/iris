import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { FormalTaskDraftView } from
  "../src/formal-tasks/formal-task-repository.js";
import type {
  FormalTaskCardRepository,
  FormalTaskDraftPresentation,
} from "../src/formal-tasks/formal-task-card-repository.js";
import {
  FormalTaskDraftPresentationServiceError,
  presentFormalTaskDraft,
} from "../src/formal-tasks/formal-task-draft-presentation-service.js";

const at = new Date("2026-08-22T06:00:00.000Z");

describe("presentFormalTaskDraft", () => {
  it("creates one deterministic pending presentation for the exact current task revision", async () => {
    const harness = serviceHarness();

    await expect(presentFormalTaskDraft({
      runtime: harness.runtime,
      draftId: "task-draft-1",
      expectedVersion: 1,
      operationKey: "task-card:create:1",
      at,
    })).resolves.toMatchObject({
      outcome: "applied",
      presentation: {
        id: expect.stringMatching(/^formal-task-card-[a-f0-9]{40}$/u),
        draftId: "task-draft-1",
        draftRevision: 1,
        draftVersion: 1,
        taskSpecHash: "a".repeat(64),
        groupId: "oc_pilot",
        state: "pending_send",
      },
    });
    expect(harness.cardRepository.createPresentation).toHaveBeenCalledWith({
      id: expect.stringMatching(/^formal-task-card-[a-f0-9]{40}$/u),
      draftId: "task-draft-1",
      expectedDraftVersion: 1,
      expectedDraftRevision: 1,
      taskSpecHash: "a".repeat(64),
      groupId: "oc_pilot",
      operationKey: "task-card:create:1",
      at,
    });
  });

  it("returns an exact replay without creating another outbox fact", async () => {
    const existing = presentation();
    const harness = serviceHarness({ existing });

    await expect(presentFormalTaskDraft({
      runtime: harness.runtime,
      draftId: "task-draft-1",
      expectedVersion: 1,
      operationKey: "task-card:create:1",
      at,
    })).resolves.toEqual({ outcome: "already_applied", presentation: existing });
    expect(harness.cardRepository.createPresentation).not.toHaveBeenCalled();
  });

  it.each([
    ["runtime disabled", { canUse: false }, "iris_runtime_disabled"],
    ["stale draft version", { draft: taskDraft({ version: 2 }) }, "formal_task_card_conflict"],
    ["invalid evidence", { draft: invalidatedDraft() }, "formal_task_evidence_invalid"],
    ["disabled policy", { policy: { enabled: false } }, "formal_task_policy_unavailable"],
    ["changed policy version", { policy: { version: 4 } }, "formal_task_policy_unavailable"],
  ] as const)("fails closed for %s", async (_label, overrides, code) => {
    const harness = serviceHarness(overrides);

    const error = await presentFormalTaskDraft({
      runtime: harness.runtime,
      draftId: "task-draft-1",
      expectedVersion: 1,
      operationKey: "task-card:create:1",
      at,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(FormalTaskDraftPresentationServiceError);
    expect((error as FormalTaskDraftPresentationServiceError).code).toBe(code);
    expect(harness.cardRepository.createPresentation).not.toHaveBeenCalled();
  });
});

function serviceHarness(overrides: {
  canUse?: boolean;
  draft?: FormalTaskDraftView;
  policy?: { enabled?: boolean; version?: number };
  existing?: FormalTaskDraftPresentation;
} = {}) {
  const draft = overrides.draft ?? taskDraft();
  const existing = overrides.existing;
  const cardRepository = {
    getPresentation: vi.fn(async () => existing),
    createPresentation: vi.fn(async (input) => ({
      outcome: "applied" as const,
      presentation: presentation({ id: input.id }),
      draft,
    })),
  } as unknown as FormalTaskCardRepository;
  const taskRepository = {
    getDraft: vi.fn(async () => draft),
    getTargetPolicy: vi.fn(async () => ({
      id: "task-policy-1",
      sourceGroupId: "oc_pilot",
      displayName: "Pilot task policy",
      allowedAssigneeOpenIds: ["ou_assignee"],
      maxDueHorizonDays: 30,
      enabled: overrides.policy?.enabled ?? true,
      version: overrides.policy?.version ?? 3,
      createdAt: at,
      updatedAt: at,
    })),
  };
  return {
    cardRepository,
    runtime: {
      repository: taskRepository,
      cardRepository,
      canUseFormalTaskCards: () => overrides.canUse ?? true,
    },
  };
}

function taskDraft(overrides: Partial<FormalTaskDraftView> = {}): FormalTaskDraftView {
  return {
    id: "task-draft-1",
    sourceGroupId: "oc_pilot",
    status: "pending_confirmation",
    currentRevisionNumber: 1,
    version: 1,
    createdBy: "iris",
    currentTaskSpecHash: "a".repeat(64),
    createdAt: at,
    updatedAt: at,
    currentRevision: {
      revisionNumber: 1,
      riskLevel: "high",
      author: "iris",
      taskSpecHash: "a".repeat(64),
      createdAt: at,
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
      evidence: [{ type: "conversation_message", id: "feishu:om_1" }],
    },
    ...overrides,
  };
}

function invalidatedDraft(): FormalTaskDraftView {
  return taskDraft({
    currentRevision: {
      revisionNumber: 1,
      riskLevel: "high",
      author: "iris",
      taskSpecHash: "a".repeat(64),
      createdAt: at,
      evidenceState: { status: "invalidated", reason: "message_deleted" },
    },
  });
}

function presentation(
  overrides: Partial<FormalTaskDraftPresentation> = {},
): FormalTaskDraftPresentation {
  return {
    id: `formal-task-card-${createHash("sha256").update(JSON.stringify({
      draftId: "task-draft-1",
      draftRevision: 1,
      operationKey: "task-card:create:1",
    })).digest("hex").slice(0, 40)}`,
    draftId: "task-draft-1",
    draftRevision: 1,
    draftVersion: 1,
    taskSpecHash: "a".repeat(64),
    groupId: "oc_pilot",
    state: "pending_send",
    createdAt: at,
    version: 1,
    ...overrides,
  };
}
