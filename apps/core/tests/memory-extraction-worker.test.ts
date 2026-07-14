import { describe, expect, it, vi } from "vitest";

import { AiWorkerMemoryExtractionError } from "../src/memory-extraction/ai-worker-memory-extraction-client.js";
import type {
  MemoryExtractionJob,
  MemoryExtractionQueue,
} from "../src/memory-extraction/memory-extraction-queue.js";
import type {
  ClaimedMemoryExtractionRun,
  MemoryExtractionRepository,
} from "../src/memory-extraction/memory-extraction-repository.js";
import { MemoryExtractionStaleRunError } from "../src/memory-extraction/memory-extraction-repository.js";
import { createMemoryExtractionWorker } from "../src/memory-extraction/memory-extraction-worker.js";

const NOW = new Date("2026-07-15T00:00:00.000Z");

describe("createMemoryExtractionWorker", () => {
  it("dequeues once and applies one canonical run for all covered same-group jobs", async () => {
    const jobs = [job("request-1"), job("request-2")];
    const claimedRun = run();
    const dependencies = createDependencies({ jobs, claimedRun });
    const candidates = [
      candidate({
        category: "workflow",
        content: "Use the release checklist.",
        evidenceMessageIds: ["feishu:msg-2"],
      }),
      candidate({ content: "Launch on Thursday." }),
    ];
    const candidateSnapshot = structuredClone(candidates);
    dependencies.client.extract.mockResolvedValue({ runId: "run-1", candidates });
    dependencies.repository.completeRun.mockResolvedValue({
      status: "completed",
      memoryIds: ["memory-1", "memory-2"],
    });
    const worker = createMemoryExtractionWorker(dependencies);

    const results = await worker.processBatch({ limit: 20 });

    expect(dependencies.queue.dequeueBatch).toHaveBeenCalledOnce();
    expect(dependencies.queue.dequeueBatch).toHaveBeenCalledWith(20, NOW);
    expect(dependencies.repository.claimRun).toHaveBeenCalledOnce();
    expect(dependencies.repository.claimRun).toHaveBeenCalledWith({
      seedRequestId: "request-1",
      maxEvidenceMessages: 40,
      contextMessageLimit: 10,
      activeMemoryLimit: 8,
    });
    expect(dependencies.client.extract).toHaveBeenCalledOnce();
    expect(dependencies.repository.completeRun).toHaveBeenCalledWith({
      runId: "run-1",
      inputFingerprint: "f".repeat(64),
      acceptedCandidates: [
        expect.objectContaining({ category: "decision", content: "Launch on Thursday." }),
        expect.objectContaining({
          category: "workflow",
          content: "Use the release checklist.",
        }),
      ],
      diagnostics: expect.objectContaining({ acceptedCount: 2, rejectedCount: 0 }),
    });
    expect(dependencies.queue.handleProcessedJob).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      expect.objectContaining({
        status: "completed",
        requestId: "request-1",
        runId: "run-1",
        memoryIds: ["memory-1", "memory-2"],
      }),
      expect.objectContaining({
        status: "completed",
        requestId: "request-2",
        runId: "run-1",
        memoryIds: ["memory-1", "memory-2"],
      }),
    ]);
    expect(candidates).toEqual(candidateSnapshot);
    expect(claimedRun.requestIds).toEqual(["request-1", "request-2"]);
  });

  it("permanently skips and ACKs disabled requests before claim or content load", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1"), job("request-2")] });
    dependencies.runtimeController.canReadGroupContext.mockReturnValue(false);
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({
        status: "skipped",
        requestId: "request-1",
        reason: "runtime_disabled_before_load",
      }),
      expect.objectContaining({
        status: "skipped",
        requestId: "request-2",
        reason: "runtime_disabled_before_load",
      }),
    ]);

    expect(dependencies.repository.skipRequest.mock.calls).toEqual([
      [{ requestId: "request-1", reason: "runtime_disabled_before_load" }],
      [{ requestId: "request-2", reason: "runtime_disabled_before_load" }],
    ]);
    expect(dependencies.queue.handleProcessedJob).toHaveBeenCalledTimes(2);
    expect(dependencies.repository.claimRun).not.toHaveBeenCalled();
    expect(dependencies.repository.loadRunInput).not.toHaveBeenCalled();
    expect(dependencies.client.extract).not.toHaveBeenCalled();
  });

  it("permanently skips a run when policy changes immediately before apply", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1"), job("request-2")] });
    dependencies.runtimeController.canReadGroupContext
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({ status: "skipped", reason: "runtime_disabled_before_apply" }),
      expect.objectContaining({ status: "skipped", reason: "runtime_disabled_before_apply" }),
    ]);

    expect(dependencies.repository.skipRun).toHaveBeenCalledWith({
      runId: "run-1",
      reason: "runtime_disabled_before_apply",
    });
    expect(dependencies.repository.completeRun).not.toHaveBeenCalled();
    expect(dependencies.queue.handleProcessedJob).toHaveBeenCalledTimes(2);
  });

  it("ACKs a completed duplicate without a model or apply call", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    dependencies.repository.claimRun.mockResolvedValue(undefined);
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({ status: "skipped", reason: "already_terminal" }),
    ]);
    expect(dependencies.queue.handleProcessedJob).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "request-1" }),
    );
    expect(dependencies.client.extract).not.toHaveBeenCalled();
    expect(dependencies.repository.completeRun).not.toHaveBeenCalled();
  });

  it("requeues a stale run without ACK, model, or apply", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    dependencies.repository.loadRunInput.mockResolvedValue({
      status: "stale",
      groupId: "chat-a",
      requestIds: ["request-1", "request-2"],
    });
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        classification: "input_stale",
        retryAction: "requeued",
      }),
    ]);
    expect(dependencies.queue.handleFailedJob).toHaveBeenCalledWith({
      job: expect.objectContaining({ requestId: "request-1" }),
      errorMessage: "internal_error",
      retryAt: new Date("2026-07-15T00:00:30.000Z"),
    });
    expect(dependencies.queue.handleProcessedJob).not.toHaveBeenCalled();
    expect(dependencies.client.extract).not.toHaveBeenCalled();
  });

  it("requeues a stale run detected during claim instead of ACKing it as terminal", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    dependencies.repository.claimRun.mockRejectedValue(new MemoryExtractionStaleRunError());
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        classification: "input_stale",
        retryAction: "requeued",
      }),
    ]);
    expect(dependencies.queue.handleProcessedJob).not.toHaveBeenCalled();
    expect(dependencies.client.extract).not.toHaveBeenCalled();
  });

  it.each([
    ["timeout", "provider_timeout"],
    ["unavailable", "provider_unavailable"],
  ] as const)("maps model %s to a bounded delayed retry", async (code, classification) => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    dependencies.client.extract.mockRejectedValue(
      new AiWorkerMemoryExtractionError(code, true),
    );
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({ status: "failed", classification, retryAction: "requeued" }),
    ]);
    expect(dependencies.repository.failRun).toHaveBeenCalledWith({
      runId: "run-1",
      classification,
    });
    expect(dependencies.queue.handleFailedJob).toHaveBeenCalledWith({
      job: expect.objectContaining({ requestId: "request-1" }),
      errorMessage: classification,
      retryAt: new Date("2026-07-15T00:00:30.000Z"),
    });
  });

  it("opens a shared bounded cooldown for 429 and delays the covered jobs", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1"), job("request-2")] });
    dependencies.client.extract.mockRejectedValue(
      new AiWorkerMemoryExtractionError("rate_limited", true, 100_000_000),
    );
    const worker = createMemoryExtractionWorker(dependencies);

    const results = await worker.processBatch({ limit: 20 });

    const expectedCooldown = new Date("2026-07-16T00:00:00.000Z");
    expect(dependencies.queue.setProviderCooldown).toHaveBeenCalledWith(expectedCooldown);
    expect(dependencies.queue.handleFailedJob).toHaveBeenCalledTimes(2);
    expect(dependencies.queue.handleFailedJob).toHaveBeenNthCalledWith(1, {
      job: expect.objectContaining({ requestId: "request-1" }),
      errorMessage: "provider_rate_limited",
      retryAt: expectedCooldown,
    });
    expect(results).toEqual([
      expect.objectContaining({ classification: "provider_rate_limited" }),
      expect.objectContaining({ classification: "provider_rate_limited" }),
    ]);
  });

  it("honors a shared cooldown without claiming or calling the model", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    const cooldown = new Date("2026-07-15T00:15:00.000Z");
    dependencies.queue.getProviderCooldown.mockResolvedValue(cooldown);
    const worker = createMemoryExtractionWorker(dependencies);

    await worker.processBatch({ limit: 20 });

    expect(dependencies.repository.claimRun).not.toHaveBeenCalled();
    expect(dependencies.client.extract).not.toHaveBeenCalled();
    expect(dependencies.queue.handleFailedJob).toHaveBeenCalledWith({
      job: expect.objectContaining({ requestId: "request-1" }),
      errorMessage: "provider_rate_limited",
      retryAt: cooldown,
    });
  });

  it("classifies unauthorized as terminal and does not schedule a delayed retry", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    dependencies.client.extract.mockRejectedValue(
      new AiWorkerMemoryExtractionError("unauthorized", false),
    );
    dependencies.queue.handleFailedJob.mockResolvedValue({
      action: "dead_lettered",
      attempts: 1,
    });
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        classification: "provider_unauthorized",
        retryAction: "dead_lettered",
      }),
    ]);
    expect(dependencies.repository.failRun).toHaveBeenCalledWith({
      runId: "run-1",
      classification: "provider_unauthorized",
    });
    expect(dependencies.queue.handleFailedJob).toHaveBeenCalledWith({
      job: expect.objectContaining({ requestId: "request-1" }),
      errorMessage: "internal_error",
    });
  });

  it("does not repeat the model for an automatically requeued terminal run", async () => {
    const dependencies = createDependencies({
      jobs: [job("request-1", "chat-a", 1)],
      claimedRun: run({ previousFailureClassification: "provider_unauthorized" }),
    });
    const worker = createMemoryExtractionWorker(dependencies);

    await worker.processBatch({ limit: 20 });

    expect(dependencies.client.extract).not.toHaveBeenCalled();
    expect(dependencies.repository.completeRun).not.toHaveBeenCalled();
    expect(dependencies.queue.handleFailedJob).toHaveBeenCalledWith({
      job: expect.objectContaining({ requestId: "request-1", attempts: 1 }),
      errorMessage: "internal_error",
    });
  });

  it.each([
    [undefined, "invalid_model_response_retry", true],
    ["invalid_model_response_retry", "invalid_model_response_terminal", false],
  ] as const)(
    "retries an invalid response exactly once (previous=%s)",
    async (previousFailureClassification, expectedClassification, delayed) => {
      const dependencies = createDependencies({
        jobs: [job("request-1", "chat-a", previousFailureClassification === undefined ? 0 : 1)],
        claimedRun: run(
          previousFailureClassification === undefined
            ? {}
            : { previousFailureClassification },
        ),
      });
      dependencies.client.extract.mockRejectedValue(
        new AiWorkerMemoryExtractionError("invalid_response", true),
      );
      const worker = createMemoryExtractionWorker(dependencies);

      await worker.processBatch({ limit: 20 });

      expect(dependencies.repository.failRun).toHaveBeenCalledWith({
        runId: "run-1",
        classification: expectedClassification,
      });
      expect(dependencies.queue.handleFailedJob).toHaveBeenCalledWith({
        job: expect.objectContaining({ requestId: "request-1" }),
        errorMessage: "invalid_model_response",
        ...(delayed ? { retryAt: new Date("2026-07-15T00:00:30.000Z") } : {}),
      });
    },
  );

  it("deterministically completes an empty accepted set with bounded diagnostics", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    dependencies.client.extract.mockResolvedValue({
      runId: "run-1",
      candidates: [candidate({ confidence: 0.5, content: "Rejected model text" })],
    });
    const worker = createMemoryExtractionWorker(dependencies);

    await worker.processBatch({ limit: 20 });

    expect(dependencies.repository.completeRun).toHaveBeenCalledWith({
      runId: "run-1",
      inputFingerprint: "f".repeat(64),
      acceptedCandidates: [],
      diagnostics: {
        proposedCount: 1,
        acceptedCount: 0,
        rejectedCount: 1,
        duplicateCount: 0,
        conflictCount: 0,
        rejectionCodes: ["low_confidence"],
      },
    });
    expect(dependencies.auditLog.record).toHaveBeenCalledWith({
      type: "memory_extraction_completed",
      documentId: "run-1",
      fragmentIds: ["feishu:msg-1", "feishu:msg-2"],
      message: "completed",
    });
    expect(JSON.stringify(dependencies.auditLog.record.mock.calls)).not.toContain(
      "Rejected model text",
    );
  });

  it("retries a processed ACK and reports success only after the ACK is durable", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    dependencies.queue.handleProcessedJob
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce(undefined);
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({ status: "completed", requestId: "request-1" }),
    ]);
    expect(dependencies.queue.handleProcessedJob).toHaveBeenCalledTimes(2);
    expect(dependencies.queue.handleFailedJob).not.toHaveBeenCalled();
  });

  it("requeues after repeated ACK failure instead of falsely reporting completion", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    dependencies.queue.handleProcessedJob.mockRejectedValue(new Error("redis unavailable"));
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        classification: "queue_handler_error",
        retryAction: "requeued",
      }),
    ]);
    expect(dependencies.queue.handleProcessedJob).toHaveBeenCalledTimes(3);
    expect(dependencies.queue.handleFailedJob).toHaveBeenCalledWith({
      job: expect.objectContaining({ requestId: "request-1" }),
      errorMessage: "internal_error",
      retryAt: new Date("2026-07-15T00:00:30.000Z"),
    });
  });

  it("isolates audit sink failure after commit and reports only a bounded observer error", async () => {
    const onAuditError = vi.fn();
    const dependencies = createDependencies({ jobs: [job("request-1")], onAuditError });
    dependencies.auditLog.record.mockRejectedValue(
      new Error("secret candidate and provider-token-value"),
    );
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(dependencies.repository.completeRun).toHaveBeenCalledOnce();
    expect(dependencies.queue.handleProcessedJob).toHaveBeenCalledOnce();
    expect(onAuditError).toHaveBeenCalledOnce();
    expect(String(onAuditError.mock.calls[0]?.[0])).toBe("Error: memory extraction audit failed");
    expect(String(onAuditError.mock.calls[0]?.[0])).not.toContain("provider-token-value");
  });

  it("rejects fractional and unsafe limits and caps direct batches", async () => {
    const dependencies = createDependencies({ jobs: [] });
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 1.5 })).rejects.toThrow(
      "memory extraction worker batch limit must be a safe integer",
    );
    await expect(
      worker.processBatch({ limit: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toThrow(
      "memory extraction worker batch limit must be a finite safe-magnitude number",
    );
    await worker.processBatch({ limit: 101 });
    expect(dependencies.queue.dequeueBatch).toHaveBeenLastCalledWith(100, NOW);
  });
});

