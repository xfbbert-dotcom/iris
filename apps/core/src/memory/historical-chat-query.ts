import { normalizeConversationStateQueryTerms } from "../conversation-state/conversation-state-context-provider.js";

export type HistoricalChatQuery = {
  start: Date;
  end: Date;
  terms: string[];
};

type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TOPIC_TERMS = 12;
const DATE_REFERENCE_PATTERN = /\d{4}-\d{1,2}-\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日|昨天|昨日|前天|今天|今日/gu;
const CJK_SENTENCE_PARTICLES = /[的了吗呢吧啊呀么]/u;
const TOPIC_NOISE = [
  /主要(?:是)?(?:讲|说|聊)(?:了)?(?:些)?什么/gu,
  /(?:聊|讲|说)(?:了)?(?:些)?什么/gu,
  /发的/gu,
  /请问|告诉我|帮我|主要|内容|话题|事情|消息|记录|关于|有关/gu,
];
const GENERIC_TOPIC_TERMS = new Set([
  "聊天", "讨论", "提到", "说到", "讲过", "聊过", "查看", "查询", "回顾", "总结",
  "what", "when", "about", "discuss", "discussed", "talk", "talked", "tell", "show",
  "conversation", "conversations", "message", "messages", "content", "history",
]);

export function resolveHistoricalChatQuery(
  question: string | undefined,
  now: Date,
): HistoricalChatQuery | undefined {
  const normalizedQuestion = question?.trim();
  if (!normalizedQuestion || !Number.isFinite(now.getTime())) return undefined;

  const references = [...normalizedQuestion.matchAll(DATE_REFERENCE_PATTERN)];
  if (references.length !== 1) return undefined;

  const reference = references[0];
  const referenceText = reference?.[0];
  const referenceIndex = reference?.index;
  if (referenceText === undefined || referenceIndex === undefined) return undefined;

  const today = chinaCalendarDate(now);
  const date = parseDateReference(referenceText, today);
  if (date === undefined || compareCalendarDates(date, today) > 0) return undefined;

  const startMs = Date.UTC(date.year, date.month - 1, date.day) - CHINA_OFFSET_MS;
  const topicText = [
    normalizedQuestion.slice(0, referenceIndex),
    normalizedQuestion.slice(referenceIndex + referenceText.length),
  ].join(" ");

  return {
    start: new Date(startMs),
    end: new Date(startMs + DAY_MS),
    terms: extractTopicTerms(topicText),
  };
}

function chinaCalendarDate(value: Date): CalendarDate {
  const shifted = new Date(value.getTime() + CHINA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function parseDateReference(reference: string, today: CalendarDate): CalendarDate | undefined {
  const relativeDays = reference === "前天"
    ? -2
    : reference === "昨天" || reference === "昨日"
      ? -1
      : reference === "今天" || reference === "今日"
        ? 0
        : undefined;
  if (relativeDays !== undefined) {
    const value = new Date(Date.UTC(today.year, today.month - 1, today.day + relativeDays));
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
    };
  }

  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(reference);
  const chineseDateMatch = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u.exec(reference);
  const monthDayMatch = /^(\d{1,2})月(\d{1,2})日$/u.exec(reference);
  const match = isoMatch ?? chineseDateMatch ?? monthDayMatch;
  if (match === null) return undefined;

  const date = isoMatch !== null || chineseDateMatch !== null
    ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
    : { year: today.year, month: Number(match[1]), day: Number(match[2]) };
  return isValidCalendarDate(date) ? date : undefined;
}

function isValidCalendarDate(date: CalendarDate): boolean {
  if (date.year < 1 || date.year > 9999) return false;
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return value.getUTCFullYear() === date.year
    && value.getUTCMonth() + 1 === date.month
    && value.getUTCDate() === date.day;
}

function compareCalendarDates(left: CalendarDate, right: CalendarDate): number {
  return left.year - right.year || left.month - right.month || left.day - right.day;
}

function extractTopicTerms(value: string): string[] {
  let topicText = value.toLowerCase();
  for (const noise of TOPIC_NOISE) topicText = topicText.replace(noise, " ");

  return normalizeConversationStateQueryTerms(topicText)
    .filter((term) => (
      term.length >= 2
      && !GENERIC_TOPIC_TERMS.has(term)
      && !CJK_SENTENCE_PARTICLES.test(term)
      && !/^\d+$/u.test(term)
    ))
    .slice(0, MAX_TOPIC_TERMS);
}
