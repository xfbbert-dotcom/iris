import { createHash } from "node:crypto";

export const WORKING_CHAT_SCOPE_ID = "pilot-working-chat";
export const MAX_SHARED_CHAT_SOURCE_BINDINGS = 1000;

export type WorkingChatScope = {
  id: string;
  version: number;
  state: "active" | "revoked";
  groups: { chatId: string; name: string }[];
  updatedAt: Date;
  updatedBy: string;
};

export type SharedChatSourceBinding = {
  scopeId: string;
  scopeVersion: number;
  sourceChatId: string;
  destinationChatId: string;
  messageId: string;
  contentHash: string;
};

export interface SharedChatSourceVerifier {
  verify(input: { chatId: string; sources: readonly SharedChatSourceBinding[] }): Promise<boolean>;
}

export type ReplaceWorkingChatScopeInput = {
  expectedVersion: number;
  state: "active" | "revoked";
  groups: WorkingChatScope["groups"];
  updatedBy: string;
  at: Date;
};

export interface WorkingChatScopeRepository {
  get(): Promise<WorkingChatScope | undefined>;
  replace(input: ReplaceWorkingChatScopeInput): Promise<WorkingChatScope>;
  resolveForChat(chatId: string): Promise<WorkingChatScope | undefined>;
  validateExact(binding: SharedChatSourceBinding): Promise<boolean>;
}

export class WorkingChatScopeConflictError extends Error {
  constructor() {
    super("working chat scope version conflict or active answer attempt");
    this.name = "WorkingChatScopeConflictError";
  }
}

export class WorkingChatScopeStaleError extends Error {
  constructor() {
    super("working chat source is no longer authorized");
    this.name = "WorkingChatScopeStaleError";
  }
}

export function hashSharedChatText(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/gu, "\n").trim()).digest("hex");
}

export function normalizeWorkingChatScopeReplacement(input: ReplaceWorkingChatScopeInput): ReplaceWorkingChatScopeInput {
  if (!isRecord(input) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || input.expectedVersion >= Number.MAX_SAFE_INTEGER || (input.state !== "active" && input.state !== "revoked")
    || !(input.at instanceof Date) || !Number.isFinite(input.at.getTime())) {
    throw new Error("invalid working chat scope replacement");
  }
  if (!Array.isArray(input.groups) || input.groups.length < 2 || input.groups.length > 5) {
    throw new Error("working chat scope requires two to five groups");
  }
  const groups: WorkingChatScope["groups"] = [];
  const seen = new Set<string>();
  for (const group of input.groups) {
    if (!isRecord(group) || Object.keys(group).length !== 2) throw new Error("invalid working chat group");
    const chatId = boundedText(group.chatId, 512);
    const name = boundedText(group.name, 256);
    if (seen.has(chatId)) throw new Error("duplicate working chat group");
    seen.add(chatId);
    groups.push({ chatId, name });
  }
  groups.sort((left, right) => left.chatId < right.chatId ? -1 : left.chatId > right.chatId ? 1 : 0);
  return { expectedVersion: input.expectedVersion, state: input.state, groups,
    updatedBy: boundedText(input.updatedBy, 256), at: new Date(input.at) };
}

export function normalizeSharedChatSourceBinding(input: SharedChatSourceBinding): SharedChatSourceBinding {
  if (!isRecord(input) || input.scopeId !== WORKING_CHAT_SCOPE_ID || !Number.isSafeInteger(input.scopeVersion)
    || input.scopeVersion < 1 || typeof input.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(input.contentHash)) {
    throw new WorkingChatScopeStaleError();
  }
  try {
    const sourceChatId = exactText(input.sourceChatId, 512);
    const destinationChatId = exactText(input.destinationChatId, 512);
    if (sourceChatId === destinationChatId) throw new WorkingChatScopeStaleError();
    return { scopeId: WORKING_CHAT_SCOPE_ID, scopeVersion: input.scopeVersion, sourceChatId,
      destinationChatId, messageId: exactText(input.messageId, 505), contentHash: input.contentHash };
  } catch { throw new WorkingChatScopeStaleError(); }
}

function boundedText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") throw new Error("invalid working chat scope text");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxChars || normalized.includes("\u0000")) {
    throw new Error("invalid working chat scope text");
  }
  return normalized;
}

function exactText(value: unknown, maxChars: number): string {
  const normalized = boundedText(value, maxChars);
  if (value !== normalized) throw new WorkingChatScopeStaleError();
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
