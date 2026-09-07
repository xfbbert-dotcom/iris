export type StandaloneConversationKind = "social" | "general_assistance";

const MAX_CLASSIFIER_INPUT_LENGTH = 4_000;

const SOCIAL_PATTERNS = [
  /^(?:哈喽呀?|哈啰|你好呀?|您好|你?在吗|早上好|早安|下午好|晚上好|晚安)$/u,
  /^(?:谢谢[你啦]?|多谢|感谢|辛苦了|收到|好的|好呀|明白了|知道了|没问题)$/u,
  /^(?:哈哈哈|最近怎么样)$/u,
  /^(?:你是谁|你叫什么名字|你能做什么|你会做什么)$/u,
  /^(?:hello|hi|hey|good morning|good afternoon|good evening|good night)$/iu,
  /^(?:thanks|thank you|much appreciated|got it|ok|okay|sounds good)$/iu,
  /^(?:who are you|what can you do|how can you help)$/iu,
] as const;

const CHINESE_GENERAL_ASSISTANCE_PATTERNS = [
  /^(?:请|麻烦)?帮我(?:想|设计|写|起草|生成|准备|整理|提供)(?:一份|一些|几个|[一二三四五六七八九十两\d]+个)?(?:通用|基础|用户)?访谈(?:问题|提纲|建议)$/u,
  /^(?:请)?给我(?:一份|一些|几个)?(?:通用|基础|用户)?访谈(?:问题|提纲|建议)$/u,
  /^(?:请|麻烦)?帮我(?:设计|写|起草|生成|准备|整理)(?:一份)?(?:通用|用户调研|用户研究|访谈)?问卷(?:模板)?$/u,
  /^(?:请|麻烦)?帮我(?:设计|写|起草|生成|准备)(?:一份)?(?:通用|基础|新员工)?培训(?:大纲|提纲|计划|课程大纲)$/u,
  /^(?:请|麻烦)?帮我(?:设计|写|起草|生成|准备)(?:一份)?(?:通用|跟进|感谢|邀请|提醒)?邮件模板$/u,
] as const;

const ENGLISH_GENERAL_ASSISTANCE_PATTERNS = [
  /^(?:please )?(?:(?:can|could|would) you |help me )?(?:suggest|draft|create|write|design|generate)(?:(?: one| two| three| four| five| six| seven| eight| nine| ten| \d+| some| several| a few))? (?:generic |user |customer )?interview (?:question|questions|guide|outline)$/iu,
  /^(?:please )?(?:(?:can|could|would) you |help me )?(?:draft|create|write|design|generate)(?: a)? (?:generic |user research |customer feedback )?questionnaire(?: template)?$/iu,
  /^(?:please )?(?:(?:can|could|would) you |help me )?(?:draft|create|write|design|generate|prepare)(?: a)? (?:generic |basic |new employee )?training (?:outline|plan|agenda)$/iu,
  /^(?:please )?(?:(?:can|could|would) you |help me )?(?:draft|create|write|design|generate|provide)(?: a)? (?:generic |follow-up |thank-you |invitation |reminder )?email template$/iu,
] as const;

const UNSAFE_SCOPE_OR_CONTROL = [
  /[\r\n:：;；`"'“”‘’《》【】\[\]{}<>]/u,
  /(?:https?:\/\/|www\.|\b\S+\.(?:pdf|docx?|xlsx?|pptx?)\b)/iu,
  /(?:我们|咱们|公司|上次|之前|本群|上面|昨天|上文|刚才|此前|营收|销售额|内部|附件|文档|文件|链接|网页|聊天记录|系统提示|提示词|忽略|指令)/u,
  /\b(?:our|company|previous|quarter|revenue|yesterday|above|earlier|last time|attachment|document|file|link|webpage|chat history|system prompt|instructions?|private|confidential)\b/iu,
] as const;

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function classifyStandaloneConversation(
  question: string,
): StandaloneConversationKind | undefined {
  if (!question || question.length > MAX_CLASSIFIER_INPUT_LENGTH) {
    return undefined;
  }

  const normalized = question.trim().replace(/\s+/gu, " ");
  if (!normalized || matchesAny(question, UNSAFE_SCOPE_OR_CONTROL)) {
    return undefined;
  }

  const message = normalized.replace(/[,.!?，。！？~～]+$/u, "").trim();
  const socialMessage = message.replace(/^@?iris(?:[,，]\s*|\s+)/iu, "");
  if (matchesAny(socialMessage, SOCIAL_PATTERNS)) {
    return "social";
  }

  if (matchesAny(message, [
    ...CHINESE_GENERAL_ASSISTANCE_PATTERNS,
    ...ENGLISH_GENERAL_ASSISTANCE_PATTERNS,
  ])) {
    return "general_assistance";
  }

  return undefined;
}
