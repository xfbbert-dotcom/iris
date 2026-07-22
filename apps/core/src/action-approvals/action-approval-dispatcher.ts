import { createHash } from "node:crypto";

import {
  FeishuInteractiveCardClientError,
  type FeishuInteractiveCardClient,
  type FeishuInteractiveCardClientErrorClassification,
} from "../feishu/feishu-interactive-card-client.js";

import {
  ActionApprovalCardBindingError,
  renderActionApprovalCard,
  type ActionApprovalCardRenderInput,
  type ActionApprovalCardRenderResult,
} from "./action-approval-card-renderer.js";
import type {
  ActionApprovalDeliveryContext,
  ActionApprovalSendClaim,
  ActionProposalRepository,
} from "./action-proposal-repository.js";

const MAX_BATCH_LIMIT = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_EXTERNAL_ATTEMPTS = 5;

export type ActionApprovalDispatcherCode =
  | "send_succeeded"
  | "runtime_disabled"
  | "stale_presentation"
  | "max_attempts_exhausted"
  | FeishuInteractiveCardClientErrorClassification;

export type ActionApprovalDispatcherResult = {
  status: "sent" | "retrying" | "permanent_failure" | "outcome_unknown";
  presentationId: string;
  code: ActionApprovalDispatcherCode;
};

export type ActionApprovalDispatcherDependencies = {
  repository: Pick<ActionProposalRepository,
    | "claimApprovalPresentationSend"
    | "getApprovalDeliveryContext"
    | "beginApprovalExternalAttempt"
    | "failApprovalPresentationPreparation"
    | "completeApprovalPresentationSend"
    | "failApprovalPresentationSend"
  >;
  cardClient: Pick<FeishuInteractiveCardClient, "sendCardToUser">;
  renderer?: (input: ActionApprovalCardRenderInput) => ActionApprovalCardRenderResult;
  canDeliverApprovalCards(sourceGroupId?: string): boolean;
  reviewPublicOrigin?: string;
  workerId: string;
  leaseMs: number;
  retryDelayMs: number;
  now?: () => Date;
};

export function createActionApprovalDispatcher({
  repository,
  cardClient,
  renderer = renderActionApprovalCard,
  canDeliverApprovalCards,
  reviewPublicOrigin,
  workerId,
  leaseMs,
  retryDelayMs,
  now = () => new Date(),
}: ActionApprovalDispatcherDependencies) {
  const safeWorkerId = requireIdentifier("workerId", workerId);
  const safeLeaseMs = requirePositiveSafeInteger("leaseMs", leaseMs);
  const safeRetryDelayMs = requirePositiveSafeInteger("retryDelayMs", retryDelayMs);
  return {
    async processBatch({ limit }: { limit: number }): Promise<ActionApprovalDispatcherResult[]> {
      const results: ActionApprovalDispatcherResult[] = [];
      for (let index = 0; index < sanitizeLimit(limit); index += 1) {
        const claimedAt = requireDate(now());
        const claim = await repository.claimApprovalPresentationSend({
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
          canDeliverApprovalCards,
          ...(reviewPublicOrigin === undefined ? {} : { reviewPublicOrigin }),
          retryDelayMs: safeRetryDelayMs,
          now,
        }));
      }
      return results;
    },
  };
}

async function dispatchClaim(input: {
  claim: ActionApprovalSendClaim;
  repository: ActionApprovalDispatcherDependencies["repository"];
  cardClient: ActionApprovalDispatcherDependencies["cardClient"];
  renderer: NonNullable<ActionApprovalDispatcherDependencies["renderer"]>;
  canDeliverApprovalCards(sourceGroupId?: string): boolean;
  reviewPublicOrigin?: string;
  retryDelayMs: number;
  now: () => Date;
}): Promise<ActionApprovalDispatcherResult> {
  let context: ActionApprovalDeliveryContext | undefined;
  try {
    context = await input.repository.getApprovalDeliveryContext(input.claim.presentation.id);
  } catch {
    throw new Error("action approval presentation context unavailable");
  }
  if (!isExactClaimContext(input.claim, context)) return failPreparation(input, "stale_presentation");
  let rendered: ActionApprovalCardRenderResult;
  try {
    rendered = input.renderer({
      context: context.context,
      requirement: context.requirement,
      policy: context.policy,
      presentation: context.presentation,
      ...(input.reviewPublicOrigin === undefined ? {} : { reviewPublicOrigin: input.reviewPublicOrigin }),
    });
  } catch (error) {
    if (error instanceof ActionApprovalCardBindingError) {
      return failPreparation(input, "stale_presentation");
    }
    throw error;
  }
  if (!readRuntimeGate(input, context.sourceGroupId)) {
    return failPreparation(input, "runtime_disabled");
  }
  await input.repository.beginApprovalExternalAttempt({
    presentationId: context.presentation.id,
    workerId: input.claim.workerId,
    at: requireDate(input.now()),
  });
  if (!readRuntimeGate(input, context.sourceGroupId)) {
    return failExternalAttempt(input, "permanent", "runtime_disabled");
  }

  let sent: { messageId: string };
  try {
    sent = await input.cardClient.sendCardToUser({
      recipientOpenId: context.presentation.recipientOpenId,
      cardJson: rendered.json,
      uuid: stablePresentationUuid(context.presentation.id),
    });
  } catch (error) {
    return failFromCardError(input, error);
  }
  try {
    await input.repository.completeApprovalPresentationSend({
      presentationId: context.presentation.id,
      workerId: input.claim.workerId,
      messageId: sent.messageId,
      at: requireDate(input.now()),
    });
  } catch {
    return failExternalAttempt(input, "outcome_unknown", "outcome_unknown");
  }
  return { status: "sent", presentationId: context.presentation.id, code: "send_succeeded" };
}

function failFromCardError(
  input: Parameters<typeof dispatchClaim>[0],
  error: unknown,
): Promise<ActionApprovalDispatcherResult> {
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
  code: ActionApprovalDispatcherCode,
): Promise<ActionApprovalDispatcherResult> {
  await input.repository.failApprovalPresentationPreparation({
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
  code: ActionApprovalDispatcherCode,
): Promise<ActionApprovalDispatcherResult> {
  const failedAt = requireDate(input.now());
  await input.repository.failApprovalPresentationSend({
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
  claim: ActionApprovalSendClaim,
  context: ActionApprovalDeliveryContext | undefined,
): context is ActionApprovalDeliveryContext {
  if (context === undefined) return false;
  const claimed = claim.presentation;
  const current = context.presentation;
  return current.id === claimed.id &&
    current.proposalId === claimed.proposalId &&
    current.requirementId === claimed.requirementId &&
    current.proposalVersion === claimed.proposalVersion &&
    current.recipientOpenId === claimed.recipientOpenId &&
    current.state === "pending_send" &&
    current.state === claimed.state &&
    current.operationKey === claimed.operationKey &&
    current.version === claimed.version &&
    current.messageId === claimed.messageId;
}

function readRuntimeGate(
  input: Parameters<typeof dispatchClaim>[0],
  sourceGroupId?: string,
): boolean {
  try {
    return input.canDeliverApprovalCards(sourceGroupId);
  } catch {
    return false;
  }
}

function stablePresentationUuid(presentationId: string): string {
  return createHash("sha256")
    .update(`action-approval-card:${presentationId}`)
    .digest("hex")
    .slice(0, 50);
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("action approval dispatcher batch limit must be a finite safe-magnitude number");
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

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("action approval dispatcher time must be valid");
  }
  return new Date(value);
}