function createDependencies(input: {
  jobs: MemoryExtractionJob[];
  claimedRun?: ClaimedMemoryExtractionRun;
  onAuditError?: (error: unknown) => void;
}) {
  const claimedRun = input.claimedRun ?? run();
  const queue = {
    enqueue: vi.fn(async () => undefined),
    dequeueBatch: vi.fn(async () => input.jobs),
    handleProcessedJob: vi.fn(async () => undefined),
    handleFailedJob: vi.fn(
      async (): Promise<Awaited<ReturnType<MemoryExtractionQueue["handleFailedJob"]>>> => ({
        action: "requeued",
        attempts: 1,
      }),
    ),
    getPendingCount: vi.fn(async () => 0),
    getProcessingCount: vi.fn(async () => 0),
    getDelayedCount: vi.fn(async () => 0),
    getDeadLetterCount: vi.fn(async () => 0),
    getProviderCooldown: vi.fn(async (): Promise<Date | undefined> => undefined),
    setProviderCooldown: vi.fn(async () => undefined),
    listDeadLetters: vi.fn(async () => []),
    replayDeadLetter: vi.fn(async () => "not_found" as const),
    deleteDeadLetter: vi.fn(async () => "not_found" as const),
    replayDeadLetters: vi.fn(async () => ({
      replayedCount: 0,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    })),
  };
  const repository = {
    registerRequest: vi.fn(),
    claimRun: vi.fn(async () => claimedRun as ClaimedMemoryExtractionRun | undefined),
    loadRunInput: vi.fn(
      async (): Promise<
        Awaited<ReturnType<MemoryExtractionRepository["loadRunInput"]>>
      > => ({ status: "ready", run: claimedRun }),
    ),
    skipRequest: vi.fn(async () => undefined),
    skipRun: vi.fn(async () => undefined),
    failRun: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => ({
      status: "completed" as const,
      memoryIds: ["memory-1"],
    })),
    getStatusCounts: vi.fn(async () => ({
      pending: 0,
      processing: 0,
      completed: 0,
      skipped: 0,
      failedRuns: 0,
    })),
  };
  const client = {
    checkHealth: vi.fn(async () => true),
    extract: vi.fn(async () => ({
      runId: claimedRun.id,
      candidates: [candidate()],
    })),
  };
  const auditLog = {
    record: vi.fn(async () => undefined),
  };
  const runtimeController = {
    canProcessIncomingEvent: vi.fn(() => true),
    canReadGroupContext: vi.fn(() => true),
  };
  return {
    queue,
    repository,
    client,
    auditLog,
    runtimeController,
    now: () => new Date(NOW),
    ...(input.onAuditError === undefined ? {} : { onAuditError: input.onAuditError }),
  };
}

