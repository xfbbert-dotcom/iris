import { createHash } from "node:crypto";

import {
  FeishuInteractiveCardClientError,
  type FeishuInteractiveCardClient,
  type FeishuInteractiveCardClientErrorClassification,
} from "../feishu/feishu-interactive-card-client.js";

import { renderApprovalInteractionStatusCard } from "./approval-interaction-worker.js";
import {
  renderKnowledgeDraftCard,
  type KnowledgeDraftCardRenderInput,
  type KnowledgeDraftCardRenderResult,
} from "./knowledge-card-renderer.js";
import type {
  KnowledgeCardPresentationContext,
  KnowledgeCardRepository,
  KnowledgeCardSendClaim,
} from "./knowledge-card-repository.js";

const MAX_BATCH_LIMIT = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type KnowledgeCardDispatcherCode =
  | "send_succeeded"
  | "card_update_succeeded"
  | "runtime_disabled"
  | "stale_presentation"
  | "evidence_invalidated"
  | "body_too_large"
  | "card_too_large"
  | "too_many_components"
  | FeishuInteractiveCardClientErrorClassification;

export type KnowledgeCardDispatcherResult = {
  status: "sent" | "updated" | "retrying" | "permanent_failure" | "outcome_unknown";
  presentationId: string;
  code: KnowledgeCardDispatcherCode;
};

export type KnowledgeCardDispatcherDependencies = {
  repository: Pick<KnowledgeCardRepository,
    | "claimPresentationSend"
    | "getPresentationContext"
    | "completePresentationSend"
    | "failPresentationSend"
  >;
  cardClient: FeishuInteractiveCardClient;
  renderer?: (input: KnowledgeDraftCardRenderInput) => KnowledgeDraftCardRenderResult;
  canUseKnowledgeCards(groupId: string): boolean;
  targetDisplayName: string;
  workerId: string;
  leaseMs: number;
  retryDelayMs: number;
  now?: () => Date;
};

export function createKnowledgeCardDispatcher({
  repository,
  cardClient,
  renderer = renderKnowledgeDraftCard,
  canUseKnowledgeCards,
  targetDisplayName,
  workerId,
  leaseMs,
  retryDelayMs,
  now = () => new Date(),
}: KnowledgeCardDispatcherDependencies) {
  const safeWorkerId = requireIdentifier("workerId", workerId);
  const safeLeaseMs = requirePositiveSafeInteger("leaseMs", leaseMs);
  const safeRetryDelayMs = requirePositiveSafeInteger("retryDelayMs", retryDelayMs);
  const safeTargetDisplayName = requireDisplayName(targetDisplayName);

  return {
    async processBatch({ limit }: { limit: number }): Promise<KnowledgeCardDispatcherResult[]> {
      const safeLimit = sanitizeLimit(limit);
      const results: KnowledgeCardDispatcherResult[] = [];
      for (let index = 0; index < safeLimit; index += 1) {
        const claimedAt = requireDate(now());
        const claim = await repository.claimPresentationSend({
          workerId: safeWorkerId,
          at: claimedAt,
          leaseUntil: new Date(claimedAt.getTime() + safeLeaseMs),
        });
        if (claim === undefined) break;
        results.push(await dispatchClaim({
          claim,
          repository,
          cardClient,
          renderer,
          canUseKnowledgeCards,
          targetDisplayName: safeTargetDisplayName,
          retryDelayMs: safeRetryDelayMs,
          now,
        }));
      }
      return results;
    },
  };
}

async function dispatchClaim(input: {
  claim: KnowledgeCardSendClaim;
  repository: KnowledgeCardDispatcherDependencies["repository"];
  cardClient: FeishuInteractiveCardClient;
  renderer: NonNullable<KnowledgeCardDispatcherDependencies["renderer"]>;
  canUseKnowledgeCards(groupId: string): boolean;
  targetDisplayName: string;
  retryDelayMs: number;
  now: () => Date;
}): Promise<KnowledgeCardDispatcherResult> {
  const { presentation: claimedPresentation } = input.claim;
  let context: KnowledgeCardPresentationContext | undefined;
  try {
    context = await input.repository.getPresentationContext(claimedPresentation.id);
  } catch {
    throw new Error("knowledge card presentation context unavailable");
  }
  if (!isExactClaimContext(input.claim, context)) {
    return fail(input, "permanent", "stale_presentation");
  }
  if (context.evidenceState.status !== "current") {
    return fail(input, "permanent", "evidence_invalidated");
  }

  if (context.presentation.state === "closed") {
    return updateCommittedResult(input, context);
  }
  if (!isCurrentPendingSend(context)) {
    return fail(input, "permanent", "stale_presentation");
  }

  const rendered = input.renderer({
    draft: context.draft,
    presentation: context.presentation,
    targetDisplayName: input.targetDisplayName,
  });
  if (rendered.status === "review_required") {
    return fail(input, "permanent", rendered.reason);
  }
  if (rendered.contentHash !== context.presentation.contentHash) {
    return fail(input, "permanent", "stale_presentation");
  }
  if (!readRuntimeGate(input, context.presentation.chatId)) {
    return fail(input, "permanent", "runtime_disabled");
  }

  let sent: { messageId: string };
  try {
    sent = await input.cardClient.sendCard({
      chatId: context.presentation.chatId,
      cardJson: rendered.json,
      uuid: stablePresentationUuid(context.presentation.id),
    });
  } catch (error) {
    return failFromCardError(input, error);
  }
  try {
    await input.repository.completePresentationSend({
      presentationId: context.presentation.id,
      workerId: input.claim.workerId,
      messageId: sent.messageId,
      at: requireDate(input.now()),
    });
    return { status: "sent", presentationId: context.presentation.id, code: "send_succeeded" };
  } catch {
    return fail(input, "outcome_unknown", "outcome_unknown");
  }
}

