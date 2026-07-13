import type { IrisCapability } from "../config/runtime-config.js";

export type DurableRuntimeControlSnapshot = {
  revision: number;
  desiredGlobalEnabled: boolean;
  disabledGroupIds: string[];
  capabilities: IrisCapability;
  updatedAt: Date;
  updatedBy?: string;
};

export interface RuntimeControlStateRepository {
  getSnapshot(): Promise<DurableRuntimeControlSnapshot>;
  replaceSnapshot(input: {
    expectedRevision: number;
    next: Omit<DurableRuntimeControlSnapshot, "revision" | "updatedAt">;
  }): Promise<DurableRuntimeControlSnapshot | "conflict">;
}

export const runtimeCapabilityNames = [
  "readGroupContext",
  "replyWhenMentioned",
  "readGroupDocuments",
  "retrieveKnowledgeBase",
  "proactiveSpeech",
  "generateKnowledgeDrafts",
  "writeKnowledgeBase",
  "callExternalTools",
] as const satisfies readonly (keyof IrisCapability)[];

export const runtimeControlUpdatedByMaxChars = 256;

type DurableRuntimeControlSnapshotRow = {
  revision: unknown;
  desired_global_enabled: unknown;
  disabled_group_ids: unknown;
  capabilities: unknown;
  updated_at: unknown;
  updated_by: unknown;
};

export function decodeDurableRuntimeControlSnapshot(
  row: unknown,
): DurableRuntimeControlSnapshot {
  if (!hasExactKeys(row, [
    "revision",
    "desired_global_enabled",
    "disabled_group_ids",
    "capabilities",
    "updated_at",
    "updated_by",
  ])) {
    throw invalidSnapshot("row");
  }

  const snapshotRow = row as DurableRuntimeControlSnapshotRow;
  const revision = decodeRevision(snapshotRow.revision, "revision");
  const desiredGlobalEnabled = decodeBoolean(
    snapshotRow.desired_global_enabled,
    "desired_global_enabled",
  );
  const disabledGroupIds = decodeDisabledGroupIds(snapshotRow.disabled_group_ids);
  const capabilities = decodeCapabilities(snapshotRow.capabilities);
  const updatedAt = decodeUpdatedAt(snapshotRow.updated_at);
  const updatedBy = decodeUpdatedBy(snapshotRow.updated_by);

  return {
    revision,
    desiredGlobalEnabled,
    disabledGroupIds,
    capabilities,
    updatedAt,
    ...(updatedBy === undefined ? {} : { updatedBy }),
  };
}

export function normalizeRuntimeControlStateReplacement(input: {
  expectedRevision: unknown;
  next: unknown;
}): {
  expectedRevision: number;
  next: Omit<DurableRuntimeControlSnapshot, "revision" | "updatedAt">;
  updatedBy: string | null;
} {
  const expectedRevision = decodeRevision(input.expectedRevision, "expectedRevision");
  const next = decodeReplacement(input.next);

  return {
    expectedRevision,
    next,
    updatedBy: next.updatedBy ?? null,
  };
}

function decodeReplacement(value: unknown): Omit<
  DurableRuntimeControlSnapshot,
  "revision" | "updatedAt"
> {
  if (!hasAllowedKeys(value, [
    "desiredGlobalEnabled",
    "disabledGroupIds",
    "capabilities",
    "updatedBy",
  ]) || !hasOwn(value, "desiredGlobalEnabled") || !hasOwn(value, "disabledGroupIds") || !hasOwn(value, "capabilities")) {
    throw invalidSnapshot("next");
  }

  const next = value as Record<string, unknown>;
  const updatedByValue = hasOwn(next, "updatedBy") ? next.updatedBy : undefined;
  const updatedBy =
    updatedByValue === undefined ? undefined : decodeUpdatedBy(updatedByValue);

  if (updatedByValue !== undefined && updatedBy === undefined) {
    throw invalidSnapshot("updatedBy");
  }

  return {
    desiredGlobalEnabled: decodeBoolean(next.desiredGlobalEnabled, "desiredGlobalEnabled"),
    disabledGroupIds: decodeDisabledGroupIds(next.disabledGroupIds),
    capabilities: decodeCapabilities(next.capabilities),
    ...(updatedBy === undefined ? {} : { updatedBy }),
  };
}

function decodeRevision(value: unknown, field: string): number {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw invalidSnapshot(field);
  }

  if (typeof value === "string" && !/^-?\d+$/.test(value)) {
    throw invalidSnapshot(field);
  }

  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw invalidSnapshot(field);
  }

  return revision;
}

function decodeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidSnapshot(field);
  }

  return value;
}

function decodeDisabledGroupIds(value: unknown): string[] {
  if (!isDenseJsonStringArray(value)) {
    throw invalidSnapshot("disabled_group_ids");
  }

  const normalized = value.map((groupId) => {
    const trimmed = groupId.trim();
    if (trimmed.length === 0) {
      throw invalidSnapshot("disabled_group_ids");
    }

    return trimmed;
  });
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    throw invalidSnapshot("disabled_group_ids");
  }

  return [...unique].sort();
}

function isDenseJsonStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1) {
    return false;
  }

  for (const key of ownKeys) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string" || !isArrayIndex(key, value.length)) {
      return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      return false;
    }
  }

  for (const key in value) {
    if (!hasOwn(value, key)) {
      return false;
    }
  }

  return true;
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) {
    return false;
  }

  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function decodeCapabilities(value: unknown): IrisCapability {
  if (!hasExactKeys(value, runtimeCapabilityNames)) {
    throw invalidSnapshot("capabilities");
  }

  const capabilities = value as Record<keyof IrisCapability, unknown>;
  return Object.fromEntries(
    runtimeCapabilityNames.map((name) => [name, decodeBoolean(capabilities[name], "capabilities")]),
  ) as IrisCapability;
}

function decodeUpdatedAt(value: unknown): Date {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw invalidSnapshot("updated_at");
  }

  const updatedAt = new Date(value);
  if (Number.isNaN(updatedAt.getTime())) {
    throw invalidSnapshot("updated_at");
  }

  return updatedAt;
}

function decodeUpdatedBy(value: unknown): string | undefined {
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidSnapshot("updated_by");
  }

  const updatedBy = value.trim();
  if (updatedBy.length === 0 || updatedBy.length > runtimeControlUpdatedByMaxChars) {
    throw invalidSnapshot("updated_by");
  }

  return updatedBy;
}

function hasExactKeys(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  return (
    hasAllowedKeys(value, expectedKeys) &&
    Reflect.ownKeys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => hasOwn(value, key))
  );
}

function hasAllowedKeys(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && allowedKeys.includes(key),
    )
  );
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidSnapshot(field: string): Error {
  return new Error(`invalid runtime control snapshot: ${field}`);
}
