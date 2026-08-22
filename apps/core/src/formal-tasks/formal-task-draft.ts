import { createHash } from "node:crypto";

export const FORMAL_TASK_DRAFT_STATUSES = [
  "pending_confirmation",
  "pending_review",
  "needs_revision",
  "rejected",
  "created",
] as const;

export const FORMAL_TASK_REMINDER_MINUTES = [0, 30, 60, 1440] as const;

export type FormalTaskDraftStatus = (typeof FORMAL_TASK_DRAFT_STATUSES)[number];
export type FormalTaskReminderMinutes = (typeof FORMAL_TASK_REMINDER_MINUTES)[number];

export type FormalTaskSpec = {
  title: string;
  description: string;
  assigneeOpenId: string;
  dueAtUtc?: string;
  reminderMinutes?: FormalTaskReminderMinutes;
  sourceGroupId: string;
  targetPolicyId: string;
  targetPolicyVersion: number;
};

export type FormalTaskDraft = {
  id: string;
  sourceGroupId: string;
  status: FormalTaskDraftStatus;
  currentRevisionNumber: number;
  version: number;
  createdBy: string;
  currentTaskSpecHash: string;
  createdAt: Date;
  updatedAt: Date;
};

export class FormalTaskDraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormalTaskDraftValidationError";
  }
}

export function normalizeFormalTaskSpec(input: unknown): FormalTaskSpec {
  if (!isRecord(input)) throw validationError("formal task specification must be an object");
  assertOnlyKeys(input, [
    "title",
    "description",
    "assigneeOpenId",
    "dueAt",
    "reminderMinutes",
    "sourceGroupId",
    "targetPolicyId",
    "targetPolicyVersion",
  ]);

  const title = normalizeText("title", input.title, 1, 256, false);
  const description = normalizeText("description", input.description, 1, 3000, true);
  const assigneeOpenId = normalizeReference("assigneeOpenId", input.assigneeOpenId);
  const sourceGroupId = normalizeReference("sourceGroupId", input.sourceGroupId);
  const targetPolicyId = normalizeReference("targetPolicyId", input.targetPolicyId);
  const targetPolicyVersion = requirePositiveInteger(
    "targetPolicyVersion",
    input.targetPolicyVersion,
  );
  const dueAtUtc = normalizeDueAt(input.dueAt);
  const reminderMinutes = normalizeReminderMinutes(input.reminderMinutes);
  if (reminderMinutes !== undefined && dueAtUtc === undefined) {
    throw validationError("reminderMinutes requires dueAt");
  }

  return {
    title,
    description,
    assigneeOpenId,
    ...(dueAtUtc === undefined ? {} : { dueAtUtc }),
    ...(reminderMinutes === undefined ? {} : { reminderMinutes }),
    sourceGroupId,
    targetPolicyId,
    targetPolicyVersion,
  };
}

export function canonicalFormalTaskSpec(input: unknown): string {
  return JSON.stringify(normalizeFormalTaskSpec(input));
}

export function canonicalFormalTaskSpecHash(input: unknown): string {
  return createHash("sha256").update(canonicalFormalTaskSpec(input)).digest("hex");
}

export function normalizeFormalTaskDraft(input: unknown): FormalTaskDraft {
  if (!isRecord(input)) throw validationError("formal task draft must be an object");
  assertOnlyKeys(input, [
    "id",
    "sourceGroupId",
    "status",
    "currentRevisionNumber",
    "version",
    "createdBy",
    "currentTaskSpecHash",
    "createdAt",
    "updatedAt",
  ]);
  if (!FORMAL_TASK_DRAFT_STATUSES.includes(input.status as FormalTaskDraftStatus)) {
    throw validationError("status is invalid");
  }
  const currentTaskSpecHash = input.currentTaskSpecHash;
  if (typeof currentTaskSpecHash !== "string" || !/^[0-9a-f]{64}$/u.test(currentTaskSpecHash)) {
    throw validationError("currentTaskSpecHash is invalid");
  }

  return {
    id: normalizeReference("id", input.id),
    sourceGroupId: normalizeReference("sourceGroupId", input.sourceGroupId),
    status: input.status as FormalTaskDraftStatus,
    currentRevisionNumber: requirePositiveInteger(
      "currentRevisionNumber",
      input.currentRevisionNumber,
    ),
    version: requirePositiveInteger("version", input.version),
    createdBy: normalizeReference("createdBy", input.createdBy),
    currentTaskSpecHash,
    createdAt: normalizeDate("createdAt", input.createdAt),
    updatedAt: normalizeDate("updatedAt", input.updatedAt),
  };
}

function normalizeText(
  name: string,
  value: unknown,
  minLength: number,
  maxLength: number,
  allowNewlines: boolean,
): string {
  if (typeof value !== "string") throw validationError(`${name} must be a string`);
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  const forbidden = allowNewlines
    ? /[\u0000-\u0009\u000b-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  if (forbidden.test(normalized)) throw validationError(`${name} contains control characters`);
  const length = [...normalized].length;
  if (length < minLength || length > maxLength) {
    throw validationError(`${name} length is invalid`);
  }
  return normalized;
}

function normalizeReference(name: string, value: unknown): string {
  if (typeof value !== "string") throw validationError(`${name} must be a string`);
  const normalized = value.trim();
  if (
    [...normalized].length < 1 ||
    [...normalized].length > 512 ||
    /[\u0000-\u001f\u007f\s]/u.test(normalized)
  ) {
    throw validationError(`${name} is invalid`);
  }
  return normalized;
}

function normalizeDueAt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw validationError("dueAt must be a valid Date");
  }
  return value.toISOString();
}

function normalizeReminderMinutes(value: unknown): FormalTaskReminderMinutes | undefined {
  if (value === undefined) return undefined;
  if (!FORMAL_TASK_REMINDER_MINUTES.includes(value as FormalTaskReminderMinutes)) {
    throw validationError("reminderMinutes is invalid");
  }
  return value as FormalTaskReminderMinutes;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw validationError(`${name} must be a safe positive integer`);
  }
  return Number(value);
}

function normalizeDate(name: string, value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw validationError(`${name} must be a valid Date`);
  }
  return new Date(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw validationError(`unknown field: ${key}`);
  }
}

function validationError(message: string): FormalTaskDraftValidationError {
  return new FormalTaskDraftValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
