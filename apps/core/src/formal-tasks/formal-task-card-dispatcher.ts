import { createHash } from "node:crypto";

import {
  FeishuInteractiveCardClientError,
  type FeishuInteractiveCardClient,
  type FeishuInteractiveCardClientErrorClassification,
} from "../feishu/feishu-interactive-card-client.js";

import {
  renderFormalTaskCardCommittedResult,
  renderFormalTaskDraftCard,
  type FormalTaskDraftCardRenderResult,
} from "./formal-task-card-renderer.js";
import type {
  FormalTaskCardPresentationContext,
  FormalTaskCardRepository,
  FormalTaskCardSendClaim,
} from "./formal-task-card-repository.js";

const MAX_BATCH_LIMIT = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_EXTERNAL_ATTEMPTS = 5;

export type FormalTaskCardDispatcherCode =
  | "send_succeeded"
  | "card_update_succeeded"
  | "runtime_disabled"
  | "stale_presentation"
  | "stale_policy"
  | "evidence_invalidated"
  | "body_too_large"
  | "card_too_large"
  | "too_many_components"
  | "max_attempts_exhausted"
  | FeishuInteractiveCardClientErrorClassification;

export type FormalTaskCardDispatcherResult = {
  status: "sent" | "updated" | "retrying" | "permanent_failure" | "outcome_unknown";
  presentationId: string;
  code: FormalTaskCardDispatcherCode;
};

export type FormalTaskCardDispatcherDependencies = {
  repository: Pick<FormalTaskCardRepository,
    | "claimPresentationSend"
    | "getPresentationContext"
    | "beginExternalAttempt"
    | "failPresentationPreparation"
    | "completePresentationSend"
    | "failPresentationSend"
  >;
  cardClient: Pick<FeishuInteractiveCardClient, "sendCard" | "updateCard">;
  renderer?: typeof renderFormalTaskDraftCard;
  canUseFormalTaskCards(groupId: string): boolean;
  workerId: string;
  leaseMs: number;
  retryDelayMs: number;
  now?: () => Date;
};

export function createFormalTaskCardDispatcher({
  repository,
  cardClient,
  renderer = renderFormalTaskDraftCard,
  canUseFormalTaskCards,
  workerId,
  leaseMs,
  retryDelayMs,
  now = () => new Date(),
}: FormalTaskCardDispatcherDependencies) {
  const safeWorkerId = requireIdentifier("workerId", workerId);
  const safeLeaseMs = requirePositiveSafeInteger("leaseMs", leaseMs);
  const safeRetryDelayMs = requirePositiveSafeInteger("retryDelayMs", retryDelayMs);
  return {
    async processBatch({ limit }: { limit: number }): Promise<FormalTaskCardDispatcherResult[]> {
      const results: FormalTaskCardDispatcherResult[] = [];
      for (let index = 0; index < sanitizeLimit(limit); index += 1) {
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
          canUseFormalTaskCards,
          retryDelayMs: safeRetryDelayMs,
          now,
        }));
      }
      return results;
    },
  };
}

