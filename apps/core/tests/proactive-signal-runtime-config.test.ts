import { describe, expect, it } from "vitest";

import { readProactiveSignalRuntimeConfig } from "../src/proactive/proactive-signal-runtime-config.js";

describe("readProactiveSignalRuntimeConfig", () => {
  it("is disabled by default without reading dependent settings", () => {
    expect(readProactiveSignalRuntimeConfig({
      IRIS_PROACTIVE_CANDIDATE_BATCH_LIMIT: "not-a-number",
    })).toEqual({ enabled: false });
  });

  it("uses conservative defaults and an empty allowlist", () => {
    expect(readProactiveSignalRuntimeConfig({
      IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED: "true",
    })).toEqual({
      enabled: true,
      groupIds: [],
      intervalMs: 300_000,
      batchLimit: 50,
      policy: {
        policyVersion: "phase4a-v1",
        minConfidence: 0.7,
        quietThreadMs: 86_400_000,
        quietActionMs: 86_400_000,
        overdueGraceMs: 1_800_000,
      },
    });
  });

  it("normalizes a sorted unique pilot group allowlist and bounded overrides", () => {
    expect(readProactiveSignalRuntimeConfig({
      IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED: "true",
      IRIS_PROACTIVE_CANDIDATE_GROUP_IDS: " group-b,group-a ",
      IRIS_PROACTIVE_CANDIDATE_INTERVAL_MS: "1000",
      IRIS_PROACTIVE_CANDIDATE_BATCH_LIMIT: "25",
      IRIS_PROACTIVE_CANDIDATE_MIN_CONFIDENCE: "0.82",
      IRIS_PROACTIVE_CANDIDATE_QUIET_THREAD_MS: "7200000",
      IRIS_PROACTIVE_CANDIDATE_QUIET_ACTION_MS: "3600000",
      IRIS_PROACTIVE_CANDIDATE_OVERDUE_GRACE_MS: "600000",
    })).toMatchObject({
      enabled: true,
      groupIds: ["group-a", "group-b"],
      intervalMs: 1000,
      batchLimit: 25,
      policy: {
        minConfidence: 0.82,
        quietThreadMs: 7_200_000,
        quietActionMs: 3_600_000,
        overdueGraceMs: 600_000,
      },
    });
  });

  it.each([
    ["invalid enabled flag", { IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED: "yes" }],
    ["duplicate group", {
      IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED: "true",
      IRIS_PROACTIVE_CANDIDATE_GROUP_IDS: "group-a, group-a",
    }],
    ["blank group", {
      IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED: "true",
      IRIS_PROACTIVE_CANDIDATE_GROUP_IDS: "group-a,,group-b",
    }],
    ["oversized batch", {
      IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED: "true",
      IRIS_PROACTIVE_CANDIDATE_BATCH_LIMIT: "501",
    }],
    ["timer overflow", {
      IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED: "true",
      IRIS_PROACTIVE_CANDIDATE_INTERVAL_MS: "2147483648",
    }],
    ["invalid confidence", {
      IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED: "true",
      IRIS_PROACTIVE_CANDIDATE_MIN_CONFIDENCE: "1",
    }],
    ["fractional duration", {
      IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED: "true",
      IRIS_PROACTIVE_CANDIDATE_QUIET_THREAD_MS: "1.5",
    }],
  ])("rejects %s", (_label, env) => {
    expect(() => readProactiveSignalRuntimeConfig(env)).toThrow();
  });
});
