import type {
  AnswerSourcePermissionGrantBinding,
  AnswerSourcePermissionVerifier,
  AnswerSourceSnapshotBinding,
} from "../answer-replies/answer-source-permission-verifier.js";
import type { FeishuChatHistoryReader } from "../feishu/feishu-chat-history-reader.js";
import { createLocalMessageSourceVerifier } from "../memory/local-message-source.js";
import { createPdSourceRef, type PdSource } from "./contracts.js";

export interface PdSourceVerifier {
  verify(input: { chatId: string; sources: readonly PdSource[] }): Promise<boolean>;
}

export function createPdSourceVerifier({
  reader,
  documents,
  canReadGroup,
  canProactivelySpeak,
}: {
  reader: FeishuChatHistoryReader;
  documents: AnswerSourcePermissionVerifier;
  canReadGroup: (chatId: string) => boolean;
  canProactivelySpeak: (chatId: string) => boolean;
}): PdSourceVerifier {
  const localMessages = createLocalMessageSourceVerifier({ reader, canReadGroup });
  return {
    async verify({ chatId, sources }) {
      if (!canProactivelySpeak(chatId)) return false;
      if (sources.some((source) => source.ref !== createPdSourceRef(source))) return false;

      const messageBindings = sources.flatMap((source) => source.kind === "message" ? [source.binding] : []);
      if (!await localMessages.verify({ chatId, sources: messageBindings })) return false;

      const documentBindings = sources.flatMap((source) => source.kind === "document" ? [source.binding] : []);
      const normalizedDocuments = normalizeDocumentBindings(chatId, documentBindings);
      if (normalizedDocuments === undefined) return false;
      if (normalizedDocuments.documentSourceIds.length > 0) {
        let decisions;
        try {
          decisions = await documents.verify({
            chatId,
            documentSourceIds: normalizedDocuments.documentSourceIds,
            sourceSnapshotBindings: normalizedDocuments.sourceSnapshotBindings,
            crossGroupGrantBindings: normalizedDocuments.crossGroupGrantBindings,
          });
        } catch {
          return false;
        }
        const allowed = new Set<string>();
        for (const decision of decisions) {
          if (
            decision.outcome !== "allowed"
            || !normalizedDocuments.documentSourceIds.includes(decision.documentSourceId)
            || allowed.has(decision.documentSourceId)
          ) return false;
          allowed.add(decision.documentSourceId);
        }
        if (allowed.size !== normalizedDocuments.documentSourceIds.length) return false;
      }

      return canReadGroup(chatId) && canProactivelySpeak(chatId);
    },
  };
}

function normalizeDocumentBindings(
  chatId: string,
  bindings: readonly PdSource["binding"][],
): {
  documentSourceIds: string[];
  sourceSnapshotBindings: AnswerSourceSnapshotBinding[];
  crossGroupGrantBindings: AnswerSourcePermissionGrantBinding[];
} | undefined {
  const bySource = new Map<string, string>();
  const sourceSnapshotBindings: AnswerSourceSnapshotBinding[] = [];
  const crossGroupGrantBindings: AnswerSourcePermissionGrantBinding[] = [];
  for (const binding of bindings) {
    if (!("documentSourceId" in binding)) return undefined;
    const grantValues = [
      binding.crossGroupGrantId,
      binding.crossGroupGrantVersion,
      binding.crossGroupGrantorGroupId,
      binding.crossGroupGranteeGroupId,
    ];
    const hasGrant = grantValues.every((value) => value !== undefined);
    if (grantValues.some((value) => value !== undefined) && !hasGrant) return undefined;
    if (
      binding.documentSourceId.trim().length === 0
      || binding.documentSnapshotId.trim().length === 0
      || (hasGrant && (
        typeof binding.crossGroupGrantId !== "string"
        || binding.crossGroupGrantId.trim().length === 0
        || !Number.isSafeInteger(binding.crossGroupGrantVersion)
        || binding.crossGroupGrantVersion! < 1
        || typeof binding.crossGroupGrantorGroupId !== "string"
        || binding.crossGroupGrantorGroupId.trim().length === 0
        || binding.crossGroupGranteeGroupId !== chatId
        || binding.crossGroupGrantorGroupId === binding.crossGroupGranteeGroupId
      ))
    ) return undefined;

    const identity = JSON.stringify([
      binding.documentSnapshotId,
      binding.crossGroupGrantId,
      binding.crossGroupGrantVersion,
      binding.crossGroupGrantorGroupId,
      binding.crossGroupGranteeGroupId,
    ]);
    const previous = bySource.get(binding.documentSourceId);
    if (previous !== undefined) {
      if (previous !== identity) return undefined;
      continue;
    }
    bySource.set(binding.documentSourceId, identity);
    sourceSnapshotBindings.push({
      documentSourceId: binding.documentSourceId,
      documentSnapshotId: binding.documentSnapshotId,
    });
    if (hasGrant) {
      crossGroupGrantBindings.push({
        documentSourceId: binding.documentSourceId,
        grantId: binding.crossGroupGrantId!,
        version: binding.crossGroupGrantVersion!,
        grantorGroupId: binding.crossGroupGrantorGroupId!,
        granteeGroupId: binding.crossGroupGranteeGroupId!,
      });
    }
  }
  return { documentSourceIds: [...bySource.keys()], sourceSnapshotBindings, crossGroupGrantBindings };
}
