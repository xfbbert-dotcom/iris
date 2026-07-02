import { describe, expect, it } from "vitest";
import {
  readAnswerDraftRuntimeConfig,
  readFeishuAuthConfig,
  readModelProviderConfig,
} from "../src/config/env.js";

describe("readFeishuAuthConfig", () => {
  it("reads Feishu verification token and encrypt key from the environment", () => {
    expect(
      readFeishuAuthConfig({
        FEISHU_VERIFICATION_TOKEN: "token-a",
        FEISHU_ENCRYPT_KEY: "encrypt-a"
      })
    ).toEqual({
      verificationToken: "token-a",
      encryptKey: "encrypt-a"
    });
  });

  it("treats blank strings as missing values", () => {
    expect(
      readFeishuAuthConfig({
        FEISHU_VERIFICATION_TOKEN: "   ",
        FEISHU_ENCRYPT_KEY: ""
      })
    ).toEqual({});
  });
});

describe("readModelProviderConfig", () => {
  it("returns undefined when no model provider is configured", () => {
    expect(readModelProviderConfig({})).toBeUndefined();
  });

  it("reads openai-compatible model config and trims values", () => {
    expect(
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: " openai-compatible ",
        IRIS_MODEL_BASE_URL: " https://api.example.com/v1/ ",
        IRIS_MODEL_API_KEY: " key-a ",
        IRIS_MODEL_NAME: " model-a ",
        IRIS_MODEL_TIMEOUT_MS: " 1500 ",
      }),
    ).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "key-a",
      model: "model-a",
      timeoutMs: 1500,
    });
  });

  it("rejects incomplete openai-compatible config", () => {
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
      }),
    ).toThrow("IRIS_MODEL_API_KEY is required");
  });

  it("rejects invalid timeout values", () => {
    expect(() =>
      readModelProviderConfig({
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
        IRIS_MODEL_API_KEY: "key-a",
        IRIS_MODEL_NAME: "model-a",
        IRIS_MODEL_TIMEOUT_MS: "0",
      }),
    ).toThrow("IRIS_MODEL_TIMEOUT_MS must be a positive integer");
  });
});

describe("readAnswerDraftRuntimeConfig", () => {
  it("returns disabled config when internal answer drafts are not enabled", () => {
    expect(readAnswerDraftRuntimeConfig({})).toEqual({ enabled: false });
    expect(readAnswerDraftRuntimeConfig({ IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "false" })).toEqual({
      enabled: false,
    });
  });

  it("reads enabled allow-indexed runtime config", () => {
    expect(
      readAnswerDraftRuntimeConfig({
        IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: " true ",
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: " allow-indexed ",
      }),
    ).toEqual({
      enabled: true,
      permissionMode: "allow-indexed",
    });
  });

  it("requires permission mode when runtime is enabled", () => {
    expect(() =>
      readAnswerDraftRuntimeConfig({ IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true" }),
    ).toThrow("IRIS_INTERNAL_DRAFT_PERMISSION_MODE is required");
  });

  it("rejects unsupported permission modes", () => {
    expect(() =>
      readAnswerDraftRuntimeConfig({
        IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "live-feishu",
      }),
    ).toThrow("Unsupported IRIS_INTERNAL_DRAFT_PERMISSION_MODE: live-feishu");
  });
});
