// Offline smoke for the exact committed Core runtime image. Pipe through stdin to
// docker run --rm -i --network none --read-only --entrypoint node IMAGE --input-type=module.
// Uses synthetic configuration and an injected fetch; never starts the application server.
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { readModelProviderConfig, readProactiveDiscussionModelProviderConfig } from "/app/apps/core/dist/config/env.js";
import { createOpenAICompatibleChatCompletionsClient } from "/app/apps/core/dist/model/openai-compatible-chat-completions-client.js";
import { parsePdOpinionMode, pdOpinionModeOptions } from "/app/apps/core/dist/proactive-discussion/opinion-mode.js";
import { createProactiveDiscussionRuntime } from "/app/apps/core/dist/runtime/proactive-discussion-runtime.js";

const require = createRequire("/app/package.json");
assert.equal(require("fastify/package.json").version, "5.12.5");
assert.equal(require("fast-uri/package.json").version, "3.1.8");
const excludedDevelopmentPackages = ["@vitest/mocker", "vite/node_modules/esbuild", "nanoid", "postcss",
  "source-map-js", "tinypool", "vite", "vite-node", "vitest"];
for (const name of excludedDevelopmentPackages) await assert.rejects(access(`/app/node_modules/${name}/package.json`));
const migrations = ["0059_proactive_discussion.sql", "0060_proactive_discussion_prose_sources.sql"];
for (const name of migrations) await access(`/app/apps/core/migrations/${name}`);
assert.deepEqual(pdOpinionModeOptions(parsePdOpinionMode("source-plan")), {
  canonicalOpinion: true, sourceBoundIdentity: true, opinionPlan: true,
});
const env = Object.freeze({
  IRIS_MODEL_PROVIDER: "openai-compatible", IRIS_MODEL_BASE_URL: "https://qa.invalid/v1",
  IRIS_MODEL_API_KEY: "synthetic-qa", IRIS_MODEL_NAME: "synthetic-qa-model",
  IRIS_PROACTIVE_DISCUSSION_MODEL_SOURCE: "dedicated",
  IRIS_PROACTIVE_DISCUSSION_MODEL_PROVIDER: "openai-compatible",
  IRIS_PROACTIVE_DISCUSSION_MODEL_BASE_URL: "https://pd.invalid/v1",
  IRIS_PROACTIVE_DISCUSSION_MODEL_API_KEY: "synthetic-pd", IRIS_PROACTIVE_DISCUSSION_MODEL_NAME: "synthetic-pd-model",
  IRIS_PROACTIVE_DISCUSSION_MODEL_STRUCTURED_OUTPUT_MODE: "json_object",
  IRIS_PROACTIVE_DISCUSSION_MODEL_TIMEOUT_MS: "60000", IRIS_PROACTIVE_DISCUSSION_MODEL_MAX_TOKENS: "4096",
  IRIS_PROACTIVE_DISCUSSION_MODEL_ENABLE_THINKING: "false",
});
const requests = [];
const fetch = async (url, init) => {
  requests.push({ url, init });
  return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
    headers: { "content-type": "application/json" },
  });
};
const messages = [{ role: "user", content: "offline synthetic check" }];
const responseFormat = { type: "json_schema", json_schema: { name: "offline_check", strict: true,
  schema: { type: "object", properties: {}, required: [], additionalProperties: false } } };
await createOpenAICompatibleChatCompletionsClient({ config: readProactiveDiscussionModelProviderConfig(env), fetch })
  .complete(messages, { responseFormat });
assert.equal(requests[0].url, "https://pd.invalid/v1/chat/completions");
assert.equal(new Headers(requests[0].init.headers).get("authorization"), "Bearer synthetic-pd");
const pdBody = JSON.parse(requests[0].init.body);
assert.equal(pdBody.model, "synthetic-pd-model");
assert.deepEqual(pdBody.response_format, { type: "json_object" });
assert.equal(pdBody.max_tokens, 4096); assert.equal(pdBody.enable_thinking, false);
await createOpenAICompatibleChatCompletionsClient({ config: readModelProviderConfig(env), fetch })
  .complete(messages, { responseFormat });
assert.equal(requests[1].url, "https://qa.invalid/v1/chat/completions");
assert.equal(new Headers(requests[1].init.headers).get("authorization"), "Bearer synthetic-qa");
assert.equal(requests[1].init.body, JSON.stringify({ model: "synthetic-qa-model", messages, response_format: responseFormat }));
assert.throws(() => readProactiveDiscussionModelProviderConfig({ ...env, IRIS_PROACTIVE_DISCUSSION_MODEL_API_KEY: "" }));
const disabled = createProactiveDiscussionRuntime({ env: {
  IRIS_PROACTIVE_DISCUSSION_ENABLED: "false", IRIS_PROACTIVE_DISCUSSION_MODEL_SOURCE: "dedicated",
}, dependencies: { createPostgresPool() { throw Error("unexpected database"); }, fetch() { throw Error("unexpected network"); } } });
try {
  await disabled.start();
  assert.deepEqual(await disabled.getStatus(), { pending: 0, failed: 0, deadLetter: 0, unknown: 0,
    lastSuccessAt: null, enabled: false, running: false, ok: true });
} finally { await disabled.close(); }
console.log(JSON.stringify({ kind: "iris-core-offline-image-smoke", ok: true, fastify: "5.12.5", fastUri: "3.1.8",
  excludedDevelopmentPackages,
  migrationsPresent: migrations, sourcePlan: true, dedicatedTransport: true, ordinaryQaBodyUnchanged: true,
  missingDedicatedRejected: true, disabledRuntimeNoDependencies: true, simulatedCompletions: requests.length,
  realProviderRequests: 0, applicationServerStarted: false }));
