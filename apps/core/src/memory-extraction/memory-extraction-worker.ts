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
  type MemoryExtractionTerminalErrorCode,
} from "./memory-extraction-queue.js";
import type {
  ClaimedMemoryExtractionRun,
  MemoryExtractionRepository,
  MemoryExtractionRequestRoute,
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
      status: "deferred";
      requestId: string;
      groupId: string;
      runId?: string;
      reason: "unselected_run_scope";
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
  minConfidence?: number;
  now?: () => Date;
  onAuditError?: (error: unknown) => void;
};

type IndexedJob = { job: MemoryExtractionJob; index: number };
type RoutedJob = IndexedJob & { route: MemoryExtractionRequestRoute };

export function createMemoryExtractionWorker(input: MemoryExtractionWorkerDependencies) {
  const now = input.now ?? (() => new Date());

  return {
    async processBatch({ limit }: { limit: number }): Promise<MemoryExtractionWorkerResult[]> {
      const safeLimit = sanitizeBatchLimit(limit);
      const dequeueAt = requireValidNow(now());
      await recoverProcessing(input.queue);
      const jobs = await input.queue.dequeueBatch(safeLimit, dequeueAt);
      const indexedJobs = jobs.map((job, index) => ({ job, index }));
      const results = new Map<number, MemoryExtractionWorkerResult>();
      if (indexedJobs.length === 0) {
        return [];
      }

      let routes: MemoryExtractionRequestRoute[];
      try {
        routes = await input.repository.getRequestRoutes({
          requestIds: indexedJobs.map(({ job }) => job.requestId),
        });
      } catch {
        await failIndexedJobs({
          queue: input.queue,
          jobs: indexedJobs,
          results,
          classification: "internal_error",
          errorMessage: "internal_error",
          retryAt: (job) => retryAtForJob(dequeueAt, job),
        });
        return orderedResults(indexedJobs, results);
      }

      let routeByRequestId: Map<string, MemoryExtractionRequestRoute>;
      try {
        routeByRequestId = indexRoutes(routes, indexedJobs);
      } catch {
        await failIndexedJobs({
          queue: input.queue,
          jobs: indexedJobs,
          results,
          classification: "internal_error",
          errorMessage: "internal_error",
          retryAt: (job) => retryAtForJob(dequeueAt, job),
        });
        return orderedResults(indexedJobs, results);
      }
      const groups = new Map<string, RoutedJob[]>();
      for (const indexedJob of indexedJobs) {
        const route = routeByRequestId.get(indexedJob.job.requestId);
        if (route === undefined || route.groupId !== indexedJob.job.groupId) {
          await recordAudit(input, {
            type: "memory_extraction_failed",
            documentId: indexedJob.job.requestId,
            fragmentIds: [],
            message: "corrupt_routing",
          });
          await terminalIndexedJobs({
            queue: input.queue,
            jobs: [indexedJob],
            results,
            classification: "invalid_queue_payload",
            errorCode: "corrupt_routing",
            ...(route === undefined ? {} : { groupId: route.groupId }),
          });
          continue;
        }
        if (route.status === "completed" || route.status === "skipped") {
          results.set(
            indexedJob.index,
            await acknowledgeResult({
              queue: input.queue,
              indexedJob,
              now: dequeueAt,
              success: {
                status: "skipped",
                requestId: route.requestId,
                groupId: route.groupId,
                ...(route.runId === undefined ? {} : { runId: route.runId }),
                reason: "already_terminal",
              },
            }),
          );
          continue;
        }
        const routedJob = { ...indexedJob, route };
        const group = groups.get(route.groupId);
        if (group === undefined) {
          groups.set(route.groupId, [routedJob]);
        } else {
          group.push(routedJob);
        }
      }

      for (const groupJobs of groups.values()) {
        await processGroup({ dependencies: input, jobs: groupJobs, results, now: dequeueAt });
      }

      return orderedResults(indexedJobs, results);
    },
  };
}

