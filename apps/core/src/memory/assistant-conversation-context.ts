import type { AnswerSourcePermissionVerifier, AnswerSourcePermissionGrantBinding, AnswerSourceSnapshotBinding } from "../answer-replies/answer-source-permission-verifier.js";
import type { Queryable } from "../documents/document-fragment-repository.js";
import type { DocumentSourceGroupGrantRepository } from "../documents/document-source-group-grant.js";
import type { FeishuChatHistoryMessage, FeishuChatHistoryReader } from "../feishu/feishu-chat-history-reader.js";
import type { AssistantDocumentSourceBinding } from "./context-assembly.js";
import { normalizeSharedChatSourceBinding, type SharedChatSourceBinding, type SharedChatSourceVerifier } from "../shared-chat/working-chat-scope.js";
import { createPassiveAssistantReceiptProvider, normalizeLocalMessageBinding, type AssistantReplyLineageReceiptProvider, type PassiveAssistantReceiptProvider, type PassiveAssistantReceiptCandidate } from "./assistant-reply-receipt-provider.js";
import type { LocalMessageSourceVerifier } from "./local-message-source.js";

export type AssistantConversationContextProvider = {
  loadRecentReplies(input: { chatId: string; before: Date }): Promise<FeishuChatHistoryMessage[]>;
};

type SourceIdentity = {
  delivery_id: string;
  document_source_id: string;
  document_snapshot_id: string;
  cross_group_grant_id: string | null;
  cross_group_grant_version: number | null;
  cross_group_grantor_group_id: string | null;
  cross_group_grantee_group_id: string | null;
};

const MAX_REPLIES = 2;
const MAX_SOURCE_TRACES = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createAssistantConversationContextProvider({ queryable, reader, verifier, grants, sharedChatVerifier, localMessageVerifier, passiveReceipts, proactiveReceipts, requireChatProvenance = false }: {
  queryable: Queryable;
  reader: FeishuChatHistoryReader;
  verifier: AnswerSourcePermissionVerifier;
  grants?: Pick<DocumentSourceGroupGrantRepository, "validateExact">;
  sharedChatVerifier?: SharedChatSourceVerifier;
  localMessageVerifier?: LocalMessageSourceVerifier;
  passiveReceipts?: PassiveAssistantReceiptProvider;
  proactiveReceipts?: AssistantReplyLineageReceiptProvider;
  requireChatProvenance?: boolean;
}): AssistantConversationContextProvider {
  async function canReuseReceipt(receipt: PassiveAssistantReceiptCandidate, chatId: string): Promise<boolean> {
    try {
      if (receipt.provenanceVersion !== 1 && (requireChatProvenance || receipt.provenanceVersion !== null
        || receipt.localMessageSources.length > 0 || receipt.sharedChatSources.length > 0)) return false;
      if ([receipt.documentSources, receipt.localMessageSources, receipt.sharedChatSources].some(sources => sources.length > MAX_SOURCE_TRACES)) return false;
      const chatSources = receipt.sharedChatSources.map(source => normalizeSharedChatSourceBinding(source));
      if (chatSources.some(source => source.destinationChatId !== chatId)
        || (chatSources.length > 0 && await sharedChatVerifier?.verify({ chatId, sources: chatSources }) !== true)) return false;
      const localSources = receipt.localMessageSources.map(source => normalizeLocalMessageBinding(source, chatId));
      if (localSources.length > 0 && await localMessageVerifier?.verify({ chatId, sources: localSources }) !== true) return false;
      const sources = receipt.documentSources.map(source => ({ delivery_id: receipt.receiptId,
        document_source_id: source.documentSourceId, document_snapshot_id: source.documentSnapshotId,
        cross_group_grant_id: source.crossGroupGrantId ?? null, cross_group_grant_version: source.crossGroupGrantVersion ?? null,
        cross_group_grantor_group_id: source.crossGroupGrantorGroupId ?? null, cross_group_grantee_group_id: source.crossGroupGranteeGroupId ?? null }));
      return await canReuseSources({ chatId, sources, verifier, grants });
    } catch { return false; }
  }
  return { async loadRecentReplies({ chatId, before }) {
    if (reader.readMessagesByIds === undefined) return [];
    const after = new Date(before.getTime() - DAY_MS);
    const window = { chatId, after, before, limit: MAX_REPLIES };
    const [passive, proactive] = await Promise.all([
      (passiveReceipts ?? createPassiveAssistantReceiptProvider({ queryable })).listRecentSent(window),
      proactiveReceipts?.listRecentSent(window) ?? [],
    ]);
    const candidates = [...passive, ...proactive].filter(receipt => receipt.sentAt instanceof Date
      && receipt.sentAt >= after && receipt.sentAt < before)
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime() || b.receiptId.localeCompare(a.receiptId)).slice(0, MAX_REPLIES);
    if (candidates.length === 0) return [];
    const eligible = [];
    for (const receipt of candidates) if (await canReuseReceipt(receipt, chatId)) eligible.push(receipt);
    if (eligible.length === 0) return [];
    const messages = await reader.readMessagesByIds({ chatId, messageIds: eligible.map(receipt => receipt.replyMessageId), sender: "assistant" });
    const result: FeishuChatHistoryMessage[] = [];
    for (const receipt of eligible) {
      try {
        const message = messages.find(item => item.messageId === receipt.replyMessageId && item.chatId === chatId
          && item.role === "assistant" && item.sentAt >= after && item.sentAt < before);
        if (message === undefined || result.some(item => item.messageId === message.messageId)) continue;
        if (!await canReuseReceipt(receipt, chatId)) continue;
        const chatSources = receipt.sharedChatSources.map(source => normalizeSharedChatSourceBinding(source));
        const localSources = receipt.localMessageSources.map(source => normalizeLocalMessageBinding(source, chatId));
        result.push({ ...message,
          ...(receipt.documentSources.length === 0 ? {} : { underlyingDocumentSources: receipt.documentSources.map(source => ({ ...source })) }),
          ...(chatSources.length === 0 ? {} : { underlyingChatSources: chatSources.map(source => ({ ...source })) }),
          ...(localSources.length === 0 ? {} : { underlyingLocalMessageSources: localSources.map(source => ({ ...source })) }),
        });
      } catch { /* Fresh source verification fails closed for this entire assistant body. */ }
    }
    return result;
  } };
}

