export const KNOWLEDGE_DRAFT_ORIGIN_KINDS = [
  "group_conclusion",
  "repeated_qa",
  "workflow",
  "document_discussion",
  "knowledge_conflict",
  "user_requested",
] as const;

export const KNOWLEDGE_DRAFT_RISK_LEVELS = ["low", "medium", "high"] as const;
export const KNOWLEDGE_DRAFT_STATUSES = [
  "pending_confirmation",
  "pending_review",
  "needs_revision",
  "rejected",
  "published",
] as const;
export const KNOWLEDGE_DRAFT_EVENT_TYPES = [
  "created",
  "revised",
  "group_confirmed",
  "revision_requested",
  "rejected",
] as const;
export const KNOWLEDGE_DRAFT_REVIEWER_TYPES = [
  "feishu_user",
  "text_label",
  "admin_role",
] as const;
export const KNOWLEDGE_DRAFT_EVIDENCE_TYPES = [
  "conversation_message",
  "discussion_thread",
  "action_item",
  "document_source",
] as const;

export const KNOWLEDGE_DRAFT_TITLE_MAX_CHARS = 256;
export const KNOWLEDGE_DRAFT_CONTENT_MAX_CHARS = 100_000;
export const KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS = 512;
export const KNOWLEDGE_DRAFT_REASON_MAX_CHARS = 2_000;
export const KNOWLEDGE_DRAFT_MAX_EVIDENCE = 100;

export type KnowledgeDraftOriginKind = (typeof KNOWLEDGE_DRAFT_ORIGIN_KINDS)[number];
export type KnowledgeDraftRiskLevel = (typeof KNOWLEDGE_DRAFT_RISK_LEVELS)[number];
export type KnowledgeDraftStatus = (typeof KNOWLEDGE_DRAFT_STATUSES)[number];
export type KnowledgeDraftEventType = (typeof KNOWLEDGE_DRAFT_EVENT_TYPES)[number];
export type KnowledgeDraftReviewerType = (typeof KNOWLEDGE_DRAFT_REVIEWER_TYPES)[number];
export type KnowledgeDraftEvidenceType = (typeof KNOWLEDGE_DRAFT_EVIDENCE_TYPES)[number];

type GroupEvidence = {
  type: "conversation_message";
  id: string;
  groupId: string;
};

type VersionedGroupEvidence = {
  type: "discussion_thread" | "action_item";
  id: string;
  groupId: string;
  entityVersion: number;
};

type DocumentEvidence = {
  type: "document_source";
  id: string;
  expectedUpdatedAt: Date;
};

export type KnowledgeDraftEvidenceReference =
  | GroupEvidence
  | VersionedGroupEvidence
  | DocumentEvidence;

export type KnowledgeDraftReviewer = {
  type: KnowledgeDraftReviewerType;
  ref: string;
};

export type KnowledgeDraftPublicationSuggestion = {
  spaceId?: string;
  parentNodeToken?: string;
};

export type KnowledgeDraftRevisionInput = {
  sourceGroupId?: string;
  title: string;
  content: string;
  riskLevel: KnowledgeDraftRiskLevel;
  reviewer?: KnowledgeDraftReviewer;
  suggestedPublication?: KnowledgeDraftPublicationSuggestion;
  evidence: KnowledgeDraftEvidenceReference[];
};

export type NormalizedKnowledgeDraftRevision = KnowledgeDraftRevisionInput & {
  evidence: KnowledgeDraftEvidenceReference[];
};

export class KnowledgeDraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeDraftValidationError";
  }
}

