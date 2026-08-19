const MAX_EVIDENCE_PLAN_ITEMS = 12;
const MAX_EVIDENCE_PLAN_ITEM_CHARS = 1200;
const MAX_EVIDENCE_PLAN_ANSWER_CHARS = 8000;
const MAX_EVIDENCE_SOURCE_LABEL_CHARS = 512;
const EVIDENCE_SOURCE_TRUNCATION_MARKER = " ... [truncated]";
const EVIDENCE_CITATION_REF_PATTERN = /^(?:C(?:[1-9]|10)|M[1-8]|T[1-6]|D(?:[1-9]|1[0-2])|A[1-6])$/u;
const EVIDENCE_REF_CLASS_ORDER = new Map([
  ["C", 0],
  ["M", 1],
  ["T", 2],
  ["D", 3],
  ["A", 4],
]);
const PLAN_FIELDS = new Set([
  "taskMode",
  "evidenceState",
  "premises",
  "proposedAnswer",
  "missingInformation",
  "confidence",
]);
const PREMISE_FIELDS = new Set(["citationRef", "statement"]);

export type EvidencePlanningDocument = {
  citationRef: string;
  source: string;
  text: string;
};

export type EvidenceState =
  | "explicit"
  | "complete_inference"
  | "partial"
  | "none"
  | "conflict";
export type EvidenceConfidence = "high" | "medium" | "low";
export type EvidencePremise = {
  citationRef: string;
  statement: string;
};

export type EvidencePlan = {
  taskMode: "direct_task" | "company_fact";
  evidenceState: EvidenceState | null;
  premises: EvidencePremise[];
  proposedAnswer: string | null;
  missingInformation: string[];
  confidence: EvidenceConfidence | null;
};

export class EvidencePlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidencePlanValidationError";
  }
}

export type ConflictEvidencePlan = {
  candidateId: string;
  plan: EvidencePlan & {
    taskMode: "company_fact";
    evidenceState: "conflict";
    proposedAnswer: string;
    confidence: "high" | "medium";
  };
};

export function createConflictEvidencePlan(input: {
  candidateId: string;
  knowledgePremise: EvidencePremise;
  groupPremise: EvidencePremise;
  proposedAnswer: string;
  confidence: "high" | "medium";
}): ConflictEvidencePlan {
  const candidateId = readBoundedString(
    input.candidateId,
    512,
    "conflict evidence candidate id",
  );
  if (candidateId !== input.candidateId) {
    throw new EvidencePlanValidationError("conflict evidence candidate id is invalid");
  }
  const knowledgePremise = readConflictPremise(
    input.knowledgePremise,
    /^D(?:[1-9]|1[0-2])$/u,
    "knowledge",
  );
  const groupPremise = readConflictPremise(
    input.groupPremise,
    /^M[1-8]$/u,
    "group",
  );
  const proposedAnswer = readBoundedString(
    input.proposedAnswer,
    MAX_EVIDENCE_PLAN_ANSWER_CHARS,
    "conflict evidence proposed answer",
  );
  if (input.confidence !== "high" && input.confidence !== "medium") {
    throw new EvidencePlanValidationError("conflict evidence confidence is invalid");
  }

  const plan: ConflictEvidencePlan["plan"] = {
    taskMode: "company_fact",
    evidenceState: "conflict",
    premises: [groupPremise, knowledgePremise],
    proposedAnswer,
    missingInformation: [],
    confidence: input.confidence,
  };
  validateState(plan);
  return { candidateId, plan };
}

export function parseEvidencePlanContent(
  content: string,
  allowedCitationRefs: readonly string[],
): EvidencePlan {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new EvidencePlanValidationError("evidence plan response was not valid JSON");
  }

  const record = requireRecord(value, "evidence plan must be an object");
  requireExactFields(record, PLAN_FIELDS, "evidence plan");
  const taskMode = readTaskMode(record.taskMode);
  const evidenceState = readEvidenceState(record.evidenceState);
  const premises = readPremises(record.premises, new Set(allowedCitationRefs));
  const proposedAnswer = readOptionalBoundedString(
    record.proposedAnswer,
    MAX_EVIDENCE_PLAN_ANSWER_CHARS,
    "evidence plan proposed answer",
  );
  const missingInformation = readBoundedStringArray(
    record.missingInformation,
    "evidence plan missing information",
  );
  const confidence = readConfidence(record.confidence);

  validateState({
    taskMode,
    evidenceState,
    premises,
    proposedAnswer,
    missingInformation,
    confidence,
  });

  return {
    taskMode,
    evidenceState,
    premises,
    proposedAnswer,
    missingInformation,
    confidence,
  };
}

