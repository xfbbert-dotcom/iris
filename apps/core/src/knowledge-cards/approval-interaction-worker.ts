import type { FeishuGroupMembershipChecker } from "../feishu/feishu-group-membership-checker.js";
import type { FeishuInteractiveCardClient } from "../feishu/feishu-interactive-card-client.js";
import { KnowledgeDraftEvidenceError } from "../knowledge-governance/postgres-knowledge-draft-evidence.js";

import type { ApprovalInteractionQueue } from "./approval-interaction-queue.js";
import type { ApprovalInteractionJob } from "./knowledge-card.js";
import { renderKnowledgeCardCommittedResult } from "./knowledge-card-renderer.js";
import type {
  ApplyKnowledgeCardInteractionInput,
  KnowledgeCardInteractionResult,
  KnowledgeCardRepository,
  KnowledgeDraftPresentation,
} from "./knowledge-card-repository.js";
import {
  KnowledgeCardMembershipProofError,
  KnowledgeCardOperationConflictError,
  KnowledgeCardPersistenceConflictError,
  KnowledgeCardPresentationNotFoundError,
} from "./postgres-knowledge-card-repository.js";

const MAX_BATCH_LIMIT = 100;
const MAX_LEASE_MS = 2_147_483_647;

export type ApprovalInteractionWorkerResult = {
  status: "applied" | "already_applied" | "denied" | "retrying" | "dead_lettered";
  idempotencyKey: string;
  code: ApprovalInteractionWorkerCode;
};

export type ApprovalInteractionWorkerCode =
  | "action_applied"
  | "duplicate_callback"
  | "runtime_disabled"
  | "bot_actor"
  | "not_current_member"
  | "stale_presentation"
  | "invalid_membership_evidence"
  | "evidence_invalidated"
  | "membership_unavailable"
  | "repository_unavailable"
  | "redis_unavailable"
  | "internal_error";

export type ApprovalInteractionWorkerDependencies = {
  queue: Pick<ApprovalInteractionQueue, "claimBatch" | "acknowledge" | "handleFailure">;
  repository: Pick<KnowledgeCardRepository, "getPresentation" | "applyInteraction">;
  membershipChecker: FeishuGroupMembershipChecker;
  cardClient: Pick<FeishuInteractiveCardClient, "updateCard">;
  canUseKnowledgeCards(groupId: string): boolean;
  botOpenId: string;
  workerId: string;
  leaseMs: number;
  now?: () => Date;
};

export function createApprovalInteractionWorker({
  queue,
  repository,
  membershipChecker,
  cardClient,
  canUseKnowledgeCards,
  botOpenId,
  workerId,
  leaseMs,
  now = () => new Date(),
}: ApprovalInteractionWorkerDependencies) {
  const safeBotOpenId = requireIdentifier("botOpenId", botOpenId);
  const safeWorkerId = requireIdentifier("workerId", workerId);
  const safeLeaseMs = requirePositiveSafeInteger("leaseMs", leaseMs, MAX_LEASE_MS);

  return {
    async processBatch({ limit }: { limit: number }): Promise<ApprovalInteractionWorkerResult[]> {
      const claimedAt = requireDate(now());
      const jobs = await queue.claimBatch({
        limit: sanitizeLimit(limit),
        workerId: safeWorkerId,
        now: claimedAt,
        leaseUntil: new Date(claimedAt.getTime() + safeLeaseMs),
      });
      const results: ApprovalInteractionWorkerResult[] = [];
      for (const job of jobs) {
        results.push(await processJob({
          job,
          queue,
          repository,
          membershipChecker,
          cardClient,
          canUseKnowledgeCards,
          botOpenId: safeBotOpenId,
          workerId: safeWorkerId,
          now,
        }));
      }
      return results;
    },
  };
}

