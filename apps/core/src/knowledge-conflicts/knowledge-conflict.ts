export const KNOWLEDGE_CONFLICT_OUTCOMES = [
  "conflict", "no_conflict", "insufficient_evidence",
] as const;
export const KNOWLEDGE_CONFLICT_CANDIDATE_STATUSES = [
  "pending_review", "dismissed", "approved_for_delivery",
  "delivered", "draft_created", "superseded",
] as const;
export const KNOWLEDGE_CONFLICT_SCAN_STATUSES = [
  "pending", "processing", "retry", "completed", "dead_lettered",
] as const;
export const KNOWLEDGE_CONFLICT_DELIVERY_STATUSES = [
  "pending", "processing", "external_attempting", "sent",
  "failed", "outcome_unknown", "cancelled",
] as const;

export const KNOWLEDGE_CONFLICT_SUBJECT_MAX_CHARS = 256;
export const KNOWLEDGE_CONFLICT_STATEMENT_MAX_CHARS = 4_000;
export const KNOWLEDGE_CONFLICT_REFERENCE_MAX_CHARS = 512;
export const KNOWLEDGE_CONFLICT_MAX_MISSING_EVIDENCE = 20;

export type KnowledgeConflictOutcome = (typeof KNOWLEDGE_CONFLICT_OUTCOMES)[number];
export type KnowledgeConflictCandidateStatus =
  (typeof KNOWLEDGE_CONFLICT_CANDIDATE_STATUSES)[number];
export type KnowledgeConflictScanStatus = (typeof KNOWLEDGE_CONFLICT_SCAN_STATUSES)[number];
export type KnowledgeConflictDeliveryStatus =
  (typeof KNOWLEDGE_CONFLICT_DELIVERY_STATUSES)[number];
