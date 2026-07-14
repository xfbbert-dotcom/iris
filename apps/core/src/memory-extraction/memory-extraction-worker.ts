import type { AuditEvent, AuditLog } from "../audit/audit-log.js";
import {
  AiWorkerMemoryExtractionError,
  type AiWorkerMemoryExtractionClient,
} from "./ai-worker-memory-extraction-client.js";
import { validateCandidates } from "./memory-candidate-validator.js";
import {
  MAX_MEMORY_EXTRACTION_QUEUE_LIMIT,
  type MemoryExtractionJob,
  type MemoryExtractionQueue,
} from "./memory-extraction-queue.js";
import type {
  ClaimedMemoryExtractionRun,
  MemoryExtractionRepository,
} from "./memory-extraction-repository.js";
import { MemoryExtractionStaleRunError } from "./memory-extraction-repository.js";

const MAX_EVIDENCE_MESSAGES = 40;
const MAX_CONTEXT_MESSAGES = 10;
const MAX_ACTIVE_MEMORIES = 8;
const MAX_QUEUE_HANDLER_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
const MIN_RATE_LIMIT_DELAY_MS = 60_000;
const MAX_RATE_LIMIT_DELAY_MS = 86_400_000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 900_000;
const MAX_DEFAULT_RATE_LIMIT_DELAY_MS = 21_600_000;

type RuntimeController = {
  canProcessIncomingEvent(input: { groupId?: string }): boolean;
  canReadGroupContext(groupId: string): boolean;
};

export type MemoryExtractionWorkerResult =
  | {
      status: "completed";
      requestId: string;
      groupId: string;
      runId: string;
      completionStatus: "completed" | "already_completed";
      memoryIds: string[];
    }
  | {
      status: "skipped";
      requestId: string;
      groupId: string;
      runId?: string;
      reason:
        | "already_terminal"
        | "runtime_disabled_before_load"
        | "runtime_disabled_before_apply";
    }
  | {
      status: "failed";
      requestId: string;
      groupId: string;
      runId?: string;
      classification:
        | "input_stale"
        | "provider_timeout"
        | "provider_unavailable"
        | "provider_rate_limited"
        | "provider_unauthorized"
        | "invalid_model_response"
        | "invalid_queue_payload"
        | "queue_handler_error"
        | "internal_error";
      retryAction: "requeued" | "dead_lettered";
      attempts: number;
    };

export type MemoryExtractionWorkerDependencies = {
  queue: MemoryExtractionQueue;
  repository: MemoryExtractionRepository;
  client: AiWorkerMemoryExtractionClient;
  auditLog?: AuditLog;
  runtimeController: RuntimeController;
  now?: () => Date;
  onAuditError?: (error: unknown) => void;
};

type IndexedJob = { job: MemoryExtractionJob; index: number };

export function createMemoryExtractionWorker(input: MemoryExtractionWorkerDependencies) {
  const now = input.now ?? (() => new Date());

  return {
    async processBatch({ limit }: { limit: number }): Promise<MemoryExtractionWorkerResult[]> {
      const safeLimit = sanitizeBatchLimit(limit);
      const dequeueAt = requireValidNow(now());
      const jobs = await input.queue.dequeueBatch(safeLimit, dequeueAt);
      const indexedJobs = jobs.map((job, index) => ({ job, index }));
      const groups = groupJobs(indexedJobs);
      const results = new Map<number, MemoryExtractionWorkerResult>();

      for (const groupJobs of groups.values()) {
        await processGroup({ dependencies: input, jobs: groupJobs, results, now: dequeueAt });
      }

      return indexedJobs.map(({ index }) => {
        const result = results.get(index);
        if (result === undefined) {
          throw new Error("memory extraction worker result is incomplete");
        }
        return result;
      });
    },
  };
}