async function canReuseSources({ chatId, sources, verifier, grants }: {
  chatId: string;
  sources: SourceIdentity[];
  verifier: AnswerSourcePermissionVerifier;
  grants: Pick<DocumentSourceGroupGrantRepository, "validateExact"> | undefined;
}): Promise<boolean> {
  const snapshots = new Map<string, string>();
  const bindings: AnswerSourcePermissionGrantBinding[] = [];
  const grantIdentities = new Map<string, string>();
  for (const source of sources) {
    if (typeof source.document_source_id !== "string" || !source.document_source_id.trim()
      || typeof source.document_snapshot_id !== "string" || !source.document_snapshot_id.trim()) return false;
    const previous = snapshots.get(source.document_source_id);
    if (previous !== undefined && previous !== source.document_snapshot_id) return false;
    snapshots.set(source.document_source_id, source.document_snapshot_id);
    if (source.cross_group_grant_id !== null) {
      const { cross_group_grant_id: grantId, cross_group_grant_version: version,
        cross_group_grantor_group_id: grantorGroupId, cross_group_grantee_group_id: granteeGroupId } = source;
      if (grants === undefined || typeof grantId !== "string" || typeof version !== "number"
        || !Number.isSafeInteger(version) || version < 1 || typeof grantorGroupId !== "string" || granteeGroupId !== chatId) return false;
      const identity = JSON.stringify([grantId, version, grantorGroupId, granteeGroupId]);
      const previousGrant = grantIdentities.get(source.document_source_id);
      if (previousGrant !== undefined) {
        if (previousGrant !== identity) return false;
        continue;
      }
      grantIdentities.set(source.document_source_id, identity);
      const binding = { documentSourceId: source.document_source_id, grantId, version, grantorGroupId, granteeGroupId };
      if (!await grants.validateExact(binding)) return false;
      bindings.push(binding);
    } else {
      if (source.cross_group_grant_version !== null || source.cross_group_grantor_group_id !== null
        || source.cross_group_grantee_group_id !== null) return false;
      const previousGrant = grantIdentities.get(source.document_source_id);
      if (previousGrant !== undefined && previousGrant !== "unbound") return false;
      grantIdentities.set(source.document_source_id, "unbound");
    }
  }
  if (snapshots.size === 0) return true;
  const sourceSnapshotBindings: AnswerSourceSnapshotBinding[] = [...snapshots].map(([documentSourceId, documentSnapshotId]) => ({ documentSourceId, documentSnapshotId }));
  const decisions = await verifier.verify({ chatId, documentSourceIds: [...snapshots.keys()], sourceSnapshotBindings,
    ...(bindings.length === 0 ? {} : { crossGroupGrantBindings: bindings }),
  });
  return decisions.length === snapshots.size && [...snapshots.keys()].every(id =>
    decisions.some(decision => decision.documentSourceId === id && decision.outcome === "allowed"));
}
