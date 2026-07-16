import { describe, expect, it } from "vitest";

import type { ProposedActionOperation, ProposedThreadOperation } from "../src/memory-extraction/ai-worker-memory-extraction-client.js";
import {
  type ConversationStateExtractionRun,
  validateConversationStateCandidates,
} from "../src/conversation-state/conversation-state-candidate-validator.js";

describe("validateConversationStateCandidates", () => {
  it("keeps uncertain new topics isolated as candidates", () => {
    const result = validateConversationStateCandidates({
      run: claimedRun(),
      response: responseWithThreadCreate({ confidence: 0.7 }),
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.threadOperations).toEqual([
      expect.objectContaining({ operation: "create", initialStatus: "candidate" }),
    ]);
    expect(result.actionOperations).toEqual([]);
  });

  it("rejects a suggestion as an action even without a question mark", () => {
    const run = claimedRun();
    run.evidenceMessages[0]!.text = "We should ask Ada to ship the launch notes.";
    const result = validateConversationStateCandidates({
      run,
      response: {
        runId: "run-1",
        candidates: [],
        threadOperations: [],
        actionOperations: [{
          operation: "create",
          operationKey: "action:create:notes",
          confidence: 0.9,
          evidenceMessageIds: ["message-1"],
          evidenceSpan: "We should ask Ada",
          description: "Ship the launch notes.",
          owner: { ownerType: "sender", messageId: "message-1" },
        }],
      },
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.actionOperations).toEqual([]);
    expect(result.diagnostics.rejectionCodes).toEqual(["non_commitment_action"]);
  });

  it.each([
    ["missing exact evidence span", (run: any, response: any) => { response.threadOperations[0].evidenceSpan = "invented span"; }, "invalid_evidence"],
    ["cross-group target snapshot", (run: any) => { run.existingThreads = [{ ...existingThread(), groupId: "group-2" }]; }, "invalid_run"],
    ["stale version", (run: any) => { run.existingThreads = [{ ...existingThread(), version: 2 }]; }, "stale_version"],
  ])("rejects %s with a content-free reason", (_name, mutate, code) => {
    const run = claimedRun() as any;
    const response = responseWithExistingThreadOperation();
    mutate(run, response);

    const result = validateConversationStateCandidates({ run, response, candidateFloor: 0.65, applyConfidence: 0.85 });

    expect(result.threadOperations).toEqual([]);
    expect(result.diagnostics.rejectionCodes).toEqual([code]);
  });

  it("rejects an invented persisted mention owner", () => {
    const result = validateConversationStateCandidates({
      run: claimedRun() as any,
      response: responseWithActionCreate({
        owner: { ownerType: "mention", messageId: "message-1", mentionKey: "@Ada" },
      }),
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.actionOperations).toEqual([]);
    expect(result.diagnostics.rejectionCodes).toEqual(["invalid_owner"]);
  });

  it("maps an exact persisted mention owner to its open ID", () => {
    const run = claimedRun() as any;
    run.evidenceMessages[0].mentions = [{ key: "@Ada", openId: "ou_ada" }];
    run.evidenceMessages[0].text = "@Ada will ship the launch notes.";
    const result = validateConversationStateCandidates({
      run,
      response: responseWithActionCreate({
        evidenceSpan: "will ship the launch notes",
        owner: { ownerType: "mention", messageId: "message-1", mentionKey: "@Ada" },
      }),
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.actionOperations).toEqual([
      expect.objectContaining({ ownerRefType: "feishu_user", ownerRef: "ou_ada", ownerResolved: true }),
    ]);
  });

  it("requires exact due-date evidence and rejects duplicate operation keys globally", () => {
    const response = responseWithActionCreate({
      dueAt: "2026-07-20T09:00:00.000Z",
      dueEvidenceSpan: "next Monday",
    });
    response.threadOperations = [{
      ...responseWithThreadCreate().threadOperations[0]!,
      operationKey: "action:create:ship",
    }];
    const result = validateConversationStateCandidates({
      run: claimedRun() as any,
      response,
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.threadOperations).toEqual([]);
    expect(result.actionOperations).toEqual([]);
    expect(result.diagnostics).toEqual(expect.objectContaining({ proposedCount: 2, rejectedCount: 2 }));
    expect(result.diagnostics.rejectionCodes).toEqual(["duplicate_operation_key"]);
  });

  it("sorts accepted operations by operation key and keeps text labels unresolved", () => {
    const response = responseWithActionCreate({
      operationKey: "action:create:z",
      owner: { ownerType: "text_label", messageId: "message-1", label: "Launch" },
    });
    response.actionOperations.push({
      ...response.actionOperations[0]!,
      operationKey: "action:create:a",
      owner: { ownerType: "sender", messageId: "message-1" },
    } as Extract<ProposedActionOperation, { operation: "create" }>);
    const result = validateConversationStateCandidates({
      run: claimedRun() as any,
      response,
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.actionOperations.map((operation) => operation.operationKey)).toEqual(["action:create:a", "action:create:z"]);
    expect(result.actionOperations[1]).toMatchObject({ ownerRefType: "text_label", ownerRef: "Launch", ownerResolved: false });
  });

  it("fails closed without reading an accessor-backed worker response", () => {
    const response = responseWithThreadCreate() as Record<string, unknown>;
    Object.defineProperty(response, "threadOperations", {
      enumerable: true,
      get() {
        throw new Error("worker getter must not execute");
      },
    });

    expect(() => validateConversationStateCandidates({
      run: claimedRun(),
      response: response as unknown as ReturnType<typeof responseWithThreadCreate>,
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    })).not.toThrow();
  });

  it("rejects action corrections that name a thread outside the current run", () => {
    const run = claimedRun() as any;
    run.existingActions = [existingAction()];
    const result = validateConversationStateCandidates({
      run,
      response: {
        runId: "run-1",
        candidates: [],
        threadOperations: [],
        actionOperations: [{
          operation: "correct",
          operationKey: "action:correct:1",
          confidence: 0.9,
          evidenceMessageIds: ["message-1"],
          evidenceSpan: "Launch planning",
          actionId: "action-1",
          expectedVersion: 1,
          correctedFields: ["thread_id"],
          threadId: "thread-not-in-run",
        }],
      },
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.actionOperations).toEqual([]);
    expect(result.diagnostics.rejectionCodes).toEqual(["unknown_thread"]);
  });

  it("accepts an explicit null action-correction thread link as unlink", () => {
    const run = claimedRun() as any;
    run.existingActions = [existingAction()];
    const result = validateConversationStateCandidates({
      run,
      response: {
        runId: "run-1",
        candidates: [],
        threadOperations: [],
        actionOperations: [{
          operation: "correct",
          operationKey: "action:correct:unlink",
          confidence: 0.9,
          evidenceMessageIds: ["message-1"],
          evidenceSpan: "Launch planning",
          actionId: "action-1",
          expectedVersion: 1,
          correctedFields: ["thread_id"],
          threadId: null,
        }],
      },
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.actionOperations).toEqual([
      expect.objectContaining({ correctedFields: ["thread_id"], threadId: null }),
    ]);
    expect(result.diagnostics.rejectionCodes).toEqual([]);
  });

  it.each([
    ["candidate", true],
    ["open", true],
    ["resolved", false],
    ["merged", false],
  ] as const)("%s threads %s attach-evidence validation", (status, accepted) => {
    const run = claimedRun() as any;
    run.existingThreads = [{ ...existingThread(), status }];
    const result = validateConversationStateCandidates({
      run,
      response: {
        runId: "run-1",
        candidates: [],
        threadOperations: [{
          operation: "attach_evidence",
          operationKey: `thread:attach:${status}`,
          confidence: 0.9,
          evidenceMessageIds: ["message-1"],
          evidenceSpan: "Launch planning",
          threadId: "thread-1",
          expectedVersion: 1,
        }],
        actionOperations: [],
      },
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.threadOperations).toHaveLength(accepted ? 1 : 0);
    expect(result.diagnostics.rejectionCodes).toEqual(
      accepted ? [] : [status === "merged" ? "merged_thread_immutable" : "invalid_thread_transition"],
    );
  });

  it.each([
    [0.85, 0.85],
    [0.9, 0.85],
    [-0.01, 0.85],
    [0.65, Number.POSITIVE_INFINITY],
  ])("rejects invalid confidence threshold configuration before diagnostics: %s / %s", (candidateFloor, applyConfidence) => {
    expect(() => validateConversationStateCandidates({
      run: claimedRun(),
      response: responseWithThreadCreate(),
      candidateFloor,
      applyConfidence,
    })).toThrow("conversation state confidence thresholds are invalid");
  });
});

function claimedRun(): ConversationStateExtractionRun {
  return {
    id: "run-1",
    groupId: "group-1",
    inputFingerprint: "a".repeat(64),
    requestIds: ["request-1"],
    evidenceMessages: [{
      id: "message-1",
      groupId: "group-1",
      senderId: "sender-1",
      text: "Launch planning is underway.",
      sentAt: new Date("2026-07-14T00:01:00.000Z"),
      createdAt: new Date("2026-07-14T00:01:01.000Z"),
      evidenceEligible: true,
      mentions: [],
    }],
    contextMessages: [],
    existingMemories: [],
    mentions: [],
    existingThreads: [],
    existingActions: [],
    enabledOperationFamilies: ["thread", "action"] as Array<"thread" | "action">,
  };
}

function responseWithThreadCreate(
  overrides: Partial<Extract<ProposedThreadOperation, { operation: "create" }>> = {},
): { runId: string; candidates: []; threadOperations: ProposedThreadOperation[]; actionOperations: ProposedActionOperation[] } {
  return {
    runId: "run-1",
    candidates: [],
    threadOperations: [{
      operation: "create",
      operationKey: "thread:create:launch",
      confidence: 0.85,
      evidenceMessageIds: ["message-1"],
      evidenceSpan: "Launch planning",
      title: "Launch planning",
      summary: "Launch planning is underway.",
      initialStatus: "open",
      ...overrides,
    } as Extract<ProposedThreadOperation, { operation: "create" }>],
    actionOperations: [],
  };
}

function responseWithExistingThreadOperation(): { runId: string; candidates: []; threadOperations: ProposedThreadOperation[]; actionOperations: ProposedActionOperation[] } {
  return {
    runId: "run-1",
    candidates: [],
    threadOperations: [{
      operation: "update_summary",
      operationKey: "thread:update:launch",
      confidence: 0.9,
      evidenceMessageIds: ["message-1"],
      evidenceSpan: "Launch planning",
      threadId: "thread-1",
      expectedVersion: 1,
      summary: "Launch planning is underway.",
    }],
    actionOperations: [],
  };
}

function responseWithActionCreate(
  overrides: Partial<Extract<ProposedActionOperation, { operation: "create" }>> = {},
): { runId: string; candidates: []; threadOperations: ProposedThreadOperation[]; actionOperations: ProposedActionOperation[] } {
  return {
    runId: "run-1",
    candidates: [],
    threadOperations: [],
    actionOperations: [{
      operation: "create",
      operationKey: "action:create:ship",
      confidence: 0.9,
      evidenceMessageIds: ["message-1"],
      evidenceSpan: "Launch planning is underway",
      description: "Ship the launch notes.",
      owner: { ownerType: "sender", messageId: "message-1" },
      ...overrides,
    }],
  };
}

function existingThread() {
  return {
    id: "thread-1",
    groupId: "group-1",
    title: "Launch",
    summary: "Launch planning is underway.",
    status: "open" as const,
    confidence: 0.9,
    version: 1,
    firstEvidenceAt: new Date("2026-07-14T00:01:00.000Z"),
    lastActivityAt: new Date("2026-07-14T00:01:00.000Z"),
    createdAt: new Date("2026-07-14T00:01:00.000Z"),
    updatedAt: new Date("2026-07-14T00:01:00.000Z"),
  };
}

function existingAction() {
  return {
    id: "action-1",
    groupId: "group-1",
    description: "Ship launch notes.",
    ownerRefType: "feishu_user" as const,
    ownerRef: "sender-1",
    status: "open" as const,
    confidence: 0.9,
    version: 1,
    createdAt: new Date("2026-07-14T00:01:00.000Z"),
    updatedAt: new Date("2026-07-14T00:01:00.000Z"),
  };
}