async function processGroup(input: {
  dependencies: MemoryExtractionWorkerDependencies;
  jobs: IndexedJob[];
  results: Map<number, MemoryExtractionWorkerResult>;
  now: Date;
}): Promise<void> {
  const { dependencies, jobs, results, now } = input;
  const groupId = jobs[0]!.job.groupId;
  let seedIndex = 0;

  while (seedIndex < jobs.length) {
    const current = jobs[seedIndex]!;
    if (!runtimeAllows(dependencies.runtimeController, groupId)) {
      await skipBeforeLoad({ dependencies, indexedJob: current, results, now });
      seedIndex += 1;
      continue;
    }

    const cooldown = await getActiveCooldown(dependencies.queue, now);
    if (cooldown !== undefined) {
      await failIndexedJobs({
        queue: dependencies.queue,
        jobs: jobs.slice(seedIndex),
        results,
        classification: "provider_rate_limited",
        errorMessage: "provider_rate_limited",
        retryAt: () => cooldown,
      });
      return;
    }

    let claimedRun: ClaimedMemoryExtractionRun | undefined;
    try {
      claimedRun = await dependencies.repository.claimRun({
        seedRequestId: current.job.requestId,
        maxEvidenceMessages: MAX_EVIDENCE_MESSAGES,
        contextMessageLimit: MAX_CONTEXT_MESSAGES,
        activeMemoryLimit: MAX_ACTIVE_MEMORIES,
      });
    } catch (error) {
      const stale = error instanceof MemoryExtractionStaleRunError;
      await failIndexedJobs({
        queue: dependencies.queue,
        jobs: jobs.slice(seedIndex),
        results,
        classification: stale ? "input_stale" : "internal_error",
        errorMessage: "internal_error",
        retryAt: (job) => retryAtForJob(now, job),
      });
      return;
    }

    if (claimedRun === undefined) {
      results.set(
        current.index,
        await acknowledgeResult({
          queue: dependencies.queue,
          indexedJob: current,
          now,
          success: {
            status: "skipped",
            requestId: current.job.requestId,
            groupId: current.job.groupId,
            reason: "already_terminal",
          },
        }),
      );
      seedIndex += 1;
      continue;
    }

    await processClaimedRun({
      dependencies,
      jobs: jobs.slice(seedIndex),
      claimedRun,
      results,
      now,
      routingGroupId: groupId,
    });
    return;
  }
}

