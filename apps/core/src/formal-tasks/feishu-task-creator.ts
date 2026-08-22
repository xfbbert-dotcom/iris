import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import type { FeishuTenantAccessTokenProvider } from
  "../feishu/feishu-tenant-access-token-provider.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";

export type FeishuTaskMember = {
  id: string;
  type: "user" | "app";
  role: "assignee" | "follower";
};

export type FeishuTaskSnapshot = {
  guid: string;
  taskId: string;
  url: string;
  title: string;
  description: string;
  dueAt?: Date;
  dueIsAllDay?: boolean;
  members: FeishuTaskMember[];
  reminderMinutes?: number;
};

export type FeishuTaskCreateInput = {
  title: string;
  description: string;
  assigneeOpenId: string;
  dueAt?: Date;
  reminderMinutes?: 0 | 30 | 60 | 1440;
  clientToken: string;
  signal?: AbortSignal;
};

export type FeishuTaskCreateOutcome =
  | { kind: "created"; task: FeishuTaskSnapshot }
  | {
      kind: "retryable";
      code: "rate_limited" | "server_error" | "aborted_before_dispatch";
    }
  | {
      kind: "rejected";
      code: "unauthorized" | "forbidden" | "not_found" | "invalid_request";
    }
  | {
      kind: "unknown";
      code:
        | "timeout"
        | "connection_lost"
        | "malformed_response"
        | "aborted_after_dispatch";
    };

export type FeishuTaskGetOutcome =
  | { kind: "found"; task: FeishuTaskSnapshot }
  | { kind: "missing" }
  | {
      kind: "retryable";
      code: "rate_limited" | "server_error" | "timeout" | "connection_lost" | "aborted";
    }
  | { kind: "rejected"; code: "unauthorized" | "forbidden" | "invalid_request" }
  | { kind: "invalid_response" };

export interface FeishuTaskCreator {
  createTask(input: FeishuTaskCreateInput): Promise<FeishuTaskCreateOutcome>;
  getTask(input: { taskGuid: string; signal?: AbortSignal }): Promise<FeishuTaskGetOutcome>;
}

export type FeishuTaskCreatorDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_TITLE_CHARS = 256;
const MAX_DESCRIPTION_CHARS = 3_000;
const MAX_MEMBER_ID_CHARS = 100;
const MAX_REMOTE_ID_CHARS = 512;
const MIN_CLIENT_TOKEN_CHARS = 10;
const MAX_CLIENT_TOKEN_CHARS = 100;
const ALLOWED_REMINDER_MINUTES = new Set([0, 30, 60, 1440]);

type SafeCreateInput = Omit<FeishuTaskCreateInput, "dueAt"> & { dueAt?: Date };

type TransportResult =
  | { kind: "response"; status: number; body?: unknown }
  | {
      kind:
        | "timeout"
        | "connection_lost"
        | "malformed_response"
        | "aborted_before_dispatch"
        | "aborted_after_dispatch";
    };

