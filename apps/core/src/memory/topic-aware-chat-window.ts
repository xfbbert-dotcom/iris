import { normalizeConversationStateQueryTerms } from "../conversation-state/conversation-state-context-provider.js";
import { isReferentialFollowup } from "./followup-historical-chat-query.js";

type ChatTopicMessage = {
  text: string;
  speaker?: string;
  messageId?: string;
  parentMessageId?: string;
  rootMessageId?: string;
  role?: "user" | "assistant";
  selectionTopicTerms?: readonly string[];
};

type TopicBundle = {
  identity: string;
  sourceIndex: number;
  labelIndex?: number;
  labelScore: number;
  labelInheritedScore: number;
  score: number;
  inheritedScore: number;
  latestMatchIndex: number;
  hasHumanSource: boolean;
};

const MAX_TOPIC_BUNDLES = 2;
const MAX_TOPIC_SLOTS = 4;
const MAX_SELECTION_TOPIC_TERMS = 24;
const MAX_IMPLICIT_SOURCE_DISTANCE = 3;
const MIN_IMPLICIT_SOURCE_CHARS = 500;
const MAX_IMPLICIT_LABEL_CHARS = 200;
const IMPLICIT_SOURCE_LABEL = /^(?:\[[^\]\r\n]{1,64}\]\s*)?(?:这是|这份|这篇|这版)/u;
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
  const inheritedTerms = isReferentialFollowup(question)
    ? collectSelectionTopicTerms(messages)
    : [];
  if (terms.length === 0 && inheritedTerms.length === 0) return messages.slice(-limit);

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
    const currentScore = terms.filter((term) => text.includes(term)).length;
    const inheritedScore = inheritedTerms.filter((term) => text.includes(term)).length;
    const score = currentScore + inheritedScore;
    if (score === 0) return;

    const source = resolveFreshSource(messages, messageIndexes, message, index)
      ?? resolveNearbyLongSource(messages, message, index);
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
        labelInheritedScore: sourceIndex === index ? 0 : inheritedScore,
        score,
        inheritedScore,
        latestMatchIndex: index,
        hasHumanSource: sourceMessage.role !== "assistant",
      });
      return;
    }

    existing.score = Math.max(existing.score, score);
    existing.inheritedScore = Math.max(existing.inheritedScore, inheritedScore);
    existing.latestMatchIndex = Math.max(existing.latestMatchIndex, index);
    if (
      sourceIndex !== index
      && (
        inheritedScore > existing.labelInheritedScore
        || (inheritedScore === existing.labelInheritedScore && score > existing.labelScore)
        || (
          inheritedScore === existing.labelInheritedScore
          && score === existing.labelScore
          && index > (existing.labelIndex ?? -1)
        )
      )
    ) {
      existing.labelIndex = index;
      existing.labelScore = score;
      existing.labelInheritedScore = inheritedScore;
    }
  });

  const rankedBundles = [...bundles.values()].sort((left, right) => (
    Number(right.inheritedScore > 0) - Number(left.inheritedScore > 0)
    || Number(right.hasHumanSource) - Number(left.hasHumanSource)
    || Number(right.labelIndex !== undefined) - Number(left.labelIndex !== undefined)
    || right.inheritedScore - left.inheritedScore
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
  messages: readonly ChatTopicMessage[],
  messageIndexes: ReadonlyMap<string, readonly number[]>,
  message: ChatTopicMessage,
  messageIndex: number,
): { identity: string; index: number } | undefined {
  const references = [message.parentMessageId, message.rootMessageId]
    .filter((identity): identity is string => identity !== undefined);
  for (const identity of references) {
    const indexes = messageIndexes.get(identity) ?? [];
    for (let cursor = indexes.length - 1; cursor >= 0; cursor -= 1) {
      const index = indexes[cursor]!;
      if (index < messageIndex && messages[index]?.role !== "assistant") {
        return { identity, index };
      }
    }
  }
  return undefined;
}

function collectSelectionTopicTerms(messages: readonly ChatTopicMessage[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const value of message.selectionTopicTerms?.slice(0, MAX_SELECTION_TOPIC_TERMS) ?? []) {
      for (const term of normalizeConversationStateQueryTerms(value.trim().toLowerCase())) {
        if (
          term.length < 2 || GENERIC_TERMS.has(term) || /^\d+$/u.test(term)
          || CJK_QUESTION_PARTICLES.test(term) || seen.has(term)
        ) continue;
        seen.add(term);
        terms.push(term);
        if (terms.length === MAX_SELECTION_TOPIC_TERMS) return terms;
      }
    }
  }
  return terms;
}

function resolveNearbyLongSource(
  messages: readonly ChatTopicMessage[],
  label: ChatTopicMessage,
  labelIndex: number,
): { identity: string; index: number } | undefined {
  const labelText = label.text.trim();
  if (
    label.parentMessageId !== undefined || label.rootMessageId !== undefined
    || labelText.length > MAX_IMPLICIT_LABEL_CHARS || !IMPLICIT_SOURCE_LABEL.test(labelText)
  ) return undefined;

  const earliestIndex = Math.max(0, labelIndex - MAX_IMPLICIT_SOURCE_DISTANCE);
  for (let index = labelIndex - 1; index >= earliestIndex; index -= 1) {
    const source = messages[index]!;
    if (
      source.role === "assistant" || source.text.trim().length < MIN_IMPLICIT_SOURCE_CHARS
      || (
        label.speaker !== undefined && source.speaker !== undefined
        && label.speaker !== source.speaker
      )
    ) continue;
    return { identity: source.messageId ?? `index:${index}`, index };
  }
  return undefined;
}
