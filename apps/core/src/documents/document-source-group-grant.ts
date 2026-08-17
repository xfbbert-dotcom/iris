export type DocumentSourceGroupGrantState = "active" | "revoked";

export type DocumentSourceGroupGrant = {
  id: string;
  documentSourceId: string;
  grantorGroupId: string;
  granteeGroupId: string;
  state: DocumentSourceGroupGrantState;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type DocumentSourceGroupGrantMutationResult = {
  outcome: "applied" | "already_applied";
  grant: DocumentSourceGroupGrant;
};

export type DocumentSourceGroupGrantStatus = {
  migration0051Applied: boolean;
  active?: number;
  revoked?: number;
  latestUpdatedAt?: Date;
};

export type DocumentSourceGroupGrantRepository = {
  getStatus(): Promise<DocumentSourceGroupGrantStatus>;
  grant(input: {
    documentSourceId: string;
    grantorGroupId: string;
    granteeGroupId: string;
    expectedVersion: number;
    operationKey: string;
    actorRef: string;
    at: Date;
  }): Promise<DocumentSourceGroupGrantMutationResult>;
  revoke(input: {
    grantId: string;
    expectedVersion: number;
    operationKey: string;
    actorRef: string;
    at: Date;
  }): Promise<DocumentSourceGroupGrantMutationResult>;
  findActiveForSourceAndGrantee(input: {
    documentSourceId: string;
    granteeGroupId: string;
  }): Promise<DocumentSourceGroupGrant | undefined>;
  listForSource(input: {
    documentSourceId: string;
    limit: number;
  }): Promise<DocumentSourceGroupGrant[]>;
  findById(grantId: string): Promise<DocumentSourceGroupGrant | undefined>;
  validateExact(input: {
    grantId: string;
    version: number;
    documentSourceId: string;
    grantorGroupId: string;
    granteeGroupId: string;
  }): Promise<boolean>;
};

export class DocumentSourceGroupGrantValidationError extends Error {
  constructor(message = "invalid document source group grant input") {
    super(message);
    this.name = "DocumentSourceGroupGrantValidationError";
  }
}

export class DocumentSourceGroupGrantConflictError extends Error {
  constructor(message = "document source group grant conflict") {
    super(message);
    this.name = "DocumentSourceGroupGrantConflictError";
  }
}

export class DocumentSourceGroupGrantNotFoundError extends Error {
  constructor(message = "document source group grant not found") {
    super(message);
    this.name = "DocumentSourceGroupGrantNotFoundError";
  }
}
