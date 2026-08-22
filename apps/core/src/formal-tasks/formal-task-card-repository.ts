import type { KnowledgeCardPresentationState } from
  "../knowledge-cards/knowledge-card.js";

import type {
  FeishuTaskTargetPolicy,
  FormalTaskDraftView,
} from "./formal-task-repository.js";

export type FormalTaskDraftPresentation = {
  id: string;
  draftId: string;
  draftRevision: number;
  draftVersion: number;
  taskSpecHash: string;
  groupId: string;
  state: KnowledgeCardPresentationState;
  messageId?: string;
  createdAt: Date;
  activatedAt?: Date;
  closedAt?: Date;
  version: number;
};

export type FormalTaskCardCommittedResult =
  | {
      action: "confirm";
      actorOpenId: string;
      confirmedAt: Date;
      nextGate: "pending_review";
    }
  | {
      action: "request_revision";
      state: "needs_revision";
      reason: string;
    }
  | {
      action: "reject";
      state: "rejected";
      reason: string;
    };

export type FormalTaskCardPresentationContext = {
  presentation: FormalTaskDraftPresentation;
  draft: FormalTaskDraftView;
  targetPolicy: FeishuTaskTargetPolicy;
  committedResult?: FormalTaskCardCommittedResult;
};

export type CreateFormalTaskCardPresentationInput = {
  id: string;
  draftId: string;
  expectedDraftVersion: number;
  expectedDraftRevision: number;
  taskSpecHash: string;
  groupId: string;
  operationKey: string;
  at: Date;
};

type FormalTaskCardInteractionInputBase = {
  presentationId: string;
  draftId: string;
  draftRevision: number;
  draftVersion: number;
  taskSpecHash: string;
  targetPolicyId: string;
  targetPolicyVersion: number;
  groupId: string;
  eventId: string;
  actorOpenId: string;
  membershipCheckedAt: Date;
  at: Date;
};

export type ApplyFormalTaskCardInteractionInput = FormalTaskCardInteractionInputBase & (
  | { action: "confirm"; reason?: never; rejectionConfirmed?: never }
  | { action: "request_revision"; reason: string; rejectionConfirmed?: never }
  | { action: "reject"; reason: string; rejectionConfirmed: true }
);

export type FormalTaskCardMutationResult = {
  outcome: "applied" | "already_applied";
  presentation: FormalTaskDraftPresentation;
  draft: FormalTaskDraftView;
};

export type FormalTaskCardInteractionResult = FormalTaskCardMutationResult & {
  committedResult: FormalTaskCardCommittedResult;
};

export type FormalTaskCardSendClaim = {
  presentation: FormalTaskDraftPresentation;
  workerId: string;
  leaseUntil: Date;
  attempts: number;
};

export type FormalTaskCardPresentationStatusCounts = Record<
  KnowledgeCardPresentationState,
  number
>;

export type FormalTaskCardOutboxStatusCounts = {
  pending: number;
  processing: number;
  external_attempting: number;
  sent: number;
  failed: number;
  outcome_unknown: number;
  terminalFailed: number;
};

export interface FormalTaskCardRepository {
  createPresentation(
    input: CreateFormalTaskCardPresentationInput,
  ): Promise<FormalTaskCardMutationResult>;
  claimPresentationSend(input: {
    workerId: string;
    leaseUntil: Date;
    at: Date;
  }): Promise<FormalTaskCardSendClaim | undefined>;
  beginExternalAttempt(input: {
    presentationId: string;
    workerId: string;
    at: Date;
  }): Promise<void>;
  failPresentationPreparation(input: {
    presentationId: string;
    workerId: string;
    errorCode: string;
    at: Date;
  }): Promise<void>;
  completePresentationSend(input: {
    presentationId: string;
    workerId: string;
    messageId: string;
    at: Date;
  }): Promise<void>;
  failPresentationSend(input: {
    presentationId: string;
    workerId: string;
    classification: "retryable" | "permanent" | "outcome_unknown";
    errorCode: string;
    retryAt?: Date;
    at: Date;
  }): Promise<void>;
  applyInteraction(
    input: ApplyFormalTaskCardInteractionInput,
  ): Promise<FormalTaskCardInteractionResult>;
  getPresentation(id: string): Promise<FormalTaskDraftPresentation | undefined>;
  getPresentationContext(id: string): Promise<FormalTaskCardPresentationContext | undefined>;
  getPresentationStatusCounts(): Promise<FormalTaskCardPresentationStatusCounts>;
  getOutboxStatusCounts(): Promise<FormalTaskCardOutboxStatusCounts>;
}
