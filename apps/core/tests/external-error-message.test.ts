import { describe, expect, it } from "vitest";

import { readExternalErrorMessage } from "../src/integrations/external-error-message.js";

describe("readExternalErrorMessage", () => {
  it("reads nested provider error messages", () => {
    expect(readExternalErrorMessage({ error: { message: " bad key " } })).toBe("bad key");
  });

  it("reads top-level Feishu error messages", () => {
    expect(readExternalErrorMessage({ msg: " permission denied " })).toBe("permission denied");
    expect(readExternalErrorMessage({ message: " unavailable " })).toBe("unavailable");
  });

  it("reads the first useful message from an array-wrapped provider error", () => {
    expect(
      readExternalErrorMessage([
        { error: { message: "   " } },
        { error: { message: " daily request quota exhausted " } },
      ]),
    ).toBe("daily request quota exhausted");
  });

  it("falls back when no useful message is present", () => {
    expect(readExternalErrorMessage({ error: { message: "   " } })).toBe("unknown error");
    expect(readExternalErrorMessage({})).toBe("unknown error");
    expect(readExternalErrorMessage(undefined)).toBe("unknown error");
    expect(readExternalErrorMessage([[], null, {}])).toBe("unknown error");
  });

  it("truncates oversized external error messages", () => {
    const message = readExternalErrorMessage({
      error: { message: `${"E".repeat(600)} trailing secret detail` },
    });

    expect(message.length).toBeLessThanOrEqual(512);
    expect(message).toContain("[truncated]");
    expect(message).not.toContain("trailing secret detail");
  });
});
