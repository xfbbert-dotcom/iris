import { createHash } from "node:crypto";

import {
  FeishuInteractiveCardClientError,
  type FeishuInteractiveCardClient,
  type FeishuInteractiveCardClientErrorClassification,
} from "../feishu/feishu-interactive-card-client.js";

import { renderFeishuTaskResultCard } from "./feishu-task-result-card.js";
import type {
  FeishuTaskResultPresentationContext,
  FeishuTaskResultSendClaim,
  FormalTaskExecutionRepository,
} from "./formal-task-execution-repository.js";

const MAX_BATCH_LIMIT = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_EXTERNAL_ATTEMPTS = 5;

export type FeishuTaskResultDispatcherCode =
  | "send_succeeded"
  | "runtime_disabled"
  | "stale_presentation"
  | "render_failed"
  | "max_attempts_exhausted"
  | FeishuInteractiveCardClientErrorClassification;

export type FeishuTaskResultDispatcherResult = {
  status: "sent" | "retrying" | "permanent_failure" | "outcome_unknown";
  presentationId: string;
  code: FeishuTaskResultDispatcherCode;
};

export type FeishuTaskResultDispatcherDependencies = {
  repository: Pick<FormalTaskExecutionRepository,
    "claimResultPresentationSend" | "getResultPresentationContext" |
    "beginResultPresentationAttempt" | "failResultPresentationPreparation" |
    "completeResultPresentationSend" | "failResultPresentationSend">;
  cardClient: Pick<FeishuInteractiveCardClient, "sendCard">;
  canSendResultCards(groupId?: string): boolean;
  workerId: string;
  leaseMs: number;
  retryDelayMs: number;
  now?: () => Date;
};

export function createFeishuTaskResultDispatcher({
  repository,
  cardClient,
  canSendResultCards,
  workerId,
  leaseMs,
  retryDelayMs,
  now = () => new Date(),
}: FeishuTaskResultDispatcherDependencies) {
  const safeWorkerId = requireIdentifier("workerId", workerId);
  const safeLeaseMs = requirePositiveInteger("leaseMs", leaseMs, MAX_TIMER_DELAY_MS);
  const safeRetryDelayMs = requirePositiveInteger(
    "retryDelayMs",
    retryDelayMs,
    MAX_TIMER_DELAY_MS,
  );
  return {
    async processBatch({ limit }: { limit: number }): Promise<FeishuTaskResultDispatcherResult[]> {
      const safeLimit = requirePositiveInteger("limit", limit, MAX_BATCH_LIMIT);
      if (!readGate(canSendResultCards)) return [];
      const results: FeishuTaskResultDispatcherResult[] = [];
      for (let index = 0; index < safeLimit; index += 1) {
        if (!readGate(canSendResultCards)) break;
        const claimedAt = requireDate(now());
        const claim = await repository.claimResultPresentationSend({
          workerId: safeWorkerId,
          leaseUntil: new Date(claimedAt.getTime() + safeLeaseMs),
          at: claimedAt,
        });
        if (claim === undefined) break;
        results.push(await dispatchClaim({
          claim,
          repository,
          cardClient,
          canSendResultCards,
          retryDelayMs: safeRetryDelayMs,
          now,
        }));
      }
      return results;
    },
  };
}

async function dispatchClaim(input: {
  claim: FeishuTaskResultSendClaim;
  repository: FeishuTaskResultDispatcherDependencies["repository"];
  cardClient: FeishuTaskResultDispatcherDependencies["cardClient"];
  canSendResultCards: FeishuTaskResultDispatcherDependencies["canSendResultCards"];
  retryDelayMs: number;
  now: () => Date;
}): Promise<FeishuTaskResultDispatcherResult> {
  let context: FeishuTaskResultPresentationContext | undefined;
  try {
    context = await input.repository.getResultPresentationContext(
      input.claim.presentation.id,
    );
  } catch {
    context = undefined;
  }
  if (!isExactContext(input.claim, context)) return failPreparation(input, "stale_presentation");
  if (!readGate(input.canSendResultCards, context.presentation.groupId)) {
    return failPreparation(input, "runtime_disabled");
  }
  let cardJson: string;
  try {
    cardJson = renderFeishuTaskResultCard(context).json;
  } catch {
    return failPreparation(input, "render_failed");
  }
  await input.repository.beginResultPresentationAttempt({
    presentationId: context.presentation.id,
    workerId: input.claim.workerId,
    at: requireDate(input.now()),
  });
  if (!readGate(input.canSendResultCards, context.presentation.groupId)) {
    return failExternalAttempt(input, "permanent", "runtime_disabled");
  }
  let sent: { messageId: string };
  try {
    sent = await input.cardClient.sendCard({
      chatId: context.presentation.groupId,
      cardJson,
      uuid: stableUuid(context.presentation.id),
    });
  } catch (error) {
    return failFromCardError(input, error);
  }
  try {
    await input.repository.completeResultPresentationSend({
      presentationId: context.presentation.id,
      workerId: input.claim.workerId,
      messageId: sent.messageId,
      at: requireDate(input.now()),
    });
    return {
      status: "sent",
      presentationId: context.presentation.id,
      code: "send_succeeded",
    };
  } catch {
    return failExternalAttempt(input, "outcome_unknown", "outcome_unknown");
  }
}

function failFromCardError(
  input: Parameters<typeof dispatchClaim>[0],
  error: unknown,
): Promise<FeishuTaskResultDispatcherResult> {
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
  code: FeishuTaskResultDispatcherCode,
): Promise<FeishuTaskResultDispatcherResult> {
  await input.repository.failResultPresentationPreparation({
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
  code: FeishuTaskResultDispatcherCode,
): Promise<FeishuTaskResultDispatcherResult> {
  const failedAt = requireDate(input.now());
  await input.repository.failResultPresentationSend({
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

function isExactContext(
  claim: FeishuTaskResultSendClaim,
  context: FeishuTaskResultPresentationContext | undefined,
): context is FeishuTaskResultPresentationContext {
  if (context === undefined) return false;
  const expected = claim.presentation;
  const actual = context.presentation;
  return expected.id === actual.id &&
    expected.creationId === actual.creationId &&
    expected.proposalId === actual.proposalId &&
    expected.groupId === actual.groupId &&
    expected.state === actual.state &&
    expected.version === actual.version &&
    expected.messageId === actual.messageId;
}

function readGate(
  gate: FeishuTaskResultDispatcherDependencies["canSendResultCards"],
  groupId?: string,
): boolean {
  try {
    return gate(groupId);
  } catch {
    return false;
  }
}

function stableUuid(presentationId: string): string {
  return createHash("sha256")
    .update(`formal-task-result:${presentationId}`)
    .digest("hex")
    .slice(0, 50);
}

function requireIdentifier(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requirePositiveInteger(name: string, value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return Number(value);
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("formal task result dispatcher time is invalid");
  }
  return new Date(value);
}
