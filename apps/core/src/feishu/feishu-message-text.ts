const MAX_FEISHU_MESSAGE_CONTENT_CHARS = 64_000;
const MAX_FEISHU_MESSAGE_TEXT_CHARS = 8000;
const TRUNCATION_MARKER = " ... [truncated]";
const readablePostContentKeys = new Set(["title", "text", "href", "url"]);
const MAX_POST_TEXT_TRAVERSAL_DEPTH = 20;
const MAX_POST_TEXT_PARTS = 200;

export function readFeishuMessageText(messageType: string, content: unknown): string | undefined {
  return truncateMessageText(readText(messageType, content));
}

function readText(messageType: string, content: unknown): string | undefined {
  if (typeof content !== "string" || content.length > MAX_FEISHU_MESSAGE_CONTENT_CHARS) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (messageType === "text") {
      if (!isRecord(parsed)) {
        return undefined;
      }

      return readOptionalString(parsed.text);
    }

    if (messageType === "post") {
      return readPostText(parsed);
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function readPostText(value: unknown): string | undefined {
  const parts: string[] = [];
  collectPostTextParts(value, parts);

  const text = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();

  return text.length > 0 ? text : undefined;
}

function collectPostTextParts(value: unknown, parts: string[], depth = 0): void {
  if (depth > MAX_POST_TEXT_TRAVERSAL_DEPTH || parts.length >= MAX_POST_TEXT_PARTS) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (parts.length >= MAX_POST_TEXT_PARTS) {
        break;
      }
      collectPostTextParts(item, parts, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (typeof nestedValue === "string" && readablePostContentKeys.has(key)) {
      parts.push(nestedValue);
      continue;
    }

    if (Array.isArray(nestedValue) || isRecord(nestedValue)) {
      collectPostTextParts(nestedValue, parts, depth + 1);
    }
  }
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateMessageText(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= MAX_FEISHU_MESSAGE_TEXT_CHARS) {
    return value;
  }

  const prefixChars = MAX_FEISHU_MESSAGE_TEXT_CHARS - TRUNCATION_MARKER.length;
  return `${value.slice(0, prefixChars).trimEnd()}${TRUNCATION_MARKER}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
