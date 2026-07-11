import { describe, expect, it } from "vitest";

import { readPositiveSafeInteger } from "../src/config/numeric-guards.js";

describe("readPositiveSafeInteger", () => {
  it("rejects values above Node's maximum timer delay", () => {
    expect(readPositiveSafeInteger(2_147_483_647, "timeoutMs")).toBe(2_147_483_647);
    expect(() => readPositiveSafeInteger(2_147_483_648, "timeoutMs")).toThrow(
      "timeoutMs must not exceed 2147483647",
    );
  });
});
