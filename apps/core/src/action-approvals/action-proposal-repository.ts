import type { KnowledgeDraftRiskLevel } from "../knowledge-governance/knowledge-draft.js";

import type {
  ActionApprovalRequirementKind,
  ActionProposal,
  ActionProposalStatus,
  ActionRoleGrantType,
} from "./action-proposal.js";

export type ActionProposalStatusCounts = Record<ActionProposalStatus, number>;

export type PublicationTargetPolicy = {
  id: string;
  spaceId: string;
  parentNodeToken?: string;
  displayName: string;
  allowedGroupIds: string[];
  allowedRiskLevels: KnowledgeDraftRiskLevel[];
  enabled: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ActionRoleGrant = {
  roleType: ActionRoleGrantType;
  actorOpenId: string;
  enabled: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ActionApprovalRequirement = {
  id: string;
  proposalId: string;
  kind: ActionApprovalRequirementKind;
  roleRefType: "source_group" | "feishu_user" | "unassigned";
  roleRef?: string;
  targetPolicyId: string;
  targetPolicyVersion: number;
  state: "pending" | "satisfied" | "invalidated";
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ActionApproval = {
  id: string;
  proposalId: string;
  requirementId: string;
  actorOpenId: string;
  sourcePresentationId: string;
  callbackEventId: string;
  subjectRevision: number;
  subjectVersion: number;
  operationKey: string;
  createdAt: Date;
};

export type ActionProposalContext = {
  proposal: ActionProposal;
  requirements: ActionApprovalRequirement[];
  approvals: ActionApproval[];
};

export interface ActionProposalRepository {
  getProposal(id: string): Promise<ActionProposalContext | undefined>;
  listProposals(input: {
    statuses?: ActionProposalStatus[];
    subjectId?: string;
    limit: number;
  }): Promise<ActionProposal[]>;
  getStatusCounts(): Promise<ActionProposalStatusCounts>;
  listTargetPolicies(input: { enabled?: boolean; limit: number }): Promise<PublicationTargetPolicy[]>;
  listRoleGrants(input: {
    roleType?: ActionRoleGrantType;
    enabled?: boolean;
    limit: number;
  }): Promise<ActionRoleGrant[]>;
}
