import { createHash } from "node:crypto";

import { ModelProviderHttpError, isModelProviderCapacityError } from
  "../model/model-provider-error.js";
import type {
  CurrentConflictFingerprint,
  KnowledgeConflictEvidenceBuildResult,
  KnowledgeConflictEvidenceBuilder,
} from "./knowledge-conflict-evidence-builder.js";
import {
  KnowledgeConflictOperationConflictError,
  KnowledgeConflictStaleEvidenceError,
  type KnowledgeConflictRepository,
  type KnowledgeConflictScanClaim,
  type RecordKnowledgeConflictDetectionInput,
} from "./knowledge-conflict-repository.js";
import type {
  KnowledgeConflictDetector,
  KnowledgeConflictEvidenceReference,
  KnowledgeConflictPlan,
} from "./knowledge-conflict.js";

const MAX_BATCH_LIMIT = 50;
const MAX_GROUP_IDS = 50;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_IDENTIFIER_CHARS = 512;
const INVALID_DETECTOR_RESPONSE = "knowledge conflict detector response was invalid";
const RETRYABLE_EVIDENCE_CODES = new Set([
  "message_lookup_failed",
  "target_policy_lookup_failed",
  "embedding_invalid",
  "embedding_failed",
  "fragment_search_failed",
  "source_lookup_failed",
  "snapshot_lookup_failed",
  "permission_check_failed",
  "permission_attestation_invalid",
  "fragment_lookup_failed",
]);

export type KnowledgeConflictScannerBatchResult = {
  discovered: number;
  claimed: number;
  conflict: number;
  noConflict: number;
  insufficientEvidence: number;
  permissionBlocked: number;
  retrying: number;
  deadLettered: number;
  superseded: number;
};

export type KnowledgeConflictScanner = {
  scanBatch(input: { limit: number }): Promise<KnowledgeConflictScannerBatchResult>;
};

type ScannerRepository = Pick<KnowledgeConflictRepository,
  "discoverEligibleScans" | "claimNextScan" | "completeScan" | "failScan" |
  "recordDetectionResult">;

export type KnowledgeConflictScannerDependencies = {
  repository: ScannerRepository;
  evidenceBuilder: KnowledgeConflictEvidenceBuilder;
  detector: KnowledgeConflictDetector;
  groupIds: readonly string[];
  canUseKnowledgeConflict(groupId: string): boolean;
  workerId: string;
  leaseDurationMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  detectorContractVersion: string;
  now?: () => Date;
};

export function createKnowledgeConflictScanner(
  dependencies: KnowledgeConflictScannerDependencies,
): KnowledgeConflictScanner {
  const groupIds = normalizeGroupIds(dependencies.groupIds);
  const workerId = requireIdentifier("workerId", dependencies.workerId);
  const leaseDurationMs = requireDelay("leaseDurationMs", dependencies.leaseDurationMs);
  const retryBaseDelayMs = requireDelay("retryBaseDelayMs", dependencies.retryBaseDelayMs);
  const retryMaxDelayMs = requireDelay("retryMaxDelayMs", dependencies.retryMaxDelayMs);
  if (retryMaxDelayMs < retryBaseDelayMs) {
    throw new Error("retryMaxDelayMs must not be less than retryBaseDelayMs");
  }
  const detectorContractVersion = requireIdentifier(
    "detectorContractVersion",
    dependencies.detectorContractVersion,
  );
  const now = dependencies.now ?? (() => new Date());

  return {
    async scanBatch({ limit }) {
      const safeLimit = sanitizeBatchLimit(limit);
      const result = emptyBatch();
      if (safeLimit === 0 || groupIds.length === 0) return result;

      const enabledGroups = groupIds.filter((groupId) =>
        readApplicationGate(dependencies.canUseKnowledgeConflict, groupId));
      if (enabledGroups.length === 0) return result;

      const discoveryAt = requireDate("scanner time", now());
      const discovery = await dependencies.repository.discoverEligibleScans({
        groupIds: enabledGroups,
        limit: safeLimit,
        at: discoveryAt,
      });
      result.discovered = Math.min(safeLimit, requireCount("discovered", discovery.discovered));

      for (let index = 0; index < safeLimit; index += 1) {
        const claimAt = requireDate("scanner time", now());
        const claimed = await dependencies.repository.claimNextScan({
          groupIds: enabledGroups,
          workerId,
          at: claimAt,
          leaseUntil: addMilliseconds(claimAt, leaseDurationMs),
        });
        if (claimed === undefined) break;
        result.claimed += 1;
        await processClaim({
          dependencies,
          claim: claimed,
          workerId,
          retryBaseDelayMs,
          retryMaxDelayMs,
          detectorContractVersion,
          now,
          result,
        });
      }
      return result;
    },
  };
}

