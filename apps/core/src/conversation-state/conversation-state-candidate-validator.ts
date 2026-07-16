import {
  type AiWorkerExtractionResponse,
  type ProposedActionOperation,
  type ProposedActionOwner,
  type ProposedThreadOperation,
  type ValidatedActionOperation,
  type ValidatedThreadOperation,
} from "../memory-extraction/ai-worker-memory-extraction-client.js";
import type { ClaimedMemoryExtractionRun, ExtractionMessage } from "../memory-extraction/memory-extraction-repository.js";
import {
  type ActionItem,
  type DiscussionThread,
} from "./conversation-state-repository.js";
import { validateActionTransition, validateThreadTransition } from "./conversation-state-machine.js";

const MAX_IDENTIFIER_CHARS = 512;
const MAX_CONTENT_CHARS = 4000;
const MAX_OPERATIONS_PER_FAMILY = 8;
const MAX_EVIDENCE_IDS = 40;

export type ConversationStateExtractionMessage = ExtractionMessage & {
  mentions?: Array<{ key: string; openId: string }>;
};

export type ConversationStateExtractionRun = ClaimedMemoryExtractionRun & {
  evidenceMessages: ConversationStateExtractionMessage[];
  existingThreads: DiscussionThread[];
  existingActions: ActionItem[];
  enabledOperationFamilies: Array<"memory" | "thread" | "action">;
};

export type ConversationStateCandidateDiagnostics = {
  proposedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  rejectionCodes: string[];
};

export function validateConversationStateCandidates(input: {
  run: ConversationStateExtractionRun;
  response: AiWorkerExtractionResponse;
  candidateFloor: number;
  applyConfidence: number;
}): {
  threadOperations: ValidatedThreadOperation[];
  actionOperations: ValidatedActionOperation[];
  diagnostics: ConversationStateCandidateDiagnostics;
} {
  if (!isThreshold(input.candidateFloor) || !isThreshold(input.applyConfidence) || input.candidateFloor >= input.applyConfidence) {
    throw new Error("conversation state confidence thresholds are invalid");
  }
  if (!isExactResponse(input.response)) {
    return result([], [], 0, 0, ["invalid_response"]);
  }
  const proposedThreads = boundedOperations(input.response.threadOperations);
  const proposedActions = boundedOperations(input.response.actionOperations);
  const proposedCount = proposedThreads.length + proposedActions.length;
  const rejected = new Set<string>();
  const acceptedThreads: ValidatedThreadOperation[] = [];
  const acceptedActions: ValidatedActionOperation[] = [];

  if (!isValidRun(input.run) || input.response.runId !== input.run.id) {
    return result([], [], proposedCount, proposedCount, ["invalid_run"]);
  }
  if ((input.response.threadOperations?.length ?? 0) > MAX_OPERATIONS_PER_FAMILY ||
    (input.response.actionOperations?.length ?? 0) > MAX_OPERATIONS_PER_FAMILY) {
    return result([], [], proposedCount, proposedCount, ["operation_count"]);
  }

  const evidenceById = new Map(input.run.evidenceMessages.map((message) => [message.id, message]));
  const threadsById = new Map(input.run.existingThreads.map((thread) => [thread.id, thread]));
  const actionsById = new Map(input.run.existingActions.map((action) => [action.id, action]));
  const duplicateKeys = duplicateOperationKeys([...proposedThreads, ...proposedActions]);

  for (const operation of proposedThreads) {
    const accepted = validateThreadOperation({
      operation,
      evidenceById,
      threadsById,
      duplicateKeys,
      enabled: input.run.enabledOperationFamilies.includes("thread"),
      candidateFloor: input.candidateFloor,
      applyConfidence: input.applyConfidence,
    });
    if (accepted.ok) acceptedThreads.push(accepted.value);
    else rejected.add(accepted.code);
  }
  for (const operation of proposedActions) {
    const accepted = validateActionOperation({
      operation,
      evidenceById,
      actionsById,
      threadsById,
      duplicateKeys,
      enabled: input.run.enabledOperationFamilies.includes("action"),
      applyConfidence: input.applyConfidence,
    });
    if (accepted.ok) acceptedActions.push(accepted.value);
    else rejected.add(accepted.code);
  }

  const acceptedCount = acceptedThreads.length + acceptedActions.length;
  return result(
    acceptedThreads.sort(compareOperationKeys),
    acceptedActions.sort(compareOperationKeys),
    proposedCount,
    proposedCount - acceptedCount,
    [...rejected].sort(),
  );
}

