import { createHash } from "node:crypto";

import type { FeishuGroupMembershipChecker } from "../feishu/feishu-group-membership-checker.js";
import type { ApprovalInteractionJob } from "../knowledge-cards/knowledge-card.js";

import type { ProactiveSignalRepository } from "./proactive-signal-repository.js";

const MAX_IDENTIFIER_CHARS = 512;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type ProactiveSignalFeedbackJob = Extract<
  ApprovalInteractionJob,
  { kind: "proactive_signal_feedback" }
>;

export type ProactiveSignalFeedbackWorkerResult = {
  status: "applied" | "already_applied" | "denied" | "retryable";
  code:
    | "feedback_applied"
    | "duplicate_feedback"
    | "runtime_disabled"
    | "bot_actor"
    | "not_current_member"
    | "stale_delivery"
    | "membership_unavailable"
    | "repository_unavailable"
    | "internal_error";
};

export function createProactiveSignalFeedbackWorker({
  repository,
  membershipChecker,
  canProactivelySpeak,
  botOpenId,
  suppressionDays,
  now = () => new Date(),
}: {
  repository: Pick<ProactiveSignalRepository, "recordFeedback" | "validateFeedbackBinding">;
  membershipChecker: FeishuGroupMembershipChecker;
  canProactivelySpeak(groupId: string): boolean;
  botOpenId: string;
  suppressionDays: number;
  now?: () => Date;
}) {
  const safeBotOpenId = requireIdentifier("botOpenId", botOpenId);
  const safeSuppressionDays = requireSuppressionDays(suppressionDays);

  return {
    async processFeedback(
      rawJob: ProactiveSignalFeedbackJob,
    ): Promise<ProactiveSignalFeedbackWorkerResult> {
      let job: ReturnType<typeof normalizeJob>;
      try {
        job = normalizeJob(rawJob);
      } catch {
        return retryable("internal_error");
      }

      const initiallyEnabled = readRuntimeGate(canProactivelySpeak, job.chatId);
      if (initiallyEnabled === undefined) return retryable("internal_error");
      if (!initiallyEnabled) return denied("runtime_disabled");
      if (job.actorOpenId === safeBotOpenId) return denied("bot_actor");

      try {
        const binding = await repository.validateFeedbackBinding({
          deliveryId: job.deliveryId,
          candidateIdempotencyKey: job.candidateIdempotencyKey,
          groupId: job.chatId,
          ...(job.messageId === undefined ? {} : { messageId: job.messageId }),
          entityVersion: job.entityVersion,
        });
        if (binding.status === "stale_binding") return denied("stale_delivery");
      } catch {
        return retryable("repository_unavailable");
      }

      try {
        if (!await membershipChecker.isCurrentMember({
          chatId: job.chatId,
          openId: job.actorOpenId,
        })) {
          return denied("not_current_member");
        }
      } catch {
        return retryable("membership_unavailable");
      }

      const enabledBeforeMutation = readRuntimeGate(canProactivelySpeak, job.chatId);
      if (enabledBeforeMutation === undefined) return retryable("internal_error");
      if (!enabledBeforeMutation) return denied("runtime_disabled");

      let at: Date;
      try {
        at = requireDate(now());
      } catch {
        return retryable("internal_error");
      }
      const suppressUntil = job.action === "irrelevant"
        ? new Date(at.getTime() + safeSuppressionDays * MS_PER_DAY)
        : new Date(at);
      const actorFingerprint = createHash("sha256")
        .update(`${job.appId}:${job.actorOpenId}`, "utf8")
        .digest("hex");

      try {
        const result = await repository.recordFeedback({
          idempotencyKey: job.idempotencyKey,
          deliveryId: job.deliveryId,
          candidateIdempotencyKey: job.candidateIdempotencyKey,
          groupId: job.chatId,
          ...(job.messageId === undefined ? {} : { messageId: job.messageId }),
          entityVersion: job.entityVersion,
          actorFingerprint,
          feedback: job.action,
          suppressUntil,
          at,
        });
        if (result.status === "already_applied") {
          return { status: "already_applied", code: "duplicate_feedback" };
        }
        if (result.status === "stale_binding") return denied("stale_delivery");
        return { status: "applied", code: "feedback_applied" };
      } catch {
        return retryable("repository_unavailable");
      }
    },
  };
}

function normalizeJob(job: ProactiveSignalFeedbackJob) {
  return {
    idempotencyKey: requireIdentifier("idempotencyKey", job.idempotencyKey),
    appId: requireIdentifier("appId", job.appId),
    actorOpenId: requireIdentifier("actorOpenId", job.actorOpenId),
    chatId: requireIdentifier("chatId", job.chatId),
    messageId: job.messageId === undefined
      ? undefined
      : requireIdentifier("messageId", job.messageId),
    deliveryId: requireIdentifier("deliveryId", job.deliveryId),
    candidateIdempotencyKey: requireIdentifier(
      "candidateIdempotencyKey",
      job.candidateIdempotencyKey,
    ),
    entityVersion: requirePositiveSafeInteger("entityVersion", job.entityVersion),
    action: job.action,
  };
}

function readRuntimeGate(
  gate: (groupId: string) => boolean,
  groupId: string,
): boolean | undefined {
  try {
    return gate(groupId) === true;
  } catch {
    return undefined;
  }
}

function denied(
  code: Extract<ProactiveSignalFeedbackWorkerResult["code"],
    "runtime_disabled" | "bot_actor" | "not_current_member" | "stale_delivery">,
): ProactiveSignalFeedbackWorkerResult {
  return { status: "denied", code };
}

function retryable(
  code: Extract<ProactiveSignalFeedbackWorkerResult["code"],
    "membership_unavailable" | "repository_unavailable" | "internal_error">,
): ProactiveSignalFeedbackWorkerResult {
  return { status: "retryable", code };
}

function requireIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_IDENTIFIER_CHARS) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function requirePositiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} is invalid`);
  return value;
}

function requireSuppressionDays(value: number): number {
  const days = requirePositiveSafeInteger("suppressionDays", value);
  if (days > 365) throw new Error("suppressionDays is invalid");
  return days;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("feedback time is invalid");
  }
  return new Date(value);
}
