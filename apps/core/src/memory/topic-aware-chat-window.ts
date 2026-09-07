import { normalizeConversationStateQueryTerms } from "../conversation-state/conversation-state-context-provider.js";

type ChatTopicMessage = {
  text: string;
  messageId?: string;
  parentMessageId?: string;
  rootMessageId?: string;
};

const MAX_TOPIC_SLOTS = 2;
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

  const messageIndexes = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.messageId !== undefined) messageIndexes.set(message.messageId, index);
  });
  const candidates = messages.flatMap((message, index) => {
    const text = message.text.trim().toLowerCase();
    if (text === normalizedQuestion || text.endsWith(normalizedQuestion)) return [];
    const score = terms.filter((term) => text.includes(term)).length;
    if (score === 0) return [];
    const parentIndex = [message.parentMessageId, message.rootMessageId]
      .flatMap((id) => id === undefined ? [] : [messageIndexes.get(id)])
      .find((candidate): candidate is number => candidate !== undefined && candidate < index);
    return [{ index, score, parentIndex }];
  }).sort((left, right) => (
    Number(right.parentIndex !== undefined) - Number(left.parentIndex !== undefined)
    || right.score - left.score
    || right.index - left.index
  ));

  const selected = new Set<number>();
  const topicLimit = Math.min(MAX_TOPIC_SLOTS, limit);
  for (const candidate of candidates) {
    if (selected.size >= topicLimit) break;
    if (candidate.parentIndex !== undefined) selected.add(candidate.parentIndex);
    if (selected.size < topicLimit) selected.add(candidate.index);
  }
  for (let index = messages.length - 1; index >= 0 && selected.size < limit; index -= 1) {
    selected.add(index);
  }
  return messages.filter((_message, index) => selected.has(index));
}
