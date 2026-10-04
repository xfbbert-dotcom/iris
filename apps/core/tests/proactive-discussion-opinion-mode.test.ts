import { expect, test } from "vitest";
import { parsePdOpinionMode, pdOpinionModeOptions } from "../src/proactive-discussion/opinion-mode.js";
import { readProactiveDiscussionConfig } from "../src/config/runtime-config.js";

test("omission keeps legacy and the explicit mode maps only the three supported options", () => {
  expect(parsePdOpinionMode()).toBe("legacy");
  expect(parsePdOpinionMode("legacy")).toBe("legacy");
  expect(pdOpinionModeOptions("legacy")).toEqual({});
  expect(parsePdOpinionMode("source-plan")).toBe("source-plan");
  expect(pdOpinionModeOptions("source-plan")).toEqual({ canonicalOpinion: true, sourceBoundIdentity: true, opinionPlan: true });
});

test.each(["", "true", "canonical", "source-plan ", "SOURCE-PLAN"])("rejects unknown mode %j", value => {
  expect(() => parsePdOpinionMode(value)).toThrow("opinion mode");
});

test("mode selection does not turn on proactive discussion or expand groups", () => {
  expect(readProactiveDiscussionConfig({})).toMatchObject({ opinionMode: "legacy", enabled: false });
  expect(readProactiveDiscussionConfig({ IRIS_PROACTIVE_DISCUSSION_OPINION_MODE: "source-plan" }))
    .toEqual({ opinionMode: "source-plan", enabled: false, groupIds: [], pollIntervalMs: 1000, batchLimit: 10 });
  expect(() => readProactiveDiscussionConfig({ IRIS_PROACTIVE_DISCUSSION_OPINION_MODE: "unknown" })).toThrow();
});
