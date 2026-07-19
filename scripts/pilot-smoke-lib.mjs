export function assertHealthyInternalStatus(snapshot) {
  const summary = isRecord(snapshot) && isRecord(snapshot.summary) ? snapshot.summary : undefined;
  if (
    !isRecord(snapshot) ||
    snapshot.ok !== true ||
    snapshot.status !== "healthy" ||
    summary?.degradedComponentCount !== 0 ||
    summary.stoppedEnabledRuntimeComponentCount !== 0
  ) {
    throw new Error("Expected a healthy internal status with all enabled runtimes running");
  }
}

export function assertRuntimeGloballyDisabled(snapshot) {
  if (snapshot?.components?.runtimeControl?.globalEnabled !== false) {
    throw new Error("Expected the pilot runtime to start globally disabled");
  }
}

export function assertPilotActivationReady(snapshot) {
  assertHealthyInternalStatus(snapshot);
  assertRuntimeGloballyDisabled(snapshot);

  const runtimeControl = snapshot?.components?.runtimeControl;
  if (
    !isRecord(runtimeControl) ||
    !Number.isSafeInteger(runtimeControl.revision) ||
    runtimeControl.revision < 0 ||
    typeof runtimeControl.desiredGlobalEnabled !== "boolean" ||
    runtimeControl.activationRequired !== runtimeControl.desiredGlobalEnabled
  ) {
    throw new Error("Expected consistent durable runtime-control state after restart");
  }
  if (
    runtimeControl.persistence?.storage !== "postgres" ||
    runtimeControl.persistence.ok !== true
  ) {
    throw new Error("Expected healthy Postgres runtime-control persistence before activation");
  }

  const workers = [
    {
      status: snapshot?.components?.eventWorker,
      countNames: ["pendingEventCount", "deadLetterEventCount"],
    },
    {
      status: snapshot?.components?.documentSync,
      countNames: ["pendingJobCount", "deadLetterJobCount"],
    },
    {
      status: snapshot?.components?.reindex,
      countNames: ["pendingJobCount", "deadLetterJobCount"],
    },
  ];
  if (
    workers.some(
      ({ status, countNames }) =>
        !isRecord(status) ||
        status.ok !== true ||
        status.enabled !== true ||
        status.running !== true ||
        countNames.some((countName) => status[countName] !== 0),
    )
  ) {
    throw new Error("Expected healthy pilot workers and queues with zero pending and DLQ counts");
  }
}

export function assertKnowledgeCardOutboxReady(knowledgeCards) {
  if (knowledgeCards === undefined) return "unavailable-while-disabled";
  const outbox = isRecord(knowledgeCards) && isRecord(knowledgeCards.outbox)
    ? knowledgeCards.outbox
    : undefined;
  const countNames = [
    "pending",
    "processing",
    "external_attempting",
    "sent",
    "failed",
    "outcome_unknown",
    "terminalFailed",
  ];
  if (
    outbox === undefined ||
    countNames.some((name) => !Number.isSafeInteger(outbox[name]) || outbox[name] < 0) ||
    outbox.terminalFailed > outbox.failed
  ) {
    throw new Error("Expected bounded content-free knowledge-card outbox counts");
  }
  if (outbox.outcome_unknown > 0 || outbox.terminalFailed > 0) {
    throw new Error("Expected knowledge-card outbox without unresolved or terminal failures");
  }
  return "no-unresolved-terminal-failures";
}

export function assertDurableRuntimeMutation({ responseStatus, body, enabled }) {
  if (
    responseStatus !== 200 ||
    !isRecord(body) ||
    body.globalEnabled !== enabled ||
    body.durable !== true
  ) {
    throw new Error(`Expected a durable runtime mutation for global enablement ${enabled}`);
  }
}

export function assertFastFeishuAcknowledgement({ status, body, elapsedMs, deadlineMs }) {
  if (
    status !== 200 ||
    !isRecord(body) ||
    body.ok !== true ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs > deadlineMs
  ) {
    throw new Error(`Expected Feishu callback acknowledgement within ${deadlineMs}ms`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
