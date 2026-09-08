import { describe, expect, it } from "vitest";

import { selectTopicAwareChatWindow } from "../src/memory/topic-aware-chat-window.js";

type TestMessage = {
  text: string;
  messageId: string;
  parentMessageId?: string;
  rootMessageId?: string;
  role?: "user" | "assistant";
};

describe("selectTopicAwareChatWindow", () => {
  it("keeps two distinct source and label bundles despite repeated labels and newer noise", () => {
    const messages: TestMessage[] = [
      message("old-source", "Original release assumptions from the first planning cycle."),
      message("old-label", "Aurora rollout plan source", {
        parentMessageId: "old-source",
        rootMessageId: "old-source",
      }),
      message("new-source", "Revised release assumptions from the latest planning cycle."),
      message("new-label", "Aurora rollout plan source", {
        parentMessageId: "new-source",
        rootMessageId: "new-source",
      }),
      message("new-label-repeat", "Aurora follow-up", {
        parentMessageId: "new-source",
        rootMessageId: "new-source",
      }),
      ...Array.from({ length: 15 }, (_, index) =>
        message(`noise-${index + 1}`, `Unrelated status update ${index + 1}`),
      ),
    ];

    const selected = selectTopicAwareChatWindow(messages, "Compare the Aurora rollout plan", 10);

    expect(selected).toHaveLength(10);
    expect(selected.map(({ messageId }) => messageId)).toEqual([
      "old-source",
      "old-label",
      "new-source",
      "new-label",
      "noise-10",
      "noise-11",
      "noise-12",
      "noise-13",
      "noise-14",
      "noise-15",
    ]);
  });

  it("keeps a relevant long standalone source alongside a linked source bundle", () => {
    const standalone = `Aurora operating constraints ${"and supporting detail ".repeat(80)}`;
    const messages: TestMessage[] = [
      message("standalone-source", standalone),
      message("linked-source", "Release details that rely on the reply label for their topic."),
      message("linked-label", "Aurora operating constraints", {
        parentMessageId: "linked-source",
        rootMessageId: "linked-source",
      }),
      ...Array.from({ length: 10 }, (_, index) =>
        message(`noise-${index + 1}`, `Unrelated note ${index + 1}`),
      ),
    ];

    const selected = selectTopicAwareChatWindow(messages, "Analyze Aurora operating constraints", 4);

    expect(selected.map(({ messageId }) => messageId)).toEqual([
      "standalone-source",
      "linked-source",
      "linked-label",
      "noise-10",
    ]);
  });

  it("does not let assistant output outrank a relevant human source", () => {
    const messages: TestMessage[] = [
      message("human-source", "Aurora launch assumptions from the supplied material.", { role: "user" }),
      message("assistant-output", "Aurora launch assumptions comparison and proposed analysis.", {
        role: "assistant",
      }),
      message("noise", "Unrelated latest context", { role: "user" }),
    ];

    const selected = selectTopicAwareChatWindow(messages, "Compare Aurora launch assumptions", 1);

    expect(selected.map(({ messageId }) => messageId)).toEqual(["human-source"]);
  });

  it("keeps bundles with distinct direct parents even when their labels share a root", () => {
    const messages: TestMessage[] = [
      message("common-root", "General discussion thread"),
      message("old-source", "First supplied set of operating details", {
        parentMessageId: "common-root",
        rootMessageId: "common-root",
      }),
      message("old-label", "Aurora rollout assumptions", {
        parentMessageId: "old-source",
        rootMessageId: "common-root",
      }),
      message("new-source", "Second supplied set of operating details", {
        parentMessageId: "common-root",
        rootMessageId: "common-root",
      }),
      message("new-label", "Aurora rollout assumptions", {
        parentMessageId: "new-source",
        rootMessageId: "common-root",
      }),
      message("noise", "Latest unrelated context"),
    ];

    const selected = selectTopicAwareChatWindow(messages, "Compare Aurora rollout assumptions", 4);

    expect(selected.map(({ messageId }) => messageId)).toEqual([
      "old-source",
      "old-label",
      "new-source",
      "new-label",
    ]);
  });

  it("does not promote an assistant label by attaching it to unrelated human content", () => {
    const messages: TestMessage[] = [
      message("unrelated-human", "Supplied notes about a different subject", { role: "user" }),
      message("assistant-label", "Aurora rollout assumptions comparison", {
        parentMessageId: "unrelated-human",
        role: "assistant",
      }),
      message("relevant-human", "Aurora source material", { role: "user" }),
      message("noise", "Latest unrelated context", { role: "user" }),
    ];

    const selected = selectTopicAwareChatWindow(messages, "Compare Aurora rollout assumptions", 1);

    expect(selected.map(({ messageId }) => messageId)).toEqual(["relevant-human"]);
  });

  it("keeps a single linked source before its label within a two-slot limit", () => {
    const messages = [
      message("source", "Detailed supplied material without the conversational topic label."),
      message("label", "Aurora launch notes", { parentMessageId: "source" }),
      message("noise", "Latest unrelated context"),
    ];

    const selected = selectTopicAwareChatWindow(messages, "Review Aurora launch notes", 2);

    expect(selected.map(({ messageId }) => messageId)).toEqual(["source", "label"]);
  });

  it("uses the linked source alone when the limit cannot fit its label", () => {
    const messages = [
      message("source", "Detailed supplied material without the conversational topic label."),
      message("label", "Aurora launch notes", { parentMessageId: "source" }),
      message("noise", "Latest unrelated context"),
    ];

    const selected = selectTopicAwareChatWindow(messages, "Review Aurora launch notes", 1);

    expect(selected.map(({ messageId }) => messageId)).toEqual(["source"]);
  });

  it("does not reserve a literal echo of the current question", () => {
    const messages = [
      message("echo", "speaker: Compare Aurora launch notes"),
      message("noise", "Latest unrelated context"),
    ];

    const selected = selectTopicAwareChatWindow(messages, "Compare Aurora launch notes", 1);

    expect(selected.map(({ messageId }) => messageId)).toEqual(["noise"]);
  });

  it("falls back to the latest context when the question has no topic terms", () => {
    const messages = [
      message("old", "Older context"),
      message("middle", "Middle context"),
      message("latest", "Latest context"),
    ];

    const selected = selectTopicAwareChatWindow(messages, "What about this?", 2);

    expect(selected.map(({ messageId }) => messageId)).toEqual(["middle", "latest"]);
  });

  it("returns no messages for a non-positive limit and all messages for a sufficient limit", () => {
    const messages = [message("old", "Older context"), message("latest", "Latest context")];

    expect(selectTopicAwareChatWindow(messages, "Aurora", 0)).toEqual([]);
    expect(selectTopicAwareChatWindow(messages, "Aurora", 2)).toEqual(messages);
  });
});

function message(
  messageId: string,
  text: string,
  metadata: Omit<Partial<TestMessage>, "messageId" | "text"> = {},
): TestMessage {
  return { messageId, text, role: "user", ...metadata };
}
