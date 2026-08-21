import { describe, expect, it, vi } from "vitest";

import { canonicalManagedBodyHash, type ManagedKnowledgePage } from "../src/action-approvals/managed-knowledge-page.js";
import { createManagedKnowledgeSyncObserver } from "../src/action-approvals/managed-knowledge-sync-observer.js";
import type { DocumentSnapshot } from "../src/documents/document-snapshot-repository.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";

describe("ManagedKnowledgeSyncObserver", () => {
  it.each([
    {
      sourceUri: "https://docs.feishu.cn/wiki/wiki-node-1",
      identity: { remoteWikiNodeToken: "wiki-node-1" },
    },
    {
      sourceUri: "https://docs.feishu.cn/docx/docx-1",
      identity: { remoteDocumentToken: "docx-1" },
    },
  ])("links and observes a source by its exact parsed token: $sourceUri", async ({
    sourceUri,
    identity,
  }) => {
    const source = documentSource({ sourceUri });
    const snapshot = documentSnapshot({ sourceUri });
    const page = managedPage();
    const linkedPage = { ...page, linkedDocumentSourceId: source.id, version: 2 };
    const repository = {
      findByRemoteIdentity: vi.fn(async () => page),
      linkSource: vi.fn(async () => ({ outcome: "applied" as const, page: linkedPage })),
      recordSnapshotObservation: vi.fn(async (input) => ({
        outcome: "applied" as const,
        observation: { ...input, createdAt: input.at },
      })),
    };
    const blockReader = {
      readManagedBlock: vi.fn(async () => ({
        revision: 12,
        blockType: "text" as const,
        body: "  Approved body\r\n",
      })),
    };
    const observedAt = new Date("2026-08-20T02:00:00.000Z");
    const observer = createManagedKnowledgeSyncObserver({
      repository,
      blockReader,
      createId: () => "observation-1",
      now: () => observedAt,
    });

    await observer.observe({ source, snapshot });

    expect(repository.findByRemoteIdentity).toHaveBeenCalledWith(identity);
    expect(repository.linkSource).toHaveBeenCalledWith({
      managedPageId: "managed-1",
      expectedVersion: 1,
      documentSourceId: "source-1",
      operationKey: expect.stringMatching(/^managed-source-link:[0-9a-f]{64}$/u),
      actor: "document-sync",
      at: observedAt,
    });
    expect(blockReader.readManagedBlock).toHaveBeenCalledWith({
      remoteDocumentToken: "docx-1",
      managedBodyBlockId: "blk_body",
    });
    expect(repository.recordSnapshotObservation).toHaveBeenCalledWith({
      id: "observation-1",
      managedPageId: "managed-1",
      managedPageVersion: 2,
      documentSnapshotId: "snapshot-1",
      documentSourceId: "source-1",
      snapshotContentHash: "b".repeat(64),
      observedRemoteRevisionId: "12",
      observedManagedBodyBlockId: "blk_body",
      observedBlockType: "text",
      managedBodyContentHash: canonicalManagedBodyHash("Approved body"),
      adapterVersion: "feishu-docx-managed-block-v1",
      observedAt,
      operationKey: expect.stringMatching(/^managed-snapshot-observation:[0-9a-f]{64}$/u),
      at: observedAt,
    });
  });

  it("does not use title or body similarity when no exact token matches", async () => {
    const repository = {
      findByRemoteIdentity: vi.fn(async () => undefined),
      linkSource: vi.fn(),
      recordSnapshotObservation: vi.fn(),
    };
    const blockReader = { readManagedBlock: vi.fn() };
    const observer = createManagedKnowledgeSyncObserver({ repository, blockReader });
    const source = documentSource({
      sourceUri: "https://docs.feishu.cn/docx/different-token",
      title: "Same title",
    });

    await observer.observe({
      source,
      snapshot: documentSnapshot({ sourceUri: source.sourceUri, bodyText: "Approved body" }),
    });

    expect(repository.findByRemoteIdentity).toHaveBeenCalledWith({
      remoteDocumentToken: "different-token",
    });
    expect(blockReader.readManagedBlock).not.toHaveBeenCalled();
    expect(repository.linkSource).not.toHaveBeenCalled();
    expect(repository.recordSnapshotObservation).not.toHaveBeenCalled();
  });

  it("observes an already linked exact source without relinking it", async () => {
    const page = managedPage({ linkedDocumentSourceId: "source-1", version: 4 });
    const repository = {
      findByRemoteIdentity: vi.fn(async () => page),
      linkSource: vi.fn(),
      recordSnapshotObservation: vi.fn(async (input) => ({
        outcome: "applied" as const,
        observation: { ...input, createdAt: input.at },
      })),
    };
    const observer = createManagedKnowledgeSyncObserver({
      repository,
      blockReader: {
        readManagedBlock: vi.fn(async () => ({
          revision: 13,
          blockType: "text" as const,
          body: "Approved body",
        })),
      },
      createId: () => "observation-2",
    });

    await observer.observe({
      source: documentSource(),
      snapshot: documentSnapshot(),
    });

    expect(repository.linkSource).not.toHaveBeenCalled();
    expect(repository.recordSnapshotObservation).toHaveBeenCalledWith(expect.objectContaining({
      managedPageVersion: 4,
    }));
  });

  it("never reassigns a page already linked to a different source", async () => {
    const repository = {
      findByRemoteIdentity: vi.fn(async () => managedPage({
        linkedDocumentSourceId: "source-other",
      })),
      linkSource: vi.fn(),
      recordSnapshotObservation: vi.fn(),
    };
    const blockReader = { readManagedBlock: vi.fn() };
    const observer = createManagedKnowledgeSyncObserver({ repository, blockReader });

    await observer.observe({
      source: documentSource(),
      snapshot: documentSnapshot(),
    });

    expect(repository.linkSource).not.toHaveBeenCalled();
    expect(blockReader.readManagedBlock).not.toHaveBeenCalled();
    expect(repository.recordSnapshotObservation).not.toHaveBeenCalled();
  });

  it.each([
    { name: "blank snapshot ID", overrides: { id: " " } },
    { name: "oversized snapshot ID", overrides: { id: "s".repeat(513) } },
    { name: "different source ID", overrides: { documentSourceId: "source-other" } },
    {
      name: "different source URI",
      overrides: { sourceUri: "https://docs.feishu.cn/docx/docx-other" },
    },
    { name: "malformed snapshot hash", overrides: { contentHash: "B".repeat(64) } },
    { name: "invalid fetched date", overrides: { fetchedAt: new Date("invalid") } },
    { name: "invalid created date", overrides: { createdAt: new Date("invalid") } },
  ] satisfies Array<{ name: string; overrides: Partial<DocumentSnapshot> }>)(
    "rejects $name before any managed-page side effect",
    async ({ overrides }) => {
      const repository = {
        findByRemoteIdentity: vi.fn(async () => managedPage()),
        linkSource: vi.fn(),
        recordSnapshotObservation: vi.fn(),
      };
      const blockReader = { readManagedBlock: vi.fn() };
      const observer = createManagedKnowledgeSyncObserver({ repository, blockReader });

      await expect(observer.observe({
        source: documentSource(),
        snapshot: documentSnapshot(overrides),
      })).rejects.toThrow("requires the source's successful snapshot");

      expect(repository.findByRemoteIdentity).not.toHaveBeenCalled();
      expect(repository.linkSource).not.toHaveBeenCalled();
      expect(blockReader.readManagedBlock).not.toHaveBeenCalled();
      expect(repository.recordSnapshotObservation).not.toHaveBeenCalled();
    },
  );
});

