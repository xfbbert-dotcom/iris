// No provider network or production configuration is used by this wiring smoke.
// Run from /app in the existing Core container after copying this file and the
// adjacent free-gate module to a writable directory. Optional --core-dist points
// at the existing compiled application; this script never builds or starts it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFreeGate, FREE_GATE_TIMING } from './proactive-discussion-free-gate.mjs';

const key = 'iris-wiring-smoke-placeholder-not-a-real-key';
const upstream = 'https://wiring-smoke.invalid/v1/chat/completions';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
const messages = [
  {role: 'system', content: 'Local wiring check. Return a JSON object.'},
  {role: 'user', content: 'Return {"smoke":true}.'},
];
const responseFormat = {type: 'json_schema', json_schema: {
  name: 'WiringSmoke', strict: true,
  schema: {type: 'object', additionalProperties: false,
    properties: {smoke: {type: 'boolean'}}, required: ['smoke']},
}};

async function pendingIn(gate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const name = (await readdir(gate.sessionDir)).find(file => file.startsWith('pending-'));
    if (name) return JSON.parse(await readFile(join(gate.sessionDir, name), 'utf8'));
    await pause(10);
  }
  throw Error('smoke pending missing');
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--core-dist'), 'unsupported arguments');
  const dist = resolve(args[1] ?? 'apps/core/dist');
  const clientPath = join(dist, 'model/openai-compatible-chat-completions-client.js');
  const configPath = join(dist, 'config/env.js');
  const gatePath = fileURLToPath(new URL('./proactive-discussion-free-gate.mjs', import.meta.url));
  const originalFetch = globalThis.fetch;
  const allowedUrls = new Set();
  // The real HTTP transport can reach only the two ephemeral loopback servers.
  // Gate upstream is an injected function and can never reach this transport.
  globalThis.fetch = async (url, init) => {
    assert.ok(typeof url === 'string' && allowedUrls.has(url), 'non-smoke network rejected');
    return originalFetch(url, {...init, redirect: 'error'});
  };
  let parent;
  try {
    const {createOpenAICompatibleChatCompletionsClient} = await import(pathToFileURL(clientPath).href);
    const {readProactiveDiscussionModelProviderConfig} = await import(pathToFileURL(configPath).href);
    parent = await mkdtemp(join(tmpdir(), 'iris-wiring-smoke-'));
    const checks = [];
    let loopbackHttp = 0, fakeUpstreamCalls = 0;
    for (const permit of [false, true]) {
      const outbound = [], forwarded = [], timeouts = [];
      const gate = createFreeGate({
        sessionParent: parent, apiKey: key, upstreamUrl: upstream,
        // Short local-only limits; this does not start a real pilot window.
        permitWaitMs: permit ? 4000 : 200, windowMs: 10000,
        fetchImpl: async (url, init) => {
          assert.equal(url, upstream);
          assert.equal(init.headers.authorization, `Bearer ${key}`);
          forwarded.push(Buffer.from(init.body));
          fakeUpstreamCalls++;
          return new Response(JSON.stringify({model: 'qwen3.8-max',
            choices: [{finish_reason: 'stop', message: {role: 'assistant', content: '{"smoke":true}'}}],
            usage: {total_tokens: 1}}), {status: 200, headers: {'content-type': 'application/json'}});
        },
      });
      try {
        await gate.start();
        const baseUrl = `http://127.0.0.1:${gate.server.address().port}/v1`;
        const endpoint = `${baseUrl}/chat/completions`;
        allowedUrls.add(endpoint);
        // Never spread process.env: no actual key, URL, or business material is read.
        const config = readProactiveDiscussionModelProviderConfig({
          IRIS_MODEL_PROVIDER: 'openai-compatible',
          IRIS_MODEL_BASE_URL: 'https://unused-shared.invalid/v1',
          IRIS_MODEL_API_KEY: 'unused-shared-placeholder', IRIS_MODEL_NAME: 'unused-shared-model',
          IRIS_PROACTIVE_DISCUSSION_MODEL_SOURCE: 'dedicated',
          IRIS_PROACTIVE_DISCUSSION_MODEL_PROVIDER: 'openai-compatible',
          IRIS_PROACTIVE_DISCUSSION_MODEL_BASE_URL: baseUrl,
          IRIS_PROACTIVE_DISCUSSION_MODEL_API_KEY: key,
          IRIS_PROACTIVE_DISCUSSION_MODEL_NAME: 'qwen3.8-max',
          IRIS_PROACTIVE_DISCUSSION_MODEL_TIMEOUT_MS: String(FREE_GATE_TIMING.clientTimeoutMs),
          IRIS_PROACTIVE_DISCUSSION_MODEL_STRUCTURED_OUTPUT_MODE: 'json_object',
          IRIS_PROACTIVE_DISCUSSION_MODEL_MAX_TOKENS: '4096',
          IRIS_PROACTIVE_DISCUSSION_MODEL_ENABLE_THINKING: 'false',
        });
        assert.deepEqual(config, {provider: 'openai-compatible', baseUrl, apiKey: key,
          model: 'qwen3.8-max', timeoutMs: 120000, structuredOutputMode: 'json_object',
          maxTokens: 4096, enableThinking: false});
        const client = createOpenAICompatibleChatCompletionsClient({config,
          fetch: async (url, init) => {
            assert.equal(url, endpoint);
            assert.equal(init.headers.authorization, `Bearer ${key}`);
            outbound.push(Buffer.from(init.body));
            loopbackHttp++;
            return globalThis.fetch(url, init);
          },
          scheduleTimeout: (callback, ms) => {
            timeouts.push(ms);
            return setTimeout(callback, ms);
          },
        });
        // Attach rejection immediately so a failed smoke cannot become an
        // unhandled rejection while waiting for the pending record.
        const completed = client.complete(messages, {responseFormat}).then(
          content => ({content}), error => ({error}));
        const pending = await pendingIn(gate);
        assert.equal(pending.model, 'qwen3.8-max');
        assert.equal(pending.requestHash, sha(outbound[0]));
        if (permit) {
          const observedAt = new Date().toISOString();
          assert.ok(Date.parse(observedAt) >= Date.parse(pending.at));
          const body = {requestId: pending.requestId, requestHash: pending.requestHash,
            model: 'qwen3.8-max', remainingTokens: 200000, observedAt,
            expiresAt: new Date(Date.now() + 3000).toISOString(), freeExhaustionStop: true};
          // A synthetic permit is valid only in this injected-fake smoke session.
          const target = join(gate.sessionDir, `permit-${pending.requestId}.json`);
          await writeFile(`${target}.tmp`, JSON.stringify(body), {flag: 'wx', mode: 0o600});
          await rename(`${target}.tmp`, target);
        }
        const result = await completed;
        assert.equal(outbound.length, 1, 'the client must not retry 422 or a success');
        assert.equal(timeouts.length, 1);
        assert.ok(timeouts[0] > 119000 && timeouts[0] <= 120000);
        const wire = JSON.parse(outbound[0].toString('utf8'));
        assert.deepEqual(Object.keys(wire).sort(), ['enable_thinking', 'max_tokens', 'messages', 'model', 'response_format']);
        assert.equal(wire.model, 'qwen3.8-max');
        assert.deepEqual(wire.response_format, {type: 'json_object'});
        assert.equal(wire.max_tokens, 4096);
        assert.equal(wire.enable_thinking, false);
        assert.equal(wire.messages.length, 2);
        assert.deepEqual(wire.messages[1], messages[1]);
        assert.ok(wire.messages[0].content.startsWith(messages[0].content));
        assert.ok(wire.messages[0].content.endsWith(JSON.stringify(responseFormat.json_schema.schema)));
        if (permit) {
          assert.equal(result.error, undefined);
          assert.equal(result.content, '{"smoke":true}');
          assert.equal(forwarded.length, 1);
          assert.deepEqual(forwarded[0], outbound[0], 'gate must preserve complete wire bytes');
        } else {
          assert.equal(result.error?.statusCode, 422);
          assert.equal(forwarded.length, 0);
          assert.equal(JSON.parse(await readFile(join(gate.sessionDir, 'stopped.json'), 'utf8')).uncertain, false);
        }
        checks.push({case: permit ? 'fresh-mock-permit-identical-wire' : 'missing-permit-no-retry', passed: true});
        allowedUrls.delete(endpoint);
      } finally {await gate.close();}
    }
    assert.equal(loopbackHttp, 2);
    assert.equal(fakeUpstreamCalls, 1);
    console.log(JSON.stringify({kind: 'compiled-core-free-gate-wiring-smoke', checks,
      loopbackHttp, fakeUpstreamCalls, providerHttp: 0, readsProductionConfig: false,
      timing: FREE_GATE_TIMING,
      semanticAcceptance: false, feishuAcceptance: false,
      compiledClientSha256: sha(await readFile(clientPath)), compiledConfigSha256: sha(await readFile(configPath)),
      gateSha256: sha(await readFile(gatePath))}));
  } finally {
    globalThis.fetch = originalFetch;
    if (parent) {
      const target = resolve(parent), root = resolve(tmpdir());
      assert.ok(target.startsWith(root + sep) && basename(target).startsWith('iris-wiring-smoke-'));
      await rm(target, {recursive: true, force: true});
    }
  }
}

main().catch(() => {console.error('compiled-core free-gate wiring smoke failed'); process.exitCode = 1;});
