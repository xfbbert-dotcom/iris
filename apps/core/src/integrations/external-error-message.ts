const DEFAULT_EXTERNAL_ERROR_MESSAGE_MAX_CHARS = 512;
const TRUNCATION_MARKER = " ... [truncated]";

export function readExternalErrorMessage(responseBody: unknown): string {
  const message = readMessageCandidate(responseBody)?.trim();
  if (message === undefined || message.length === 0) {
    return "unknown error";
  }

  return truncateExternalErrorMessage(redactExternalErrorSecrets(message));
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

  if (isRecord(responseBody.error)) {
    const nestedMessage = readNonBlankString(responseBody.error.message);
    if (nestedMessage !== undefined) {
      return nestedMessage;
    }
  }

  const feishuMessage = readNonBlankString(responseBody.msg);
  if (feishuMessage !== undefined) {
    return feishuMessage;
  }

  return readNonBlankString(responseBody.message);
}

function readNonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function redactExternalErrorSecrets(message: string): string {
  return message
    .replace(/\b(Bearer)\s+[^\s,;]+/giu, "$1 [redacted]")
    .replace(
      /\b(api[-_ ]?key|access[-_ ]?token|secret)\s*([:=])\s*[^\s,;]+/giu,
      "$1$2[redacted]",
    );
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
