import type {
  KnowledgeConflictConfirmationAction,
  KnowledgeConflictConfirmationInteractionJob,
} from "../knowledge-cards/knowledge-card.js";

export type PersistKnowledgeConflictCallbackIdentityInput = {
  idempotencyKey: string;
  eventId: string;
  appId: string;
  actorOpenId: string;
  chatId: string;
  messageId: string;
  presentationId: string;
  candidateId: string;
  candidateVersion: number;
  groupId: string;
  nonce: string;
  action: KnowledgeConflictConfirmationAction;
  receivedAt: Date;
};

export type KnowledgeConflictAuthenticatedContext = Pick<
  PersistKnowledgeConflictCallbackIdentityInput,
  "eventId" | "appId" | "actorOpenId" | "chatId" | "messageId"
>;

export type AuthenticatedKnowledgeConflictConfirmationInteraction =
  Omit<
    KnowledgeConflictConfirmationInteractionJob,
    "eventId" | "appId" | "actorOpenId" | "chatId" | "messageId"
  > & KnowledgeConflictAuthenticatedContext;

export interface KnowledgeConflictCallbackIdentityStore {
  persistIdentity(input: PersistKnowledgeConflictCallbackIdentityInput): Promise<{ id: string }>;
  resolveIdentity(input: {
    id: string;
    interaction: KnowledgeConflictConfirmationInteractionJob;
  }): Promise<KnowledgeConflictAuthenticatedContext | undefined>;
}

export class KnowledgeConflictCallbackIdentityConflictError extends Error {
  constructor() {
    super("knowledge conflict callback identity conflict");
    this.name = "KnowledgeConflictCallbackIdentityConflictError";
  }
}
