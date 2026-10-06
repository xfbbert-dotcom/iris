import type { RetrievedDocumentFragment } from "../documents/document-fragment-repository.js";
import type { DocumentSnapshotRepository } from "../documents/document-snapshot-repository.js";
import { normalizeConversationMessageTextForStorage } from "../conversation/conversation-message-repository.js";
import type {
  FeishuChatHistoryMessage,
  FeishuChatHistoryReader,
} from "../feishu/feishu-chat-history-reader.js";
import type { DocumentRetrievalContextBuilder } from "../memory/document-retrieval-context.js";
import {
  boundLiveAnalysisItems,
  truncateLiveAnalysisText,
} from "../memory/live-analysis-text.js";
import { hashLocalMessageText } from "../memory/local-message-source.js";
import {
  createPdSourceRef,
  type PdContext,
  type PdIssue,
  type PdJob,
  type PdSource,
} from "./contracts.js";
import type { PdRepository } from "./repository.js";
import type { PdSourceVerifier } from "./source-verifier.js";

export interface PdContextBuilder {
  load(job: PdJob): Promise<PdContext | null>;
}

const MAX_MESSAGES = 20;
const MAX_DOCUMENTS = 12;
const MAX_DOCUMENT_TEXT = 1200;
const MAX_QUERY_TEXT = 4000;

export function createPdContextBuilder({
  repository,
  reader,
  documents,
  sourceVerifier,
  canReadGroup,
  historicalSnapshots,
}: {
  repository: Pick<PdRepository, "readState">;
  reader: FeishuChatHistoryReader;
  documents: (chatId: string) => DocumentRetrievalContextBuilder;
  sourceVerifier: PdSourceVerifier;
  canReadGroup: (chatId: string) => boolean;
  historicalSnapshots?: Pick<DocumentSnapshotRepository, "findSnapshotById">;
}): PdContextBuilder {
  return {
    async load(job) {
      if (!canReadGroup(job.chatId)) return null;
      const before = await repository.readState(job.chatId);
      if (!policyMatchesJob(before.policy, job)) return null;
      if (!await sourceVerifier.verify({ chatId: job.chatId, sources: [] })) return null;

      const listed = await reader.listRecentMessages({ chatId: job.chatId, limit: MAX_MESSAGES });
      const eligible = uniqueCurrentHumanMessages(listed, job.chatId).slice(0, MAX_MESSAGES);
      let trigger = eligible.find((message) => message.messageId === job.messageId);
      if (trigger === undefined) {
        if (reader.readMessagesByIds === undefined) return null;
        const exact = await reader.readMessagesByIds({
          chatId: job.chatId,
          messageIds: [job.messageId],
          sender: "user",
        });
        trigger = uniqueCurrentHumanMessages(exact, job.chatId)
          .find((message) => message.messageId === job.messageId);
        if (trigger === undefined) return null;
        if (eligible.length >= MAX_MESSAGES) eligible.pop();
        eligible.push(trigger);
      }
      const storedTriggerText = normalizeConversationMessageTextForStorage(trigger.text);
      if (storedTriggerText === null || hashLocalMessageText(storedTriggerText) !== job.contentHash) {
        return null;
      }

      const messages = eligible.sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());
      const messageEntries = messages.map((message) => {
        const binding = {
          chatId: job.chatId,
          messageId: message.messageId,
          contentHash: hashLocalMessageText(message.text),
        };
        const source: PdSource = {
          kind: "message",
          ref: createPdSourceRef({ kind: "message", binding }),
          binding,
        };
        return { source, text: message.text };
      });

      const queryText = [trigger, ...messages.filter((message) => message.messageId !== trigger!.messageId)]
        .map((message) => message.text)
        .join("\n")
        .slice(0, MAX_QUERY_TEXT);
      const retrieval = await documents(job.chatId).buildContext({
        queryText,
        liveChatMessages: [],
        fragmentLimit: MAX_DOCUMENTS,
        liveChatLimit: 0,
      });
      const documentEntries = retrieval.allowedFragments
        .filter((fragment) => fragment.text.trim().length > 0)
        .slice(0, MAX_DOCUMENTS)
        .map(toDocumentEntry);
      const currentSources = uniqueSources([
        ...messageEntries.map(({ source }) => source),
        ...documentEntries.map(({ source }) => source),
      ]);
      if (!await sourceVerifier.verify({ chatId: job.chatId, sources: currentSources })) return null;

      const verifiedIssues: PdIssue[] = [];
      for (const issue of before.issues) {
        if (
          issue.chatId === job.chatId
          && issue.proseSources !== null && issue.proseSources !== undefined
          && issue.proseSources.length > 0 && issue.proseSources.length <= 1000
          && await sourceVerifier.verify({ chatId: job.chatId, sources: issue.proseSources })
        ) verifiedIssues.push(issue);
      }
      const allSources = uniqueSources([
        ...currentSources,
        ...verifiedIssues.flatMap((issue) => issue.proseSources!),
      ]);
      // Never clip provenance while retaining text derived from the missing part.
      if (allSources.length > 1000) return null;

      const sourceRefs = new Set(allSources.map(source => source.ref));
      const currentRefs = new Set(currentSources.map(source => source.ref));
      const basis = uniqueSources(verifiedIssues.flatMap(issue => issue.basisSources));
      if (basis.some(source => !sourceRefs.has(source.ref) || source.ref !== createPdSourceRef(source))) return null;
      const missingBasis = basis.filter(source => !currentRefs.has(source.ref));
      // A verified historical binding alone is not evidence text. Restore only
      // the accepted baseline, never the accumulated prose history or AI text.
      const restored = await restoreBasisText(missingBasis, job.chatId);
      if (restored === null) return null;
      if (missingBasis.length && !await sourceVerifier.verify({ chatId: job.chatId, sources: allSources })) return null;

      const bounded = boundLiveAnalysisItems([
        ...messageEntries.map(({ source, text }) => ({ ref: source.ref, text })),
        ...documentEntries.map(({ source, text }) => ({
          ref: source.ref,
          text: truncateLiveAnalysisText(text, MAX_DOCUMENT_TEXT),
        })),
        ...restored,
      ]);
      const after = await repository.readState(job.chatId);
      if (
        !canReadGroup(job.chatId)
        || !policyMatchesJob(after.policy, job)
        || after.contextVersion !== before.contextVersion
        || after.catalogVersion !== before.catalogVersion
      ) return null;

      return {
        chatId: job.chatId,
        triggerMessageId: job.messageId,
        policy: before.policy!,
        contextVersion: before.contextVersion,
        catalogVersion: before.catalogVersion,
        sources: allSources,
        items: bounded,
        issues: verifiedIssues,
      };
    },
  };

  async function restoreBasisText(sources: PdSource[], chatId: string): Promise<{ ref: string; text: string }[] | null> {
    const restored: { ref: string; text: string }[] = [];
    try {
      const messages = sources.filter(source => source.kind === "message");
      if (messages.length && !reader.readMessagesByIds) return null;
      for (let offset = 0; offset < messages.length; offset += 8) {
        if (!canReadGroup(chatId)) return null;
        const batch = messages.slice(offset, offset + 8);
        const expected = new Map(batch.map(source => [source.binding.messageId, source]));
        if (expected.size !== batch.length) return null;
        const read = await reader.readMessagesByIds!({ chatId, messageIds: [...expected.keys()], sender: "user" });
        if (read.length !== batch.length) return null;
        const seen = new Set<string>();
        for (const message of read) {
          const source = expected.get(message.messageId);
          if (!source || seen.has(message.messageId) || source.binding.chatId !== chatId
            || uniqueCurrentHumanMessages([message], chatId).length !== 1
            || message.underlyingLocalMessageSources !== undefined
            || hashLocalMessageText(message.text) !== source.binding.contentHash) return null;
          seen.add(message.messageId);
          restored.push({ ref: source.ref, text: message.text });
        }
      }
      for (const source of sources) {
        if (source.kind !== "document") continue;
        if (!canReadGroup(chatId) || !historicalSnapshots) return null;
        const snapshot = await historicalSnapshots.findSnapshotById(source.binding.documentSnapshotId);
        if (!snapshot || snapshot.id !== source.binding.documentSnapshotId
          || snapshot.documentSourceId !== source.binding.documentSourceId || snapshot.fetchStatus !== "succeeded"
          || !snapshot.bodyText?.trim()) return null;
        restored.push({ ref: source.ref, text: truncateLiveAnalysisText(snapshot.bodyText, MAX_DOCUMENT_TEXT) });
      }
      return canReadGroup(chatId) ? restored : null;
    } catch { return null; }
  }
}

