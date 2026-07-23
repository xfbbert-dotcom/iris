import type { ProactiveSignalDeliveryContext } from "./proactive-signal-repository.js";

const MAX_CARD_JSON_BYTES = 24 * 1024;
const MAX_COMPONENTS = 12;

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
  const { candidate } = input.context;
  let componentCount = 0;
  const component = <T extends Record<string, unknown>>(value: T): T => {
    componentCount += 1;
    return value;
  };
  const summary = candidate.kind === "overdue_action"
    ? "Action appears overdue"
    : "Thread has been quiet";
  const suggestedAction = candidate.suggestedMode === "ask_for_status"
    ? "Please share the latest status when convenient."
    : "Please share whether this thread still needs follow-up.";
  const evidenceCount = candidate.evidenceMessageIds.length;
  const card: Record<string, unknown> = {
    schema: "2.0",
    header: {
      template: candidate.priority === "high" ? "red" : "orange",
      title: { tag: "plain_text", content: "Iris follow-up" },
    },
    body: {
      elements: [
        component({
          tag: "markdown",
          content: [
            `**${summary}**`,
            `Type: ${candidate.entityType}`,
            `Version: ${candidate.entityVersion}`,
            `Context: ${evidenceCount} related ${evidenceCount === 1 ? "message" : "messages"}`,
          ].join("\n"),
        }),
        component({
          tag: "markdown",
          content: suggestedAction,
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
