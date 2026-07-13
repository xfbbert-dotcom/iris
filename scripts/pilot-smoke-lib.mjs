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
