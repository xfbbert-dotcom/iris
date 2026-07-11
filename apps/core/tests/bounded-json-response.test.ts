import { describe, expect, it, vi } from "vitest";

import { readBoundedJsonResponse } from "../src/integrations/bounded-json-response.js";

describe("readBoundedJsonResponse", () => {
  it("parses bounded JSON response streams", async () => {
    await expect(
      readBoundedJsonResponse({
        response: new Response(JSON.stringify({ ok: true })),
        invalidJsonErrorMessage: "invalid json",
        maxResponseBytes: 64,
        responseSizeErrorMessage: "response too large",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects oversized known content lengths before reading the response body", async () => {
    const response = {
      headers: new Headers({ "content-length": "11" }),
      json: vi.fn(async () => {
        throw new Error("json should not be read");
      }),
    } as unknown as Response;

    await expect(
      readBoundedJsonResponse({
        response,
        invalidJsonErrorMessage: "invalid json",
        maxResponseBytes: 10,
        responseSizeErrorMessage: "response too large",
      }),
    ).rejects.toThrow("response too large");

    expect(response.json).not.toHaveBeenCalled();
  });

  it("rejects oversized streamed responses and cancels the reader", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"padding":"'));
        controller.enqueue(new TextEncoder().encode("xxxxx"));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readBoundedJsonResponse({
        response: {
          headers: new Headers(),
          body,
        } as Response,
        invalidJsonErrorMessage: "invalid json",
        maxResponseBytes: 10,
        responseSizeErrorMessage: "response too large",
      }),
    ).rejects.toThrow("response too large");

    expect(cancelled).toBe(true);
  });

  it("uses text fallback when a response has no readable stream", async () => {
    await expect(
      readBoundedJsonResponse({
        response: {
          headers: new Headers(),
          body: undefined,
          text: vi.fn(async () => JSON.stringify({ fallback: true })),
          json: vi.fn(async () => {
            throw new Error("json should not be read");
          }),
        } as unknown as Response,
        invalidJsonErrorMessage: "invalid json",
        maxResponseBytes: 64,
        responseSizeErrorMessage: "response too large",
      }),
    ).resolves.toEqual({ fallback: true });
  });

  it("maps invalid JSON to the configured error message", async () => {
    await expect(
      readBoundedJsonResponse({
        response: new Response("{not-json"),
        invalidJsonErrorMessage: "invalid json",
        maxResponseBytes: 64,
        responseSizeErrorMessage: "response too large",
      }),
    ).rejects.toThrow("invalid json");
  });

  it("preserves abort errors for timeout adapters", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";

    await expect(
      readBoundedJsonResponse({
        response: {
          json: vi.fn(async () => {
            throw abortError;
          }),
        } as unknown as Response,
        invalidJsonErrorMessage: "invalid json",
      }),
    ).rejects.toBe(abortError);
  });
});
