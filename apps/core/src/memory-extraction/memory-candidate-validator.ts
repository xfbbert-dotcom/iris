import {
  MEMORY_CANDIDATE_CATEGORIES,
  type MemoryExtractionDiagnostics,
  type ProposedMemoryCandidate,
  type ValidatedMemoryCandidate,
} from "./ai-worker-memory-extraction-client.js";
import type { ClaimedMemoryExtractionRun } from "./memory-extraction-repository.js";

const DEFAULT_MIN_CONFIDENCE = 0.85;
const MAX_CANDIDATES = 8;
const MAX_EVIDENCE_IDS = 40;
const MAX_CONTEXT_MESSAGES = 10;
const MAX_MESSAGES = 50;
const MAX_EXISTING_MEMORIES = 8;
const MAX_IDENTIFIER_CHARS = 512;
const MAX_CONTENT_CHARS = 4000;
const RELATIONS = ["new", "duplicate", "conflict"] as const;
const CANDIDATE_KEYS = [
  "category",
  "content",
  "importance",
  "confidence",
  "evidenceMessageIds",
  "relation",
  "existingMemoryId",
] as const;
const REQUIRED_CANDIDATE_KEYS = CANDIDATE_KEYS.filter((key) => key !== "existingMemoryId");
const REJECTION_CODE_ORDER = [
  "candidate_count",
  "invalid_run",
  "invalid_shape",
  "invalid_category",
  "invalid_content",
  "invalid_importance",
  "invalid_confidence",
  "invalid_relation",
  "invalid_evidence",
  "invalid_relation_reference",
  "low_confidence",
  "duplicate_relation",
  "conflict_relation",
  "exact_duplicate",
] as const;

export type MemoryCandidateValidationResult = MemoryExtractionDiagnostics & {
  accepted: ValidatedMemoryCandidate[];
};

export function validateCandidates(input: {
  run: ClaimedMemoryExtractionRun;
  candidates: readonly ProposedMemoryCandidate[];
  minConfidence?: number;
}): MemoryCandidateValidationResult {
  const minConfidence = requireMinConfidence(input.minConfidence);
  if (!Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES) {
    return {
      accepted: [],
      proposedCount: MAX_CANDIDATES,
      acceptedCount: 0,
      rejectedCount: MAX_CANDIDATES,
      duplicateCount: 0,
      conflictCount: 0,
      rejectionCodes: ["candidate_count"],
    };
  }

  if (isGrosslyInvalidRun(input.run)) {
    return {
      accepted: [],
      proposedCount: input.candidates.length,
      acceptedCount: 0,
      rejectedCount: input.candidates.length,
      duplicateCount: 0,
      conflictCount: 0,
      rejectionCodes: input.candidates.length === 0 ? [] : ["invalid_run"],
    };
  }

  const evidenceIds = validEvidenceIds(input.run);
  const existingMemoryIds = uniqueExistingMemoryIds(input.run);
  const existingContent = new Set(
    input.run.existingMemories
      .map((memory) => canonicalizeContent(memory.content)?.comparisonKey)
      .filter((value): value is string => value !== undefined),
  );
  const accepted: Array<ValidatedMemoryCandidate & { comparisonKey: string }> = [];
  const rejectionCodes: string[] = [];
  let duplicateCount = 0;
  let conflictCount = 0;
  let rejectedCount = 0;

  const reject = (code: string): void => {
    rejectedCount += 1;
    if (!rejectionCodes.includes(code) && rejectionCodes.length < MAX_CANDIDATES) {
      rejectionCodes.push(code);
    }
  };

  for (const rawCandidate of input.candidates as readonly unknown[]) {
    if (!isExactCandidateRecord(rawCandidate)) {
      reject("invalid_shape");
      continue;
    }
    const candidate = rawCandidate as ProposedMemoryCandidate;
    if (!MEMORY_CANDIDATE_CATEGORIES.includes(candidate.category as never)) {
      reject("invalid_category");
      continue;
    }
    const canonicalContent = canonicalizeContent(candidate.content);
    if (canonicalContent === undefined) {
      reject("invalid_content");
      continue;
    }
    if (!Number.isSafeInteger(candidate.importance) || candidate.importance < 1 || candidate.importance > 5) {
      reject("invalid_importance");
      continue;
    }
    if (typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
      reject("invalid_confidence");
      continue;
    }
    if (!RELATIONS.includes(candidate.relation as never)) {
      reject("invalid_relation");
      continue;
    }
    const evidence = normalizeEvidence(candidate.evidenceMessageIds, evidenceIds);
    if (evidence === undefined) {
      reject("invalid_evidence");
      continue;
    }
    if (!hasValidRelationReference(candidate, existingMemoryIds)) {
      reject("invalid_relation_reference");
      continue;
    }
    if (candidate.confidence < minConfidence) {
      reject("low_confidence");
      continue;
    }
    if (candidate.relation === "duplicate") {
      duplicateCount += 1;
      reject("duplicate_relation");
      continue;
    }
    if (candidate.relation === "conflict") {
      conflictCount += 1;
      reject("conflict_relation");
      continue;
    }

    const { content, comparisonKey } = canonicalContent;
    if (existingContent.has(comparisonKey)) {
      duplicateCount += 1;
      reject("exact_duplicate");
      continue;
    }
    accepted.push({
      category: candidate.category,
      content,
      importance: candidate.importance,
      confidence: candidate.confidence,
      evidenceMessageIds: evidence,
      comparisonKey,
    });
  }

  accepted.sort(compareCandidates);
  const canonical: ValidatedMemoryCandidate[] = [];
  const acceptedContent = new Set<string>();
  for (const candidate of accepted) {
    if (acceptedContent.has(candidate.comparisonKey)) {
      duplicateCount += 1;
      reject("exact_duplicate");
      continue;
    }
    acceptedContent.add(candidate.comparisonKey);
    canonical.push({
      category: candidate.category,
      content: candidate.content,
      importance: candidate.importance,
      confidence: candidate.confidence,
      evidenceMessageIds: [...candidate.evidenceMessageIds],
    });
  }

  return {
    accepted: canonical,
    proposedCount: input.candidates.length,
    acceptedCount: canonical.length,
    rejectedCount,
    duplicateCount,
    conflictCount,
    rejectionCodes: rejectionCodes.sort(compareRejectionCodes),
  };
}

