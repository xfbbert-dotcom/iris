import { normalizeConversationStateQueryTerms } from "../conversation-state/conversation-state-context-provider.js";

type ChatTopicMessage = {
  text: string;
  messageId?: string;
  parentMessageId?: string;
  rootMessageId?: string;
  role?: "user" | "assistant";
};

type TopicBundle = {
  identity: string;
  sourceIndex: number;
  labelIndex?: number;
  labelScore: number;
  score: number;
  latestMatchIndex: number;
  hasHumanSource: boolean;
};

const MAX_TOPIC_BUNDLES = 2;
const MAX_TOPIC_SLOTS = 4;
const GENERIC_TERMS = new Set([
  "消息", "内容", "资料", "情况", "相关", "当前", "现在", "最近", "之前", "上次", "刚才",
  "知道", "查看", "找到", "帮助", "一下", "介绍", "事情", "问题", "信息", "记录",
  "message", "messages", "content", "information", "status", "context", "current", "recent",
  "previous", "latest", "tell", "about", "anything", "something", "news",
]);
const CJK_QUESTION_PARTICLES = /[的了吗呢吧啊呀是在有给把被和与及或从到这那我你他她它么]/u;

/** Selects within a fixed budget while retaining the input's oldest-to-newest order. */
export function selectTopicAwareChatWindow<T extends ChatTopicMessage>(
  messages: readonly T[],
  question: string | undefined,
  limit: number,
): T[] {
  if (limit <= 0) return [];
  if (messages.length <= limit) return [...messages];

  const normalizedQuestion = question?.trim().toLowerCase() ?? "";
  const terms = normalizeConversationStateQueryTerms(normalizedQuestion).filter((term) => (
    term.length >= 2 && !GENERIC_TERMS.has(term) && !/^\d+$/u.test(term)
    && !CJK_QUESTION_PARTICLES.test(term)
  ));
  if (terms.length === 0) return messages.slice(-limit);

  const messageIndexes = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (message.messageId === undefined) return;
    const indexes = messageIndexes.get(message.messageId) ?? [];
    indexes.push(index);
    messageIndexes.set(message.messageId, indexes);
  });
  const bundles = new Map<string, TopicBundle>();
  messages.forEach((message, index) => {
    if (message.role === "assistant") return;
    const text = message.text.trim().toLowerCase();
    if (text === normalizedQuestion || text.endsWith(normalizedQuestion)) return;
    const score = terms.filter((term) => text.includes(term)).length;
    if (score === 0) return;

    const source = resolveFreshSource(messageIndexes, message, index);
    const sourceIndex = source?.index ?? index;
    const sourceMessage = messages[sourceIndex]!;
    const identity = source?.identity ?? sourceMessage.messageId ?? `index:${sourceIndex}`;
    const existing = bundles.get(identity);
    if (existing === undefined) {
      bundles.set(identity, {
        identity,
        sourceIndex,
        ...(sourceIndex === index ? {} : { labelIndex: index }),
        labelScore: sourceIndex === index ? 0 : score,
        score,
        latestMatchIndex: index,
        hasHumanSource: sourceMessage.role !== "assistant",
      });
      return;
    }

    existing.score = Math.max(existing.score, score);
    existing.latestMatchIndex = Math.max(existing.latestMatchIndex, index);
    if (
      sourceIndex !== index
      && (score > existing.labelScore || (score === existing.labelScore && index > (existing.labelIndex ?? -1)))
    ) {
      existing.labelIndex = index;
      existing.labelScore = score;
    }
  });

  const rankedBundles = [...bundles.values()].sort((left, right) => (
    Number(right.hasHumanSource) - Number(left.hasHumanSource)
    || Number(right.labelIndex !== undefined) - Number(left.labelIndex !== undefined)
    || right.score - left.score
    || right.latestMatchIndex - left.latestMatchIndex
    || right.sourceIndex - left.sourceIndex
    || left.identity.localeCompare(right.identity)
  ));

  const selected = new Set<number>();
  const topicLimit = Math.min(MAX_TOPIC_SLOTS, limit);
  for (const bundle of rankedBundles.slice(0, MAX_TOPIC_BUNDLES)) {
    if (selected.size >= topicLimit) break;
    selected.add(bundle.sourceIndex);
    if (selected.size < topicLimit && bundle.labelIndex !== undefined) {
      selected.add(bundle.labelIndex);
    }
  }
  for (let index = messages.length - 1; index >= 0 && selected.size < limit; index -= 1) {
    selected.add(index);
  }
  return messages.filter((_message, index) => selected.has(index));
}

function resolveFreshSource(
  messageIndexes: ReadonlyMap<string, readonly number[]>,
  message: ChatTopicMessage,
  messageIndex: number,
): { identity: string; index: number } | undefined {
  const references = [message.parentMessageId, message.rootMessageId]
    .filter((identity): identity is string => identity !== undefined);
  const resolved = references.flatMap((identity) => {
    const indexes = messageIndexes.get(identity) ?? [];
    let index: number | undefined;
    for (let cursor = indexes.length - 1; cursor >= 0; cursor -= 1) {
      if (indexes[cursor]! < messageIndex) {
        index = indexes[cursor];
        break;
      }
    }
    return index === undefined ? [] : [{ identity, index }];
  });
  return resolved[0];
}
