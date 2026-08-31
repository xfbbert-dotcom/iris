import { describe, expect, it, vi } from "vitest";

import {
  ChatKnowledgeDraftModelUnavailableError,
  createChatKnowledgeDraftGenerator as createBaseChatKnowledgeDraftGenerator,
} from "../src/knowledge-governance/chat-knowledge-draft-generator.js";
import type { ConversationMessage } from "../src/conversation/conversation-message-repository.js";
import type { ModelProvider } from "../src/agent/answer-draft-orchestrator.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";

const observedAt = new Date("2026-08-02T01:00:00.000Z");

type GeneratorFactoryInput = Parameters<typeof createBaseChatKnowledgeDraftGenerator>[0];

function createChatKnowledgeDraftGenerator(
  input: Omit<GeneratorFactoryInput, "canReadGroupContext"> &
    Partial<Pick<GeneratorFactoryInput, "canReadGroupContext">>,
) {
  return createBaseChatKnowledgeDraftGenerator({
    ...input,
    canReadGroupContext: input.canReadGroupContext ?? (() => true),
  });
}

describe("ChatKnowledgeDraftGenerator", () => {
  it("copies the replied group document snapshot into a governed draft without a model call", async () => {
    const sourceUpdatedAt = new Date("2026-08-31T05:36:41.000Z");
    const documentSource = {
      id: "source-fan-truth",
      sourceType: "group_visible_document" as const,
      sourceUri: "https://example.feishu.cn/wiki/fan-truth",
      originGroupId: "oc_pilot",
      originMessageId: "om_shared_document",
      permissionState: "unknown" as const,
      syncState: "synced" as const,
      canUseForAnswering: true,
      canUseForKnowledgeDrafts: true,
      createdAt: new Date("2026-08-31T05:36:39.000Z"),
      updatedAt: new Date("2026-08-31T05:36:40.000Z"),
      evidence: [{
        kind: "group_message" as const,
        sourceUri: "https://example.feishu.cn/wiki/fan-truth",
        groupId: "oc_pilot",
        messageId: "om_shared_document",
        observedAt: new Date("2026-08-31T05:36:35.727Z"),
      }],
    };
    const documentSources = {
      listSourcesByGroupId: vi.fn(async () => [documentSource]),
      markPermissionStateIfCurrent: vi.fn(async () => ({
        ...documentSource,
        permissionState: "readable" as const,
        updatedAt: sourceUpdatedAt,
      })),
    };
    const snapshots = {
      findLatestSnapshotForSource: vi.fn(async () => ({
        id: "snapshot-fan-truth",
        documentSourceId: documentSource.id,
        sourceUri: documentSource.sourceUri,
        fetchStatus: "succeeded" as const,
        bodyText: "麦当劳 fan truth（粉丝时刻）\n\n完整文章正文。",
        contentHash: "a".repeat(64),
        fetchedAt: new Date("2026-08-31T05:36:40.836Z"),
        createdAt: new Date("2026-08-31T05:36:40.836Z"),
      })),
    };
    const permissionChecker = { canReadSource: vi.fn(async () => true) };
    const repository = { listRecentByChat: vi.fn() };
    const model = { generateAnswerDraft: vi.fn() };
    const generator = createChatKnowledgeDraftGenerator({
      repository,
      model,
      documentSources,
      snapshots,
      permissionChecker,
      canReadDocuments: () => true,
    } as unknown as GeneratorFactoryInput);

    await expect(generator.generate({
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "把这篇文章写入知识库",
      source: { type: "document", referenceMessageId: "om_shared_document" },
      observedAt: new Date("2026-08-31T05:39:38.563Z"),
    } as Parameters<typeof generator.generate>[0])).resolves.toEqual({
      status: "generated",
      title: "麦当劳 fan truth（粉丝时刻）",
      content: "麦当劳 fan truth（粉丝时刻）\n\n完整文章正文。",
      evidence: [{
        type: "document_source",
        id: "source-fan-truth",
        expectedUpdatedAt: sourceUpdatedAt,
      }],
    });
    expect(documentSources.listSourcesByGroupId).toHaveBeenCalledWith("oc_pilot");
    expect(permissionChecker.canReadSource).toHaveBeenCalledWith(documentSource);
    expect(documentSources.markPermissionStateIfCurrent).toHaveBeenCalledWith({
      id: "source-fan-truth",
      permissionState: "readable",
      expectedUpdatedAt: new Date("2026-08-31T05:36:40.000Z"),
    });
    expect(repository.listRecentByChat).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("uses the only recently shared group document when the command says above this article", async () => {
    const source = {
      id: "source-recent",
      sourceType: "group_visible_document" as const,
      sourceUri: "https://example.feishu.cn/wiki/recent",
      originGroupId: "oc_pilot",
      originMessageId: "om_recent",
      permissionState: "readable" as const,
      syncState: "synced" as const,
      canUseForAnswering: true,
      canUseForKnowledgeDrafts: true,
      createdAt: new Date("2026-08-31T05:36:39.000Z"),
      updatedAt: new Date("2026-08-31T05:36:40.000Z"),
      evidence: [{
        kind: "group_message" as const,
        sourceUri: "https://example.feishu.cn/wiki/recent",
        groupId: "oc_pilot",
        messageId: "om_recent",
        observedAt: new Date("2026-08-31T05:36:35.727Z"),
      }],
    };
    const model = { generateAnswerDraft: vi.fn() };
    const generator = createChatKnowledgeDraftGenerator({
      repository: { listRecentByChat: vi.fn() },
      model,
      documentSources: {
        listSourcesByGroupId: vi.fn(async () => [source]),
        markPermissionStateIfCurrent: vi.fn(),
      },
      snapshots: {
        findLatestSnapshotForSource: vi.fn(async () => ({
          id: "snapshot-recent",
          documentSourceId: source.id,
          sourceUri: source.sourceUri,
          fetchStatus: "succeeded" as const,
          bodyText: "最近文章\n正文",
          fetchedAt: new Date("2026-08-31T05:36:40.000Z"),
          createdAt: new Date("2026-08-31T05:36:40.000Z"),
        })),
      },
      permissionChecker: { canReadSource: vi.fn(async () => true) },
      canReadDocuments: () => true,
    } as unknown as GeneratorFactoryInput);

    await expect(generator.generate({
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "把上面这篇文章保存到知识库中",
      source: { type: "document" },
      observedAt: new Date("2026-08-31T05:36:46.341Z"),
    } as Parameters<typeof generator.generate>[0])).resolves.toMatchObject({
      status: "generated",
      title: "最近文章",
      content: "最近文章\n正文",
      evidence: [{ type: "document_source", id: "source-recent" }],
    });
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("does not inspect document sources when document reading is disabled", async () => {
    const documentSources = {
      listSourcesByGroupId: vi.fn(),
      markPermissionStateIfCurrent: vi.fn(),
    };
    const generator = createChatKnowledgeDraftGenerator({
      repository: { listRecentByChat: vi.fn() },
      model: { generateAnswerDraft: vi.fn() },
      documentSources,
      snapshots: { findLatestSnapshotForSource: vi.fn() },
      permissionChecker: { canReadSource: vi.fn() },
      canReadDocuments: () => false,
    } as unknown as GeneratorFactoryInput);

    await expect(generator.generate({
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "把这篇文章写入知识库",
      source: { type: "document", referenceMessageId: "om_document" },
      observedAt,
    } as Parameters<typeof generator.generate>[0])).resolves.toEqual({
      status: "document_unavailable",
    });
    expect(documentSources.listSourcesByGroupId).not.toHaveBeenCalled();
  });

  it("fails closed when above this article could refer to more than one recent document", async () => {
    const first = groupDocumentSource({ id: "source-first", messageId: "om_first" });
    const second = groupDocumentSource({ id: "source-second", messageId: "om_second" });
    const permissionChecker = { canReadSource: vi.fn() };
    const snapshots = { findLatestSnapshotForSource: vi.fn() };
    const generator = createChatKnowledgeDraftGenerator({
      repository: { listRecentByChat: vi.fn() },
      model: { generateAnswerDraft: vi.fn() },
      documentSources: {
        listSourcesByGroupId: vi.fn(async () => [first, second]),
        markPermissionStateIfCurrent: vi.fn(),
      },
      snapshots,
      permissionChecker,
      canReadDocuments: () => true,
    } as unknown as GeneratorFactoryInput);

    await expect(generator.generate({
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "把上面这篇文章保存到知识库中",
      source: { type: "document" },
      observedAt,
    } as Parameters<typeof generator.generate>[0])).resolves.toEqual({
      status: "document_unavailable",
    });
    expect(permissionChecker.canReadSource).not.toHaveBeenCalled();
    expect(snapshots.findLatestSnapshotForSource).not.toHaveBeenCalled();
  });

  it("does not disclose or attest a document that fails the live permission check", async () => {
    const source = groupDocumentSource({ id: "source-denied", messageId: "om_denied" });
    const markPermissionStateIfCurrent = vi.fn();
    const snapshots = { findLatestSnapshotForSource: vi.fn() };
    const generator = createChatKnowledgeDraftGenerator({
      repository: { listRecentByChat: vi.fn() },
      model: { generateAnswerDraft: vi.fn() },
      documentSources: {
        listSourcesByGroupId: vi.fn(async () => [source]),
        markPermissionStateIfCurrent,
      },
      snapshots,
      permissionChecker: { canReadSource: vi.fn(async () => false) },
      canReadDocuments: () => true,
    } as unknown as GeneratorFactoryInput);

    await expect(generator.generate({
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "把这篇文章写入知识库",
      source: { type: "document", referenceMessageId: "om_denied" },
      observedAt,
    } as Parameters<typeof generator.generate>[0])).resolves.toEqual({
      status: "document_unavailable",
    });
    expect(markPermissionStateIfCurrent).not.toHaveBeenCalled();
    expect(snapshots.findLatestSnapshotForSource).not.toHaveBeenCalled();
  });

  it("does not read the message repository when group context access is denied", async () => {
    const repository = { listRecentByChat: vi.fn() };
    const model = { generateAnswerDraft: vi.fn() };
    const generator = createChatKnowledgeDraftGenerator({
      repository,
      model,
      canReadGroupContext: vi.fn(() => false),
    });

    await expect(generator.generate({
      chatId: "oc_denied",
      requesterOpenId: "ou_owner",
      requestText: "create a knowledge draft",
      observedAt,
    })).resolves.toEqual({ status: "no_context" });
    expect(repository.listRecentByChat).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("rechecks group context access after repository I/O and before the model", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => [
        {
          ...message("feishu:om_1", "om_1", "private discussion", "2026-08-02T00:59:00.000Z"),
          chatId: "oc_revoked",
        },
      ]),
    };
    const model = { generateAnswerDraft: vi.fn() };
    const canReadGroupContext = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const generator = createChatKnowledgeDraftGenerator({
      repository,
      model,
      canReadGroupContext,
    });

    await expect(generator.generate({
      chatId: "oc_revoked",
      requesterOpenId: "ou_owner",
      requestText: "create a knowledge draft",
      observedAt,
    })).resolves.toEqual({ status: "no_context" });
    expect(repository.listRecentByChat).toHaveBeenCalledOnce();
    expect(canReadGroupContext).toHaveBeenCalledTimes(2);
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("generates from chronological same-group messages and returns matching evidence", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => [
        message("feishu:om_2", "om_2", "second conclusion", "2026-08-02T00:59:00.000Z"),
        message("feishu:om_1", "om_1", "first decision", "2026-08-02T00:58:00.000Z"),
      ]),
    };
    const model = {
      generateAnswerDraft: vi.fn(async () => ({
        answerText: "TITLE: 客户反馈看板上线范围\nCONTENT:\n本周五先向内部试点开放。",
      })),
    };
    const generator = createChatKnowledgeDraftGenerator({ repository, model });

    const result = await generator.generate({
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "把刚才讨论整理成知识草稿",
      observedAt,
    });

    expect(repository.listRecentByChat).toHaveBeenCalledWith({ chatId: "oc_pilot", limit: 60 });
    expect(result).toEqual({
      status: "generated",
      title: "客户反馈看板上线范围",
      content: "本周五先向内部试点开放。",
      evidence: [
        { type: "conversation_message", id: "feishu:om_1", groupId: "oc_pilot" },
        { type: "conversation_message", id: "feishu:om_2", groupId: "oc_pilot" },
      ],
    });
    expect(model.generateAnswerDraft).toHaveBeenCalledWith({
      question: expect.stringContaining("把刚才讨论整理成知识草稿"),
      promptContext: expect.stringMatching(
        /<live_chat_context>[\s\S]*first decision[\s\S]*second conclusion[\s\S]*<\/live_chat_context>/u,
      ),
    });
  });

  it("returns no_context without calling the model when no prior text is available", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => [
        message("feishu:future", "future", "future text", "2026-08-02T01:00:01.000Z"),
        { ...message("feishu:image", "image", "ignored", "2026-08-02T00:59:00.000Z"), text: undefined },
      ]),
    };
    const model = { generateAnswerDraft: vi.fn() };
    const generator = createChatKnowledgeDraftGenerator({ repository, model });

    await expect(generator.generate({
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "整理成知识草稿",
      observedAt,
    })).resolves.toEqual({ status: "no_context" });
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("excludes a repository row whose group does not match the requested group", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => [
        {
          ...message("feishu:other", "om_other", "other group secret", "2026-08-02T00:59:30.000Z"),
          chatId: "oc_other",
        },
        message("feishu:pilot", "om_pilot", "pilot decision", "2026-08-02T00:59:00.000Z"),
      ]),
    };
    const model = {
      generateAnswerDraft: vi.fn<ModelProvider["generateAnswerDraft"]>(async () => ({
        answerText: "TITLE: Pilot decision\nCONTENT:\nOnly the pilot decision.",
      })),
    };
    const generator = createChatKnowledgeDraftGenerator({ repository, model });

    const result = await generator.generate({
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "create a knowledge draft",
      observedAt,
    });

    expect(result).toMatchObject({
      status: "generated",
      evidence: [{ type: "conversation_message", id: "feishu:pilot", groupId: "oc_pilot" }],
    });
    const promptContext = model.generateAnswerDraft.mock.calls[0]?.[0].promptContext ?? "";
    expect(promptContext).toContain("pilot decision");
    expect(promptContext).not.toContain("other group secret");
  });

  it("uses only the latest twenty eligible messages", async () => {
    const messages = Array.from({ length: 24 }, (_, index) =>
      message(
        `feishu:om_${index + 1}`,
        `om_${index + 1}`,
        `message ${index + 1}`,
        new Date(observedAt.getTime() - index * 1_000).toISOString(),
      ),
    );
    const repository = { listRecentByChat: vi.fn(async () => messages) };
    const model = {
      generateAnswerDraft: vi.fn<ModelProvider["generateAnswerDraft"]>(async () => ({
        answerText: "TITLE: Bounded draft\nCONTENT:\nBounded content",
      })),
    };
    const generator = createChatKnowledgeDraftGenerator({ repository, model });

    const result = await generator.generate({
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "create a knowledge draft",
      observedAt,
    });

    expect(result.status).toBe("generated");
    if (result.status !== "generated") throw new Error("expected generated result");
    expect(result.evidence).toHaveLength(20);
    expect(result.evidence[0]?.id).toBe("feishu:om_20");
    expect(result.evidence.at(-1)?.id).toBe("feishu:om_1");
    const promptContext = model.generateAnswerDraft.mock.calls[0]?.[0].promptContext ?? "";
    expect(promptContext).not.toContain("message 21");
    expect(promptContext.indexOf("message 20")).toBeLessThan(promptContext.indexOf("message 1<"));
  });

  it("wraps provider failures without exposing provider detail", async () => {
    const providerFailure = new TypeError("private transport detail");
    const generator = createChatKnowledgeDraftGenerator({
      repository: {
        listRecentByChat: vi.fn(async () => [
          message("feishu:om_1", "om_1", "discussion", "2026-08-02T00:59:00.000Z"),
        ]),
      },
      model: { generateAnswerDraft: vi.fn(async () => { throw providerFailure; }) },
    });

    const failure = await generator.generate({
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "create a knowledge draft",
      observedAt,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ChatKnowledgeDraftModelUnavailableError);
    expect((failure as ChatKnowledgeDraftModelUnavailableError).providerCause).toBe(providerFailure);
    expect((failure as Error).message).not.toContain("private transport detail");
  });

  it.each([
    "",
    "TITLE: Missing content",
    "prefix\nTITLE: Title\nCONTENT:\nBody",
    "TITLE: \nCONTENT:\nBody",
    `TITLE: ${"x".repeat(257)}\nCONTENT:\nBody`,
  ])("fails closed for malformed model output %#", async (answerText) => {
    const generator = createChatKnowledgeDraftGenerator({
      repository: {
        listRecentByChat: vi.fn(async () => [
          message("feishu:om_1", "om_1", "discussion", "2026-08-02T00:59:00.000Z"),
        ]),
      },
      model: { generateAnswerDraft: vi.fn(async () => ({ answerText })) },
    });

    await expect(generator.generate({
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "整理成知识草稿",
      observedAt,
    })).rejects.toThrow("knowledge draft model response is invalid");
  });
});

