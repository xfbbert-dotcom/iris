const MAX_EVIDENCE_PLAN_ITEMS = 12;
const MAX_EVIDENCE_PLAN_ITEM_CHARS = 1200;
const MAX_EVIDENCE_PLAN_ANSWER_CHARS = 8000;
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

export type EvidenceState = "explicit" | "complete_inference" | "partial" | "none";
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
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
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

  requirePlanCondition(
    plan.premises.length === 0 && plan.proposedAnswer === null,
    "no-evidence plan cannot contain a factual answer",
  );
  requirePlanCondition(
    plan.missingInformation.length > 0 && plan.confidence === "low",
    "no-evidence plan requires a low-confidence gap",
  );
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
    if (!/^D(?:[1-9]|1[0-2])$/u.test(citationRef)) {
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