function job(requestId: string, groupId = "chat-a", attempts = 0): MemoryExtractionJob {
  return {
    schemaVersion: 1,
    idempotencyKey: `memory-extraction:${requestId}`,
    requestId,
    groupId,
    enqueuedAt: new Date(NOW),
    notBefore: new Date(NOW),
    attempts,
  };
}

function run(overrides: Partial<ClaimedMemoryExtractionRun> = {}): ClaimedMemoryExtractionRun {
  return {
    id: "run-1",
    groupId: "chat-a",
    inputFingerprint: "f".repeat(64),
    requestIds: ["request-1", "request-2"],
    evidenceMessages: [
      extractionMessage("feishu:msg-1", "Launch on Thursday."),
      extractionMessage("feishu:msg-2", "Use the release checklist."),
    ],
    contextMessages: [],
    existingMemories: [],
    ...overrides,
  };
}

function extractionMessage(id: string, text: string) {
  return {
    id,
    groupId: "chat-a",
    senderId: "alice",
    text,
    sentAt: new Date("2026-07-14T23:59:00.000Z"),
    createdAt: new Date("2026-07-14T23:59:00.000Z"),
    evidenceEligible: true,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    category: "decision" as const,
    content: "Launch on Thursday.",
    importance: 4,
    confidence: 0.9,
    evidenceMessageIds: ["feishu:msg-1"],
    relation: "new" as const,
    ...overrides,
  };
}
