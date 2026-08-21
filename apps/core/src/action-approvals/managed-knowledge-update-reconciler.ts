import { createHash } from "node:crypto";

import {
  createDocumentSyncIdempotencyKey,
  type DocumentSyncQueue,
} from "../documents/document-sync-queue.js";

import type { ManagedKnowledgeUpdater, ManagedUpdateOutcome } from "./feishu-managed-knowledge-updater.js";
import type {
  ClaimedManagedKnowledgeUpdate,
  ManagedKnowledgePageRepository,
} from "./managed-knowledge-page-repository.js";
import type { ManagedKnowledgeMutationPermissionVerifier } from
  "./managed-knowledge-mutation-permission-verifier.js";

const MAX_BATCH_LIMIT = 100;

export type ManagedKnowledgeUpdateReconciliationResult = {
  status: "applied" | "retry_same_token" | "reconciliation_required";
  executionId: string;
  code: string;
};

export function createManagedKnowledgeUpdateReconciler({
  managedPages,
  updater,
  syncQueue,
  workerId,
  staleDispatchMs,
  activeEmbeddingProfileId,
  permissionVerifier,
  now = () => new Date(),
}: {
  managedPages: Pick<
    ManagedKnowledgePageRepository,
    | "listReconciliationRequired"
    | "markRemoteRequestDispatched"
    | "claimRemoteRetry"
    | "recordRemoteOutcome"
    | "findResyncReadyExecution"
    | "completeResync"
  >;
  updater: ManagedKnowledgeUpdater;
  syncQueue: Pick<DocumentSyncQueue, "enqueue">;
  workerId: string;
  staleDispatchMs: number;
  activeEmbeddingProfileId: string;
  permissionVerifier: ManagedKnowledgeMutationPermissionVerifier;
  now?: () => Date;
}) {
  const safeWorkerId = requireIdentifier("workerId", workerId);
  const safeStaleDispatchMs = requirePositiveInteger("staleDispatchMs", staleDispatchMs);
  const safeActiveEmbeddingProfileId = requireIdentifier(
    "activeEmbeddingProfileId",
    activeEmbeddingProfileId,
  );
  const dependencies = {
    managedPages, updater, permissionVerifier, syncQueue, workerId: safeWorkerId,
    staleDispatchMs: safeStaleDispatchMs,
    activeEmbeddingProfileId: safeActiveEmbeddingProfileId,
    now,
  };
  const reconcileOne = (claim: ClaimedManagedKnowledgeUpdate) =>
    reconcileManagedKnowledgeUpdate({ ...dependencies, claim });
  return {
    reconcileOne,
    async processBatch({ limit }: { limit: number }): Promise<ManagedKnowledgeUpdateReconciliationResult[]> {
      const observedAt = requireDate(now());
      const work = await managedPages.listReconciliationRequired({
        limit: sanitizeLimit(limit),
        dispatchedBefore: new Date(observedAt.getTime() - safeStaleDispatchMs),
        claimedBefore: new Date(observedAt.getTime() - safeStaleDispatchMs),
      });
      const results: ManagedKnowledgeUpdateReconciliationResult[] = [];
      for (const claim of work) {
        try {
          results.push(await reconcileOne(claim));
        } catch {
          results.push({
            status: "reconciliation_required",
            executionId: claim.execution.id,
            code: "reconciliation_failed",
          });
        }
      }
      return results;
    },
  };
}