async function processClaimedRun(input: {
  dependencies: MemoryExtractionWorkerDependencies;
  jobs: IndexedJob[];
  claimedRun: ClaimedMemoryExtractionRun;
  results: Map<number, MemoryExtractionWorkerResult>;
  now: Date;
  routingGroupId: string;
}): Promise<void> {
  const { dependencies, jobs, claimedRun, results, now, routingGroupId } = input;
  const coveredRequestIds = new Set(claimedRun.requestIds);
  const coveredJobs = jobs.filter(({ job }) => coveredRequestIds.has(job.requestId));
  const uncoveredJobs = jobs.filter(({ job }) => !coveredRequestIds.has(job.requestId));

  if (claimedRun.groupId !== routingGroupId || coveredJobs.length === 0) {
    await persistRunFailure(dependencies.repository, claimedRun.id, "invalid_queue_payload");
    await recordAudit(dependencies, {
      type: "memory_extraction_failed",
      documentId: claimedRun.id,
      fragmentIds: evidenceIds(claimedRun),
      message: "invalid_queue_payload",
    });
    await failIndexedJobs({
      queue: dependencies.queue,
      jobs,
      results,
      runId: claimedRun.id,
      classification: "invalid_queue_payload",
      errorMessage: "invalid_queue_payload",
    });
    return;
  }

  let loaded:
    | Awaited<ReturnType<MemoryExtractionRepository["loadRunInput"]>>
    | undefined;
  try {
    loaded = await dependencies.repository.loadRunInput(claimedRun.id);
  } catch {
    await failIndexedJobs({
      queue: dependencies.queue,
      jobs,
      results,
      runId: claimedRun.id,
      classification: "internal_error",
      errorMessage: "internal_error",
      retryAt: (job) => retryAtForJob(now, job),
    });
    return;
  }

  if (loaded.status === "stale") {
    await failIndexedJobs({
      queue: dependencies.queue,
      jobs,
      results,
      runId: claimedRun.id,
      classification: "input_stale",
      errorMessage: "internal_error",
      retryAt: (job) => retryAtForJob(now, job),
    });
    return;
  }
  if (loaded.status === "completed") {
    await acknowledgeIndexedJobs({
      dependencies,
      jobs: coveredJobs,
      results,
      now,
      result: (job) => ({
        status: "skipped",
        requestId: job.requestId,
        groupId: job.groupId,
        runId: claimedRun.id,
        reason: "already_terminal",
      }),
    });
    await requeueUncovered({ dependencies, jobs: uncoveredJobs, results, now });
    return;
  }
  if (loaded.status === "not_found" || !sameRun(claimedRun, loaded.run)) {
    await persistRunFailure(dependencies.repository, claimedRun.id, "invalid_queue_payload");
    await failIndexedJobs({
      queue: dependencies.queue,
      jobs,
      results,
      runId: claimedRun.id,
      classification: "invalid_queue_payload",
      errorMessage: "invalid_queue_payload",
    });
    return;
  }

  const run = loaded.run;
  const previousFailure = claimedRun.previousFailureClassification;
  if (
    coveredJobs.every(({ job }) => job.attempts > 0) &&
    isTerminalFailure(previousFailure)
  ) {
    await persistRunFailure(dependencies.repository, run.id, previousFailure);
    await failIndexedJobs({
      queue: dependencies.queue,
      jobs: coveredJobs,
      results,
      runId: run.id,
      classification: publicFailureClassification(previousFailure),
      errorMessage: terminalQueueError(previousFailure),
    });
    await requeueUncovered({ dependencies, jobs: uncoveredJobs, results, now });
    return;
  }

  let response: Awaited<ReturnType<AiWorkerMemoryExtractionClient["extract"]>>;
  try {
    response = await dependencies.client.extract(run);
    if (response.runId !== run.id) {
      throw new AiWorkerMemoryExtractionError("invalid_response", true);
    }
  } catch (error) {
    await handleModelFailure({
      dependencies,
      jobs: coveredJobs,
      uncoveredJobs,
      results,
      run,
      previousFailure,
      error,
      now,
    });
    return;
  }

  let validation: ReturnType<typeof validateCandidates>;
  try {
    validation = validateCandidates({ run, candidates: response.candidates });
  } catch {
    await handleModelFailure({
      dependencies,
      jobs: coveredJobs,
      uncoveredJobs,
      results,
      run,
      previousFailure,
      error: new AiWorkerMemoryExtractionError("invalid_response", true),
      now,
    });
    return;
  }

  if (!runtimeAllows(dependencies.runtimeController, run.groupId)) {
    try {
      await dependencies.repository.skipRun({
        runId: run.id,
        reason: "runtime_disabled_before_apply",
      });
    } catch {
      await failIndexedJobs({
        queue: dependencies.queue,
        jobs: coveredJobs,
        results,
        runId: run.id,
        classification: "internal_error",
        errorMessage: "internal_error",
        retryAt: (job) => retryAtForJob(now, job),
      });
      await requeueUncovered({ dependencies, jobs: uncoveredJobs, results, now });
      return;
    }
    await recordAudit(dependencies, {
      type: "memory_extraction_skipped",
      documentId: run.id,
      fragmentIds: evidenceIds(run),
      message: "runtime_disabled_before_apply",
    });
    await acknowledgeIndexedJobs({
      dependencies,
      jobs: coveredJobs,
      results,
      now,
      result: (job) => ({
        status: "skipped",
        requestId: job.requestId,
        groupId: job.groupId,
        runId: run.id,
        reason: "runtime_disabled_before_apply",
      }),
    });
    await requeueUncovered({ dependencies, jobs: uncoveredJobs, results, now });
    return;
  }

  let completion: Awaited<ReturnType<MemoryExtractionRepository["completeRun"]>>;
  try {
    completion = await dependencies.repository.completeRun({
      runId: run.id,
      inputFingerprint: run.inputFingerprint,
      acceptedCandidates: validation.accepted,
      diagnostics: {
        proposedCount: validation.proposedCount,
        acceptedCount: validation.acceptedCount,
        rejectedCount: validation.rejectedCount,
        duplicateCount: validation.duplicateCount,
        conflictCount: validation.conflictCount,
        rejectionCodes: [...validation.rejectionCodes],
      },
    });
  } catch {
    await failIndexedJobs({
      queue: dependencies.queue,
      jobs: coveredJobs,
      results,
      runId: run.id,
      classification: "internal_error",
      errorMessage: "internal_error",
      retryAt: (job) => retryAtForJob(now, job),
    });
    await requeueUncovered({ dependencies, jobs: uncoveredJobs, results, now });
    return;
  }

  await recordAudit(dependencies, {
    type: "memory_extraction_completed",
    documentId: run.id,
    fragmentIds: evidenceIds(run),
    message: "completed",
  });
  await acknowledgeIndexedJobs({
    dependencies,
    jobs: coveredJobs,
    results,
    now,
    result: (job) => ({
      status: "completed",
      requestId: job.requestId,
      groupId: job.groupId,
      runId: run.id,
      completionStatus: completion.status,
      memoryIds: [...completion.memoryIds],
    }),
  });
  await requeueUncovered({ dependencies, jobs: uncoveredJobs, results, now });
}