function validateThreadOperation(input: {
  operation: ProposedThreadOperation;
  evidenceById: Map<string, ConversationStateExtractionMessage>;
  threadsById: Map<string, DiscussionThread>;
  duplicateKeys: Set<string>;
  enabled: boolean;
  candidateFloor: number;
  applyConfidence: number;
}): { ok: true; value: ValidatedThreadOperation } | { ok: false; code: string } {
  const { operation } = input;
  if (!isExactThreadOperation(operation)) return reject("invalid_shape");
  if (!input.enabled) return reject("family_disabled");
  if (input.duplicateKeys.has(operation.operationKey)) return reject("duplicate_operation_key");
  const evidence = evidenceMessages(operation, input.evidenceById);
  if (evidence === undefined || !hasExactSpan(evidence, operation.evidenceSpan)) return reject("invalid_evidence");
  if (operation.confidence < input.applyConfidence) {
    if (operation.operation === "create" && operation.confidence >= input.candidateFloor) {
      return { ok: true, value: { ...operation, initialStatus: "candidate" } };
    }
    return reject("low_confidence");
  }
  if (operation.operation === "create") return { ok: true, value: operation };

  const targetId = operation.operation === "merge" ? operation.sourceThreadId : operation.threadId;
  const target = input.threadsById.get(targetId);
  if (target === undefined || target.groupId === undefined) return reject("unknown_thread");
  if (target.version !== operation.expectedVersion) return reject("stale_version");
  if (operation.operation === "merge") {
    const mergeTarget = input.threadsById.get(operation.targetThreadId);
    if (mergeTarget === undefined || mergeTarget.id === target.id) return reject("unknown_thread");
    const transition = validateThreadTransition({ from: target.status, to: "merged", eventType: "merged" });
    return transition.ok ? { ok: true, value: operation } : reject(transition.code);
  }
  if (operation.operation === "attach_evidence") {
    const transition = validateThreadTransition({
      from: target.status,
      to: target.status,
      eventType: "evidence_attached",
    });
    return transition.ok ? { ok: true, value: operation } : reject(transition.code);
  }
  const transition = validateThreadTransition({
    from: target.status,
    to: threadTargetStatus(operation, target.status),
    eventType: threadEventType(operation),
  });
  return transition.ok ? { ok: true, value: operation } : reject(transition.code);
}

