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
      requestIds: ["request-1", "request-2"],
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
      conflictCandidates: [],
      diagnostics: expect.objectContaining({ acceptedCount: 2, rejectedCount: 0 }),
      threadOperations: [],
      actionOperations: [],
      conversationStateDiagnostics: { proposedCount: 0, acceptedCount: 0, rejectedCount: 0, rejectionCodes: [] },
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

  it("applies the configured minimum confidence during candidate validation", async () => {
    const dependencies = {
      ...createDependencies({ jobs: [job("request-1")] }),
      minConfidence: 1,
    };
    const worker = createMemoryExtractionWorker(dependencies);

    await worker.processBatch({ limit: 20 });

    expect(dependencies.repository.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptedCandidates: [],
        diagnostics: expect.objectContaining({
          proposedCount: 1,
          acceptedCount: 0,
          rejectedCount: 1,
          rejectionCodes: ["low_confidence"],
        }),
      }),
    );
  });

  it("covers only the bounded same-group run and defers overflow jobs", async () => {
    const jobs = Array.from(
      { length: 41 },
      (_, index) => job(`request-${String(index + 1).padStart(2, "0")}`),
    );
    const coveredRequestIds = jobs.slice(0, 40).map(({ requestId }) => requestId);
    const dependencies = createDependencies({
      jobs,
      claimedRun: run({ requestIds: coveredRequestIds }),
    });
    const worker = createMemoryExtractionWorker(dependencies);

    const results = await worker.processBatch({ limit: 100 });

    expect(dependencies.repository.claimRun).toHaveBeenCalledOnce();
    expect(dependencies.repository.claimRun).toHaveBeenCalledWith(
      expect.objectContaining({ requestIds: coveredRequestIds }),
    );
    expect(dependencies.client.extract).toHaveBeenCalledOnce();
    expect(dependencies.repository.completeRun).toHaveBeenCalledOnce();
    expect(dependencies.queue.handleProcessedJob).toHaveBeenCalledTimes(40);
    expect(dependencies.queue.deferJob).toHaveBeenCalledOnce();
    expect(dependencies.queue.deferJob).toHaveBeenCalledWith(jobs[40]);
    expect(dependencies.queue.handleFailedJob).not.toHaveBeenCalled();
    expect(results.slice(0, 40)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "completed", requestId: "request-01" }),
        expect.objectContaining({ status: "completed", requestId: "request-40" }),
      ]),
    );
    expect(results[40]).toEqual(
      expect.objectContaining({
        status: "deferred",
        requestId: "request-41",
        reason: "unselected_run_scope",
      }),
    );
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

  it.each([false, true])(
    "terminal-DLQs forged routing without touching the durable request (runtime enabled=%s)",
    async (runtimeEnabled) => {
      const forgedJob = job("request-1", "forged-chat");
      const dependencies = createDependencies({
        jobs: [forgedJob],
        routes: [{ requestId: "request-1", groupId: "chat-a", status: "pending" }],
      });
      dependencies.runtimeController.canProcessIncomingEvent.mockReturnValue(runtimeEnabled);
      dependencies.runtimeController.canReadGroupContext.mockReturnValue(runtimeEnabled);
      const worker = createMemoryExtractionWorker(dependencies);

      await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
        expect.objectContaining({
          status: "failed",
          requestId: "request-1",
          classification: "invalid_queue_payload",
          retryAction: "dead_lettered",
        }),
      ]);
      expect(dependencies.queue.handleTerminalJob).toHaveBeenCalledWith({
        job: forgedJob,
        errorCode: "corrupt_routing",
      });
      expect(dependencies.repository.skipRequest).not.toHaveBeenCalled();
      expect(dependencies.repository.failRun).not.toHaveBeenCalled();
      expect(dependencies.repository.claimRun).not.toHaveBeenCalled();
      expect(dependencies.repository.loadRunInput).not.toHaveBeenCalled();
      expect(dependencies.client.extract).not.toHaveBeenCalled();
    },
  );

  it("terminal-DLQs a stale or missing route without loading chat content", async () => {
    const staleJob = job("request-missing", "old-chat");
    const dependencies = createDependencies({ jobs: [staleJob], routes: [] });
    const worker = createMemoryExtractionWorker(dependencies);

    await worker.processBatch({ limit: 20 });

    expect(dependencies.repository.getRequestRoutes).toHaveBeenCalledWith({
      requestIds: ["request-missing"],
    });
    expect(dependencies.queue.handleTerminalJob).toHaveBeenCalledWith({
      job: staleJob,
      errorCode: "corrupt_routing",
    });
    expect(dependencies.repository.skipRequest).not.toHaveBeenCalled();
    expect(dependencies.repository.claimRun).not.toHaveBeenCalled();
    expect(dependencies.repository.loadRunInput).not.toHaveBeenCalled();
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
    const dependencies = createDependencies({
      jobs: [job("request-1")],
      routes: [{ requestId: "request-1", groupId: "chat-a", status: "completed", runId: "run-1" }],
    });
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({ status: "skipped", reason: "already_terminal" }),
    ]);
    expect(dependencies.queue.handleProcessedJob).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "request-1" }),
    );
    expect(dependencies.client.extract).not.toHaveBeenCalled();
    expect(dependencies.repository.completeRun).not.toHaveBeenCalled();
    expect(dependencies.repository.claimRun).not.toHaveBeenCalled();
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

  it("defers every job under shared cooldown without claiming, calling the model, or charging attempts", async () => {
    const jobs = [job("request-1", "chat-a", 4), job("request-2", "chat-b", 4)];
    const dependencies = createDependencies({
      jobs,
      routes: jobs.map((queuedJob) => ({
        requestId: queuedJob.requestId,
        groupId: queuedJob.groupId,
        status: "pending" as const,
      })),
    });
    const cooldown = new Date("2026-07-15T00:15:00.000Z");
    dependencies.queue.getProviderCooldown.mockResolvedValue(cooldown);
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({
        status: "deferred",
        requestId: "request-1",
        reason: "provider_cooldown",
      }),
      expect.objectContaining({
        status: "deferred",
        requestId: "request-2",
        reason: "provider_cooldown",
      }),
    ]);

    expect(dependencies.repository.claimRun).not.toHaveBeenCalled();
    expect(dependencies.client.extract).not.toHaveBeenCalled();
    expect(dependencies.queue.deferJob).toHaveBeenNthCalledWith(1, jobs[0], cooldown);
    expect(dependencies.queue.deferJob).toHaveBeenNthCalledWith(2, jobs[1], cooldown);
    expect(dependencies.queue.handleFailedJob).not.toHaveBeenCalled();
    expect(dependencies.queue.handleTerminalJob).not.toHaveBeenCalled();
  });

  it("classifies unauthorized as terminal and does not schedule a delayed retry", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    dependencies.client.extract.mockRejectedValue(
      new AiWorkerMemoryExtractionError("unauthorized", false),
    );
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
    expect(dependencies.queue.handleTerminalJob).toHaveBeenCalledWith({
      job: expect.objectContaining({ requestId: "request-1" }),
      errorCode: "provider_unauthorized",
    });
    expect(dependencies.queue.handleFailedJob).not.toHaveBeenCalled();
  });

  it("does not reset a terminal run budget for a fresh replacement job", async () => {
    const dependencies = createDependencies({
      jobs: [job("request-1", "chat-a", 0)],
      claimedRun: run({
        requestIds: ["request-1"],
        previousFailureClassification: "provider_unauthorized",
      }),
    });
    const worker = createMemoryExtractionWorker(dependencies);

    await worker.processBatch({ limit: 20 });

    expect(dependencies.client.extract).not.toHaveBeenCalled();
    expect(dependencies.repository.completeRun).not.toHaveBeenCalled();
    expect(dependencies.queue.handleTerminalJob).toHaveBeenCalledWith({
      job: expect.objectContaining({ requestId: "request-1", attempts: 0 }),
      errorCode: "provider_unauthorized",
    });
    expect(dependencies.queue.handleFailedJob).not.toHaveBeenCalled();
  });

  it("inherits a terminal multi-request run budget from a recovered job subset", async () => {
    const recoveredJob = job("request-1", "chat-a", 0);
    const dependencies = createDependencies({
      jobs: [recoveredJob],
      routes: [{
        requestId: "request-1",
        groupId: "chat-a",
        status: "processing",
        runId: "run-1",
      }],
      claimedRun: run({ previousFailureClassification: "provider_unauthorized" }),
    });
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 1 })).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        requestId: "request-1",
        classification: "provider_unauthorized",
        retryAction: "dead_lettered",
      }),
    ]);
    expect(dependencies.client.extract).not.toHaveBeenCalled();
    expect(dependencies.queue.handleTerminalJob).toHaveBeenCalledWith({
      job: recoveredJob,
      errorCode: "provider_unauthorized",
    });
    expect(dependencies.queue.handleFailedJob).not.toHaveBeenCalled();
  });

  it("advances at most one durable run scope for a same-group batch", async () => {
    const jobs = [job("request-1"), job("request-2")];
    const dependencies = createDependencies({
      jobs,
      routes: [
        {
          requestId: "request-1",
          groupId: "chat-a",
          status: "processing",
          runId: "run-1",
        },
        {
          requestId: "request-2",
          groupId: "chat-a",
          status: "processing",
          runId: "run-2",
        },
      ],
      claimedRun: run({ requestIds: ["request-1"] }),
    });
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({ status: "completed", requestId: "request-1" }),
      expect.objectContaining({
        status: "deferred",
        requestId: "request-2",
        reason: "unselected_run_scope",
      }),
    ]);
    expect(dependencies.repository.claimRun).toHaveBeenCalledWith(
      expect.objectContaining({ requestIds: ["request-1"] }),
    );
    expect(dependencies.client.extract).toHaveBeenCalledOnce();
    expect(dependencies.repository.completeRun).toHaveBeenCalledOnce();
    expect(dependencies.queue.handleProcessedJob).toHaveBeenCalledWith(jobs[0]);
    expect(dependencies.queue.deferJob).toHaveBeenCalledWith(jobs[1]);
    expect(dependencies.queue.handleFailedJob).not.toHaveBeenCalled();
  });

  it("fairly advances repeated-failure run scopes without charging deferred jobs", async () => {
    const jobs = [job("request-1"), job("request-2"), job("request-3")];
    const runs = jobs.map((queuedJob, index) => run({
      id: `run-${index + 1}`,
      requestIds: [queuedJob.requestId],
    }));
    const runByRequestId = new Map(runs.map((claimed) => [claimed.requestIds[0]!, claimed]));
    const runById = new Map(runs.map((claimed) => [claimed.id, claimed]));
    const dependencies = createDependencies({ jobs });
    dependencies.queue.dequeueBatch
      .mockResolvedValueOnce(jobs)
      .mockResolvedValueOnce(jobs.slice(1))
      .mockResolvedValueOnce(jobs.slice(2));
    dependencies.repository.getRequestRoutes.mockImplementation(async ({ requestIds }) =>
      requestIds.map((requestId) => ({
        requestId,
        groupId: "chat-a",
        status: "processing" as const,
        runId: runByRequestId.get(requestId)!.id,
      })),
    );
    dependencies.repository.claimRun.mockImplementation(async ({ requestIds }) =>
      runByRequestId.get(requestIds[0]!),
    );
    dependencies.repository.loadRunInput.mockImplementation(async (runId) => ({
      status: "ready" as const,
      run: runById.get(runId)!,
    }));
    dependencies.client.extract
      .mockRejectedValueOnce(new AiWorkerMemoryExtractionError("timeout", true))
      .mockRejectedValueOnce(new AiWorkerMemoryExtractionError("unavailable", true))
      .mockResolvedValueOnce({ runId: "run-3", candidates: [candidate()] });
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 100 })).resolves.toEqual([
      expect.objectContaining({ status: "failed", requestId: "request-1" }),
      expect.objectContaining({ status: "deferred", requestId: "request-2" }),
      expect.objectContaining({ status: "deferred", requestId: "request-3" }),
    ]);
    await expect(worker.processBatch({ limit: 100 })).resolves.toEqual([
      expect.objectContaining({ status: "failed", requestId: "request-2" }),
      expect.objectContaining({ status: "deferred", requestId: "request-3" }),
    ]);
    await expect(worker.processBatch({ limit: 100 })).resolves.toEqual([
      expect.objectContaining({ status: "completed", requestId: "request-3" }),
    ]);

    expect(dependencies.queue.deferJob.mock.calls.map(([deferredJob]) => ({
      requestId: deferredJob.requestId,
      attempts: deferredJob.attempts,
    }))).toEqual([
      { requestId: "request-2", attempts: 0 },
      { requestId: "request-3", attempts: 0 },
      { requestId: "request-3", attempts: 0 },
    ]);
    expect(dependencies.queue.handleFailedJob).toHaveBeenCalledTimes(2);
    expect(dependencies.queue.handleTerminalJob).not.toHaveBeenCalled();
    expect(dependencies.client.extract).toHaveBeenCalledTimes(3);
    expect(dependencies.repository.completeRun).toHaveBeenCalledOnce();
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
            ? { requestIds: ["request-1"] }
            : { requestIds: ["request-1"], previousFailureClassification },
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
      if (delayed) {
        expect(dependencies.queue.handleFailedJob).toHaveBeenCalledWith({
          job: expect.objectContaining({ requestId: "request-1" }),
          errorMessage: "invalid_model_response",
          retryAt: new Date("2026-07-15T00:00:30.000Z"),
        });
        expect(dependencies.queue.handleTerminalJob).not.toHaveBeenCalled();
      } else {
        expect(dependencies.queue.handleTerminalJob).toHaveBeenCalledWith({
          job: expect.objectContaining({ requestId: "request-1" }),
          errorCode: "invalid_model_response",
        });
        expect(dependencies.queue.handleFailedJob).not.toHaveBeenCalled();
      }
    },
  );

  it("requeues a run that becomes stale inside atomic completion without reporting success", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    dependencies.repository.completeRun.mockRejectedValue(new MemoryExtractionStaleRunError());
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({
        status: "failed",
        classification: "input_stale",
        retryAction: "requeued",
      }),
    ]);
    expect(dependencies.queue.handleProcessedJob).not.toHaveBeenCalled();
    expect(dependencies.queue.handleFailedJob).toHaveBeenCalledWith({
      job: expect.objectContaining({ requestId: "request-1" }),
      errorMessage: "internal_error",
      retryAt: new Date("2026-07-15T00:00:30.000Z"),
    });
    expect(dependencies.auditLog.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "memory_extraction_completed" }),
    );
  });

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
      conflictCandidates: [],
      diagnostics: {
        proposedCount: 1,
        acceptedCount: 0,
        rejectedCount: 1,
        duplicateCount: 0,
        conflictCount: 0,
        rejectionCodes: ["low_confidence"],
      },
      threadOperations: [],
      actionOperations: [],
      conversationStateDiagnostics: { proposedCount: 0, acceptedCount: 0, rejectedCount: 0, rejectionCodes: [] },
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

  it("passes validated v2 thread and action operations with their content-free diagnostics into atomic completion", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    dependencies.client.extract.mockResolvedValue({
      runId: "run-1",
      candidates: [],
      threadOperations: [{
        operation: "create",
        operationKey: "thread:create:launch",
        confidence: 0.9,
        evidenceMessageIds: ["feishu:msg-1"],
        evidenceSpan: "Launch on Thursday.",
        title: "Launch",
        summary: "Track launch work.",
        initialStatus: "open",
      }],
      actionOperations: [{
        operation: "create",
        operationKey: "action:create:launch",
        confidence: 0.9,
        evidenceMessageIds: ["feishu:msg-1"],
        evidenceSpan: "Launch on Thursday.",
        description: "Ship launch work.",
        owner: { ownerType: "sender", messageId: "feishu:msg-1" },
      }],
    } as any);
    const worker = createMemoryExtractionWorker(dependencies);

    await worker.processBatch({ limit: 20 });

    expect(dependencies.repository.completeRun).toHaveBeenCalledWith(expect.objectContaining({
      threadOperations: [expect.objectContaining({ operationKey: "thread:create:launch" })],
      actionOperations: [expect.objectContaining({ operationKey: "action:create:launch" })],
      conversationStateDiagnostics: {
        proposedCount: 2,
        acceptedCount: 2,
        rejectedCount: 0,
        rejectionCodes: [],
      },
    }));
  });

  it("isolates a stale second thread operation while preserving valid memory and state work", async () => {
    const dependencies = createDependencies({
      jobs: [job("request-1")],
      claimedRun: run({
        requestIds: ["request-1"],
        existingThreads: [{
          id: "thread-1",
          groupId: "chat-a",
          title: "Launch",
          summary: "Launch on Thursday.",
          status: "open",
          confidence: 0.9,
          version: 1,
          evidenceCount: 1,
          firstEvidenceAt: new Date("2026-07-14T23:59:00.000Z"),
          lastActivityAt: new Date("2026-07-14T23:59:00.000Z"),
          createdAt: new Date("2026-07-14T23:59:00.000Z"),
          updatedAt: new Date("2026-07-14T23:59:00.000Z"),
        }],
      }),
    });
    dependencies.client.extract.mockResolvedValue({
      runId: "run-1",
      candidates: [candidate()],
      threadOperations: [
        {
          operation: "update_summary",
          operationKey: "thread:update:z",
          confidence: 0.9,
          evidenceMessageIds: ["feishu:msg-1"],
          evidenceSpan: "Launch on Thursday.",
          threadId: "thread-1",
          expectedVersion: 1,
          summary: "Rejected later summary.",
        },
        {
          operation: "update_summary",
          operationKey: "thread:update:a",
          confidence: 0.9,
          evidenceMessageIds: ["feishu:msg-1"],
          evidenceSpan: "Launch on Thursday.",
          threadId: "thread-1",
          expectedVersion: 1,
          summary: "Accepted sorted summary.",
        },
      ],
      actionOperations: [],
    } as any);
    const worker = createMemoryExtractionWorker(dependencies);

    await worker.processBatch({ limit: 20 });

    expect(dependencies.repository.completeRun).toHaveBeenCalledWith(expect.objectContaining({
      acceptedCandidates: [expect.objectContaining({ content: "Launch on Thursday." })],
      threadOperations: [expect.objectContaining({
        operationKey: "thread:update:a",
        summary: "Accepted sorted summary.",
      })],
      conversationStateDiagnostics: {
        proposedCount: 2,
        acceptedCount: 1,
        rejectedCount: 1,
        rejectionCodes: ["stale_version"],
      },
    }));
  });

  it("passes only fully validated conflict candidates into atomic completion", async () => {
    const dependencies = createDependencies({
      jobs: [job("request-1")],
      claimedRun: run({
        requestIds: ["request-1"],
        existingMemories: [{
          id: "memory-existing",
          category: "decision",
          content: "Launch on Thursday.",
          updatedAt: new Date("2026-07-14T23:00:00.000Z"),
        }],
      }),
    });
    dependencies.client.extract.mockResolvedValue({
      runId: "run-1",
      candidates: [
        candidate({
          content: "  Launch moved to Friday.  ",
          evidenceMessageIds: ["feishu:msg-2", "feishu:msg-1", "feishu:msg-2"],
          relation: "conflict",
          existingMemoryId: "memory-existing",
        }),
        candidate({
          content: "Rejected private model text",
          confidence: 0.2,
          relation: "conflict",
          existingMemoryId: "memory-existing",
        }),
      ],
    });
    const worker = createMemoryExtractionWorker(dependencies);

    await worker.processBatch({ limit: 20 });

    expect(dependencies.repository.completeRun).toHaveBeenCalledWith({
      runId: "run-1",
      inputFingerprint: "f".repeat(64),
      acceptedCandidates: [],
      conflictCandidates: [{
        category: "decision",
        content: "Launch moved to Friday.",
        importance: 4,
        confidence: 0.9,
        evidenceMessageIds: ["feishu:msg-1", "feishu:msg-2"],
        existingMemoryId: "memory-existing",
      }],
      diagnostics: {
        proposedCount: 2,
        acceptedCount: 0,
        rejectedCount: 2,
        duplicateCount: 0,
        conflictCount: 1,
        rejectionCodes: ["low_confidence", "conflict_relation"],
      },
      threadOperations: [],
      actionOperations: [],
      conversationStateDiagnostics: { proposedCount: 0, acceptedCount: 0, rejectedCount: 0, rejectionCodes: [] },
    });
    expect(JSON.stringify(dependencies.repository.completeRun.mock.calls)).not.toContain(
      "Rejected private model text",
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

  it("recovers exhausted queue-handler work on the next batch without restarting", async () => {
    const dependencies = createDependencies({ jobs: [job("request-1")] });
    dependencies.repository.getRequestRoutes
      .mockResolvedValueOnce([
        { requestId: "request-1", groupId: "chat-a", status: "pending" },
      ])
      .mockResolvedValueOnce([
        { requestId: "request-1", groupId: "chat-a", status: "completed", runId: "run-1" },
      ]);
    dependencies.queue.recoverProcessing
      .mockResolvedValueOnce({ recoveredCount: 0, remainingCount: 0 })
      .mockResolvedValueOnce({ recoveredCount: 1, remainingCount: 0 });
    dependencies.queue.handleProcessedJob.mockRejectedValue(new Error("redis unavailable"));
    dependencies.queue.handleFailedJob.mockRejectedValue(new Error("redis unavailable"));
    const worker = createMemoryExtractionWorker(dependencies);

    await expect(worker.processBatch({ limit: 20 })).rejects.toThrow(
      "memory extraction queue recovery failed",
    );
    dependencies.queue.handleProcessedJob.mockResolvedValue(undefined);

    await expect(worker.processBatch({ limit: 20 })).resolves.toEqual([
      expect.objectContaining({ status: "skipped", reason: "already_terminal" }),
    ]);
    expect(dependencies.queue.recoverProcessing).toHaveBeenCalledTimes(2);
    expect(dependencies.client.extract).toHaveBeenCalledOnce();
    expect(dependencies.repository.completeRun).toHaveBeenCalledOnce();
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
  routes?: Array<{
    requestId: string;
    groupId: string;
    status: "pending" | "processing" | "completed" | "skipped";
    runId?: string;
  }>;
  onAuditError?: (error: unknown) => void;
}) {
  const claimedRun = input.claimedRun ?? run({
    requestIds: input.jobs.map(({ requestId }) => requestId),
  });
  const queue = {
    enqueue: vi.fn(async () => undefined),
    recoverProcessing: vi.fn(async () => ({ recoveredCount: 0, remainingCount: 0 })),
    dequeueBatch: vi.fn(async () => input.jobs),
    deferJob: vi.fn(async (_job: MemoryExtractionJob) => undefined),
    handleProcessedJob: vi.fn(async () => undefined),
    handleTerminalJob: vi.fn(async ({ job: terminalJob }: { job: MemoryExtractionJob }) => ({
      action: "dead_lettered" as const,
      attempts: terminalJob.attempts + 1,
    })),
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
    getRequestRoutes: vi.fn(async (
      _routeInput: Parameters<MemoryExtractionRepository["getRequestRoutes"]>[0],
    ) =>
      input.routes ?? input.jobs.map(({ requestId, groupId }) => ({
        requestId,
        groupId,
        status: "pending" as const,
      })),
    ),
    claimRun: vi.fn(async (
      _claimInput: Parameters<MemoryExtractionRepository["claimRun"]>[0],
    ) => claimedRun as ClaimedMemoryExtractionRun | undefined),
    loadRunInput: vi.fn(
      async (_runId: string): Promise<
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
      acceptedCandidates: 0,
      rejectedCandidates: 0,
      duplicateCandidates: 0,
      conflictCandidates: 0,
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
    mentions: [],
    existingThreads: [],
    existingActions: [],
    enabledOperationFamilies: ["memory", "thread", "action"],
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
