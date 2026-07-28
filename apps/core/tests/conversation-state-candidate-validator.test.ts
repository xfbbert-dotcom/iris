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

  it.each([
    ["union-only", { senderId: "on_union", senderUnionId: "on_union" }],
    ["user-only", { senderId: "user_legacy", senderUserId: "user_legacy" }],
  ])("rejects a sender owner backed by a %s identity", (_name, identity) => {
    const run = claimedRun() as any;
    Object.assign(run.evidenceMessages[0], identity);
    delete run.evidenceMessages[0].senderOpenId;

    const result = validateConversationStateCandidates({
      run,
      response: responseWithActionCreate(),
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.actionOperations).toEqual([]);
    expect(result.diagnostics.rejectionCodes).toEqual(["invalid_owner"]);
  });

  it("binds a sender owner only to the persisted Feishu open ID", () => {
    const run = claimedRun() as any;
    run.evidenceMessages[0].senderId = "generic-attribution";
    run.evidenceMessages[0].senderOpenId = "ou_trusted";

    const result = validateConversationStateCandidates({
      run,
      response: responseWithActionCreate(),
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.actionOperations).toEqual([
      expect.objectContaining({
        ownerRefType: "feishu_user",
        ownerRef: "ou_trusted",
        ownerResolved: true,
      }),
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

  it("accepts only the first sorted operation that consumes an existing thread version", () => {
    const run = claimedRun();
    run.existingThreads = [existingThread()];
    const response = responseWithExistingThreadOperation();
    const update = response.threadOperations[0] as Extract<ProposedThreadOperation, { operation: "update_summary" }>;
    response.threadOperations = [
      { ...update, operationKey: "thread:update:z", summary: "Launch planning z." },
      { ...update, operationKey: "thread:update:a", summary: "Launch planning a." },
    ];

    const result = validateConversationStateCandidates({
      run,
      response,
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.threadOperations).toEqual([
      expect.objectContaining({ operationKey: "thread:update:a", summary: "Launch planning a." }),
    ]);
    expect(result.diagnostics).toEqual({
      proposedCount: 2,
      acceptedCount: 1,
      rejectedCount: 1,
      threadProposedCount: 2,
      threadAcceptedCount: 1,
      threadRejectedCount: 1,
      actionProposedCount: 0,
      actionAcceptedCount: 0,
      actionRejectedCount: 0,
      rejectionCodes: ["stale_version"],
    });
  });

  it("rejects a noncanonical merge target using persisted evidence counts", () => {
    const run = claimedRun();
    run.existingThreads = [
      { ...existingThread(), id: "thread-source", evidenceCount: 5 },
      { ...existingThread(), id: "thread-target", evidenceCount: 1 },
    ];
    const response = responseWithExistingThreadOperation();
    response.threadOperations = [{
      operation: "merge",
      operationKey: "thread:merge:noncanonical",
      confidence: 0.9,
      evidenceMessageIds: ["message-1"],
      evidenceSpan: "Launch planning",
      sourceThreadId: "thread-source",
      targetThreadId: "thread-target",
      expectedVersion: 1,
    }];

    const result = validateConversationStateCandidates({ run, response, candidateFloor: 0.65, applyConfidence: 0.85 });

    expect(result.threadOperations).toEqual([]);
    expect(result.diagnostics.rejectionCodes).toEqual(["noncanonical_merge_target"]);
  });

  it("rejects later conflicting merges after the first sorted merge advances simulated state", () => {
    const run = claimedRun();
    run.existingThreads = [
      { ...existingThread(), id: "thread-source", status: "candidate", evidenceCount: 1 },
      { ...existingThread(), id: "thread-target-a", evidenceCount: 2 },
      { ...existingThread(), id: "thread-target-z", evidenceCount: 1 },
    ];
    const merge = {
      operation: "merge" as const,
      confidence: 0.9,
      evidenceMessageIds: ["message-1"],
      evidenceSpan: "Launch planning",
      sourceThreadId: "thread-source",
      expectedVersion: 1,
    };
    const response = responseWithExistingThreadOperation();
    response.threadOperations = [
      { ...merge, operationKey: "thread:merge:z", targetThreadId: "thread-target-z" },
      { ...merge, operationKey: "thread:merge:a", targetThreadId: "thread-target-a" },
    ];

    const result = validateConversationStateCandidates({ run, response, candidateFloor: 0.65, applyConfidence: 0.85 });

    expect(result.threadOperations.map((operation) => operation.operationKey)).toEqual(["thread:merge:a"]);
    expect(result.diagnostics.rejectionCodes).toEqual(["stale_version"]);
  });

  it("rejects a merge that depends on target evidence touched earlier in the batch", () => {
    const run = claimedRun();
    run.existingThreads = [
      { ...existingThread(), id: "thread-source", status: "candidate", evidenceCount: 1 },
      { ...existingThread(), id: "thread-target", evidenceCount: 1 },
    ];
    const response = responseWithExistingThreadOperation();
    response.threadOperations = [
      {
        operation: "attach_evidence",
        operationKey: "a:thread:attach-target",
        confidence: 0.9,
        evidenceMessageIds: ["message-1"],
        evidenceSpan: "Launch planning",
        threadId: "thread-target",
        expectedVersion: 1,
      },
      {
        operation: "merge",
        operationKey: "b:thread:merge",
        confidence: 0.9,
        evidenceMessageIds: ["message-1"],
        evidenceSpan: "Launch planning",
        sourceThreadId: "thread-source",
        targetThreadId: "thread-target",
        expectedVersion: 1,
      },
    ];

    const result = validateConversationStateCandidates({ run, response, candidateFloor: 0.65, applyConfidence: 0.85 });

    expect(result.threadOperations.map((operation) => operation.operationKey)).toEqual([
      "a:thread:attach-target",
    ]);
    expect(result.diagnostics.rejectionCodes).toEqual(["batch_evidence_dependency"]);
  });

  it("prefers batch evidence dependency when target evidence could flip canonical selection", () => {
    const run = claimedRun();
    run.existingThreads = [
      {
        ...existingThread(),
        id: "thread-source",
        evidenceCount: 2,
        createdAt: new Date("2026-07-14T00:02:00.000Z"),
      },
      {
        ...existingThread(),
        id: "thread-target",
        evidenceCount: 1,
        createdAt: new Date("2026-07-14T00:01:00.000Z"),
      },
    ];
    const response = responseWithExistingThreadOperation();
    response.threadOperations = [
      {
        operation: "attach_evidence",
        operationKey: "a:thread:attach-target",
        confidence: 0.9,
        evidenceMessageIds: ["message-1"],
        evidenceSpan: "Launch planning",
        threadId: "thread-target",
        expectedVersion: 1,
      },
      {
        operation: "merge",
        operationKey: "b:thread:merge",
        confidence: 0.9,
        evidenceMessageIds: ["message-1"],
        evidenceSpan: "Launch planning",
        sourceThreadId: "thread-source",
        targetThreadId: "thread-target",
        expectedVersion: 1,
      },
    ];

    const result = validateConversationStateCandidates({ run, response, candidateFloor: 0.65, applyConfidence: 0.85 });

    expect(result.threadOperations.map((operation) => operation.operationKey)).toEqual([
      "a:thread:attach-target",
    ]);
    expect(result.diagnostics.rejectionCodes).toEqual(["batch_evidence_dependency"]);
  });

  it("rejects a merge that depends on source evidence touched earlier in the batch", () => {
    const run = claimedRun();
    run.existingThreads = [
      { ...existingThread(), id: "thread-source", evidenceCount: 1 },
      { ...existingThread(), id: "thread-target", evidenceCount: 5 },
    ];
    const response = responseWithExistingThreadOperation();
    response.threadOperations = [
      {
        operation: "update_summary",
        operationKey: "a:thread:update-source",
        confidence: 0.9,
        evidenceMessageIds: ["message-1"],
        evidenceSpan: "Launch planning",
        threadId: "thread-source",
        expectedVersion: 1,
        summary: "Updated launch planning.",
      },
      {
        operation: "merge",
        operationKey: "b:thread:merge",
        confidence: 0.9,
        evidenceMessageIds: ["message-1"],
        evidenceSpan: "Launch planning",
        sourceThreadId: "thread-source",
        targetThreadId: "thread-target",
        expectedVersion: 2,
      },
    ];

    const result = validateConversationStateCandidates({ run, response, candidateFloor: 0.65, applyConfidence: 0.85 });

    expect(result.threadOperations.map((operation) => operation.operationKey)).toEqual([
      "a:thread:update-source",
    ]);
    expect(result.diagnostics.rejectionCodes).toEqual(["batch_evidence_dependency"]);
  });

  it("rejects an action dependency after an earlier sorted operation merges its thread", () => {
    const run = claimedRun();
    run.existingThreads = [
      { ...existingThread(), id: "thread-source", status: "candidate", evidenceCount: 1 },
      { ...existingThread(), id: "thread-target", evidenceCount: 2 },
    ];
    const response = responseWithActionCreate({
      operationKey: "z:action:create",
      threadId: "thread-source",
    });
    response.threadOperations = [{
      operation: "merge",
      operationKey: "a:thread:merge",
      confidence: 0.9,
      evidenceMessageIds: ["message-1"],
      evidenceSpan: "Launch planning",
      sourceThreadId: "thread-source",
      targetThreadId: "thread-target",
      expectedVersion: 1,
    }];

    const result = validateConversationStateCandidates({ run, response, candidateFloor: 0.65, applyConfidence: 0.85 });

    expect(result.threadOperations).toHaveLength(1);
    expect(result.actionOperations).toEqual([]);
    expect(result.diagnostics.rejectionCodes).toEqual(["invalid_dependency"]);
  });

  it.each(["complete", "cancel", "resolve_owner"] as const)(
    "terminally rejects merge plus %s for an action on the merge source",
    (operation) => {
      const run = claimedRun() as any;
      run.existingThreads = [
        { ...existingThread(), id: "thread-source", evidenceCount: 1 },
        { ...existingThread(), id: "thread-target", evidenceCount: 2 },
      ];
      run.existingActions = [{
        ...existingAction(),
        id: "action-source",
        threadId: "thread-source",
      }];
      const actionOperation = {
        operation,
        operationKey: `a:action:${operation}`,
        confidence: 0.9,
        evidenceMessageIds: ["message-1"],
        evidenceSpan: "Launch planning",
        actionId: "action-source",
        expectedVersion: 1,
        ...(operation === "resolve_owner"
          ? { owner: { ownerType: "sender" as const, messageId: "message-1" } }
          : {}),
      } as ProposedActionOperation;

      const result = validateConversationStateCandidates({
        run,
        response: {
          runId: "run-1",
          candidates: [],
          threadOperations: [{
            operation: "merge",
            operationKey: "z:thread:merge",
            confidence: 0.9,
            evidenceMessageIds: ["message-1"],
            evidenceSpan: "Launch planning",
            sourceThreadId: "thread-source",
            targetThreadId: "thread-target",
            expectedVersion: 1,
          }],
          actionOperations: [actionOperation],
        },
        candidateFloor: 0.65,
        applyConfidence: 0.85,
      });

      expect(result.threadOperations).toEqual([]);
      expect(result.actionOperations).toEqual([]);
      expect(result.diagnostics).toMatchObject({
        proposedCount: 2,
        acceptedCount: 0,
        rejectedCount: 2,
        rejectionCodes: ["merge_action_batch_conflict"],
      });
    },
  );

  it("accepts an explicit action commitment linked to a candidate thread", () => {
    const run = claimedRun() as any;
    run.existingThreads = [{ ...existingThread(), status: "candidate" }];

    const result = validateConversationStateCandidates({
      run,
      response: responseWithActionCreate({ threadId: "thread-1" }),
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.actionOperations).toEqual([
      expect.objectContaining({
        operation: "create",
        threadId: "thread-1",
        ownerRefType: "feishu_user",
        ownerRef: "sender-1",
      }),
    ]);
    expect(result.diagnostics.rejectionCodes).toEqual([]);
  });

  it.each([
    ["unknown", []],
    ["merged", [{ ...existingThread(), status: "merged" as const }]],
  ])("rejects an action create linked to an %s thread", (_name, existingThreads) => {
    const run = claimedRun() as any;
    run.existingThreads = existingThreads;

    const result = validateConversationStateCandidates({
      run,
      response: responseWithActionCreate({ threadId: "thread-1" }),
      candidateFloor: 0.65,
      applyConfidence: 0.85,
    });

    expect(result.actionOperations).toEqual([]);
    expect(result.diagnostics.rejectionCodes).toEqual(["invalid_dependency"]);
  });

  it.each(["correct", "reopen"] as const)(
    "rejects %s action state that depends on a candidate thread",
    (operation) => {
      const run = claimedRun() as any;
      run.existingThreads = [{ ...existingThread(), status: "candidate" }];
      run.existingActions = [{
        ...existingAction(),
        threadId: "thread-1",
        ...(operation === "reopen"
          ? { status: "completed", completedAt: new Date("2026-07-14T00:02:00.000Z") }
          : {}),
      }];
      const actionOperation = operation === "correct"
        ? {
            operation: "correct",
            operationKey: "action:correct:candidate",
            confidence: 0.9,
            evidenceMessageIds: ["message-1"],
            evidenceSpan: "Launch planning",
            actionId: "action-1",
            expectedVersion: 1,
            correctedFields: ["description"],
            description: "Ship corrected launch notes.",
          }
        : {
            operation: "reopen",
            operationKey: "action:reopen:candidate",
            confidence: 0.9,
            evidenceMessageIds: ["message-1"],
            evidenceSpan: "Launch planning",
            actionId: "action-1",
            expectedVersion: 1,
          };

      const result = validateConversationStateCandidates({
        run,
        response: {
          runId: "run-1",
          candidates: [],
          threadOperations: [],
          actionOperations: [actionOperation as ProposedActionOperation],
        },
        candidateFloor: 0.65,
        applyConfidence: 0.85,
      });

      expect(result.actionOperations).toEqual([]);
      expect(result.diagnostics.rejectionCodes).toEqual(["invalid_dependency"]);
    },
  );

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
    expect(result.diagnostics.rejectionCodes).toEqual(["invalid_dependency"]);
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
      senderOpenId: "sender-1",
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
    evidenceCount: 1,
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
