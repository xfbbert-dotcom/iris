import { describe, expect, it, vi } from "vitest";

import {
  assertClosedCountDelta,
  assertProjectResourcesRemoved,
  combineAcceptanceErrors,
  isAcceptanceDrainComplete,
  type AcceptanceDrainCounts,
  type ConversationStateCounts,
} from "./conversation-state-acceptance-helpers.js";

const zeroDrainCounts: AcceptanceDrainCounts = {
  eventWaiting: 0,
  eventProcessing: 0,
  eventDeadLetter: 0,
  extractionPending: 0,
  extractionProcessing: 0,
  extractionDelayed: 0,
  extractionDeadLetter: 0,
  projectionPending: 0,
  projectionProcessing: 0,
  projectionFailed: 0,
};

const baseCounts: ConversationStateCounts = {
  messages: 10,
  requests: 9,
  runs: 8,
  threads: 7,
  threadEvents: 6,
  threadEvidence: 5,
  actions: 4,
  actionEvents: 3,
  actionEvidence: 2,
  operationClaims: 1,
};

describe("conversation-state acceptance helpers", () => {
  it("does not drain while a raw event is processing even when waiting is zero", () => {
    expect(isAcceptanceDrainComplete({ ...zeroDrainCounts, eventProcessing: 1 })).toBe(false);
  });

  it("rejects an unexpected delta in a field omitted by the caller", () => {
    expect(() => assertClosedCountDelta(
      { ...baseCounts, actions: baseCounts.actions + 1 },
      baseCounts,
      { messages: 0 },
    )).toThrow();
  });

  it("detects stopped project containers through docker ps -aq", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) =>
      args.includes("-aq") ? "stopped-container-id\n" : "",
    );

    await expect(assertProjectResourcesRemoved({
      projectName: "iris-conversation-state-acceptance-test",
      runCommand,
    })).rejects.toThrow("containers");
    expect(runCommand).toHaveBeenCalledWith("docker", [
      "ps",
      "-aq",
      "--filter",
      "label=com.docker.compose.project=iris-conversation-state-acceptance-test",
    ]);
    expect(runCommand).toHaveBeenCalledWith("docker", [
      "volume",
      "ls",
      "-q",
      "--filter",
      "label=com.docker.compose.project=iris-conversation-state-acceptance-test",
    ]);
  });

  it("preserves primary and cleanup failures in one aggregate", () => {
    const primary = new Error("primary gate failure");
    const cleanup = new Error("cleanup failure");
    const combined = combineAcceptanceErrors(primary, [cleanup]);

    expect(combined).toBeInstanceOf(AggregateError);
    expect((combined as AggregateError).errors).toEqual([primary, cleanup]);
  });
});