function requireMinConfidence(value: number | undefined): number {
  const minConfidence = value ?? DEFAULT_MIN_CONFIDENCE;
  if (
    typeof minConfidence !== "number" ||
    !Number.isFinite(minConfidence) ||
    minConfidence < 0 ||
    minConfidence > 1
  ) {
    throw new Error("minimum confidence must be between 0 and 1");
  }
  return minConfidence;
}

function isGrosslyInvalidRun(run: ClaimedMemoryExtractionRun): boolean {
  return !isIdentifier(run.groupId) ||
    !Array.isArray(run.evidenceMessages) ||
    !Array.isArray(run.contextMessages) ||
    !Array.isArray(run.existingMemories) ||
    run.evidenceMessages.length === 0 ||
    run.evidenceMessages.length > MAX_EVIDENCE_IDS ||
    run.contextMessages.length > MAX_CONTEXT_MESSAGES ||
    run.evidenceMessages.length + run.contextMessages.length > MAX_MESSAGES ||
    run.existingMemories.length > MAX_EXISTING_MEMORIES;
}

function validEvidenceIds(run: ClaimedMemoryExtractionRun): Set<string> {
  const occurrences = new Map<string, number>();
  for (const message of [...run.contextMessages, ...run.evidenceMessages]) {
    occurrences.set(message.id, (occurrences.get(message.id) ?? 0) + 1);
  }
  return new Set(
    run.evidenceMessages
      .filter((message) =>
        isIdentifier(message.id) &&
        occurrences.get(message.id) === 1 &&
        message.groupId === run.groupId &&
        message.evidenceEligible === true,
      )
      .map((message) => message.id),
  );
}

function uniqueExistingMemoryIds(run: ClaimedMemoryExtractionRun): Set<string> {
  const counts = new Map<string, number>();
  for (const memory of run.existingMemories) {
    counts.set(memory.id, (counts.get(memory.id) ?? 0) + 1);
  }
  return new Set(
    [...counts]
      .filter(([id, count]) => count === 1 && isIdentifier(id))
      .map(([id]) => id),
  );
}

function normalizeEvidence(value: unknown, validIds: ReadonlySet<string>): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE_IDS) {
    return undefined;
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (!isIdentifier(id) || !validIds.has(id)) {
      return undefined;
    }
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return unique.sort(compareStrings);
}

function hasValidRelationReference(
  candidate: ProposedMemoryCandidate,
  existingMemoryIds: ReadonlySet<string>,
): boolean {
  if (candidate.relation === "new") {
    return candidate.existingMemoryId === undefined;
  }
  return isIdentifier(candidate.existingMemoryId) && existingMemoryIds.has(candidate.existingMemoryId);
}

function isExactCandidateRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).every((key) => CANDIDATE_KEYS.includes(key as never)) &&
    REQUIRED_CANDIDATE_KEYS.every((key) => Object.hasOwn(value, key));
}

function canonicalizeContent(value: unknown): {
  content: string;
  comparisonKey: string;
} | undefined {
  if (typeof value !== "string" || value.includes("\u0000") || hasLoneSurrogate(value)) {
    return undefined;
  }
  if (/[\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)) {
    return undefined;
  }
  const content = value.trim();
  if (content.length === 0 || content.length > MAX_CONTENT_CHARS) {
    return undefined;
  }
  const comparisonKey = content.normalize("NFC").toLowerCase().normalize("NFC");
  return { content, comparisonKey };
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    codePointLength(value) <= MAX_IDENTIFIER_CHARS &&
    value === value.trim() &&
    !hasLoneSurrogate(value) &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function compareCandidates(
  left: ValidatedMemoryCandidate & { comparisonKey: string },
  right: ValidatedMemoryCandidate & { comparisonKey: string },
): number {
  return compareStrings(left.category, right.category) ||
    compareStrings(left.comparisonKey, right.comparisonKey) ||
    compareStrings(left.content, right.content) ||
    compareStrings(JSON.stringify(left.evidenceMessageIds), JSON.stringify(right.evidenceMessageIds)) ||
    left.importance - right.importance ||
    left.confidence - right.confidence;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRejectionCodes(left: string, right: string): number {
  return REJECTION_CODE_ORDER.indexOf(left as never) - REJECTION_CODE_ORDER.indexOf(right as never);
}

function codePointLength(value: string): number {
  return [...value].length;
}
