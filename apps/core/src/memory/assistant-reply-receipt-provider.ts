import type { Queryable } from "../documents/document-fragment-repository.js";
import type { AssistantDocumentSourceBinding } from "./context-assembly.js";
import type { LocalMessageSourceBinding } from "./local-message-source.js";
import { normalizeSharedChatSourceBinding, type SharedChatSourceBinding } from "../shared-chat/working-chat-scope.js";

export type AssistantLineageReceipt = {
  receiptId: string; replyMessageId: string; sentAt: Date;
  documentSources: AssistantDocumentSourceBinding[];
  localMessageSources: LocalMessageSourceBinding[];
  sharedChatSources: SharedChatSourceBinding[];
  provenanceVersion: 1;
};
export type AssistantReceiptWindow = { chatId: string; after: Date; before: Date; limit: number };
export interface AssistantReplyLineageReceiptProvider {
  listRecentSent(input: AssistantReceiptWindow): Promise<readonly AssistantLineageReceipt[]>;
}
export type LegacyPassiveAssistantReceipt = {
  receiptId: string; replyMessageId: string; sentAt: Date;
  documentSources: readonly AssistantDocumentSourceBinding[];
  localMessageSources: readonly []; sharedChatSources: readonly []; provenanceVersion: null;
};
export type PassiveAssistantReceiptCandidate = AssistantLineageReceipt | LegacyPassiveAssistantReceipt;
export interface PassiveAssistantReceiptProvider {
  listRecentSent(input: AssistantReceiptWindow): Promise<readonly PassiveAssistantReceiptCandidate[]>;
}

export function createPassiveAssistantReceiptProvider({ queryable }: { queryable: Queryable }): PassiveAssistantReceiptProvider {
  return { async listRecentSent({ chatId, after, before, limit }) {
    const deliveries = (await queryable.query<{ delivery_id: string; reply_message_id: string; sent_at: Date; chat_provenance_version?: number | null }>(
      `SELECT id AS delivery_id, reply_message_id, sent_at, chat_provenance_version FROM answer_reply_deliveries
       WHERE provider = 'feishu' AND chat_id = $1 AND state = 'sent'
         AND reply_message_id IS NOT NULL AND sent_at >= $2 AND sent_at < $3
       ORDER BY sent_at DESC, id DESC LIMIT $4`, [chatId, after, before, limit],
    )).rows;
    if (deliveries.length === 0) return [];
    const ids = deliveries.map(row => row.delivery_id);
    const [documents, shared, local] = await Promise.all([
      queryable.query<Record<string, unknown>>(`SELECT delivery_id, document_source_id, document_snapshot_id,
        cross_group_grant_id, cross_group_grant_version, cross_group_grantor_group_id, cross_group_grantee_group_id
        FROM answer_reply_source_traces WHERE delivery_id = ANY($1::text[]) ORDER BY delivery_id, prompt_rank LIMIT 2001`, [ids]),
      queryable.query<Record<string, unknown>>(`SELECT delivery_id, trace_index, scope_id, scope_version, source_chat_id, destination_chat_id, message_id, content_hash
        FROM answer_reply_chat_source_traces WHERE delivery_id = ANY($1::text[]) ORDER BY delivery_id, trace_index LIMIT 2001`, [ids]),
      queryable.query<Record<string, unknown>>(`SELECT delivery_id, trace_index, chat_id, message_id, content_hash
        FROM answer_reply_local_source_traces WHERE delivery_id = ANY($1::text[]) ORDER BY delivery_id, trace_index LIMIT 2001`, [ids]),
    ]);
    if ([documents, shared, local].some(result => result.rows.length > 2000)) return [];
    const receipts: PassiveAssistantReceiptCandidate[] = [];
    for (const row of deliveries) {
      try {
        if (!row.delivery_id || !row.reply_message_id || !(row.sent_at instanceof Date) || !Number.isFinite(row.sent_at.getTime())
          || row.sent_at < after || row.sent_at >= before) continue;
        const documentSources = documents.rows.filter(source => source.delivery_id === row.delivery_id).map(source => ({
          documentSourceId: source.document_source_id as string, documentSnapshotId: source.document_snapshot_id as string,
          ...(source.cross_group_grant_id === null ? {} : { crossGroupGrantId: source.cross_group_grant_id as string,
            crossGroupGrantVersion: source.cross_group_grant_version as number, crossGroupGrantorGroupId: source.cross_group_grantor_group_id as string,
            crossGroupGranteeGroupId: source.cross_group_grantee_group_id as string }),
          // Preserve malformed partial grant fields for the existing validator to reject.
          ...(source.cross_group_grant_id !== null || source.cross_group_grant_version === null ? {} : { crossGroupGrantVersion: source.cross_group_grant_version as number }),
          ...(source.cross_group_grant_id !== null || source.cross_group_grantor_group_id === null ? {} : { crossGroupGrantorGroupId: source.cross_group_grantor_group_id as string }),
          ...(source.cross_group_grant_id !== null || source.cross_group_grantee_group_id === null ? {} : { crossGroupGranteeGroupId: source.cross_group_grantee_group_id as string }),
        }));
        const sharedChatSources = shared.rows.filter(source => source.delivery_id === row.delivery_id).map((source, index) => {
          if (source.trace_index !== index || source.destination_chat_id !== chatId) throw new Error("invalid shared trace");
          return normalizeSharedChatSourceBinding({ scopeId: source.scope_id as string, scopeVersion: Number(source.scope_version), sourceChatId: source.source_chat_id as string,
            destinationChatId: source.destination_chat_id as string, messageId: source.message_id as string, contentHash: source.content_hash as string });
        });
        const localMessageSources = local.rows.filter(source => source.delivery_id === row.delivery_id).map((source, index) => {
          if (source.trace_index !== index) throw new Error("invalid local trace index");
          return normalizeLocalMessageBinding({ chatId: source.chat_id, messageId: source.message_id, contentHash: source.content_hash }, chatId);
        });
        const common = { receiptId: row.delivery_id, replyMessageId: row.reply_message_id, sentAt: row.sent_at, documentSources };
        if (row.chat_provenance_version === 1) receipts.push({ ...common, localMessageSources, sharedChatSources, provenanceVersion: 1 });
        else if (row.chat_provenance_version == null && localMessageSources.length === 0 && sharedChatSources.length === 0)
          receipts.push({ ...common, localMessageSources: [], sharedChatSources: [], provenanceVersion: null });
      } catch { /* A partial or malformed lineage cannot authorize assistant text. */ }
    }
    return receipts;
  } };
}

export function normalizeLocalMessageBinding(value: unknown, chatId: string): LocalMessageSourceBinding {
  if (typeof value !== "object" || value === null) throw new Error("invalid local source");
  const source = value as Record<string, unknown>;
  if (source.chatId !== chatId || typeof chatId !== "string" || chatId.trim() !== chatId || chatId.length < 1 || chatId.length > 512
    || typeof source.messageId !== "string" || source.messageId.trim() !== source.messageId || source.messageId.length < 1 || source.messageId.length > 505
    || typeof source.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(source.contentHash)) throw new Error("invalid local source");
  return { chatId, messageId: source.messageId, contentHash: source.contentHash };
}