async function skipBeforeLoad(input: {
  dependencies: MemoryExtractionWorkerDependencies;
  indexedJob: IndexedJob;
  results: Map<number, MemoryExtractionWorkerResult>;
  now: Date;
}): Promise<void> {
  const { dependencies, indexedJob, results, now } = input;
  try {
    await dependencies.repository.skipRequest({
      requestId: indexedJob.job.requestId,
      reason: "runtime_disabled_before_load",
    });
  } catch {
    const [failed] = await failJobs({
      queue: dependencies.queue,
      jobs: [indexedJob.job],
      classification: "internal_error",
      errorMessage: "internal_error",
      retryAt: (job) => retryAtForJob(now, job),
    });
    results.set(indexedJob.index, failed!);
    return;
  }
  await recordAudit(dependencies, {
    type: "memory_extraction_skipped",
    documentId: indexedJob.job.requestId,
    fragmentIds: [],
    message: "runtime_disabled_before_load",
  });
  results.set(
    indexedJob.index,
    await acknowledgeResult({
      queue: dependencies.queue,
      indexedJob,
      now,
      success: {
        status: "skipped",
        requestId: indexedJob.job.requestId,
        groupId: indexedJob.job.groupId,
        reason: "runtime_disabled_before_load",
      },
    }),
  );
}

async function handleModelFailure(input: {
  dependencies: MemoryExtractionWorkerDependencies;
  jobs: IndexedJob[];
  uncoveredJobs: IndexedJob[];
  results: Map<number, MemoryExtractionWorkerResult>;
  run: ClaimedMemoryExtractionRun;
  previousFailure: string | undefined;
  error: unknown;
  now: Date;
}): Promise<void> {
  const classified = classifyModelFailure({
    error: input.error,
    previousFailure: input.previousFailure,
    jobs: input.jobs.map(({ job }) => job),
    now: input.now,
  });
  try {
    await persistRunFailure(
      input.dependencies.repository,
      input.run.id,
      classified.persistedClassification,
    );
    if (classified.cooldownUntil !== undefined) {
      await retryQueueOperation(() =>
        input.dependencies.queue.setProviderCooldown(classified.cooldownUntil!),
      );
    }
  } catch {
    await failIndexedJobs({
      queue: input.dependencies.queue,
      jobs: input.jobs,
      results: input.results,
      runId: input.run.id,
      classification: "internal_error",
      errorMessage: "internal_error",
      retryAt: (job) => retryAtForJob(input.now, job),
    });
    await requeueUncovered({
      dependencies: input.dependencies,
      jobs: input.uncoveredJobs,
      results: input.results,
      now: input.now,
    });
    return;
  }

  await recordAudit(input.dependencies, {
    type: "memory_extraction_failed",
    documentId: input.run.id,
    fragmentIds: evidenceIds(input.run),
    message: classified.publicClassification,
  });
  await failIndexedJobs({
    queue: input.dependencies.queue,
    jobs: input.jobs,
    results: input.results,
    runId: input.run.id,
    classification: classified.publicClassification,
    errorMessage: classified.queueError,
    ...(classified.retryAt === undefined ? {} : { retryAt: classified.retryAt }),
  });
  await requeueUncovered({
    dependencies: input.dependencies,
    jobs: input.uncoveredJobs,
    results: input.results,
    now: input.now,
  });
}

