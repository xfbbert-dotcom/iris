import { describe, expect, it, vi } from "vitest";

import { readBoundedJsonResponse } from "../src/integrations/bounded-json-response.js";

describe("readBoundedJsonResponse", () => {
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
});