async function reconcileManagedKnowledgeUpdate(input: {
  managedPages: Pick<
    ManagedKnowledgePageRepository,
    "markRemoteRequestDispatched" | "claimRemoteRetry" | "recordRemoteOutcome" |
    "findResyncReadyExecution" | "completeResync"
  >;
  updater: ManagedKnowledgeUpdater;
  syncQueue: Pick<DocumentSyncQueue, "enqueue">;
  claim: ClaimedManagedKnowledgeUpdate;
  workerId: string;
  staleDispatchMs: number;
  activeEmbeddingProfileId: string;
  permissionVerifier: ManagedKnowledgeMutationPermissionVerifier;
  now: () => Date;
}): Promise<ManagedKnowledgeUpdateReconciliationResult> {
  if (input.claim.execution.state === "claimed") return recoverStaleClaim(input);
  if (input.claim.execution.state === "remote_applied") {
    if (!await enqueueAndComplete(input, input.claim.execution)) {
      return { status: "reconciliation_required", executionId: input.claim.execution.id, code: "resync_enqueue_failed" };
    }
    return { status: "applied", executionId: input.claim.execution.id, code: "resync_enqueued" };
  }
  let observation;
  try {
    observation = await input.updater.readBack(remoteIdentity(input.claim));
  } catch {
    await requireReconciliation(input, "readback_unavailable");
    return {
      status: "reconciliation_required",
      executionId: input.claim.execution.id,
      code: "readback_unavailable",
    };
  }
  const expectedRevision = parsePositiveRevision(input.claim.execution.expectedRemoteRevisionId);
  if (
    expectedRevision !== undefined &&
    observation.blockType === "text" &&
    observation.revision > expectedRevision &&
    observation.canonicalBodyHash === input.claim.execution.afterBodyContentHash
  ) {
    const applied = await input.managedPages.recordRemoteOutcome({
      executionId: input.claim.execution.id,
      expectedExecutionVersion: input.claim.execution.version,
      classification: "remote_applied",
      pageDisposition: "resync_required",
      responseClassification: "readback_applied",
      responseRevisionId: String(observation.revision),
      operationKey: stableOperationKey("managed-update-reconciled-applied", [input.claim.execution.id]),
      actor: input.workerId,
      at: requireDate(input.now()),
    });
    if (!await enqueueAndComplete(input, applied.execution)) {
      return { status: "reconciliation_required", executionId: input.claim.execution.id, code: "resync_enqueue_failed" };
    }
    return { status: "applied", executionId: input.claim.execution.id, code: "readback_applied" };
  }
  if (
    expectedRevision !== undefined &&
    observation.blockType === "text" &&
    observation.revision === expectedRevision &&
    observation.canonicalBodyHash === input.claim.execution.beforeBodyContentHash
  ) {
    return retrySameToken(input);
  }
  await requireReconciliation(input, "human_edit_or_unexpected_readback");
  return {
    status: "reconciliation_required",
    executionId: input.claim.execution.id,
    code: "human_edit_or_unexpected_readback",
  };
}

