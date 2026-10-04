import { expect, test, vi } from "vitest";
import * as pdModels from "../src/proactive-discussion/model.js";
import * as clients from "../src/model/openai-compatible-chat-completions-client.js";
import { createProactiveDiscussionRuntime } from "../src/runtime/proactive-discussion-runtime.js";
import type { RuntimeController } from "../src/admin/runtime-controller.js";
import type { createPostgresPool } from "../src/database/postgres.js";
import { PD_PILOT_CHAT } from "../src/proactive-discussion/contracts.js";

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