async function processJob(input: {
  job: ApprovalInteractionJob;
  queue: Pick<ApprovalInteractionQueue, "acknowledge" | "handleFailure">;
  repository: Pick<KnowledgeCardRepository, "getPresentation" | "applyInteraction">;
  membershipChecker: FeishuGroupMembershipChecker;
  cardClient: Pick<FeishuInteractiveCardClient, "updateCard">;
  canUseKnowledgeCards(groupId: string): boolean;
  botOpenId: string;
  workerId: string;
  now: () => Date;
}): Promise<ApprovalInteractionWorkerResult> {
  const { job } = input;
  let presentation: KnowledgeDraftPresentation | undefined;

  const initiallyEnabled = readRuntimeGate(input.canUseKnowledgeCards, job.chatId);
  if (initiallyEnabled === undefined) {
    return handleTransientFailure(input, "internal_error");
  }
  if (!initiallyEnabled) {
    return denyAndAcknowledge(input, "runtime_disabled", job.messageId);
  }

  try {
    presentation = await input.repository.getPresentation(job.presentationId);
  } catch {
    return handleTransientFailure(input, "repository_unavailable");
  }
  if (!isExactActivePresentation(presentation, job)) {
    return denyAndAcknowledge(input, "stale_presentation", presentation?.messageId ?? job.messageId);
  }

  if (job.actorOpenId === input.botOpenId) {
    return denyAndAcknowledge(input, "bot_actor", presentation.messageId);
  }

  let isCurrentMember: boolean;
  try {
    isCurrentMember = await input.membershipChecker.isCurrentMember({
      chatId: job.chatId,
      openId: job.actorOpenId,
    });
  } catch {
    return handleTransientFailure(input, "membership_unavailable");
  }
  if (!isCurrentMember) {
    return denyAndAcknowledge(input, "not_current_member", presentation.messageId);
  }

  const enabledBeforeMutation = readRuntimeGate(input.canUseKnowledgeCards, job.chatId);
  if (enabledBeforeMutation === undefined) {
    return handleTransientFailure(input, "internal_error");
  }
  if (!enabledBeforeMutation) {
    return denyAndAcknowledge(input, "runtime_disabled", presentation.messageId);
  }

  const membershipCheckedAt = requireDate(input.now());
  let mutation: KnowledgeCardInteractionResult;
  try {
    mutation = await input.repository.applyInteraction(toRepositoryInput(
      job,
      membershipCheckedAt,
      requireDate(input.now()),
    ));
  } catch (error) {
    const stableCode = classifyStableRepositoryDenial(error);
    if (stableCode !== undefined) {
      return denyAndAcknowledge(input, stableCode, presentation.messageId);
    }
    return handleTransientFailure(input, "repository_unavailable");
  }

  const code = mutation.outcome === "already_applied" ? "duplicate_callback" : "action_applied";
  await attemptBoundedCardUpdate(
    input.cardClient,
    mutation.presentation.messageId ?? presentation.messageId,
    () => renderKnowledgeCardCommittedResult({
      presentation: mutation.presentation,
      draft: mutation.draft,
      result: mutation.committedResult,
    }),
  );
  const ackFailure = await acknowledge(input);
  if (ackFailure !== undefined) return ackFailure;
  return {
    status: mutation.outcome,
    idempotencyKey: job.idempotencyKey,
    code,
  };
}

function toRepositoryInput(
  job: ApprovalInteractionJob,
  membershipCheckedAt: Date,
  at: Date,
): ApplyKnowledgeCardInteractionInput {
  const common = {
    presentationId: job.presentationId,
    draftId: job.draftId,
    revisionNumber: job.revisionNumber,
    draftVersion: job.draftVersion,
    chatId: job.chatId,
    eventId: job.eventId,
    actorOpenId: job.actorOpenId,
    membershipCheckedAt,
    at,
  };
  if (job.action === "confirm") return { ...common, action: "confirm" };
  if (job.action === "request_revision") {
    return { ...common, action: "request_revision", reason: requireJobReason(job.reason) };
  }
  return {
    ...common,
    action: "reject",
    reason: requireJobReason(job.reason),
    rejectionConfirmed: true,
  };
}

function isExactActivePresentation(
  presentation: KnowledgeDraftPresentation | undefined,
  job: ApprovalInteractionJob,
): presentation is KnowledgeDraftPresentation & { messageId: string } {
  return presentation !== undefined &&
    presentation.state === "active" &&
    presentation.id === job.presentationId &&
    presentation.draftId === job.draftId &&
    presentation.revisionNumber === job.revisionNumber &&
    presentation.draftVersion === job.draftVersion &&
    presentation.chatId === job.chatId &&
    presentation.messageId !== undefined &&
    (job.messageId === undefined || job.messageId === presentation.messageId);
}

function classifyStableRepositoryDenial(
  error: unknown,
): Extract<ApprovalInteractionWorkerCode,
  "stale_presentation" | "invalid_membership_evidence" | "evidence_invalidated" | "duplicate_callback"
