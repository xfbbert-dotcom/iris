import { createHash } from "node:crypto";

import type { AgentExecutionObserver } from "../agent-runtime/agent-execution-observer.js";
import {
  FeishuInteractiveCardClientError,
  type FeishuInteractiveCardClient,
  type FeishuInteractiveCardClientErrorClassification,
} from "../feishu/feishu-interactive-card-client.js";
import {
  renderProactiveSignalCard,
  type ProactiveSignalCardRenderInput,
  type ProactiveSignalCardRenderResult,
} from "./proactive-signal-card-renderer.js";
import type {
  ProactiveSignalDeliveryClaim,
  ProactiveSignalDeliveryContext,
  ProactiveSignalRepository,
} from "./proactive-signal-repository.js";

const MAX_BATCH_LIMIT = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_EXTERNAL_ATTEMPTS = 5;

export type ProactiveSignalDispatcherCode =
  | "send_succeeded"
  | "runtime_disabled"
  | "stale_delivery"
  | "feedback_suppressed"
  | "max_attempts_exhausted"
  | FeishuInteractiveCardClientErrorClassification;

export type ProactiveSignalDispatcherResult = {
  status: "sent" | "retrying" | "permanent_failure" | "outcome_unknown";
  deliveryId: string;
  code: ProactiveSignalDispatcherCode;
};

export type ProactiveSignalDispatcherDependencies = {
  repository: Pick<ProactiveSignalRepository,
    | "claimProactiveSignalDelivery"
    | "getProactiveSignalDeliveryContext"
    | "beginProactiveSignalDeliveryAttempt"
    | "failProactiveSignalDeliveryPreparation"
    | "completeProactiveSignalDelivery"
    | "failProactiveSignalDelivery"
  >;
  cardClient: Pick<FeishuInteractiveCardClient, "sendCard">;
  renderer?: (input: ProactiveSignalCardRenderInput) => ProactiveSignalCardRenderResult;
  canDeliverProactiveSignals(groupId: string): boolean;
  workerId: string;
  leaseMs: number;
  retryDelayMs: number;
  now?: () => Date;
  agentExecutionObserver?: AgentExecutionObserver;
};

export function createProactiveSignalDispatcher({
  repository,
  cardClient,
  renderer = renderProactiveSignalCard,
  canDeliverProactiveSignals,
  workerId,
  leaseMs,
  retryDelayMs,
  now = () => new Date(),
  agentExecutionObserver,
}: ProactiveSignalDispatcherDependencies) {
  const safeWorkerId = requireIdentifier("workerId", workerId);
  const safeLeaseMs = requirePositiveSafeInteger("leaseMs", leaseMs);
  const safeRetryDelayMs = requirePositiveSafeInteger("retryDelayMs", retryDelayMs);
  return {
    async processBatch({ limit }: { limit: number }): Promise<ProactiveSignalDispatcherResult[]> {
      const results: ProactiveSignalDispatcherResult[] = [];
      for (let index = 0; index < sanitizeLimit(limit); index += 1) {
        const claimedAt = requireDate(now());
        const claim = await repository.claimProactiveSignalDelivery({
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
          canDeliverProactiveSignals,
          retryDelayMs: safeRetryDelayMs,
          now,
          agentExecutionObserver,
        }));
      }
      return results;
    },
  };
}

type DispatchClaimInput = {
  claim: ProactiveSignalDeliveryClaim;
  repository: ProactiveSignalDispatcherDependencies["repository"];
  cardClient: ProactiveSignalDispatcherDependencies["cardClient"];
  renderer: NonNullable<ProactiveSignalDispatcherDependencies["renderer"]>;
  canDeliverProactiveSignals(groupId: string): boolean;
  retryDelayMs: number;
  now: () => Date;
  agentExecutionObserver: AgentExecutionObserver | undefined;
  context?: ProactiveSignalDeliveryContext;
};

async function dispatchClaim(input: DispatchClaimInput): Promise<ProactiveSignalDispatcherResult> {
  let context: ProactiveSignalDeliveryContext | undefined;
  try {
    context = await input.repository.getProactiveSignalDeliveryContext(input.claim.delivery.id);
  } catch {
    throw new Error("proactive signal delivery context unavailable");
  }
  if (!isExactClaimContext(input.claim, context)) return failPreparation(input, "stale_delivery");
  const contextualInput = { ...input, context };
  let rendered: ProactiveSignalCardRenderResult;
  try {
    rendered = input.renderer({ context });
  } catch {
    return failPreparation(contextualInput, "stale_delivery");
  }
  if (!readRuntimeGate(input, context.delivery.groupId)) {
    return failPreparation(contextualInput, "runtime_disabled");
  }
  await observeDeliveryAttempt(contextualInput, "tool_call_started");
  const authorization = await input.repository.beginProactiveSignalDeliveryAttempt({
    deliveryId: context.delivery.id,
    workerId: input.claim.workerId,
    at: requireDate(input.now()),
  });
  if (authorization.status === "suppressed") {
    await observeDeliveryAttempt(
      contextualInput,
      "tool_call_cancelled",
      "feedback_suppressed",
    );
    return {
      status: "permanent_failure",
      deliveryId: context.delivery.id,
      code: "feedback_suppressed",
    };
  }
  if (authorization.status === "stale") {
    return failPreparation(contextualInput, "stale_delivery");
  }
  if (!readRuntimeGate(input, context.delivery.groupId)) {
    return failExternalAttempt(contextualInput, "permanent", "runtime_disabled");
  }

  let sent: { messageId: string };
  try {
    sent = await input.cardClient.sendCard({
      chatId: context.delivery.groupId,
      cardJson: rendered.json,
      uuid: stableDeliveryUuid(context.delivery.id),
    });
  } catch (error) {
    return failFromCardError(contextualInput, error);
  }
  try {
    await input.repository.completeProactiveSignalDelivery({
      deliveryId: context.delivery.id,
      workerId: input.claim.workerId,
      messageId: sent.messageId,
      at: requireDate(input.now()),
    });
  } catch {
    return failExternalAttempt(contextualInput, "outcome_unknown", "outcome_unknown");
  }
  await observeDeliveryAttempt(
    contextualInput,
    "tool_call_completed",
    "send_succeeded",
  );
  return { status: "sent", deliveryId: context.delivery.id, code: "send_succeeded" };
}

