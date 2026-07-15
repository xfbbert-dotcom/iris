import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  AiWorkerMemoryExtractionError,
  type ProposedMemoryCandidate,
} from "../src/memory-extraction/ai-worker-memory-extraction-client.js";
import { HttpAiWorkerMemoryExtractionClient } from "../src/memory-extraction/http-ai-worker-memory-extraction-client.js";
import type { ClaimedMemoryExtractionRun } from "../src/memory-extraction/memory-extraction-repository.js";

describe("HttpAiWorkerMemoryExtractionClient", () => {
  it("sends the exact bounded v1 request and parses the exact v1 response", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(responseFixture()),
    );
    const client = createClient(fetchImpl);

    await expect(client.extract(runFixture())).resolves.toEqual({
      runId: "run-1",
      candidates: [candidateFixture()],
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://ai-worker:8000/v1/memory/extract");
    expect(init!).toMatchObject({
      method: "POST",
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        authorization: "Bearer worker-token",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(String(init!.body))).toEqual({
      schema_version: 1,
      run_id: "run-1",
      group_id: "group-1",
      input_fingerprint: "a".repeat(64),
      messages: [
        {
          id: "context-1",
          sender_id: "sender-0",
          sent_at: "2026-07-14T00:00:00.000Z",
          text: "Earlier context.",
        },
        {
          id: "message-1",
          sender_id: "sender-1",
          sent_at: "2026-07-14T00:01:00.000Z",
          text: "Launch is Thursday.",
        },
      ],
      evidence_message_ids: ["message-1"],
      existing_memories: [
        {
          id: "memory-1",
          category: "project",
          content: "Launch planning is active.",
          updated_at: "2026-07-13T00:00:00.000Z",
        },
      ],
    });
    expect(Object.keys(JSON.parse(String(init!.body)))).toEqual([
      "schema_version",
      "run_id",
      "group_id",
      "input_fingerprint",
      "messages",
      "evidence_message_ids",
      "existing_memories",
    ]);
  });

  it("rejects an oversized serialized request before calling fetch", async () => {
    const fetchImpl = vi.fn();
    const client = createClient(fetchImpl, { maxRequestBytes: 1024 });
    const run = runFixture();
    run.evidenceMessages[0]!.text = "private-run-text".repeat(100);

    await expect(client.extract(run)).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
      message: "invalid_response",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["cross-group message", (run: ClaimedMemoryExtractionRun) => {
      run.evidenceMessages[0]!.groupId = "group-2";
    }],
    ["too many evidence messages", (run: ClaimedMemoryExtractionRun) => {
      run.evidenceMessages = Array.from({ length: 41 }, (_, index) => ({
        ...run.evidenceMessages[0]!,
        id: `message-${index}`,
      }));
    }],
    ["blank message text", (run: ClaimedMemoryExtractionRun) => {
      run.evidenceMessages[0]!.text = "   ";
    }],
    ["duplicate message id", (run: ClaimedMemoryExtractionRun) => {
      run.contextMessages[0]!.id = run.evidenceMessages[0]!.id;
    }],
    ["too many existing memories", (run: ClaimedMemoryExtractionRun) => {
      run.existingMemories = Array.from({ length: 9 }, (_, index) => ({
        ...run.existingMemories[0]!,
        id: `memory-${index}`,
      }));
    }],
  ] as const)("rejects an out-of-contract claimed run before fetch: %s", async (_name, mutate) => {
    const fetchImpl = vi.fn(async () => jsonResponse(responseFixture()));
    const client = createClient(fetchImpl);
    const run = runFixture();
    mutate(run);

    await expect(client.extract(run)).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces one wall-clock timeout across fetch and response reading", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("private fetch details");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    const client = createClient(fetchImpl, { timeoutMs: 10 });

    await expect(client.extract(runFixture())).rejects.toEqual(
      expect.objectContaining({ code: "timeout", retryable: true }),
    );
    expect(observedSignal?.aborted).toBe(true);
  });

  it("enforces the same wall-clock timeout after response headers arrive", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({}));
    });
    const client = createClient(fetchImpl, { timeoutMs: 10 });

    await expect(client.extract(runFixture())).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("rejects oversized streamed success responses and cancels the stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"schema_version":1,"run_id":"run-1",'));
        controller.enqueue(new Uint8Array(100));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = createClient(async () => new Response(stream), {
      maxResponseBytes: 48,
    });

    await expect(client.extract(runFixture())).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
    expect(cancelled).toBe(true);
  });

  it.each(["gzip", "br", "gzip, br"])(
    "rejects encoded success responses before reading the body: %s",
    async (encoding) => {
      const response = unreadableResponse(200, {
        "content-encoding": encoding,
      });
      const client = createClient(async () => response);

      await expect(client.extract(runFixture())).rejects.toMatchObject({
        code: "invalid_response",
        retryable: false,
      });
      expect(response.bodyRead).toBe(false);
    },
  );

  it.each(["+12", "12.0", " 12", "12 ", "01", "1, 1", "9".repeat(21)])(
    "rejects malformed Content-Length before reading a success body: %s",
    async (contentLength) => {
      const response = unreadableResponse(200, { "content-length": contentLength });
      const client = createClient(async () => response);

      await expect(client.extract(runFixture())).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(response.bodyRead).toBe(false);
    },
  );

  it("rejects a declared oversized success response before reading the body", async () => {
    const response = unreadableResponse(200, { "content-length": "65" });
    const client = createClient(async () => response, { maxResponseBytes: 64 });

    await expect(client.extract(runFixture())).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(response.bodyRead).toBe(false);
  });

  it.each([401, 403])("maps %s before reading the body", async (status) => {
    const response = unreadableResponse(status, {
      "content-encoding": "gzip",
      "content-length": "999999999999999999999",
    });
    const client = createClient(async () => response);

    await expect(client.extract(runFixture())).rejects.toEqual(
      expect.objectContaining({ code: "unauthorized", retryable: false }),
    );
    expect(response.bodyRead).toBe(false);
  });

  it.each([500, 503, 599])("maps %s to retryable unavailable", async (status) => {
    const response = unreadableResponse(status);
    const client = createClient(async () => response);

    await expect(client.extract(runFixture())).rejects.toEqual(
      expect.objectContaining({ code: "unavailable", retryable: true }),
    );
    expect(response.bodyRead).toBe(false);
  });

  it("maps the exact bounded Python invalid-model-response contract to the retryable invalid family", async () => {
    const contractBody = readFileSync(
      new URL("../../../workers/ai/tests/fixtures/invalid_model_response.json", import.meta.url),
      "utf8",
    );
    const client = createClient(async () =>
      new Response(contractBody, {
        status: 502,
        headers: {
          "content-type": "application/json",
          "content-encoding": "identity",
        },
      }),
    );

    await expect(client.extract(runFixture())).rejects.toMatchObject({
      code: "invalid_response",
      retryable: true,
      message: "invalid_response",
    });
  });

  it.each([
    ["unknown field", '{"error":"invalid_model_response","detail":"private"}'],
    ["malformed JSON", '{"error":"invalid_model_response"'],
    ["unknown error", '{"error":"private_provider_detail"}'],
  ])("keeps a %s 502 body in the generic unavailable family", async (_name, body) => {
    const client = createClient(async () => new Response(body, { status: 502 }));

    const error = await client.extract(runFixture()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "unavailable", retryable: true });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(body);
  });

  it("keeps an oversized 502 body generic and cancels its stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":"invalid_model_response","padding":"'));
        controller.enqueue(new Uint8Array(100));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = createClient(async () => new Response(stream, { status: 502 }), {
      maxResponseBytes: 48,
    });

    await expect(client.extract(runFixture())).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    expect(cancelled).toBe(true);
  });

  it.each([
    ["0", 60_000],
    ["1", 60_000],
    ["59", 60_000],
    ["60", 60_000],
    ["86400", 86_400_000],
    ["86401", 86_400_000],
    [String(Number.MAX_SAFE_INTEGER), 86_400_000],
  ])("clamps a valid integer Retry-After %s to %s ms", async (retryAfter, expectedMs) => {
    const response = unreadableResponse(429, { "retry-after": retryAfter });
    const client = createClient(async () => response);

    await expect(client.extract(runFixture())).rejects.toEqual(
      expect.objectContaining({
        code: "rate_limited",
        retryable: true,
        retryAfterMs: expectedMs,
      }),
    );
    expect(response.bodyRead).toBe(false);
  });

  it.each(["-1", "+1", "1.0", "01", "9007199254740992", "999999999999999999999"])(
    "drops an unsafe or malformed retry delay without reading the body: %s",
    async (retryAfter) => {
      const response = unreadableResponse(429, { "retry-after": retryAfter });
      const client = createClient(async () => response);

      const error = await client.extract(runFixture()).catch((caught: unknown) => caught);
      expect(error).toEqual(
        expect.objectContaining({ code: "rate_limited", retryable: true }),
      );
      expect(error).toHaveProperty("retryAfterMs", undefined);
      expect(response.bodyRead).toBe(false);
    },
  );

  it.each([400, 404, 422, 499])("maps other status %s to invalid_response", async (status) => {
    const response = unreadableResponse(status);
    const client = createClient(async () => response);

    await expect(client.extract(runFixture())).rejects.toEqual(
      expect.objectContaining({ code: "invalid_response", retryable: false }),
    );
    expect(response.bodyRead).toBe(false);
  });

  it.each([
    ["unknown top-level field", { ...responseFixture(), unknown: true }],
    ["wrong schema", { ...responseFixture(), schema_version: 2 }],
    ["boolean schema", { ...responseFixture(), schema_version: true }],
    ["wrong run id", { ...responseFixture(), run_id: "run-2" }],
    ["too many candidates", { ...responseFixture(), candidates: Array(9).fill(candidateWire()) }],
    ["unknown candidate field", responseFixture({ ...candidateWire(), unknown: true })],
    ["non-finite confidence", responseFixture({ ...candidateWire(), confidence: Number.NaN })],
    ["fractional importance", responseFixture({ ...candidateWire(), importance: 4.5 })],
    ["duplicate evidence ids", responseFixture({ ...candidateWire(), evidence_message_ids: ["message-1", "message-1"] })],
    ["new relation existing id", responseFixture({ ...candidateWire(), existing_memory_id: "memory-1" })],
    ["missing relation existing id", responseFixture({ ...candidateWire(), relation: "duplicate" })],
  ])("rejects malformed success JSON: %s", async (_name, body) => {
    const client = createClient(async () => jsonResponse(body));

    await expect(client.extract(runFixture())).rejects.toEqual(
      expect.objectContaining({ code: "invalid_response", retryable: false }),
    );
  });

  it.each([
    ["4000 ASCII code units", "x".repeat(4000), true],
    ["4001 ASCII code units", "x".repeat(4001), false],
    ["2000 surrogate pairs", "\ud83d\ude00".repeat(2000), true],
    ["2001 surrogate pairs", "\ud83d\ude00".repeat(2001), false],
    ["4000 trimmed code units", `  ${"x".repeat(4000)}  `, true],
    ["lone high surrogate", String.fromCharCode(0xd800), false],
    ["lone low surrogate", String.fromCharCode(0xdc00), false],
  ])("uses persistence-aligned candidate content bounds: %s", async (_name, content, valid) => {
    const client = createClient(async () =>
      jsonResponse(responseFixture({ ...candidateWire(), content })),
    );
    const promise = client.extract(runFixture());

    if (valid) {
      await expect(promise).resolves.toMatchObject({
        candidates: [expect.objectContaining({ content })],
      });
    } else {
      await expect(promise).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it.each([
    ["embedded NUL", "Launch\u0000Thursday"],
    ["NUL-only after trim", "  \u0000  "],
  ])("rejects candidate content containing U+0000 without echoing it: %s", async (_name, content) => {
    const client = createClient(async () =>
      jsonResponse(responseFixture({ ...candidateWire(), content })),
    );

    const error = await client.extract(runFixture()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "AiWorkerMemoryExtractionError",
      message: "invalid_response",
      code: "invalid_response",
      retryable: false,
      retryAfterMs: undefined,
    });
    expect(Object.values(error as Record<string, unknown>)).not.toContain(content);
  });

  it("continues to parse ordinary multilingual Unicode candidate content", async () => {
    const content = "\u7814\u53d1 Caf\u00e9 \ud83d\ude00";
    const client = createClient(async () =>
      jsonResponse(responseFixture({ ...candidateWire(), content })),
    );

    await expect(client.extract(runFixture())).resolves.toMatchObject({
      candidates: [expect.objectContaining({ content })],
    });
  });

  it("never leaks token, URL credentials, response body, or run text in errors", async () => {
    expect(
      () => createClient(vi.fn(), { baseUrl: "https://user:password@worker.example" }),
    ).toThrow("ai worker base URL is invalid");

    const run = runFixture();
    run.evidenceMessages[0]!.text = "private run text";
    const client = createClient(async () => new Response("private response body", { status: 502 }));
    const error = await client.extract(run).catch((caught: unknown) => caught);
    const rendered = `${String(error)} ${JSON.stringify(error)}`;
    expect(rendered).toContain("unavailable");
    expect(rendered).not.toContain("worker-token");
    expect(rendered).not.toContain("password");
    expect(rendered).not.toContain("private response body");
    expect(rendered).not.toContain("private run text");
  });

  it.each([
    { baseUrl: "ftp://worker.example" },
    { baseUrl: "https://worker.example?secret=query" },
    { baseUrl: "https://worker.example#fragment" },
    { baseUrl: "https://@worker.example" },
    { baseUrl: `https://worker.example/${"x".repeat(2049)}` },
    { token: "" },
    { token: "line\nbreak" },
    { token: "non-ascii-\u00e9" },
    { token: "two,tokens" },
    { timeoutMs: 0 },
    { timeoutMs: 1.5 },
    { timeoutMs: 120_001 },
    { maxRequestBytes: 0 },
    { maxRequestBytes: 512 * 1024 + 1 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 1024 * 1024 + 1 },
  ])("rejects invalid client configuration without values in errors: %#", (override) => {
    expect(() => createClient(vi.fn(), override)).toThrow(/^ai worker .+ is invalid$/u);
  });

  it("returns true only for the exact bounded health payload", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, service: "iris-ai-worker", schemaVersion: 1 }),
    );
    const client = createClient(fetchImpl);

    await expect(client.checkHealth()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://ai-worker:8000/health",
      expect.objectContaining({
        method: "GET",
        headers: { accept: "application/json", "accept-encoding": "identity" },
      }),
    );
  });

  it.each([
    { ok: true },
    { ok: true, service: "other", schemaVersion: 1 },
    { ok: true, service: "iris-ai-worker", schemaVersion: 1, extra: true },
    { ok: true, service: "iris-ai-worker", schemaVersion: true },
    [],
  ])("returns false for an untrusted health payload: %#", async (body) => {
    const client = createClient(async () => jsonResponse(body));
    await expect(client.checkHealth()).resolves.toBe(false);
  });

  it("returns false for health failures without reading an error body", async () => {
    const response = unreadableResponse(503, { "content-encoding": "gzip" });
    const client = createClient(async () => response);

    await expect(client.checkHealth()).resolves.toBe(false);
    expect(response.bodyRead).toBe(false);
  });
});