export type KnowledgeConflictConfidence = "high" | "medium" | "low";
export type KnowledgeConflictMessageReference =
  `C${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;
export type KnowledgeConflictMemoryReference = "M1";
export type KnowledgeConflictDocumentReference =
  `D${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`;

export type KnowledgeConflictPlan = {
  outcome: "conflict" | "no_conflict" | "insufficient_evidence";
  subject: string;
  knowledgeBaseStatement: string | null;
  knowledgeBaseCitationRefs: string[];
  groupConclusionStatement: string | null;
  groupCitationRefs: string[];
  difference: string | null;
  suggestedUpdate: string | null;
  targetDocumentRef: string | null;
  missingEvidence: string[];
  confidence: "high" | "medium" | "low";
};

export type KnowledgeConflictEvidenceReference =
  | {
      type: "conversation_message";
      referenceId: KnowledgeConflictMessageReference;
      groupId: string;
      conversationMessageId: string;
    }
  | {
      type: "group_memory";
      referenceId: KnowledgeConflictMemoryReference;
      groupId: string;
      groupMemoryId: string;
      expectedUpdatedAt: Date;
    }
  | {
      type: "document_source";
      referenceId: KnowledgeConflictDocumentReference;
      documentSourceId: string;
      expectedUpdatedAt: Date;
    }
  | {
      type: "document_snapshot";
      referenceId: KnowledgeConflictDocumentReference;
      documentSourceId: string;
      documentSnapshotId: string;
      contentHash: string;
    }
  | {
      type: "document_fragment";
      referenceId: KnowledgeConflictDocumentReference;
      documentSourceId: string;
      documentSnapshotId: string;
      documentFragmentId: string;
      snapshotContentHash: string;
      contentHash: string;
    };

export type KnowledgeConflictCandidate = {
  id: string;
  idempotencyKey: string;
  groupId: string;
  groupMemoryId: string;
  memoryUpdatedAt: Date;
  sourceMessageId: string;
  targetDocumentSourceId: string;
  targetSourceUpdatedAt: Date;
  targetSourceVersion?: string;
  targetSnapshotId: string;
  targetContentHash: string;
  detectorContractVersion: string;
  status: KnowledgeConflictCandidateStatus;
  plan: KnowledgeConflictPlan & { outcome: "conflict" };
  evidence: KnowledgeConflictEvidenceReference[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export class KnowledgeConflictValidationError extends Error {
  constructor(message: string) {
    super(`knowledge conflict plan invalid: ${message}`);
    this.name = "KnowledgeConflictValidationError";
  }
}

const PLAN_FIELDS = [
  "confidence",
  "difference",
  "groupCitationRefs",
  "groupConclusionStatement",
  "knowledgeBaseCitationRefs",
  "knowledgeBaseStatement",
  "missingEvidence",
  "outcome",
  "subject",
  "suggestedUpdate",
  "targetDocumentRef",
] as const;
const DOCUMENT_REF = /^D(?:[1-9]|1[0-2])$/u;
const SOURCE_MESSAGE_REF = /^C(?:[1-9]|10)$/u;
const GROUP_MEMORY_REF = /^M1$/u;
const CONFIDENCES = ["high", "medium", "low"] as const;

export function parseKnowledgeConflictPlan(
  json: string,
  availableReferenceIds: ReadonlySet<string>,
): KnowledgeConflictPlan {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw invalid("JSON is invalid");
  }
  if (!isRecord(value)) throw invalid("plan must be an object");
  const keys = Object.keys(value).sort();
  if (keys.length !== PLAN_FIELDS.length
    || keys.some((key, index) => key !== PLAN_FIELDS[index])) {
    throw invalid("plan must contain the exact fields");
  }

  if (!KNOWLEDGE_CONFLICT_OUTCOMES.includes(value.outcome as KnowledgeConflictOutcome)) {
    throw invalid("outcome is invalid");
  }
  if (!CONFIDENCES.includes(value.confidence as KnowledgeConflictConfidence)) {
    throw invalid("confidence is invalid");
  }
  const plan: KnowledgeConflictPlan = {
    outcome: value.outcome as KnowledgeConflictOutcome,
    subject: requireString("subject", value.subject, KNOWLEDGE_CONFLICT_SUBJECT_MAX_CHARS),
    knowledgeBaseStatement: optionalString(
      "knowledgeBaseStatement",
      value.knowledgeBaseStatement,
      KNOWLEDGE_CONFLICT_STATEMENT_MAX_CHARS,
    ),
    knowledgeBaseCitationRefs: normalizeRefs(
      "knowledgeBaseCitationRefs",
      value.knowledgeBaseCitationRefs,
      DOCUMENT_REF,
      availableReferenceIds,
    ),
    groupConclusionStatement: optionalString(
      "groupConclusionStatement",
      value.groupConclusionStatement,
      KNOWLEDGE_CONFLICT_STATEMENT_MAX_CHARS,
    ),
    groupCitationRefs: normalizeRefs(
      "groupCitationRefs",
      value.groupCitationRefs,
      /^(?:M1|C(?:[1-9]|10))$/u,
      availableReferenceIds,
    ),
    difference: optionalString(
      "difference",
      value.difference,
      KNOWLEDGE_CONFLICT_STATEMENT_MAX_CHARS,
    ),
    suggestedUpdate: optionalString(
      "suggestedUpdate",
      value.suggestedUpdate,
      KNOWLEDGE_CONFLICT_STATEMENT_MAX_CHARS,
    ),
    targetDocumentRef: optionalReference("targetDocumentRef", value.targetDocumentRef),
    missingEvidence: normalizeMissingEvidence(value.missingEvidence),
    confidence: value.confidence as KnowledgeConflictConfidence,
  };

  requireStatementCitationPair(
    "knowledgeBaseStatement",
    plan.knowledgeBaseStatement,
    plan.knowledgeBaseCitationRefs,
  );
  requireStatementCitationPair(
    "groupConclusionStatement",
    plan.groupConclusionStatement,
    plan.groupCitationRefs,
  );
  if (plan.outcome === "conflict") requireConflictPlan(plan);
  else requireNonConflictPlan(plan);
  return plan;
}

function requireConflictPlan(plan: KnowledgeConflictPlan): void {
  if (plan.knowledgeBaseStatement === null || plan.knowledgeBaseCitationRefs.length < 1) {
    throw invalid("conflict requires document evidence");
  }
  if (plan.groupConclusionStatement === null) {
    throw invalid("conflict requires a group conclusion");
  }
  if (!plan.groupCitationRefs.some((ref) => GROUP_MEMORY_REF.test(ref))) {
    throw invalid("conflict requires the group-memory reference");
  }
  if (!plan.groupCitationRefs.some((ref) => SOURCE_MESSAGE_REF.test(ref))) {
    throw invalid("conflict requires a source-message reference");
  }
  if (plan.difference === null || plan.suggestedUpdate === null) {
    throw invalid("conflict requires a difference and suggested update");
  }
  if (
    plan.targetDocumentRef === null
    || !plan.knowledgeBaseCitationRefs.includes(plan.targetDocumentRef)
  ) throw invalid("conflict target must reference cited document evidence");
  if (plan.missingEvidence.length !== 0) {
    throw invalid("conflict must not contain missing evidence");
  }
  if (plan.confidence === "low") throw invalid("conflict confidence must be medium or high");
}

function requireNonConflictPlan(plan: KnowledgeConflictPlan): void {
  if (
    plan.difference !== null
    || plan.suggestedUpdate !== null
    || plan.targetDocumentRef !== null
  ) throw invalid(`${plan.outcome} must not contain a difference, target, or suggestion`);
  if (plan.outcome === "no_conflict" && plan.missingEvidence.length !== 0) {
    throw invalid("no_conflict must not contain missing evidence");
  }
  if (plan.outcome === "insufficient_evidence" && plan.missingEvidence.length < 1) {
    throw invalid("insufficient_evidence requires missing evidence");
  }
}

function requireStatementCitationPair(
  name: string,
  statement: string | null,
  refs: readonly string[],
): void {
  if ((statement === null) !== (refs.length === 0)) {
    throw invalid(`${name} and citations must be present together`);
  }
}

function normalizeRefs(
  name: string,
  value: unknown,
  pattern: RegExp,
  availableReferenceIds: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value) || value.length > 23) throw invalid(`${name} is invalid`);
  const refs = value.map((item) => {
    const ref = requireString(name, item, 3);
    if (!pattern.test(ref) || !availableReferenceIds.has(ref)) throw invalid(`${name} is invalid`);
    return ref;
  });
  if (new Set(refs).size !== refs.length) throw invalid(`${name} contains duplicates`);
  return refs.sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

function normalizeMissingEvidence(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > KNOWLEDGE_CONFLICT_MAX_MISSING_EVIDENCE) {
    throw invalid("missingEvidence is invalid");
  }
  const items = value.map((item) =>
    requireString("missingEvidence", item, KNOWLEDGE_CONFLICT_REFERENCE_MAX_CHARS));
  if (new Set(items).size !== items.length) throw invalid("missingEvidence contains duplicates");
  return items.sort((left, right) => left.localeCompare(right));
}

function optionalReference(name: string, value: unknown): string | null {
  if (value === null) return null;
  const ref = requireString(name, value, 3);
  if (!DOCUMENT_REF.test(ref)) throw invalid(`${name} is invalid`);
  return ref;
}

function optionalString(name: string, value: unknown, maxChars: number): string | null {
  return value === null ? null : requireString(name, value, maxChars);
}

function requireString(name: string, value: unknown, maxChars: number): string {
  if (typeof value !== "string") throw invalid(`${name} must be a string`);
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > maxChars) {
    throw invalid(`${name} length is invalid`);
  }
  return normalized;
}

function invalid(message: string): KnowledgeConflictValidationError {
  return new KnowledgeConflictValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
