import type { FeishuChatHistoryMessage } from "../feishu/feishu-chat-history-reader.js";
import { extractHistoricalChatTopicTerms, resolveHistoricalChatQuery, type HistoricalChatQuery } from "./historical-chat-query.js";

const GENERIC_FOLLOWUP_TERMS = new Set([
  "区别", "对比", "比较", "建议", "如何", "怎么", "什么", "哪个", "哪些", "觉得", "合适", "更好", "两版", "两个",
]);
const REFERENTIAL_FOLLOWUP_PATTERN = /^(?:哪(?:版|份)|两者|它们?|[这那](?:份|版)|那你觉得(?:呢|哪(?:版|份)))/u;

export function isReferentialFollowup(question: string | undefined): boolean {
  return question !== undefined && REFERENTIAL_FOLLOWUP_PATTERN.test(question.trim());
}

/** Resolve source references from fresh human turns, not Iris's previous guesses. */
export function resolveFollowupHistoricalQueries(
  question: string | undefined,
  recent: readonly FeishuChatHistoryMessage[],
): HistoricalChatQuery[] {
  if (!question?.trim()) return [];
  const terms = extractHistoricalChatTopicTerms(question).filter(term => !GENERIC_FOLLOWUP_TERMS.has(term));
  const deicticFollowup = isReferentialFollowup(question);
  const matches: HistoricalChatQuery[] = [];
  for (const message of recent.slice(0, deicticFollowup ? 20 : 100)) {
    if (message.role === "assistant") continue;
    const query = resolveHistoricalChatQuery(message.text, message.sentAt);
    if (query === undefined || query.terms.length === 0) continue;
    const sharedTerms = query.terms.filter(term => terms.includes(term));
    if (sharedTerms.length === 0 && !deicticFollowup) continue;
    const selectedTerms = sharedTerms.length > 0 ? sharedTerms : query.terms;
    if (matches.some(existing => existing.start.getTime() === query.start.getTime())) continue;
    matches.push({ ...query, terms: selectedTerms });
    if (matches.length === 2) break;
  }
  return matches;
}