async function processClaim(input: {
  dependencies: KnowledgeConflictScannerDependencies;
  claim: KnowledgeConflictScanClaim;
  workerId: string;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  detectorContractVersion: string;
  now: () => Date;
  result: KnowledgeConflictScannerBatchResult;
}): Promise<void> {
  const { dependencies, claim, workerId, result } = input;
  try {
    validateClaim(claim, workerId);
    if (!readApplicationGate(dependencies.canUseKnowledgeConflict, claim.scan.groupId)) {
      await recordTerminal(input, "permission_blocked");
      return;
    }

    let evidence: KnowledgeConflictEvidenceBuildResult;
    try {
      evidence = await dependencies.evidenceBuilder.build({ memory: claim.memory });
    } catch {
      throw new ScannerInternalError();
    }
    if (evidence.outcome === "retryable_failure") {
      await recordFailure(input, "retryable", normalizeEvidenceFailureCode(evidence.reasonCode));
      return;
    }
    if (evidence.outcome === "insufficient_evidence"
      || evidence.outcome === "permission_blocked") {
      await recordTerminal(input, evidence.outcome);
      return;
    }

    validateFingerprint(claim, evidence.fingerprint);
    if (!readApplicationGate(dependencies.canUseKnowledgeConflict, claim.scan.groupId)) {
      await recordTerminal(input, "permission_blocked");
      return;
    }
    let plan: KnowledgeConflictPlan;
    try {
      plan = await dependencies.detector.detect(evidence.input);
    } catch (error) {
      throw new DetectorPhaseError(error);
    }
    if (plan.outcome === "conflict") {
      const candidate = buildCandidate({
        claim,
        evidence,
        plan: { ...plan, outcome: "conflict" },
        detectorContractVersion: input.detectorContractVersion,
      });
      await recordResult(input, { outcome: "conflict", candidate });
      result.conflict += 1;
      return;
    }
    await recordResult(input, { outcome: plan.outcome });
    if (plan.outcome === "no_conflict") result.noConflict += 1;
    else result.insufficientEvidence += 1;
  } catch (error) {
    if (error instanceof KnowledgeConflictStaleEvidenceError) {
      await dependencies.repository.completeScan({
        scanId: claim.scan.id,
        workerId,
        outcome: "superseded",
        at: requireDate("scanner time", input.now()),
      });
      result.superseded += 1;
      return;
    }
    const failure = classifyFailure(error);
    await recordFailure(input, failure.classification, failure.errorCode);
  }
}

async function recordTerminal(
  input: Parameters<typeof processClaim>[0],
  outcome: "insufficient_evidence" | "permission_blocked",
): Promise<void> {
  await recordResult(input, { outcome });
  if (outcome === "insufficient_evidence") input.result.insufficientEvidence += 1;
  else input.result.permissionBlocked += 1;
}

