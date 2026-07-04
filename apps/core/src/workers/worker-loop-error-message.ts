const MAX_WORKER_LOOP_ERROR_MESSAGE_CHARS = 1000;
const TRUNCATION_MARKER = " ... [truncated]";

export function normalizeWorkerLoopErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return "unknown error";
  }
  if (trimmed.length <= MAX_WORKER_LOOP_ERROR_MESSAGE_CHARS) {
    return trimmed;
  }

  const prefixChars = MAX_WORKER_LOOP_ERROR_MESSAGE_CHARS - TRUNCATION_MARKER.length;
  return `${trimmed.slice(0, prefixChars).trimEnd()}${TRUNCATION_MARKER}`;
}
