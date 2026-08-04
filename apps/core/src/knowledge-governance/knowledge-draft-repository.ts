import type {
  KnowledgeDraftEvidenceReference,
  KnowledgeDraftEventType,
  KnowledgeDraftOriginKind,
  KnowledgeDraftRevisionInput,
  KnowledgeDraftRiskLevel,
  KnowledgeDraftStatus,
} from "./knowledge-draft.js";

export const KNOWLEDGE_DRAFT_EVIDENCE_INVALID_REASONS = [
  "source_missing",
  "message_deleted",
  "entity_version_changed",
  "document_permission_unavailable",
  "document_not_synced",
  "document_draft_use_disabled",
  "source_timestamp_changed",
  "group_scope_mismatch",
] as const;

export type KnowledgeDraftEvidenceInvalidReason =
  (typeof KNOWLEDGE_DRAFT_EVIDENCE_INVALID_REASONS)[number];
export type KnowledgeDraftEvidenceState =
  | { status: "current" }
  | { status: "invalidated"; reason: KnowledgeDraftEvidenceInvalidReason };

type KnowledgeDraftRevisionBase = {
  revisionNumber: number;
  riskLevel: KnowledgeDraftRiskLevel;
  author: string;
  createdAt: Date;
  evidenceState: KnowledgeDraftEvidenceState;
};

export type KnowledgeDraftRevisionView =
  | (KnowledgeDraftRevisionBase & {
      evidenceState: { status: "current" };
      title: string;
      content: string;
      reviewer?: { type: "feishu_user" | "text_label" | "admin_role"; ref: string };
      suggestedPublication?: { spaceId?: string; parentNodeToken?: string };
      evidence: KnowledgeDraftEvidenceReference[];
    })
  | (KnowledgeDraftRevisionBase & {
      evidenceState: { status: "invalidated"; reason: KnowledgeDraftEvidenceInvalidReason };
    });

export type KnowledgeDraft = {
  id: string;
  sourceGroupId?: string;
  originKind: KnowledgeDraftOriginKind;
  status: KnowledgeDraftStatus;
  currentRevisionNumber: number;
  version: number;
  createdBy: string;
  rejectedAt?: Date;
  rejectedBy?: string;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
  currentRevision: KnowledgeDraftRevisionView;
};

export type KnowledgeDraftEvent = {
  id: string;
  draftId: string;
  eventType: KnowledgeDraftEventType;
  fromVersion?: number;
  toVersion: number;
  operationKey: string;
  actor: string;
  reason?: string;
  revisionNumber: number;
  createdAt: Date;
};

export type CreateKnowledgeDraftInput = {
  id: string;
  operationKey: string;
  originKind: KnowledgeDraftOriginKind;
  createdBy: string;
  revision: KnowledgeDraftRevisionInput;
  at: Date;
};

export type ReviseKnowledgeDraftInput = {
  id: string;
  expectedVersion: number;
  operationKey: string;
  actor: string;
  revision: KnowledgeDraftRevisionInput;
  at: Date;
};

export type TransitionKnowledgeDraftInput = {
  id: string;
  expectedVersion: number;
  operationKey: string;
  actor: string;
  reason: string;
  at: Date;
};

export type KnowledgeDraftMutationResult = {
  outcome: "applied" | "already_applied";
  draft: KnowledgeDraft;
};

export type KnowledgeDraftStatusCounts = Record<KnowledgeDraftStatus, number>;

export interface KnowledgeDraftRepository {
  createDraft(input: CreateKnowledgeDraftInput): Promise<KnowledgeDraftMutationResult>;
  reviseDraft(input: ReviseKnowledgeDraftInput): Promise<KnowledgeDraftMutationResult>;
  requestRevision(input: TransitionKnowledgeDraftInput): Promise<KnowledgeDraftMutationResult>;
  rejectDraft(input: TransitionKnowledgeDraftInput): Promise<KnowledgeDraftMutationResult>;
  getDraft(id: string): Promise<KnowledgeDraft | undefined>;
  listDrafts(input: {
    sourceGroupId?: string;
    statuses?: KnowledgeDraftStatus[];
    riskLevels?: KnowledgeDraftRiskLevel[];
    limit: number;
  }): Promise<KnowledgeDraft[]>;
  listEvents(id: string): Promise<KnowledgeDraftEvent[]>;
  getStatusCounts(): Promise<KnowledgeDraftStatusCounts>;
}
