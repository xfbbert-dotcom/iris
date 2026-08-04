import { createHash } from "node:crypto";

import { KnowledgeDraftEvidenceError } from "../knowledge-governance/postgres-knowledge-draft-evidence.js";
import type { KnowledgeCardRuntime } from "../runtime/knowledge-card-runtime.js";
import { KNOWLEDGE_CARD_TARGET_DISPLAY_NAME } from "../runtime/knowledge-card-runtime.js";

import { renderKnowledgeDraftCard } from "./knowledge-card-renderer.js";
import type { KnowledgeDraftPresentation } from "./knowledge-card-repository.js";
import {
  KnowledgeCardOperationConflictError,
  KnowledgeCardPersistenceConflictError,
} from "./postgres-knowledge-card-repository.js";

export const KNOWLEDGE_DRAFT_PRESENTATION_ERROR_CODES = [
  "knowledge_draft_not_found",
  "iris_runtime_disabled",
  "knowledge_card_conflict",
  "knowledge_draft_evidence_invalid",
  "review_surface_required",
] as const;

export type KnowledgeDraftPresentationErrorCode =
  (typeof KNOWLEDGE_DRAFT_PRESENTATION_ERROR_CODES)[number];

export class KnowledgeDraftPresentationServiceError extends Error {
  constructor(public readonly code: KnowledgeDraftPresentationErrorCode) {
    super(code);
    this.name = "KnowledgeDraftPresentationServiceError";
  }
}

export type KnowledgeDraftPresentationRuntime = Pick<
  KnowledgeCardRuntime,
  "repository" | "canUseKnowledgeCards"
>;

export async function presentKnowledgeDraft(input: {
  runtime: KnowledgeDraftPresentationRuntime;
  draftId: string;
  expectedVersion: number;
  operationKey: string;
  at: Date;
}): Promise<{
  outcome: "applied" | "already_applied";
  presentation: KnowledgeDraftPresentation;
}> {
  try {
    const draft = await input.runtime.repository.getDraft(input.draftId);
    if (draft === undefined) throw serviceError("knowledge_draft_not_found");
    if (
      draft.sourceGroupId === undefined ||
      !readRuntimeGate(input.runtime, draft.sourceGroupId)
    ) throw serviceError("iris_runtime_disabled");
    if (
      draft.version !== input.expectedVersion ||
      draft.currentRevision.revisionNumber !== draft.currentRevisionNumber
    ) throw serviceError("knowledge_card_conflict");
    if (!("content" in draft.currentRevision)) {
      throw serviceError("knowledge_draft_evidence_invalid");
    }

    const at = requireValidDate(input.at);
    const presentationId = stablePresentationId({
      draftId: draft.id,
      revisionNumber: draft.currentRevisionNumber,
      operationKey: input.operationKey,
    });
    const pendingPresentation: KnowledgeDraftPresentation = {
      id: presentationId,
      draftId: draft.id,
      revisionNumber: draft.currentRevisionNumber,
      draftVersion: draft.version,
      chatId: draft.sourceGroupId,
      contentHash: "0".repeat(64),
      state: "pending_send",
      createdAt: at,
      version: 1,
    };
    const rendered = renderKnowledgeDraftCard({
      draft,
      presentation: pendingPresentation,
      targetDisplayName: KNOWLEDGE_CARD_TARGET_DISPLAY_NAME,
    });
    if (rendered.status === "review_required") {
      throw serviceError("review_surface_required");
    }

    const existing = await input.runtime.repository.getPresentation(presentationId);
    if (existing !== undefined) {
      if (!matchesPresentation(existing, pendingPresentation, rendered.contentHash)) {
        throw serviceError("knowledge_card_conflict");
      }
      return { outcome: "already_applied", presentation: existing };
    }

    try {
      const result = await input.runtime.repository.createPresentation({
        id: presentationId,
        draftId: draft.id,
        expectedDraftVersion: draft.version,
        expectedRevisionNumber: draft.currentRevisionNumber,
        chatId: draft.sourceGroupId,
        contentHash: rendered.contentHash,
        operationKey: input.operationKey,
        at,
      });
      return { outcome: result.outcome, presentation: result.presentation };
    } catch (error) {
      if (error instanceof KnowledgeCardOperationConflictError) {
        const concurrent = await input.runtime.repository.getPresentation(presentationId);
        if (
          concurrent !== undefined &&
          matchesPresentation(concurrent, pendingPresentation, rendered.contentHash)
        ) return { outcome: "already_applied", presentation: concurrent };
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof KnowledgeDraftPresentationServiceError) throw error;
    if (
      error instanceof KnowledgeCardPersistenceConflictError ||
      error instanceof KnowledgeCardOperationConflictError
    ) throw serviceError("knowledge_card_conflict");
    if (error instanceof KnowledgeDraftEvidenceError) {
      throw serviceError("knowledge_draft_evidence_invalid");
    }
    throw error;
  }
}

function matchesPresentation(
  presentation: KnowledgeDraftPresentation,
  expected: KnowledgeDraftPresentation,
  contentHash: string,
): boolean {
  return presentation.draftId === expected.draftId &&
    presentation.revisionNumber === expected.revisionNumber &&
    presentation.draftVersion === expected.draftVersion &&
    presentation.chatId === expected.chatId &&
    presentation.contentHash === contentHash;
}

function stablePresentationId(input: {
  draftId: string;
  revisionNumber: number;
  operationKey: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 40);
  return `knowledge-card-${digest}`;
}

function readRuntimeGate(runtime: KnowledgeDraftPresentationRuntime, groupId: string): boolean {
  try {
    return runtime.canUseKnowledgeCards(groupId);
  } catch {
    return false;
  }
}

function requireValidDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("knowledge draft presentation time must be a valid date");
  }
  return new Date(value);
}

function serviceError(
  code: KnowledgeDraftPresentationErrorCode,
): KnowledgeDraftPresentationServiceError {
  return new KnowledgeDraftPresentationServiceError(code);
}
