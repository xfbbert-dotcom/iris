import { describe, expect, it } from "vitest";

import { normalizeDeadLetterErrorMessage } from "../src/queues/dead-letter-error-message.js";

describe("normalizeDeadLetterErrorMessage", () => {
  it("trims short dead-letter errors", () => {
    expect(normalizeDeadLetterErrorMessage(" runner crashed ")).toBe("runner crashed");
  });

  it("falls back for blank dead-letter errors", () => {
    expect(normalizeDeadLetterErrorMessage(" \n\t ")).toBe("unknown error");
  });

  it("truncates oversized dead-letter errors", () => {
    const message = normalizeDeadLetterErrorMessage(
      `${"E".repeat(1200)} trailing diagnostic detail`,
    );

    expect(message.length).toBeLessThanOrEqual(1000);
    expect(message).toContain("[truncated]");
    expect(message).not.toContain("trailing diagnostic detail");
  });
});
