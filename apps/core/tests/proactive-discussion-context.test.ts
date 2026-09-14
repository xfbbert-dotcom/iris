import { describe, expect, it, vi } from "vitest";

import type { RetrievedDocumentFragment } from "../src/documents/document-fragment-repository.js";
import type {
  FeishuChatHistoryMessage,
  FeishuChatHistoryReader,
} from "../src/feishu/feishu-chat-history-reader.js";
import {
  createLocalMessageSourceVerifier,
  hashLocalMessageText,
} from "../src/memory/local-message-source.js";
import { createPdContextBuilder } from "../src/proactive-discussion/context-builder.js";
import {
  createPdSourceRef,
  PD_PILOT_CHAT,
  type PdIssue,
  type PdJob,
  type PdSource,
} from "../src/proactive-discussion/contracts.js";
import { createPdSourceVerifier } from "../src/proactive-discussion/source-verifier.js";

describe("local proactive message source verification", () => {
  it("batches exact user reads within the eight-ID reader contract", async () => {
    const texts = new Map(Array.from({ length: 17 }, (_, index) => [`om-${index}`, `message ${index}`]));
    const readMessagesByIds = vi.fn(async ({ chatId, messageIds, sender }: {
      chatId: string; messageIds: string[]; sender?: "user" | "assistant";
    }) => {
      expect(chatId).toBe(PD_PILOT_CHAT);
      expect(sender).toBe("user");
      expect(messageIds.length).toBeLessThanOrEqual(8);
      return messageIds.map((messageId) => historyMessage(messageId, texts.get(messageId)!));
    });
    const canReadGroup = vi.fn(() => true);
    const verifier = createLocalMessageSourceVerifier({
      reader: { listRecentMessages: async () => [], readMessagesByIds },
      canReadGroup,
    });

    await expect(verifier.verify({
      chatId: PD_PILOT_CHAT,
      sources: [...texts].map(([messageId, text]) => ({
        chatId: PD_PILOT_CHAT, messageId, contentHash: hashLocalMessageText(text),
      })),
    })).resolves.toBe(true);
    expect(readMessagesByIds).toHaveBeenCalledTimes(3);
    expect(canReadGroup).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "foreign", "assistant", "changed"] as const)(
    "fails closed for a %s live message source",
    async (kind) => {
      const original = "approved same-group body";
      const reader: FeishuChatHistoryReader = {
        listRecentMessages: async () => [],
        readMessagesByIds: async () => kind === "missing" ? [] : [{
          ...historyMessage("om-source", kind === "changed" ? "changed body" : original),
          ...(kind === "foreign" ? { chatId: "oc_foreign" } : {}),
          ...(kind === "assistant" ? { role: "assistant" as const } : {}),
        }],
      };
      const verifier = createLocalMessageSourceVerifier({ reader, canReadGroup: () => true });

      await expect(verifier.verify({ chatId: PD_PILOT_CHAT, sources: [{
        chatId: PD_PILOT_CHAT, messageId: "om-source", contentHash: hashLocalMessageText(original),
      }] })).resolves.toBe(false);
    },
  );
});