function validateActionOperation(input: {
  operation: ProposedActionOperation;
  evidenceById: Map<string, ConversationStateExtractionMessage>;
  actionsById: Map<string, ActionItem>;
  threadsById: Map<string, DiscussionThread>;
  duplicateKeys: Set<string>;
  enabled: boolean;
  applyConfidence: number;
}): { ok: true; value: ValidatedActionOperation } | { ok: false; code: string } {
  const { operation } = input;
  if (!isExactActionOperation(operation)) return reject("invalid_shape");
  if (!input.enabled) return reject("family_disabled");
  if (input.duplicateKeys.has(operation.operationKey)) return reject("duplicate_operation_key");
  const evidence = evidenceMessages(operation, input.evidenceById);
  if (evidence === undefined || !hasExactSpan(evidence, operation.evidenceSpan)) return reject("invalid_evidence");
  if (operation.confidence < input.applyConfidence) return reject("low_confidence");

  if (operation.operation === "create") {
    if (operation.threadId !== undefined && operation.threadId !== null && !input.threadsById.has(operation.threadId)) return reject("unknown_thread");
    if (isSuggestion(operation, evidence)) return reject("non_commitment_action");
    const owner = validateOwner(operation.owner, evidence, input.evidenceById);
    if (!owner.ok) return owner;
    if (operation.dueAt !== undefined && !hasExactSpan(evidence, operation.dueEvidenceSpan!)) return reject("invalid_due_evidence");
    return { ok: true, value: { ...operation, ...owner.value } };
  }

  const action = input.actionsById.get(operation.actionId);
  if (action === undefined) return reject("unknown_action");
  if (action.version !== operation.expectedVersion) return reject("stale_version");
  if (operation.operation === "correct" && Object.hasOwn(operation, "threadId") &&
    operation.threadId !== null && !input.threadsById.has(operation.threadId!)) {
    return reject("unknown_thread");
  }
  let owner: { ownerRefType: "feishu_user" | "text_label"; ownerRef: string; ownerResolved: boolean } | undefined;
  if (operation.operation === "resolve_owner" || (operation.operation === "correct" && operation.owner !== undefined)) {
    const proposedOwner = operation.owner;
    const resolvedOwner = validateOwner(proposedOwner!, evidence, input.evidenceById);
    if (!resolvedOwner.ok) return resolvedOwner;
    owner = resolvedOwner.value;
  }
  const transition = validateActionTransition({
    from: action.status,
    to: actionTargetStatus(operation, action.status),
    eventType: actionEventType(operation),
    evidenceCount: operation.evidenceMessageIds.length,
  });
  return transition.ok ? { ok: true, value: { ...operation, ...owner } } : reject(transition.code);
}

function evidenceMessages(
  operation: { evidenceMessageIds: string[] },
  evidenceById: Map<string, ConversationStateExtractionMessage>,
): ConversationStateExtractionMessage[] | undefined {
  if (!Array.isArray(operation.evidenceMessageIds) || operation.evidenceMessageIds.length === 0 || operation.evidenceMessageIds.length > MAX_EVIDENCE_IDS || new Set(operation.evidenceMessageIds).size !== operation.evidenceMessageIds.length) return undefined;
  const messages = operation.evidenceMessageIds.map((id) => evidenceById.get(id));
  return messages.some((message) => message === undefined) ? undefined : messages as ConversationStateExtractionMessage[];
}

function validateOwner(
  owner: ProposedActionOwner,
  evidence: ConversationStateExtractionMessage[],
  evidenceById: Map<string, ConversationStateExtractionMessage>,
): { ok: true; value: { ownerRefType: "feishu_user" | "text_label"; ownerRef: string; ownerResolved: boolean } } | { ok: false; code: string } {
  if (!isExactOwner(owner)) return reject("invalid_owner");
  const message = evidenceById.get(owner.messageId);
  if (message === undefined || !evidence.includes(message)) return reject("invalid_owner");
  if (owner.ownerType === "sender") {
    return message.senderId === undefined ? reject("invalid_owner") : { ok: true, value: { ownerRefType: "feishu_user", ownerRef: message.senderId, ownerResolved: true } };
  }
  if (owner.ownerType === "mention") {
    const mention = message.mentions?.find((entry) => entry.key === owner.mentionKey);
    return mention === undefined ? reject("invalid_owner") : { ok: true, value: { ownerRefType: "feishu_user", ownerRef: mention.openId, ownerResolved: true } };
  }
  return message.text.includes(owner.label)
    ? { ok: true, value: { ownerRefType: "text_label", ownerRef: owner.label, ownerResolved: false } }
    : reject("invalid_owner");
}

