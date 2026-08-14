import type { DocumentSource } from "../documents/document-source-registry.js";
import type { FeishuDocumentPermissionChecker } from
  "../permissions/feishu-document-permission-checker.js";
import type { KnowledgeConflictCandidate } from "./knowledge-conflict.js";
import {
  KnowledgeConflictStaleEvidenceError,
  KnowledgeConflictVersionConflictError,
  type KnowledgeConflictRepository,
} from "./knowledge-conflict-repository.js";
import {
  KnowledgeConflictPermissionUnavailableError,
  reattestKnowledgeConflictSourcePermissions,
} from "./knowledge-conflict-permission-reattestation.js";

const SAFE_STALE_REASONS = new Set([
  "memory_stale", "message_stale", "source_stale", "snapshot_stale", "fragment_stale",
  "permission_stale",
]);

export type KnowledgeConflictCurrentValidationResult =
  | { status: "current"; candidate: KnowledgeConflictCandidate; permissionAttestedAt: Date }
  | { status: "superseded"; candidate: KnowledgeConflictCandidate; reason: string }
  | { status: "permission_blocked"; candidate: KnowledgeConflictCandidate }
  | { status: "validation_unavailable"; candidate: KnowledgeConflictCandidate };

export type KnowledgeConflictCurrentValidator = {
  validate(input: {
    candidate: KnowledgeConflictCandidate;
    expectedVersion: number;
  }): Promise<KnowledgeConflictCurrentValidationResult>;
};

export function createKnowledgeConflictCurrentValidator(dependencies: {
  repository: Pick<KnowledgeConflictRepository, "validateCandidateCurrentState">;
  documentSources: { findSourceById(id: string): Promise<DocumentSource | undefined> };
  permissionChecker: FeishuDocumentPermissionChecker;
  now?: () => Date;
}): KnowledgeConflictCurrentValidator {
  const now = dependencies.now ?? (() => new Date());
  return {
    async validate({ candidate, expectedVersion }) {
      const sources = candidate.evidence
        .filter((evidence) => evidence.type === "document_source")
        .map((evidence) => ({
          documentSourceId: evidence.documentSourceId,
          expectedUpdatedAt: new Date(evidence.expectedUpdatedAt),
        }));
      try {
        const permission = await reattestKnowledgeConflictSourcePermissions({
          sources,
          documentSources: dependencies.documentSources,
          permissionChecker: dependencies.permissionChecker,
          now,
        });
        if (permission.status === "stale" && permission.permissionAttestedAt === undefined) {
          return { status: "superseded", candidate, reason: permission.reason };
        }
        if (permission.status === "permission_blocked") {
          return { status: "permission_blocked", candidate };
        }
        const permissionAttestedAt = permission.permissionAttestedAt;
        if (permissionAttestedAt === undefined) {
          throw new KnowledgeConflictPermissionUnavailableError();
        }
        const at = new Date(permissionAttestedAt);
        const result = await dependencies.repository.validateCandidateCurrentState({
          candidateId: candidate.id,
          expectedVersion,
          permissionAttestedAt,
          operationKey: `current-validation:${candidate.id}:v${expectedVersion}`,
          at,
        });
        return result.status === "current"
          ? {
              status: "current",
              candidate: result.candidate,
              permissionAttestedAt: new Date(permissionAttestedAt),
            }
          : {
              status: "superseded",
              candidate: result.candidate,
              reason: safeReason(result.reasonCode),
            };
      } catch (error) {
        if (error instanceof KnowledgeConflictVersionConflictError) throw error;
        if (error instanceof KnowledgeConflictStaleEvidenceError) {
          return { status: "superseded", candidate, reason: safeReason(error.reasonCode) };
        }
        if (error instanceof KnowledgeConflictPermissionUnavailableError) {
          return { status: "validation_unavailable", candidate };
        }
        return { status: "validation_unavailable", candidate };
      }
    },
  };
}

function safeReason(reason: string): string {
  return SAFE_STALE_REASONS.has(reason) ? reason : "evidence_stale";
}