async function recordResult(
  input: Parameters<typeof processClaim>[0],
  result: RecordKnowledgeConflictDetectionInput["result"],
): Promise<void> {
  const gateOpen = readApplicationGate(
    input.dependencies.canUseKnowledgeConflict,
    input.claim.scan.groupId,
  );
  const safeResult = gateOpen ? result : { outcome: "permission_blocked" as const };
  try {
    await input.dependencies.repository.recordDetectionResult({
      scanId: input.claim.scan.id,
      workerId: input.workerId,
      result: safeResult,
      at: requireDate("scanner time", input.now()),
    });
  } catch (error) {
    if (error instanceof KnowledgeConflictStaleEvidenceError
      || error instanceof KnowledgeConflictOperationConflictError) throw error;
    throw new ScannerInternalError();
  }
  if (!gateOpen && result.outcome !== "permission_blocked") {
    input.result.permissionBlocked += 1;
    throw new OutcomeAlreadyCountedError();
  }
}

class OutcomeAlreadyCountedError extends Error {}

async function recordFailure(
  input: Parameters<typeof processClaim>[0],
  classification: "retryable" | "permanent",
  errorCode: string,
): Promise<void> {
  if (errorCode === "outcome_already_counted") return;
  const failedAt = requireDate("scanner time", input.now());
  const retryAt = classification === "retryable"
    ? addMilliseconds(failedAt, retryDelayMs(
      input.claim.scan.attemptCount,
      input.retryBaseDelayMs,
      input.retryMaxDelayMs,
    ))
    : undefined;
  const failure = await input.dependencies.repository.failScan({
    scanId: input.claim.scan.id,
    workerId: input.workerId,
    classification,
    errorCode,
    ...(retryAt === undefined ? {} : { retryAt }),
    at: failedAt,
  });
  if (failure.status === "retry") input.result.retrying += 1;
  else input.result.deadLettered += 1;
}

function classifyFailure(error: unknown): {
  classification: "retryable" | "permanent";
  errorCode: string;
} {
  if (error instanceof OutcomeAlreadyCountedError) {
    return { classification: "permanent", errorCode: "outcome_already_counted" };
  }
  if (error instanceof ImpossibleEvidenceIdentityError) {
    return { classification: "permanent", errorCode: "impossible_evidence_identity" };
  }
  if (error instanceof MalformedPersistedFactsError) {
    return { classification: "permanent", errorCode: "malformed_persisted_facts" };
  }
  if (error instanceof KnowledgeConflictOperationConflictError) {
    return { classification: "permanent", errorCode: "operation_conflict" };
  }
  if (error instanceof ScannerInternalError) {
    return { classification: "retryable", errorCode: "internal_error" };
  }
  if (error instanceof DetectorPhaseError) {
    const detectorError = error.original;
    if (detectorError instanceof Error
      && detectorError.message === "knowledge conflict detector input is invalid") {
      return { classification: "permanent", errorCode: "malformed_persisted_facts" };
    }
    if (isModelProviderCapacityError(detectorError)) {
      return { classification: "retryable", errorCode: "provider_capacity" };
    }
    if (detectorError instanceof ModelProviderHttpError) {
      if (detectorError.statusCode === 408 || detectorError.statusCode >= 500) {
        return { classification: "retryable", errorCode: "provider_transport" };
      }
      return { classification: "permanent", errorCode: "provider_rejected" };
    }
    if (detectorError instanceof TypeError || isProviderTransportError(detectorError)) {
      return { classification: "retryable", errorCode: "provider_transport" };
    }
    if (detectorError instanceof Error && detectorError.message === INVALID_DETECTOR_RESPONSE) {
      return { classification: "retryable", errorCode: "provider_invalid_response" };
    }
  }
  return { classification: "retryable", errorCode: "internal_error" };
}