function isSuggestion(operation: Extract<ProposedActionOperation, { operation: "create" }>, evidence: ConversationStateExtractionMessage[]): boolean {
  const source = `${operation.description}\n${operation.evidenceSpan}`.toLocaleLowerCase();
  return /\?|\b(?:brainstorm|suggest(?:ion)?|maybe|could|should)\b|建议|脑暴/u.test(source) ||
    evidence.some((message) => /\?|\b(?:brainstorm|suggest(?:ion)?|maybe|could|should)\b|建议|脑暴/u.test(message.text.toLocaleLowerCase()));
}

function isExactThreadOperation(value: unknown): value is ProposedThreadOperation {
  if (!isExactOperationBase(value)) return false;
  const operation = value as Record<string, unknown>;
  switch (operation.operation) {
    case "create": return exactKeys(operation, ["operation", ...baseKeys, "title", "summary", "initialStatus"]) && isContent(operation.title) && isContent(operation.summary) && (operation.initialStatus === "candidate" || operation.initialStatus === "open");
    case "attach_evidence": return exactExistingKeys(operation, ["threadId"]);
    case "promote": return exactExistingKeys(operation, ["threadId", "summary"]) && isContent(operation.summary);
    case "merge": return exactExistingKeys(operation, ["sourceThreadId", "targetThreadId"]) && isIdentifier(operation.sourceThreadId) && isIdentifier(operation.targetThreadId) && operation.sourceThreadId !== operation.targetThreadId;
    case "resolve":
    case "reopen": return exactExistingKeys(operation, ["threadId"]);
    case "update_summary": return exactExistingKeys(operation, ["threadId", "summary"]) && isContent(operation.summary);
    case "correct": return exactExistingKeys(operation, ["threadId", "correctedFields", "title", "summary"], ["title", "summary"]) && correctedFieldsMatch(operation, ["title", "summary"]);
    default: return false;
  }
}

function isExactActionOperation(value: unknown): value is ProposedActionOperation {
  if (!isExactOperationBase(value)) return false;
  const operation = value as Record<string, unknown>;
  switch (operation.operation) {
    case "create": return exactKeys(operation, ["operation", ...baseKeys, "threadId", "description", "owner", "dueAt", "dueEvidenceSpan"], ["threadId", "dueAt", "dueEvidenceSpan"]) && (operation.threadId === undefined || operation.threadId === null || isIdentifier(operation.threadId)) && isContent(operation.description) && isExactOwner(operation.owner) && ((operation.dueAt === undefined && operation.dueEvidenceSpan === undefined) || (isTimestamp(operation.dueAt) && isContent(operation.dueEvidenceSpan)));
    case "complete":
    case "cancel":
    case "reopen": return exactExistingKeys(operation, ["actionId"]);
    case "resolve_owner": return exactExistingKeys(operation, ["actionId", "owner"]) && isExactOwner(operation.owner);
    case "correct": return exactExistingKeys(operation, ["actionId", "correctedFields", "description", "threadId", "owner"], ["description", "threadId", "owner"]) && correctedFieldsMatch(operation, [
      { property: "description", corrected: "description" },
      { property: "threadId", corrected: "thread_id" },
      { property: "owner", corrected: "owner" },
    ]);
    default: return false;
  }
}

const baseKeys = ["operationKey", "confidence", "evidenceMessageIds", "evidenceSpan"] as const;

function isExactOperationBase(value: unknown): boolean {
  if (!isExactRecord(value) || !isIdentifier(value.operationKey) || !isThreshold(value.confidence) || !isContent(value.evidenceSpan) || !isExactStringArray(value.evidenceMessageIds, MAX_EVIDENCE_IDS)) return false;
  return new Set(value.evidenceMessageIds).size === value.evidenceMessageIds.length;
}

function exactExistingKeys(value: Record<string, unknown>, extras: string[], optional: string[] = []): boolean {
  return exactKeys(value, ["operation", ...baseKeys, ...extras, "expectedVersion"], optional) && isIdentifier(value[extras[0]!]) && Number.isSafeInteger(value.expectedVersion) && (value.expectedVersion as number) >= 1;
}

