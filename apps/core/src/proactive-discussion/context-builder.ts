import type { RetrievedDocumentFragment } from "../documents/document-fragment-repository.js";
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
}: {
  repository: Pick<PdRepository, "readState">;
  reader: FeishuChatHistoryReader;
  documents: (chatId: string) => DocumentRetrievalContextBuilder;
  sourceVerifier: PdSourceVerifier;
  canReadGroup: (chatId: string) => boolean;
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

      const bounded = boundLiveAnalysisItems([
        ...messageEntries.map(({ source, text }) => ({ ref: source.ref, text })),
        ...documentEntries.map(({ source, text }) => ({
          ref: source.ref,
          text: truncateLiveAnalysisText(text, MAX_DOCUMENT_TEXT),
        })),
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
