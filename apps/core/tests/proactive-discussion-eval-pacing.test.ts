import { expect, test, vi } from "vitest";

import { createOpenAICompatibleChatCompletionsClient } from "../src/model/openai-compatible-chat-completions-client.js";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { pdAssessment, pdContext } from "./fixtures/proactive-discussion.js";

const evalPath = "../../../scripts/pilot/proactive-discussion-eval.ts";

type PacedFetchFactory = (input: {
  fetch: typeof globalThis.fetch;
  requestIntervalMs: number;
  now: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal | null) => Promise<void>;
}) => typeof globalThis.fetch;

async function loadPacedFetchFactory(): Promise<PacedFetchFactory> {
  const evaluator = await import(evalPath) as unknown as Record<string, unknown>;
  expect(evaluator.createRequestPacedFetch).toBeTypeOf("function");
  return evaluator.createRequestPacedFetch as PacedFetchFactory;
}

test("paced fetch waits between actual attempts, including after a failed request, and preserves arguments", async () => {
  const createRequestPacedFetch = await loadPacedFetchFactory();
  let clock = 100;
  const starts: number[] = [];
  const firstInit = { method: "POST", body: "first" } satisfies RequestInit;
  const secondInit = { method: "POST", body: "second" } satisfies RequestInit;
  const requests: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const fetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    starts.push(clock);
    requests.push([request, init]);
    if (starts.length === 1) throw new TypeError("synthetic transport failure");
    return new Response("ok");
  }) as unknown as typeof globalThis.fetch;
  const sleeps: number[] = [];
  const pacedFetch = createRequestPacedFetch({ fetch, requestIntervalMs: 10, now: () => clock,
    sleep: async milliseconds => { sleeps.push(milliseconds); clock += milliseconds; } });

  await expect(pacedFetch("https://example.invalid/first", firstInit)).rejects.toThrow("synthetic transport failure");
  expect(sleeps).toEqual([]);
  clock += 3;
  await expect(pacedFetch("https://example.invalid/second", secondInit)).resolves.toBeInstanceOf(Response);

  expect(starts).toEqual([100, 110]);
  expect(sleeps).toEqual([7]);
  expect(requests).toEqual([
    ["https://example.invalid/first", firstInit],
    ["https://example.invalid/second", secondInit],
  ]);
});

test("paced fetch aborts an interval wait without sending or blocking the next request", async () => {
  const createRequestPacedFetch = await loadPacedFetchFactory();
  let clock = 0;
  const starts: number[] = [];
  const fetch = vi.fn(async () => { starts.push(clock); return new Response("ok"); }) as unknown as typeof globalThis.fetch;
  const pacedFetch = createRequestPacedFetch({ fetch, requestIntervalMs: 50, now: () => clock,
    sleep: (milliseconds, signal) => new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      void milliseconds;
      void resolve;
    }) });

  await pacedFetch("https://example.invalid/first");
  clock = 1;
  const controller = new AbortController();
  const waiting = pacedFetch("https://example.invalid/aborted", { signal: controller.signal });
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  expect(starts).toEqual([0]);

  clock = 50;
  await pacedFetch("https://example.invalid/next");
  expect(starts).toEqual([0, 50]);
});

test("default pacing sleep clears a long wait when the client abort signal fires", async () => {
  const createRequestPacedFetch = await loadPacedFetchFactory();
  let clock = 0;
  const fetch = vi.fn(async () => new Response("ok")) as unknown as typeof globalThis.fetch;
  const pacedFetch = createRequestPacedFetch({ fetch, requestIntervalMs: 60_000, now: () => clock });
  await pacedFetch("https://example.invalid/first");

  const controller = new AbortController();
  const waiting = pacedFetch("https://example.invalid/aborted", { signal: controller.signal });
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).toHaveBeenCalledTimes(1);

  clock = 60_000;
  await pacedFetch("https://example.invalid/next");
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("one paced client covers transport retry, assessment repair, draft and scope-review fetches", async () => {
  const evaluator = await import(evalPath) as unknown as {
    createRequestPacedFetch?: PacedFetchFactory;
    runProactiveDiscussionEval: (input: unknown) => Promise<Array<{ error: string | null; draft: { text: string } | null }>>;
  };
  expect(evaluator.createRequestPacedFetch).toBeTypeOf("function");
  if (!evaluator.createRequestPacedFetch) return;
  let clock = 0;
  const starts: number[] = [];
  const sleeps: number[] = [];
  const outputs = [
    new TypeError("synthetic transport failure"),
    "not-json",
    JSON.stringify(pdAssessment()),
    JSON.stringify({ text: "两人共 16 万，比 10 万预算多 6 万。", evidenceRefs: pdAssessment().evidenceRefs }),
    JSON.stringify({ supported: true, reason: "数值和建议均来自核准内容。" }),
  ];
  const fetch = vi.fn(async () => {
    starts.push(clock);
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    return new Response(JSON.stringify({ choices: [{ message: { content: output } }] }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  const pacedFetch = evaluator.createRequestPacedFetch({ fetch, requestIntervalMs: 10, now: () => clock,
    sleep: async milliseconds => { sleeps.push(milliseconds); clock += milliseconds; } });
  const client = createOpenAICompatibleChatCompletionsClient({
    config: { provider: "openai-compatible", baseUrl: "https://example.invalid/v1", apiKey: "synthetic", model: "synthetic", timeoutMs: 1000 },
    fetch: pacedFetch,
    sleep: async () => {},
    random: () => 0,
    now: () => clock,
  });

  const [result] = await evaluator.runProactiveDiscussionEval({ model: createPdModel({ client }), rounds: 1,
    cases: [{ id: "bounded", context: pdContext(), expectedDecision: "intervene", reviewCriteria: [] }] });

  expect(result).toMatchObject({ error: null, draft: { text: "两人共 16 万，比 10 万预算多 6 万。" } });
  expect(starts).toEqual([0, 10, 20, 30, 40]);
  expect(sleeps).toEqual([10, 10, 10, 10]);
});