function policyMatchesJob(
  policy: { chatId: string; version: number; enabled: boolean } | null,
  job: PdJob,
): boolean {
  return policy !== null
    && policy.enabled
    && policy.chatId === job.chatId
    && policy.version === job.policyVersion;
}

function uniqueCurrentHumanMessages(
  messages: readonly FeishuChatHistoryMessage[],
  chatId: string,
): FeishuChatHistoryMessage[] {
  const byId = new Map<string, FeishuChatHistoryMessage>();
  for (const message of messages) {
    if (
      message.chatId !== chatId
      || message.role === "assistant"
      || message.senderId.trim().length === 0
      || message.text.trim().length === 0
      || message.sharedChatRecap === true
      || message.underlyingDocumentSources !== undefined
      || message.underlyingChatSources !== undefined
      || "sharedChatSource" in message
    ) continue;
    if (!byId.has(message.messageId)) byId.set(message.messageId, message);
  }
  return [...byId.values()];
}

function toDocumentEntry(fragment: RetrievedDocumentFragment): { source: PdSource; text: string } {
  const binding = {
    documentSourceId: fragment.documentSourceId,
    documentSnapshotId: fragment.documentSnapshotId,
    ...(fragment.crossGroupGrantId === undefined ? {} : { crossGroupGrantId: fragment.crossGroupGrantId }),
    ...(fragment.crossGroupGrantVersion === undefined ? {} : { crossGroupGrantVersion: fragment.crossGroupGrantVersion }),
    ...(fragment.crossGroupGrantorGroupId === undefined ? {} : {
      crossGroupGrantorGroupId: fragment.crossGroupGrantorGroupId,
    }),
    ...(fragment.crossGroupGranteeGroupId === undefined ? {} : {
      crossGroupGranteeGroupId: fragment.crossGroupGranteeGroupId,
    }),
  };
  return {
    source: {
      kind: "document",
      ref: createPdSourceRef({ kind: "document", binding }),
      binding,
    },
    text: fragment.text,
  };
}

function uniqueSources(sources: readonly PdSource[]): PdSource[] {
  const byRef = new Map<string, PdSource>();
  for (const source of sources) {
    if (!byRef.has(source.ref)) byRef.set(source.ref, source);
  }
  return [...byRef.values()];
}