async function updateCommittedResult(
  input: Parameters<typeof dispatchClaim>[0],
  context: KnowledgeCardPresentationContext,
): Promise<KnowledgeCardDispatcherResult> {
  const messageId = context.presentation.messageId;
  if (messageId === undefined) return fail(input, "permanent", "stale_presentation");
  if (!readRuntimeGate(input, context.presentation.chatId)) {
    return fail(input, "permanent", "runtime_disabled");
  }
  try {
    await input.cardClient.updateCard({
      messageId,
      cardJson: renderApprovalInteractionStatusCard("action_applied"),
    });
  } catch (error) {
    return failFromCardError(input, error);
  }
  try {
    await input.repository.completePresentationSend({
      presentationId: context.presentation.id,
      workerId: input.claim.workerId,
      messageId,
      at: requireDate(input.now()),
    });
    return {
      status: "updated",
      presentationId: context.presentation.id,
      code: "card_update_succeeded",
    };
  } catch {
    return fail(input, "outcome_unknown", "outcome_unknown");
  }
}

function failFromCardError(
  input: Parameters<typeof dispatchClaim>[0],
  error: unknown,
): Promise<KnowledgeCardDispatcherResult> {
  const classification = error instanceof FeishuInteractiveCardClientError
    ? error.classification
    : "request_not_sent";
  if (classification === "outcome_unknown") return fail(input, "outcome_unknown", classification);
  if (classification === "remote_rejected") return fail(input, "permanent", classification);
  return fail(input, "retryable", classification);
}

async function fail(
  input: Parameters<typeof dispatchClaim>[0],
  classification: "retryable" | "permanent" | "outcome_unknown",
  code: KnowledgeCardDispatcherCode,
): Promise<KnowledgeCardDispatcherResult> {
  const failedAt = requireDate(input.now());
  await input.repository.failPresentationSend({
    presentationId: input.claim.presentation.id,
    workerId: input.claim.workerId,
    classification,
    errorCode: code,
    ...(classification === "retryable"
      ? { retryAt: new Date(failedAt.getTime() + input.retryDelayMs) }
      : {}),
    at: failedAt,
  });
  return {
    status: classification === "retryable"
      ? "retrying"
      : classification === "permanent" ? "permanent_failure" : "outcome_unknown",
    presentationId: input.claim.presentation.id,
    code,
  };
}

function isExactClaimContext(
  claim: KnowledgeCardSendClaim,
  context: KnowledgeCardPresentationContext | undefined,
): context is KnowledgeCardPresentationContext {
  if (context === undefined) return false;
  const claimed = claim.presentation;
  const current = context.presentation;
  return current.id === claimed.id &&
    current.draftId === claimed.draftId &&
    current.revisionNumber === claimed.revisionNumber &&
    current.draftVersion === claimed.draftVersion &&
    current.chatId === claimed.chatId &&
    current.contentHash === claimed.contentHash &&
    current.state === claimed.state &&
    current.version === claimed.version &&
    current.messageId === claimed.messageId;
}

function isCurrentPendingSend(context: KnowledgeCardPresentationContext): boolean {
  const { draft, presentation } = context;
  return presentation.state === "pending_send" &&
    draft.id === presentation.draftId &&
    draft.status === "pending_confirmation" &&
    draft.sourceGroupId === presentation.chatId &&
    draft.currentRevisionNumber === presentation.revisionNumber &&
    draft.version === presentation.draftVersion &&
    draft.currentRevision.revisionNumber === presentation.revisionNumber;
}

function readRuntimeGate(input: Parameters<typeof dispatchClaim>[0], groupId: string): boolean {
  try {
    return input.canUseKnowledgeCards(groupId);
  } catch {
    return false;
  }
}

function stablePresentationUuid(presentationId: string): string {
  return createHash("sha256")
    .update(`knowledge-card:${presentationId}`)
    .digest("hex")
    .slice(0, 50);
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("knowledge card dispatcher batch limit must be a finite safe-magnitude number");
  }
  return Math.min(MAX_BATCH_LIMIT, Math.max(0, Math.floor(value)));
}

function requirePositiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  return value;
}

function requireIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || [...normalized].length > 512) {
    throw new Error("targetDisplayName is invalid");
  }
  return normalized;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("knowledge card dispatcher time must be a valid date");
  }
  return new Date(value);
}