function classifyModelFailure(input: {
  error: unknown;
  previousFailure: string | undefined;
  jobs: MemoryExtractionJob[];
  now: Date;
}): {
  persistedClassification: string;
  publicClassification:
    | "provider_timeout"
    | "provider_unavailable"
    | "provider_rate_limited"
    | "provider_unauthorized"
    | "invalid_model_response"
    | "internal_error";
  queueError:
    | "provider_timeout"
    | "provider_unavailable"
    | "provider_rate_limited"
    | "invalid_model_response"
    | "internal_error";
  retryAt?: (job: MemoryExtractionJob) => Date;
  cooldownUntil?: Date;
} {
  const hadInvalidResponse = failureTracksInvalidResponse(input.previousFailure);
  if (!(input.error instanceof AiWorkerMemoryExtractionError)) {
    return {
      persistedClassification: hadInvalidResponse
        ? "internal_error_after_invalid_response"
        : "internal_error",
      publicClassification: "internal_error",
      queueError: "internal_error",
      retryAt: (job) => retryAtForJob(input.now, job),
    };
  }
  if (input.error.code === "unauthorized") {
    return {
      persistedClassification: "provider_unauthorized",
      publicClassification: "provider_unauthorized",
      queueError: "internal_error",
    };
  }
  if (input.error.code === "invalid_response") {
    const terminal = hadInvalidResponse;
    return {
      persistedClassification: terminal
        ? "invalid_model_response_terminal"
        : "invalid_model_response_retry",
      publicClassification: "invalid_model_response",
      queueError: "invalid_model_response",
      ...(terminal ? {} : { retryAt: (job: MemoryExtractionJob) => retryAtForJob(input.now, job) }),
    };
  }
  if (input.error.code === "rate_limited") {
    const cooldownUntil = calculateCooldown(input.error.retryAfterMs, input.jobs, input.now);
    return {
      persistedClassification: hadInvalidResponse
        ? "provider_rate_limited_after_invalid_response"
        : "provider_rate_limited",
      publicClassification: "provider_rate_limited",
      queueError: "provider_rate_limited",
      retryAt: () => cooldownUntil,
      cooldownUntil,
    };
  }
  const publicClassification = input.error.code === "timeout"
    ? "provider_timeout"
    : "provider_unavailable";
  return {
    persistedClassification: hadInvalidResponse
      ? `${publicClassification}_after_invalid_response`
      : publicClassification,
    publicClassification,
    queueError: publicClassification,
    retryAt: (job) => retryAtForJob(input.now, job),
  };
}

async function acknowledgeIndexedJobs(input: {
  dependencies: MemoryExtractionWorkerDependencies;
  jobs: IndexedJob[];
  results: Map<number, MemoryExtractionWorkerResult>;
  now: Date;
  result: (job: MemoryExtractionJob) => MemoryExtractionWorkerResult;
}): Promise<void> {
  for (const indexedJob of input.jobs) {
    input.results.set(
      indexedJob.index,
      await acknowledgeResult({
        queue: input.dependencies.queue,
        indexedJob,
        now: input.now,
        success: input.result(indexedJob.job),
      }),
    );
  }
}

async function acknowledgeResult(input: {
  queue: MemoryExtractionQueue;
  indexedJob: IndexedJob;
  now: Date;
  success: MemoryExtractionWorkerResult;
}): Promise<MemoryExtractionWorkerResult> {
  try {
    await retryQueueOperation(() => input.queue.handleProcessedJob(input.indexedJob.job));
    return input.success;
  } catch {
    const [failure] = await failJobs({
      queue: input.queue,
      jobs: [input.indexedJob.job],
      classification: "queue_handler_error",
      errorMessage: "internal_error",
      retryAt: (job) => retryAtForJob(input.now, job),
    });
    return failure!;
  }
}

