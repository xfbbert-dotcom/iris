import type { AnswerSourcePermissionVerifier, AnswerSourcePermissionGrantBinding, AnswerSourceSnapshotBinding } from "../answer-replies/answer-source-permission-verifier.js";
import type { Queryable } from "../documents/document-fragment-repository.js";
import type { DocumentSourceGroupGrantRepository } from "../documents/document-source-group-grant.js";
import type { FeishuChatHistoryMessage, FeishuChatHistoryReader } from "../feishu/feishu-chat-history-reader.js";
import type { AssistantDocumentSourceBinding } from "./context-assembly.js";

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

export function createAssistantConversationContextProvider({ queryable, reader, verifier, grants }: {
  queryable: Queryable;
  reader: FeishuChatHistoryReader;
  verifier: AnswerSourcePermissionVerifier;
  grants?: Pick<DocumentSourceGroupGrantRepository, "validateExact">;
}): AssistantConversationContextProvider {
  return { async loadRecentReplies({ chatId, before }) {
    if (reader.readMessagesByIds === undefined) return [];
    const after = new Date(before.getTime() - DAY_MS);
    const deliveries = (await queryable.query<{ delivery_id: string; reply_message_id: string }>(
      `SELECT id AS delivery_id, reply_message_id FROM answer_reply_deliveries
       WHERE provider = 'feishu' AND chat_id = $1 AND state = 'sent'
         AND reply_message_id IS NOT NULL AND sent_at >= $2 AND sent_at < $3
       ORDER BY sent_at DESC, id DESC LIMIT 2`, [chatId, after, before],
    )).rows.slice(0, MAX_REPLIES).filter(row => typeof row.delivery_id === "string" && typeof row.reply_message_id === "string");
    if (deliveries.length === 0) return [];
    const traces = (await queryable.query<SourceIdentity>(
      `SELECT delivery_id, document_source_id, document_snapshot_id,
              cross_group_grant_id, cross_group_grant_version, cross_group_grantor_group_id, cross_group_grantee_group_id
       FROM answer_reply_source_traces WHERE delivery_id = ANY($1::text[])
       ORDER BY delivery_id ASC, prompt_rank ASC LIMIT 2001`, [deliveries.map(row => row.delivery_id)],
    )).rows;
    if (traces.length > MAX_SOURCE_TRACES) return [];
    const allowedIds: string[] = [];
    const sourceBindingsByMessage = new Map<string, AssistantDocumentSourceBinding[]>();
    for (const delivery of deliveries) {
      const sources = traces.filter(source => source.delivery_id === delivery.delivery_id);
      if (await canReuseSources({ chatId, sources, verifier, grants })) {
        allowedIds.push(delivery.reply_message_id);
        sourceBindingsByMessage.set(delivery.reply_message_id, sources.map(source => ({
          documentSourceId: source.document_source_id,
          documentSnapshotId: source.document_snapshot_id,
          ...(source.cross_group_grant_id === null ? {} : {
            crossGroupGrantId: source.cross_group_grant_id,
            crossGroupGrantVersion: source.cross_group_grant_version!,
            crossGroupGrantorGroupId: source.cross_group_grantor_group_id!,
            crossGroupGranteeGroupId: source.cross_group_grantee_group_id!,
          }),
        })));
      }
    }
    if (allowedIds.length === 0) return [];
    const messages = await reader.readMessagesByIds({ chatId, messageIds: allowedIds, sender: "assistant" });
    return messages.filter(message => allowedIds.includes(message.messageId) && message.chatId === chatId
      && message.role === "assistant" && message.sentAt >= after && message.sentAt < before).slice(0, MAX_REPLIES)
      .map(message => {
        const sources = sourceBindingsByMessage.get(message.messageId)!;
        return { ...message, ...(sources.length === 0 ? {} : { underlyingDocumentSources: sources }) };
      });
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
