import { describe, expect, it, vi } from "vitest";

import {
  createKnowledgeConflictEvidenceBuilder,
  type KnowledgeConflictEvidenceBuilderDependencies,
} from "../src/knowledge-conflicts/knowledge-conflict-evidence-builder.js";
import type { ConversationMessageEvidence } from "../src/conversation/conversation-message-repository.js";
import type { RetrievedDocumentFragment } from "../src/documents/document-fragment-repository.js";
import type { DocumentSnapshot } from "../src/documents/document-snapshot-repository.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";
import type { GroupMemory } from "../src/memory/group-memory-repository.js";

const fetchedAt = new Date("2026-08-13T01:00:00.000Z");
const messageSentAt = new Date("2026-08-13T01:00:01.000Z");
const sourceUpdatedAt = new Date("2026-08-13T00:30:00.000Z");
const memoryUpdatedAt = new Date("2026-08-13T01:01:00.000Z");
const attestedAt = new Date("2026-08-13T02:00:00.000Z");

describe("KnowledgeConflictEvidenceBuilder", () => {
  it("builds exact knowledge-purpose evidence only after live permission", async () => {
    const events: string[] = [];
    const harness = createHarness({
      memory: memory({ content: "  Director approval now starts at CNY 10,000.  " }),
      fragments: [fragment(), fragment({
        id: "wrong-space-fragment",
        documentSourceId: "source-wrong-space",
        documentSnapshotId: "snapshot-wrong-space",
      })],
      sources: [source(), source({
        id: "source-wrong-space",
        authorizedSpaceId: "space-other",
      })],
      snapshots: [snapshot(), snapshot({
        id: "snapshot-wrong-space",
        documentSourceId: "source-wrong-space",
      })],
      canReadSource: async () => {
        events.push("permission");
        return true;
      },
      onCandidateSearch: () => events.push("metadata"),
      onFragmentLoad: () => events.push("text"),
    });

    const result = await harness.builder.build({ memory: harness.memory });

    expect(events).toEqual(["metadata", "permission", "text"]);
    expect(harness.dependencies.embedder.embedTexts).toHaveBeenCalledWith([
      "Director approval now starts at CNY 10,000.",
    ]);
    expect(harness.dependencies.fragments.searchSimilarFragmentCandidates).toHaveBeenCalledWith({
      embeddingProfileId: "profile-6d",
      embedding: [1, 0, 0, 0, 0, 0],
      limit: 36,
      sourceTypes: ["authorized_wiki_document"],
      usage: "knowledge_drafts",
    });
    expect(result).toEqual({
      outcome: "ready",
      input: {
        subject: {
          referenceId: "M1",
          groupMemoryId: "memory-1",
          groupId: "group-1",
          category: "decision",
          content: "Director approval now starts at CNY 10,000.",
        },
        groupEvidence: [{
          referenceId: "C1",
          conversationMessageId: "feishu:message-1",
          sentAt: messageSentAt,
          text: "Director approval now starts at CNY 10,000.",
        }],
        documentEvidence: [{
          referenceId: "D1",
          documentSourceId: "source-1",
          sourceUri: "https://example.feishu.cn/wiki/source-1",
          sourceTitle: "Expense policy",
          authorizedSpaceId: "space-1",
          sourceUpdatedAt,
          documentSnapshotId: "snapshot-1",
          sourceVersion: "revision-7",
          snapshotContentHash: "a".repeat(64),
          snapshotFetchedAt: fetchedAt,
          documentFragmentId: "fragment-1",
          fragmentContentHash: "b".repeat(64),
          text: "Director approval starts at CNY 5,000.",
        }],
      },
      fingerprint: {
        memory: {
          groupMemoryId: "memory-1",
          groupId: "group-1",
          updatedAt: memoryUpdatedAt,
        },
        messages: [{
          referenceId: "C1",
          conversationMessageId: "feishu:message-1",
          chatId: "group-1",
          sentAt: messageSentAt,
        }],
        documents: [{
          referenceId: "D1",
          documentSourceId: "source-1",
          sourceUpdatedAt,
          documentSnapshotId: "snapshot-1",
          sourceVersion: "revision-7",
          snapshotContentHash: "a".repeat(64),
          snapshotFetchedAt: fetchedAt,
          documentFragmentId: "fragment-1",
          fragmentContentHash: "b".repeat(64),
        }],
        publicationTarget: {
          id: "policy-1",
          version: 3,
          spaceId: "space-1",
        },
        permissionAttestedAt: attestedAt,
      },
    });
  });

  it("limits each source to three fragments and the detector window to twelve", async () => {
    const sources = Array.from({ length: 5 }, (_, index) => source({
      id: `source-${index + 1}`,
      sourceUri: `https://example.feishu.cn/wiki/source-${index + 1}`,
    }));
    const snapshots = sources.map((item, index) => snapshot({
      id: `snapshot-${index + 1}`,
      documentSourceId: item.id,
    }));
    const fragments = sources.flatMap((item, sourceIndex) =>
      Array.from({ length: 4 }, (_, fragmentIndex) => fragment({
        id: `fragment-${sourceIndex + 1}-${fragmentIndex + 1}`,
        documentSourceId: item.id,
        documentSnapshotId: `snapshot-${sourceIndex + 1}`,
        chunkIndex: fragmentIndex,
        text: fragmentIndex === 0 && sourceIndex === 0 ? "   " : `Text ${sourceIndex}-${fragmentIndex}`,
      })));
    const harness = createHarness({ sources, snapshots, fragments });

    const result = await harness.builder.build({ memory: harness.memory });

    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") throw new Error("expected ready evidence");
    expect(result.input.documentEvidence).toHaveLength(12);
    const counts = new Map<string, number>();
    for (const item of result.input.documentEvidence) {
      counts.set(item.documentSourceId, (counts.get(item.documentSourceId) ?? 0) + 1);
      expect(item.text.trim()).not.toBe("");
    }
    expect(Math.max(...counts.values())).toBe(3);
    expect(result.input.documentEvidence.map((item) => item.referenceId)).toEqual([
      "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12",
    ]);
  });

  it("fails closed without detector input when any selected source is denied", async () => {
    const harness = createHarness({ canReadSource: async () => false });

    await expect(harness.builder.build({ memory: harness.memory })).resolves.toEqual({
      outcome: "permission_blocked",
      reasonCode: "permission_denied",
    });
    expect(harness.dependencies.fragments.findFragmentsByIds).not.toHaveBeenCalled();
  });

  it("classifies permission-check exceptions without leaking provider details", async () => {
    const harness = createHarness({
      canReadSource: async () => { throw new Error("secret tenant token and provider body"); },
    });

    const result = await harness.builder.build({ memory: harness.memory });

    expect(result).toEqual({ outcome: "retryable_failure", reasonCode: "permission_check_failed" });
    expect(JSON.stringify(result)).not.toContain("secret tenant token");
  });

  it.each([
    ["equal", [message({ sentAt: fetchedAt })]],
    ["earlier", [message({ sentAt: new Date(fetchedAt.getTime() - 1) })]],
    ["missing", []],
    ["tombstoned", [message({ tombstoned: true })]],
    ["wrong group", [message({ chatId: "group-other" })]],
  ])("returns insufficient evidence when source-message chronology is %s", async (_label, messages) => {
    const harness = createHarness({ messages });

    await expect(harness.builder.build({ memory: harness.memory })).resolves.toEqual({
      outcome: "insufficient_evidence",
      reasonCode: "chronology_unproven",
    });
    expect(harness.dependencies.permissionChecker.canReadSource).not.toHaveBeenCalled();
  });

  it("rejects non-Wiki, unsynced, locally denied, policy-disabled, and wrong-space sources", async () => {
    const sources = [
      source({ id: "wrong-type", sourceType: "group_visible_document" }),
      source({ id: "unsynced", syncState: "pending" }),
      source({ id: "locally-denied", permissionState: "denied" }),
      source({ id: "draft-disabled", canUseForKnowledgeDrafts: false }),
      source({ id: "wrong-space", authorizedSpaceId: "space-other" }),
    ];
    const fragments = sources.map((item, index) => fragment({
      id: `fragment-invalid-${index}`,
      documentSourceId: item.id,
      documentSnapshotId: `snapshot-invalid-${index}`,
    }));
    const snapshots = sources.map((item, index) => snapshot({
      id: `snapshot-invalid-${index}`,
      documentSourceId: item.id,
    }));
    const harness = createHarness({ sources, fragments, snapshots });

    await expect(harness.builder.build({ memory: harness.memory })).resolves.toEqual({
      outcome: "insufficient_evidence",
      reasonCode: "no_authorized_document_evidence",
    });
    expect(harness.dependencies.permissionChecker.canReadSource).not.toHaveBeenCalled();
  });

  it("fails closed when the bounded target-policy read could hide another match", async () => {
    const policies = Array.from({ length: 100 }, (_, index) => ({
      id: `policy-${index + 1}`,
      spaceId: index === 0 ? "space-1" : `space-${index + 2}`,
      displayName: `Policy ${index + 1}`,
      allowedGroupIds: index === 0 ? ["group-1"] : ["group-other"],
      allowedRiskLevels: ["medium" as const],
      enabled: true,
      version: 1,
      createdAt: sourceUpdatedAt,
      updatedAt: sourceUpdatedAt,
    }));
    const harness = createHarness({ policies });

    await expect(harness.builder.build({ memory: harness.memory })).resolves.toEqual({
      outcome: "insufficient_evidence",
      reasonCode: "target_policy_ambiguous",
    });
    expect(harness.dependencies.embedder.embedTexts).not.toHaveBeenCalled();
  });

  it("rejects source metadata returned under a different requested identity", async () => {
    const harness = createHarness({
      findSourceById: async () => source({ id: "source-substituted" }),
    });

    await expect(harness.builder.build({ memory: harness.memory })).resolves.toEqual({
      outcome: "insufficient_evidence",
      reasonCode: "no_authorized_document_evidence",
    });
    expect(harness.dependencies.permissionChecker.canReadSource).not.toHaveBeenCalled();
  });
});

