import { createHash } from "node:crypto";

import type { ManagedKnowledgePage } from
  "../action-approvals/managed-knowledge-page.js";
import type { ManagedKnowledgePageRepository } from
  "../action-approvals/managed-knowledge-page-repository.js";
import type { DocumentSource } from "../documents/document-source-registry.js";
import {
  FeishuInteractiveCardClientError,
  type FeishuInteractiveCardClient,
  type FeishuInteractiveCardClientErrorClassification,
} from "../feishu/feishu-interactive-card-client.js";
import {
  createKnowledgeConflictCallbackNonce,
  renderKnowledgeConflictCard,
  type KnowledgeConflictCardRenderInput,
  type KnowledgeConflictCardRenderResult,
} from "./knowledge-conflict-card-renderer.js";
import type { KnowledgeConflictCurrentValidator } from "./knowledge-conflict-current-validator.js";
import type {
  KnowledgeConflictDeliveryClaim,
  KnowledgeConflictRepository,
} from "./knowledge-conflict-repository.js";
import {
  KnowledgeConflictDeliveryConflictError,
  KnowledgeConflictVersionConflictError,
} from "./knowledge-conflict-repository.js";

const MAX_BATCH_LIMIT = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_EXTERNAL_ATTEMPTS = 5;

export type KnowledgeConflictDeliveryGates = {
  featureEnabled: boolean;
  groupAllowed: boolean;
  proactiveSpeech: boolean;
  retrieveKnowledgeBase: boolean;
  generateKnowledgeDrafts: boolean;
};

export type KnowledgeConflictDispatcherCode =
  | "send_succeeded"
  | "runtime_disabled"
  | "stale_delivery"
  | "stale_candidate"
  | "permission_blocked"
  | "validation_unavailable"
  | "source_unavailable"
  | "managed_target_unavailable"
  | "bot_not_in_group"
  | "membership_unavailable"
  | "render_failed"
  | "attempt_boundary_unavailable"
  | "max_attempts_exhausted"
  | FeishuInteractiveCardClientErrorClassification;

export type KnowledgeConflictDispatcherResult = {
  status: "sent" | "retrying" | "permanent_failure" | "outcome_unknown";
  deliveryId: string;
  code: KnowledgeConflictDispatcherCode;
};

export type KnowledgeConflictDispatcherDependencies = {
  repository: Pick<KnowledgeConflictRepository,
    | "claimNextDelivery"
    | "beginDeliveryAttempt"
    | "completeDelivery"
    | "failDelivery"
    | "getDelivery"
  >;
  currentValidator: KnowledgeConflictCurrentValidator;
  documentSources: { findSourceById(id: string): Promise<DocumentSource | undefined> };
  managedPages: Pick<ManagedKnowledgePageRepository, "findEligiblePageForConflict">;
  cardClient: Pick<FeishuInteractiveCardClient, "sendCard">;
  renderer?: (input: KnowledgeConflictCardRenderInput) => KnowledgeConflictCardRenderResult;
  readDeliveryGates(groupId: string): KnowledgeConflictDeliveryGates;
  isBotCurrentMember(groupId: string): Promise<boolean>;
  workerId: string;
  leaseMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  reconciliationDelayMs: number;
  now?: () => Date;
};

export function createKnowledgeConflictDispatcher({
  repository,
  currentValidator,
  documentSources,
  managedPages,
  cardClient,
  renderer = renderKnowledgeConflictCard,
  readDeliveryGates,
  isBotCurrentMember,
  workerId,
  leaseMs,
  retryBaseDelayMs,
  retryMaxDelayMs,
  reconciliationDelayMs,
  now = () => new Date(),
}: KnowledgeConflictDispatcherDependencies) {
  const safeWorkerId = requireIdentifier("workerId", workerId);
  const safeLeaseMs = requireDelay("leaseMs", leaseMs);
  const safeRetryBaseDelayMs = requireDelay("retryBaseDelayMs", retryBaseDelayMs);
  const safeRetryMaxDelayMs = requireDelay("retryMaxDelayMs", retryMaxDelayMs);
  const safeReconciliationDelayMs = requireDelay("reconciliationDelayMs", reconciliationDelayMs);
  if (safeRetryMaxDelayMs < safeRetryBaseDelayMs) {
    throw new Error("retryMaxDelayMs must be at least retryBaseDelayMs");
  }

  const dispatchDependencies = {
    repository,
    currentValidator,
    documentSources,
    managedPages,
    cardClient,
    renderer,
    readDeliveryGates,
    isBotCurrentMember,
    retryBaseDelayMs: safeRetryBaseDelayMs,
    retryMaxDelayMs: safeRetryMaxDelayMs,
    reconciliationDelayMs: safeReconciliationDelayMs,
    now,
  };

  return {
    async processBatch({ limit }: { limit: number }): Promise<KnowledgeConflictDispatcherResult[]> {
      const results: KnowledgeConflictDispatcherResult[] = [];
      for (let index = 0; index < sanitizeLimit(limit); index += 1) {
        const claimedAt = requireDate(now());
        const claim = await repository.claimNextDelivery({
          workerId: safeWorkerId,
          at: claimedAt,
          leaseUntil: new Date(claimedAt.getTime() + safeLeaseMs),
        });
        if (claim === undefined) break;
        results.push(await dispatchClaim({
          ...dispatchDependencies,
          claim,
          workerId: safeWorkerId,
        }));
      }
      return results;
    },
  };
}

