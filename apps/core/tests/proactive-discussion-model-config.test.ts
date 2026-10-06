import { describe, expect, it } from "vitest";
import { readModelProviderConfig, readProactiveDiscussionModelProviderConfig as read } from "../src/config/env.js";
import type { EnvLike } from "../src/config/env.js";

const prefix = "IRIS_PROACTIVE_DISCUSSION_MODEL_";
const shared: EnvLike = {
  IRIS_MODEL_PROVIDER: "openai-compatible",
  IRIS_MODEL_BASE_URL: "https://shared.invalid/v1",
  IRIS_MODEL_API_KEY: "shared-secret",
  IRIS_MODEL_NAME: "shared-model",
  IRIS_MODEL_TIMEOUT_MS: "1500",
  IRIS_MODEL_STRUCTURED_OUTPUT_MODE: "json_object",
};
const dedicated: EnvLike = {
  [`${prefix}SOURCE`]: "dedicated",
  [`${prefix}PROVIDER`]: "openai-compatible",
  [`${prefix}BASE_URL`]: " https://dedicated.invalid/v1/ ",
  [`${prefix}API_KEY`]: " dedicated-secret ",
  [`${prefix}NAME`]: " dedicated-model ",
};

describe("proactive discussion model configuration", () => {
  it.each([undefined, "shared"])("keeps the shared configuration for source %s", source => {
    expect(read({ ...dedicated, ...shared, [`${prefix}SOURCE`]: source })).toEqual({
      provider: "openai-compatible", baseUrl: "https://shared.invalid/v1", apiKey: "shared-secret",
      model: "shared-model", timeoutMs: 1500, structuredOutputMode: "json_object",
    });
    expect(read({ [`${prefix}SOURCE`]: source })).toBeUndefined();
  });

  it.each(["", " ", "private-invalid-source"])("rejects invalid source %j without revealing its value", source => {
    const operation = () => read({ ...shared, [`${prefix}SOURCE`]: source });
    expect(operation).toThrow(`${prefix}SOURCE must be shared or dedicated`);
    expect(operation).not.toThrow("private-invalid-source");
  });

  it("uses only dedicated values and independent defaults even with a complete shared profile", () => {
    expect(read({ ...shared, ...dedicated })).toEqual({
      provider: "openai-compatible", baseUrl: "https://dedicated.invalid/v1", apiKey: "dedicated-secret",
      model: "dedicated-model", timeoutMs: 30000,
    });
    expect(read({ ...dedicated, IRIS_MODEL_PROVIDER: "invalid-shared-provider" })).toEqual({
      provider: "openai-compatible", baseUrl: "https://dedicated.invalid/v1", apiKey: "dedicated-secret",
      model: "dedicated-model", timeoutMs: 30000,
    });
  });

  it.each(["PROVIDER", "BASE_URL", "API_KEY", "NAME"])("does not borrow missing dedicated %s from shared configuration", suffix => {
    for (const value of [undefined, "", "  "]) {
      expect(() => read({ ...shared, ...dedicated, [`${prefix}${suffix}`]: value }))
        .toThrow(`${prefix}${suffix} is required`);
    }
  });

  it.each([["true", true], ["false", false]] as const)("reads the complete dedicated transport profile with thinking %s", (value, expected) => {
    expect(read({ ...dedicated,
      [`${prefix}TIMEOUT_MS`]: "60000", [`${prefix}STRUCTURED_OUTPUT_MODE`]: "json_object",
      [`${prefix}MAX_TOKENS`]: "4096", [`${prefix}ENABLE_THINKING`]: value,
    })).toEqual({
      provider: "openai-compatible", baseUrl: "https://dedicated.invalid/v1", apiKey: "dedicated-secret",
      model: "dedicated-model", timeoutMs: 60000, structuredOutputMode: "json_object",
      maxTokens: 4096, enableThinking: expected,
    });
  });

  it("omits blank optional values without inheriting shared transport choices", () => {
    expect(read({ ...shared, ...dedicated,
      [`${prefix}TIMEOUT_MS`]: " ", [`${prefix}STRUCTURED_OUTPUT_MODE`]: " ",
      [`${prefix}MAX_TOKENS`]: " ", [`${prefix}ENABLE_THINKING`]: " ",
    })).toEqual({
      provider: "openai-compatible", baseUrl: "https://dedicated.invalid/v1", apiKey: "dedicated-secret",
      model: "dedicated-model", timeoutMs: 30000,
    });
  });

  it.each([
    ["PROVIDER", "private-invalid-provider"],
    ["BASE_URL", "ftp://private.invalid/v1"],
    ["BASE_URL", "https://private-secret@private.invalid/v1"],
    ["BASE_URL", "https://private.invalid/v1?private-secret=1"],
    ["BASE_URL", "https://private.invalid/v1\n"],
    ["TIMEOUT_MS", "0"], ["TIMEOUT_MS", "2147483648"],
    ["STRUCTURED_OUTPUT_MODE", "private-invalid-mode"],
    ["MAX_TOKENS", "0"], ["MAX_TOKENS", "-1"], ["MAX_TOKENS", "1.5"],
    ["MAX_TOKENS", "1e3"], ["MAX_TOKENS", "9007199254740992"],
    ["ENABLE_THINKING", "private-invalid-boolean"], ["ENABLE_THINKING", "0"],
  ])("rejects invalid dedicated %s without exposing the supplied value", (suffix, value) => {
    const operation = () => read({ ...dedicated, [`${prefix}${suffix}`]: value });
    expect(operation).toThrow(`${prefix}${suffix}`);
    try { operation(); } catch (error) {
      expect(String(error)).not.toContain("private-");
      expect(String(error)).not.toContain("shared-secret");
      expect(String(error)).not.toContain("dedicated-secret");
    }
  });

  it("does not let dedicated transport options change the ordinary answer configuration", () => {
    expect(readModelProviderConfig({ ...shared, ...dedicated,
      [`${prefix}MAX_TOKENS`]: "4096", [`${prefix}ENABLE_THINKING`]: "false",
    })).toEqual({
      provider: "openai-compatible", baseUrl: "https://shared.invalid/v1", apiKey: "shared-secret",
      model: "shared-model", timeoutMs: 1500, structuredOutputMode: "json_object",
    });
  });
});
