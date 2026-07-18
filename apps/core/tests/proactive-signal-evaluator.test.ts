import { describe, expect, it } from "vitest";

import {
  evaluateProactiveSignal,
  type ProactiveSignalPolicy,
  type ProactiveSignalSourceSnapshot,
} from "../src/proactive/proactive-signal-evaluator.js";

const hour = 60 * 60 * 1_000;
const now = new Date("2026-07-18T12:00:00.000Z");

const policy: ProactiveSignalPolicy = {
  policyVersion: "phase4a-v1",
  minConfidence: 0.7,
  quietThreadMs: 24 * hour,
  quietActionMs: 24 * hour,
  overdueGraceMs: 30 * 60 * 1_000,
};

function thread(
  overrides: Partial<Extract<ProactiveSignalSourceSnapshot, { sourceType: "thread" }>> = {},
): Extract<ProactiveSignalSourceSnapshot, { sourceType: "thread" }> {
  return {
    sourceType: "thread",
    sourceId: "thread-1",
    groupId: "group-1",
    sourceVersion: 2,
    status: "open",
    retrievalVisible: true,
    confidence: 0.9,
    lastActivityAt: new Date(now.getTime() - 25 * hour),
    hasEligibleOpenAction: false,
    ...overrides,
  };
}

function action(
  overrides: Partial<Extract<ProactiveSignalSourceSnapshot, { sourceType: "action" }>> = {},
): Extract<ProactiveSignalSourceSnapshot, { sourceType: "action" }> {
  return {
    sourceType: "action",
    sourceId: "action-1",
    groupId: "group-1",
    sourceVersion: 3,
    status: "open",
    retrievalVisible: true,
    confidence: 0.9,
    updatedAt: new Date(now.getTime() - 25 * hour),
    ...overrides,
  };
}

describe("evaluateProactiveSignal", () => {
  it("creates an explainable candidate for an exactly quiet unresolved thread", () => {
    const source = thread({
      lastActivityAt: new Date(now.getTime() - policy.quietThreadMs),
    });

    const result = evaluateProactiveSignal({ source, policy, now });

    expect(result).toMatchObject({
      groupId: "group-1",
      sourceType: "thread",
      sourceId: "thread-1",
      sourceVersion: 2,
      reason: "quiet_unresolved_thread",
      policyVersion: "phase4a-v1",
      sourceActivityAt: source.lastActivityAt,
      eligibleAt: now,
      observedAt: now,
      scoreFactors: {
        base: 0.55,
        quietForMs: policy.quietThreadMs,
        overdueByMs: 0,
      },
    });
    expect(result?.score).toBeGreaterThanOrEqual(0.55);
    expect(result?.score).toBeLessThanOrEqual(0.99);
    expect(result?.explanation).toContain("quiet for 24 hours");
    expect(result?.explanation).toContain("0.90");
    expect(result?.explanation.length).toBeLessThanOrEqual(512);
  });

  it("does not create a thread candidate when an eligible open action already represents it", () => {
    expect(evaluateProactiveSignal({
      source: thread({ hasEligibleOpenAction: true }),
      policy,
      now,
    })).toBeUndefined();
  });

  it.each([
    ["candidate thread", thread({ status: "candidate" })],
    ["resolved thread", thread({ status: "resolved" })],
    ["invalidated thread", thread({ retrievalVisible: false })],
    ["low-confidence thread", thread({ confidence: 0.69 })],
    ["not-yet-quiet thread", thread({ lastActivityAt: new Date(now.getTime() - policy.quietThreadMs + 1) })],
    ["completed action", action({ status: "completed" })],
    ["invalidated action", action({ retrievalVisible: false })],
    ["low-confidence action", action({ confidence: 0.69 })],
    ["not-yet-quiet action", action({ updatedAt: new Date(now.getTime() - policy.quietActionMs + 1) })],
  ])("rejects an ineligible %s", (_label, source) => {
    expect(evaluateProactiveSignal({ source, policy, now })).toBeUndefined();
  });

  it("creates a quiet action candidate at the exact threshold", () => {
    const source = action({
      updatedAt: new Date(now.getTime() - policy.quietActionMs),
    });

    expect(evaluateProactiveSignal({ source, policy, now })).toMatchObject({
      reason: "quiet_open_action",
      eligibleAt: now,
      scoreFactors: {
        base: 0.6,
        quietForMs: policy.quietActionMs,
        overdueByMs: 0,
      },
    });
  });

  it("gives overdue action precedence after the grace period", () => {
    const dueAt = new Date(now.getTime() - policy.overdueGraceMs);
    const source = action({
      updatedAt: new Date(now.getTime() - hour),
      dueAt,
    });

    const result = evaluateProactiveSignal({ source, policy, now });

    expect(result).toMatchObject({
      reason: "overdue_action",
      eligibleAt: now,
      sourceActivityAt: source.updatedAt,
      scoreFactors: {
        base: 0.75,
        quietForMs: hour,
        overdueByMs: policy.overdueGraceMs,
      },
    });
    expect(result?.explanation).toContain("overdue by 30 minutes");
  });

  it("does not classify an action as overdue before the full grace period", () => {
    const source = action({
      updatedAt: new Date(now.getTime() - hour),
      dueAt: new Date(now.getTime() - policy.overdueGraceMs + 1),
    });

    expect(evaluateProactiveSignal({ source, policy, now })).toBeUndefined();
  });

  it("returns stable scores and clamps extreme age contributions", () => {
    const source = action({
      confidence: 1,
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      dueAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    const first = evaluateProactiveSignal({ source, policy, now });
    const second = evaluateProactiveSignal({ source, policy, now });

    expect(first).toEqual(second);
    expect(first?.score).toBe(0.99);
    expect(first?.scoreFactors).toMatchObject({
      confidenceContribution: 0.15,
      ageContribution: 0.15,
      overdueContribution: 0.1,
    });
  });

  it("fails closed for invalid policy, source dates, or a future observation", () => {
    expect(() => evaluateProactiveSignal({
      source: thread(),
      policy: { ...policy, minConfidence: Number.NaN },
      now,
    })).toThrow("proactive signal policy");
    expect(() => evaluateProactiveSignal({
      source: thread({ lastActivityAt: new Date(Number.NaN) }),
      policy,
      now,
    })).toThrow("source activity");
    expect(evaluateProactiveSignal({
      source: thread({ lastActivityAt: new Date(now.getTime() + 1) }),
      policy,
      now,
    })).toBeUndefined();
  });
});
