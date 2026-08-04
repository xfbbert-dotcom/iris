import type { ApprovalInteractionIntentIdentity } from "./knowledge-card.js";

export type ApprovalInteractionIntent = {
  id: string;
  reason: string;
  rejectionConfirmed?: true;
};

export type PersistApprovalInteractionIntentInput = {
  interaction: ApprovalInteractionIntentIdentity;
  reason: string;
  rejectionConfirmed?: true;
  at: Date;
};

export interface ApprovalInteractionIntentStore {
  persistIntent(input: PersistApprovalInteractionIntentInput): Promise<{ id: string }>;
  resolveIntent(input: {
    id: string;
    interaction: ApprovalInteractionIntentIdentity;
  }): Promise<ApprovalInteractionIntent | undefined>;
  deleteIntent(id: string): Promise<void>;
}

export class ApprovalInteractionIntentConflictError extends Error {
  constructor() {
    super("approval interaction intent conflict");
    this.name = "ApprovalInteractionIntentConflictError";
  }
}
