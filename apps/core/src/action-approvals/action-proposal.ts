import type {
  KnowledgeDraftReviewer,
  KnowledgeDraftRiskLevel,
} from "../knowledge-governance/knowledge-draft.js";
import { KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS } from "../knowledge-governance/knowledge-draft.js";

export const ACTION_PROPOSAL_ACTION_TYPE = "publish_knowledge_draft" as const;
export const ACTION_PROPOSAL_STATUSES = [
  "pending_approval",
  "approved",
  "executing",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "reconciliation_required",
] as const;
export const ACTION_APPROVAL_REQUIREMENT_KINDS = [
  "group_confirmation",
  "designated_owner",
  "iris_admin_or_authorized_owner",
] as const;
export const ACTION_ROLE_GRANT_TYPES = [
  "iris_admin",
  "authorized_high_risk_owner",
] as const;

export type ActionProposalStatus = (typeof ACTION_PROPOSAL_STATUSES)[number];
export type ActionApprovalRequirementKind =
  (typeof ACTION_APPROVAL_REQUIREMENT_KINDS)[number];
export type ActionRoleGrantType = (typeof ACTION_ROLE_GRANT_TYPES)[number];
export type ActionApprovalRoleRefType = "source_group" | "feishu_user" | "unassigned";

export type ActionProposal = {
  id: string;
  actionType: typeof ACTION_PROPOSAL_ACTION_TYPE;
  subjectType: "knowledge_draft";
  subjectId: string;
  subjectRevision: number;
  subjectVersion: number;
  targetPolicyId: string;
  targetPolicyVersion: number;
  riskLevel: KnowledgeDraftRiskLevel;
  status: ActionProposalStatus;
  operationKey: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ActionApprovalRequirementSnapshot = {
  kind: ActionApprovalRequirementKind;
  roleRefType: ActionApprovalRoleRefType;
  roleRef?: string;
  targetPolicyId: string;
  targetPolicyVersion: number;
  satisfiedBy?: {
    actorOpenId: string;
    sourceType: "group_confirmation";
    sourceId: string;
  };
};

export type BuildApprovalRequirementSnapshotInput = {
  sourceGroupId?: string;
  riskLevel: KnowledgeDraftRiskLevel;
  reviewer?: KnowledgeDraftReviewer;
  groupConfirmation?: {
    actorOpenId: string;
    presentationId: string;
  };
  targetPolicy: {
    id: string;
    version: number;
  };
};

export class ActionProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionProposalValidationError";
  }
}

export function buildApprovalRequirementSnapshot(
  input: BuildApprovalRequirementSnapshotInput,
): ActionApprovalRequirementSnapshot[] {
  if (!isRecord(input)) throw validationError("approval requirement input must be an object");
  assertOnlyKeys(input, [
    "sourceGroupId",
    "riskLevel",
    "reviewer",
    "groupConfirmation",
    "targetPolicy",
  ]);
  if (!(["low", "medium", "high"] as const).includes(input.riskLevel)) {
    throw validationError("riskLevel is invalid");
  }

  const sourceGroupId = normalizeOptionalReference("sourceGroupId", input.sourceGroupId);
  const reviewer = normalizeReviewer(input.reviewer);
  const targetPolicy = normalizeTargetPolicy(input.targetPolicy);
  const groupConfirmation = normalizeGroupConfirmation(input.groupConfirmation);
  if ((sourceGroupId === undefined) !== (groupConfirmation === undefined)) {
    throw validationError("source group and group confirmation must be provided together");
  }

  const common = {
    targetPolicyId: targetPolicy.id,
    targetPolicyVersion: targetPolicy.version,
  };
  const requirements: ActionApprovalRequirementSnapshot[] = [];
  if (sourceGroupId !== undefined && groupConfirmation !== undefined) {
    requirements.push({
      kind: "group_confirmation",
      roleRefType: "source_group",
      roleRef: sourceGroupId,
      ...common,
      satisfiedBy: {
        actorOpenId: groupConfirmation.actorOpenId,
        sourceType: "group_confirmation",
        sourceId: groupConfirmation.presentationId,
      },
    });
  }

  if (input.riskLevel === "low" && sourceGroupId !== undefined) return requirements;
  if (input.riskLevel === "high") {
    requirements.push({
      kind: "iris_admin_or_authorized_owner",
      roleRefType: reviewer?.type === "feishu_user" ? "feishu_user" : "unassigned",
      ...(reviewer?.type === "feishu_user" ? { roleRef: reviewer.ref } : {}),
      ...common,
    });
    return requirements;
  }

  requirements.push({
    kind: "designated_owner",
    roleRefType: reviewer?.type === "feishu_user" ? "feishu_user" : "unassigned",
    ...(reviewer?.type === "feishu_user" ? { roleRef: reviewer.ref } : {}),
    ...common,
  });
  return requirements;
}

function normalizeReviewer(value: unknown): KnowledgeDraftReviewer | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw validationError("reviewer is invalid");
  assertOnlyKeys(value, ["type", "ref"]);
  if (!(value.type === "feishu_user" || value.type === "text_label" || value.type === "admin_role")) {
    throw validationError("reviewer type is invalid");
  }
  return {
    type: value.type,
    ref: requireReference("reviewer.ref", value.ref),
  };
}

function normalizeTargetPolicy(value: unknown): { id: string; version: number } {
  if (!isRecord(value)) throw validationError("targetPolicy is invalid");
  assertOnlyKeys(value, ["id", "version"]);
  return {
    id: requireReference("targetPolicy.id", value.id),
    version: requirePositiveInteger("targetPolicy.version", value.version),
  };
}

function normalizeGroupConfirmation(
  value: unknown,
): { actorOpenId: string; presentationId: string } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw validationError("groupConfirmation is invalid");
  assertOnlyKeys(value, ["actorOpenId", "presentationId"]);
  return {
    actorOpenId: requireReference("groupConfirmation.actorOpenId", value.actorOpenId),
    presentationId: requireReference("groupConfirmation.presentationId", value.presentationId),
  };
}

function normalizeOptionalReference(name: string, value: unknown): string | undefined {
  return value === undefined ? undefined : requireReference(name, value);
}

function requireReference(name: string, value: unknown): string {
  if (typeof value !== "string") throw validationError(`${name} must be a string`);
  const normalized = value.trim();
  if ([...normalized].length < 1 || [...normalized].length > KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS) {
    throw validationError(`${name} length is invalid`);
  }
  return normalized;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw validationError(`${name} must be a safe positive integer`);
  }
  return Number(value);
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw validationError(`unknown field: ${key}`);
  }
}

function validationError(message: string): ActionProposalValidationError {
  return new ActionProposalValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
