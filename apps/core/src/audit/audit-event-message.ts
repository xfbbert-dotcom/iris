const MAX_AUDIT_EVENT_MESSAGE_CHARS = 1000;
const TRUNCATION_MARKER = " ... [truncated]";

export function normalizeAuditEventMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return "unknown error";
  }
  if (trimmed.length <= MAX_AUDIT_EVENT_MESSAGE_CHARS) {
    return trimmed;
  }

  const prefixChars = MAX_AUDIT_EVENT_MESSAGE_CHARS - TRUNCATION_MARKER.length;
  return `${trimmed.slice(0, prefixChars).trimEnd()}${TRUNCATION_MARKER}`;
}
