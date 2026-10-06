import { expect, test, vi } from "vitest";
import * as pdModels from "../src/proactive-discussion/model.js";
import * as clients from "../src/model/openai-compatible-chat-completions-client.js";
import { createProactiveDiscussionRuntime } from "../src/runtime/proactive-discussion-runtime.js";
import type { RuntimeController } from "../src/admin/runtime-controller.js";
import type { createPostgresPool } from "../src/database/postgres.js";
import { PD_PILOT_CHAT } from "../src/proactive-discussion/contracts.js";
import { readModelProviderConfig } from "../src/config/env.js";

vi.mock("../src/runtime/answer-draft-runtime.js", () => ({ resolveRuntimeEmbedding: async () => ({ profile: { id: "profile" }, embedder: {} }) }));
vi.mock("../src/proactive-discussion/postgres-repository.js", () => ({ createPostgresProactiveDiscussionRepository: () => ({
  getStatus: async () => ({ pending: 0, failed: 0, deadLetter: 0, unknown: 0, lastSuccessAt: null }),
}) }));

test.each([undefined, "legacy", "source-plan"])("default resources pass mode %s without changing the configured model or calling providers", async mode => {
  const model = vi.spyOn(pdModels, "createPdModel");
  const client = vi.spyOn(clients, "createOpenAICompatibleChatCompletionsClient");
  const fetch = vi.fn(async () => { throw new Error("network forbidden in offline test"); });
  const end = vi.fn(async () => undefined);
  const runtime = createProactiveDiscussionRuntime({
    env: { IRIS_PROACTIVE_DISCUSSION_ENABLED: "true", IRIS_PROACTIVE_DISCUSSION_GROUP_IDS: PD_PILOT_CHAT,
      ...(mode === undefined ? {} : { IRIS_PROACTIVE_DISCUSSION_OPINION_MODE: mode }),
      DATABASE_URL: "postgres://test:test@localhost/test", FEISHU_APP_ID: "test-app", FEISHU_APP_SECRET: "test-secret",
      IRIS_FEISHU_BOT_OPEN_ID: "ou_testbot", IRIS_MODEL_PROVIDER: "openai-compatible", IRIS_MODEL_BASE_URL: "https://example.invalid/v1",
      IRIS_MODEL_API_KEY: "offline-test", IRIS_MODEL_NAME: "unchanged-local-model" },
    runtimeController: {} as RuntimeController,
    dependencies: { createPostgresPool: () => ({ end } as unknown as ReturnType<typeof createPostgresPool>), fetch },
  });
  try {
    await runtime.start();
    expect(await runtime.getStatus()).toMatchObject({ running: true, ok: true });
    expect(model).toHaveBeenCalledOnce();
    const { client: wrappedClient, ...options } = model.mock.calls[0]![0];
    expect(wrappedClient.complete).toBeTypeOf("function");
    expect(options).toEqual(mode === "source-plan" ? { canonicalOpinion: true, sourceBoundIdentity: true, opinionPlan: true } : {});
    expect(client.mock.calls[0]![0].config.model).toBe("unchanged-local-model");
    expect(fetch).not.toHaveBeenCalled();
  } finally { await runtime.close(); vi.restoreAllMocks(); }
});

const isolatedEnv = {
  IRIS_PROACTIVE_DISCUSSION_ENABLED: "true", IRIS_PROACTIVE_DISCUSSION_GROUP_IDS: PD_PILOT_CHAT,
  IRIS_PROACTIVE_DISCUSSION_OPINION_MODE: "source-plan", IRIS_PROACTIVE_DISCUSSION_MODEL_SOURCE: "dedicated",
  IRIS_PROACTIVE_DISCUSSION_MODEL_PROVIDER: "openai-compatible",
  IRIS_PROACTIVE_DISCUSSION_MODEL_BASE_URL: "https://pd.example.invalid/v1",
  IRIS_PROACTIVE_DISCUSSION_MODEL_API_KEY: "pd-test-key", IRIS_PROACTIVE_DISCUSSION_MODEL_NAME: "pd-test-model",
  IRIS_PROACTIVE_DISCUSSION_MODEL_TIMEOUT_MS: "60000", IRIS_PROACTIVE_DISCUSSION_MODEL_STRUCTURED_OUTPUT_MODE: "json_object",
  IRIS_PROACTIVE_DISCUSSION_MODEL_MAX_TOKENS: "4096", IRIS_PROACTIVE_DISCUSSION_MODEL_ENABLE_THINKING: "false",
  IRIS_MODEL_PROVIDER: "openai-compatible", IRIS_MODEL_BASE_URL: "https://qa.example.invalid/v1",
  IRIS_MODEL_API_KEY: "qa-test-key", IRIS_MODEL_NAME: "qa-test-model", IRIS_MODEL_TIMEOUT_MS: "1000",
  DATABASE_URL: "postgres://test:test@localhost/test", FEISHU_APP_ID: "test-app", FEISHU_APP_SECRET: "test-secret",
  IRIS_FEISHU_BOT_OPEN_ID: "ou_testbot",
};