function managedPage(overrides: Partial<ManagedKnowledgePage> = {}): ManagedKnowledgePage {
  return {
    id: "managed-1",
    originKnowledgePublicationId: "publication-1",
    targetPolicyId: "policy-1",
    targetPolicyVersion: 1,
    authorizationGroupId: "group-1",
    remoteNodeToken: "wiki-node-1",
    remoteDocumentToken: "docx-1",
    managedBodyBlockId: "blk_body",
    currentRemoteRevisionId: "11",
    currentBodyContentHash: "a".repeat(64),
    state: "active",
    version: 1,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    updatedAt: new Date("2026-08-20T00:00:00.000Z"),
    ...overrides,
  };
}

function documentSource(overrides: Partial<DocumentSource> = {}): DocumentSource {
  return {
    id: "source-1",
    sourceType: "authorized_wiki_document",
    sourceUri: "https://docs.feishu.cn/docx/docx-1",
    title: "Managed page",
    authorizedSpaceId: "space-1",
    permissionState: "readable",
    syncState: "syncing",
    canUseForAnswering: true,
    canUseForKnowledgeDrafts: true,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    updatedAt: new Date("2026-08-20T00:00:00.000Z"),
    evidence: [],
    ...overrides,
  };
}

function documentSnapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    id: "snapshot-1",
    documentSourceId: "source-1",
    sourceUri: "https://docs.feishu.cn/docx/docx-1",
    fetchStatus: "succeeded",
    bodyText: "Whole document body",
    contentHash: "b".repeat(64),
    fetchedAt: new Date("2026-08-20T01:00:00.000Z"),
    createdAt: new Date("2026-08-20T01:00:01.000Z"),
    ...overrides,
  };
}