async function dispatchClaim(input: {
  claim: FormalTaskCardSendClaim;
  repository: FormalTaskCardDispatcherDependencies["repository"];
  cardClient: FormalTaskCardDispatcherDependencies["cardClient"];
  renderer: (input: Parameters<typeof renderFormalTaskDraftCard>[0]) => FormalTaskDraftCardRenderResult;
  canUseFormalTaskCards(groupId: string): boolean;
  retryDelayMs: number;
  now: () => Date;
}): Promise<FormalTaskCardDispatcherResult> {
  let context: FormalTaskCardPresentationContext | undefined;
  try {
    context = await input.repository.getPresentationContext(input.claim.presentation.id);
  } catch {
    throw new Error("formal task card presentation context unavailable");
  }
  if (!isExactClaimContext(input.claim, context)) {
    return failPreparation(input, "stale_presentation");
  }
  if (context.presentation.state === "closed") {
    return updateCommittedResult(input, context);
  }
  if (!("taskSpec" in context.draft.currentRevision)) {
    return failPreparation(input, "evidence_invalidated");
  }
  if (!isCurrentPendingSend(context, requireDate(input.now()))) {
    return failPreparation(input, "stale_policy");
  }
  if (!readRuntimeGate(input, context.presentation.groupId)) {
    return failPreparation(input, "runtime_disabled");
  }
  const rendered = input.renderer({
    draft: context.draft,
    presentation: context.presentation,
    targetDisplayName: context.targetPolicy.displayName,
  });
  if (rendered.status === "review_required") {
    return failPreparation(input, rendered.reason);
  }

  await input.repository.beginExternalAttempt({
    presentationId: context.presentation.id,
    workerId: input.claim.workerId,
    at: requireDate(input.now()),
  });
  if (!readRuntimeGate(input, context.presentation.groupId)) {
    return failExternalAttempt(input, "permanent", "runtime_disabled");
  }
  let sent: { messageId: string };
  try {
    sent = await input.cardClient.sendCard({
      chatId: context.presentation.groupId,
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
    return failExternalAttempt(input, "outcome_unknown", "outcome_unknown");
  }
}

async function updateCommittedResult(
  input: Parameters<typeof dispatchClaim>[0],
  context: FormalTaskCardPresentationContext,
): Promise<FormalTaskCardDispatcherResult> {
  if (context.presentation.messageId === undefined || context.committedResult === undefined) {
    return failPreparation(input, "stale_presentation");
  }
  let cardJson: string;
  try {
    cardJson = renderFormalTaskCardCommittedResult({
      draft: context.draft,
      presentation: context.presentation,
      result: context.committedResult,
    });
  } catch {
    return failPreparation(input, "stale_presentation");
  }
  if (!readRuntimeGate(input, context.presentation.groupId)) {
    return failPreparation(input, "runtime_disabled");
  }
  await input.repository.beginExternalAttempt({
    presentationId: context.presentation.id,
    workerId: input.claim.workerId,
    at: requireDate(input.now()),
  });
  if (!readRuntimeGate(input, context.presentation.groupId)) {
    return failExternalAttempt(input, "permanent", "runtime_disabled");
  }
  try {
    await input.cardClient.updateCard({
      messageId: context.presentation.messageId,
      cardJson,
    });
  } catch (error) {
    return failFromCardError(input, error);
  }
  try {
    await input.repository.completePresentationSend({
      presentationId: context.presentation.id,
      workerId: input.claim.workerId,
      messageId: context.presentation.messageId,
      at: requireDate(input.now()),
    });
    return {
      status: "updated",
      presentationId: context.presentation.id,
      code: "card_update_succeeded",
    };
  } catch {
    return failExternalAttempt(input, "outcome_unknown", "outcome_unknown");
  }
}

function failFromCardError(
  input: Parameters<typeof dispatchClaim>[0],
  error: unknown,
): Promise<FormalTaskCardDispatcherResult> {
  const classification = error instanceof FeishuInteractiveCardClientError
    ? error.classification
    : "outcome_unknown";
  if (classification === "outcome_unknown") {
    return failExternalAttempt(input, "outcome_unknown", classification);
  }
  if (classification === "remote_rejected") {
    return failExternalAttempt(input, "permanent", classification);
  }
  if (input.claim.attempts >= MAX_EXTERNAL_ATTEMPTS) {
    return failExternalAttempt(input, "permanent", "max_attempts_exhausted");
  }
  return failExternalAttempt(input, "retryable", classification);
}

async function failPreparation(
  input: Parameters<typeof dispatchClaim>[0],
  code: FormalTaskCardDispatcherCode,
): Promise<FormalTaskCardDispatcherResult> {
  await input.repository.failPresentationPreparation({
    presentationId: input.claim.presentation.id,
    workerId: input.claim.workerId,
    errorCode: code,
    at: requireDate(input.now()),
  });
  return {
    status: "permanent_failure",
    presentationId: input.claim.presentation.id,
    code,
  };
}

async function failExternalAttempt(
  input: Parameters<typeof dispatchClaim>[0],
  classification: "retryable" | "permanent" | "outcome_unknown",
  code: FormalTaskCardDispatcherCode,
): Promise<FormalTaskCardDispatcherResult> {
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
  claim: FormalTaskCardSendClaim,
  context: FormalTaskCardPresentationContext | undefined,
): context is FormalTaskCardPresentationContext {
  if (context === undefined) return false;
  const claimed = claim.presentation;
  const current = context.presentation;
  return current.id === claimed.id &&
    current.draftId === claimed.draftId &&
    current.draftRevision === claimed.draftRevision &&
    current.draftVersion === claimed.draftVersion &&
    current.taskSpecHash === claimed.taskSpecHash &&
    current.groupId === claimed.groupId &&
    current.state === claimed.state &&
    current.version === claimed.version &&
    current.messageId === claimed.messageId;
}

function isCurrentPendingSend(context: FormalTaskCardPresentationContext, now: Date): boolean {
  const { draft, presentation, targetPolicy } = context;
  if (!("taskSpec" in draft.currentRevision)) return false;
  const spec = draft.currentRevision.taskSpec;
  const dueAt = spec.dueAtUtc === undefined ? undefined : new Date(spec.dueAtUtc);
  return presentation.state === "pending_send" &&
    draft.id === presentation.draftId &&
    draft.status === "pending_confirmation" &&
    draft.sourceGroupId === presentation.groupId &&
    draft.currentRevisionNumber === presentation.draftRevision &&
    draft.version === presentation.draftVersion &&
    draft.currentTaskSpecHash === presentation.taskSpecHash &&
    targetPolicy.enabled &&
    targetPolicy.id === spec.targetPolicyId &&
    targetPolicy.sourceGroupId === presentation.groupId &&
    targetPolicy.version === spec.targetPolicyVersion &&
    targetPolicy.allowedAssigneeOpenIds.includes(spec.assigneeOpenId) &&
    (dueAt === undefined || (
      dueAt.getTime() >= now.getTime() &&
      dueAt.getTime() <= now.getTime() + targetPolicy.maxDueHorizonDays * 86_400_000
    ));
}

function readRuntimeGate(
  input: Parameters<typeof dispatchClaim>[0],
  groupId: string,
): boolean {
  try {
    return input.canUseFormalTaskCards(groupId);
  } catch {
    return false;
  }
}

function stablePresentationUuid(presentationId: string): string {
  return createHash("sha256")
    .update(`formal-task-card:${presentationId}`)
    .digest("hex")
    .slice(0, 50);
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("formal task card dispatcher batch limit is invalid");
  }
  return Math.min(MAX_BATCH_LIMIT, Math.max(0, Math.floor(value)));
}

function requirePositiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("formal task card dispatcher time is invalid");
  }
  return new Date(value);
}