test("actual PD client uses only dedicated transport while ordinary QA keeps its existing request", async () => {
  const model = vi.spyOn(pdModels, "createPdModel");
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
      { headers: { "content-type": "application/json" } });
  };
  const env = Object.freeze({ ...isolatedEnv });
  const runtime = createProactiveDiscussionRuntime({ env, runtimeController: {} as RuntimeController,
    dependencies: { createPostgresPool: () => ({ end: async () => undefined } as unknown as ReturnType<typeof createPostgresPool>), fetch } });
  try {
    await runtime.start();
    expect(await runtime.getStatus()).toMatchObject({ running: true, ok: true });
    expect(requests).toHaveLength(0);
    const messages = [{ role: "user" as const, content: "synthetic transport check" }];
    const responseFormat = { type: "json_schema" as const, json_schema: { name: "transport_check", strict: true as const,
      schema: { type: "object", properties: {}, required: [], additionalProperties: false } } };
    await model.mock.calls[0]![0].client.complete(messages, { responseFormat });
    expect(requests[0]!.url).toBe("https://pd.example.invalid/v1/chat/completions");
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe("Bearer pd-test-key");
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({ model: "pd-test-model",
      response_format: { type: "json_object" }, max_tokens: 4096, enable_thinking: false });
    expect(String(requests[0]!.init.body)).not.toContain("qa-test");

    const qa = clients.createOpenAICompatibleChatCompletionsClient({ config: readModelProviderConfig(env)!, fetch });
    await qa.complete(messages, { responseFormat });
    expect(requests[1]!.url).toBe("https://qa.example.invalid/v1/chat/completions");
    expect(new Headers(requests[1]!.init.headers).get("authorization")).toBe("Bearer qa-test-key");
    expect(requests[1]!.init.body).toBe(JSON.stringify({ model: "qa-test-model", messages, response_format: responseFormat }));
  } finally { await runtime.close(); vi.restoreAllMocks(); }
});

test.each(["", "unknown"])("dedicated configuration failure (%s) stops PD before database or HTTP without QA fallback", async provider => {
  const createPool = vi.fn(() => { throw new Error("database must not be created"); });
  const fetch = vi.fn(async () => { throw new Error("HTTP must not be called"); });
  const runtime = createProactiveDiscussionRuntime({ env: { ...isolatedEnv, IRIS_PROACTIVE_DISCUSSION_MODEL_PROVIDER: provider },
    runtimeController: {} as RuntimeController, dependencies: { createPostgresPool: createPool, fetch } });
  try {
    await runtime.start();
    expect(await runtime.getStatus()).toMatchObject({ enabled: true, running: false, ok: false });
    expect(createPool).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

test("disabled PD needs no dedicated configuration or resources", async () => {
  const createPool = vi.fn(() => { throw new Error("database must not be created"); });
  const fetch = vi.fn(async () => { throw new Error("HTTP must not be called"); });
  const runtime = createProactiveDiscussionRuntime({ env: { IRIS_PROACTIVE_DISCUSSION_ENABLED: "false",
    IRIS_PROACTIVE_DISCUSSION_MODEL_SOURCE: "dedicated" }, dependencies: { createPostgresPool: createPool, fetch } });
  try {
    await runtime.start();
    expect(await runtime.getStatus()).toMatchObject({ enabled: false, running: false, ok: true });
    expect(createPool).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});
