import { describe, expect, it } from "vitest";

import type { AnswerDraftInput } from "../src/agent/answer-draft-orchestrator.js";
import type { Queryable } from "../src/documents/document-fragment-repository.js";
import type { FeishuChatHistoryMessage } from "../src/feishu/feishu-chat-history-reader.js";
import type { EvidencePlanningInput } from "../src/model/openai-compatible-evidence-planner.js";
import {
  createAnswerDraftRuntime,
  type AnswerDraftRuntimeDependencies,
} from "../src/runtime/answer-draft-runtime.js";

describe("answer drafts using fresh current-group history", () => {
  it("keeps a questionnaire's linked original beyond 50 newer messages in bounded planner evidence", async () => {
    const introduction = "使用方法：12个主问题，追问按回答选择。用户体验访谈需要了解使用频率和主要困难。";
    const original = introduction + "访谈追问：上一次使用产品遇到了哪些困难？请描述具体经历。".repeat(100);
    const harness = createHarness({ history: linkedQuestionnaireHistory(original) });

    const result = await harness.generate({ question: "刚才发的问卷讲了什么？" });

    const evidence = harness.planningInputs[0]!.evidence;
    expect(evidence.some(({ text }) => text.startsWith(`ou_author: ${introduction}`))).toBe(true);
    expect(evidence.map(({ text }) => text)).toContain("ou_author: 这是问卷");
    expect(evidence[1]?.source).toBe("live_chat:2; reply_to:C1");
    expect(JSON.stringify(evidence)).not.toContain("om_original");
    expect(evidence).toHaveLength(10);
    expect(result.promptContext.match(/<message /gu)).toHaveLength(20);
    expect(result.promptContext.indexOf(introduction)).toBeGreaterThan(-1);
    expect(result.promptContext.indexOf(introduction)).toBeLessThan(result.promptContext.indexOf("这是问卷"));
    expect(result.promptContext.indexOf("这是问卷")).toBeLessThan(result.promptContext.indexOf("随手记录-60"));
    expect(harness.historyRequests).toEqual([{ chatId: "oc_current", limit: 100 }]);
    expect(harness.planningInputs[0]?.liveChatMessages.every((message) => Object.keys(message).sort().join() === "speaker,text")).toBe(true);
  });

  it("preserves a linked label when a newer distinct message repeats the same text", async () => {
    const original = "使用方法：12个主问题，追问按回答选择。用户体验访谈的具体内容。";
    const history = linkedQuestionnaireHistory(original);
    history.unshift(historyMessage("om_repeated_label", "这是问卷", {
      sentAt: new Date("2026-09-07T10:01:00Z"),
    }));
    const harness = createHarness({ history });

    await harness.generate({ question: "刚才发的问卷讲了什么？" });

    const evidence = harness.planningInputs[0]!.evidence;
    expect(evidence.map(({ text }) => text)).toContain(`ou_author: ${original}`);
    expect(evidence.filter(({ text }) => text === "ou_author: 这是问卷")).toEqual([
      expect.objectContaining({ source: "live_chat:2; reply_to:C1" }),
      expect.objectContaining({ source: "live_chat:10" }),
    ]);
  });

  it("does not promote older sources through generic question words", async () => {
    const harness = createHarness({
      history: [
        ...unrelatedHistory(),
        historyMessage("om_old", "消息内容和资料情况都在这里。", { sentAt: new Date("2026-09-07T06:00:00Z") }),
      ],
    });

    const result = await harness.generate({ question: "最近消息有什么情况？" });

    expect(result.promptContext).not.toContain("消息内容和资料情况都在这里");
    expect(result.promptContext).toContain("随手记录-41");
    expect(result.promptContext).toContain("随手记录-60");
  });

  it.each(["deleted", "foreign"])("does not follow a questionnaire reply to a %s original", async (state) => {
    const original = "不可使用的用户体验访谈正文";
    const history = linkedQuestionnaireHistory(original);
    if (state === "foreign") history.at(-1)!.chatId = "oc_other";
    const harness = createHarness({
      history,
      tombstones: state === "deleted" ? ["om_original"] : [],
    });

    const result = await harness.generate({ question: "刚才发的问卷讲了什么？" });

    expect(harness.planningInputs[0]!.evidence.map(({ text }) => text)).toContain("ou_author: 这是问卷");
    expect(result.promptContext).not.toContain(original);
    expect(harness.planningInputs[0]!.evidence.some(({ text }) => text.includes(original))).toBe(false);
    expect(harness.planningInputs[0]!.evidence.every(({ source }) => !source.includes("reply_to:"))).toBe(true);
  });

  it("passes a recent questionnaire missed by callbacks into model evidence", async () => {
    const harness = createHarness({
      history: [historyMessage("om_questionnaire", "小叶你好！上次的新人问卷感觉怎么样呀")],
    });

    const result = await harness.generate();

    expect(harness.planningInputs[0]?.evidence).toEqual([
      {
        citationRef: "C1",
        source: "live_chat:1",
        text: "ou_author: 小叶你好！上次的新人问卷感觉怎么样呀",
      },
    ]);
    expect(result.promptContext).toContain("上次的新人问卷感觉怎么样呀");
    expect(harness.historyRequests).toEqual([{ chatId: "oc_current", limit: 100 }]);
  });

  it("uses the current authorized response without mixing in stale local history", async () => {
    const harness = createHarness({
      history: [historyMessage("om_current", "当前授权的问卷内容")],
      localText: "仅在旧缓存中的问卷内容",
    });

    const result = await harness.generate();

    expect(result.promptContext).toContain("当前授权的问卷内容");
    expect(result.promptContext).not.toContain("仅在旧缓存中的问卷内容");
    expect(harness.databaseQueries.every(({ sql }) => /^\s*SELECT\b/iu.test(sql))).toBe(true);
    expect(harness.databaseQueries.some(({ sql }) => sql.includes("FROM conversation_messages"))).toBe(false);
  });

  it("filters tombstones even when the deleted message has no local conversation row", async () => {
    const harness = createHarness({
      history: [
        historyMessage("om_deleted", "已删除的问卷正文"),
        historyMessage("om_available", "仍然可用的问卷说明"),
      ],
      tombstones: ["om_deleted"],
    });

    const result = await harness.generate();

    expect(result.promptContext).toContain("仍然可用的问卷说明");
    expect(result.promptContext).not.toContain("已删除的问卷正文");
    expect(harness.databaseQueries).toHaveLength(1);
    expect(harness.databaseQueries[0]?.sql).toContain("FROM conversation_message_deletion_tombstones");
    expect(harness.databaseQueries[0]?.sql).toMatch(/provider\s*=\s*'feishu'/u);
    expect(harness.databaseQueries[0]?.values).toEqual([["om_deleted", "om_available"]]);
  });

  it("excludes another group's returned messages before assembling model evidence", async () => {
    const harness = createHarness({
      history: [
        historyMessage("om_foreign", "其他群的私人问卷", { chatId: "oc_foreign" }),
        historyMessage("om_current", "当前群的问卷说明"),
      ],
    });

    const result = await harness.generate();

    expect(harness.planningInputs[0]?.evidence.map(({ text }) => text)).toEqual([
      "ou_author: 当前群的问卷说明",
    ]);
    expect(result.promptContext).not.toContain("其他群的私人问卷");
    expect(harness.databaseQueries[0]?.values).toEqual([["om_current"]]);
  });

  it("does not fall back to local messages when history authorization fails", async () => {
    const harness = createHarness({
      async readHistory() { throw new Error("history unavailable"); },
      localText: "当前已无权读取的缓存问卷",
    });

    await expect(harness.generate()).rejects.toThrow("history unavailable");
    expect(harness.planningInputs).toEqual([]);
    expect(harness.databaseQueries).toEqual([]);
  });

  it.each(["context", "processing"])("discards live messages when %s is disabled during the lookup", async (gate) => {
    let allowed = true;
    const harness = createHarness({
      canRead: () => gate === "context" ? allowed : true,
      canProcess: () => gate === "processing" ? allowed : true,
      async readHistory() {
        await Promise.resolve();
        allowed = false;
        return [historyMessage("om_disabled", "读取途中已停用的群消息")];
      },
    });

    const result = await harness.generate();

    expect(harness.historyRequests).toEqual([{ chatId: "oc_current", limit: 100 }]);
    expect(result.promptContext).not.toContain("读取途中已停用的群消息");
    expect(harness.planningInputs[0]?.evidence).toEqual([]);
  });

  it.each(["context", "processing"])("does not look up a group whose %s gate is disabled", async (gate) => {
    const harness = createHarness({
      canRead: () => gate !== "context",
      canProcess: () => gate !== "processing",
      history: [historyMessage("om_disabled", "停用群的消息")],
      localText: "停用群的旧消息",
    });

    const result = await harness.generate();

    expect(result.promptContext).not.toContain("停用群");
    expect(harness.historyRequests).toEqual([]);
    expect(harness.databaseQueries).toEqual([]);
  });

  it.each([
    { question: "你好" },
    { question: "只回复：ready" },
    { chatId: undefined },
    { liveChatLimit: 0 },
  ])("does not look up history for standalone or zero-history requests: %j", async (input) => {
    const harness = createHarness({ history: [historyMessage("om_unused", "不应读取的群消息")] });

    const result = await harness.generate(input);

    expect(result.promptContext).not.toContain("不应读取的群消息");
    expect(harness.historyRequests).toEqual([]);
    expect(harness.databaseQueries).toEqual([]);
  });

  it("preserves the 20-message budget and chronological prompt order", async () => {
    const harness = createHarness({
      history: Array.from({ length: 22 }, (_, index) => historyMessage(
        `om_${22 - index}`, `问卷说明-${String(22 - index).padStart(2, "0")}`,
        { sentAt: new Date(Date.UTC(2026, 8, 7, 8, 22 - index)) },
      )),
    });

    const result = await harness.generate({ liveChatLimit: 999 });

    expect(result.promptContext).not.toContain("问卷说明-01");
    expect(result.promptContext).not.toContain("问卷说明-02");
    expect(result.promptContext).toContain("问卷说明-03");
    expect(result.promptContext.indexOf("问卷说明-03")).toBeLessThan(result.promptContext.indexOf("问卷说明-22"));
    expect(harness.historyRequests).toEqual([{ chatId: "oc_current", limit: 100 }]);
    expect(harness.databaseQueries[0]?.values[0]).toHaveLength(22);
  });

  it("keeps local history when no Feishu credentials are configured", async () => {
    const harness = createHarness({ credentials: false, localText: "开发环境的本地问卷消息" });

    const result = await harness.generate();

    expect(result.promptContext).toContain("开发环境的本地问卷消息");
    expect(harness.historyRequests).toEqual([]);
  });

  it("lets the injected context provider replace the live source completely", async () => {
    const harness = createHarness({
      dependencies: {
        createLiveChatContextProvider: () => ({
          async loadRecentMessages() { return [{ speaker: "operator", text: "注入的测试上下文" }]; },
        }),
      },
    });

    const result = await harness.generate();

    expect(result.promptContext).toContain("注入的测试上下文");
    expect(harness.historyRequests).toEqual([]);
    expect(harness.databaseQueries).toEqual([]);
  });
});