function createHarness(overrides: {
  memory?: GroupMemory;
  messages?: ConversationMessageEvidence[];
  fragments?: RetrievedDocumentFragment[];
  sources?: DocumentSource[];
  snapshots?: DocumentSnapshot[];
  canReadSource?: (source: DocumentSource) => Promise<boolean>;
  onCandidateSearch?: () => void;
  onFragmentLoad?: () => void;
  policies?: Awaited<ReturnType<KnowledgeConflictEvidenceBuilderDependencies["publicationTargets"]["listTargetPolicies"]>>;
  findSourceById?: (id: string) => Promise<DocumentSource | undefined>;
} = {}) {
  const selectedMemory = overrides.memory ?? memory();
  const selectedMessages = overrides.messages ?? [message()];
  const selectedFragments = overrides.fragments ?? [fragment()];
  const selectedSources = overrides.sources ?? [source()];
  const selectedSnapshots = overrides.snapshots ?? [snapshot()];
  const sourceById = new Map(selectedSources.map((item) => [item.id, item]));
  const candidates = selectedFragments.map(({ text: _text, embedding: _embedding, ...item }) => item);
  const dependencies = {
    embeddingProfileId: "profile-6d",
    embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
    fragments: {
      searchSimilarFragmentCandidates: vi.fn(async () => {
        overrides.onCandidateSearch?.();
        return candidates;
      }),
      findFragmentsByIds: vi.fn(async ({ ids }: { ids: readonly string[] }) => {
        overrides.onFragmentLoad?.();
        const selectedIds = new Set(ids);
        return selectedFragments.filter((item) => selectedIds.has(item.id));
      }),
    },
    messages: { findByIds: vi.fn(async () => selectedMessages) },
    documentSources: {
      findSourceById: vi.fn(overrides.findSourceById ?? (async (id: string) => sourceById.get(id))),
    },
    snapshots: { findLatestSnapshotsForSources: vi.fn(async () => selectedSnapshots) },
    publicationTargets: {
      listTargetPolicies: vi.fn(async () => overrides.policies ?? [{
        id: "policy-1",
        spaceId: "space-1",
        displayName: "Pilot wiki",
        allowedGroupIds: ["group-1"],
        allowedRiskLevels: ["medium" as const],
        enabled: true,
        version: 3,
        createdAt: sourceUpdatedAt,
        updatedAt: sourceUpdatedAt,
      }]),
    },
    permissionChecker: {
      canReadSource: vi.fn(overrides.canReadSource ?? (async () => true)),
    },
    now: () => attestedAt,
  } satisfies KnowledgeConflictEvidenceBuilderDependencies;

  return {
    memory: selectedMemory,
    dependencies,
    builder: createKnowledgeConflictEvidenceBuilder(dependencies),
  };
}