function buildCandidate(input: {
  claim: KnowledgeConflictScanClaim;
  evidence: Extract<KnowledgeConflictEvidenceBuildResult, { outcome: "ready" }>;
  plan: KnowledgeConflictPlan & { outcome: "conflict" };
  detectorContractVersion: string;
}): Extract<RecordKnowledgeConflictDetectionInput["result"], { outcome: "conflict" }>["candidate"] {
  const { claim, evidence, plan } = input;
  const fingerprint = evidence.fingerprint;
  const target = fingerprint.documents.find((item) => item.referenceId === plan.targetDocumentRef);
  const sourceMessage = plan.groupCitationRefs
    .filter((referenceId) => referenceId.startsWith("C"))
    .map((referenceId) => fingerprint.messages.find((item) => item.referenceId === referenceId))
    .find((item) => item !== undefined);
  if (target === undefined || sourceMessage === undefined) throw new ImpossibleEvidenceIdentityError();

  const evidenceReferences: KnowledgeConflictEvidenceReference[] = [{
    type: "group_memory",
    referenceId: "M1",
    groupId: fingerprint.memory.groupId,
    groupMemoryId: fingerprint.memory.groupMemoryId,
    expectedUpdatedAt: new Date(fingerprint.memory.updatedAt),
  }];
  for (const referenceId of plan.groupCitationRefs.filter((item) => item.startsWith("C"))) {
    const message = fingerprint.messages.find((item) => item.referenceId === referenceId);
    if (message === undefined) throw new ImpossibleEvidenceIdentityError();
    evidenceReferences.push({
      type: "conversation_message",
      referenceId: message.referenceId as "C1",
      groupId: fingerprint.memory.groupId,
      conversationMessageId: message.conversationMessageId,
    });
  }
  for (const referenceId of plan.knowledgeBaseCitationRefs) {
    const document = fingerprint.documents.find((item) => item.referenceId === referenceId);
    if (document === undefined) throw new ImpossibleEvidenceIdentityError();
    const documentReference = document.referenceId as "D1";
    evidenceReferences.push(
      { type: "document_source", referenceId: documentReference,
        documentSourceId: document.documentSourceId,
        expectedUpdatedAt: new Date(document.sourceUpdatedAt) },
      { type: "document_snapshot", referenceId: documentReference,
        documentSourceId: document.documentSourceId,
        documentSnapshotId: document.documentSnapshotId,
        contentHash: document.snapshotContentHash },
      { type: "document_fragment", referenceId: documentReference,
        documentSourceId: document.documentSourceId,
        documentSnapshotId: document.documentSnapshotId,
        documentFragmentId: document.documentFragmentId,
        snapshotContentHash: document.snapshotContentHash,
        contentHash: document.fragmentContentHash },
    );
  }

  const digest = createHash("sha256").update([
    fingerprint.memory.groupMemoryId,
    fingerprint.memory.updatedAt.toISOString(),
    target.documentSnapshotId,
    target.snapshotContentHash,
    input.detectorContractVersion,
  ].join("\u0000")).digest("hex");
  return {
    id: `knowledge-conflict-candidate:${digest}`,
    idempotencyKey: `knowledge-conflict:${digest}`,
    groupId: fingerprint.memory.groupId,
    groupMemoryId: fingerprint.memory.groupMemoryId,
    memoryUpdatedAt: new Date(fingerprint.memory.updatedAt),
    sourceMessageId: sourceMessage.conversationMessageId,
    targetDocumentSourceId: target.documentSourceId,
    targetSourceUpdatedAt: new Date(target.sourceUpdatedAt),
    ...(target.sourceVersion === undefined ? {} : { targetSourceVersion: target.sourceVersion }),
    targetSnapshotId: target.documentSnapshotId,
    targetContentHash: target.snapshotContentHash,
    detectorContractVersion: input.detectorContractVersion,
    permissionAttestedAt: new Date(fingerprint.permissionAttestedAt),
    plan,
    evidence: evidenceReferences,
  };
}

