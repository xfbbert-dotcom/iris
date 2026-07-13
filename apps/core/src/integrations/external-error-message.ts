const DEFAULT_EXTERNAL_ERROR_MESSAGE_MAX_CHARS = 512;
const TRUNCATION_MARKER = " ... [truncated]";

export function readExternalErrorMessage(responseBody: unknown): string {
  const message = readMessageCandidate(responseBody)?.trim();
  if (message === undefined || message.length === 0) {
    return "unknown error";
  }

  return truncateExternalErrorMessage(message);
}

function readMessageCandidate(responseBody: unknown): string | undefined {
  if (Array.isArray(responseBody)) {
    for (const entry of responseBody) {
      const message = readRecordMessageCandidate(entry)?.trim();
      if (message !== undefined && message.length > 0) {
        return message;
      }
    }
    return undefined;
  }

  return readRecordMessageCandidate(responseBody);
}

function readRecordMessageCandidate(responseBody: unknown): string | undefined {
  if (!isRecord(responseBody) || Array.isArray(responseBody)) {
    return undefined;
  }

  if (isRecord(responseBody.error) && typeof responseBody.error.message === "string") {
    return responseBody.error.message;
  }

  if (typeof responseBody.msg === "string") {
    return responseBody.msg;
  }

  return typeof responseBody.message === "string" ? responseBody.message : undefined;
}

function truncateExternalErrorMessage(message: string): string {
  if (message.length <= DEFAULT_EXTERNAL_ERROR_MESSAGE_MAX_CHARS) {
    return message;
  }

  const prefixChars = DEFAULT_EXTERNAL_ERROR_MESSAGE_MAX_CHARS - TRUNCATION_MARKER.length;
  return `${message.slice(0, prefixChars).trimEnd()}${TRUNCATION_MARKER}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