function message(
  id: string,
  providerMessageId: string,
  text: string,
  sentAt: string,
): ConversationMessage {
  return {
    id,
    provider: "feishu",
    providerMessageId,
    chatId: "oc_pilot",
    senderId: "ou_member",
    senderOpenId: "ou_member",
    messageType: "text",
    text,
    sentAt: new Date(sentAt),
    rawEventIdempotencyKey: `event:${providerMessageId}`,
    createdAt: new Date(sentAt),
  };
}

function groupDocumentSource(input: { id: string; messageId: string }): DocumentSource {
  const sourceUri = `https://example.feishu.cn/wiki/${input.id}`;
  return {
    id: input.id,
    sourceType: "group_visible_document",
    sourceUri,
    originGroupId: "oc_pilot",
    originMessageId: input.messageId,
    permissionState: "unknown",
    syncState: "synced",
    canUseForAnswering: true,
    canUseForKnowledgeDrafts: true,
    createdAt: new Date("2026-08-02T00:58:00.000Z"),
    updatedAt: new Date("2026-08-02T00:59:00.000Z"),
    evidence: [{
      kind: "group_message",
      sourceUri,
      groupId: "oc_pilot",
      messageId: input.messageId,
      observedAt: new Date("2026-08-02T00:59:00.000Z"),
    }],
  };
}