describe("proactive source verification", () => {
  it("rechecks exact message and complete document snapshot/grant bindings", async () => {
    const messageText = "本群事实";
    const sources: PdSource[] = [messageSource("om-source", messageText), documentSource()];
    const verifyDocuments = vi.fn(async () => [{ documentSourceId: "doc-1", outcome: "allowed" as const }]);
    const canReadGroup = vi.fn(() => true);
    const canProactivelySpeak = vi.fn(() => true);
    const verifier = createPdSourceVerifier({
      reader: {
        listRecentMessages: async () => [],
        readMessagesByIds: async () => [historyMessage("om-source", messageText)],
      },
      documents: { verify: verifyDocuments },
      canReadGroup,
      canProactivelySpeak,
    });

    await expect(verifier.verify({ chatId: PD_PILOT_CHAT, sources })).resolves.toBe(true);
    expect(verifyDocuments).toHaveBeenCalledWith({
      chatId: PD_PILOT_CHAT,
      documentSourceIds: ["doc-1"],
      sourceSnapshotBindings: [{ documentSourceId: "doc-1", documentSnapshotId: "snapshot-1" }],
      crossGroupGrantBindings: [{
        documentSourceId: "doc-1", grantId: "grant-1", version: 4,
        grantorGroupId: "oc_grantor", granteeGroupId: PD_PILOT_CHAT,
      }],
    });
    expect(canReadGroup).toHaveBeenCalledTimes(3);
    expect(canProactivelySpeak).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a document is revoked or proactive permission changes during verification", async () => {
    const canProactivelySpeak = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const verifier = createPdSourceVerifier({
      reader: { listRecentMessages: async () => [], readMessagesByIds: async () => [] },
      documents: { verify: async () => [{ documentSourceId: "doc-1", outcome: "allowed" }] },
      canReadGroup: () => true,
      canProactivelySpeak,
    });
    await expect(verifier.verify({ chatId: PD_PILOT_CHAT, sources: [documentSource()] }))
      .resolves.toBe(false);

    const revoked = createPdSourceVerifier({
      reader: { listRecentMessages: async () => [], readMessagesByIds: async () => [] },
      documents: { verify: async () => [{ documentSourceId: "doc-1", outcome: "denied" }] },
      canReadGroup: () => true,
      canProactivelySpeak: () => true,
    });
    await expect(revoked.verify({ chatId: PD_PILOT_CHAT, sources: [documentSource()] }))
      .resolves.toBe(false);
  });

  it("deduplicates the same document binding independently of object key order", async () => {
    const first = documentSource();
    if (first.kind !== "document") throw new Error("fixture must be a document source");
    const binding = {
      crossGroupGranteeGroupId: first.binding.crossGroupGranteeGroupId,
      crossGroupGrantorGroupId: first.binding.crossGroupGrantorGroupId,
      crossGroupGrantVersion: first.binding.crossGroupGrantVersion,
      crossGroupGrantId: first.binding.crossGroupGrantId,
      documentSnapshotId: first.binding.documentSnapshotId,
      documentSourceId: first.binding.documentSourceId,
    };
    const second: PdSource = {
      kind: "document",
      ref: createPdSourceRef({ kind: "document", binding }),
      binding,
    };
    const verifier = createPdSourceVerifier({
      reader: { listRecentMessages: async () => [], readMessagesByIds: async () => [] },
      documents: { verify: async () => [{ documentSourceId: "doc-1", outcome: "allowed" }] },
      canReadGroup: () => true,
      canProactivelySpeak: () => true,
    });

    await expect(verifier.verify({ chatId: PD_PILOT_CHAT, sources: [first, second] }))
      .resolves.toBe(true);
  });
});

