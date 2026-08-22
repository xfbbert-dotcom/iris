import { describe, expect, it } from "vitest";

import {
  ActionApprovalCardBindingError,
  renderActionApprovalCard,
} from "../src/action-approvals/action-approval-card-renderer.js";
import type {
  ActionApprovalPresentation,
  ActionApprovalRequirement,
  ActionProposalContext,
  PublicationTargetPolicy,
} from "../src/action-approvals/action-proposal-repository.js";
import type { FeishuTaskTargetPolicy } from "../src/formal-tasks/formal-task-repository.js";

describe("renderActionApprovalCard", () => {
  it("renders a bounded, version-bound approval card without draft content", () => {
    const rendered = renderActionApprovalCard(input());
    const body = rendered.card.body as { elements: Array<Record<string, unknown>> };

    expect(rendered.card).toMatchObject({
      schema: "2.0",
      header: {
        template: "orange",
        title: { tag: "plain_text", content: "Approve knowledge publication" },
      },
    });
    expect(rendered.json).toContain("Risk: medium");
    expect(rendered.json).toContain("Publish new Wiki page");
    expect(rendered.json).toContain("Target: Company Wiki");
    expect(rendered.json).toContain("Draft revision: 2");
    expect(rendered.json).toContain("group_confirmation: satisfied");
    expect(rendered.json).toContain("designated_owner: pending");
    expect(rendered.json).not.toMatch(/full draft body|secret evidence|oc_group|ou_owner/iu);
    expect(Buffer.byteLength(rendered.json, "utf8")).toBeLessThanOrEqual(24 * 1024);
    expect(rendered.componentCount).toBeLessThanOrEqual(100);

    expect(buttonCallbackValues(body.elements)).toEqual([
      callbackValue("approve"),
      callbackValue("request_revision"),
      callbackValue("reject"),
    ]);
    const form = body.elements.find((element) => element.tag === "form");
    if (!form || !Array.isArray(form.elements)) throw new Error("expected approval form");
    expect(form.elements.find((element) => isRecord(element) && element.tag === "input"))
      .toMatchObject({
        name: "reason",
        input_type: "multiline_text",
        max_length: 1_000,
        required: false,
      });
    expect(form.elements.find((element) => isRecord(element) && element.name === "reject"))
      .toMatchObject({
        confirm: {
          title: { tag: "plain_text", content: "Reject publication" },
        },
      });
  });

  it("shows safe managed-page metadata and replacement intent without hashes or draft text", () => {
    const rendered = renderActionApprovalCard(input({
      actionType: "update_knowledge_publication",
      managedTarget: {
        managedPageId: "managed-1",
        documentSourceId: "source-1",
        targetSourceUri: "https://example.test/wiki/managed-1",
      },
    }));

    expect(rendered.json).toContain("Replace the single managed body block on existing Wiki page");
    expect(rendered.json).toContain("Managed page ID: managed-1");
    expect(rendered.json).toContain("https://example.test/wiki/managed-1");
    expect(rendered.json).not.toMatch(/[a-f0-9]{64}/u);
    expect(rendered.json).not.toMatch(/full draft body|secret evidence/iu);
  });

  it("adds the authenticated review link only when a public review origin is configured", () => {
    const withoutOrigin = renderActionApprovalCard(input());
    const withOrigin = renderActionApprovalCard(input({
      reviewPublicOrigin: "https://iris.quello.cn/",
    }));

    expect(withoutOrigin.json).not.toContain("View full draft");
    expect(withOrigin.json).toContain("View full draft");
    expect(withOrigin.json).toContain(
      "https://iris.quello.cn/review/action-proposals/proposal-1",
    );
  });

  it("renders a bounded exact-assignee Feishu-task approval card", () => {
    const rendered = renderActionApprovalCard(taskInput() as never);

    expect(rendered.card).toMatchObject({
      header: { title: { content: "Approve Feishu task" } },
    });
    expect(rendered.json).toContain("Create one Feishu task");
    expect(rendered.json).toContain("Task title: Complete governed pilot");
    expect(rendered.json).toContain("Assignee: ou_assignee");
    expect(rendered.json).toContain("Due: 2026-08-24T06:00:00.000Z");
    expect(rendered.json).toContain("Reminder: 30 minutes");
    expect(rendered.json).toContain("Target: Pilot tasks");
    expect(rendered.json).toContain("View full task");
    expect(rendered.json).not.toContain("full task description must stay on OAuth review");
  });

  it.each([
    ["proposal version", { presentation: { proposalVersion: 3 } }],
    ["requirement", { presentation: { requirementId: "requirement-other" } }],
    ["recipient", { presentation: { recipientOpenId: "ou_other" } }],
    ["policy version", { policy: { version: 4 } }],
    ["non-pending requirement", { requirement: { state: "satisfied" } }],
  ] as const)("fails closed on a mismatched %s binding", (_label, overrides) => {
    expect(() => renderActionApprovalCard(input(overrides as InputOverrides)))
      .toThrow(ActionApprovalCardBindingError);
  });
});

type InputOverrides = {
  actionType?: "publish_knowledge_draft" | "update_knowledge_publication";
  managedTarget?: ActionProposalContext["managedTarget"];
  presentation?: Partial<ActionApprovalPresentation>;
  requirement?: Partial<ActionApprovalRequirement>;
  policy?: Partial<PublicationTargetPolicy>;
  reviewPublicOrigin?: string;
};

