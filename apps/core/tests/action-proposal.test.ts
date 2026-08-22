import { describe, expect, it } from "vitest";

import {
  ACTION_APPROVAL_REQUIREMENT_KINDS,
  ACTION_PROPOSAL_ACTION_TYPE,
  ACTION_PROPOSAL_ACTION_TYPES,
  ACTION_PROPOSAL_STATUSES,
  ACTION_ROLE_GRANT_TYPES,
  ActionProposalValidationError,
  buildApprovalRequirementSnapshot,
} from "../src/action-approvals/action-proposal.js";

describe("action proposal contracts", () => {
  it("publishes the bounded Phase 5B-2A enums", () => {
    expect(ACTION_PROPOSAL_ACTION_TYPE).toBe("publish_knowledge_draft");
    expect(ACTION_PROPOSAL_ACTION_TYPES).toEqual([
      "publish_knowledge_draft",
      "update_knowledge_publication",
      "create_feishu_task",
    ]);
    expect(ACTION_PROPOSAL_STATUSES).toEqual([
      "pending_approval",
      "approved",
      "executing",
      "succeeded",
      "failed",
      "cancelled",
      "expired",
      "reconciliation_required",
    ]);
    expect(ACTION_APPROVAL_REQUIREMENT_KINDS).toEqual([
      "group_confirmation",
      "designated_owner",
      "iris_admin_or_authorized_owner",
    ]);
    expect(ACTION_ROLE_GRANT_TYPES).toEqual([
      "iris_admin",
      "authorized_high_risk_owner",
    ]);
  });

  it("requires exactly the formal-task assignee and never invents an admin fallback", () => {
    expect(buildApprovalRequirementSnapshot({
      actionType: "create_feishu_task",
      sourceGroupId: "oc_group",
      riskLevel: "high",
      assigneeOpenId: " ou_assignee ",
      groupConfirmation: {
        actorOpenId: "ou_member",
        presentationId: "formal-task-presentation-1",
      },
      targetPolicy: { id: "task-policy-1", version: 4 },
    })).toEqual([{
      kind: "designated_owner",
      roleRefType: "feishu_user",
      roleRef: "ou_assignee",
      targetPolicyId: "task-policy-1",
      targetPolicyVersion: 4,
    }]);
  });

  it("auto-satisfies the only requirement for a low-risk group draft", () => {
    expect(buildApprovalRequirementSnapshot({
      sourceGroupId: " oc_group ",
      riskLevel: "low",
      reviewer: { type: "feishu_user", ref: "ou_owner" },
      groupConfirmation: {
        actorOpenId: " ou_member ",
        presentationId: " presentation-1 ",
      },
      targetPolicy: { id: " policy-1 ", version: 4 },
    })).toEqual([{
      kind: "group_confirmation",
      roleRefType: "source_group",
      roleRef: "oc_group",
      targetPolicyId: "policy-1",
      targetPolicyVersion: 4,
      satisfiedBy: {
        actorOpenId: "ou_member",
        sourceType: "group_confirmation",
        sourceId: "presentation-1",
      },
    }]);
  });

  it("requires an explicit OAuth-reviewable owner approval for a low-risk managed update", () => {
    expect(buildApprovalRequirementSnapshot({
      actionType: "update_knowledge_publication",
      sourceGroupId: "oc_group",
      riskLevel: "low",
      reviewer: { type: "feishu_user", ref: "ou_owner" },
      groupConfirmation: {
        actorOpenId: "ou_member",
        presentationId: "presentation-1",
      },
      targetPolicy: { id: "policy-1", version: 4 },
    }).map(({ kind, roleRefType, roleRef, satisfiedBy }) => ({
      kind,
      roleRefType,
      roleRef,
      satisfied: satisfiedBy !== undefined,
    }))).toEqual([
      {
        kind: "group_confirmation",
        roleRefType: "source_group",
        roleRef: "oc_group",
        satisfied: true,
      },
      {
        kind: "designated_owner",
        roleRefType: "feishu_user",
        roleRef: "ou_owner",
        satisfied: false,
      },
    ]);
  });

  it("builds the exact medium-risk requirement snapshot", () => {
    expect(buildApprovalRequirementSnapshot({
      sourceGroupId: "oc_group",
      riskLevel: "medium",
      reviewer: { type: "feishu_user", ref: "ou_owner" },
      groupConfirmation: {
        actorOpenId: "ou_member",
        presentationId: "presentation-1",
      },
      targetPolicy: { id: "policy-1", version: 4 },
    }).map(({ kind, roleRefType, roleRef, satisfiedBy }) => ({
      kind,
      roleRefType,
      roleRef,
      satisfied: satisfiedBy !== undefined,
    }))).toEqual([
      {
        kind: "group_confirmation",
        roleRefType: "source_group",
        roleRef: "oc_group",
        satisfied: true,
      },
      {
        kind: "designated_owner",
        roleRefType: "feishu_user",
        roleRef: "ou_owner",
        satisfied: false,
      },
    ]);
  });

  it("does not auto-approve a company-level low-risk draft", () => {
    expect(buildApprovalRequirementSnapshot({
      riskLevel: "low",
      reviewer: { type: "feishu_user", ref: "ou_owner" },
      targetPolicy: { id: "policy-1", version: 1 },
    })).toEqual([{
      kind: "designated_owner",
      roleRefType: "feishu_user",
      roleRef: "ou_owner",
      targetPolicyId: "policy-1",
      targetPolicyVersion: 1,
    }]);
  });

  it("keeps a high-risk requirement pending for an admin or authorized owner", () => {
    expect(buildApprovalRequirementSnapshot({
      sourceGroupId: "oc_group",
      riskLevel: "high",
      reviewer: { type: "feishu_user", ref: "ou_owner" },
      groupConfirmation: {
        actorOpenId: "ou_member",
        presentationId: "presentation-1",
      },
      targetPolicy: { id: "policy-1", version: 7 },
    }).at(-1)).toEqual({
      kind: "iris_admin_or_authorized_owner",
      roleRefType: "feishu_user",
      roleRef: "ou_owner",
      targetPolicyId: "policy-1",
      targetPolicyVersion: 7,
    });
  });

  it("keeps unverifiable medium reviewers pending without inventing an actor", () => {
    expect(buildApprovalRequirementSnapshot({
      sourceGroupId: "oc_group",
      riskLevel: "medium",
      reviewer: { type: "text_label", ref: "Product owner" },
      groupConfirmation: {
        actorOpenId: "ou_member",
        presentationId: "presentation-1",
      },
      targetPolicy: { id: "policy-1", version: 1 },
    }).at(-1)).toEqual({
      kind: "designated_owner",
      roleRefType: "unassigned",
      targetPolicyId: "policy-1",
      targetPolicyVersion: 1,
    });
  });

  it.each([
    ["group draft without confirmation", {
      sourceGroupId: "oc_group",
      riskLevel: "low",
      targetPolicy: { id: "policy-1", version: 1 },
    }],
    ["invalid policy version", {
      riskLevel: "low",
      reviewer: { type: "feishu_user", ref: "ou_owner" },
      targetPolicy: { id: "policy-1", version: 0 },
    }],
    ["unknown field", {
      riskLevel: "low",
      reviewer: { type: "feishu_user", ref: "ou_owner" },
      targetPolicy: { id: "policy-1", version: 1 },
      content: "must not enter the snapshot",
    }],
  ])("rejects %s", (_label, input) => {
    expect(() => buildApprovalRequirementSnapshot(input as never))
      .toThrow(ActionProposalValidationError);
  });
});