async function recoverStaleClaim(
  input: Parameters<typeof reconcileManagedKnowledgeUpdate>[0],
): Promise<ManagedKnowledgeUpdateReconciliationResult> {
  const failPreflight = async (
    code: string,
    pageDisposition: "reconciliation_required" | "blocked" = "reconciliation_required",
  ) => {
    await input.managedPages.recordRemoteOutcome({
      executionId: input.claim.execution.id,
      expectedExecutionVersion: input.claim.execution.version,
      classification: "preflight_failed",
      pageDisposition,
      responseClassification: code,
      reconciliationReasonCode: code,
      operationKey: stableOperationKey("managed-update-stale-claim-preflight-failed", [
        input.claim.execution.id,
        code,
      ]),
      actor: input.workerId,
      at: requireDate(input.now()),
    });
    return {
      status: "reconciliation_required" as const,
      executionId: input.claim.execution.id,
      code,
    };
  };
  if (input.claim.execution.approvalId === undefined ||
    input.claim.execution.executorId === undefined) {
    return failPreflight("stale_claim_identity_missing");
  }
  const permissionFailure = await livePermissionFailure(input);
  if (permissionFailure !== undefined) return failPreflight(permissionFailure, "blocked");
  let preflight;
  try {
    preflight = await input.updater.preflight(remoteIdentity(input.claim));
  } catch {
    return failPreflight("stale_claim_preflight_unavailable");
  }
  const expectedRevision = parsePositiveRevision(input.claim.execution.expectedRemoteRevisionId);
  if (
    expectedRevision === undefined || preflight.blockType !== "text" ||
    preflight.revision !== expectedRevision ||
    preflight.canonicalBodyHash !== input.claim.execution.beforeBodyContentHash
  ) return failPreflight("stale_claim_preflight_mismatch");

  let dispatched;
  try {
    dispatched = await input.managedPages.markRemoteRequestDispatched({
      executionId: input.claim.execution.id,
      expectedExecutionVersion: input.claim.execution.version,
      operationKey: stableOperationKey("managed-update-stale-claim-dispatched", [
        input.claim.execution.id,
      ]),
      actor: input.workerId,
      at: requireDate(input.now()),
    });
  } catch {
    return {
      status: "reconciliation_required",
      executionId: input.claim.execution.id,
      code: "stale_claim_dispatch_not_claimed",
    };
  }
  let outcome: ManagedUpdateOutcome;
  try {
    outcome = await input.updater.update({
      ...remoteIdentity(input.claim),
      expectedRevision,
      proposedBody: input.claim.draft.content,
      clientToken: input.claim.execution.clientToken,
    });
  } catch {
    outcome = { kind: "unknown", code: "connection_lost" };
  }
  if (outcome.kind === "applied") {
    const applied = await input.managedPages.recordRemoteOutcome({
      executionId: input.claim.execution.id,
      expectedExecutionVersion: dispatched.execution.version,
      classification: "remote_applied",
      pageDisposition: "resync_required",
      responseClassification: "stale_claim_applied",
      responseRevisionId: String(outcome.resultingRevision),
      operationKey: stableOperationKey("managed-update-stale-claim-applied", [
        input.claim.execution.id,
      ]),
      actor: input.workerId,
      at: requireDate(input.now()),
    });
    if (!await enqueueAndComplete(input, applied.execution)) {
      return {
        status: "reconciliation_required",
        executionId: input.claim.execution.id,
        code: "resync_enqueue_failed",
      };
    }
    return { status: "applied", executionId: input.claim.execution.id, code: "stale_claim_applied" };
  }
  if (outcome.kind === "rejected") {
    const pageDisposition = outcome.code === "forbidden"
      ? "blocked" as const
      : outcome.code === "missing"
        ? "retired" as const
        : "reconciliation_required" as const;
    await input.managedPages.recordRemoteOutcome({
      executionId: input.claim.execution.id,
      expectedExecutionVersion: dispatched.execution.version,
      classification: "failed",
      pageDisposition,
      responseClassification: outcome.code,
      reconciliationReasonCode: outcome.code,
      operationKey: stableOperationKey("managed-update-stale-claim-rejected", [
        input.claim.execution.id,
      ]),
      actor: input.workerId,
      at: requireDate(input.now()),
    });
    return { status: "reconciliation_required", executionId: input.claim.execution.id, code: outcome.code };
  }
  await input.managedPages.recordRemoteOutcome({
    executionId: input.claim.execution.id,
    expectedExecutionVersion: dispatched.execution.version,
    classification: "outcome_unknown",
    pageDisposition: "reconciliation_required",
    responseClassification: outcome.code,
    reconciliationReasonCode: "stale_claim_outcome_unresolved",
    operationKey: stableOperationKey("managed-update-stale-claim-outcome-unknown", [
      input.claim.execution.id,
    ]),
    actor: input.workerId,
    at: requireDate(input.now()),
  });
  return { status: "reconciliation_required", executionId: input.claim.execution.id, code: outcome.code };
}

