import { createHash, randomUUID } from "node:crypto";

import type { DocumentSnapshot } from "../documents/document-snapshot-repository.js";
import type { DocumentSource } from "../documents/document-source-registry.js";
import {
  parseFeishuDocxDocumentId,
  parseFeishuWikiNodeToken,
} from "../documents/feishu-document-body-fetcher.js";

import type { ManagedBlockReader } from "./feishu-managed-knowledge-block-reader.js";
import { canonicalManagedBodyHash } from "./managed-knowledge-page.js";
import type { ManagedKnowledgePageRepository } from "./managed-knowledge-page-repository.js";

export interface ManagedKnowledgeSyncObserver {
  observe(input: { source: DocumentSource; snapshot: DocumentSnapshot }): Promise<void>;
}

export type ManagedKnowledgeSyncObserverDependencies = {
  repository: Pick<
    ManagedKnowledgePageRepository,
    "findByRemoteIdentity" | "linkSource" | "recordSnapshotObservation" |
    "findResyncReadyExecution" | "completeResync"
  >;
  blockReader: ManagedBlockReader;
  createId?: () => string;
  now?: () => Date;
};

const ADAPTER_VERSION = "feishu-docx-managed-block-v1";
const ACTOR = "document-sync";

export function createManagedKnowledgeSyncObserver({
  repository,
  blockReader,
  createId = randomUUID,
  now = () => new Date(),
}: ManagedKnowledgeSyncObserverDependencies): ManagedKnowledgeSyncObserver {
  return {
    async observe({ source, snapshot }) {
      const snapshotContentHash = requireSuccessfulSnapshot(source, snapshot);
      const identity = parseExactRemoteIdentity(source.sourceUri);
      if (identity === undefined) return;

      const page = await repository.findByRemoteIdentity(identity);
      if (page === undefined) return;
      if (
        page.linkedDocumentSourceId !== undefined &&
        page.linkedDocumentSourceId !== source.id
      ) {
        return;
      }

      const observedAt = now();
      const linkedPage = page.linkedDocumentSourceId === source.id
        ? page
        : (await repository.linkSource({
            managedPageId: page.id,
            expectedVersion: page.version,
            documentSourceId: source.id,
            operationKey: operationKey("managed-source-link", [page.id, source.id]),
            actor: ACTOR,
            at: observedAt,
          })).page;
      const block = await blockReader.readManagedBlock({
        remoteDocumentToken: linkedPage.remoteDocumentToken,
        managedBodyBlockId: linkedPage.managedBodyBlockId,
      });
      if (block.blockType !== "text") {
        throw new Error("managed knowledge observation requires a text block");
      }

      const recorded = await repository.recordSnapshotObservation({
        id: createId(),
        managedPageId: linkedPage.id,
        managedPageVersion: linkedPage.version,
        documentSnapshotId: snapshot.id,
        documentSourceId: source.id,
        snapshotContentHash,
        observedRemoteRevisionId: String(block.revision),
        observedManagedBodyBlockId: linkedPage.managedBodyBlockId,
        observedBlockType: "text",
        managedBodyContentHash: canonicalManagedBodyHash(block.body),
        adapterVersion: ADAPTER_VERSION,
        observedAt,
        operationKey: operationKey("managed-snapshot-observation", [linkedPage.id, snapshot.id]),
        at: observedAt,
      });
      const ready = await repository.findResyncReadyExecution({
        observationId: recorded.observation.id,
      });
      if (ready !== undefined) {
        await repository.completeResync({
          executionId: ready.executionId,
          expectedExecutionVersion: ready.executionVersion,
          expectedManagedPageVersion: ready.managedPageVersion,
          observationId: ready.observationId,
          operationKey: operationKey("managed-resync-complete", [
            ready.executionId,
            ready.observationId,
          ]),
          actor: ACTOR,
          at: observedAt,
        });
      }
    },
  };
}

function parseExactRemoteIdentity(sourceUri: string):
  | { remoteWikiNodeToken: string }
  | { remoteDocumentToken: string }
  | undefined {
  const remoteWikiNodeToken = parseFeishuWikiNodeToken(sourceUri);
  if (remoteWikiNodeToken !== undefined) return { remoteWikiNodeToken };
  const remoteDocumentToken = parseFeishuDocxDocumentId(sourceUri);
  return remoteDocumentToken === undefined ? undefined : { remoteDocumentToken };
}

function requireSuccessfulSnapshot(source: DocumentSource, snapshot: DocumentSnapshot): string {
  if (
    typeof snapshot.id !== "string" ||
    [...snapshot.id.trim()].length < 1 ||
    [...snapshot.id.trim()].length > 512 ||
    snapshot.fetchStatus !== "succeeded" ||
    snapshot.documentSourceId !== source.id ||
    snapshot.sourceUri !== source.sourceUri ||
    typeof snapshot.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(snapshot.contentHash) ||
    !isValidDate(snapshot.fetchedAt) ||
    !isValidDate(snapshot.createdAt)
  ) {
    throw new Error("managed knowledge observation requires the source's successful snapshot");
  }
  return snapshot.contentHash;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function operationKey(prefix: string, identity: string[]): string {
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `${prefix}:${digest}`;
}

export type { ManagedBlockReader };