function correctedFieldsMatch(
  value: Record<string, unknown>,
  fields: Array<{ property: string; corrected: string }> | string[],
): boolean {
  const mappings = fields.map((field) => typeof field === "string" ? { property: field, corrected: field } : field);
  const correctedFields = value.correctedFields;
  if (!isExactStringArray(correctedFields, mappings.length) || correctedFields.length === 0 || !correctedFields.every((field) => mappings.some((mapping) => mapping.corrected === field)) || new Set(correctedFields).size !== correctedFields.length) return false;
  const supplied = mappings.filter((mapping) => Object.hasOwn(value, mapping.property)).map((mapping) => mapping.corrected);
  if (supplied.length !== correctedFields.length || !supplied.every((field) => correctedFields.includes(field))) return false;
  return (!Object.hasOwn(value, "description") || isContent(value.description)) && (!Object.hasOwn(value, "threadId") || value.threadId === null || isIdentifier(value.threadId)) && (!Object.hasOwn(value, "title") || isContent(value.title)) && (!Object.hasOwn(value, "summary") || isContent(value.summary)) && (!Object.hasOwn(value, "owner") || isExactOwner(value.owner));
}

function isExactOwner(value: unknown): value is ProposedActionOwner {
  if (!isExactRecord(value) || !isIdentifier(value.ownerType) || !isIdentifier(value.messageId)) return false;
  if (value.ownerType === "sender") return exactKeys(value, ["ownerType", "messageId"]);
  if (value.ownerType === "mention") return exactKeys(value, ["ownerType", "messageId", "mentionKey"]) && isIdentifier(value.mentionKey);
  return value.ownerType === "text_label" && exactKeys(value, ["ownerType", "messageId", "label"]) && isContent(value.label);
}

function isExactResponse(value: unknown): value is AiWorkerExtractionResponse & {
  threadOperations: ProposedThreadOperation[];
  actionOperations: ProposedActionOperation[];
} {
  return isExactRecord(value) &&
    exactKeys(value, ["runId", "candidates", "threadOperations", "actionOperations"], ["threadOperations", "actionOperations"]) &&
    isIdentifier(value.runId) &&
    isExactArray(value.candidates) &&
    (value.threadOperations === undefined || isExactArray(value.threadOperations)) &&
    (value.actionOperations === undefined || isExactArray(value.actionOperations));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): boolean {
  return isExactRecord(value) && Reflect.ownKeys(value).length === Object.keys(value).length && Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => optional.includes(key) || Object.hasOwn(value, key));
}

function isExactRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => descriptor.enumerable && "value" in descriptor);
}

function isExactArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  return Reflect.ownKeys(value).every((key) => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/u.test(key));
}

function isExactStringArray(value: unknown, maximum: number): value is string[] {
  if (!isExactArray(value) || value.length === 0 || value.length > maximum) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    if (descriptors[String(index)] === undefined || !("value" in descriptors[String(index)]!) || !isIdentifier(value[index])) return false;
  }
  return true;
}

function isValidRun(run: ConversationStateExtractionRun): boolean {
  const messages = run.evidenceMessages as ConversationStateExtractionMessage[];
  return isIdentifier(run.id) && isIdentifier(run.groupId) && Array.isArray(messages) && Array.isArray(run.existingThreads) && Array.isArray(run.existingActions) && Array.isArray(run.enabledOperationFamilies) && messages.length > 0 && messages.length <= MAX_EVIDENCE_IDS && run.existingThreads.length <= 12 && run.existingActions.length <= 12 && new Set(messages.map((message) => message.id)).size === messages.length && new Set(run.existingThreads.map((thread) => thread.id)).size === run.existingThreads.length && new Set(run.existingActions.map((action) => action.id)).size === run.existingActions.length && messages.every((message) => message.evidenceEligible === true && message.groupId === run.groupId && isIdentifier(message.id) && isContent(message.text) && (message.senderId === undefined || isIdentifier(message.senderId)) && (message.mentions ?? []).every((mention: { key: string; openId: string }) => isIdentifier(mention.key) && isIdentifier(mention.openId))) && run.existingThreads.every((thread) => thread.groupId === run.groupId && isIdentifier(thread.id) && Number.isSafeInteger(thread.version) && thread.version >= 1) && run.existingActions.every((action) => action.groupId === run.groupId && isIdentifier(action.id) && Number.isSafeInteger(action.version) && action.version >= 1) && new Set(run.enabledOperationFamilies).size === run.enabledOperationFamilies.length;
}