async function retrySameToken(
  input: Parameters<typeof reconcileManagedKnowledgeUpdate>[0],
): Promise<ManagedKnowledgeUpdateReconciliationResult> {
  const permissionFailure = await livePermissionFailure(input);
  if (permissionFailure !== undefined) {
    await input.managedPages.recordRemoteOutcome({
      executionId: input.claim.execution.id,
      expectedExecutionVersion: input.claim.execution.version,
      classification: "failed",
      pageDisposition: "blocked",
      responseClassification: permissionFailure,
      reconciliationReasonCode: permissionFailure,
      operationKey: stableOperationKey("managed-update-retry-permission-failed", [
        input.claim.execution.id,
        permissionFailure,
      ]),
      actor: input.workerId,
      at: requireDate(input.now()),
    });
    return {
      status: "reconciliation_required",
      executionId: input.claim.execution.id,
      code: permissionFailure,
    };
  }
  let retry;
  try {
    const claimedAt = requireDate(input.now());
    retry = await input.managedPages.claimRemoteRetry({
      executionId: input.claim.execution.id,
      expectedExecutionVersion: input.claim.execution.version,
      operationKey: stableOperationKey("managed-update-reconcile-safe-retry", [input.claim.execution.id]),
      actor: input.workerId,
      at: claimedAt,
      staleDispatchedBefore: new Date(claimedAt.getTime() - input.staleDispatchMs),
    });
  } catch {
    return {
      status: "reconciliation_required",
      executionId: input.claim.execution.id,
      code: "safe_retry_not_claimed",
    };
  }
  let outcome: ManagedUpdateOutcome;
  try {
    outcome = await input.updater.update({
      ...remoteIdentity(input.claim),
      expectedRevision: parsePositiveRevision(input.claim.execution.expectedRemoteRevisionId)!,
      proposedBody: input.claim.draft.content,
      clientToken: input.claim.execution.clientToken,
    });
  } catch {
    outcome = { kind: "unknown", code: "connection_lost" };
  }
  if (outcome.kind === "applied") {
    const applied = await input.managedPages.recordRemoteOutcome({
      executionId: input.claim.execution.id,
      expectedExecutionVersion: retry.execution.version,
      classification: "remote_applied",
      pageDisposition: "resync_required",
      responseClassification: "safe_retry_applied",
      responseRevisionId: String(outcome.resultingRevision),
      operationKey: stableOperationKey("managed-update-reconcile-retry-applied", [input.claim.execution.id]),
      actor: input.workerId,
      at: requireDate(input.now()),
    });
    if (!await enqueueAndComplete(input, applied.execution)) {
      return {
        status: "reconciliation_required",
        executionId: input.claim.execution.id,
        code: "resync_enqueue_failed",
      };
    }
    return {
      status: "retry_same_token",
      executionId: input.claim.execution.id,
      code: "safe_retry_applied",
    };
  }
  if (outcome.kind === "rejected") {
    const pageDisposition = outcome.code === "forbidden"
      ? "blocked" as const
      : outcome.code === "missing"
        ? "retired" as const
        : "reconciliation_required" as const;
    await input.managedPages.recordRemoteOutcome({
      executionId: input.claim.execution.id,
      expectedExecutionVersion: retry.execution.version,
      classification: "failed",
      pageDisposition,
      responseClassification: outcome.code,
      reconciliationReasonCode: outcome.code,
      operationKey: stableOperationKey("managed-update-reconcile-retry-rejected", [input.claim.execution.id]),
      actor: input.workerId,
      at: requireDate(input.now()),
    });
    return {
      status: "retry_same_token",
      executionId: input.claim.execution.id,
      code: outcome.code,
    };
  }
  await input.managedPages.recordRemoteOutcome({
    executionId: input.claim.execution.id,
    expectedExecutionVersion: retry.execution.version,
    classification: "outcome_unknown",
    pageDisposition: "reconciliation_required",
    responseClassification: outcome.code,
    reconciliationReasonCode: "safe_retry_outcome_unresolved",
    operationKey: stableOperationKey("managed-update-reconcile-retry-unknown", [input.claim.execution.id]),
    actor: input.workerId,
    at: requireDate(input.now()),
  });
  return {
    status: "retry_same_token",
    executionId: input.claim.execution.id,
    code: outcome.code,
  };
}

