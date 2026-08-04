import type { ProactiveSignalDeliveryContext } from "./proactive-signal-repository.js";

const MAX_CARD_JSON_BYTES = 24 * 1024;
const MAX_COMPONENTS = 12;
const MAX_VISIBLE_SUBJECT_CHARS = 160;

export type ProactiveSignalCardRenderInput = {
  context: ProactiveSignalDeliveryContext;
};

export type ProactiveSignalCardRenderResult = {
  card: Record<string, unknown>;
  json: string;
  componentCount: number;
};

export function renderProactiveSignalCard(
  input: ProactiveSignalCardRenderInput,
): ProactiveSignalCardRenderResult {
  const { delivery, candidate } = input.context;
  let componentCount = 0;
  const component = <T extends Record<string, unknown>>(value: T): T => {
    componentCount += 1;
    return value;
  };
  const subjectLabel = escapeFeishuMarkdown(normalizeSubjectLabel(input.context.subjectLabel));
  const subjectKind = candidate.kind === "overdue_action" ? "行动项" : "讨论";
  const summary = candidate.kind === "overdue_action"
    ? "这个行动项已超过截止时间"
    : "这个讨论已有一段时间没有更新";
  const suggestedAction = candidate.suggestedMode === "ask_for_status"
    ? "请在方便时补充最新状态。"
    : "请告诉我：这件事还需要继续跟进吗？";
  const evidenceCount = candidate.evidenceMessageIds.length;
  const feedbackCallbackValue = (action: "helpful" | "irrelevant") => ({
    kind: "proactive_signal_feedback",
    action,
    deliveryId: delivery.id,
    candidateIdempotencyKey: candidate.idempotencyKey,
    entityVersion: String(candidate.entityVersion),
  });
  const feedbackElements = [
    component({
      tag: "button",
      name: "helpful",
      text: { tag: "plain_text", content: "\u6709\u5e2e\u52a9" },
      type: "primary",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: feedbackCallbackValue("helpful") }],
    }),
    component({
      tag: "button",
      name: "irrelevant",
      text: { tag: "plain_text", content: "\u4e0d\u76f8\u5173" },
      type: "default",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: feedbackCallbackValue("irrelevant") }],
    }),
  ];
  const card: Record<string, unknown> = {
    schema: "2.0",
    header: {
      template: candidate.priority === "high" ? "red" : "orange",
      title: { tag: "plain_text", content: "Iris 主动提醒" },
    },
    body: {
      elements: [
        component({
          tag: "markdown",
          content: [
            `**${summary}**`,
            `**${subjectKind}：** ${subjectLabel}`,
            `依据：${evidenceCount} 条相关群消息`,
          ].join("\n"),
        }),
        component({
          tag: "markdown",
          content: suggestedAction,
        }),
        component({
          tag: "form",
          name: "proactiveSignalFeedback",
          elements: feedbackElements,
        }),
      ],
    },
  };
  if (componentCount > MAX_COMPONENTS) {
    throw new Error("proactive signal card has too many components");
  }
  const json = JSON.stringify(card);
  if (Buffer.byteLength(json, "utf8") > MAX_CARD_JSON_BYTES) {
    throw new Error("proactive signal card is too large");
  }
  return { card, json, componentCount };
}

function normalizeSubjectLabel(value: string | undefined): string {
  if (typeof value !== "string") throw new Error("proactive signal subject is unavailable");
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) throw new Error("proactive signal subject is unavailable");
  const characters = Array.from(normalized);
  if (characters.length <= MAX_VISIBLE_SUBJECT_CHARS) return normalized;
  return `${characters.slice(0, MAX_VISIBLE_SUBJECT_CHARS - 3).join("")}...`;
}

function escapeFeishuMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>~])/gu, "\\$1");
}
