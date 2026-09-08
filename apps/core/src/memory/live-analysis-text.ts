import type { EvidencePlanningDocument } from "../agent/evidence-plan.js";
import type { LiveChatMessage } from "./context-assembly.js";

export const MAX_LIVE_ANALYSIS_TEXT_CHARS = 8000;
export const MAX_LIVE_ANALYSIS_TOTAL_CHARS = 24000;
const TRUNCATION_MARKER = " ... [truncated]";

export function truncateLiveAnalysisText(value: string, maxChars = MAX_LIVE_ANALYSIS_TEXT_CHARS): string {
  const text = value.trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`;
}

// Give short messages their full space, then share the remaining budget among long originals.
// Counts and ordering stay intact so source/reply bundles survive text budgeting.
export function boundLiveAnalysisItems<T extends { text: string }>(items: readonly T[]): T[] {
  const bounded = items.map((item) => ({ ...item, text: truncateLiveAnalysisText(item.text) }));
  const lengths = bounded.map(({ text }) => text.length).sort((left, right) => left - right);
  let remaining = MAX_LIVE_ANALYSIS_TOTAL_CHARS;
  let cap = MAX_LIVE_ANALYSIS_TEXT_CHARS;
  for (let index = 0; index < lengths.length; index += 1) {
    const share = Math.floor(remaining / (lengths.length - index));
    if (lengths[index]! > share) {
      cap = share;
      break;
    }
    remaining -= lengths[index]!;
  }
  return bounded.map((item) => ({ ...item, text: truncateLiveAnalysisText(item.text, cap) }));
}

export function boundLiveAnalysisPayload(
  evidence: EvidencePlanningDocument[],
  liveChatMessages: LiveChatMessage[],
): { evidence: EvidencePlanningDocument[]; liveChatMessages: LiveChatMessage[] } {
  const chatEvidence = evidence.filter(({ citationRef }) => /^C(?:[1-9]|10)$/u.test(citationRef));
  // Human originals already appear as Cn facts. Assistant output is always separate conversation.
  const conversation = liveChatMessages.filter((message) => message.role === "assistant" || !chatEvidence.some(({ text }) => (
    text === message.text || text === truncateLiveAnalysisText(`${message.speaker}: ${message.text}`)
  )));
  const bounded = boundLiveAnalysisItems([...chatEvidence, ...conversation]);
  const byRef = new Map(chatEvidence.map((item, index) => [item.citationRef, bounded[index]!.text]));
  return {
    evidence: evidence.map((item) => ({ ...item, text: byRef.get(item.citationRef) ?? item.text })),
    liveChatMessages: conversation.map((item, index) => ({ ...item, text: bounded[chatEvidence.length + index]!.text })),
  };
}