async function livePermissionFailure(
  input: Parameters<typeof reconcileManagedKnowledgeUpdate>[0],
): Promise<"permission_denied" | "permission_unavailable" | undefined> {
  try {
    const allowed = await input.permissionVerifier.verify({
      documentSourceId: input.claim.target.linkedDocumentSourceId,
      authorizationGroupId: input.claim.target.authorizationGroupId,
    });
    return allowed ? undefined : "permission_denied";
  } catch {
    return "permission_unavailable";
  }
}

async function requireReconciliation(
  input: Parameters<typeof reconcileManagedKnowledgeUpdate>[0],
  reasonCode: string,
): Promise<void> {
  if (input.claim.execution.state === "reconciliation_required") return;
  await input.managedPages.recordRemoteOutcome({
    executionId: input.claim.execution.id,
    expectedExecutionVersion: input.claim.execution.version,
    classification: "reconciliation_required",
    pageDisposition: "reconciliation_required",
    responseClassification: reasonCode,
    reconciliationReasonCode: reasonCode,
    operationKey: stableOperationKey("managed-update-reconciliation-required", [
      input.claim.execution.id,
      reasonCode,
    ]),
    actor: input.workerId,
    at: requireDate(input.now()),
  });
}

async function enqueueAndComplete(
  input: Parameters<typeof reconcileManagedKnowledgeUpdate>[0],
  execution: ClaimedManagedKnowledgeUpdate["execution"],
): Promise<boolean> {
  try {
    await input.syncQueue.enqueue({
      idempotencyKey: createDocumentSyncIdempotencyKey({
        documentSourceId: input.claim.target.linkedDocumentSourceId,
      }),
      documentSourceId: input.claim.target.linkedDocumentSourceId,
      reason: "manual_source_sync",
      enqueuedAt: requireDate(input.now()),
      attempts: 0,
    });
  } catch {
    await input.managedPages.recordRemoteOutcome({
      executionId: execution.id,
      expectedExecutionVersion: execution.version,
      classification: "reconciliation_required",
      pageDisposition: "reconciliation_required",
      responseClassification: "resync_enqueue_failed",
      ...(execution.responseRevisionId === undefined
        ? {}
        : { responseRevisionId: execution.responseRevisionId }),
      reconciliationReasonCode: "resync_enqueue_failed",
      operationKey: stableOperationKey("managed-update-reconcile-enqueue-failed", [execution.id]),
      actor: input.workerId,
      at: requireDate(input.now()),
    });
    return false;
  }
  const candidate = await input.managedPages.findResyncReadyExecution({
    executionId: input.claim.execution.id,
    activeEmbeddingProfileId: input.activeEmbeddingProfileId,
  });
  if (candidate === undefined) return true;
  await input.managedPages.completeResync({
    executionId: candidate.executionId,
    expectedExecutionVersion: candidate.executionVersion,
    expectedManagedPageVersion: candidate.managedPageVersion,
    observationId: candidate.observationId,
    activeEmbeddingProfileId: input.activeEmbeddingProfileId,
    operationKey: stableOperationKey("managed-update-resync-complete", [
      candidate.executionId,
      candidate.observationId,
    ]),
    actor: input.workerId,
    at: requireDate(input.now()),
  });
  return true;
}

function remoteIdentity(claim: ClaimedManagedKnowledgeUpdate) {
  return {
    remoteDocumentToken: claim.target.remoteDocumentToken,
    managedBodyBlockId: claim.target.managedBodyBlockId,
  };
}

function parsePositiveRevision(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function stableOperationKey(prefix: string, identity: string[]): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function sanitizeLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_BATCH_LIMIT) {
    throw new Error("batch limit is invalid");
  }
  return Number(value);
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} is invalid`);
  return Number(value);
}

function requireIdentifier(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if ([...normalized].length < 1 || [...normalized].length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("date is invalid");
  return new Date(value);
}