async function failIndexedJobs(input: {
  queue: MemoryExtractionQueue;
  jobs: IndexedJob[];
  results: Map<number, MemoryExtractionWorkerResult>;
  runId?: string;
  classification: Extract<MemoryExtractionWorkerResult, { status: "failed" }>["classification"];
  errorMessage: string;
  retryAt?: (job: MemoryExtractionJob) => Date;
}): Promise<void> {
  const failures = await failJobs({
    queue: input.queue,
    jobs: input.jobs.map(({ job }) => job),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    classification: input.classification,
    errorMessage: input.errorMessage,
    ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
  });
  input.jobs.forEach(({ index }, resultIndex) => {
    input.results.set(index, failures[resultIndex]!);
  });
}

async function failJobs(input: {
  queue: MemoryExtractionQueue;
  jobs: MemoryExtractionJob[];
  runId?: string;
  classification: Extract<MemoryExtractionWorkerResult, { status: "failed" }>["classification"];
  errorMessage: string;
  retryAt?: (job: MemoryExtractionJob) => Date;
}): Promise<MemoryExtractionWorkerResult[]> {
  const results: MemoryExtractionWorkerResult[] = [];
  for (const job of input.jobs) {
    const failure = await handleFailedJobWithRetry(input.queue, {
      job,
      errorMessage: input.errorMessage,
      ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt(job) }),
    });
    results.push({
      status: "failed",
      requestId: job.requestId,
      groupId: job.groupId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      classification: input.classification,
      retryAction: failure.action,
      attempts: failure.attempts,
    });
  }
  return results;
}

async function handleFailedJobWithRetry(
  queue: MemoryExtractionQueue,
  input: Parameters<MemoryExtractionQueue["handleFailedJob"]>[0],
): Promise<Awaited<ReturnType<MemoryExtractionQueue["handleFailedJob"]>>> {
  try {
    return await retryQueueOperation(() => queue.handleFailedJob(input));
  } catch {
    throw new Error("memory extraction queue recovery failed");
  }
}

async function retryQueueOperation<T>(operation: () => Promise<T>): Promise<T> {
  let failed = false;
  for (let attempt = 0; attempt < MAX_QUEUE_HANDLER_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch {
      failed = true;
    }
  }
  if (failed) {
    throw new Error("memory extraction queue operation failed");
  }
  throw new Error("memory extraction queue operation failed");
}

async function requeueUncovered(input: {
  dependencies: MemoryExtractionWorkerDependencies;
  jobs: IndexedJob[];
  results: Map<number, MemoryExtractionWorkerResult>;
  now: Date;
}): Promise<void> {
  if (input.jobs.length === 0) {
    return;
  }
  await failIndexedJobs({
    queue: input.dependencies.queue,
    jobs: input.jobs,
    results: input.results,
    classification: "internal_error",
    errorMessage: "internal_error",
    retryAt: (job) => retryAtForJob(input.now, job),
  });
}

async function persistRunFailure(
  repository: MemoryExtractionRepository,
  runId: string,
  classification: string,
): Promise<void> {
  await repository.failRun({ runId, classification });
}

async function recordAudit(
  dependencies: MemoryExtractionWorkerDependencies,
  event: AuditEvent,
): Promise<void> {
  if (dependencies.auditLog === undefined) {
    return;
  }
  try {
    await dependencies.auditLog.record(event);
  } catch {
    try {
      dependencies.onAuditError?.(new Error("memory extraction audit failed"));
    } catch {
      // Audit observers cannot affect durable extraction state.
    }
  }
}

function runtimeAllows(controller: RuntimeController, groupId: string): boolean {
  try {
    return controller.canProcessIncomingEvent({ groupId }) &&
      controller.canReadGroupContext(groupId);
  } catch {
    return false;
  }
}

