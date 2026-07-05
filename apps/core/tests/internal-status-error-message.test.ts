import { describe, expect, it } from "vitest";

import { normalizeInternalStatusErrorMessage } from "../src/admin/internal-status-error-message.js";

describe("normalizeInternalStatusErrorMessage", () => {
  it("normalizes standard Error messages", () => {
    expect(normalizeInternalStatusErrorMessage(new Error(" queue unavailable "))).toBe(
      "queue unavailable",
    );
  });

  it("falls back when a status error cannot be stringified", () => {
    expect(normalizeInternalStatusErrorMessage(Object.create(null))).toBe("unknown error");
  });
});