function failFromCardError(
  input: DispatchClaimInput,
  error: unknown,
): Promise<ProactiveSignalDispatcherResult> {
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
  input: DispatchClaimInput,
  code: ProactiveSignalDispatcherCode,
): Promise<ProactiveSignalDispatcherResult> {
  await input.repository.failProactiveSignalDeliveryPreparation({
    deliveryId: input.claim.delivery.id,
    workerId: input.claim.workerId,
    errorCode: code,
    at: requireDate(input.now()),
  });
  await observeDeliveryAttempt(input, "tool_call_cancelled", code);
  return {
    status: "permanent_failure",
    deliveryId: input.claim.delivery.id,
    code,
  };
}

async function failExternalAttempt(
  input: DispatchClaimInput,
  classification: "retryable" | "permanent" | "outcome_unknown",
  code: ProactiveSignalDispatcherCode,
): Promise<ProactiveSignalDispatcherResult> {
  const failedAt = requireDate(input.now());
  await input.repository.failProactiveSignalDelivery({
    deliveryId: input.claim.delivery.id,
    workerId: input.claim.workerId,
    classification,
    errorCode: code,
    ...(classification === "retryable"
      ? { retryAt: new Date(failedAt.getTime() + input.retryDelayMs) }
      : {}),
    at: failedAt,
  });
  await observeDeliveryAttempt(input, "tool_call_failed", code, classification);
  return {
    status: classification === "retryable"
      ? "retrying"
      : classification === "permanent" ? "permanent_failure" : "outcome_unknown",
    deliveryId: input.claim.delivery.id,
    code,
  };
}

async function observeDeliveryAttempt(
  input: DispatchClaimInput,
  eventType:
    | "tool_call_started"
    | "tool_call_completed"
    | "tool_call_failed"
    | "tool_call_cancelled",
  code?: ProactiveSignalDispatcherCode,
  classification?: "retryable" | "permanent" | "outcome_unknown",
): Promise<void> {
  if (input.agentExecutionObserver === undefined) {
    return;
  }

  const delivery = input.context?.delivery ?? input.claim.delivery;
  try {
    await input.agentExecutionObserver.observe({
      groupId: delivery.groupId,
      subjectType: "tool_call",
      subjectId: delivery.id,
      eventType,
      phase: eventType === "tool_call_completed" ? "completed" : "external_call",
      toolCallId: delivery.id,
      toolName: "iris.feishu.deliverProactiveSignal",
      ...(eventType === "tool_call_started"
        ? {}
        : {
            outcome: eventType === "tool_call_completed"
              ? "success" as const
              : eventType === "tool_call_cancelled" || code === "runtime_disabled"
                ? "skipped" as const
                : classification === "outcome_unknown"
                  ? "unknown" as const
                  : "error" as const,
          }),
      ...(code === undefined ? {} : { decisionReason: code }),
      operationKey: `proactive-delivery:${createHash("sha256")
        .update([
          delivery.id,
          input.claim.attempts,
          eventType,
          code ?? "started",
        ].join(":"))
        .digest("hex")}`,
      metadata: {
        ...(input.context === undefined
          ? {}
          : { signalType: input.context.candidate.kind }),
        attemptNumber: input.claim.attempts,
      },
      at: requireDate(input.now()),
    });
  } catch {
    // Delivery facts remain authoritative when execution observation is unavailable.
  }
}

function isExactClaimContext(
  claim: ProactiveSignalDeliveryClaim,
  context: ProactiveSignalDeliveryContext | undefined,
): context is ProactiveSignalDeliveryContext {
  if (context === undefined) return false;
  return context.delivery.id === claim.delivery.id &&
    context.delivery.candidateIdempotencyKey === claim.delivery.candidateIdempotencyKey &&
    context.delivery.groupId === claim.delivery.groupId &&
    context.delivery.status === "processing" &&
    context.delivery.status === claim.delivery.status &&
    context.delivery.attemptCount === claim.delivery.attemptCount &&
    context.candidate.idempotencyKey === context.delivery.candidateIdempotencyKey &&
    context.candidate.groupId === context.delivery.groupId &&
    context.candidate.status === "pending";
}

function readRuntimeGate(
  input: DispatchClaimInput,
  groupId: string,
): boolean {
  try {
    return input.canDeliverProactiveSignals(groupId);
  } catch {
    return false;
  }
}

function stableDeliveryUuid(deliveryId: string): string {
  return createHash("sha256")
    .update(`proactive-signal-card:${deliveryId}`)
    .digest("hex")
    .slice(0, 50);
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("proactive signal dispatcher batch limit must be a finite safe-magnitude number");
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
    throw new Error("proactive signal dispatcher time must be valid");
  }
  return new Date(value);
}
