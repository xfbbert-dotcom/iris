import { describe, expect, it } from "vitest";

import {
  applyProactiveSignalTransition,
  ProactiveSignalTransitionError,
} from "../src/proactive/proactive-signal-state-machine.js";
import type { ProactiveSignalCandidate } from "../src/proactive/proactive-signal-candidate.js";

const candidate: ProactiveSignalCandidate = {
  id: "candidate-1",
  groupId: "group-1",
  sourceType: "thread",
  sourceId: "thread-1",
  sourceVersion: 2,
  reason: "quiet_unresolved_thread",
  score: 0.71,
  scoreFactors: {
    base: 0.55,
    confidenceContribution: 0.1,
    ageContribution: 0.06,
    overdueContribution: 0,
    quietForMs: 48 * 60 * 60 * 1_000,
    overdueByMs: 0,
  },
  explanation: "Open thread has been quiet for 48 hours; semantic confidence is 0.90.",
  policyVersion: "phase4a-v1",
  status: "pending",
  version: 1,
  sourceActivityAt: new Date("2026-07-16T12:00:00.000Z"),
  eligibleAt: new Date("2026-07-17T12:00:00.000Z"),
  observedAt: new Date("2026-07-18T12:00:00.000Z"),
  createdAt: new Date("2026-07-18T12:00:00.000Z"),
  updatedAt: new Date("2026-07-18T12:00:00.000Z"),
};

describe("applyProactiveSignalTransition", () => {
  it("dismisses a pending candidate with bounded audit metadata", () => {
    const at = new Date("2026-07-18T13:00:00.000Z");

    expect(applyProactiveSignalTransition(candidate, {
      type: "dismiss",
      expectedVersion: 1,
      dismissedBy: "operator@example.com",
      dismissalReason: "Already handled outside the thread",
      at,
    })).toEqual({
      ...candidate,
      status: "dismissed",
      version: 2,
      dismissedAt: at,
      dismissedBy: "operator@example.com",
      dismissalReason: "Already handled outside the thread",
      updatedAt: at,
    });
  });

  it("expires a pending candidate without dismissal metadata", () => {
    const at = new Date("2026-07-18T13:00:00.000Z");

    expect(applyProactiveSignalTransition(candidate, {
      type: "expire",
      expectedVersion: 1,
      at,
    })).toEqual({
      ...candidate,
      status: "expired",
      version: 2,
      expiredAt: at,
      updatedAt: at,
    });
  });

  it.each([
    ["version conflict", candidate, { type: "expire", expectedVersion: 2, at: new Date() }],
    ["repeat dismissal", { ...candidate, status: "dismissed" }, {
      type: "dismiss",
      expectedVersion: 1,
      dismissedBy: "operator",
      at: new Date(),
    }],
    ["repeat expiry", { ...candidate, status: "expired" }, {
      type: "expire",
      expectedVersion: 1,
      at: new Date(),
    }],
  ] as const)("rejects %s", (_label, current, event) => {
    expect(() => applyProactiveSignalTransition(
      current as ProactiveSignalCandidate,
      event,
    )).toThrow(ProactiveSignalTransitionError);
  });

  it("rejects invalid timestamps and unbounded metadata", () => {
    expect(() => applyProactiveSignalTransition(candidate, {
      type: "dismiss",
      expectedVersion: 1,
      dismissedBy: " ",
      at: new Date(),
    })).toThrow("dismissedBy");
    expect(() => applyProactiveSignalTransition(candidate, {
      type: "dismiss",
      expectedVersion: 1,
      dismissedBy: "operator",
      dismissalReason: "x".repeat(513),
      at: new Date(),
    })).toThrow("dismissalReason");
    expect(() => applyProactiveSignalTransition(candidate, {
      type: "expire",
      expectedVersion: 1,
      at: new Date(Number.NaN),
    })).toThrow("transition time");
  });
});
