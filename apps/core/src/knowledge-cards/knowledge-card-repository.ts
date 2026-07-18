import type { KnowledgeDraft, KnowledgeDraftEvidenceState } from "../knowledge-governance/knowledge-draft-repository.js";

import type { KnowledgeCardAction, KnowledgeCardPresentationState } from "./knowledge-card.js";

export type KnowledgeDraftPresentation = {
  id: string;
  draftId: string;
  revisionNumber: number;
  draftVersion: number;
  chatId: string;
  contentHash: string;
  state: KnowledgeCardPresentationState;
  messageId?: string;
  createdAt: Date;
  activatedAt?: Date;
  closedAt?: Date;
  version: number;
};

export type CreateKnowledgeCardPresentationInput = {
  id: string;
  draftId: string;
  expectedDraftVersion: number;
  expectedRevisionNumber: number;
  chatId: string;
  contentHash: string;
  operationKey: string;
  at: Date;
};

export type ApplyKnowledgeCardInteractionInput = {
  presentationId: string;
  draftId: string;
  revisionNumber: number;
  draftVersion: number;
  chatId: string;
  eventId: string;
  actorOpenId: string;
  action: KnowledgeCardAction;
  reason?: string;
  rejectionConfirmed?: true;
  membershipCheckedAt: Date;
  at: Date;
};

export type KnowledgeCardMutationResult = {
  outcome: "applied" | "already_applied";
  presentation: KnowledgeDraftPresentation;
  draft: KnowledgeDraft;
};

export type KnowledgeCardInteractionResult = KnowledgeCardMutationResult;

export type KnowledgeCardSendClaim = {
  presentation: KnowledgeDraftPresentation;
  workerId: string;
  leaseUntil: Date;
};

export type KnowledgeCardStatusCounts = Record<KnowledgeCardPresentationState, number> & {
  pendingSend: number;
};

export type KnowledgeCardPresentationContext = {
  presentation: KnowledgeDraftPresentation;
  evidenceState: KnowledgeDraftEvidenceState;
};

export interface KnowledgeCardRepository {
  createPresentation(input: CreateKnowledgeCardPresentationInput): Promise<KnowledgeCardMutationResult>;
  claimPresentationSend(input: {
    workerId: string;
    leaseUntil: Date;
    at: Date;
  }): Promise<KnowledgeCardSendClaim | undefined>;
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
  applyInteraction(input: ApplyKnowledgeCardInteractionInput): Promise<KnowledgeCardInteractionResult>;
  getPresentation(id: string): Promise<KnowledgeDraftPresentation | undefined>;
  listPresentations(input: { draftId: string; limit: number }): Promise<KnowledgeDraftPresentation[]>;
  getStatusCounts(): Promise<KnowledgeCardStatusCounts>;
}