function memory(overrides: Partial<GroupMemory> = {}): GroupMemory {
  return {
    id: "memory-1",
    groupId: "group-1",
    scope: "group",
    category: "decision",
    content: "Director approval now starts at CNY 10,000.",
    importance: 4,
    confidence: 0.95,
    status: "active",
    idempotencyKey: "memory:create:1",
    origin: "extractor",
    createdBy: "system",
    evidenceMessageIds: ["feishu:message-1"],
    createdAt: memoryUpdatedAt,
    updatedAt: memoryUpdatedAt,
    ...overrides,
  };
}

function message(overrides: Partial<ConversationMessageEvidence> = {}): ConversationMessageEvidence {
  return {
    id: "feishu:message-1",
    provider: "feishu",
    providerMessageId: "message-1",
    chatId: "group-1",
    messageType: "text",
    text: "Director approval now starts at CNY 10,000.",
    sentAt: messageSentAt,
    rawEventIdempotencyKey: "raw-event:1",
    createdAt: messageSentAt,
    tombstoned: false,
    ...overrides,
  };
}

function source(overrides: Partial<DocumentSource> = {}): DocumentSource {
  return {
    id: "source-1",
    sourceType: "authorized_wiki_document",
    sourceUri: "https://example.feishu.cn/wiki/source-1",
    title: "Expense policy",
    authorizedSpaceId: "space-1",
    permissionState: "readable",
    syncState: "synced",
    canUseForAnswering: false,
    canUseForKnowledgeDrafts: true,
    createdAt: sourceUpdatedAt,
    updatedAt: sourceUpdatedAt,
    evidence: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    id: "snapshot-1",
    documentSourceId: "source-1",
    sourceUri: "https://example.feishu.cn/wiki/source-1",
    fetchStatus: "succeeded",
    bodyText: "Director approval starts at CNY 5,000.",
    contentHash: "a".repeat(64),
    sourceVersion: "revision-7",
    fetchedAt,
    createdAt: fetchedAt,
    ...overrides,
  };
}

function fragment(overrides: Partial<RetrievedDocumentFragment> = {}): RetrievedDocumentFragment {
  return {
    id: "fragment-1",
    documentSourceId: "source-1",
    documentSnapshotId: "snapshot-1",
    sourceUri: "https://example.feishu.cn/wiki/source-1",
    sourceTitle: "Expense policy",
    sourceType: "feishu_wiki",
    chunkIndex: 0,
    text: "Director approval starts at CNY 5,000.",
    contentHash: "b".repeat(64),
    embedding: [1, 0, 0, 0, 0, 0],
    embeddingProfileId: "profile-6d",
    distance: 0.1,
    createdAt: fetchedAt,
    ...overrides,
  };
}
