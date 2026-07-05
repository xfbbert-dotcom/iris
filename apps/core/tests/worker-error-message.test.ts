import { describe, expect, it } from "vitest";

import { normalizeWorkerErrorMessage } from "../src/workers/worker-error-message.js";

describe("normalizeWorkerErrorMessage", () => {
  it("normalizes standard Error instances", () => {
    expect(normalizeWorkerErrorMessage(new Error(" processor failed "))).toBe("processor failed");
  });

  it("falls back when a thrown value cannot be stringified", () => {
    expect(normalizeWorkerErrorMessage(Object.create(null))).toBe("unknown error");
  });
});
