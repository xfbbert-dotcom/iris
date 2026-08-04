import {
  WikiSpaceSyncError,
  type WikiSpaceSyncErrorClassification,
} from "./feishu-wiki-space-client.js";
import type { WikiSpaceAuthorizationRepository } from "./wiki-space-authorization-repository.js";
import type { WikiSpaceScanResult } from "./wiki-space-scanner.js";

export type AuthorizedWikiDocumentRegistrar = {
  register(input: {
    sourceUri: string;
    title?: string;
    authorizedSpaceId: string;
    observedAt: Date;
  }): Promise<{ sourceId: string; enqueueStatus: "enqueued" | "already_pending" }>;
};

export type WikiSpaceSyncWorkerResult =
  | { status: "idle" }
  | {
      status: "synced";
      authorizationId: string;
      registeredDocumentCount: number;
      skippedNodeCount: number;
    }
  | {
      status: "retrying" | "dead_lettered";
      authorizationId: string;
      classification: string;
    };

export type WikiSpaceSyncWorkerDependencies = {
  repository: Pick<WikiSpaceAuthorizationRepository, "claimNext" | "complete" | "fail">;
  scanner(input: { rootNodeToken: string }): Promise<WikiSpaceScanResult>;
  registrar: AuthorizedWikiDocumentRegistrar;
  leaseMs: number;
  refreshIntervalMs: number;
  maxAttempts: number;
  now?: () => Date;
};

const MAX_RETRY_DELAY_MS = 30 * 60 * 1_000;
const INITIAL_RETRY_DELAY_MS = 30 * 1_000;

export function createWikiSpaceSyncWorker({
  repository,
  scanner,
  registrar,
  leaseMs,
  refreshIntervalMs,
  maxAttempts,
  now = () => new Date(),
}: WikiSpaceSyncWorkerDependencies) {
  const safeLeaseMs = requirePositiveSafeInteger("leaseMs", leaseMs);
  const safeRefreshIntervalMs = requirePositiveSafeInteger("refreshIntervalMs", refreshIntervalMs);
  const safeMaxAttempts = requirePositiveSafeInteger("maxAttempts", maxAttempts);

  return {
    async processNext(): Promise<WikiSpaceSyncWorkerResult> {
      const at = now();
      const authorization = await repository.claimNext({
        at,
        leaseExpiresAt: new Date(at.getTime() + safeLeaseMs),
        maxAttempts: safeMaxAttempts,
      });
      if (authorization === undefined) return { status: "idle" };

      let scan: WikiSpaceScanResult;
      let registeredDocumentCount = 0;
      try {
        scan = await scanner({ rootNodeToken: authorization.rootNodeToken });
        for (const document of scan.documents) {
          await registrar.register({
            sourceUri: canonicalWikiDocumentUri(authorization.rootSourceUri, document.nodeToken),
            ...(document.title === undefined ? {} : { title: document.title }),
            authorizedSpaceId: scan.spaceId,
            observedAt: at,
          });
          registeredDocumentCount += 1;
        }
      } catch (error) {
        const { classification, retriable } = classifyFailure(error);
        const retryAt = retriable && authorization.attemptCount < safeMaxAttempts
          ? new Date(at.getTime() + retryDelayMs(authorization.attemptCount))
          : undefined;
        await repository.fail({
          id: authorization.id,
          revision: authorization.revision,
          at,
          classification,
          ...(retryAt === undefined ? {} : { retryAt }),
        });
        return {
          status: retryAt === undefined ? "dead_lettered" : "retrying",
          authorizationId: authorization.id,
          classification,
        };
      }

      await repository.complete({
        id: authorization.id,
        revision: authorization.revision,
        at,
        nextScanAt: new Date(at.getTime() + safeRefreshIntervalMs),
        spaceId: scan.spaceId,
        ...(scan.rootTitle === undefined ? {} : { title: scan.rootTitle }),
        discoveredNodeCount: scan.discoveredNodeCount,
        registeredDocumentCount,
        skippedNodeCount: scan.skippedNodeCount,
      });
      return {
        status: "synced",
        authorizationId: authorization.id,
        registeredDocumentCount,
        skippedNodeCount: scan.skippedNodeCount,
      };
    },
  };
}

function canonicalWikiDocumentUri(rootSourceUri: string, nodeToken: string): string {
  const origin = new URL(rootSourceUri).origin;
  if (origin === "null") throw new Error("wiki root source URI must have an origin");
  return `${origin}/wiki/${encodeURIComponent(nodeToken)}`;
}

function classifyFailure(error: unknown): {
  classification: WikiSpaceSyncErrorClassification | "internal_error";
  retriable: boolean;
} {
  if (error instanceof WikiSpaceSyncError) {
    return { classification: error.classification, retriable: error.retriable };
  }
  return { classification: "internal_error", retriable: true };
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** (attemptCount - 1));
}

function requirePositiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}
