import type { LocalMessageSourceBinding } from "../memory/local-message-source.js";
import type { PdAssessment, PdContext, PdDelivery, PdDraft, PdIssue, PdJob, PdPolicy, PdStatus } from "./contracts.js";

export interface PdRepository {
  resumeByOperator(input: { chatId: string; issueId: string; expectedVersion: number; operatorId: string; at: Date }): Promise<"applied" | "conflict" | "blocked">;
  readDelivery(deliveryId: string): Promise<(PdDelivery & { version: number; replyMessageId: string | null }) | null>;
  setPolicy(input: { policy: PdPolicy; expectedVersion: number; at: Date }): Promise<"applied" | "conflict">;
  register(input: {
    chatId: string; messageId: string; contentHash: string; policyVersion: number;
    purpose: PdJob["purpose"]; feedback?: PdJob["feedback"]; at: Date;
  }): Promise<"registered" | "duplicate" | "blocked">;
  readState(chatId: string): Promise<{
    policy: PdPolicy | null; contextVersion: number; catalogVersion: number; issues: PdIssue[];
  }>;
  claimEvaluation(input: { workerId: string; at: Date; leaseUntil: Date }): Promise<PdJob | null>;
  renewEvaluation(input: { job: PdJob; at: Date; leaseUntil: Date }): Promise<boolean>;
  commitEvaluation(input: {
    job: PdJob; context: PdContext; assessment: PdAssessment; draft: PdDraft | null; at: Date;
  }): Promise<"prepared" | "skipped" | "stale" | "lease_lost" | "blocked">;
  failEvaluation(input: { job: PdJob; reason: string; retryable: boolean; at: Date }): Promise<void>;
  requeueEvaluation(input: { job: PdJob; at: Date }): Promise<void>;
  applyFeedback(input: {
    job: PdJob; action: "pause" | "resume"; issueId: string;
    expectedIssueVersion: number; verifiedReplyMessageId: string;
    actorOpenId: string; verifiedMessage: LocalMessageSourceBinding; at: Date;
  }): Promise<"applied" | "duplicate" | "blocked">;
  findIssueByReply(input: { chatId: string; replyMessageId: string }): Promise<PdIssue | null>;
  claimDelivery(input: { workerId: string; at: Date; leaseUntil: Date }): Promise<PdClaimedDelivery | null>;
  beginSend(input: { delivery: PdClaimedDelivery; checkedContextVersion: number; at: Date }): Promise<"sending" | "stale" | "blocked">;
  cancelDelivery(input: { delivery: PdDelivery; reason: string; at: Date }): Promise<void>;
  finishSend(input: {
    delivery: PdDelivery; outcome: "sent" | "outcome_unknown";
    replyMessageId?: string; reason?: string; at: Date;
  }): Promise<void>;
  reconcile(input: {
    deliveryId: string; expectedVersion: number; operatorId: string;
    outcome: "sent" | "not_sent"; replyMessageId?: string; evidence: string; at: Date;
  }): Promise<"applied" | "conflict" | "blocked">;
  getStatus(): Promise<PdStatus>;
}

// Claim-local runtime proof, never fabricated for an ordinary read-only DTO.
export type PdClaimedDelivery = PdDelivery & { checkedRuntimeRevision: number };

// Evaluation/feedback and send transitions are supplied by later implementation
// tasks. The foundation factory never advertises methods it does not implement.
export type PdFoundationRepository = Pick<PdRepository,
  "setPolicy" | "register" | "readState" | "claimEvaluation" | "failEvaluation" | "getStatus">;

export type PdEvaluationRepository = PdFoundationRepository & Pick<PdRepository,
  "commitEvaluation" | "requeueEvaluation" | "applyFeedback" | "findIssueByReply" | "renewEvaluation">;

export class PdCatalogCapacityError extends Error {
  readonly code = "proactive_discussion_catalog_degraded";
  constructor() { super("proactive discussion catalog exceeds 100 issues; evaluation is degraded"); }
}
