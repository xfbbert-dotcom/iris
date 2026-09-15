import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./proactive-discussion-eval.ts", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
// Fail at module resolution if the CLI gains any Feishu transport dependency.
const guard = `import { register } from 'node:module'; register(${JSON.stringify("data:text/javascript," + encodeURIComponent("export async function resolve(s,c,n){if(/feishu-(chat-history-reader|message-replier|tenant-access-token-provider)/.test(s))throw Error('forbidden sending dependency');return n(s,c)}"))}, import.meta.url);`;
function run(args, env = {}, entry = script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(guard), "--import", "tsx", ...(entry === script ? [script, ...args] : ["--input-type=module", "--eval", entry])], {
      cwd: root, env: { ...process.env, IRIS_MODEL_PROVIDER: "", IRIS_MODEL_API_KEY: "", IRIS_MODEL_BASE_URL: "", IRIS_MODEL_NAME: "", ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
async function mockProvider(operation, fail = false) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body), receivedAt: performance.now() });
    res.setHeader("Content-Type", "application/json");
    if (fail) { res.statusCode = 401; res.end(JSON.stringify({ error: "synthetic-secret" })); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "skip", reason: "no_work_value", issueRef: null,
      evidenceRefs: [], observation: "", reasoning: "", suggestion: "", uncertainty: "fact", materialChange: { kind: "none", explanation: "", evidenceRefs: [] } }) } }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await operation({ IRIS_MODEL_PROVIDER: "openai-compatible", IRIS_MODEL_API_KEY: "synthetic-secret", IRIS_MODEL_NAME: "synthetic",
    IRIS_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, IRIS_MODEL_TIMEOUT_MS: "1000" }, requests); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("CLI default two rounds actually call all synthetic cases and report decision failures with nonzero exit", async () => {
  await mockProvider(async (env, requests) => {
    const result = await run([], env); const report = JSON.parse(result.stdout);
    assert.equal(result.code, 1); assert.equal(report.rounds, 2); assert.equal(report.requestIntervalMs, 0); assert.equal(report.includeSyntheticTrace, false); assert.equal(report.results.length, 30);
    assert.equal(Object.hasOwn(report, "syntheticTrace"), false);
    assert.equal(requests.length, 30); assert.ok(requests.every(r => r.url === "/v1/chat/completions"));
    assert.deepEqual(report.results.map(r => r.round), [...Array(15).fill(1), ...Array(15).fill(2)]);
    assert.ok(report.results.every(r => r.assessment.decision === "skip" && r.draft === null));
    assert.ok(report.decisionMismatches.includes("arithmetic:1"));
    assert.equal(report.manualReview, "pending"); assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
  });
});
test("import guard does not read config, call a model or write output", async () => {
  await mockProvider(async (env, requests) => {
    const result = await run([], env, `await import(${JSON.stringify(new URL("./proactive-discussion-eval.ts", import.meta.url).href)});`);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, ""); assert.equal(requests.length, 0);
  });
});
test("CLI rejects unavailable/invalid configuration and bad rounds without printing values", async () => {
  for (const args of [[], ["--rounds", "0"], ["--rounds", "2junk"], ["--unknown"],
    ["--request-interval-ms"], ["--request-interval-ms", "-1"], ["--request-interval-ms", "60001"],
    ["--request-interval-ms", "1junk"], ["--request-interval-ms", "1", "--request-interval-ms", "2"],
    ["--include-synthetic-trace"], ["--include-synthetic-trace", "yes"],
    ["--include-synthetic-trace", "true", "--include-synthetic-trace", "false"]]) {
    const result = await run(args);
    assert.equal(result.code, 2); assert.ok(!JSON.stringify(result).includes("sensitive-invalid-provider"));
  }
  const invalid = await run([], { IRIS_MODEL_PROVIDER: "sensitive-invalid-provider" });
  assert.equal(invalid.code, 2); assert.ok(!JSON.stringify(invalid).includes("sensitive-invalid-provider"));
});
test("CLI enables bounded synthetic trace explicitly without adding model calls", async () => {
  await mockProvider(async (env, requests) => {
    const result = await run(["--include-synthetic-trace", "true", "--rounds", "2"], env);
    const report = JSON.parse(result.stdout);
    assert.equal(result.code, 1); assert.equal(report.includeSyntheticTrace, true); assert.equal(requests.length, 30);
    assert.equal(report.results.length, 30); assert.equal(report.syntheticTrace.complete, true);
    assert.equal(report.syntheticTrace.validationBasis, "diagnostic_replay_not_runtime_error_detail");
    assert.equal(report.syntheticTrace.records.length, 30);
    assert.deepEqual(report.syntheticTrace.records.map(record => `${record.caseId}:${record.round}:${record.attempt}`), [
      ...report.cases.map(entry => `${entry.id}:1:1`), ...report.cases.map(entry => `${entry.id}:2:1`),
    ]);
    assert.ok(report.syntheticTrace.records.every(record => record.stage === "assessment"));
    assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
  });
});
test("CLI rejects an invalid request interval before making a provider request", async () => {
  await mockProvider(async (env, requests) => {
    const result = await run(["--request-interval-ms", "60001"], env);
    assert.equal(result.code, 2); assert.equal(requests.length, 0);
  });
});
test("CLI applies the requested low-millisecond interval to actual HTTP requests and reports it", async () => {
  await mockProvider(async (env, requests) => {
    const result = await run(["--request-interval-ms", "12", "--rounds", "1"], env);
    const report = JSON.parse(result.stdout);
    assert.equal(result.code, 1); assert.equal(report.rounds, 1); assert.equal(report.requestIntervalMs, 12);
    assert.equal(requests.length, 15);
    assert.ok(requests.at(-1).receivedAt - requests[0].receivedAt >= 120,
      `expected paced requests, observed ${requests.at(-1).receivedAt - requests[0].receivedAt}ms`);
  });
});
test("provider failures preserve both complete rounds and a failed exit without leaking upstream bodies", async () => {
  await mockProvider(async (env, requests) => {
    const result = await run(["--rounds", "2", "--include-synthetic-trace", "true"], env); const report = JSON.parse(result.stdout);
    assert.equal(result.code, 1); assert.equal(requests.length, 30); assert.equal(report.results.length, 30);
    assert.ok(report.results.every(r => r.error === "assessment_failed" && r.assessment === null));
    assert.deepEqual(report.decisionMismatches, []);
    assert.ok(report.results.every(r => r.diagnostic?.phase === "assessment"
      && r.diagnostic?.category === "http" && r.diagnostic?.statusCode === 401));
    assert.deepEqual(report.syntheticTrace.records, []);
    assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
  }, true);
});
