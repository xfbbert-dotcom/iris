import type { Queryable } from "../documents/document-fragment-repository.js";
import type { AssistantDocumentSourceBinding } from "../memory/context-assembly.js";
import { normalizeLocalMessageBinding, type AssistantLineageReceipt, type AssistantReplyLineageReceiptProvider } from "../memory/assistant-reply-receipt-provider.js";
import { createPdSourceRef, type PdSource } from "./contracts.js";

export function createPdReceiptProvider({ queryable }: { queryable: Queryable }): AssistantReplyLineageReceiptProvider {
  return { async listRecentSent({ chatId, after, before, limit }) {
    const deliveries = (await queryable.query<Record<string, unknown>>(`SELECT id, chat_id, reply_message_id, sent_at, state,
      (SELECT count(*)::integer FROM proactive_discussion_sources s WHERE s.delivery_id = d.id) AS source_count
      FROM proactive_discussion_deliveries d WHERE chat_id=$1 AND state='sent'
      AND reply_message_id IS NOT NULL AND sent_at >= $2 AND sent_at < $3
      ORDER BY sent_at DESC, id DESC LIMIT $4`, [chatId, after, before, limit])).rows;
    if (deliveries.length === 0) return [];
    const sources = (await queryable.query<Record<string, unknown>>(`SELECT delivery_id, source_index, kind, ref, binding
      FROM proactive_discussion_sources WHERE delivery_id=ANY($1::text[]) ORDER BY delivery_id, source_index LIMIT 2001`,
    [deliveries.map(row => row.id)])).rows;
    if (sources.length > 2000) return [];
    const result: AssistantLineageReceipt[] = [];
    for (const row of deliveries) {
      try {
        if (row.state !== "sent" || row.chat_id !== chatId || typeof row.id !== "string" || !row.id
          || typeof row.reply_message_id !== "string" || !row.reply_message_id.trim()
          || !(row.sent_at instanceof Date) || !Number.isFinite(row.sent_at.getTime()) || row.sent_at < after || row.sent_at >= before
          || !Number.isInteger(row.source_count) || (row.source_count as number) < 1 || (row.source_count as number) > 1000) continue;
        const rows = sources.filter(source => source.delivery_id === row.id);
        if (rows.length !== row.source_count) continue;
        const bindings: PdSource[] = rows.map((source, index) => {
          if (source.source_index !== index || typeof source.ref !== "string") throw new Error("invalid source order");
          const binding = source.kind === "message" ? normalizeLocalMessageBinding(source.binding, chatId)
            : source.kind === "document" ? documentBinding(source.binding, chatId) : undefined;
          if (binding === undefined) throw new Error("invalid source kind");
          const normalized = { kind: source.kind, binding, ref: source.ref } as PdSource;
          if (createPdSourceRef(normalized) !== source.ref) throw new Error("invalid source ref");
          return normalized;
        });
        result.push({ receiptId: row.id, replyMessageId: row.reply_message_id, sentAt: row.sent_at, provenanceVersion: 1,
          documentSources: bindings.flatMap(source => source.kind === "document" ? [source.binding] : []),
          localMessageSources: bindings.flatMap(source => source.kind === "message" ? [source.binding] : []), sharedChatSources: [] });
      } catch { /* Unknown or partial sources never authorize the opinion body. */ }
    }
    return result;
  } };
}

function documentBinding(value: unknown, chatId: string): AssistantDocumentSourceBinding {
  if (typeof value !== "object" || value === null) throw new Error("invalid document binding");
  const source = value as Record<string, unknown>;
  const exact = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value;
  if (!exact(source.documentSourceId) || !exact(source.documentSnapshotId)) throw new Error("invalid document identity");
  const fields = [source.crossGroupGrantId, source.crossGroupGrantVersion, source.crossGroupGrantorGroupId, source.crossGroupGranteeGroupId];
  if (fields.some(field => field !== undefined) && (!exact(source.crossGroupGrantId) || !Number.isSafeInteger(source.crossGroupGrantVersion)
    || (source.crossGroupGrantVersion as number) < 1 || !exact(source.crossGroupGrantorGroupId)
    || source.crossGroupGranteeGroupId !== chatId || source.crossGroupGrantorGroupId === chatId)) throw new Error("invalid document grant");
  return { documentSourceId: source.documentSourceId, documentSnapshotId: source.documentSnapshotId,
    ...(fields.every(field => field === undefined) ? {} : { crossGroupGrantId: source.crossGroupGrantId as string,
      crossGroupGrantVersion: source.crossGroupGrantVersion as number, crossGroupGrantorGroupId: source.crossGroupGrantorGroupId as string,
      crossGroupGranteeGroupId: source.crossGroupGranteeGroupId as string }) };
}