function createClient(
  fetchImpl: (...args: any[]) => any,
  overrides: Record<string, unknown> = {},
): HttpAiWorkerMemoryExtractionClient {
  return new HttpAiWorkerMemoryExtractionClient({
    baseUrl: "http://ai-worker:8000",
    token: "worker-token",
    timeoutMs: 1_000,
    maxRequestBytes: 512 * 1024,
    maxResponseBytes: 64 * 1024,
    fetch: fetchImpl as typeof fetch,
    ...overrides,
  });
}

function runFixture(): ClaimedMemoryExtractionRun {
  return {
    id: "run-1",
    groupId: "group-1",
    inputFingerprint: "a".repeat(64),
    requestIds: ["request-1"],
    contextMessages: [
      {
        id: "context-1",
        groupId: "group-1",
        senderId: "sender-0",
        text: "Earlier context.",
        sentAt: new Date("2026-07-14T00:00:00.000Z"),
        createdAt: new Date("2026-07-14T00:00:01.000Z"),
        evidenceEligible: false,
      },
    ],
    evidenceMessages: [
      {
        id: "message-1",
        groupId: "group-1",
        senderId: "sender-1",
        text: "Launch is Thursday.",
        sentAt: new Date("2026-07-14T00:01:00.000Z"),
        createdAt: new Date("2026-07-14T00:01:01.000Z"),
        evidenceEligible: true,
      },
    ],
    existingMemories: [
      {
        id: "memory-1",
        category: "project",
        content: "Launch planning is active.",
        updatedAt: new Date("2026-07-13T00:00:00.000Z"),
      },
    ],
  };
}

