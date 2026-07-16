import { describe, expect, it } from "vitest";

import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { readMemoryExtractionRuntimeConfig } from "../src/config/env.js";

describe("createDefaultRuntimeConfig", () => {
  it("keeps the development default enabled when startup configuration is absent", () => {
    expect(createDefaultRuntimeConfig({}).globalEnabled).toBe(true);
  });

  it("starts globally disabled when explicitly configured fail closed", () => {
    expect(
      createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: " false " }).globalEnabled,
    ).toBe(false);
  });

  it("supports explicit startup enablement", () => {
    expect(createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "TRUE" }).globalEnabled).toBe(
      true,
    );
  });

  it("rejects invalid startup enablement instead of silently enabling Iris", () => {
    expect(() =>
      createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "sometimes" }),
    ).toThrow("IRIS_RUNTIME_GLOBAL_ENABLED must be true or false");
    expect(() => createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "   " })).toThrow(
      "IRIS_RUNTIME_GLOBAL_ENABLED must be true or false",
    );
  });
});

describe("memory extraction rollout configuration", () => {
  it("fails closed with empty allowlists and parses trimmed unique group ids", () => {
    expect(readMemoryExtractionRuntimeConfig(enabledExtractionEnv())).toMatchObject({
      threadEnabledGroupIds: [],
      actionEnabledGroupIds: [],
      candidateConfidenceFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(readMemoryExtractionRuntimeConfig({
      ...enabledExtractionEnv(),
      IRIS_THREAD_EXTRACTION_GROUP_IDS: " group-a,group-b, group-a ",
      IRIS_ACTION_EXTRACTION_GROUP_IDS: "group-b",
      IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR: "0.7",
      IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE: "0.9",
    })).toMatchObject({
      threadEnabledGroupIds: ["group-a", "group-b"],
      actionEnabledGroupIds: ["group-b"],
      candidateConfidenceFloor: 0.7,
      applyConfidence: 0.9,
    });
  });

  it("rejects action groups outside the thread rollout and invalid threshold ordering", () => {
    expect(() => readMemoryExtractionRuntimeConfig({
      ...enabledExtractionEnv(),
      IRIS_THREAD_EXTRACTION_GROUP_IDS: "group-a",
      IRIS_ACTION_EXTRACTION_GROUP_IDS: "group-b",
    })).toThrow("IRIS_ACTION_EXTRACTION_GROUP_IDS must be a subset of IRIS_THREAD_EXTRACTION_GROUP_IDS");

    expect(() => readMemoryExtractionRuntimeConfig({
      ...enabledExtractionEnv(),
      IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR: "0.85",
      IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE: "0.85",
    })).toThrow("IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR must be less than IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE");
  });
});

function enabledExtractionEnv() {
  return {
    IRIS_MEMORY_EXTRACTION_ENABLED: "true",
    DATABASE_URL: "postgres://example/iris",
    REDIS_URL: "redis://localhost:6379",
    IRIS_AI_WORKER_BASE_URL: "http://ai-worker:8000",
    IRIS_AI_WORKER_TOKEN: "worker-token",
    IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
  };
}