async function getActiveCooldown(
  queue: MemoryExtractionQueue,
  now: Date,
): Promise<Date | undefined> {
  let cooldown: Date | undefined;
  try {
    cooldown = await queue.getProviderCooldown();
  } catch {
    throw new Error("memory extraction queue operation failed");
  }
  return cooldown !== undefined && cooldown.getTime() > now.getTime()
    ? new Date(cooldown)
    : undefined;
}

function calculateCooldown(
  retryAfterMs: number | undefined,
  jobs: MemoryExtractionJob[],
  now: Date,
): Date {
  const attempts = jobs.reduce((maximum, job) => Math.max(maximum, job.attempts), 0);
  const fallback = Math.min(
    MAX_DEFAULT_RATE_LIMIT_DELAY_MS,
    DEFAULT_RATE_LIMIT_DELAY_MS * 2 ** Math.min(attempts, 4),
  );
  const delay = retryAfterMs === undefined || !Number.isFinite(retryAfterMs)
    ? fallback
    : Math.min(MAX_RATE_LIMIT_DELAY_MS, Math.max(MIN_RATE_LIMIT_DELAY_MS, retryAfterMs));
  return addMilliseconds(now, delay);
}

function retryAtForJob(now: Date, job: MemoryExtractionJob): Date {
  const delay = RETRY_DELAYS_MS[Math.min(job.attempts, RETRY_DELAYS_MS.length - 1)]!;
  return addMilliseconds(now, delay);
}

function addMilliseconds(now: Date, milliseconds: number): Date {
  const timestamp = now.getTime() + milliseconds;
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error("memory extraction retry time is invalid");
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error("memory extraction retry time is invalid");
  }
  return date;
}

function sameRun(
  claimed: ClaimedMemoryExtractionRun,
  loaded: ClaimedMemoryExtractionRun,
): boolean {
  return claimed.id === loaded.id &&
    claimed.groupId === loaded.groupId &&
    claimed.inputFingerprint === loaded.inputFingerprint &&
    sameStrings(claimed.requestIds, loaded.requestIds);
}

function sameStrings(left: string[], right: string[]): boolean {
  const leftValues = [...left].sort(compareStrings);
  const rightValues = [...right].sort(compareStrings);
  return leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index]);
}

function evidenceIds(run: ClaimedMemoryExtractionRun): string[] {
  return run.evidenceMessages.map((message) => message.id).sort(compareStrings);
}

function failureTracksInvalidResponse(classification: string | undefined): boolean {
  return classification === "invalid_model_response_retry" ||
    classification === "invalid_model_response_terminal" ||
    classification?.endsWith("_after_invalid_response") === true;
}

function isTerminalFailure(classification: string | undefined): classification is string {
  return classification === "provider_unauthorized" ||
    classification === "invalid_model_response_terminal" ||
    classification === "invalid_queue_payload";
}

function publicFailureClassification(
  classification: string,
): Extract<MemoryExtractionWorkerResult, { status: "failed" }>["classification"] {
  if (classification === "provider_unauthorized") {
    return "provider_unauthorized";
  }
  if (classification === "invalid_model_response_terminal") {
    return "invalid_model_response";
  }
  return "invalid_queue_payload";
}

function terminalQueueError(classification: string): string {
  return classification === "invalid_model_response_terminal"
    ? "invalid_model_response"
    : classification === "invalid_queue_payload"
      ? "invalid_queue_payload"
      : "internal_error";
}

function groupJobs(jobs: IndexedJob[]): Map<string, IndexedJob[]> {
  const groups = new Map<string, IndexedJob[]>();
  for (const indexedJob of jobs) {
    const group = groups.get(indexedJob.job.groupId);
    if (group === undefined) {
      groups.set(indexedJob.job.groupId, [indexedJob]);
    } else {
      group.push(indexedJob);
    }
  }
  return groups;
}

function sanitizeBatchLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("memory extraction worker batch limit must be a finite safe-magnitude number");
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error("memory extraction worker batch limit must be a safe integer");
  }
  return Math.min(MAX_MEMORY_EXTRACTION_QUEUE_LIMIT, Math.max(0, value));
}

function requireValidNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("memory extraction worker time must be a valid date");
  }
  return new Date(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