function candidateFixture(): ProposedMemoryCandidate {
  return {
    category: "decision",
    content: "Launch is Thursday.",
    importance: 4,
    confidence: 0.95,
    evidenceMessageIds: ["message-1"],
    relation: "new",
  };
}

function candidateWire(): Record<string, unknown> {
  return {
    category: "decision",
    content: "Launch is Thursday.",
    importance: 4,
    confidence: 0.95,
    evidence_message_ids: ["message-1"],
    relation: "new",
  };
}

function responseFixture(
  candidate: Record<string, unknown> = candidateWire(),
): Record<string, unknown> {
  return { schema_version: 1, run_id: "run-1", candidates: [candidate] };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "content-encoding": "identity" },
  });
}

function unreadableResponse(
  status: number,
  headers: Record<string, string> = {},
): Response & { bodyRead: boolean } {
  let bodyRead = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    get bodyRead() {
      return bodyRead;
    },
    get body() {
      bodyRead = true;
      throw new Error("private response body must not be read");
    },
    text: async () => {
      bodyRead = true;
      throw new Error("private response body must not be read");
    },
  } as unknown as Response & { bodyRead: boolean };
}

describe("AiWorkerMemoryExtractionError", () => {
  it("stores only bounded classification metadata", () => {
    const error = new AiWorkerMemoryExtractionError("rate_limited", true, 1_000);
    expect(error).toMatchObject({
      name: "AiWorkerMemoryExtractionError",
      message: "rate_limited",
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 1_000,
    });
  });
});
