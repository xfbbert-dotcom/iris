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

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