async function processGroup(input: {
  dependencies: MemoryExtractionWorkerDependencies;
  jobs: RoutedJob[];
  results: Map<number, MemoryExtractionWorkerResult>;
  now: Date;
}): Promise<void> {
  const { dependencies, jobs, results, now } = input;
  const groupId = jobs[0]!.route.groupId;
  if (!runtimeAllows(dependencies.runtimeController, groupId)) {
    for (const indexedJob of jobs) {
      await skipBeforeLoad({ dependencies, indexedJob, results, now, groupId });
    }
    return;
  }

  const cooldown = await getActiveCooldown(dependencies.queue, now);
  if (cooldown !== undefined) {
    await failIndexedJobs({
      queue: dependencies.queue,
      jobs,
      results,
      classification: "provider_rate_limited",
      errorMessage: "provider_rate_limited",
      retryAt: () => cooldown,
    });
    return;
  }

  const scopedJobs = jobs.filter((job) => sameDurableRunScope(job.route, jobs[0]!.route));
  const runJobs = scopedJobs.slice(0, MAX_EVIDENCE_MESSAGES);
  const runJobIndexes = new Set(runJobs.map(({ index }) => index));
  const deferredJobs = jobs.filter(({ index }) => !runJobIndexes.has(index));
  let claimedRun: ClaimedMemoryExtractionRun | undefined;
  try {
    claimedRun = await dependencies.repository.claimRun({
      requestIds: runJobs.map(({ route }) => route.requestId),
      maxEvidenceMessages: MAX_EVIDENCE_MESSAGES,
      contextMessageLimit: MAX_CONTEXT_MESSAGES,
      activeMemoryLimit: MAX_ACTIVE_MEMORIES,
    });
  } catch (error) {
    const stale = error instanceof MemoryExtractionStaleRunError;
    await failIndexedJobs({
      queue: dependencies.queue,
      jobs: runJobs,
      results,
      classification: stale ? "input_stale" : "internal_error",
      errorMessage: "internal_error",
      retryAt: (job) => retryAtForJob(now, job),
    });
    await deferJobs(dependencies.queue, deferredJobs, results);
    return;
  }

  if (claimedRun === undefined) {
    await reconcileUnclaimedJobs({ dependencies, jobs: runJobs, results, now });
    await deferJobs(dependencies.queue, deferredJobs, results);
    return;
  }

  const expectedRequestIds = runJobs.map(({ route }) => route.requestId);
  if (
    claimedRun.groupId !== groupId ||
    !claimedRunMatchesRoutes(claimedRun, runJobs, expectedRequestIds)
  ) {
    await failIndexedJobs({
      queue: dependencies.queue,
      jobs: runJobs,
      results,
      runId: claimedRun.id,
      classification: "internal_error",
      errorMessage: "internal_error",
      retryAt: (job) => retryAtForJob(now, job),
    });
    await deferJobs(dependencies.queue, deferredJobs, results);
    return;
  }

  await processClaimedRun({ dependencies, jobs: runJobs, claimedRun, results, now });
  await deferJobs(dependencies.queue, deferredJobs, results);
}

async function processClaimedRun(input: {
  dependencies: MemoryExtractionWorkerDependencies;
  jobs: RoutedJob[];
  claimedRun: ClaimedMemoryExtractionRun;
  results: Map<number, MemoryExtractionWorkerResult>;
  now: Date;
}): Promise<void> {
  const { dependencies, jobs, claimedRun, results, now } = input;

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
      jobs,
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
    return;
  }
  if (loaded.status === "not_found" || !sameRun(claimedRun, loaded.run)) {
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

  const run = loaded.run;
  const previousFailure = run.previousFailureClassification;
  if (isTerminalFailure(previousFailure)) {
    await persistRunFailure(dependencies.repository, run.id, previousFailure);
    await recordAudit(dependencies, {
      type: "memory_extraction_failed",
      documentId: run.id,
      fragmentIds: evidenceIds(run),
      message: publicFailureClassification(previousFailure),
    });
    await terminalIndexedJobs({
      queue: dependencies.queue,
      jobs,
      results,
      runId: run.id,
      classification: publicFailureClassification(previousFailure),
      errorCode: terminalErrorCode(previousFailure),
    });
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
      jobs,
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
    validation = validateCandidates({
      run,
      candidates: response.candidates,
      ...(dependencies.minConfidence === undefined
        ? {}
        : { minConfidence: dependencies.minConfidence }),
    });
  } catch {
    await handleModelFailure({
      dependencies,
      jobs,
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
        jobs,
        results,
        runId: run.id,
        classification: "internal_error",
        errorMessage: "internal_error",
        retryAt: (job) => retryAtForJob(now, job),
      });
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
      jobs,
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
  } catch (error) {
    const stale = error instanceof MemoryExtractionStaleRunError;
    await failIndexedJobs({
      queue: dependencies.queue,
      jobs,
      results,
      runId: run.id,
      classification: stale ? "input_stale" : "internal_error",
      errorMessage: "internal_error",
      retryAt: (job) => retryAtForJob(now, job),
    });
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
    jobs,
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
}

async function skipBeforeLoad(input: {
  dependencies: MemoryExtractionWorkerDependencies;
  indexedJob: IndexedJob;
  results: Map<number, MemoryExtractionWorkerResult>;
  now: Date;
  groupId: string;
}): Promise<void> {
  const { dependencies, indexedJob, results, now, groupId } = input;
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
        groupId,
        reason: "runtime_disabled_before_load",
      },
    }),
  );
}

