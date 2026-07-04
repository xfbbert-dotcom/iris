const MAX_DEAD_LETTER_ERROR_MESSAGE_CHARS = 1000;
const TRUNCATION_MARKER = " ... [truncated]";

export function normalizeDeadLetterErrorMessage(errorMessage: string): string {
  const trimmed = errorMessage.trim();
  if (trimmed.length === 0) {
    return "unknown error";
  }
  if (trimmed.length <= MAX_DEAD_LETTER_ERROR_MESSAGE_CHARS) {
    return trimmed;
  }

  const prefixChars = MAX_DEAD_LETTER_ERROR_MESSAGE_CHARS - TRUNCATION_MARKER.length;
  return `${trimmed.slice(0, prefixChars).trimEnd()}${TRUNCATION_MARKER}`;
}