> | undefined {
  if (error instanceof KnowledgeCardOperationConflictError) return "duplicate_callback";
  if (error instanceof KnowledgeCardMembershipProofError) return "invalid_membership_evidence";
  if (error instanceof KnowledgeDraftEvidenceError) return "evidence_invalidated";
  if (
    error instanceof KnowledgeCardPersistenceConflictError ||
    error instanceof KnowledgeCardPresentationNotFoundError
  ) return "stale_presentation";
  return undefined;
}

async function denyAndAcknowledge(
  input: Parameters<typeof processJob>[0],
  code: Extract<ApprovalInteractionWorkerCode,
    | "runtime_disabled"
    | "bot_actor"
    | "not_current_member"
    | "stale_presentation"
    | "invalid_membership_evidence"
    | "evidence_invalidated"
    | "duplicate_callback"
  >,
  messageId: string | undefined,
): Promise<ApprovalInteractionWorkerResult> {
  await attemptBoundedCardUpdate(input.cardClient, messageId, () => renderStatusCard(code));
  const ackFailure = await acknowledge(input);
  if (ackFailure !== undefined) return ackFailure;
  return { status: "denied", idempotencyKey: input.job.idempotencyKey, code };
}

async function acknowledge(
  input: Parameters<typeof processJob>[0],
): Promise<ApprovalInteractionWorkerResult | undefined> {
  try {
    await input.queue.acknowledge({ job: input.job, workerId: input.workerId });
    return undefined;
  } catch {
    return handleTransientFailure(input, "redis_unavailable");
  }
}

async function handleTransientFailure(
  input: Parameters<typeof processJob>[0],
  code: Extract<ApprovalInteractionWorkerCode,
    "membership_unavailable" | "repository_unavailable" | "redis_unavailable" | "internal_error"
  >,
): Promise<ApprovalInteractionWorkerResult> {
  const failure = await input.queue.handleFailure({
    job: input.job,
    workerId: input.workerId,
    errorCode: code,
    at: requireDate(input.now()),
  });
  return {
    status: failure.action === "dead_lettered" ? "dead_lettered" : "retrying",
    idempotencyKey: input.job.idempotencyKey,
    code,
  };
}

async function attemptBoundedCardUpdate(
  cardClient: Pick<FeishuInteractiveCardClient, "updateCard">,
  messageId: string | undefined,
  renderCard: () => string,
): Promise<void> {
  if (messageId === undefined) return;
  try {
    await cardClient.updateCard({ messageId, cardJson: renderCard() });
  } catch {
    // Stable denials are not retried, and committed actions already have a PG result outbox.
  }
}

export function renderApprovalInteractionStatusCard(code: ApprovalInteractionWorkerCode): string {
  return renderStatusCard(code);
}

function renderStatusCard(code: ApprovalInteractionWorkerCode): string {
  const content: Record<ApprovalInteractionWorkerCode, string> = {
    action_applied: "Knowledge draft action recorded.",
    duplicate_callback: "This action was already processed.",
    runtime_disabled: "Knowledge card actions are currently disabled.",
    bot_actor: "Iris cannot approve its own knowledge draft.",
    not_current_member: "Only current group members can review this draft.",
    stale_presentation: "This draft changed. Use the latest knowledge card.",
    invalid_membership_evidence: "Membership verification expired. Try again.",
    evidence_invalidated: "This draft can no longer be reviewed because its evidence changed.",
    membership_unavailable: "Membership could not be verified. Try again later.",
    repository_unavailable: "The action could not be recorded. Try again later.",
    redis_unavailable: "The action could not be queued. Try again later.",
    internal_error: "The action could not be processed. Try again later.",
  };
  return JSON.stringify({
    schema: "2.0",
    header: {
      template: code === "action_applied" ? "green" : "grey",
      title: { tag: "plain_text", content: "Knowledge draft review" },
    },
    body: { elements: [{ tag: "markdown", content: content[code] }] },
  });
}

function readRuntimeGate(
  canUseKnowledgeCards: (groupId: string) => boolean,
  groupId: string,
): boolean | undefined {
  try {
    return canUseKnowledgeCards(groupId);
  } catch {
    return undefined;
  }
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("approval interaction batch limit must be a finite safe-magnitude number");
  }
  return Math.min(MAX_BATCH_LIMIT, Math.max(0, Math.floor(value)));
}

function requirePositiveSafeInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function requireIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireJobReason(value: string | undefined): string {
  if (value === undefined) throw new Error("normalized approval action reason is missing");
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("approval interaction worker time must be a valid date");
  }
  return new Date(value);
}