function unrelatedHistory(): FeishuChatHistoryMessage[] {
  return Array.from({ length: 60 }, (_, index) => historyMessage(
    `om_noise_${60 - index}`,
    `随手记录-${String(60 - index).padStart(2, "0")}`,
    { sentAt: new Date(Date.UTC(2026, 8, 7, 8, 60 - index)) },
  ));
}

function linkedQuestionnaireHistory(original: string): FeishuChatHistoryMessage[] {
  return [
    historyMessage("om_question", "刚才发的问卷讲了什么？", { sentAt: new Date("2026-09-07T10:00:00Z") }),
    ...unrelatedHistory(),
    historyMessage("om_label", "这是问卷", {
      parentMessageId: "om_original",
      rootMessageId: "om_original",
      sentAt: new Date("2026-09-07T06:01:00Z"),
    }),
    historyMessage("om_original", original, { sentAt: new Date("2026-09-07T06:00:00Z") }),
  ];
}

function historyMessage(messageId: string, text: string, overrides: Partial<FeishuChatHistoryMessage> = {}): FeishuChatHistoryMessage {
  return {
    messageId,
    chatId: "oc_current",
    senderId: "ou_author",
    text,
    sentAt: new Date("2026-09-07T08:00:00.000Z"),
    ...overrides,
  };
}