export function citedRefsForEvidencePlan(plan: EvidencePlan): string[] {
  return plan.premises
    .map(({ citationRef }) => citationRef)
    .sort(compareEvidenceCitationRefs);
}

export function documentCitationRefsForEvidencePlan(plan: EvidencePlan): string[] {
  return citedRefsForEvidencePlan(plan).filter((citationRef) => citationRef.startsWith("D"));
}

export function normalizeEvidenceSourceLabel(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must not be blank`);
  }
  if (normalized.length <= MAX_EVIDENCE_SOURCE_LABEL_CHARS) {
    return normalized;
  }

  const prefixChars = MAX_EVIDENCE_SOURCE_LABEL_CHARS - EVIDENCE_SOURCE_TRUNCATION_MARKER.length;
  return `${normalized.slice(0, prefixChars).trimEnd()}${EVIDENCE_SOURCE_TRUNCATION_MARKER}`;
}

function validateState(plan: EvidencePlan): void {
  if (plan.taskMode === "direct_task") {
    requirePlanCondition(
      plan.evidenceState === null &&
        plan.premises.length === 0 &&
        plan.proposedAnswer === null &&
        plan.missingInformation.length === 0 &&
        plan.confidence === null,
      "direct task evidence fields are invalid",
    );
    return;
  }

  requirePlanCondition(plan.evidenceState !== null, "company fact evidence state is required");
  if (plan.evidenceState === "explicit" || plan.evidenceState === "complete_inference") {
    requirePlanCondition(plan.premises.length > 0, "evidence plan requires a premise");
    requirePlanCondition(plan.proposedAnswer !== null, "evidence plan requires an answer");
    requirePlanCondition(
      plan.missingInformation.length === 0,
      "complete evidence cannot include missing information",
    );
    requirePlanCondition(
      plan.confidence === "high" || plan.confidence === "medium",
      "complete evidence confidence is invalid",
    );
    return;
  }

  if (plan.evidenceState === "partial") {
    requirePlanCondition(
      plan.premises.length > 0 && plan.proposedAnswer !== null,
      "partial evidence requires a premise and answer",
    );
    requirePlanCondition(
      plan.missingInformation.length > 0,
      "partial evidence requires missing information",
    );
    requirePlanCondition(
      plan.confidence === "low" || plan.confidence === "medium",
      "partial evidence confidence is invalid",
    );
    return;
  }

  if (plan.evidenceState === "conflict") {
    requirePlanCondition(
      plan.premises.some(({ citationRef }) => citationRef.startsWith("M"))
        && plan.premises.some(({ citationRef }) => citationRef.startsWith("D"))
        && plan.proposedAnswer !== null,
      "conflict evidence requires group and document premises",
    );
    requirePlanCondition(
      plan.missingInformation.length === 0,
      "conflict evidence cannot include missing information",
    );
    requirePlanCondition(
      plan.confidence === "high" || plan.confidence === "medium",
      "conflict evidence confidence is invalid",
    );
    return;
  }

  requirePlanCondition(
    plan.premises.length === 0 && plan.proposedAnswer === null,
    "no-evidence plan cannot contain a factual answer",
  );
  requirePlanCondition(
    plan.missingInformation.length > 0 && plan.confidence === "low",
    "no-evidence plan requires a low-confidence gap",
  );
}

function readConflictPremise(
  value: EvidencePremise,
  referencePattern: RegExp,
  kind: "knowledge" | "group",
): EvidencePremise {
  if (typeof value !== "object" || value === null) {
    throw new EvidencePlanValidationError(`conflict ${kind} premise is invalid`);
  }
  const citationRef = readBoundedString(
    value.citationRef,
    3,
    `conflict ${kind} premise citation reference`,
  );
  if (!referencePattern.test(citationRef)) {
    throw new EvidencePlanValidationError(
      `conflict ${kind} premise citation reference is invalid`,
    );
  }
  return {
    citationRef,
    statement: readBoundedString(
      value.statement,
      MAX_EVIDENCE_PLAN_ITEM_CHARS,
      `conflict ${kind} premise statement`,
    ),
  };
}

function readPremises(value: unknown, allowedCitationRefs: ReadonlySet<string>): EvidencePremise[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_PLAN_ITEMS) {
    throw new EvidencePlanValidationError("evidence plan premises are invalid");
  }

  const seenRefs = new Set<string>();
  return value.map((candidate) => {
    const premise = requireRecord(candidate, "evidence plan premise must be an object");
    requireExactFields(premise, PREMISE_FIELDS, "evidence plan premise");
    const citationRef = readBoundedString(
      premise.citationRef,
      3,
      "evidence plan citation reference",
    );
    if (!EVIDENCE_CITATION_REF_PATTERN.test(citationRef)) {
      throw new EvidencePlanValidationError("evidence plan citation reference is invalid");
    }
    if (!allowedCitationRefs.has(citationRef)) {
      throw new EvidencePlanValidationError("evidence plan citation reference is not allowed");
    }
    if (seenRefs.has(citationRef)) {
      throw new EvidencePlanValidationError(
        "evidence plan citation references must be unique",
      );
    }
    seenRefs.add(citationRef);
    return {
      citationRef,
      statement: readBoundedString(
        premise.statement,
        MAX_EVIDENCE_PLAN_ITEM_CHARS,
        "evidence plan premise statement",
      ),
    };
  });
}

export function isEvidenceCitationRef(value: string): boolean {
  return EVIDENCE_CITATION_REF_PATTERN.test(value);
}

function compareEvidenceCitationRefs(left: string, right: string): number {
  const classDifference =
    (EVIDENCE_REF_CLASS_ORDER.get(left[0] ?? "") ?? Number.MAX_SAFE_INTEGER) -
    (EVIDENCE_REF_CLASS_ORDER.get(right[0] ?? "") ?? Number.MAX_SAFE_INTEGER);
  return classDifference === 0
    ? Number(left.slice(1)) - Number(right.slice(1))
    : classDifference;
}

function readBoundedStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_PLAN_ITEMS) {
    throw new EvidencePlanValidationError(`${fieldName} is invalid`);
  }

  const seen = new Set<string>();
  return value.map((candidate) => {
    const item = readBoundedString(candidate, MAX_EVIDENCE_PLAN_ITEM_CHARS, fieldName);
    if (seen.has(item)) {
      throw new EvidencePlanValidationError(`${fieldName} must be unique`);
    }
    seen.add(item);
    return item;
  });
}

function readOptionalBoundedString(
  value: unknown,
  maxChars: number,
  fieldName: string,
): string | null {
  if (value === null) {
    return null;
  }
  return readBoundedString(value, maxChars, fieldName);
}

function readBoundedString(value: unknown, maxChars: number, fieldName: string): string {
  if (typeof value !== "string") {
    throw new EvidencePlanValidationError(`${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new EvidencePlanValidationError(`${fieldName} must not be blank`);
  }
  if ([...normalized].length > maxChars) {
    throw new EvidencePlanValidationError(`${fieldName} is too long`);
  }
  return normalized;
}

