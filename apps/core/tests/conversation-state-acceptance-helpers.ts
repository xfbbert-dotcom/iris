import assert from "node:assert/strict";

export type AcceptanceDrainCounts = {
  eventWaiting: number;
  eventProcessing: number;
  eventDeadLetter: number;
  extractionPending: number;
  extractionProcessing: number;
  extractionDelayed: number;
  extractionDeadLetter: number;
  projectionPending: number;
  projectionProcessing: number;
  projectionFailed: number;
};

export type ConversationStateCounts = {
  messages: number;
  requests: number;
  runs: number;
  threads: number;
  threadEvents: number;
  threadEvidence: number;
  actions: number;
  actionEvents: number;
  actionEvidence: number;
  operationClaims: number;
};

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

export function isAcceptanceDrainComplete(counts: AcceptanceDrainCounts): boolean {
  return counts.eventWaiting === 0 &&
    counts.eventProcessing === 0 &&
    counts.eventDeadLetter === 0 &&
    counts.extractionPending === 0 &&
    counts.extractionProcessing === 0 &&
    counts.extractionDelayed === 0 &&
    counts.extractionDeadLetter === 0 &&
    counts.projectionPending === 0 &&
    counts.projectionProcessing === 0 &&
    counts.projectionFailed === 0;
}

export function assertClosedCountDelta(
  actual: ConversationStateCounts,
  before: ConversationStateCounts,
  expectedDeltas: Partial<ConversationStateCounts>,
): void {
  const expected: ConversationStateCounts = {
    messages: before.messages + (expectedDeltas.messages ?? 0),
    requests: before.requests + (expectedDeltas.requests ?? 0),
    runs: before.runs + (expectedDeltas.runs ?? 0),
    threads: before.threads + (expectedDeltas.threads ?? 0),
    threadEvents: before.threadEvents + (expectedDeltas.threadEvents ?? 0),
    threadEvidence: before.threadEvidence + (expectedDeltas.threadEvidence ?? 0),
    actions: before.actions + (expectedDeltas.actions ?? 0),
    actionEvents: before.actionEvents + (expectedDeltas.actionEvents ?? 0),
    actionEvidence: before.actionEvidence + (expectedDeltas.actionEvidence ?? 0),
    operationClaims: before.operationClaims + (expectedDeltas.operationClaims ?? 0),
  };
  assert.deepEqual(actual, expected);
}

export async function assertProjectResourcesRemoved(input: {
  projectName: string;
  runCommand: CommandRunner;
}): Promise<void> {
  const projectFilter = `label=com.docker.compose.project=${input.projectName}`;
  const [containers, volumes] = await Promise.all([
    input.runCommand("docker", ["ps", "-aq", "--filter", projectFilter]),
    input.runCommand("docker", ["volume", "ls", "-q", "--filter", projectFilter]),
  ]);
  assert.equal(containers.trim(), "", "acceptance containers were not removed");
  assert.equal(volumes.trim(), "", "acceptance volumes were not removed");
}

export function combineAcceptanceErrors(
  primaryError: unknown,
  cleanupErrors: unknown[],
): unknown {
  if (primaryError === undefined && cleanupErrors.length === 0) return undefined;
  if (primaryError !== undefined && cleanupErrors.length === 0) return primaryError;
  return new AggregateError(
    [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
    "conversation state acceptance failed and cleanup did not complete",
  );
}