function createHarness(options: {
  history?: FeishuChatHistoryMessage[];
  readHistory?: () => Promise<FeishuChatHistoryMessage[]>;
  localText?: string;
  tombstones?: string[];
  canRead?: () => boolean;
  canProcess?: () => boolean;
  credentials?: boolean;
  dependencies?: Partial<AnswerDraftRuntimeDependencies>;
} = {}) {
  const historyRequests: { chatId: string; limit: number }[] = [];
  const databaseQueries: { sql: string; values: unknown[] }[] = [];
  const planningInputs: EvidencePlanningInput[] = [];
  const queryable: Queryable = {
    async query<T>(sql: string, values: unknown[] = []) {
      databaseQueries.push({ sql, values });
      if (sql.includes("FROM conversation_message_deletion_tombstones")) {
        const ids = values[0] as string[];
        return {
          rows: (options.tombstones ?? [])
            .filter((id) => ids.includes(id))
            .map((id) => ({ provider_message_id: id })) as T[],
        };
      }
      if (sql.includes("FROM conversation_messages")) {
        return { rows: (options.localText === undefined ? [] : [{
          id: "feishu:om_local",
          provider: "feishu",
          provider_message_id: "om_local",
          chat_id: "oc_current",
          sender_id: "ou_local",
          sender_open_id: "ou_local",
          sender_union_id: null,
          sender_user_id: null,
          message_type: "text",
          text: options.localText,
          sent_at: new Date("2026-09-07T07:00:00.000Z"),
          raw_event_idempotency_key: "received-local",
          created_at: new Date("2026-09-07T07:00:01.000Z"),
          mentions: [],
        }]) as T[] };
      }
      throw new Error("Unexpected database query in history test");
    },
  };
  const runtime = createAnswerDraftRuntime({
    env: {
      IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
      IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
      DATABASE_URL: "postgres://test.invalid/iris",
      IRIS_MODEL_PROVIDER: "openai-compatible",
      IRIS_MODEL_BASE_URL: "https://model.invalid/v1",
      IRIS_MODEL_API_KEY: "test-key",
      IRIS_MODEL_NAME: "test-model",
      ...(options.credentials === false ? {} : {
        FEISHU_APP_ID: "test-app",
        FEISHU_APP_SECRET: "test-secret",
      }),
    },
    runtimeController: {
      canReadDocuments: () => false,
      canRetrieveKnowledgeBase: () => false,
      canReadGroupContext: options.canRead ?? (() => true),
      canProcessGroupMessage: options.canProcess ?? (() => true),
    },
    dependencies: {
      createPostgresPool: () => ({ ...queryable, async end() {} }),
      createEmbeddingProfileRepository: () => ({
        async getStaticDevelopmentProfile() {
          return {
            id: "static-dev-6d", provider: "static-dev", model: "static-dev-6d",
            dimensions: 6, displayName: "Static development", status: "active",
            createdAt: new Date("2026-09-07T00:00:00Z"),
          };
        },
        async findOrCreateProfile() { throw new Error("Unexpected profile creation"); },
        async getProfileById() { throw new Error("Unexpected profile lookup"); },
      }),
      createFeishuTenantAccessTokenProvider: () => ({
        async getTenantAccessToken() { return "tenant-test-token"; },
      }),
      createFeishuChatHistoryReader: () => ({
        async listRecentMessages(input: { chatId: string; limit: number }) {
          historyRequests.push(input);
          return options.readHistory?.() ?? options.history ?? [];
        },
      }),
      createChatCompletionsClient: () => ({
        async complete(messages) {
          const input = JSON.parse(messages.at(-1)!.content);
          if (input.plan !== undefined) {
            return JSON.stringify({
              answerText: "已根据当前群消息整理。",
              evidenceState: input.plan.evidenceState,
              confidence: input.plan.confidence,
            });
          }
          planningInputs.push(input);
          const evidence = input.evidence[0];
          return JSON.stringify({
            taskMode: "company_fact",
            evidenceState: evidence === undefined ? "none" : "explicit",
            premises: evidence === undefined ? [] : [{ citationRef: evidence.citationRef, statement: evidence.text.slice(0, 1200) }],
            proposedAnswer: evidence === undefined ? null : evidence.text,
            missingInformation: evidence === undefined ? ["当前群相关消息"] : [],
            confidence: evidence === undefined ? "low" : "high",
          });
        },
      }),
      createModelProvider: () => ({
        async generateAnswerDraft() { return { answerText: "你好" }; },
      }),
      createRequestContextRouter: () => ({
        async classify() { return "contextual"; },
      }),
      ...options.dependencies,
    },
  })!;
  return {
    runtime,
    planningInputs,
    historyRequests,
    databaseQueries,
    generate(input: Partial<AnswerDraftInput> = {}) {
      return runtime.answerDraftOrchestrator.generateDraft({
        question: "小叶的新人问卷是什么情况？",
        chatId: "oc_current",
        liveChatMessages: [],
        fragmentLimit: 0,
        ...input,
      });
    },
  };
}