describe("proactive same-group context", () => {
  it("checks proactive authorization before reading live group or document content", async () => {
    const listRecentMessages = vi.fn(async () => [historyMessage("om-trigger", "must not be read")]);
    const buildContext = vi.fn(async () => ({
      promptContext: "", allowedFragments: [], deniedDocumentIds: [],
      retrievedFragmentCount: 0, usedGroupMemories: [],
    }));
    const builder = createPdContextBuilder({
      repository: stableRepository(),
      reader: { listRecentMessages },
      documents: () => ({ buildContext }),
      sourceVerifier: { verify: async ({ sources }) => sources.length !== 0 },
      canReadGroup: () => true,
    });

    await expect(builder.load(job(hashLocalMessageText("must not be read")))).resolves.toBeNull();
    expect(listRecentMessages).not.toHaveBeenCalled();
    expect(buildContext).not.toHaveBeenCalled();
  });

  it("uses only current same-group human bodies and allowed fragments, never derived prompt text", async () => {
    const trigger = historyMessage("om-trigger", "预算只有十万", { sentAt: new Date("2026-09-14T10:02:00Z") });
    const earlier = historyMessage("om-earlier", "计划招聘两人", { sentAt: new Date("2026-09-14T10:01:00Z") });
    const reader: FeishuChatHistoryReader = {
      listRecentMessages: vi.fn(async () => [
        trigger,
        earlier,
        { ...historyMessage("om-bot", "外群秘密"), role: "assistant" as const },
        { ...historyMessage("om-shared", "共享群派生回答"), underlyingChatSources: [{} as never] },
        { ...historyMessage("om-foreign", "别群原文"), chatId: "oc_foreign" },
      ]),
      readMessagesByIds: async () => [],
    };
    const buildContext = vi.fn(async () => ({
      promptContext: "INJECTED ASSISTANT OR MEMORY TEXT",
      allowedFragments: [fragment("doc-1", "授权文档说明每人预算八万")],
      deniedDocumentIds: [], retrievedFragmentCount: 1, usedGroupMemories: [],
    }));
    const verify = vi.fn(async () => true);
    const repository = stableRepository();
    const builder = createPdContextBuilder({
      repository,
      reader,
      documents: (chatId) => {
        expect(chatId).toBe(PD_PILOT_CHAT);
        return { buildContext };
      },
      sourceVerifier: { verify },
      canReadGroup: () => true,
    });

    const context = await builder.load(job(hashLocalMessageText(trigger.text)));

    expect(context).not.toBeNull();
    expect(context?.items.map(({ text }) => text)).toEqual([
      "计划招聘两人", "预算只有十万", "授权文档说明每人预算八万",
    ]);
    expect(context?.items.map(({ text }) => text)).not.toContain("INJECTED ASSISTANT OR MEMORY TEXT");
    expect(new Set(context?.sources.map(({ ref }) => ref))).toEqual(new Set(context?.items.map(({ ref }) => ref)));
    expect(buildContext).toHaveBeenCalledWith(expect.objectContaining({
      liveChatMessages: [], fragmentLimit: 12, liveChatLimit: 0,
      queryText: expect.stringContaining("预算只有十万"),
    }));
    expect(verify).toHaveBeenCalledWith({
      chatId: PD_PILOT_CHAT,
      sources: context?.sources,
    });
    expect(repository.readState).toHaveBeenCalledTimes(2);
  });

  it("forces a readable trigger into the bounded recent window", async () => {
    const recent = Array.from({ length: 20 }, (_, index) => historyMessage(
      `om-${index}`, `recent ${index}`, { sentAt: new Date(1_800_000_000_000 - index * 1000) },
    ));
    const trigger = historyMessage("om-trigger", "older trigger", { sentAt: new Date(1_799_999_000_000) });
    const readMessagesByIds = vi.fn(async () => [trigger]);
    const builder = createPdContextBuilder({
      repository: stableRepository(),
      reader: { listRecentMessages: async () => recent, readMessagesByIds },
      documents: () => emptyDocuments(),
      sourceVerifier: { verify: async () => true },
      canReadGroup: () => true,
    });

    const context = await builder.load(job(hashLocalMessageText(trigger.text)));

    expect(context?.items).toHaveLength(20);
    expect(context?.items.some(({ text }) => text === "older trigger")).toBe(true);
    expect(readMessagesByIds).toHaveBeenCalledWith({
      chatId: PD_PILOT_CHAT, messageIds: ["om-trigger"], sender: "user",
    });
  });

  it("excludes issue-derived text when any basis source no longer verifies", async () => {
    const trigger = historyMessage("om-trigger", "new message");
    const issueBasis = messageSource("om-old", "deleted old basis");
    const issue = pdIssue(issueBasis);
    const repository = stableRepository([issue]);
    const verify = vi.fn(async ({ sources }: { sources: readonly PdSource[] }) =>
      !sources.some(({ ref }) => ref === issueBasis.ref));
    const builder = createPdContextBuilder({
      repository,
      reader: { listRecentMessages: async () => [trigger], readMessagesByIds: async () => [] },
      documents: () => emptyDocuments(),
      sourceVerifier: { verify },
      canReadGroup: () => true,
    });

    const context = await builder.load(job(hashLocalMessageText(trigger.text)));

    expect(context?.issues).toEqual([]);
    expect(context?.sources).toHaveLength(1);
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it("returns null rather than mixing versions or using an unverified trigger", async () => {
    const trigger = historyMessage("om-trigger", "new message");
    const repository = stableRepository();
    repository.readState
      .mockResolvedValueOnce(state())
      .mockResolvedValueOnce({ ...state(), contextVersion: 2 });
    const builder = createPdContextBuilder({
      repository,
      reader: { listRecentMessages: async () => [trigger], readMessagesByIds: async () => [] },
      documents: () => emptyDocuments(),
      sourceVerifier: { verify: async () => true },
      canReadGroup: () => true,
    });
    await expect(builder.load(job(hashLocalMessageText(trigger.text)))).resolves.toBeNull();

    const missingTrigger = createPdContextBuilder({
      repository: stableRepository(),
      reader: { listRecentMessages: async () => [], readMessagesByIds: async () => [] },
      documents: () => emptyDocuments(),
      sourceVerifier: { verify: async () => true },
      canReadGroup: () => true,
    });
    await expect(missingTrigger.load(job(hashLocalMessageText(trigger.text)))).resolves.toBeNull();
  });

  it("shares a 24000-character budget across at most 20 messages and 12 document fragments", async () => {
    const messages = Array.from({ length: 20 }, (_, index) => historyMessage(
      index === 0 ? "om-trigger" : `om-${index}`,
      `${index}`.padEnd(9_000, "m"),
      { sentAt: new Date(1_800_000_000_000 + index) },
    ));
    const documents = Array.from({ length: 15 }, (_, index) => fragment(`doc-${index}`, "d".repeat(2_000)));
    const builder = createPdContextBuilder({
      repository: stableRepository(),
      reader: { listRecentMessages: async () => messages, readMessagesByIds: async () => [] },
      documents: () => ({ buildContext: async () => ({
        promptContext: "ignored", allowedFragments: documents,
        deniedDocumentIds: [], retrievedFragmentCount: documents.length, usedGroupMemories: [],
      }) }),
      sourceVerifier: { verify: async () => true },
      canReadGroup: () => true,
    });

    const context = await builder.load(job(hashLocalMessageText(messages[0]!.text)));
    const messageRefs = new Set(messages.map(({ messageId, text }) => messageSource(messageId, text).ref));
    const messageItems = context!.items.filter(({ ref }) => messageRefs.has(ref));
    const documentItems = context!.items.filter(({ ref }) => !messageRefs.has(ref));

    expect(messageItems.length).toBeLessThanOrEqual(20);
    expect(documentItems.length).toBeLessThanOrEqual(12);
    expect(messageItems.every(({ text }) => text.length <= 8_000)).toBe(true);
    expect(documentItems.every(({ text }) => text.length <= 1_200)).toBe(true);
    expect(context!.items.reduce((total, { text }) => total + text.length, 0)).toBeLessThanOrEqual(24_000);
  });
});

function historyMessage(
  messageId: string,
  text: string,
  overrides: Partial<FeishuChatHistoryMessage> = {},
): FeishuChatHistoryMessage {
  return {
    messageId, chatId: PD_PILOT_CHAT, senderId: `ou-${messageId}`, text,
    sentAt: new Date("2026-09-14T10:00:00Z"), ...overrides,
  };
}

function messageSource(messageId: string, text: string): PdSource {
  const binding = { chatId: PD_PILOT_CHAT, messageId, contentHash: hashLocalMessageText(text) };
  return { kind: "message", ref: createPdSourceRef({ kind: "message", binding }), binding };
}

function documentSource(): PdSource {
  const binding = {
    documentSourceId: "doc-1", documentSnapshotId: "snapshot-1",
    crossGroupGrantId: "grant-1", crossGroupGrantVersion: 4,
    crossGroupGrantorGroupId: "oc_grantor", crossGroupGranteeGroupId: PD_PILOT_CHAT,
  };
  return { kind: "document", ref: createPdSourceRef({ kind: "document", binding }), binding };
}

function fragment(documentSourceId: string, text: string): RetrievedDocumentFragment {
  return {
    id: `fragment-${documentSourceId}`, documentSourceId, documentSnapshotId: `snapshot-${documentSourceId}`,
    sourceUri: `https://docs.feishu.cn/docx/${documentSourceId}`, chunkIndex: 0, text,
    contentHash: "a".repeat(64), embedding: [1], embeddingProfileId: "profile",
    createdAt: new Date("2026-09-14T09:00:00Z"), sourceType: "feishu_group_document",
  };
}

function job(contentHash: string): PdJob {
  return {
    id: "job-1", chatId: PD_PILOT_CHAT, messageId: "om-trigger", contentHash,
    policyVersion: 3, leaseToken: "lease", attempt: 1, purpose: "assessment",
  };
}

function state(issues: PdIssue[] = []) {
  return {
    policy: { chatId: PD_PILOT_CHAT, version: 3, enabled: true, operatorId: "operator" },
    contextVersion: 1, catalogVersion: 1, issues,
  };
}

function stableRepository(issues: PdIssue[] = []) {
  return { readState: vi.fn(async () => state(issues)) };
}

function emptyDocuments() {
  return { buildContext: async () => ({
    promptContext: "", allowedFragments: [], deniedDocumentIds: [],
    retrievedFragmentCount: 0, usedGroupMemories: [],
  }) };
}

function pdIssue(source: PdSource): PdIssue {
  return {
    id: "issue-1", chatId: PD_PILOT_CHAT, description: "old issue", state: "surfaced",
    version: 1, basisVersion: 1, lastObservation: "old observation",
    lastReasoning: "old reasoning", lastSuggestion: "old suggestion",
    basisSources: [source], hasUnknownDelivery: false,
  };
}