type DispatchClaimInput = {
  claim: KnowledgeConflictDeliveryClaim;
  workerId: string;
  repository: KnowledgeConflictDispatcherDependencies["repository"];
  currentValidator: KnowledgeConflictCurrentValidator;
  documentSources: KnowledgeConflictDispatcherDependencies["documentSources"];
  managedPages: KnowledgeConflictDispatcherDependencies["managedPages"];
  cardClient: KnowledgeConflictDispatcherDependencies["cardClient"];
  renderer: NonNullable<KnowledgeConflictDispatcherDependencies["renderer"]>;
  readDeliveryGates: KnowledgeConflictDispatcherDependencies["readDeliveryGates"];
  isBotCurrentMember: KnowledgeConflictDispatcherDependencies["isBotCurrentMember"];
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  reconciliationDelayMs: number;
  now: () => Date;
};

async function dispatchClaim(input: DispatchClaimInput): Promise<KnowledgeConflictDispatcherResult> {
  const { delivery, candidate } = input.claim;
  if (!exactClaim(input)) return fail(input, "permanent", "stale_delivery");
  if (!gatesOpen(input, candidate.groupId)) return fail(input, "permanent", "runtime_disabled");
  const firstMembership = await readMembership(input, candidate.groupId);
  if (firstMembership !== "member") {
    return fail(input, firstMembership === "not_member" ? "permanent" : "retryable",
      firstMembership === "not_member" ? "bot_not_in_group" : "membership_unavailable");
  }

  let source: DocumentSource | undefined;
  try {
    source = await input.documentSources.findSourceById(candidate.targetDocumentSourceId);
  } catch {
    return fail(input, "retryable", "source_unavailable");
  }
  if (!exactSource(candidate, source)) return fail(input, "permanent", "stale_candidate");

  let managedPage: ManagedKnowledgePage | undefined;
  try {
    managedPage = await input.managedPages.findEligiblePageForConflict({
      documentSourceId: candidate.targetDocumentSourceId,
      authorizationGroupId: candidate.groupId,
    });
  } catch {
    return fail(input, "retryable", "managed_target_unavailable");
  }
  const managedUpdateTarget = managedPage === undefined
    ? undefined
    : exactManagedUpdateTarget(candidate, managedPage);
  if (managedPage !== undefined && managedUpdateTarget === undefined) {
    return fail(input, "retryable", "managed_target_unavailable");
  }

  let rendered: KnowledgeConflictCardRenderResult;
  try {
    rendered = input.renderer({
      candidate,
      source,
      nonce: createKnowledgeConflictCallbackNonce(delivery.id),
      ...(managedUpdateTarget === undefined ? {} : { managedUpdateTarget }),
    });
  } catch {
    return fail(input, "permanent", "render_failed");
  }

  if (!gatesOpen(input, candidate.groupId)) return fail(input, "permanent", "runtime_disabled");
  const finalMembership = await readMembership(input, candidate.groupId);
  if (finalMembership !== "member") {
    return fail(input, finalMembership === "not_member" ? "permanent" : "retryable",
      finalMembership === "not_member" ? "bot_not_in_group" : "membership_unavailable");
  }

  let validation: Awaited<ReturnType<KnowledgeConflictCurrentValidator["validate"]>>;
  try {
    validation = await input.currentValidator.validate({ candidate, expectedVersion: candidate.version });
  } catch {
    return fail(input, "retryable", "validation_unavailable");
  }
  if (validation.status === "superseded") {
    return settlePermanent(input, "stale_candidate");
  }
  if (validation.status === "permission_blocked") {
    return fail(input, "permanent", "permission_blocked");
  }
  if (validation.status === "validation_unavailable") {
    return fail(input, "retryable", "validation_unavailable");
  }
  if (!exactValidatedCandidate(candidate, validation.candidate)) {
    return settlePermanent(input, "stale_candidate");
  }

  if (!gatesOpen(input, candidate.groupId)) {
    return settlePermanent(input, "runtime_disabled");
  }
  const postValidationMembership = await readMembership(input, candidate.groupId);
  if (postValidationMembership !== "member") {
    return postValidationMembership === "not_member"
      ? settlePermanent(input, "bot_not_in_group")
      : fail(input, "retryable", "membership_unavailable");
  }
  if (!gatesOpen(input, candidate.groupId)) {
    return settlePermanent(input, "runtime_disabled");
  }

  try {
    await input.repository.beginDeliveryAttempt({
      deliveryId: delivery.id,
      candidateId: candidate.id,
      expectedCandidateVersion: candidate.version,
      expectedAttemptCount: delivery.attemptCount,
      workerId: input.workerId,
      at: requireDate(input.now()),
    });
  } catch (error) {
    if (error instanceof KnowledgeConflictVersionConflictError
      || error instanceof KnowledgeConflictDeliveryConflictError) {
      return settlePermanent(input, "stale_candidate");
    }
    return fail(input, "retryable", "attempt_boundary_unavailable");
  }

  let sent: { messageId: string };
  try {
    sent = await input.cardClient.sendCard({
      chatId: candidate.groupId,
      cardJson: rendered.json,
      uuid: stableDeliveryUuid(delivery.id),
    });
  } catch (error) {
    return failFromCardError(input, error);
  }
  try {
    await input.repository.completeDelivery({
      deliveryId: delivery.id,
      workerId: input.workerId,
      messageId: sent.messageId,
      at: requireDate(input.now()),
    });
  } catch {
    return fail(input, "outcome_unknown", "outcome_unknown");
  }
  return result(delivery.id, "sent", "send_succeeded");
}