function input(overrides: InputOverrides = {}) {
  const at = new Date("2026-07-20T00:00:00.000Z");
  const requirement: ActionApprovalRequirement = {
    id: "requirement-1",
    proposalId: "proposal-1",
    kind: "designated_owner",
    roleRefType: "feishu_user",
    roleRef: "ou_owner",
    targetPolicyId: "policy-1",
    targetPolicyVersion: 3,
    state: "pending",
    version: 1,
    createdAt: at,
    updatedAt: at,
    ...overrides.requirement,
  };
  const context: ActionProposalContext = {
    proposal: {
      id: "proposal-1",
      actionType: overrides.actionType ?? "publish_knowledge_draft",
      subjectType: "knowledge_draft",
      subjectId: "draft-1",
      subjectRevision: 2,
      subjectVersion: 7,
      targetPolicyId: "policy-1",
      targetPolicyVersion: 3,
      riskLevel: "medium",
      status: "pending_approval",
      operationKey: "publish-knowledge:draft-1:2:3",
      version: 4,
      createdAt: at,
      updatedAt: at,
    },
    requirements: [
      {
        id: "requirement-group",
        proposalId: "proposal-1",
        kind: "group_confirmation",
        roleRefType: "source_group",
        roleRef: "oc_group",
        targetPolicyId: "policy-1",
        targetPolicyVersion: 3,
        state: "satisfied",
        satisfiedActorOpenId: "ou_member",
        satisfiedSourceType: "group_confirmation",
        satisfiedSourceId: "group-presentation-1",
        version: 1,
        createdAt: at,
        updatedAt: at,
      },
      requirement,
    ],
    approvals: [],
    ...(overrides.managedTarget === undefined ? {} : { managedTarget: overrides.managedTarget }),
  };
  const policy: PublicationTargetPolicy = {
    id: "policy-1",
    spaceId: "space-1",
    displayName: "Company Wiki",
    allowedGroupIds: ["oc_group"],
    allowedRiskLevels: ["low", "medium", "high"],
    enabled: true,
    version: 3,
    createdAt: at,
    updatedAt: at,
    ...overrides.policy,
  };
  const presentation: ActionApprovalPresentation = {
    id: "proposal-presentation-1",
    proposalId: "proposal-1",
    requirementId: "requirement-1",
    proposalVersion: 4,
    recipientOpenId: "ou_owner",
    state: "pending_send",
    operationKey: "action-presentation:proposal-1:requirement-1:ou_owner:4",
    version: 1,
    createdAt: at,
    ...overrides.presentation,
  };
  return {
    context,
    requirement,
    policy,
    presentation,
    ...(overrides.reviewPublicOrigin === undefined
      ? {}
      : { reviewPublicOrigin: overrides.reviewPublicOrigin }),
  };
}

function taskInput() {
  const at = new Date("2026-08-22T00:00:00.000Z");
  const requirement: ActionApprovalRequirement = {
    id: "task-requirement-1",
    proposalId: "task-proposal-1",
    kind: "designated_owner",
    roleRefType: "feishu_user",
    roleRef: "ou_assignee",
    targetPolicyId: "task-policy-1",
    targetPolicyVersion: 3,
    state: "pending",
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  const policy: FeishuTaskTargetPolicy = {
    id: "task-policy-1",
    sourceGroupId: "oc_pilot",
    displayName: "Pilot tasks",
    allowedAssigneeOpenIds: ["ou_assignee"],
    maxDueHorizonDays: 30,
    enabled: true,
    version: 3,
    createdAt: at,
    updatedAt: at,
  };
  return {
    context: {
      proposal: {
        id: "task-proposal-1",
        actionType: "create_feishu_task",
        subjectType: "formal_task_draft",
        subjectId: "formal-task-1",
        subjectRevision: 2,
        subjectVersion: 4,
        targetPolicyId: policy.id,
        targetPolicyVersion: policy.version,
        riskLevel: "high",
        status: "pending_approval",
        operationKey: "create-feishu-task:formal-task-1:2:3",
        version: 1,
        createdAt: at,
        updatedAt: at,
      },
      requirements: [requirement],
      approvals: [],
      formalTask: {
        sourceGroupId: "oc_pilot",
        title: "Complete governed pilot",
        description: "full task description must stay on OAuth review",
        assigneeOpenId: "ou_assignee",
        dueAt: new Date("2026-08-24T06:00:00.000Z"),
        reminderMinutes: 30,
        taskSpecHash: "a".repeat(64),
        groupConfirmationPresentationId: "task-confirmation-1",
      },
    },
    requirement,
    policy,
    presentation: {
      id: "task-approval-presentation-1",
      proposalId: "task-proposal-1",
      requirementId: requirement.id,
      proposalVersion: 1,
      recipientOpenId: "ou_assignee",
      state: "pending_send",
      operationKey: "task-approval-presentation",
      version: 1,
      createdAt: at,
    },
    reviewPublicOrigin: "https://iris.quello.cn/",
  };
}

function callbackValue(action: "approve" | "request_revision" | "reject") {
  return {
    kind: "action_proposal_approval",
    action,
    presentationId: "proposal-presentation-1",
    proposalId: "proposal-1",
    requirementId: "requirement-1",
    proposalVersion: "4",
    subjectRevision: "2",
    subjectVersion: "7",
    targetPolicyVersion: "3",
  };
}

function buttonCallbackValues(elements: Array<Record<string, unknown>>): unknown[] {
  const form = elements.find((element) => element.tag === "form");
  if (!form || !Array.isArray(form.elements)) throw new Error("expected approval form");
  return form.elements.flatMap((element) => {
    if (!isRecord(element) || element.tag !== "button" || !Array.isArray(element.behaviors)) {
      return [];
    }
    const behavior = element.behaviors[0];
    return isRecord(behavior) ? [behavior.value] : [];
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
