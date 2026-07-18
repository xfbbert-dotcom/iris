import type { ApprovalInteractionJob } from "./knowledge-card.js";

export type ApprovalInteractionJobDeadLetter = {
  id: string;
  job: ApprovalInteractionJob;
  errorCode: string;
  failedAt: Date;
  replayable: true;
};

export type ApprovalInteractionInvalidPayloadDeadLetter = {
  id: string;
  payloadDigest: string;
  payloadBytes: number;
  errorCode: "invalid_queue_payload";
  failedAt: Date;
  replayable: false;
};

export type ApprovalInteractionDeadLetter =
  | ApprovalInteractionJobDeadLetter
  | ApprovalInteractionInvalidPayloadDeadLetter;

export interface ApprovalInteractionQueue {
  enqueue(job: ApprovalInteractionJob): Promise<"enqueued" | "duplicate">;
  claimBatch(input: {
    limit: number;
    workerId: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<ApprovalInteractionJob[]>;
  acknowledge(input: { job: ApprovalInteractionJob; workerId: string }): Promise<void>;
  handleFailure(input: {
    job: ApprovalInteractionJob;
    workerId: string;
    errorCode: string;
    at: Date;
  }): Promise<{ action: "delayed" | "dead_lettered" }>;
  getCounts(): Promise<{
    pending: number;
    processing: number;
    delayed: number;
    deadLetter: number;
  }>;
  listDeadLetters(input: { limit: number }): Promise<ApprovalInteractionDeadLetter[]>;
  replayDeadLetter(id: string): Promise<"replayed" | "not_found">;
  deleteDeadLetter(id: string): Promise<"deleted" | "not_found">;
}