function readTaskMode(value: unknown): EvidencePlan["taskMode"] {
  if (value !== "direct_task" && value !== "company_fact") {
    throw new EvidencePlanValidationError("evidence plan task mode is invalid");
  }
  return value;
}

function readEvidenceState(value: unknown): EvidenceState | null {
  if (
    value !== null &&
    value !== "explicit" &&
    value !== "complete_inference" &&
    value !== "partial" &&
    value !== "none"
  ) {
    throw new EvidencePlanValidationError("evidence plan state is invalid");
  }
  return value;
}

function readConfidence(value: unknown): EvidenceConfidence | null {
  if (value !== null && value !== "high" && value !== "medium" && value !== "low") {
    throw new EvidencePlanValidationError("evidence plan confidence is invalid");
  }
  return value;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvidencePlanValidationError(message);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  record: Record<string, unknown>,
  fields: ReadonlySet<string>,
  fieldName: string,
): void {
  if (Object.keys(record).some((key) => !fields.has(key))) {
    throw new EvidencePlanValidationError(`${fieldName} includes unknown fields`);
  }
  if ([...fields].some((key) => !Object.hasOwn(record, key))) {
    throw new EvidencePlanValidationError(`${fieldName} is missing required fields`);
  }
}

function requirePlanCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new EvidencePlanValidationError(message);
  }
}
