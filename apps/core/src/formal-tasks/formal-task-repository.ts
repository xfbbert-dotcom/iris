import type { KnowledgeDraftEvidenceInvalidReason } from
  "../knowledge-governance/knowledge-draft-repository.js";

import type {
  FormalTaskDraftStatus,
  FormalTaskSpec,
} from "./formal-task-draft.js";

export const FORMAL_TASK_RISK_LEVELS = ["low", "medium", "high"] as const;
export const FORMAL_TASK_DRAFT_EVENT_TYPES = [
  "created",
  "revised",
  "group_confirmed",
  "revision_requested",
  "rejected",
  "task_created",
] as const;

export type FormalTaskRiskLevel = (typeof FORMAL_TASK_RISK_LEVELS)[number];
export type FormalTaskDraftEventType = (typeof FORMAL_TASK_DRAFT_EVENT_TYPES)[number];

export type FormalTaskEvidenceReference =
  | { type: "conversation_message"; id: string }
  | { type: "action_item"; id: string; entityVersion: number };

export type FormalTaskDraftRevisionInput = {
  taskSpec: unknown;
  riskLevel: FormalTaskRiskLevel;
  author: string;
  evidence: FormalTaskEvidenceReference[];
};

type FormalTaskDraftRevisionBase = {
  revisionNumber: number;
  riskLevel: FormalTaskRiskLevel;
  author: string;
  taskSpecHash: string;
  createdAt: Date;
};

export type FormalTaskDraftRevisionView =
  | (FormalTaskDraftRevisionBase & {
      evidenceState: { status: "current" };
      taskSpec: FormalTaskSpec;
      evidence: FormalTaskEvidenceReference[];
    })
  | (FormalTaskDraftRevisionBase & {
      evidenceState: {
        status: "invalidated";
        reason: KnowledgeDraftEvidenceInvalidReason;
      };
    });

export type FormalTaskDraftView = {
  id: string;
  sourceGroupId: string;
  status: FormalTaskDraftStatus;
  currentRevisionNumber: number;
  version: number;
  createdBy: string;
  currentTaskSpecHash: string;
  rejectedAt?: Date;
  rejectedBy?: string;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
  currentRevision: FormalTaskDraftRevisionView;
};

export type FormalTaskDraftEvent = {
  id: string;
  draftId: string;
  eventType: FormalTaskDraftEventType;
  fromVersion?: number;
  toVersion: number;
  operationKey: string;
  actor: string;
  reason?: string;
  revisionNumber: number;
  createdAt: Date;
};

export type FeishuTaskTargetPolicy = {
  id: string;
  sourceGroupId: string;
  displayName: string;
  allowedAssigneeOpenIds: string[];
  maxDueHorizonDays: number;
  enabled: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertFeishuTaskTargetPolicyInput = {
  id: string;
  sourceGroupId: string;
  displayName: string;
  allowedAssigneeOpenIds: string[];
  maxDueHorizonDays: number;
  enabled: boolean;
  expectedVersion: number;
  operationKey: string;
  operator: string;
  at: Date;
};

export type CreateFormalTaskDraftInput = {
  id: string;
  operationKey: string;
  createdBy: string;
  revision: FormalTaskDraftRevisionInput;
  at: Date;
};

export type ReviseFormalTaskDraftInput = {
  id: string;
  expectedVersion: number;
  operationKey: string;
  actor: string;
  revision: FormalTaskDraftRevisionInput;
  at: Date;
};

export type TransitionFormalTaskDraftInput = {
  id: string;
  expectedVersion: number;
  expectedRevision: number;
  expectedTaskSpecHash: string;
  operationKey: string;
  actor: string;
  at: Date;
};

export type DisposeFormalTaskDraftInput = TransitionFormalTaskDraftInput & {
  reason: string;
};

export type FeishuTaskTargetPolicyMutationResult = {
  outcome: "applied" | "already_applied";
  policy: FeishuTaskTargetPolicy;
};

export type FormalTaskDraftMutationResult = {
  outcome: "applied" | "already_applied";
  draft: FormalTaskDraftView;
};

export type FormalTaskDraftStatusCounts = Record<FormalTaskDraftStatus, number>;

export interface FormalTaskRepository {
  upsertTargetPolicy(
    input: UpsertFeishuTaskTargetPolicyInput,
  ): Promise<FeishuTaskTargetPolicyMutationResult>;
  getTargetPolicy(id: string): Promise<FeishuTaskTargetPolicy | undefined>;
  getTargetPolicyForGroup(sourceGroupId: string): Promise<FeishuTaskTargetPolicy | undefined>;
  createDraft(input: CreateFormalTaskDraftInput): Promise<FormalTaskDraftMutationResult>;
  reviseDraft(input: ReviseFormalTaskDraftInput): Promise<FormalTaskDraftMutationResult>;
  confirmDraft(input: TransitionFormalTaskDraftInput): Promise<FormalTaskDraftMutationResult>;
  requestRevision(input: DisposeFormalTaskDraftInput): Promise<FormalTaskDraftMutationResult>;
  rejectDraft(input: DisposeFormalTaskDraftInput): Promise<FormalTaskDraftMutationResult>;
  markTaskCreated(input: TransitionFormalTaskDraftInput): Promise<FormalTaskDraftMutationResult>;
  getDraft(id: string): Promise<FormalTaskDraftView | undefined>;
  listDrafts(input: {
    sourceGroupId?: string;
    statuses?: FormalTaskDraftStatus[];
    riskLevels?: FormalTaskRiskLevel[];
    limit: number;
  }): Promise<FormalTaskDraftView[]>;
  listEvents(id: string): Promise<FormalTaskDraftEvent[]>;
  getStatusCounts(): Promise<FormalTaskDraftStatusCounts>;
}
