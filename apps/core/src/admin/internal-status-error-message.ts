const MAX_INTERNAL_STATUS_ERROR_MESSAGE_CHARS = 1000;
const TRUNCATION_MARKER = " ... [truncated]";

export function normalizeInternalStatusErrorMessage(error: unknown): string {
  const message = readInternalStatusErrorMessage(error);
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return "unknown error";
  }
  if (trimmed.length <= MAX_INTERNAL_STATUS_ERROR_MESSAGE_CHARS) {
    return trimmed;
  }

  const prefixChars =
    MAX_INTERNAL_STATUS_ERROR_MESSAGE_CHARS - TRUNCATION_MARKER.length;
  return `${trimmed.slice(0, prefixChars).trimEnd()}${TRUNCATION_MARKER}`;
}

function readInternalStatusErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}