async function settlePermanent(
  input: DispatchClaimInput,
  code: KnowledgeConflictDispatcherCode,
): Promise<KnowledgeConflictDispatcherResult> {
  try {
    return await fail(input, "permanent", code);
  } catch (error) {
    if (!(error instanceof KnowledgeConflictDeliveryConflictError)) throw error;
    const current = await input.repository.getDelivery(input.claim.delivery.id);
    if (current?.status === "cancelled" || (current?.status === "failed" && !current.retryable)) {
      return result(input.claim.delivery.id, "permanent_failure", code);
    }
    if (current?.status === "outcome_unknown") {
      return result(input.claim.delivery.id, "outcome_unknown", "outcome_unknown");
    }
    if (current?.status === "sent") {
      return result(input.claim.delivery.id, "sent", "send_succeeded");
    }
    throw error;
  }
}

function failFromCardError(
  input: DispatchClaimInput,
  error: unknown,
): Promise<KnowledgeConflictDispatcherResult> {
  const classification = error instanceof FeishuInteractiveCardClientError
    ? error.classification
    : "outcome_unknown";
  if (classification === "outcome_unknown") return fail(input, "outcome_unknown", classification);
  if (classification === "remote_rejected") return fail(input, "permanent", classification);
  if (input.claim.delivery.attemptCount >= MAX_EXTERNAL_ATTEMPTS) {
    return fail(input, "permanent", "max_attempts_exhausted");
  }
  return fail(input, "retryable", classification);
}

async function fail(
  input: DispatchClaimInput,
  classification: "retryable" | "permanent" | "outcome_unknown",
  code: KnowledgeConflictDispatcherCode,
): Promise<KnowledgeConflictDispatcherResult> {
  const boundedClassification = classification === "retryable"
    && input.claim.delivery.attemptCount >= MAX_EXTERNAL_ATTEMPTS
    ? "permanent"
    : classification;
  const boundedCode = classification === "retryable"
    && boundedClassification === "permanent"
    ? "max_attempts_exhausted"
    : code;
  const failedAt = requireDate(input.now());
  await input.repository.failDelivery({
    deliveryId: input.claim.delivery.id,
    workerId: input.workerId,
    classification: boundedClassification,
    errorCode: boundedCode,
    ...(boundedClassification === "retryable"
      ? { retryAt: new Date(failedAt.getTime() + retryDelay(input)) }
      : boundedClassification === "outcome_unknown"
        ? { reconciliationDueAt: new Date(failedAt.getTime() + input.reconciliationDelayMs) }
        : {}),
    at: failedAt,
  });
  return result(
    input.claim.delivery.id,
    boundedClassification === "retryable"
      ? "retrying"
      : boundedClassification === "permanent" ? "permanent_failure" : "outcome_unknown",
    boundedCode,
  );
}

