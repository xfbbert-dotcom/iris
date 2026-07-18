import type { KnowledgeDraft, KnowledgeDraftEvidenceState } from "../knowledge-governance/knowledge-draft-repository.js";

import type { KnowledgeCardPresentationState } from "./knowledge-card.js";

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

type KnowledgeCardInteractionInputBase = {
  presentationId: string;
  draftId: string;
  revisionNumber: number;
  draftVersion: number;
  chatId: string;
  eventId: string;
  actorOpenId: string;
  membershipCheckedAt: Date;
  at: Date;
};

export type ApplyKnowledgeCardInteractionInput = KnowledgeCardInteractionInputBase & (
  | { action: "confirm"; reason?: never; rejectionConfirmed?: never }
  | { action: "request_revision"; reason: string; rejectionConfirmed?: never }
  | { action: "reject"; reason: string; rejectionConfirmed: true }
);

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
  attempts: number;
};

export type KnowledgeCardStatusCounts = Record<KnowledgeCardPresentationState, number> & {
  pendingSend: number;
};

export type KnowledgeCardPresentationContext = {
  presentation: KnowledgeDraftPresentation;
  draft: KnowledgeDraft;
  evidenceState: KnowledgeDraftEvidenceState;
};

export interface KnowledgeCardRepository {
  createPresentation(input: CreateKnowledgeCardPresentationInput): Promise<KnowledgeCardMutationResult>;
  claimPresentationSend(input: {
    workerId: string;
    leaseUntil: Date;
    at: Date;
  }): Promise<KnowledgeCardSendClaim | undefined>;
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
  applyInteraction(input: ApplyKnowledgeCardInteractionInput): Promise<KnowledgeCardInteractionResult>;
  getPresentation(id: string): Promise<KnowledgeDraftPresentation | undefined>;
  getPresentationContext(id: string): Promise<KnowledgeCardPresentationContext | undefined>;
  listPresentations(input: { draftId: string; limit: number }): Promise<KnowledgeDraftPresentation[]>;
  getStatusCounts(): Promise<KnowledgeCardStatusCounts>;
}