function validateClaim(claim: KnowledgeConflictScanClaim, workerId: string): void {
  const scan = claim.scan;
  if (!isRecord(claim.memory)
    || typeof claim.memory.id !== "string"
    || typeof claim.memory.groupId !== "string"
    || !(claim.memory.updatedAt instanceof Date)
    || Number.isNaN(claim.memory.updatedAt.getTime())
    || !isValidDate(scan.memoryUpdatedAt)
    || !isValidDate(scan.nextAttemptAt)
    || !isValidDate(scan.createdAt)
    || !isValidDate(scan.updatedAt)
    || !isValidDate(scan.leaseUntil)
    || !Number.isSafeInteger(scan.attemptCount)
    || scan.attemptCount < 1) throw new MalformedPersistedFactsError();
  if (scan.status !== "processing"
    || scan.leaseWorkerId !== workerId
    || scan.groupMemoryId !== claim.memory.id
    || scan.groupId !== claim.memory.groupId
    || scan.memoryUpdatedAt.getTime() !== claim.memory.updatedAt.getTime()) {
    throw new ImpossibleEvidenceIdentityError();
  }
}

function validateFingerprint(
  claim: KnowledgeConflictScanClaim,
  fingerprint: CurrentConflictFingerprint,
): void {
  if (!(fingerprint.memory.updatedAt instanceof Date)
    || Number.isNaN(fingerprint.memory.updatedAt.getTime())
    || !(fingerprint.permissionAttestedAt instanceof Date)
    || Number.isNaN(fingerprint.permissionAttestedAt.getTime())) {
    throw new MalformedPersistedFactsError();
  }
  if (fingerprint.memory.groupMemoryId !== claim.scan.groupMemoryId
    || fingerprint.memory.groupId !== claim.scan.groupId
    || fingerprint.memory.updatedAt.getTime() !== claim.scan.memoryUpdatedAt.getTime()) {
    throw new ImpossibleEvidenceIdentityError();
  }
}

class ImpossibleEvidenceIdentityError extends Error {}
class MalformedPersistedFactsError extends Error {}
class ScannerInternalError extends Error {}
class DetectorPhaseError extends Error {
  constructor(readonly original: unknown) {
    super("knowledge conflict detector failed");
  }
}

function normalizeEvidenceFailureCode(value: string): string {
  return RETRYABLE_EVIDENCE_CODES.has(value) ? value : "evidence_builder_failed";
}

function isProviderTransportError(error: unknown): boolean {
  return error instanceof Error && (
    error.message === "model provider request timed out"
    || error.message === "model provider request attempts exhausted"
  );
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function retryDelayMs(attemptCount: number, baseMs: number, maximumMs: number): number {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new MalformedPersistedFactsError();
  }
  let delay = baseMs;
  for (let attempt = 1; attempt < attemptCount && delay < maximumMs; attempt += 1) {
    delay = Math.min(maximumMs, delay * 2);
  }
  return delay;
}

function readApplicationGate(
  gate: (groupId: string) => boolean,
  groupId: string,
): boolean {
  try {
    return gate(groupId) === true;
  } catch {
    return false;
  }
}

function normalizeGroupIds(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_GROUP_IDS) {
    throw new Error(`groupIds must contain at most ${MAX_GROUP_IDS} items`);
  }
  return [...new Set(values.map((value) => requireIdentifier("groupId", value)))].sort();
}

function sanitizeBatchLimit(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("limit must be a safe integer");
  return Math.min(MAX_BATCH_LIMIT, Math.max(0, value));
}

function requireIdentifier(name: string, value: string): string {
  if (typeof value !== "string") throw new Error(`${name} is invalid`);
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > MAX_IDENTIFIER_CHARS) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function requireDelay(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be a positive safe timer delay`);
  }
  return value;
}

function requireDate(name: string, value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${name} is invalid`);
  return new Date(value);
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  const timestamp = value.getTime() + milliseconds;
  if (!Number.isSafeInteger(timestamp)) throw new Error("scanner timestamp is invalid");
  return requireDate("scanner timestamp", new Date(timestamp));
}

function requireCount(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`);
  return value;
}

function emptyBatch(): KnowledgeConflictScannerBatchResult {
  return {
    discovered: 0,
    claimed: 0,
    conflict: 0,
    noConflict: 0,
    insufficientEvidence: 0,
    permissionBlocked: 0,
    retrying: 0,
    deadLettered: 0,
    superseded: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