async function handleModelFailure(input: {
  dependencies: MemoryExtractionWorkerDependencies;
  jobs: RoutedJob[];
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
    return;
  }

  await recordAudit(input.dependencies, {
    type: "memory_extraction_failed",
    documentId: input.run.id,
    fragmentIds: evidenceIds(input.run),
    message: classified.publicClassification,
  });
  if (classified.terminalCode !== undefined) {
    await terminalIndexedJobs({
      queue: input.dependencies.queue,
      jobs: input.jobs,
      results: input.results,
      runId: input.run.id,
      classification: classified.publicClassification,
      errorCode: classified.terminalCode,
    });
  } else {
    await failIndexedJobs({
      queue: input.dependencies.queue,
      jobs: input.jobs,
      results: input.results,
      runId: input.run.id,
      classification: classified.publicClassification,
      errorMessage: classified.queueError,
      ...(classified.retryAt === undefined ? {} : { retryAt: classified.retryAt }),
    });
  }
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
  terminalCode?: MemoryExtractionTerminalErrorCode;
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
      terminalCode: "provider_unauthorized",
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
      ...(terminal ? { terminalCode: "invalid_model_response" as const } : {}),
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

async function terminalIndexedJobs(input: {
  queue: MemoryExtractionQueue;
  jobs: IndexedJob[];
  results: Map<number, MemoryExtractionWorkerResult>;
  runId?: string;
  groupId?: string;
  classification: Extract<MemoryExtractionWorkerResult, { status: "failed" }>["classification"];
  errorCode: MemoryExtractionTerminalErrorCode;
}): Promise<void> {
  for (const indexedJob of input.jobs) {
    let terminal: Awaited<ReturnType<MemoryExtractionQueue["handleTerminalJob"]>>;
    try {
      terminal = await retryQueueOperation(() =>
        input.queue.handleTerminalJob({
          job: indexedJob.job,
          errorCode: input.errorCode,
        }),
      );
    } catch {
      throw new Error("memory extraction queue recovery failed");
    }
    input.results.set(indexedJob.index, {
      status: "failed",
      requestId: indexedJob.job.requestId,
      groupId: input.groupId ?? indexedJob.job.groupId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      classification: input.classification,
      retryAction: terminal.action,
      attempts: terminal.attempts,
    });
  }
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

function sameDurableRunScope(
  left: MemoryExtractionRequestRoute,
  right: MemoryExtractionRequestRoute,
): boolean {
  if (left.groupId !== right.groupId || left.status !== right.status) {
    return false;
  }
  return left.status === "pending" || left.runId === right.runId;
}

function claimedRunMatchesRoutes(
  claimedRun: ClaimedMemoryExtractionRun,
  jobs: RoutedJob[],
  expectedRequestIds: string[],
): boolean {
  const firstRoute = jobs[0]!.route;
  if (firstRoute.status === "pending") {
    return jobs.every(({ route }) => route.status === "pending") &&
      sameStrings(claimedRun.requestIds, expectedRequestIds);
  }
  if (firstRoute.status !== "processing" || firstRoute.runId !== claimedRun.id) {
    return false;
  }
  const claimedRequestIds = new Set(claimedRun.requestIds);
  return jobs.every(({ route }) =>
    route.status === "processing" &&
    route.runId === claimedRun.id &&
    claimedRequestIds.has(route.requestId),
  );
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

function terminalErrorCode(classification: string): MemoryExtractionTerminalErrorCode {
  if (classification === "provider_unauthorized") {
    return "provider_unauthorized";
  }
  if (classification === "invalid_model_response_terminal") {
    return "invalid_model_response";
  }
  return "corrupt_routing";
}

function indexRoutes(
  routes: MemoryExtractionRequestRoute[],
  jobs: IndexedJob[],
): Map<string, MemoryExtractionRequestRoute> {
  const requestIds = new Set(jobs.map(({ job }) => job.requestId));
  const indexed = new Map<string, MemoryExtractionRequestRoute>();
  for (const route of routes) {
    if (!requestIds.has(route.requestId) || indexed.has(route.requestId)) {
      throw new Error("memory extraction route lookup returned invalid identifiers");
    }
    indexed.set(route.requestId, route);
  }
  return indexed;
}

async function recoverProcessing(queue: MemoryExtractionQueue): Promise<void> {
  try {
    await retryQueueOperation(() =>
      queue.recoverProcessing({ limit: MAX_MEMORY_EXTRACTION_QUEUE_LIMIT }),
    );
  } catch {
    throw new Error("memory extraction queue recovery failed");
  }
}

function orderedResults(
  jobs: IndexedJob[],
  results: Map<number, MemoryExtractionWorkerResult>,
): MemoryExtractionWorkerResult[] {
  return jobs.map(({ index }) => {
    const result = results.get(index);
    if (result === undefined) {
      throw new Error("memory extraction batch result is incomplete");
    }
    return result;
  });
}

async function deferJobs(
  queue: MemoryExtractionQueue,
  jobs: RoutedJob[],
  results: Map<number, MemoryExtractionWorkerResult>,
): Promise<void> {
  if (jobs.length === 0) {
    return;
  }
  for (const indexedJob of jobs) {
    try {
      await retryQueueOperation(() => queue.deferJob(indexedJob.job));
    } catch {
      throw new Error("memory extraction queue recovery failed");
    }
    results.set(indexedJob.index, {
      status: "deferred",
      requestId: indexedJob.route.requestId,
      groupId: indexedJob.route.groupId,
      ...(indexedJob.route.runId === undefined ? {} : { runId: indexedJob.route.runId }),
      reason: "unselected_run_scope",
    });
  }
}

async function reconcileUnclaimedJobs(input: {
  dependencies: MemoryExtractionWorkerDependencies;
  jobs: RoutedJob[];
  results: Map<number, MemoryExtractionWorkerResult>;
  now: Date;
}): Promise<void> {
  let routes: MemoryExtractionRequestRoute[];
  try {
    routes = await input.dependencies.repository.getRequestRoutes({
      requestIds: input.jobs.map(({ job }) => job.requestId),
    });
  } catch {
    await failIndexedJobs({
      queue: input.dependencies.queue,
      jobs: input.jobs,
      results: input.results,
      classification: "internal_error",
      errorMessage: "internal_error",
      retryAt: (job) => retryAtForJob(input.now, job),
    });
    return;
  }

  let routeByRequestId: Map<string, MemoryExtractionRequestRoute>;
  try {
    routeByRequestId = indexRoutes(routes, input.jobs);
  } catch {
    await failIndexedJobs({
      queue: input.dependencies.queue,
      jobs: input.jobs,
      results: input.results,
      classification: "internal_error",
      errorMessage: "internal_error",
      retryAt: (job) => retryAtForJob(input.now, job),
    });
    return;
  }

  for (const indexedJob of input.jobs) {
    const route = routeByRequestId.get(indexedJob.job.requestId);
    if (route === undefined || route.groupId !== indexedJob.route.groupId) {
      await terminalIndexedJobs({
        queue: input.dependencies.queue,
        jobs: [indexedJob],
        results: input.results,
        classification: "invalid_queue_payload",
        errorCode: "corrupt_routing",
        ...(route === undefined ? {} : { groupId: route.groupId }),
      });
      continue;
    }
    if (route.status === "completed" || route.status === "skipped") {
      input.results.set(
        indexedJob.index,
        await acknowledgeResult({
          queue: input.dependencies.queue,
          indexedJob,
          now: input.now,
          success: {
            status: "skipped",
            requestId: route.requestId,
            groupId: route.groupId,
            ...(route.runId === undefined ? {} : { runId: route.runId }),
            reason: "already_terminal",
          },
        }),
      );
      continue;
    }
    await failIndexedJobs({
      queue: input.dependencies.queue,
      jobs: [indexedJob],
      results: input.results,
      ...(route.runId === undefined ? {} : { runId: route.runId }),
      classification: "internal_error",
      errorMessage: "internal_error",
      retryAt: (job) => retryAtForJob(input.now, job),
    });
  }
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