function duplicateOperationKeys(operations: Array<{ operationKey: string }>): Set<string> {
  const counts = new Map<string, number>();
  for (const operation of operations) counts.set(operation.operationKey, (counts.get(operation.operationKey) ?? 0) + 1);
  return new Set([...counts].flatMap(([key, count]) => count > 1 ? [key] : []));
}

function boundedOperations<T>(operations: T[] | undefined): T[] {
  return Array.isArray(operations) ? operations.slice(0, MAX_OPERATIONS_PER_FAMILY) : [];
}

function threadTargetStatus(operation: Exclude<ProposedThreadOperation, { operation: "create" | "attach_evidence" | "merge" }>, status: DiscussionThread["status"]): DiscussionThread["status"] {
  if (operation.operation === "promote" || operation.operation === "reopen") return "open";
  if (operation.operation === "resolve") return "resolved";
  return status;
}

function threadEventType(operation: Exclude<ProposedThreadOperation, { operation: "create" | "attach_evidence" | "merge" }>) {
  return operation.operation === "promote" ? "promoted" : operation.operation === "resolve" ? "resolved" : operation.operation === "reopen" ? "reopened" : operation.operation === "update_summary" ? "summary_updated" : "corrected";
}

function actionTargetStatus(operation: Exclude<ProposedActionOperation, { operation: "create" }>, status: ActionItem["status"]): ActionItem["status"] {
  if (operation.operation === "complete") return "completed";
  if (operation.operation === "cancel") return "cancelled";
  if (operation.operation === "reopen") return "open";
  return status;
}

function actionEventType(operation: Exclude<ProposedActionOperation, { operation: "create" }>) {
  return operation.operation === "complete" ? "completed" : operation.operation === "cancel" ? "cancelled" : operation.operation === "reopen" ? "reopened" : operation.operation === "resolve_owner" ? "owner_resolved" : "corrected";
}

function hasExactSpan(messages: ConversationStateExtractionMessage[], span: string): boolean {
  return messages.some((message) => message.text.includes(span));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_CHARS && value === value.trim() && !hasUnsafeText(value) && !/\p{Cc}/u.test(value);
}

function isContent(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_CONTENT_CHARS && !hasUnsafeText(value);
}

function isTimestamp(value: unknown): value is string {
  return isContent(value) && value.length <= 64 && Number.isFinite(new Date(value).getTime()) && /(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value);
}

function hasUnsafeText(value: string): boolean {
  if (value.includes("\u0000") || /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function isThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function compareOperationKeys(left: { operationKey: string }, right: { operationKey: string }): number {
  return left.operationKey < right.operationKey ? -1 : left.operationKey > right.operationKey ? 1 : 0;
}

function reject(code: string): { ok: false; code: string } {
  return { ok: false, code };
}

function result(
  threadOperations: ValidatedThreadOperation[],
  actionOperations: ValidatedActionOperation[],
  proposedCount: number,
  rejectedCount: number,
  rejectionCodes: string[],
) {
  return {
    threadOperations,
    actionOperations,
    diagnostics: {
      proposedCount,
      acceptedCount: threadOperations.length + actionOperations.length,
      rejectedCount,
      rejectionCodes: [...new Set(rejectionCodes)].sort(),
    },
  };
}