export function createFeishuTaskCreator({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: FeishuTaskCreatorDependencies): FeishuTaskCreator {
  const safeBaseUrl = requireOfficialFeishuBaseUrl(baseUrl);
  const safeTimeoutMs = readPositiveSafeInteger(timeoutMs, "Feishu task timeoutMs");

  return {
    async createTask(input) {
      const safeInput = normalizeCreateInput(input);
      if (safeInput.signal?.aborted === true) {
        return { kind: "retryable", code: "aborted_before_dispatch" };
      }
      const body = {
        summary: safeInput.title,
        description: safeInput.description,
        ...(safeInput.dueAt === undefined
          ? {}
          : {
              due: {
                timestamp: String(safeInput.dueAt.getTime()),
                is_all_day: false,
              },
            }),
        members: [{ id: safeInput.assigneeOpenId, type: "user", role: "assignee" }],
        ...(safeInput.reminderMinutes === undefined
          ? {}
          : { reminders: [{ relative_fire_minute: safeInput.reminderMinutes }] }),
        client_token: safeInput.clientToken,
      };
      const result = await requestJson({
        url: `${safeBaseUrl}/open-apis/task/v2/tasks?user_id_type=open_id`,
        method: "POST",
        body,
        signal: safeInput.signal,
        tokenProvider,
        fetch,
        timeoutMs: safeTimeoutMs,
      });
      if (result.kind !== "response") return mapCreateTransportFailure(result.kind);
      const error = classifyCreateHttpError(result.status, result.body);
      if (error !== undefined) return error;
      const task = readSuccessfulTask(result.status, result.body);
      return task === undefined
        ? { kind: "unknown", code: "malformed_response" }
        : { kind: "created", task };
    },

    async getTask(input) {
      const taskGuid = requireIdentifier("taskGuid", input.taskGuid, MAX_REMOTE_ID_CHARS);
      if (input.signal?.aborted === true) return { kind: "retryable", code: "aborted" };
      const result = await requestJson({
        url: `${safeBaseUrl}/open-apis/task/v2/tasks/${encodeURIComponent(
          taskGuid,
        )}?user_id_type=open_id`,
        method: "GET",
        signal: input.signal,
        tokenProvider,
        fetch,
        timeoutMs: safeTimeoutMs,
      });
      if (result.kind !== "response") return mapGetTransportFailure(result.kind);
      const error = classifyGetHttpError(result.status, result.body);
      if (error !== undefined) return error;
      const task = readSuccessfulTask(result.status, result.body);
      return task === undefined || task.guid !== taskGuid
        ? { kind: "invalid_response" }
        : { kind: "found", task };
    },
  };
}

async function requestJson(input: {
  url: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}): Promise<TransportResult> {
  let tenantAccessToken: string;
  try {
    tenantAccessToken = requireAccessToken(await input.tokenProvider.getTenantAccessToken());
  } catch {
    throw new Error("Feishu task authorization failed");
  }
  if (isSignalAborted(input.signal)) return { kind: "aborted_before_dispatch" };

  const controller = new AbortController();
  let deadlineAborted = false;
  let callerAborted = false;
  let dispatched = false;
  let response: Response | undefined;
  const abortFromCaller = () => {
    callerAborted = true;
    controller.abort();
  };
  input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    deadlineAborted = true;
    controller.abort();
  }, input.timeoutMs);
  try {
    if (isSignalAborted(input.signal)) return { kind: "aborted_before_dispatch" };
    dispatched = true;
    response = await input.fetch(input.url, {
      method: input.method,
      headers: {
        authorization: `Bearer ${tenantAccessToken}`,
        ...(input.body === undefined
          ? {}
          : { "content-type": "application/json; charset=utf-8" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    try {
      const body = await readBoundedJsonResponse({
        response,
        invalidJsonErrorMessage: "Feishu task response was not valid JSON",
        maxResponseBytes: MAX_RESPONSE_BYTES,
        responseSizeErrorMessage: `Feishu task response exceeds ${MAX_RESPONSE_BYTES} bytes`,
      });
      return { kind: "response", status: response.status, body };
    } catch {
      if (deadlineAborted) return { kind: "timeout" };
      if (callerAborted) return { kind: "aborted_after_dispatch" };
      return response.ok
        ? { kind: "malformed_response" }
        : { kind: "response", status: response.status };
    }
  } catch {
    if (deadlineAborted) return { kind: "timeout" };
    if (callerAborted || isSignalAborted(input.signal)) {
      return { kind: dispatched ? "aborted_after_dispatch" : "aborted_before_dispatch" };
    }
    return response === undefined
      ? { kind: "connection_lost" }
      : { kind: "malformed_response" };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function mapCreateTransportFailure(
  kind: Exclude<TransportResult["kind"], "response">,
): FeishuTaskCreateOutcome {
  if (kind === "aborted_before_dispatch") return { kind: "retryable", code: kind };
  return {
    kind: "unknown",
    code: kind === "malformed_response" ? "malformed_response" : kind,
  };
}

function mapGetTransportFailure(
  kind: Exclude<TransportResult["kind"], "response">,
): FeishuTaskGetOutcome {
  if (kind === "malformed_response") return { kind: "invalid_response" };
  if (kind === "aborted_before_dispatch" || kind === "aborted_after_dispatch") {
    return { kind: "retryable", code: "aborted" };
  }
  return { kind: "retryable", code: kind };
}

function classifyCreateHttpError(
  status: number,
  body: unknown,
): Exclude<FeishuTaskCreateOutcome, { kind: "created" }> | undefined {
  if (status === 200) return undefined;
  const code = readNonzeroCode(body);
  if (code === undefined) return fallbackCreateHttpError(status);
  if (status === 400 && code === 1_470_400) {
    return { kind: "rejected", code: "invalid_request" };
  }
  if (status === 403 && code === 1_470_403) return { kind: "rejected", code: "forbidden" };
  if (status === 404 && code === 1_470_404) return { kind: "rejected", code: "not_found" };
  if (status === 500 && (code === 1_470_500 || code === 1_470_422)) {
    return { kind: "retryable", code: "server_error" };
  }
  if (status === 429) return { kind: "retryable", code: "rate_limited" };
  if (status === 401) return { kind: "rejected", code: "unauthorized" };
  return { kind: "unknown", code: "malformed_response" };
}

function fallbackCreateHttpError(
  status: number,
): Exclude<FeishuTaskCreateOutcome, { kind: "created" }> {
  if (status === 429) return { kind: "retryable", code: "rate_limited" };
  if (status >= 500 && status <= 599) return { kind: "retryable", code: "server_error" };
  return { kind: "unknown", code: "malformed_response" };
}

function classifyGetHttpError(
  status: number,
  body: unknown,
): Exclude<FeishuTaskGetOutcome, { kind: "found" }> | undefined {
  if (status === 200) return undefined;
  const code = readNonzeroCode(body);
  if (status === 404 && code === 1_470_404) return { kind: "missing" };
  if (status === 400 && code === 1_470_400) {
    return { kind: "rejected", code: "invalid_request" };
  }
  if (status === 403 && code === 1_470_403) return { kind: "rejected", code: "forbidden" };
  if (status === 500 && code === 1_470_500) {
    return { kind: "retryable", code: "server_error" };
  }
  if (status === 429 && code !== undefined) return { kind: "retryable", code: "rate_limited" };
  if (status === 401 && code !== undefined) return { kind: "rejected", code: "unauthorized" };
  if (code === undefined && status === 429) return { kind: "retryable", code: "rate_limited" };
  if (code === undefined && status >= 500 && status <= 599) {
    return { kind: "retryable", code: "server_error" };
  }
  return { kind: "invalid_response" };
}

function readSuccessfulTask(status: number, body: unknown): FeishuTaskSnapshot | undefined {
  if (
    status !== 200 ||
    !isRecord(body) ||
    body.code !== 0 ||
    !isRecord(body.data) ||
    !isRecord(body.data.task)
  ) return undefined;
  try {
    const task = body.data.task;
    const due = readDue(task.due);
    const reminders = readReminders(task.reminders);
    const members = readMembers(task.members);
    if (due === undefined && reminders.length > 0) return undefined;
    return {
      guid: requireIdentifier("guid", task.guid, MAX_REMOTE_ID_CHARS),
      taskId: requireIdentifier("taskId", task.task_id, MAX_REMOTE_ID_CHARS),
      url: requireFeishuTaskUrl(task.url),
      title: requireExternalText("summary", task.summary, 1, 3_000, false),
      description: requireExternalText(
        "description",
        task.description,
        1,
        MAX_DESCRIPTION_CHARS,
        true,
      ),
      ...(due === undefined ? {} : { dueAt: due.at, dueIsAllDay: due.isAllDay }),
      members,
      ...(reminders.length === 0 ? {} : { reminderMinutes: reminders[0] }),
    };
  } catch {
    return undefined;
  }
}

function readDue(value: unknown): { at: Date; isAllDay: boolean } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.is_all_day !== "boolean") {
    throw new Error("task due is invalid");
  }
  const milliseconds = requireTimestamp(value.timestamp);
  return { at: new Date(milliseconds), isAllDay: value.is_all_day };
}

function readReminders(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 1) throw new Error("task reminders are invalid");
  return value.map((reminder) => {
    if (!isRecord(reminder)) throw new Error("task reminder is invalid");
    const minutes = reminder.relative_fire_minute;
    if (typeof minutes !== "number" || !Number.isSafeInteger(minutes)) {
      throw new Error("task reminder is invalid");
    }
    return minutes;
  });
}

function readMembers(value: unknown): FeishuTaskMember[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("task members are invalid");
  return value.map((member) => {
    if (!isRecord(member)) throw new Error("task member is invalid");
    if (!(member.type === "user" || member.type === "app")) {
      throw new Error("task member type is invalid");
    }
    if (!(member.role === "assignee" || member.role === "follower")) {
      throw new Error("task member role is invalid");
    }
    return {
      id: requireIdentifier("member id", member.id, MAX_MEMBER_ID_CHARS),
      type: member.type,
      role: member.role,
    };
  });
}

function normalizeCreateInput(input: FeishuTaskCreateInput): SafeCreateInput {
  const title = requireExternalText("title", input.title, 1, MAX_TITLE_CHARS, false);
  const description = requireExternalText(
    "description",
    input.description,
    1,
    MAX_DESCRIPTION_CHARS,
    true,
  );
  const assigneeOpenId = requireIdentifier(
    "assigneeOpenId",
    input.assigneeOpenId,
    MAX_MEMBER_ID_CHARS,
  );
  const clientToken = requireClientToken(input.clientToken);
  const dueAt = input.dueAt === undefined ? undefined : requireDate("dueAt", input.dueAt);
  const reminderMinutes = input.reminderMinutes;
  if (
    reminderMinutes !== undefined &&
    (!ALLOWED_REMINDER_MINUTES.has(reminderMinutes) || dueAt === undefined)
  ) throw new Error("reminderMinutes is invalid");
  return {
    title,
    description,
    assigneeOpenId,
    ...(dueAt === undefined ? {} : { dueAt }),
    ...(reminderMinutes === undefined ? {} : { reminderMinutes }),
    clientToken,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function requireOfficialFeishuBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("baseUrl must be a string");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("baseUrl is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "open.feishu.cn" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !(url.pathname === "/" || url.pathname === "") ||
    url.search !== "" ||
    url.hash !== ""
  ) throw new Error("baseUrl is invalid");
  return url.origin;
}

function requireFeishuTaskUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("task URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("task URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !(url.hostname === "feishu.cn" || url.hostname.endsWith(".feishu.cn"))
  ) throw new Error("task URL is invalid");
  return url.toString();
}

function requireExternalText(
  name: string,
  value: unknown,
  minLength: number,
  maxLength: number,
  allowNewlines: boolean,
): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  const forbidden = allowNewlines
    ? /[\u0000-\u0009\u000b-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  const length = [...normalized].length;
  if (forbidden.test(normalized) || length < minLength || length > maxLength) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function requireIdentifier(name: string, value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (
    normalized !== value ||
    [...normalized].length < 1 ||
    [...normalized].length > maxLength ||
    /[\u0000-\u001f\u007f\s]/u.test(normalized)
  ) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireClientToken(value: unknown): string {
  const token = requireIdentifier("clientToken", value, MAX_CLIENT_TOKEN_CHARS);
  if (
    token.length < MIN_CLIENT_TOKEN_CHARS ||
    !/^[A-Za-z0-9_-]+$/u.test(token)
  ) throw new Error("clientToken is invalid");
  return token;
}

function requireDate(name: string, value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${name} is invalid`);
  }
  return new Date(value);
}

function requireTimestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{1,20}$/u.test(value)) {
    throw new Error("task timestamp is invalid");
  }
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new Error("task timestamp is invalid");
  }
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) throw new Error("task timestamp is invalid");
  return milliseconds;
}

function requireAccessToken(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("access token is invalid");
  }
  return value.trim();
}

function readNonzeroCode(body: unknown): number | undefined {
  if (!isRecord(body) || !Number.isSafeInteger(body.code) || Number(body.code) === 0) {
    return undefined;
  }
  return Number(body.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
