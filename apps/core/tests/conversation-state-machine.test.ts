import { describe, expect, it } from "vitest";

import {
  selectCanonicalMergeTarget,
  validateActionTransition,
  validateThreadTransition,
} from "../src/conversation-state/conversation-state-machine.js";

describe("conversation state machine", () => {
  it.each([
    ["candidate", "candidate", "corrected"],
    ["candidate", "candidate", "evidence_attached"],
    ["candidate", "open", "promoted"],
    ["candidate", "merged", "merged"],
    ["open", "open", "summary_updated"],
    ["open", "open", "corrected"],
    ["open", "open", "evidence_attached"],
    ["open", "resolved", "resolved"],
    ["open", "merged", "merged"],
    ["resolved", "resolved", "corrected"],
    ["resolved", "open", "reopened"],
    ["resolved", "merged", "merged"],
  ] as const)("allows thread %s -> %s through %s", (from, to, eventType) => {
    expect(validateThreadTransition({ from, to, eventType })).toEqual({ ok: true });
  });

  it("rejects changes to an already merged thread", () => {
    expect(validateThreadTransition({
      from: "merged",
      to: "open",
      eventType: "reopened",
    })).toEqual({ ok: false, code: "merged_thread_immutable" });
  });

  it("requires a resolved thread to reopen before new evidence can be attached", () => {
    expect(validateThreadTransition({
      from: "resolved",
      to: "resolved",
      eventType: "evidence_attached" as never,
    })).toEqual({ ok: false, code: "invalid_thread_transition" });
  });

  it("rejects thread event types which do not describe the requested transition", () => {
    expect(validateThreadTransition({
      from: "open",
      to: "resolved",
      eventType: "corrected",
    })).toEqual({ ok: false, code: "invalid_thread_transition" });
  });

  it.each([
    ["open", "completed", "completed"],
    ["open", "cancelled", "cancelled"],
    ["open", "open", "corrected"],
    ["open", "open", "owner_resolved"],
    ["completed", "open", "reopened"],
    ["completed", "completed", "corrected"],
    ["completed", "completed", "owner_resolved"],
    ["cancelled", "open", "reopened"],
    ["cancelled", "cancelled", "corrected"],
    ["cancelled", "cancelled", "owner_resolved"],
  ] as const)("allows action %s -> %s through %s", (from, to, eventType) => {
    expect(validateActionTransition({ from, to, eventType, evidenceCount: 1 })).toEqual({ ok: true });
  });

  it("rejects action completion without explicit evidence", () => {
    expect(validateActionTransition({
      from: "open",
      to: "completed",
      eventType: "completed",
      evidenceCount: 0,
    })).toEqual({ ok: false, code: "completion_evidence_required" });
  });

  it("selects a canonical merge target deterministically", () => {
    expect(selectCanonicalMergeTarget([
      { id: "resolved-more-evidence", status: "resolved", evidenceCount: 8, createdAt: new Date("2026-07-15T00:00:00Z") },
      { id: "open-later", status: "open", evidenceCount: 1, createdAt: new Date("2026-07-16T00:00:00Z") },
      { id: "open-earlier", status: "open", evidenceCount: 1, createdAt: new Date("2026-07-14T00:00:00Z") },
      { id: "candidate", status: "candidate", evidenceCount: 99, createdAt: new Date("2026-07-01T00:00:00Z") },
    ])).toBe("open-earlier");
  });

  it("uses id as the final canonical merge tie-breaker", () => {
    expect(selectCanonicalMergeTarget([
      { id: "thread-b", status: "open", evidenceCount: 2, createdAt: new Date("2026-07-15T00:00:00Z") },
      { id: "thread-a", status: "open", evidenceCount: 2, createdAt: new Date("2026-07-15T00:00:00Z") },
    ])).toBe("thread-a");
  });
});