export function normalizeKnowledgeDraftRevisionInput(
  input: KnowledgeDraftRevisionInput,
): NormalizedKnowledgeDraftRevision {
  if (!isRecord(input)) throw validationError("knowledge draft revision must be an object");
  const sourceGroupId = normalizeOptionalReference("sourceGroupId", input.sourceGroupId);
  const title = requireString("title", input.title, KNOWLEDGE_DRAFT_TITLE_MAX_CHARS);
  const content = requireString("content", input.content, KNOWLEDGE_DRAFT_CONTENT_MAX_CHARS);
  if (!KNOWLEDGE_DRAFT_RISK_LEVELS.includes(input.riskLevel as KnowledgeDraftRiskLevel)) {
    throw validationError("riskLevel is invalid");
  }
  const evidence = normalizeEvidence(input.evidence, sourceGroupId);
  const reviewer = normalizeReviewer(input.reviewer);
  const suggestedPublication = normalizePublicationSuggestion(input.suggestedPublication);

  return {
    ...(sourceGroupId === undefined ? {} : { sourceGroupId }),
    title,
    content,
    riskLevel: input.riskLevel,
    ...(reviewer === undefined ? {} : { reviewer }),
    ...(suggestedPublication === undefined ? {} : { suggestedPublication }),
    evidence,
  };
}

function normalizeEvidence(
  value: unknown,
  sourceGroupId: string | undefined,
): KnowledgeDraftEvidenceReference[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > KNOWLEDGE_DRAFT_MAX_EVIDENCE) {
    throw validationError("evidence count is invalid");
  }
  const normalized = value.map((item) => normalizeEvidenceReference(item, sourceGroupId));
  const keys = normalized.map((item) => `${item.type}\0${item.id}`);
  if (new Set(keys).size !== keys.length) throw validationError("evidence contains duplicates");
  return normalized.sort((left, right) =>
    left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
}

function normalizeEvidenceReference(
  value: unknown,
  sourceGroupId: string | undefined,
): KnowledgeDraftEvidenceReference {
  if (!isRecord(value) || !KNOWLEDGE_DRAFT_EVIDENCE_TYPES.includes(value.type as KnowledgeDraftEvidenceType)) {
    throw validationError("evidence type is invalid");
  }
  const evidenceType = value.type as KnowledgeDraftEvidenceType;
  const id = requireString("evidence.id", value.id, KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS);
  if (evidenceType === "document_source") {
    if (!(value.expectedUpdatedAt instanceof Date) || !Number.isFinite(value.expectedUpdatedAt.getTime())) {
      throw validationError("document evidence timestamp is invalid");
    }
    return { type: "document_source", id, expectedUpdatedAt: new Date(value.expectedUpdatedAt) };
  }

  if (sourceGroupId === undefined) {
    throw validationError("group evidence requires sourceGroupId");
  }
  const groupId = requireString(
    "evidence.groupId",
    value.groupId,
    KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS,
  );
  if (groupId !== sourceGroupId) throw validationError("evidence group does not match sourceGroupId");
  if (evidenceType === "conversation_message") {
    return { type: "conversation_message", id, groupId };
  }
  if (!Number.isSafeInteger(value.entityVersion) || Number(value.entityVersion) < 1) {
    throw validationError("evidence entityVersion is invalid");
  }
  return {
    type: evidenceType,
    id,
    groupId,
    entityVersion: Number(value.entityVersion),
  };
}

function normalizeReviewer(value: unknown): KnowledgeDraftReviewer | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !KNOWLEDGE_DRAFT_REVIEWER_TYPES.includes(value.type as KnowledgeDraftReviewerType)
  ) throw validationError("reviewer is invalid");
  return {
    type: value.type as KnowledgeDraftReviewerType,
    ref: requireString("reviewer.ref", value.ref, KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS),
  };
}

function normalizePublicationSuggestion(
  value: unknown,
): KnowledgeDraftPublicationSuggestion | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw validationError("suggestedPublication is invalid");
  const spaceId = normalizeOptionalReference("suggestedPublication.spaceId", value.spaceId);
  const parentNodeToken = normalizeOptionalReference(
    "suggestedPublication.parentNodeToken",
    value.parentNodeToken,
  );
  if (spaceId === undefined && parentNodeToken === undefined) {
    throw validationError("suggestedPublication must not be empty");
  }
  return {
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(parentNodeToken === undefined ? {} : { parentNodeToken }),
  };
}

function normalizeOptionalReference(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requireString(name, value, KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS);
}

function requireString(name: string, value: unknown, maxChars: number): string {
  if (typeof value !== "string") throw validationError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxChars) {
    throw validationError(`${name} length is invalid`);
  }
  return normalized;
}

function validationError(message: string): KnowledgeDraftValidationError {
  return new KnowledgeDraftValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