function result(
  deliveryId: string,
  status: KnowledgeConflictDispatcherResult["status"],
  code: KnowledgeConflictDispatcherCode,
): KnowledgeConflictDispatcherResult {
  return { status, deliveryId, code };
}

function retryDelay(input: DispatchClaimInput): number {
  const exponent = Math.max(0, input.claim.delivery.attemptCount - 1);
  return Math.min(input.retryMaxDelayMs, input.retryBaseDelayMs * (2 ** Math.min(exponent, 30)));
}

function gatesOpen(input: DispatchClaimInput, groupId: string): boolean {
  try {
    const gates = input.readDeliveryGates(groupId);
    return gates.featureEnabled === true
      && gates.groupAllowed === true
      && gates.proactiveSpeech === true
      && gates.retrieveKnowledgeBase === true
      && gates.generateKnowledgeDrafts === true;
  } catch {
    return false;
  }
}

async function readMembership(
  input: DispatchClaimInput,
  groupId: string,
): Promise<"member" | "not_member" | "unavailable"> {
  try {
    return await input.isBotCurrentMember(groupId) ? "member" : "not_member";
  } catch {
    return "unavailable";
  }
}

function exactClaim(input: DispatchClaimInput): boolean {
  const { delivery, candidate } = input.claim;
  return delivery.status === "processing"
    && delivery.leaseWorkerId === input.workerId
    && delivery.candidateId === candidate.id
    && delivery.groupId === candidate.groupId
    && candidate.status === "approved_for_delivery"
    && Number.isSafeInteger(candidate.version)
    && candidate.version > 0
    && Number.isSafeInteger(delivery.attemptCount)
    && delivery.attemptCount > 0;
}

function exactSource(
  candidate: KnowledgeConflictDeliveryClaim["candidate"],
  source: DocumentSource | undefined,
): source is DocumentSource {
  return source !== undefined
    && source.id === candidate.targetDocumentSourceId
    && source.sourceType === "authorized_wiki_document"
    && source.syncState === "synced"
    && (source.permissionState === "readable" || source.permissionState === "unknown")
    && source.canUseForKnowledgeDrafts
    && validDate(source.updatedAt)
    && validDate(candidate.targetSourceUpdatedAt)
    && source.updatedAt.getTime() === candidate.targetSourceUpdatedAt.getTime();
}

function exactManagedUpdateTarget(
  candidate: KnowledgeConflictDeliveryClaim["candidate"],
  page: ManagedKnowledgePage,
): KnowledgeConflictCardRenderInput["managedUpdateTarget"] {
  if (page.state !== "active" ||
    page.linkedDocumentSourceId !== candidate.targetDocumentSourceId ||
    page.authorizationGroupId !== candidate.groupId ||
    page.currentRemoteRevisionId === undefined ||
    page.currentBodyContentHash === undefined) {
    return undefined;
  }
  return {
    managedPageId: page.id,
    managedPageVersion: page.version,
    expectedRemoteRevisionId: page.currentRemoteRevisionId,
  };
}

function exactValidatedCandidate(
  claimed: KnowledgeConflictDeliveryClaim["candidate"],
  validated: KnowledgeConflictDeliveryClaim["candidate"],
): boolean {
  return validated.id === claimed.id
    && validated.groupId === claimed.groupId
    && validated.version === claimed.version
    && validated.status === "approved_for_delivery"
    && validated.targetDocumentSourceId === claimed.targetDocumentSourceId
    && validated.targetSnapshotId === claimed.targetSnapshotId
    && validated.targetContentHash === claimed.targetContentHash;
}

function stableDeliveryUuid(deliveryId: string): string {
  return createHash("sha256")
    .update(`knowledge-conflict-card:${deliveryId}`)
    .digest("hex")
    .slice(0, 50);
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("knowledge conflict dispatcher batch limit must be a finite safe-magnitude number");
  }
  return Math.min(MAX_BATCH_LIMIT, Math.max(0, Math.floor(value)));
}

function requireDelay(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  return value;
}

function requireIdentifier(name: string, value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function requireDate(value: Date): Date {
  if (!validDate(value)) throw new Error("knowledge conflict dispatcher time must be valid");
  return new Date(value);
}
