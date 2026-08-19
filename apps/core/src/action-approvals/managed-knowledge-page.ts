import { createHash } from "node:crypto";

export const MANAGED_KNOWLEDGE_PAGE_STATES = [
  "active", "updating", "resync_required", "reconciliation_required", "blocked", "retired",
] as const;
export const MANAGED_KNOWLEDGE_UPDATE_EXECUTION_STATES = [
  "claimed", "preflight_failed", "remote_request_dispatched", "outcome_unknown", "remote_applied",
  "resync_required", "succeeded", "failed", "reconciliation_required",
] as const;

export type ManagedKnowledgePageState = (typeof MANAGED_KNOWLEDGE_PAGE_STATES)[number];
export type ManagedKnowledgeUpdateExecutionState =
  (typeof MANAGED_KNOWLEDGE_UPDATE_EXECUTION_STATES)[number];

export type ManagedKnowledgePage = {
  id: string;
  originKnowledgePublicationId: string;
  targetPolicyId: string;
  targetPolicyVersion: number;
  authorizationGroupId: string;
  remoteNodeToken: string;
  remoteDocumentToken: string;
  managedBodyBlockId: string;
  linkedDocumentSourceId?: string;
  currentRemoteRevisionId?: string;
  currentBodyContentHash?: string;
  expectedResyncContentHash?: string;
  state: ManagedKnowledgePageState;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ManagedKnowledgeUpdateTarget = {
  id: string;
  draftId: string;
  draftRevision: number;
  draftVersion: number;
  conflictCandidateId: string;
  conflictCandidateVersion: number;
  managedPageId: string;
  managedPageVersion: number;
  linkedDocumentSourceId: string;
  targetSnapshotId: string;
  targetSnapshotHash: string;
  targetSourceVersion?: string;
  remoteDocumentToken: string;
  managedBodyBlockId: string;
  expectedRemoteRevisionId: string;
  currentBodyContentHash: string;
  proposedBodyContentHash: string;
  authorizationGroupId: string;
  targetPolicyId: string;
  targetPolicyVersion: number;
  operationKey: string;
  createdAt: Date;
};

export type ManagedSnapshotObservation = {
  id: string;
  managedPageId: string;
  managedPageVersion: number;
  documentSnapshotId: string;
  documentSourceId: string;
  snapshotContentHash: string;
  observedRemoteRevisionId: string;
  observedManagedBodyBlockId: string;
  observedBlockType: "text";
  managedBodyContentHash: string;
  adapterVersion: string;
  observedAt: Date;
};

export type ManagedKnowledgeUpdateExecution = {
  id: string;
  proposalId: string;
  managedPageId: string;
  managedPageVersion: number;
  updateTargetId: string;
  attemptNumber: number;
  state: ManagedKnowledgeUpdateExecutionState;
  operationKey: string;
  requestFingerprint: string;
  expectedRemoteRevisionId: string;
  beforeBodyContentHash: string;
  afterBodyContentHash: string;
  clientToken: string;
  responseRevisionId?: string;
  responseClassification?: string;
  reconciliationReasonCode?: string;
  remoteRequestDispatchedAt?: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ManagedKnowledgePageEvent = {
  id: string;
  managedPageId: string;
  eventType: "registered" | "source_linked" | "update_claimed" | "remote_outcome_confirmed" |
    "resync_completed" | "reconciliation_required" | "blocked" | "retired" | "reactivated";
  fromVersion?: number;
  toVersion: number;
  operationKey: string;
  actor?: string;
  reasonCode?: string;
  createdAt: Date;
};

export type ManagedKnowledgeUpdateExecutionEvent = {
  id: string;
  executionId: string;
  eventType: string;
  fromVersion?: number;
  toVersion: number;
  operationKey: string;
  reasonCode?: string;
  createdAt: Date;
};

export type ManagedKnowledgeUpdateStatusCounts = Record<ManagedKnowledgeUpdateExecutionState, number>;

export function canonicalManagedBody(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if ([...normalized].length < 1 || [...normalized].length > 200_000) {
    throw new Error("managed body length is invalid");
  }
  return normalized;
}

export function canonicalManagedBodyHash(value: string): string {
  return createHash("sha256").update(canonicalManagedBody(value)).digest("hex");
}

export function normalizeManagedKnowledgePage(value: ManagedKnowledgePage): ManagedKnowledgePage {
  const page = value as Record<string, unknown>;
  const state = requireEnum("state", page.state, MANAGED_KNOWLEDGE_PAGE_STATES);
  const normalized: ManagedKnowledgePage = {
    id: requireReference("id", page.id),
    originKnowledgePublicationId: requireReference("originKnowledgePublicationId", page.originKnowledgePublicationId),
    targetPolicyId: requireReference("targetPolicyId", page.targetPolicyId),
    targetPolicyVersion: requirePositiveInteger("targetPolicyVersion", page.targetPolicyVersion),
    authorizationGroupId: requireReference("authorizationGroupId", page.authorizationGroupId),
    remoteNodeToken: requireReference("remoteNodeToken", page.remoteNodeToken),
    remoteDocumentToken: requireReference("remoteDocumentToken", page.remoteDocumentToken),
    managedBodyBlockId: requireReference("managedBodyBlockId", page.managedBodyBlockId),
    ...(page.linkedDocumentSourceId === undefined ? {} : {
      linkedDocumentSourceId: requireReference("linkedDocumentSourceId", page.linkedDocumentSourceId),
    }),
    ...(page.currentRemoteRevisionId === undefined ? {} : {
      currentRemoteRevisionId: requireReference("currentRemoteRevisionId", page.currentRemoteRevisionId),
    }),
    ...(page.currentBodyContentHash === undefined ? {} : {
      currentBodyContentHash: requireHash("currentBodyContentHash", page.currentBodyContentHash),
    }),
    ...(page.expectedResyncContentHash === undefined ? {} : {
      expectedResyncContentHash: requireHash("expectedResyncContentHash", page.expectedResyncContentHash),
    }),
    state,
    version: requirePositiveInteger("version", page.version),
    createdAt: requireDate("createdAt", page.createdAt),
    updatedAt: requireDate("updatedAt", page.updatedAt),
  };
  const hasExactIdentity = normalized.currentRemoteRevisionId !== undefined &&
    normalized.currentBodyContentHash !== undefined;
  if (state === "active" && !hasExactIdentity) {
    throw new Error("active page requires currentRemoteRevisionId and currentBodyContentHash");
  }
  if (["updating", "resync_required", "reconciliation_required"].includes(state) && !hasExactIdentity) {
    throw new Error(`${state} page requires currentRemoteRevisionId and currentBodyContentHash`);
  }
  if (state === "resync_required" && normalized.expectedResyncContentHash === undefined) {
    throw new Error("resync_required page requires expectedResyncContentHash");
  }
  return normalized;
}

function requireReference(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if ([...normalized].length < 1 || [...normalized].length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} is invalid`);
  return Number(value);
}

function requireHash(name: string, value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requireDate(name: string, value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${name} is invalid`);
  return value;
}

function requireEnum<T extends readonly string[]>(name: string, value: unknown, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${name} is invalid`);
  return value as T[number];
}
